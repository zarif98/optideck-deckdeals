import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * End-to-end tests for the wishlist alert flow, with Steam and ITAD faked.
 *
 * There is no simulated Steam client, but there does not need to be: every
 * external dependency reaches the plugin through the ServerAPI object Decky
 * injects - `fetchNoCors` for all network traffic, `callPluginMethod` for
 * settings persistence, and `toaster.toast` for the notification itself. A
 * fake ServerAPI therefore lets us drive the real code path end to end and
 * assert on the toast that comes out, instead of waiting for a real sale.
 *
 * Each test gets fresh module instances (the services are singletons holding
 * their own caches), so scenarios cannot leak into one another.
 */

const STEAM_ID = "76561197960287930";
const API_KEY = "k".repeat(32);

interface FakeDeal {
    shopId: number;
    shopName: string;
    amount: number;
    cut: number;
}

interface WorldState {
    /** Steam app ids on the wishlist, or null to simulate a private wishlist. */
    wishlist: number[] | null;
    /** Steam app id -> ITAD game id. Missing entries mean ITAD does not know it. */
    itadIds: Record<string, string>;
    /** ITAD game id -> the offers live right now. */
    deals: Record<string, FakeDeal[]>;
    /** ITAD game id -> display title. */
    titles: Record<string, string>;
}

function makeWorld(overrides: Partial<WorldState> = {}): WorldState {
    return {
        wishlist: [1086940],
        itadIds: { "1086940": "game-bg3" },
        deals: {},
        titles: { "game-bg3": "Baldur's Gate 3" },
        ...overrides,
    };
}

/** Build the fake ServerAPI Decky would otherwise provide. */
function makeServerApi(world: WorldState) {
    const toasts: { title: string; body: string; onClick?: () => void }[] = [];
    const settingsStore: Record<string, unknown> = {};
    const requests: { url: string; body?: string }[] = [];

    const json = (value: unknown) => ({ success: true, result: { body: JSON.stringify(value) } });

    const serverApi = {
        toaster: {
            toast: (t: any) => {
                toasts.push({ title: String(t.title), body: String(t.body), onClick: t.onClick });
            },
        },

        callPluginMethod: async (method: string, args: any) => {
            if (method === "settings_load") {
                const stored = settingsStore[args.key];
                return { success: true, result: stored !== undefined ? stored : args.defaults };
            }
            if (method === "settings_save") {
                settingsStore[args.key] = args.value;
                return { success: true, result: args.value };
            }
            return { success: false, result: null };
        },

        fetchNoCors: async (url: string, init?: any) => {
            requests.push({ url, body: init?.body });
            const target = new URL(url);

            // Provider credentials.
            if (target.hostname === "api.optideck.gg") {
                return json({ itad_api_key: API_KEY, exchange_rate_api_key: API_KEY });
            }

            // Steam's wishlist API.
            if (target.hostname === "api.steampowered.com") {
                if (world.wishlist === null) return json({ response: {} }); // private
                return json({ response: { items: world.wishlist.map(appid => ({ appid })) } });
            }

            // ITAD bulk Steam-app-id -> game-id lookup.
            if (target.pathname === "/lookup/id/shop/61/v1") {
                const requested: string[] = JSON.parse(init.body);
                const out: Record<string, string> = {};
                for (const key of requested) {
                    const appId = key.replace("app/", "");
                    if (world.itadIds[appId]) out[key] = world.itadIds[appId];
                }
                return json(out);
            }

            // ITAD live prices.
            if (target.pathname === "/games/prices/v3") {
                const requested: string[] = JSON.parse(init.body);
                return json(requested.map(id => ({
                    id,
                    deals: (world.deals[id] || []).map(d => ({
                        shop: { id: d.shopId, name: d.shopName },
                        price: { amount: d.amount, currency: "EUR" },
                        regular: { amount: 59.99, currency: "EUR" },
                        cut: d.cut,
                        url: "https://example.com/deal",
                    })),
                })));
            }

            // ITAD game info (titles for notifications).
            if (target.pathname === "/games/info/v2") {
                const id = target.searchParams.get("id") || "";
                return json({ title: world.titles[id] ?? "Unknown Game" });
            }

            return { success: false, result: null };
        },
    };

    return { serverApi, toasts, settingsStore, requests };
}

/** Fresh module instances plus a wired-up fake device. */
async function boot(world: WorldState) {
    vi.resetModules();

    (globalThis as any).window = { App: { m_CurrentUser: { strSteamID: STEAM_ID } } };

    const harness = makeServerApi(world);
    const api = harness.serverApi as any;

    const { Cache } = await import("../utils/Cache");
    // SETTINGS is a `let` binding assigned by init(), so hold the module and
    // read through it rather than destructuring the (still undefined) value.
    const settingsModule = await import("../utils/Settings");
    const { Settings, Setting } = settingsModule;
    const { providerAuthService } = await import("./ProviderAuthService");
    const { priceService } = await import("./PriceService");
    const { wishlistService } = await import("./WishlistService");
    const decky = await import("decky-frontend-lib") as any;
    decky.resetNavCalls();

    Cache.init();
    Settings.init(api);
    providerAuthService.init(api);
    priceService.init(api);
    wishlistService.init(api);

    return { ...harness, wishlistService, settingsModule, Setting, navCalls: decky.navCalls };
}

const deal = (overrides: Partial<FakeDeal> = {}): FakeDeal => ({
    shopId: 61,
    shopName: "Steam",
    amount: 29.99,
    cut: 50,
    ...overrides,
});

describe("wishlist alerts, end to end", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it("says nothing on the first run, even though a sale is already live", async () => {
        const world = makeWorld({ deals: { "game-bg3": [deal()] } });
        const { wishlistService, toasts } = await boot(world);

        const result = await wishlistService.check();

        expect(toasts).toEqual([]);
        expect(result.seeded).toBe(true);
    });

    it("notifies when a new sale appears after the baseline is set", async () => {
        // Pass 1: nothing on sale, so the baseline is empty.
        const world = makeWorld({ deals: { "game-bg3": [] } });
        const { wishlistService, toasts } = await boot(world);
        await wishlistService.check();
        expect(toasts).toEqual([]);

        // Pass 2: the sale starts. This is the moment the user cares about.
        world.deals["game-bg3"] = [deal({ amount: 29.99, cut: 50 })];
        const result = await wishlistService.check();

        expect(result.found).toBe(1);
        expect(toasts).toHaveLength(1);
        expect(toasts[0].title).toBe("Baldur's Gate 3");
        expect(toasts[0].body).toContain("50");
        expect(toasts[0].body).toContain("29.99 EUR");
        expect(toasts[0].body).toContain("Steam");
    });

    it("does not repeat itself while the same sale continues", async () => {
        const world = makeWorld({ deals: { "game-bg3": [] } });
        const { wishlistService, toasts } = await boot(world);
        await wishlistService.check();

        world.deals["game-bg3"] = [deal()];
        await wishlistService.check();
        expect(toasts).toHaveLength(1);

        await wishlistService.check();
        await wishlistService.check();
        expect(toasts).toHaveLength(1);
    });

    it("notifies again when the discount deepens", async () => {
        const world = makeWorld({ deals: { "game-bg3": [] } });
        const { wishlistService, toasts } = await boot(world);
        await wishlistService.check();

        world.deals["game-bg3"] = [deal({ amount: 29.99, cut: 50 })];
        await wishlistService.check();

        world.deals["game-bg3"] = [deal({ amount: 17.99, cut: 70 })];
        await wishlistService.check();

        expect(toasts).toHaveLength(2);
        expect(toasts[1].body).toContain("17.99 EUR");
    });

    it("notifies again when a sale ends and later returns", async () => {
        const world = makeWorld({ deals: { "game-bg3": [] } });
        const { wishlistService, toasts } = await boot(world);
        await wishlistService.check();

        world.deals["game-bg3"] = [deal()];
        await wishlistService.check();
        expect(toasts).toHaveLength(1);

        world.deals["game-bg3"] = []; // sale ends
        await wishlistService.check();

        world.deals["game-bg3"] = [deal()]; // and comes back
        await wishlistService.check();

        expect(toasts).toHaveLength(2);
    });

    it("reports a non-Steam sale, which Steam itself would never tell you about", async () => {
        const world = makeWorld({ deals: { "game-bg3": [] } });
        const { wishlistService, toasts } = await boot(world);
        await wishlistService.check();

        world.deals["game-bg3"] = [deal({ shopId: 35, shopName: "gog.com", amount: 24.99, cut: 58 })];
        await wishlistService.check();

        expect(toasts[0].body).toContain("GOG");
    });

    it("stays quiet for a discount below the configured threshold", async () => {
        const world = makeWorld({ deals: { "game-bg3": [] } });
        const { wishlistService, toasts } = await boot(world);
        await wishlistService.check();

        world.deals["game-bg3"] = [deal({ cut: 10 })];
        const result = await wishlistService.check();

        expect(result.found).toBe(0);
        expect(toasts).toEqual([]);
    });

    it("collapses a large batch into a single summary rather than flooding", async () => {
        const world = makeWorld({
            wishlist: [1, 2, 3, 4, 5],
            itadIds: { "1": "g1", "2": "g2", "3": "g3", "4": "g4", "5": "g5" },
            titles: { g1: "Game One", g2: "Game Two", g3: "Game Three", g4: "Game Four", g5: "Game Five" },
            deals: {},
        });
        const { wishlistService, toasts } = await boot(world);
        await wishlistService.check();

        for (const id of ["g1", "g2", "g3", "g4", "g5"]) {
            world.deals[id] = [deal({ cut: 60 })];
        }
        await wishlistService.check();

        expect(toasts).toHaveLength(1);
        expect(toasts[0].title).toContain("5");
    });

    it("re-announces current sales after the alert history is reset", async () => {
        const world = makeWorld({ deals: { "game-bg3": [] } });
        const { wishlistService, toasts } = await boot(world);
        await wishlistService.check();

        world.deals["game-bg3"] = [deal()];
        await wishlistService.check();
        expect(toasts).toHaveLength(1);

        // Resetting must not re-seed, or it would silently swallow everything.
        await wishlistService.resetAlertHistory();
        await wishlistService.check();

        expect(toasts).toHaveLength(2);
    });

    it("reports a private wishlist instead of silently finding nothing", async () => {
        const world = makeWorld({ wishlist: null, deals: { "game-bg3": [deal()] } });
        const { wishlistService, toasts } = await boot(world);

        const result = await wishlistService.check();

        expect(result.error).toBe("private");
        expect(toasts).toEqual([]);
    });

    it("reports a missing SteamID rather than calling Steam with a bad id", async () => {
        const world = makeWorld();
        const { wishlistService, requests } = await boot(world);
        (globalThis as any).window = { App: { m_CurrentUser: { strSteamID: "not-a-steamid" } } };

        const result = await wishlistService.check();

        expect(result.error).toBe("noSteamId");
        expect(requests.some(r => r.url.includes("api.steampowered.com"))).toBe(false);
    });

    it("does nothing at all when alerts are switched off", async () => {
        const world = makeWorld({ deals: { "game-bg3": [deal()] } });
        const { wishlistService, settingsModule, Setting, toasts, requests } = await boot(world);

        await settingsModule.SETTINGS.save(Setting.WISHLIST_ALERTS, false);
        const result = await wishlistService.check();

        expect(result.error).toBe("disabled");
        expect(toasts).toEqual([]);
        expect(requests.some(r => r.url.includes("api.steampowered.com"))).toBe(false);
    });

    it("skips wishlist entries ITAD does not recognise without failing the run", async () => {
        const world = makeWorld({
            wishlist: [1086940, 999999],
            itadIds: { "1086940": "game-bg3" },
            deals: { "game-bg3": [] },
        });
        const { wishlistService, toasts } = await boot(world);
        await wishlistService.check();

        world.deals["game-bg3"] = [deal()];
        const result = await wishlistService.check();

        expect(result.checked).toBe(1);
        expect(toasts).toHaveLength(1);
    });

    it("sends the SteamID only to Steam, and never to ITAD or Optideck", async () => {
        const world = makeWorld({ deals: { "game-bg3": [deal()] } });
        const { wishlistService, requests } = await boot(world);

        await wishlistService.check();

        const leaked = requests.filter(r =>
            !r.url.includes("api.steampowered.com") &&
            (r.url.includes(STEAM_ID) || (r.body ?? "").includes(STEAM_ID))
        );
        expect(leaked).toEqual([]);
    });
});

describe("notification click-through", () => {
    it("takes you to the game's Steam store page, where the comparison is shown", async () => {
        const world = makeWorld({ deals: { "game-bg3": [] } });
        const { wishlistService, toasts, navCalls } = await boot(world);
        await wishlistService.check();

        world.deals["game-bg3"] = [deal({ shopId: 35, shopName: "gog.com", cut: 60 })];
        await wishlistService.check();

        expect(toasts[0].onClick).toBeTypeOf("function");

        toasts[0].onClick!();

        expect(navCalls).toContainEqual({
            method: "NavigateToSteamWeb",
            arg: "https://store.steampowered.com/app/1086940/",
        });
    });

    it("closes the quick access menu first, so the page is actually visible", async () => {
        const world = makeWorld({ deals: { "game-bg3": [] } });
        const { wishlistService, toasts, navCalls } = await boot(world);
        await wishlistService.check();

        world.deals["game-bg3"] = [deal()];
        await wishlistService.check();
        toasts[0].onClick!();

        expect(navCalls[0].method).toBe("CloseSideMenus");
    });

    it("makes the summary toast open the deals list, which shows every game found", async () => {
        const world = makeWorld({
            wishlist: [11, 22, 33, 44],
            itadIds: { "11": "g1", "22": "g2", "33": "g3", "44": "g4" },
            titles: { g1: "One", g2: "Two", g3: "Three", g4: "Four" },
            deals: {},
        });
        const { wishlistService, toasts, navCalls } = await boot(world);
        await wishlistService.check();

        // g3 has the deepest discount, so it headlines the summary.
        world.deals["g1"] = [deal({ cut: 30 })];
        world.deals["g2"] = [deal({ cut: 40 })];
        world.deals["g3"] = [deal({ cut: 80 })];
        world.deals["g4"] = [deal({ cut: 50 })];
        await wishlistService.check();

        expect(toasts).toHaveLength(1);
        expect(toasts[0].body).toContain("Three");

        toasts[0].onClick!();

        expect(navCalls).toContainEqual({ method: "Navigate", arg: "/deckdeals/deals" });
    });

    it("keeps deals in the list on later checks, after they stop being announced", async () => {
        // Opening the list hours later must still show what is on sale, even
        // though those deals were announced once and are now quiet.
        const world = makeWorld({ deals: { "game-bg3": [] } });
        const { wishlistService, settingsModule, Setting, toasts } = await boot(world);
        await wishlistService.check();

        world.deals["game-bg3"] = [deal({ cut: 50 })];
        await wishlistService.check();
        expect(toasts).toHaveLength(1);

        // Second pass over the same sale: nothing new to announce...
        await wishlistService.check();
        expect(toasts).toHaveLength(1);

        // ...but the list must not go empty.
        const stored = await settingsModule.SETTINGS.load(Setting.WISHLIST_DEALS);
        expect(Object.keys(stored)).toEqual(["1086940"]);
    });

    it("records every qualifying deal for the list, not just the ones announced", async () => {
        const world = makeWorld({
            wishlist: [11, 22, 33, 44],
            itadIds: { "11": "g1", "22": "g2", "33": "g3", "44": "g4" },
            titles: { g1: "One", g2: "Two", g3: "Three", g4: "Four" },
            deals: {},
        });
        const { wishlistService, settingsModule, Setting } = await boot(world);
        await wishlistService.check();

        world.deals["g1"] = [deal({ cut: 30, amount: 10 })];
        world.deals["g2"] = [deal({ cut: 40, amount: 20 })];
        world.deals["g3"] = [deal({ cut: 80, amount: 5, shopId: 35, shopName: "gog.com" })];
        world.deals["g4"] = [deal({ cut: 50, amount: 30 })];
        await wishlistService.check();

        const stored = await settingsModule.SETTINGS.load(Setting.WISHLIST_DEALS);

        expect(Object.keys(stored).sort()).toEqual(["11", "22", "33", "44"]);
        expect(stored["33"]).toMatchObject({ gameId: "g3", cut: 80, amount: 5, store: "GOG" });
    });
});
