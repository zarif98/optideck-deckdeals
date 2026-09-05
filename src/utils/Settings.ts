import { ServerAPI } from "decky-frontend-lib";
import { CACHE } from "./Cache";
import { ALL_STORE_IDS } from "./Stores";

export enum Setting {
  FONTSIZE = "fontSize",
  PADDING_BOTTOM = "paddingBottom",
  COUNTRY = "country",
  STORES = "stores",
  ENABLED = "enabled",
  DATE_FORMAT = "dateFormat",
  SHOW_QUICK_LINKS = "showQuickLinks",
  SHOW_PREDICTIONS = "showPredictions",
  PROVIDERS = "providers",
  HISTORY_RANGE = "historyRange",
  LOCALE = "locale",
  WISHLIST_ALERTS = "wishlistAlerts",
  WISHLIST_MIN_DISCOUNT = "wishlistMinDiscount",
  WISHLIST_CHECK_HOURS = "wishlistCheckHours",
  WISHLIST_SEEN = "wishlistSeen",
  WISHLIST_DEALS = "wishlistDeals",
  WISHLIST_SEEDED = "wishlistSeeded",
  WISHLIST_LAST_CHECK = "wishlistLastCheck",
}

export let SETTINGS: Settings

export class Settings {
  private readonly serverAPI: ServerAPI;
  public defaults: Record<Setting, any> = {
    fontSize: 16,
    paddingBottom: 10,
    country: "US",
    stores: ALL_STORE_IDS,
    enabled: true,
    dateFormat: "default",
    showQuickLinks: true,
    showPredictions: true,
    providers: ["itad"],
    historyRange: "1y",
    locale: "en",
    wishlistAlerts: true,
    wishlistMinDiscount: 20,
    wishlistCheckHours: 6,
    wishlistSeen: {},
    wishlistDeals: {},
    wishlistSeeded: false,
    wishlistLastCheck: 0,
  };

  constructor(serverAPI: ServerAPI) {
    this.serverAPI = serverAPI;
  }

  static init(serverAPI: ServerAPI) {
    SETTINGS = new Settings(serverAPI)
  }

  async load(key: Setting) {
    const cacheValue = await CACHE.loadValue(key)
    if (cacheValue) {
      return cacheValue
    }

    return this.serverAPI.callPluginMethod("settings_load", {
      key: key,
      defaults: this.defaults[key]

    }).then(async (response) => {
      if (response.success && response.result != undefined) {
        CACHE.setValue(key, response.result)
        return response.result;
      }
      CACHE.setValue(key, this.defaults[key])
      return this.defaults[key];
    })
  }


  async save(key: Setting, value: any) {
    CACHE.setValue(key, value)

    await this.serverAPI.callPluginMethod("settings_save", {
      key: key,
      value: value,
    });
  }
}
