import { Focusable, Navigation, PanelSection, PanelSectionRow, staticClasses } from "decky-frontend-lib";
import { useEffect, useState } from "react";
import { SETTINGS, Setting } from "../utils/Settings";
import { RowDeal, formatRowPrice, sortRowDeals, storePageUrlFor } from "../utils/Deals";
import { priceService } from "../service/PriceService";
import { t } from "../l10n";

/*
 * Full-page list of the wishlist deals found by the last check.
 *
 * Registered as a route so a notification can open it directly. Reading from
 * the stored results rather than re-querying keeps opening it instant and
 * offline-safe; the numbers are exactly what the notification was about.
 */

/** Bound the title lookups, which cost one request each. */
const MAX_TITLE_LOOKUPS = 60;

const DealsPage = () => {
    const [deals, setDeals] = useState<Record<string, RowDeal>>({});
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let mounted = true;

        async function load() {
            const stored = await SETTINGS.load(Setting.WISHLIST_DEALS);
            const current: Record<string, RowDeal> =
                stored && typeof stored === "object" && !Array.isArray(stored) ? { ...stored } : {};

            if (!mounted) return;
            setDeals(current);
            setLoading(false);

            // Titles are not known at check time - resolve the missing ones and
            // write them back so a second visit is instant.
            const missing = Object.entries(current)
                .filter(([, deal]) => !deal.title && deal.gameId)
                .slice(0, MAX_TITLE_LOOKUPS);
            if (missing.length === 0) return;

            let changed = false;
            for (const [appId, deal] of missing) {
                const title = await priceService.getGameTitle(deal.gameId);
                if (!mounted) return;
                if (title) {
                    current[appId] = { ...current[appId], title };
                    changed = true;
                    setDeals({ ...current });
                }
            }

            if (changed && mounted) {
                await SETTINGS.save(Setting.WISHLIST_DEALS, current);
            }
        }

        load();
        return () => { mounted = false; };
    }, []);

    const rows = sortRowDeals(deals);

    const openStorePage = (appId: string) => {
        Navigation.CloseSideMenus();
        Navigation.NavigateToSteamWeb(storePageUrlFor(appId));
    };

    return (
        <div style={{ marginTop: "40px", height: "calc(100% - 40px)", overflowY: "auto" }}>
            <PanelSection title={t("deals.title")}>
                {loading && (
                    <PanelSectionRow>
                        <div style={{ color: "#8f98a0", fontSize: "13px" }}>{t("store.loading")}</div>
                    </PanelSectionRow>
                )}

                {!loading && rows.length === 0 && (
                    <PanelSectionRow>
                        <div style={{ color: "#8f98a0", fontSize: "13px", lineHeight: 1.5 }}>
                            {t("deals.empty")}
                        </div>
                    </PanelSectionRow>
                )}

                {rows.map(({ appId, deal }) => (
                    <PanelSectionRow key={appId}>
                        <Focusable
                            onActivate={() => openStorePage(appId)}
                            style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                gap: "12px",
                                padding: "10px 12px",
                                borderRadius: "6px",
                                background: "rgba(255,255,255,0.04)",
                                marginBottom: "6px",
                            }}
                        >
                            <div style={{ minWidth: 0 }}>
                                <div className={staticClasses.Text} style={{ fontSize: "15px", overflowWrap: "anywhere" }}>
                                    {deal.title || appId}
                                </div>
                                <div style={{ fontSize: "12px", color: "#67c1f5", marginTop: "2px" }}>
                                    {formatRowPrice(deal)}
                                </div>
                            </div>
                            <div
                                style={{
                                    flexShrink: 0,
                                    fontSize: "15px",
                                    fontWeight: "bold",
                                    color: "#beee11",
                                }}
                            >
                                -{deal.cut}%
                            </div>
                        </Focusable>
                    </PanelSectionRow>
                ))}

                {!loading && rows.length > 0 && (
                    <PanelSectionRow>
                        <div style={{ fontSize: "11px", color: "#6b7280", marginTop: "6px" }}>
                            {t("deals.footerHint")}
                        </div>
                    </PanelSectionRow>
                )}
            </PanelSection>
        </div>
    );
};

export default DealsPage;
