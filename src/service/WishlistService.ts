import { Navigation, ServerAPI } from "decky-frontend-lib";
import { SETTINGS, Setting } from "../utils/Settings";
import { priceService } from "./PriceService";
import { DEALS_ROUTE, Deal, buildRowDeals, pickWishlistDeal, planAnnouncements, storePageUrlFor } from "../utils/Deals";
import { isValidSteamId64, parseWishlistAppIds } from "../utils/ApiParsing";
import { t } from "../l10n";

/*
 * WishlistService watches the signed-in user's Steam wishlist and raises a
 * Decky toast when a wishlisted game is discounted anywhere - not just on
 * Steam. Steam itself only notifies about Steam sales, which is exactly the
 * gap this fills.
 *
 * Flow:
 * 1) Resolve the signed-in SteamID64 from the Steam client frontend.
 * 2) Pull the wishlist app ids from Steam's public wishlist API.
 * 3) Bulk-resolve those app ids to ITAD game ids (cached in memory).
 * 4) Ask ITAD for live prices across every store the user selected.
 * 5) Toast anything at or above the configured discount that we have not
 *    already announced at that exact price.
 *
 * Security model:
 * - Only two hosts are contacted: Steam's public API and ITAD (via PriceService).
 * - The SteamID is read locally and validated as a 17-digit number.
 * - Response payloads are size-bounded and strictly shape-checked.
 * - Every failure path is non-fatal; the watcher simply retries next cycle.
 */

interface WishlistCandidate {
    appId: string;
    gameId: string;
    deal: Deal;
}

class WishlistService {
    // =========================================================================
    // PART 1: Service State
    // =========================================================================
    private serverApi: ServerAPI | undefined;
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    /** Bumped on every start/stop so a delayed first pass cannot re-arm a stopped watcher. */
    private generation = 0;
    private readonly WISHLIST_HOST = "api.steampowered.com";
    private readonly WISHLIST_PATH = "/IWishlistService/GetWishlist/v1/";
    private readonly MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
    /** Bound the work for people with enormous wishlists. */
    private readonly MAX_WISHLIST_APPS = 500;
    /** Announce at most this many games individually; the rest get one summary. */
    private readonly MAX_INDIVIDUAL_TOASTS = 3;
    /** Steam app id -> ITAD game id, cached for the session. */
    private idCache = new Map<string, string>();
    private lastError: string | null = null;

    public init(serverApi: ServerAPI) {
        this.serverApi = serverApi;
    }

    // =========================================================================
    // PART 2: Scheduling
    // Purpose: Run a check shortly after boot, then on the configured interval.
    // =========================================================================
    public async start() {
        await this.stop();

        const enabled = await SETTINGS.load(Setting.WISHLIST_ALERTS);
        if (!enabled) return;

        const hours = await this.getCheckIntervalHours();
        const intervalMs = hours * 60 * 60 * 1000;
        const generation = this.generation;

        // Give the Steam client a moment to finish signing in before the first pass.
        this.timer = setTimeout(async () => {
            await this.check();
            // The plugin may have been stopped while that first check was in flight.
            if (generation !== this.generation) return;
            this.timer = setInterval(() => { void this.check(); }, intervalMs);
        }, 60 * 1000);
    }

    public async stop() {
        this.generation++;
        if (this.timer) {
            clearTimeout(this.timer as NodeJS.Timeout);
            clearInterval(this.timer as NodeJS.Timeout);
            this.timer = null;
        }
    }

    /** Restart the schedule after a settings change. */
    public async restart() {
        await this.start();
    }

    private async getCheckIntervalHours(): Promise<number> {
        const raw = await SETTINGS.load(Setting.WISHLIST_CHECK_HOURS);
        const hours = Number(raw);
        if (!Number.isFinite(hours) || hours < 1 || hours > 168) return 6;
        return hours;
    }

    // =========================================================================
    // PART 3: SteamID Discovery
    // Purpose: Read the signed-in account id from the Steam client frontend.
    // Security: Accepts only a 17-digit SteamID64; never leaves the device
    //           except as the `steamid` parameter of Steam's own wishlist API.
    // =========================================================================
    private getSteamId(): string | null {
        const candidates: unknown[] = [];
        try {
            const w = window as any;
            candidates.push(w?.App?.m_CurrentUser?.strSteamID);
            candidates.push(w?.g_steamID);
            candidates.push(w?.App?.cm?.m_steamid?.m_ulSteamID?.toString?.());
            candidates.push(w?.LoginStore?.m_strAccountSteamID);
        } catch {
            return null;
        }

        for (const candidate of candidates) {
            if (isValidSteamId64(candidate)) return String(candidate);
        }
        return null;
    }

    // =========================================================================
    // PART 4: Wishlist Retrieval
    // Purpose: Pull wishlisted app ids from Steam's public wishlist API.
    // Security: Pinned HTTPS host/path, bounded body, strict array parsing.
    // =========================================================================
    private buildWishlistUrl(steamId: string): string {
        const url = new URL(`https://${this.WISHLIST_HOST}${this.WISHLIST_PATH}`);
        url.searchParams.set("steamid", steamId);
        return url.toString();
    }

    private isAllowedWishlistUrl(urlString: string): boolean {
        try {
            const url = new URL(urlString);
            return url.protocol === "https:"
                && url.hostname === this.WISHLIST_HOST
                && url.pathname === this.WISHLIST_PATH;
        } catch {
            return false;
        }
    }

    private parseBodyString(result: unknown): string | null {
        if (result && typeof result === "object" && "body" in result && typeof (result as any).body === "string") {
            return (result as any).body;
        }
        if (typeof result === "string") return result;
        return null;
    }

    public async fetchWishlistAppIds(): Promise<{ appIds: string[]; error?: string }> {
        if (!this.serverApi) return { appIds: [], error: "notReady" };

        const steamId = this.getSteamId();
        if (!steamId) return { appIds: [], error: "noSteamId" };

        const url = this.buildWishlistUrl(steamId);
        if (!this.isAllowedWishlistUrl(url)) return { appIds: [], error: "blocked" };

        try {
            const res = await this.serverApi.fetchNoCors(url, { method: "GET" });
            if (!res.success) return { appIds: [], error: "fetchFailed" };

            const body = this.parseBodyString(res.result);
            if (!body || body.length > this.MAX_RESPONSE_BYTES) return { appIds: [], error: "badResponse" };

            return parseWishlistAppIds(JSON.parse(body), this.MAX_WISHLIST_APPS);
        } catch (e) {
            console.error("[Deckdeals] Wishlist fetch failed", e);
            return { appIds: [], error: "exception" };
        }
    }

    // =========================================================================
    // PART 5: Deal Check
    // Purpose: Compare live prices against the user's discount threshold and
    //          announce anything not already seen at that price.
    // =========================================================================

    private async getMinDiscount(): Promise<number> {
        const raw = await SETTINGS.load(Setting.WISHLIST_MIN_DISCOUNT);
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || value > 100) return 20;
        return value;
    }

    /**
     * Run one wishlist pass. Returns a short status the settings UI can show.
     */
    public async check(): Promise<{ found: number; checked: number; error?: string; seeded?: boolean }> {
        if (this.running) return { found: 0, checked: 0, error: "busy" };
        this.running = true;

        try {
            const enabled = await SETTINGS.load(Setting.WISHLIST_ALERTS);
            if (!enabled) return { found: 0, checked: 0, error: "disabled" };

            const { appIds, error } = await this.fetchWishlistAppIds();
            if (error) {
                this.lastError = error;
                return { found: 0, checked: 0, error };
            }
            this.lastError = null;
            if (appIds.length === 0) return { found: 0, checked: 0 };

            // Resolve ITAD ids, reusing anything already mapped this session.
            const unknownAppIds = appIds.filter(id => !this.idCache.has(id));
            if (unknownAppIds.length > 0) {
                const resolved = await priceService.lookupItadIds(unknownAppIds);
                for (const [appId, gameId] of resolved) this.idCache.set(appId, gameId);
            }

            const gameIdByApp = new Map<string, string>();
            for (const appId of appIds) {
                const gameId = this.idCache.get(appId);
                if (gameId) gameIdByApp.set(appId, gameId);
            }
            if (gameIdByApp.size === 0) return { found: 0, checked: appIds.length };

            const dealsByGame = await priceService.getDealsForGameIds([...gameIdByApp.values()]);
            const minDiscount = await this.getMinDiscount();

            const candidates: WishlistCandidate[] = [];
            for (const [appId, gameId] of gameIdByApp) {
                const deal = pickWishlistDeal(dealsByGame.get(gameId) || [], minDiscount);
                if (!deal) continue;
                candidates.push({ appId, gameId, deal });
            }

            const seenRaw = await SETTINGS.load(Setting.WISHLIST_SEEN);
            const seen: Record<string, string> = (seenRaw && typeof seenRaw === "object" && !Array.isArray(seenRaw))
                ? { ...seenRaw }
                : {};

            // The first pass only establishes a baseline - see planAnnouncements.
            const isFirstRun = !(await SETTINGS.load(Setting.WISHLIST_SEEDED));
            const { announce, nextSeen } = planAnnouncements(candidates, seen, isFirstRun);

            if (announce.length > 0) await this.announce(announce);

            await SETTINGS.save(Setting.WISHLIST_SEEN, nextSeen);
            // Published for the wishlist page, which annotates matching rows.
            await SETTINGS.save(Setting.WISHLIST_DEALS, buildRowDeals(candidates));
            await SETTINGS.save(Setting.WISHLIST_LAST_CHECK, Date.now());
            if (isFirstRun) await SETTINGS.save(Setting.WISHLIST_SEEDED, true);

            return { found: announce.length, checked: gameIdByApp.size, seeded: isFirstRun };
        } catch (e) {
            console.error("[Deckdeals] Wishlist check failed", e);
            return { found: 0, checked: 0, error: "exception" };
        } finally {
            this.running = false;
        }
    }

    // =========================================================================
    // PART 6: Notification
    // Purpose: Surface findings as Decky toasts without flooding the user.
    // =========================================================================
    /**
     * Open a game's Steam store page in the Steam in-app browser.
     *
     * That page is where StoreInjector renders the Deckdeals module, so a
     * tapped notification lands on the full cross-store comparison rather than
     * just telling the user a deal exists somewhere.
     */
    private navigateTo(url: string) {
        try {
            Navigation.CloseSideMenus();
            Navigation.NavigateToSteamWeb(url);
        } catch (e) {
            console.error("[Deckdeals] Could not open page", e);
        }
    }



    /**
     * Open the in-plugin deals list.
     *
     * A summary toast names one game but stands for many, so it leads to the
     * list of everything found rather than to a single store page. Steam's own
     * wishlist was the other candidate, but it shows Steam prices only - it
     * would not display the non-Steam deals the notification was about.
     */
    private openDealsList() {
        try {
            Navigation.CloseSideMenus();
            Navigation.Navigate(DEALS_ROUTE);
        } catch (e) {
            console.error("[Deckdeals] Could not open deals list", e);
        }
    }

    private formatDeal(deal: Deal): string {
        return t("wishlist.toast.body")
            .replace("{cut}", String(deal.cut))
            .replace("{price}", `${deal.amount.toFixed(2)} ${deal.currency}`)
            .replace("{store}", deal.store);
    }

    private async announce(candidates: WishlistCandidate[]) {
        if (!this.serverApi) return;

        // Biggest discount first, so the summary toast leads with the best find.
        const byDiscount = [...candidates].sort((a, b) => b.deal.cut - a.deal.cut);

        if (byDiscount.length <= this.MAX_INDIVIDUAL_TOASTS) {
            for (const candidate of byDiscount) {
                const title = await priceService.getGameTitle(candidate.gameId)
                    || t("wishlist.toast.fallbackTitle");
                this.serverApi.toaster.toast({
                    title,
                    body: this.formatDeal(candidate.deal),
                    duration: 8000,
                    onClick: () => this.navigateTo(storePageUrlFor(candidate.appId)),
                });
            }
            return;
        }

        const headline = byDiscount[0];
        const title = await priceService.getGameTitle(headline.gameId) || t("wishlist.toast.fallbackTitle");
        this.serverApi.toaster.toast({
            title: t("wishlist.toast.summaryTitle").replace("{count}", String(byDiscount.length)),
            body: `${title} - ${this.formatDeal(headline.deal)}`,
            duration: 10000,
            onClick: () => this.openDealsList(),
        });
    }

    /**
     * Forget which deals have already been announced, so the next check
     * re-announces everything currently on sale.
     *
     * The seeded flag is deliberately left set: clearing it would make the next
     * pass a silent first run again, which is the opposite of what someone
     * asking to be re-told wants (and would make this useless for verifying
     * that notifications work at all).
     */
    public async resetAlertHistory() {
        await SETTINGS.save(Setting.WISHLIST_SEEN, {});
    }

    public getLastError(): string | null {
        return this.lastError;
    }
}

export const wishlistService = new WishlistService();
