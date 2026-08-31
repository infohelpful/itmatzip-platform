/**
 * 공개 사이트 런타임 설정 (메뉴 숨김 · 모바일 접속 · AdSense · SEO).
 * 관리자 저장값은 /admin/api.php?action=public 에서 읽고,
 * PHP가 없는 환경은 /admin/site-config.json 으로 폴백합니다.
 */

/** @typedef {{ enabled?: boolean, slot?: string, adFormat?: string, fullWidthResponsive?: boolean }} AdUnitConfig */

/** @typedef {{ ko?: string, en?: string, ja?: string, zh?: string }} LangMap */

/** @typedef {{ title?: string, description?: string, keywords?: string }} MetaFields */

/**
 * @typedef {Object} SiteConfig
 * @property {string[]} hiddenToolIds
 * @property {string[]} mobileEnabledToolIds
 * @property {{
 *   enabled: boolean,
 *   client: string,
 *   units: Record<string, AdUnitConfig>,
 * }} adsense
 * @property {{ meta: Record<string, MetaFields>, ogImage: string }} [hub]
 * @property {Record<string, { meta: Record<string, MetaFields> }>} [legal]
 * @property {Record<string, {
 *   title: LangMap,
 *   subtitle: LangMap,
 *   description: LangMap,
 *   badge: LangMap,
 *   meta: Record<string, MetaFields>,
 *   ogImage: string,
 *   adsense: { client: string, units: Record<string, AdUnitConfig> },
 * }>} [tools]
 * @property {number} [updatedAt]
 */

export const SITE_LANGS = ["ko", "en", "ja", "zh"];

/** @type {SiteConfig} */
export const DEFAULT_SITE_CONFIG = {
  hiddenToolIds: [],
  mobileEnabledToolIds: [
    "thumbnail-grabber",
    "ico-maker",
    "image-combiner",
    "online-clock",
    "unattend-maker",
    "json-formatter",
    "currency-calculator",
  ],
  adsense: {
    enabled: true,
    client: "ca-pub-2088466558007407",
    units: {
      dashboardBanner: {
        enabled: true,
        slot: "5724069500",
        adFormat: "horizontal",
        fullWidthResponsive: true,
      },
      editorAboveWorkspace: {
        enabled: true,
        slot: "5724069500",
        adFormat: "horizontal",
        fullWidthResponsive: true,
      },
      editorBelowExport: {
        enabled: true,
        slot: "5724069500",
        adFormat: "horizontal",
        fullWidthResponsive: true,
      },
      downloadTop: {
        enabled: true,
        slot: "5724069500",
        adFormat: "horizontal",
        fullWidthResponsive: true,
      },
      downloadBottom: {
        enabled: true,
        slot: "5724069500",
        adFormat: "horizontal",
        fullWidthResponsive: true,
      },
    },
  },
  hub: {
    ogImage: "",
    meta: {
      ko: {
        title: "무음제거·누끼·보컬제거 로컬툴 | ItMatZip",
        description:
          "브라우저에서 바로 쓰는 무료 웹 도구. 무음 제거, 이미지 작업까지 IT맛집 툴즈.",
        keywords:
          "무음 제거, 보컬 제거, 누끼, 배경제거, 고정 영역 제거, 유튜브 썸네일",
      },
      en: {
        title: "Silence Remover & Background Remover | ItMatZip",
        description:
          "Remove silence from video, isolate vocals, and cut backgrounds on your PC. Files never leave your computer. Free local web tools.",
        keywords:
          "silence remover, remove silence from video, vocal remover, background remover, fixed area remover, youtube thumbnail downloader",
      },
      ja: {
        title: "無音カット・背景削除・ボーカル除去 | ItMatZip",
        description:
          "動画の無音カット、ボーカル除去、背景削除をPC内で処理します。アップロード不要。YouTubeサムネ保存まで揃えた無料ローカルツールです。",
        keywords:
          "無音カット, ボーカル除去, 背景削除, 切り抜き, 固定領域除去, YouTubeサムネイル",
      },
      zh: {
        title: "去静音、抠图、人声分离 | ItMatZip",
        description:
          "视频去静音、人声分离、抠图去背景，文件只在电脑处理、不上传。YouTube封面、固定区域去除也在同一套免费本地工具里。",
        keywords: "去静音, 人声分离, 抠图, 去背景, 固定区域去除, YouTube封面",
      },
    },
  },
  legal: {},
  tools: {},
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

function normalizeLangMap(raw) {
  const out = { ko: "", en: "", ja: "", zh: "" };
  if (!raw || typeof raw !== "object") return out;
  for (const lang of SITE_LANGS) {
    const v = /** @type {Record<string, unknown>} */ (raw)[lang];
    out[lang] = typeof v === "string" ? v : "";
  }
  return out;
}

function normalizeMeta(raw) {
  const src = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  return {
    title: typeof src.title === "string" ? src.title : "",
    description: typeof src.description === "string" ? src.description : "",
    keywords: typeof src.keywords === "string" ? src.keywords : "",
  };
}

function normalizeMetaLangs(raw) {
  const src = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  /** @type {Record<string, MetaFields>} */
  const out = {};
  for (const lang of SITE_LANGS) {
    out[lang] = normalizeMeta(src[lang]);
  }
  return out;
}

function fillEmptyMetaLangs(meta, fallback) {
  const out = normalizeMetaLangs(meta);
  const fb = fallback && typeof fallback === "object" ? fallback : {};
  for (const lang of SITE_LANGS) {
    const f = normalizeMeta(fb[lang]);
    out[lang] = {
      title: out[lang].title || f.title,
      description: out[lang].description || f.description,
      keywords: out[lang].keywords || f.keywords,
    };
  }
  return out;
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
    hub: { meta: normalizeMetaLangs(null), ogImage: "" },
    legal: {},
    tools: {},
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

  if (typeof src.updatedAt === "number") out.updatedAt = src.updatedAt;

  const ads = src.adsense && typeof src.adsense === "object"
    ? /** @type {Record<string, unknown>} */ (src.adsense)
    : null;
  if (ads) {
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
          enabled: typeof unit.enabled === "boolean" ? unit.enabled : prev.enabled !== false,
          slot: typeof unit.slot === "string" ? unit.slot.trim() : prev.slot,
          adFormat: typeof unit.adFormat === "string" ? unit.adFormat : prev.adFormat,
          fullWidthResponsive:
            typeof unit.fullWidthResponsive === "boolean"
              ? unit.fullWidthResponsive
              : prev.fullWidthResponsive,
        };
      }
    }
  }

  const hub = src.hub && typeof src.hub === "object" ? /** @type {Record<string, unknown>} */ (src.hub) : {};
  out.hub = {
    meta: normalizeMetaLangs(hub.meta),
    ogImage: typeof hub.ogImage === "string" ? hub.ogImage : "",
  };

  const legal = src.legal && typeof src.legal === "object" ? /** @type {Record<string, unknown>} */ (src.legal) : {};
  out.legal = {};
  for (const [id, val] of Object.entries(legal)) {
    if (!val || typeof val !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (val);
    out.legal[id] = { meta: normalizeMetaLangs(row.meta) };
  }

  const tools = src.tools && typeof src.tools === "object" ? /** @type {Record<string, unknown>} */ (src.tools) : {};
  out.tools = {};
  for (const [id, val] of Object.entries(tools)) {
    if (!val || typeof val !== "object") continue;
    const row = /** @type {Record<string, unknown>} */ (val);
    const tAds = row.adsense && typeof row.adsense === "object"
      ? /** @type {Record<string, unknown>} */ (row.adsense)
      : {};
    /** @type {Record<string, AdUnitConfig>} */
    const tUnits = {};
    if (tAds.units && typeof tAds.units === "object") {
      for (const [key, uval] of Object.entries(/** @type {Record<string, unknown>} */ (tAds.units))) {
        if (!uval || typeof uval !== "object") continue;
        const unit = /** @type {Record<string, unknown>} */ (uval);
        tUnits[key] = {
          enabled: typeof unit.enabled === "boolean" ? unit.enabled : true,
          slot: typeof unit.slot === "string" ? unit.slot.trim() : "",
        };
      }
    }
    out.tools[id] = {
      title: normalizeLangMap(row.title),
      subtitle: normalizeLangMap(row.subtitle),
      description: normalizeLangMap(row.description),
      badge: normalizeLangMap(row.badge),
      meta: normalizeMetaLangs(row.meta),
      ogImage: typeof row.ogImage === "string" ? row.ogImage : "",
      adsense: {
        client: typeof tAds.client === "string" ? tAds.client.trim() : "",
        units: tUnits,
      },
    };
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

/** @param {string} [htmlLang] */
export function uiLang(htmlLang) {
  const n = String(htmlLang || (typeof document !== "undefined" ? document.documentElement.lang : "") || "ko");
  if (n === "zh-CN" || n.startsWith("zh")) return "zh";
  if (n.startsWith("en")) return "en";
  if (n.startsWith("ja")) return "ja";
  return "ko";
}

/** @param {LangMap | undefined} map @param {string} [lang] */
export function pickLang(map, lang) {
  if (!map || typeof map !== "object") return "";
  const key = lang || uiLang();
  const v = map[key];
  return typeof v === "string" ? v.trim() : "";
}

/** @param {LangMap | undefined} map @param {string} [lang] */
export function pickLangFallback(map, lang) {
  const order = [lang || uiLang(), "ko", "en", "ja", "zh"];
  const seen = new Set();
  for (const key of order) {
    if (seen.has(key)) continue;
    seen.add(key);
    const v = pickLang(map, key);
    if (v) return v;
  }
  return "";
}

/** @param {LangMap | undefined} map */
export function langMapHasValue(map) {
  if (!map || typeof map !== "object") return false;
  return SITE_LANGS.some((lang) => typeof map[lang] === "string" && map[lang].trim() !== "");
}
