import { describe, expect, it } from "vitest";
import {
    buildShopsParam,
    isLegacyStoreDefault,
    isValidAppId,
    isValidCountry,
    isValidSteamId64,
    parseBulkLookupMap,
    parseWishlistAppIds,
} from "./ApiParsing";
import { ALL_STORE_IDS, STEAM_STORE_ID } from "./Stores";

describe("isValidSteamId64", () => {
    it("accepts a 17-digit id", () => {
        expect(isValidSteamId64("76561197960287930")).toBe(true);
    });

    it.each([
        ["too short", "7656119796028793"],
        ["too long", "765611979602879301"],
        ["non-numeric", "7656119796028793a"],
        ["an account name", "someuser"],
        ["empty", ""],
        ["undefined", undefined],
        ["null", null],
    ])("rejects %s", (_label, value) => {
        expect(isValidSteamId64(value)).toBe(false);
    });
});

describe("parseWishlistAppIds", () => {
    it("extracts app ids as strings", () => {
        const result = parseWishlistAppIds(
            { response: { items: [{ appid: 1086940 }, { appid: 570 }] } },
            500
        );

        expect(result.appIds).toEqual(["1086940", "570"]);
    });

    it("distinguishes a private wishlist from an empty one", () => {
        // These need different messages in the UI, so they must not collapse.
        const privateList = parseWishlistAppIds({ response: {} }, 500);
        const emptyList = parseWishlistAppIds({ response: { items: [] } }, 500);

        expect(privateList).toHaveProperty("error", "private");
        expect(emptyList).not.toHaveProperty("error");
        expect(emptyList.appIds).toEqual([]);
    });

    it.each([
        ["a null payload", null],
        ["a string payload", "nope"],
        ["a missing response envelope", {}],
        ["items that are not an array", { response: { items: "nope" } }],
    ])("reports %s as private rather than throwing", (_label, payload) => {
        expect(parseWishlistAppIds(payload, 500)).toHaveProperty("error", "private");
    });

    it("skips malformed entries without discarding the good ones", () => {
        const result = parseWishlistAppIds(
            {
                response: {
                    items: [
                        { appid: 570 },
                        { appid: "1086940" },
                        { appid: 0 },
                        { appid: -5 },
                        { appid: 1.5 },
                        {},
                        null,
                        { appid: 440 },
                    ],
                },
            },
            500
        );

        expect(result.appIds).toEqual(["570", "440"]);
    });

    it("caps the number of entries it will process", () => {
        const items = Array.from({ length: 600 }, (_, i) => ({ appid: i + 1 }));

        const result = parseWishlistAppIds({ response: { items } }, 500);

        expect(result.appIds).toHaveLength(500);
        expect(result.appIds[499]).toBe("500");
    });
});

describe("parseBulkLookupMap", () => {
    it("strips the shop prefix so keys match wishlist app ids", () => {
        const result = parseBulkLookupMap({ "app/1086940": "018d937f-1234" });

        expect(result.get("1086940")).toBe("018d937f-1234");
    });

    it("keeps unprefixed keys as-is", () => {
        expect(parseBulkLookupMap({ "570": "abc" }).get("570")).toBe("abc");
    });

    it("drops entries ITAD could not resolve", () => {
        const result = parseBulkLookupMap({
            "app/570": "valid-id",
            "app/1": null,
            "app/2": "",
            "app/3": 12345,
            "app/4": "x".repeat(129),
        });

        expect([...result.keys()]).toEqual(["570"]);
    });

    it.each([
        ["null", null],
        ["an array", []],
        ["a string", "nope"],
    ])("returns an empty map for %s", (_label, payload) => {
        expect(parseBulkLookupMap(payload).size).toBe(0);
    });
});

describe("buildShopsParam", () => {
    it("always includes Steam so the history graph keeps its baseline", () => {
        expect(buildShopsParam([35, 16]).split(",")).toContain(String(STEAM_STORE_ID));
    });

    it("does not duplicate Steam when it is already selected", () => {
        const ids = buildShopsParam([61, 35]).split(",");

        expect(ids.filter(id => id === "61")).toHaveLength(1);
    });

    it("filters out ids that could not be real stores", () => {
        expect(buildShopsParam([35, -1, 1.5, 10000, NaN, "61" as any, null]).split(",").sort())
            .toEqual(["35", "61"]);
    });

    it.each([
        ["an empty selection", []],
        ["a non-array value", "everything"],
        ["null", null],
    ])("falls back sensibly for %s", (_label, stores) => {
        // An empty array still yields Steam; a non-array means "unset", which
        // should behave like the new all-stores default.
        expect(buildShopsParam(stores).length).toBeGreaterThan(0);
    });

    it("uses every store when the setting is unset", () => {
        expect(buildShopsParam(undefined).split(",")).toHaveLength(ALL_STORE_IDS.length);
    });

    it("yields Steam alone when the selection is emptied", () => {
        expect(buildShopsParam([])).toBe(String(STEAM_STORE_ID));
    });
});

describe("isLegacyStoreDefault", () => {
    it("recognises the old Steam-only default", () => {
        expect(isLegacyStoreDefault([61])).toBe(true);
    });

    it.each([
        ["an explicit multi-store selection", [61, 35]],
        ["a single non-Steam store", [35]],
        ["the new all-stores default", ALL_STORE_IDS],
        ["an empty selection", []],
        ["a non-array value", "61"],
        ["null", null],
        ["undefined", undefined],
    ])("leaves %s alone", (_label, stores) => {
        expect(isLegacyStoreDefault(stores)).toBe(false);
    });
});

describe("input validators", () => {
    it.each(["570", "1086940", "1"])("accepts app id %s", (appId) => {
        expect(isValidAppId(appId)).toBe(true);
    });

    it.each(["", "abc", "57 0", "-570", "5.70", "1234567890123"])(
        "rejects app id %j before it reaches a URL",
        (appId) => {
            expect(isValidAppId(appId)).toBe(false);
        }
    );

    it.each(["US", "DE", "GB"])("accepts country %s", (country) => {
        expect(isValidCountry(country)).toBe(true);
    });

    it.each(["us", "USA", "U", "", "U1"])("rejects country %j", (country) => {
        expect(isValidCountry(country)).toBe(false);
    });
});
