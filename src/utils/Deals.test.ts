import { describe, expect, it } from "vitest";
import { Deal, buildRowDeals, dealKey, diffAnnouncements, formatRowPrice, normalizeDeal, normalizeDeals, pickWishlistDeal, planAnnouncements, sortRowDeals, storePageUrlFor } from "./Deals";

const deal = (overrides: Partial<Deal> = {}): Deal => ({
    amount: 10,
    currency: "EUR",
    cut: 50,
    store: "Steam",
    storeId: 61,
    url: "https://store.steampowered.com/app/1",
    ...overrides,
});

describe("normalizeDeal", () => {
    it("maps a well-formed ITAD entry, resolving the store name from its id", () => {
        const result = normalizeDeal({
            shop: { id: 35, name: "gog.com" },
            price: { amount: 14.99, currency: "EUR" },
            regular: { amount: 29.99, currency: "EUR" },
            cut: 50,
            url: "https://www.gog.com/game/x",
        });

        expect(result).toEqual({
            amount: 14.99,
            currency: "EUR",
            cut: 50,
            store: "GOG",
            storeId: 35,
            url: "https://www.gog.com/game/x",
        });
    });

    it("falls back to the shop name ITAD sent when the id is unknown to us", () => {
        const result = normalizeDeal({
            shop: { id: 9998, name: "Some New Store" },
            price: { amount: 5, currency: "USD" },
        });

        expect(result?.store).toBe("Some New Store");
    });

    it.each([
        ["a missing price", { shop: { id: 61 } }],
        ["a non-numeric amount", { price: { amount: "12.99" } }],
        ["a negative amount", { price: { amount: -1 } }],
        ["a NaN amount", { price: { amount: NaN } }],
        ["an infinite amount", { price: { amount: Infinity } }],
        ["a null entry", null],
    ])("rejects %s rather than displaying it", (_label, raw) => {
        expect(normalizeDeal(raw)).toBeNull();
    });

    it("treats a free game as a valid deal, not as missing data", () => {
        expect(normalizeDeal({ price: { amount: 0, currency: "EUR" } })?.amount).toBe(0);
    });

    it("discards a non-HTTPS url but keeps the price", () => {
        const result = normalizeDeal({
            price: { amount: 9.99 },
            url: "http://insecure.example.com/deal",
        });

        expect(result?.amount).toBe(9.99);
        expect(result?.url).toBe("");
    });

    it("treats an offer with no discount field as not discounted", () => {
        expect(normalizeDeal({ price: { amount: 9.99 } })?.cut).toBe(0);
    });
});

describe("normalizeDeals", () => {
    it("drops invalid entries and orders the rest cheapest first", () => {
        const deals = normalizeDeals([
            { shop: { id: 61 }, price: { amount: 30 } },
            { shop: { id: 35 }, price: { amount: -5 } },
            { shop: { id: 16 }, price: { amount: 12 } },
            { shop: { id: 6 }, price: { amount: 20 } },
        ]);

        expect(deals.map(d => d.amount)).toEqual([12, 20, 30]);
    });

    it("returns an empty list for a non-array payload", () => {
        expect(normalizeDeals(null)).toEqual([]);
        expect(normalizeDeals({ deals: [] })).toEqual([]);
    });
});

describe("pickWishlistDeal", () => {
    it("does not let a permanently cheap listing mask a genuine sale", () => {
        // The key regression: a reseller is cheapest but not discounted, while
        // another store is genuinely on sale. The sale is what the user wants.
        const deals = [
            deal({ amount: 25, cut: 0, store: "Cheap Reseller", storeId: 20 }),
            deal({ amount: 30, cut: 40, store: "Steam", storeId: 61 }),
        ];

        expect(pickWishlistDeal(deals, 20)?.store).toBe("Steam");
    });

    it("picks the cheapest offer among those clearing the threshold", () => {
        const deals = [
            deal({ amount: 18, cut: 10, storeId: 20 }),
            deal({ amount: 22, cut: 45, storeId: 35 }),
            deal({ amount: 26, cut: 60, storeId: 61 }),
        ];

        expect(pickWishlistDeal(deals, 40)?.amount).toBe(22);
    });

    it("returns null when nothing clears the threshold", () => {
        expect(pickWishlistDeal([deal({ cut: 15 })], 20)).toBeNull();
    });

    it("treats the threshold as inclusive", () => {
        expect(pickWishlistDeal([deal({ cut: 20 })], 20)).not.toBeNull();
    });

    it("returns null for an empty deal list", () => {
        expect(pickWishlistDeal([], 20)).toBeNull();
    });

    it("accepts any discount when the threshold is zero", () => {
        expect(pickWishlistDeal([deal({ cut: 0 })], 0)).not.toBeNull();
    });
});

describe("dealKey", () => {
    it("is stable for the same offer at the same price", () => {
        expect(dealKey(deal())).toBe(dealKey(deal()));
    });

    it.each([
        ["the price", { amount: 9 }],
        ["the store", { storeId: 35 }],
        ["the discount", { cut: 60 }],
    ])("changes when %s changes", (_label, override) => {
        expect(dealKey(deal(override))).not.toBe(dealKey(deal()));
    });

    it("ignores sub-cent float noise so a re-fetch does not re-notify", () => {
        expect(dealKey(deal({ amount: 10.001 }))).toBe(dealKey(deal({ amount: 10.004 })));
    });
});

describe("diffAnnouncements", () => {
    it("announces a deal the user has not been told about", () => {
        const candidates = [{ appId: "570", deal: deal() }];

        const { fresh } = diffAnnouncements(candidates, {});

        expect(fresh).toHaveLength(1);
    });

    it("stays quiet on a repeat check of the same offer", () => {
        const candidates = [{ appId: "570", deal: deal() }];
        const seen = { "570": dealKey(deal()) };

        const { fresh } = diffAnnouncements(candidates, seen);

        expect(fresh).toHaveLength(0);
    });

    it("announces again when the price drops further", () => {
        const candidates = [{ appId: "570", deal: deal({ amount: 8, cut: 60 }) }];
        const seen = { "570": dealKey(deal()) };

        const { fresh } = diffAnnouncements(candidates, seen);

        expect(fresh).toHaveLength(1);
    });

    it("forgets a game once its sale ends, so the next sale alerts again", () => {
        // Pass 1: on sale, remembered.
        const first = diffAnnouncements([{ appId: "570", deal: deal() }], {});
        expect(first.nextSeen).toHaveProperty("570");

        // Pass 2: no longer discounted, so it is not a candidate at all.
        const second = diffAnnouncements([], first.nextSeen);
        expect(second.nextSeen).not.toHaveProperty("570");

        // Pass 3: the same sale returns and must be announced again.
        const third = diffAnnouncements([{ appId: "570", deal: deal() }], second.nextSeen);
        expect(third.fresh).toHaveLength(1);
    });

    it("remembers every current candidate, including ones it stayed quiet about", () => {
        const candidates = [
            { appId: "570", deal: deal() },
            { appId: "440", deal: deal({ storeId: 35 }) },
        ];
        const seen = { "570": dealKey(deal()) };

        const { fresh, nextSeen } = diffAnnouncements(candidates, seen);

        expect(fresh.map(c => c.appId)).toEqual(["440"]);
        expect(Object.keys(nextSeen).sort()).toEqual(["440", "570"]);
    });

    it("does not mutate the caller's seen map", () => {
        const seen = { "570": "stale" };

        diffAnnouncements([{ appId: "570", deal: deal() }], seen);

        expect(seen).toEqual({ "570": "stale" });
    });
});

describe("planAnnouncements", () => {
    const candidates = [
        { appId: "570", deal: deal() },
        { appId: "440", deal: deal({ storeId: 35 }) },
    ];

    it("stays silent on the first run instead of announcing a backlog of old sales", () => {
        const { announce } = planAnnouncements(candidates, {}, true);

        expect(announce).toEqual([]);
    });

    it("still records the baseline it stayed silent about", () => {
        const { nextSeen } = planAnnouncements(candidates, {}, true);

        expect(Object.keys(nextSeen).sort()).toEqual(["440", "570"]);
    });

    it("announces normally on every later run", () => {
        const { announce } = planAnnouncements(candidates, {}, false);

        expect(announce).toHaveLength(2);
    });

    it("does not suppress a game wishlisted later while already on sale", () => {
        // Seeded on the first pass with one game...
        const { nextSeen } = planAnnouncements([candidates[0]], {}, true);

        // ...a second game appears, already discounted. That is news to the user.
        const { announce } = planAnnouncements(candidates, nextSeen, false);

        expect(announce.map(c => c.appId)).toEqual(["440"]);
    });

    it("does not suppress a discount that deepens after seeding", () => {
        const { nextSeen } = planAnnouncements([{ appId: "570", deal: deal({ cut: 25 }) }], {}, true);

        const { announce } = planAnnouncements(
            [{ appId: "570", deal: deal({ cut: 50, amount: 5 }) }],
            nextSeen,
            false
        );

        expect(announce).toHaveLength(1);
    });

    it("re-announces everything once the seen map is cleared, so a reset is testable", () => {
        const { announce } = planAnnouncements(candidates, {}, false);

        expect(announce).toHaveLength(2);
    });
});

describe("deals list", () => {
    it("keys entries by Steam app id so a row can link to its store page", () => {
        const rows = buildRowDeals([
            { appId: "570", gameId: "g1", deal: deal({ amount: 12.5, cut: 40, store: "GOG" }) },
        ]);

        expect(rows["570"]).toEqual({
            gameId: "g1",
            amount: 12.5,
            currency: "EUR",
            cut: 40,
            store: "GOG",
        });
    });

    it("orders by deepest discount, then by price", () => {
        const rows = sortRowDeals({
            a: { gameId: "g1", amount: 30, currency: "EUR", cut: 50, store: "Steam" },
            b: { gameId: "g2", amount: 10, currency: "EUR", cut: 80, store: "GOG" },
            c: { gameId: "g3", amount: 5, currency: "EUR", cut: 50, store: "Fanatical" },
        });

        expect(rows.map(r => r.appId)).toEqual(["b", "c", "a"]);
    });

    it("returns an empty list when nothing has been found", () => {
        expect(sortRowDeals({})).toEqual([]);
    });

    it("fills the localized template with price, discount and store", () => {
        const deal = { gameId: "g", amount: 24.99, currency: "EUR", cut: 58, store: "GOG" };

        expect(formatRowPrice(deal, "{price} (-{cut}%) at {store}"))
            .toBe("24.99 EUR (-58%) at GOG");
    });

    it("lets a translation reorder the parts", () => {
        const deal = { gameId: "g", amount: 24.99, currency: "EUR", cut: 58, store: "GOG" };

        expect(formatRowPrice(deal, "{store}: -{cut}% ({price})"))
            .toBe("GOG: -58% (24.99 EUR)");
    });

    it("links a row to the right Steam page", () => {
        expect(storePageUrlFor("1086940")).toBe("https://store.steampowered.com/app/1086940/");
    });
});
