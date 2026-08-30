/**
 * 공개 사이트 런타임 설정 (메뉴 숨김 · 모바일 접속 · AdSense).
 * 관리자 저장값은 /admin/api.php?action=public 에서 읽고,
 * PHP가 없는 환경은 /admin/site-config.json 으로 폴백합니다.
 */

/** @typedef {{ slot?: string, adFormat?: string, fullWidthResponsive?: boolean }} AdUnitConfig */

/**
 * @typedef {Object} SiteConfig
 * @property {string[]} hiddenToolIds
 * @property {string[]} mobileEnabledToolIds
 * @property {{
 *   enabled: boolean,
 *   client: string,
 *   units: Record<string, AdUnitConfig>,
 * }} adsense
 */

/** @type {SiteConfig} */
export const DEFAULT_SITE_CONFIG = {
  hiddenToolIds: [],
  mobileEnabledToolIds: ["thumbnail-grabber", "ico-maker", "online-clock", "unattend-maker", "json-formatter", "currency-calculator"],
  adsense: {
    enabled: true,
    client: "ca-pub-2088466558007407",
    units: {
      dashboardBanner: {
        slot: "5724069500",
        adFormat: "horizontal",
        fullWidthResponsive: true,
      },
      editorAboveWorkspace: {
        slot: "5724069500",
        adFormat: "horizontal",
        fullWidthResponsive: true,
      },
      editorBelowExport: {
        slot: "5724069500",
        adFormat: "horizontal",
        fullWidthResponsive: true,
      },
      downloadTop: {
        slot: "5724069500",
        adFormat: "horizontal",
        fullWidthResponsive: true,
      },
      downloadBottom: {
        slot: "5724069500",
        adFormat: "horizontal",
        fullWidthResponsive: true,
      },
    },
  },
};

/** @type {Promise<SiteConfig> | null} */
let _loadPromise = null;

function originRootConfigUrl(fileName) {
  try {
    return new URL(`/admin/${fileName}`, window.location.origin).href;
  } catch {
    return `/admin/${fileName}`;
  }
}

/**
 * @param {unknown} raw
 * @returns {SiteConfig}
 */
export function mergeSiteConfig(raw) {
  /** @type {SiteConfig} */
  const out = {
    hiddenToolIds: [],
    mobileEnabledToolIds: [...DEFAULT_SITE_CONFIG.mobileEnabledToolIds],
    adsense: {
      enabled: DEFAULT_SITE_CONFIG.adsense.enabled,
      client: DEFAULT_SITE_CONFIG.adsense.client,
      units: { ...DEFAULT_SITE_CONFIG.adsense.units },
    },
  };

  if (!raw || typeof raw !== "object") return out;
  const src = /** @type {Record<string, unknown>} */ (raw);

  if (Array.isArray(src.hiddenToolIds)) {
    out.hiddenToolIds = src.hiddenToolIds.filter((id) => typeof id === "string" && id.trim());
  }

  if (Object.prototype.hasOwnProperty.call(src, "mobileEnabledToolIds")) {
    out.mobileEnabledToolIds = Array.isArray(src.mobileEnabledToolIds)
      ? src.mobileEnabledToolIds.filter((id) => typeof id === "string" && id.trim())
      : [];
  }

  const ads = src.adsense && typeof src.adsense === "object"
    ? /** @type {Record<string, unknown>} */ (src.adsense)
    : null;
  if (!ads) return out;

  if (typeof ads.enabled === "boolean") out.adsense.enabled = ads.enabled;
  if (typeof ads.client === "string" && ads.client.trim()) {
    out.adsense.client = ads.client.trim();
  }
  if (ads.units && typeof ads.units === "object") {
    const units = /** @type {Record<string, unknown>} */ (ads.units);
    for (const [key, val] of Object.entries(units)) {
      if (!val || typeof val !== "object") continue;
      const unit = /** @type {Record<string, unknown>} */ (val);
      const prev = out.adsense.units[key] || {};
      out.adsense.units[key] = {
        ...prev,
        slot: typeof unit.slot === "string" ? unit.slot.trim() : prev.slot,
        adFormat: typeof unit.adFormat === "string" ? unit.adFormat : prev.adFormat,
        fullWidthResponsive:
          typeof unit.fullWidthResponsive === "boolean"
            ? unit.fullWidthResponsive
            : prev.fullWidthResponsive,
      };
    }
  }
  return out;
}

/**
 * @returns {Promise<SiteConfig>}
 */
export function loadSiteConfig() {
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    try {
      const apiRes = await fetch(originRootConfigUrl("api.php") + "?action=public", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (apiRes.ok) {
        const data = await apiRes.json();
        if (data && data.ok && data.config) return mergeSiteConfig(data.config);
      }
    } catch {
      /* PHP/API 없는 환경 */
    }

    try {
      const fileRes = await fetch(originRootConfigUrl("site-config.json"), { cache: "no-store" });
      if (fileRes.ok) return mergeSiteConfig(await fileRes.json());
    } catch {
      /* ignore */
    }

    return mergeSiteConfig(DEFAULT_SITE_CONFIG);
  })();

  return _loadPromise;
}

/** @param {string} toolId */
export async function isToolHidden(toolId) {
  const cfg = await loadSiteConfig();
  return cfg.hiddenToolIds.includes(toolId);
}

/** @param {string} toolId */
export async function isToolMobileEnabled(toolId) {
  const cfg = await loadSiteConfig();
  return cfg.mobileEnabledToolIds.includes(toolId);
}
