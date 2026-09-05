import { ServerAPI } from "decky-frontend-lib";
import { SETTINGS, Setting } from "../utils/Settings";
import { ALL_STORE_IDS, STEAM_STORE_ID, STORES } from "../utils/Stores";
import { providerAuthService } from "./ProviderAuthService";

/*
 * PriceService resolves Steam app ids to ITAD game ids, fetches price history,
 * and returns normalized data for StoreInjector rendering.
 *
 * Security model:
 * - Uses key material only from ProviderAuthService.
 * - Calls fixed ITAD endpoints over HTTPS.
 * - Handles multiple fetchNoCors result shapes defensively.
 * - Returns structured errors without throwing into UI flow.
 */
/** A price that is live right now at a specific store. */
export interface Deal {
    amount: number;
    currency: string;
    regular: number;
    cut: number;
    store: string;
    storeId: number;
    url: string;
}

export interface PriceData {
    /** Cheapest price available right now across the user's selected stores. */
    best: Deal | null;
    /** Every live price we found, cheapest first. */
    deals: Deal[];
    /** Historic low within the fetched window - context, not the headline. */
    lowest: { amount: number; currency: string; date: string; store: string; storeId: number };
    history: { amount: number; currency: string; date: string; store?: string; storeId?: number }[];
    urls: { steamdb: string; itad: string };
}

class PriceService {
    // =========================================================================
    // PART 1: Service State + Bootstrap
    // Purpose: Hold the ServerAPI dependency and initialize it once.
    // =========================================================================
    private serverApi: ServerAPI | undefined;
    private readonly LOOKUP_HOST = "api.isthereanydeal.com";
    private readonly LOOKUP_PATH = "/games/lookup/v1";
    private readonly HISTORY_HOST = "api.isthereanydeal.com";
    private readonly HISTORY_PATH = "/games/history/v2";
    private readonly PRICES_HOST = "api.isthereanydeal.com";
    private readonly PRICES_PATH = "/games/prices/v3";
    private readonly BULK_LOOKUP_HOST = "api.isthereanydeal.com";
    private readonly BULK_LOOKUP_PATH = "/lookup/id/shop/61/v1";
    private readonly INFO_HOST = "api.isthereanydeal.com";
    private readonly INFO_PATH = "/games/info/v2";
    /** ITAD caps bulk requests; stay well under it so a large wishlist still works. */
    private readonly MAX_BULK_IDS = 200;
    private titleCache = new Map<string, string>();
    private readonly MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB hard cap

    public init(serverApi: ServerAPI) {
        this.serverApi = serverApi;
    }

    public getSteamDBUrl(appId: string): string {
        return `https://steamdb.info/app/${appId}/`;
    }

    // =========================================================================
    // PART 2: Input + URL + Payload Guards
    // Purpose: Constrain request targets and response formats before parsing.
    // =========================================================================

    private isValidAppId(appId: string): boolean {
        return /^\d{1,12}$/.test(appId);
    }

    private isValidCountry(country: string): boolean {
        return /^[A-Z]{2}$/.test(country);
    }

    private buildLookupUrl(apiKey: string, appId: string): string {
        const url = new URL(`https://${this.LOOKUP_HOST}${this.LOOKUP_PATH}`);
        url.searchParams.set("key", apiKey);
        url.searchParams.set("appid", appId);
        return url.toString();
    }

    private buildHistoryUrl(apiKey: string, gameId: string, country: string, shops: string, sinceIso: string): string {
        const url = new URL(`https://${this.HISTORY_HOST}${this.HISTORY_PATH}`);
        url.searchParams.set("key", apiKey);
        url.searchParams.set("id", gameId);
        url.searchParams.set("country", country);
        url.searchParams.set("shops", shops);
        url.searchParams.set("since", sinceIso);
        return url.toString();
    }

    private buildPricesUrl(apiKey: string, country: string, shops: string): string {
        const url = new URL(`https://${this.PRICES_HOST}${this.PRICES_PATH}`);
        url.searchParams.set("key", apiKey);
        url.searchParams.set("country", country);
        url.searchParams.set("shops", shops);
        // capacity=0 returns every live offer; nondeals=true keeps stores that are
        // simply cheaper without being on sale, which is the whole point here.
        url.searchParams.set("capacity", "0");
        url.searchParams.set("nondeals", "true");
        url.searchParams.set("vouchers", "true");
        return url.toString();
    }

    private buildBulkLookupUrl(apiKey: string): string {
        const url = new URL(`https://${this.BULK_LOOKUP_HOST}${this.BULK_LOOKUP_PATH}`);
        url.searchParams.set("key", apiKey);
        return url.toString();
    }

    private isAllowedApiUrl(urlString: string): boolean {
        try {
            const url = new URL(urlString);
            const isLookup = url.hostname === this.LOOKUP_HOST && url.pathname === this.LOOKUP_PATH;
            const isHistory = url.hostname === this.HISTORY_HOST && url.pathname === this.HISTORY_PATH;
            const isPrices = url.hostname === this.PRICES_HOST && url.pathname === this.PRICES_PATH;
            const isBulkLookup = url.hostname === this.BULK_LOOKUP_HOST && url.pathname === this.BULK_LOOKUP_PATH;
            const isInfo = url.hostname === this.INFO_HOST && url.pathname === this.INFO_PATH;
            return url.protocol === "https:" && (isLookup || isHistory || isPrices || isBulkLookup || isInfo);
        } catch {
            return false;
        }
    }

    private parseBodyString(result: unknown): string | null {
        if (result && typeof result === "object" && "body" in result && typeof (result as any).body === "string") {
            return (result as any).body;
        }
        if (typeof result === "string") {
            return result;
        }
        return null;
    }

    private parseLookupResponse(result: unknown): { gameId: string; gameSlug: string } | null {
        const body = this.parseBodyString(result);
        if (!body || body.length > this.MAX_RESPONSE_BYTES) return null;

        let data: unknown;
        try {
            data = JSON.parse(body);
        } catch {
            return null;
        }

        if (!data || typeof data !== "object" || Array.isArray(data)) return null;
        const obj = data as Record<string, unknown>;
        if (obj.found !== true) return null;
        if (!obj.game || typeof obj.game !== "object" || Array.isArray(obj.game)) return null;

        const game = obj.game as Record<string, unknown>;
        const gameId = game.id;
        const gameSlug = game.slug;
        if (typeof gameId !== "string" || gameId.length === 0 || gameId.length > 128) return null;
        if (typeof gameSlug !== "string" || gameSlug.length === 0 || gameSlug.length > 128) return null;

        return { gameId, gameSlug };
    }

    private parseHistoryResponse(result: unknown): any[] | null {
        const body = this.parseBodyString(result);
        if (!body || body.length > this.MAX_RESPONSE_BYTES) return null;

        let data: unknown;
        try {
            data = JSON.parse(body);
        } catch {
            return null;
        }

        if (!Array.isArray(data)) return null;
        return data;
    }

    private parseJsonBody(result: unknown): unknown | null {
        const body = this.parseBodyString(result);
        if (!body || body.length > this.MAX_RESPONSE_BYTES) return null;
        try {
            return JSON.parse(body);
        } catch {
            return null;
        }
    }

    // =========================================================================
    // PART 2B: Request Scope
    // Purpose: Resolve the country + store selection every ITAD call shares.
    // Security: Country is regex-checked; store ids are integer-bounded.
    // =========================================================================
    private async getRequestScope(): Promise<{ country: string; shopsParam: string }> {
        const rawCountry = await SETTINGS.load(Setting.COUNTRY) || "US";
        const country = this.isValidCountry(rawCountry) ? rawCountry : "US";

        const storesArr = await SETTINGS.load(Setting.STORES) || ALL_STORE_IDS;
        const validStores = Array.isArray(storesArr) ? storesArr : ALL_STORE_IDS;
        // Steam is always included so the history graph keeps its reference line.
        const storesWithSteam = validStores.includes(STEAM_STORE_ID) ? validStores : [...validStores, STEAM_STORE_ID];
        const safeStoreIds = storesWithSteam
            .filter((id) => Number.isInteger(id) && id >= 0 && id <= 9999)
            .map((id) => String(id));

        return {
            country,
            shopsParam: safeStoreIds.length > 0 ? safeStoreIds.join(",") : String(STEAM_STORE_ID)
        };
    }

    // =========================================================================
    // PART 2C: Live Deal Fetching
    // Purpose: Ask ITAD what each store charges *right now* for a set of games.
    // Security: POSTs only to the pinned prices endpoint with plugin-built bodies.
    // =========================================================================
    private normalizeDeal(raw: any): Deal | null {
        const amount = raw?.price?.amount;
        if (typeof amount !== "number" || !isFinite(amount) || amount < 0) return null;

        const storeId = typeof raw?.shop?.id === "number" ? raw.shop.id : 0;
        const url = typeof raw?.url === "string" && raw.url.startsWith("https://") ? raw.url : "";
        const regular = typeof raw?.regular?.amount === "number" ? raw.regular.amount : amount;
        const cut = typeof raw?.cut === "number" ? raw.cut : 0;

        return {
            amount,
            currency: typeof raw?.price?.currency === "string" ? raw.price.currency : "USD",
            regular,
            cut,
            store: STORES.find(s => s.id === storeId)?.title || raw?.shop?.name || "Unknown",
            storeId,
            url
        };
    }

    /**
     * Fetch live deals for up to MAX_BULK_IDS ITAD game ids in one request.
     * Returns a map of gameId -> deals sorted cheapest first. Failures return an
     * empty map rather than throwing, so callers degrade instead of breaking.
     */
    public async getDealsForGameIds(gameIds: string[]): Promise<Map<string, Deal[]>> {
        const out = new Map<string, Deal[]>();
        if (!this.serverApi || gameIds.length === 0) return out;

        const apiKey = await providerAuthService.getItadKey();
        if (!apiKey) return out;

        const { country, shopsParam } = await this.getRequestScope();
        const pricesUrl = this.buildPricesUrl(apiKey, country, shopsParam);
        if (!this.isAllowedApiUrl(pricesUrl)) return out;

        for (let i = 0; i < gameIds.length; i += this.MAX_BULK_IDS) {
            const chunk = gameIds.slice(i, i + this.MAX_BULK_IDS);
            try {
                const res = await this.serverApi.fetchNoCors(pricesUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(chunk)
                });
                if (!res.success) continue;

                const parsed = this.parseJsonBody(res.result);
                if (!Array.isArray(parsed)) continue;

                for (const item of parsed) {
                    const id = (item as any)?.id;
                    if (typeof id !== "string") continue;
                    const rawDeals = Array.isArray((item as any)?.deals) ? (item as any).deals : [];
                    const deals = rawDeals
                        .map((d: any) => this.normalizeDeal(d))
                        .filter((d: Deal | null): d is Deal => d !== null)
                        .sort((a: Deal, b: Deal) => a.amount - b.amount);
                    out.set(id, deals);
                }
            } catch (e) {
                console.error("[Deckdeals] Live deal fetch failed", e);
            }
        }

        return out;
    }

    /**
     * Bulk-resolve Steam app ids to ITAD game ids. Returns a map keyed by the
     * Steam app id (as a string) for the ids that ITAD recognised.
     */
    public async lookupItadIds(appIds: string[]): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        if (!this.serverApi) return out;

        const safeAppIds = appIds.filter(id => this.isValidAppId(id));
        if (safeAppIds.length === 0) return out;

        const apiKey = await providerAuthService.getItadKey();
        if (!apiKey) return out;

        const lookupUrl = this.buildBulkLookupUrl(apiKey);
        if (!this.isAllowedApiUrl(lookupUrl)) return out;

        for (let i = 0; i < safeAppIds.length; i += this.MAX_BULK_IDS) {
            const chunk = safeAppIds.slice(i, i + this.MAX_BULK_IDS);
            try {
                const res = await this.serverApi.fetchNoCors(lookupUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(chunk.map(id => `app/${id}`))
                });
                if (!res.success) continue;

                const parsed = this.parseJsonBody(res.result);
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

                for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
                    const appId = key.startsWith("app/") ? key.slice(4) : key;
                    if (typeof value === "string" && value.length > 0 && value.length <= 128) {
                        out.set(appId, value);
                    }
                }
            } catch (e) {
                console.error("[Deckdeals] Bulk id lookup failed", e);
            }
        }

        return out;
    }

    /**
     * Resolve an ITAD game id to its display title. Used for wishlist toasts,
     * so it is called only for the handful of games we actually announce.
     * Titles are memoised for the session.
     */
    public async getGameTitle(gameId: string): Promise<string | null> {
        if (!this.serverApi) return null;
        if (!/^[A-Za-z0-9-]{1,128}$/.test(gameId)) return null;

        const cached = this.titleCache.get(gameId);
        if (cached !== undefined) return cached;

        const apiKey = await providerAuthService.getItadKey();
        if (!apiKey) return null;

        const url = new URL(`https://${this.INFO_HOST}${this.INFO_PATH}`);
        url.searchParams.set("key", apiKey);
        url.searchParams.set("id", gameId);
        if (!this.isAllowedApiUrl(url.toString())) return null;

        try {
            const res = await this.serverApi.fetchNoCors(url.toString(), { method: "GET" });
            if (!res.success) return null;

            const parsed = this.parseJsonBody(res.result);
            const title = (parsed as any)?.title;
            if (typeof title !== "string" || title.length === 0 || title.length > 256) return null;

            this.titleCache.set(gameId, title);
            return title;
        } catch {
            return null;
        }
    }

    // =========================================================================
    // PART 3: Main Price Lookup Flow
    // Purpose: Resolve ITAD game id, fetch history, and produce normalized output.
    // Security:
    // - Requires initialized ServerAPI + valid provider key.
    // - Uses HTTPS ITAD API endpoints only.
    // - Fails closed to { data: null, error } on malformed responses.
    // =========================================================================
    public async getLowestPrice(appId: string): Promise<{ data: PriceData | null, error?: string, debug?: any }> {
        if (!this.serverApi) return { data: null, error: "ServerAPI not initialized" };
        if (!this.isValidAppId(appId)) return { data: null, error: "Invalid app id format" };

        const apiKey = await providerAuthService.getItadKey();
        if (!apiKey) return { data: null, error: "Failed to fetch ITAD API key" };

        const lookupUrl = this.buildLookupUrl(apiKey, appId);
        let historyUrl = "";

        try {
            const { country, shopsParam } = await this.getRequestScope();
            const providers = await SETTINGS.load(Setting.PROVIDERS) || ["itad"];

            if (!providers.includes("itad")) {
                // For now we only support ITAD, if not selected, we could return null or fallback
                // but user likely expects at least one provider to work if they enabled the plugin.
                // We'll proceed with ITAD for now but could handle other providers here.
            }

            // PART 3A: Lookup ITAD game metadata from Steam app id.
            // Removed <any> generic type argument to avoid "Untyped function calls..." error
            if (!this.isAllowedApiUrl(lookupUrl)) {
                return { data: null, error: "Lookup URL failed security policy", debug: { lookupUrl } };
            }
            const lookupRes = await this.serverApi.fetchNoCors(lookupUrl, { method: "GET" });

            if (!lookupRes.success) {
                return { data: null, error: "Lookup fetch failed", debug: { lookupUrl } };
            }

            const parsedLookup = this.parseLookupResponse(lookupRes.result);
            if (!parsedLookup) {
                return { data: null, error: "Invalid lookup response", debug: { lookupUrl } };
            }

            const gameId = parsedLookup.gameId;
            const gameSlug = parsedLookup.gameSlug;

            // PART 3B: Fetch historical deals for configured country/stores.
            const since = new Date();
            since.setFullYear(since.getFullYear() - 5);
            // ITAD requires full ISO 8601 format WITHOUT milliseconds (e.g. 2024-02-10T00:00:00Z)
            const sinceStr = since.toISOString().split('.')[0] + "Z";

            historyUrl = this.buildHistoryUrl(apiKey, gameId, country, shopsParam, sinceStr);

            // Removed <any> generic type argument to avoid "Untyped function calls..." error
            if (!this.isAllowedApiUrl(historyUrl)) {
                return { data: null, error: "History URL failed security policy", debug: { lookupUrl, historyUrl } };
            }
            const historyRes = await this.serverApi.fetchNoCors(historyUrl, { method: "GET" });

            if (!historyRes.success) {
                return { data: null, error: "History fetch failed", debug: { lookupUrl, historyUrl } };
            }

            const historyData = this.parseHistoryResponse(historyRes.result);

            if (!historyData) {
                return {
                    data: null,
                    error: "Invalid history response",
                    debug: { lookupUrl, historyUrl }
                };
            }
            if (historyData.length === 0) {
                return { data: null, error: "No history entries", debug: { lookupUrl, historyUrl } };
            }

            // PART 3C: Parse/normalize deal entries and compute lowest value.
            // Parse deals - history/v2 returns FLAT array:
            // [ { timestamp, shop: { id, name }, deal: { price: { amount, currency }, regular: {...}, cut } }, ... ]
            let lowestPrice = Infinity;
            let lowestEntry: any = null;
            const historyPoints: { amount: number; currency: string; date: string; store: string; storeId: number }[] = [];

            for (const entry of historyData) {
                const amount = entry.deal?.price?.amount;
                const currency = entry.deal?.price?.currency || "USD";
                const date = entry.timestamp;
                const storeId = entry.shop?.id || 0;
                const storeName = STORES.find(s => s.id === storeId)?.title || entry.shop?.name || "Unknown";

                if (typeof amount === 'number' && date) {
                    historyPoints.push({ amount, currency, date, store: storeName, storeId });

                    if (amount < lowestPrice) {
                        lowestPrice = amount;
                        lowestEntry = entry;
                    }
                }
            }

            // PART 3D: Sort points for deterministic graph rendering order.
            historyPoints.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

            if (lowestPrice !== Infinity && lowestEntry) {
                const storeId = lowestEntry.shop?.id || 0;
                const store = STORES.find(s => s.id === storeId)?.title || lowestEntry.shop?.name || "Unknown";
                const slug = gameSlug || appId;
                const currency = lowestEntry.deal?.price?.currency || "USD";

                // PART 3E: What every store charges right now. This is the headline
                // number - a historic low the user can no longer buy at is trivia.
                const liveDeals = (await this.getDealsForGameIds([gameId])).get(gameId) || [];

                return {
                    data: {
                        best: liveDeals.length > 0 ? liveDeals[0] : null,
                        deals: liveDeals,
                        lowest: {
                            amount: lowestPrice,
                            currency: currency,
                            date: lowestEntry.timestamp || new Date().toISOString(),
                            store: store,
                            storeId: storeId
                        },
                        history: historyPoints,
                        urls: {
                            steamdb: this.getSteamDBUrl(appId),
                            itad: `https://isthereanydeal.com/game/${slug}/`
                        }
                    },
                    debug: { lookupUrl, historyUrl, entries: historyData.length }
                };
            }

            return { data: null, error: "No valid deals in history", debug: { lookupUrl, historyUrl } };

        } catch (e) {
            console.error(e);
            return { data: null, error: "Exception: " + e, debug: { lookupUrl, historyUrl } };
        }
    }
}

export const priceService = new PriceService();
