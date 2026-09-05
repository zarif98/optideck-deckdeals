import { STORES } from "./Stores";

/*
 * Pure deal logic, deliberately free of network and Decky dependencies so it
 * can be unit tested. Everything here is a decision the plugin makes about
 * price data, which is exactly the part that fails silently on a real device:
 * a broken dedupe rule only shows up as "why am I being notified again?"
 * hours later.
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

/**
 * Convert one raw ITAD deal entry into our normalized shape.
 * Returns null for anything we cannot trust: a non-finite or negative amount
 * means the whole entry is suspect, so it is dropped rather than displayed.
 * A non-HTTPS URL is discarded but does not invalidate the price itself.
 */
export function normalizeDeal(raw: unknown): Deal | null {
    const entry = raw as any;
    const amount = entry?.price?.amount;
    if (typeof amount !== "number" || !isFinite(amount) || amount < 0) return null;

    const storeId = typeof entry?.shop?.id === "number" ? entry.shop.id : 0;
    const url = typeof entry?.url === "string" && entry.url.startsWith("https://") ? entry.url : "";
    const regular = typeof entry?.regular?.amount === "number" ? entry.regular.amount : amount;
    const cut = typeof entry?.cut === "number" ? entry.cut : 0;

    return {
        amount,
        currency: typeof entry?.price?.currency === "string" ? entry.price.currency : "USD",
        regular,
        cut,
        store: STORES.find(s => s.id === storeId)?.title || entry?.shop?.name || "Unknown",
        storeId,
        url
    };
}

/** Normalize a raw deals array and order it cheapest first. */
export function normalizeDeals(rawDeals: unknown): Deal[] {
    if (!Array.isArray(rawDeals)) return [];
    return rawDeals
        .map(normalizeDeal)
        .filter((d): d is Deal => d !== null)
        .sort((a, b) => a.amount - b.amount);
}

/**
 * Choose the deal that should trigger a wishlist alert: the cheapest offer that
 * actually clears the discount threshold.
 *
 * Taking the cheapest offer overall would be wrong - a permanently cheap
 * reseller listing (cut = 0) would mask a genuine sale at another store, and
 * the user would never hear about the sale they were waiting for.
 *
 * `deals` is expected cheapest-first (as produced by normalizeDeals).
 */
export function pickWishlistDeal(deals: Deal[], minDiscount: number): Deal | null {
    return deals.find(d => d.cut >= minDiscount) ?? null;
}

/**
 * Stable identity for a deal. Announcements are keyed on this, so the same
 * offer at the same price stays quiet across checks, while any change to the
 * store, the discount, or the price counts as something new worth saying.
 */
export function dealKey(deal: Deal): string {
    return `${deal.storeId}:${deal.cut}:${deal.amount.toFixed(2)}`;
}

export interface AnnounceCandidate {
    appId: string;
    deal: Deal;
}

/**
 * Work out what to announce and what to remember.
 *
 * `fresh` is everything not already announced at this exact price.
 * `nextSeen` contains only games that are on sale right now - a game whose sale
 * ends drops out entirely, so when it goes on sale again it alerts again
 * instead of being suppressed forever by a stale entry.
 */
export function diffAnnouncements<T extends AnnounceCandidate>(
    candidates: T[],
    seen: Record<string, string>
): { fresh: T[]; nextSeen: Record<string, string> } {
    const fresh = candidates.filter(c => seen[c.appId] !== dealKey(c.deal));

    const nextSeen: Record<string, string> = {};
    for (const candidate of candidates) {
        nextSeen[candidate.appId] = dealKey(candidate.deal);
    }

    return { fresh, nextSeen };
}

/**
 * Decide what to announce on a given pass, accounting for first run.
 *
 * On the very first check there is no baseline, so every wishlisted game that
 * happens to be discounted right now would look "new" - and across ~30 stores
 * something is always on sale. Announcing that backlog would present weeks-old
 * deals as fresh news. Instead the first pass records the baseline silently and
 * says nothing; from then on a notification genuinely means something changed.
 *
 * This suppresses only the initial backlog. A game added to the wishlist later
 * while already on sale is absent from `seen`, so it still alerts, and a
 * discount that deepens still alerts because the price is part of its key.
 */
export function planAnnouncements<T extends AnnounceCandidate>(
    candidates: T[],
    seen: Record<string, string>,
    isFirstRun: boolean
): { announce: T[]; nextSeen: Record<string, string> } {
    const { fresh, nextSeen } = diffAnnouncements(candidates, seen);
    return { announce: isFirstRun ? [] : fresh, nextSeen };
}
