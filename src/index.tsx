import {
  definePlugin,
  ServerAPI,
  staticClasses,
} from "decky-frontend-lib";
import { FaChartLine } from "react-icons/fa";

import DeckyMenuOption from "./components/DeckyMenuOption";
import DealsPage from "./components/DealsPage";
import { injectStore } from "./patches/StoreInjector";
import { Cache } from "./utils/Cache";
import { SETTINGS, Settings } from "./utils/Settings";
import { DEALS_ROUTE } from "./utils/Deals";
import { priceService } from "./service/PriceService";
import { exchangeRateService } from "./service/ExchangeRateService";
import { providerAuthService } from "./service/ProviderAuthService";
import { wishlistService } from "./service/WishlistService";
import { t } from "./l10n";


export default definePlugin((serverApi: ServerAPI) => {


  Cache.init()
  Settings.init(serverApi)
  providerAuthService.init(serverApi)
  priceService.init(serverApi)
  exchangeRateService.init(serverApi)
  wishlistService.init(serverApi)

  // Apply one-time settings upgrades, then arm the wishlist watcher.
  void SETTINGS.migrate().then(() => wishlistService.start())

  // Full-page deals list, opened directly by wishlist notifications.
  serverApi.routerHook.addRoute(DEALS_ROUTE, DealsPage)

  // injectStore returns a teardown function
  const stopStoreInjector = injectStore(serverApi)


  return {
    title: <div className={staticClasses.Title}>{t("plugin.title")}</div>,
    content: <DeckyMenuOption />,
    icon: <FaChartLine />,
    onDismount() {
      stopStoreInjector()
      serverApi.routerHook.removeRoute(DEALS_ROUTE)
      void wishlistService.stop()
    },
  };
});
