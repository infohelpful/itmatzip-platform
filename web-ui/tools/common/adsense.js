/**
 * Google AdSense — 스크립트는 최초 showAdSense() 호출 시 1회만 로드합니다.
 *
 * 사용 예:
 *   import { showAdSense } from "../common/adsense.js?v=6";
 *   await showAdSense("downloadTop", "#dl-ad-top");
 */

import { loadSiteConfig } from "./site-config.js?v=7";

/** @type {string} */
let _client = "ca-pub-2088466558007407";

let _runtimePromise = null;
let _adsDisabled = false;

/** @type {Promise<void> | null} */
let _scriptLoadPromise = null;

/** 광고 차단·네트워크 실패 등으로 스크립트를 더 이상 시도하지 않음 */
let _scriptUnavailable = false;

/** adsbygoogle.js 로드 성공 */
let _scriptLoaded = false;

/** @type {boolean} */
let _blockedLogged = false;

const FILL_WATCH_MS = 18_000;

/**
 * data-ad-status 없이도 iframe이 보이면 광고가 뜬 것으로 봄 (Auto ads·느린 filled 대응)
 * @returns {boolean}
 */
export function pageShowsAdCreative() {
  try {
    for (const ins of document.querySelectorAll("ins.adsbygoogle")) {
      if (ins.getAttribute("data-ad-status") === "filled") return true;
      for (const iframe of ins.querySelectorAll("iframe")) {
        const r = iframe.getBoundingClientRect();
        if (r.width >= 20 && r.height >= 20) return true;
      }
    }
    for (const iframe of document.querySelectorAll(
      'iframe[src*="googlesyndication"], iframe[src*="doubleclick.net"], iframe[id*="google_ads"]',
    )) {
      const r = iframe.getBoundingClientRect();
      if (r.width >= 20 && r.height >= 20) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** @param {string} unitKey */
function notifyAdSlotFailed(unitKey) {
  if (pageShowsAdCreative()) return;
  if (typeof window !== "undefined") {
    window.__itmatzipAdSenseBlocked = true;
  }
  document.dispatchEvent(
    new CustomEvent("itz:adsense-slot-failed", { detail: { unitKey } }),
  );
}

/**
 * @param {HTMLElement} ins
 * @param {HTMLElement} container
 * @param {string} unitKey
 */
function scheduleFillWatch(ins, container, unitKey) {
  window.setTimeout(() => {
    if (ins.getAttribute("data-ad-status") === "filled") return;
    if (pageShowsAdCreative()) return;
    if (container.getAttribute("data-adsense-empty") === "1") return;
    markAdSlotEmpty(container);
    notifyAdSlotFailed(unitKey);
  }, FILL_WATCH_MS);
}

/**
 * @typedef {Object} AdSenseUnit
 * @property {string} slot
 * @property {string} [adFormat] `data-ad-format` (예: "horizontal", "auto")
 * @property {boolean} [fullWidthResponsive]
 * @property {string} [style]
 * @property {number} [minWidth] 이 폭 미만이면 push 하지 않음 (TagError 방지)
 */

/**
 * 가로형 배너가 들어갈 수 있는 최소 폭.
 * 이보다 좁은 컨테이너에 push 하면 AdSense 가 맞는 크기를 못 찾아
 * `TagError: No slot size for availableWidth=…` 를 던진다.
 */
const HORIZONTAL_MIN_WIDTH = 250;

/** PC 728×90 / 모바일 320×50 — 구글 예시의 800px 기준과 맞춤 */
const AD_BANNER_MOBILE_MQ = "(max-width: 799px)";
const AD_BANNER_HEIGHT_DESKTOP = 90;
const AD_BANNER_HEIGHT_MOBILE = 50;

function bannerAdHeightPx() {
  try {
    if (window.matchMedia(AD_BANNER_MOBILE_MQ).matches) return AD_BANNER_HEIGHT_MOBILE;
  } catch {
    /* ignore */
  }
  return AD_BANNER_HEIGHT_DESKTOP;
}

/**
 * 광고 단위 정의 (슬롯 추가 시 여기만 수정)
 * @type {Record<string, AdSenseUnit>}
 */
export const AD_UNITS = {
  /** XML 다운로드 페이지 상단 */
  downloadTop: {
    slot: "5724069500",
    minWidth: HORIZONTAL_MIN_WIDTH,
  },
  /** XML 다운로드 페이지 하단 */
  downloadBottom: {
    slot: "5724069500",
    minWidth: HORIZONTAL_MIN_WIDTH,
  },
  /** 편집 화면 — 옵션·미디어 요약 위 */
  editorAboveWorkspace: {
    slot: "5724069500",
    minWidth: HORIZONTAL_MIN_WIDTH,
  },
  /** 편집 화면 — XML 다운로드 버튼 아래 */
  editorBelowExport: {
    slot: "5724069500",
    minWidth: HORIZONTAL_MIN_WIDTH,
  },
  /** 메인 대시보드 — 상단 배너 */
  dashboardBanner: {
    slot: "5724069500",
    minWidth: HORIZONTAL_MIN_WIDTH,
  },
};

/**
 * @param {{ client?: string }} [cfg]
 */
export function configureAdSense(cfg = {}) {
  if (cfg.client?.trim()) _client = cfg.client.trim();
}

/** @type {import("./site-config.js").SiteConfig | null} */
let _siteCfg = null;

function currentToolId() {
  try {
    return (document.documentElement.getAttribute("data-tool-id") || "").trim();
  } catch {
    return "";
  }
}

function pageClient(cfg, toolId) {
  const toolClient = toolId && cfg?.tools?.[toolId]?.adsense?.client;
  if (typeof toolClient === "string" && /^ca-pub-\d{8,22}$/.test(toolClient.trim())) {
    return toolClient.trim();
  }
  const globalClient = cfg?.adsense?.client;
  return typeof globalClient === "string" && globalClient.trim() ? globalClient.trim() : _client;
}

/**
 * @param {import("./site-config.js").SiteConfig} cfg
 * @param {string} unitKey
 * @returns {{ off: boolean, slot: string, client: string }}
 */
export function resolveAdUnit(cfg, unitKey) {
  let key = unitKey === "editorAbovePath" ? "editorAboveWorkspace" : unitKey;
  if (!cfg || cfg.adsense?.enabled === false) {
    return { off: true, slot: "", client: _client };
  }
  const toolId = currentToolId();
  const client = pageClient(cfg, toolId);
  const toolUnit = toolId && cfg.tools?.[toolId]?.adsense?.units?.[key];
  if (toolUnit && typeof toolUnit === "object") {
    if (toolUnit.enabled === false) return { off: true, slot: "", client };
    const slot = String(toolUnit.slot || "").trim();
    if (slot) return { off: false, slot, client };
  }
  const global = cfg.adsense?.units?.[key] || AD_UNITS[key];
  if (global && global.enabled === false) return { off: true, slot: "", client };
  const slot = String(global?.slot || AD_UNITS[key]?.slot || "").trim();
  if (!slot) return { off: true, slot: "", client };
  return { off: false, slot, client };
}

function applyRuntimeAdSense() {
  if (_runtimePromise) return _runtimePromise;
  _runtimePromise = (async () => {
    try {
      const cfg = await loadSiteConfig();
      _siteCfg = cfg;
      _adsDisabled = cfg.adsense?.enabled === false;
      const toolId = currentToolId();
      configureAdSense({ client: pageClient(cfg, toolId) });
    } catch {
      _adsDisabled = false;
    }
  })();
  return _runtimePromise;
}

/**
 * adsbygoogle.js 1회 로드
 * @returns {Promise<void>}
 */
export function ensureAdSenseScript() {
  if (_scriptUnavailable) {
    return Promise.reject(new Error("AdSense script unavailable"));
  }
  if (_scriptLoadPromise) return _scriptLoadPromise;

  _scriptLoadPromise = new Promise((resolve, reject) => {
    const adSrc = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(_client)}`;
    if (document.querySelector(`script[src*="adsbygoogle.js"]`)) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.async = true;
    s.src = adSrc;
    s.crossOrigin = "anonymous";
    s.onload = () => {
      _scriptLoaded = true;
      resolve();
    };
    s.onerror = () => {
      _scriptUnavailable = true;
      if (typeof window !== "undefined") {
        window.__itmatzipAdSenseBlocked = true;
      }
      _scriptLoadPromise = null;
      reject(new Error("AdSense script load failed"));
    };
    (document.head || document.documentElement).appendChild(s);
  });

  return _scriptLoadPromise;
}

/**
 * @param {string | HTMLElement | null | undefined} target
 * @returns {HTMLElement | null}
 */
function resolveContainer(target) {
  if (!target) return null;
  if (typeof target === "string") return document.querySelector(target);
  return target;
}

/**
 * @param {HTMLElement} el
 */
function markAdSlotEmpty(el) {
  el.setAttribute("data-adsense-empty", "1");
}

/** @param {unknown} err */
function logScriptUnavailableOnce(err) {
  if (_blockedLogged) return;
  _blockedLogged = true;
  console.info(
    "[adsense] 광고 스크립트를 불러오지 못했습니다. (광고 차단 확장·localhost·네트워크일 수 있음)",
    err,
  );
}

/**
 * 광고가 실제로 쓸 수 있는 폭 (padding 제외) — AdSense 의 availableWidth 와 같은 기준
 * @param {HTMLElement} el
 * @returns {number}
 */
function availableAdWidth(el) {
  const cs = getComputedStyle(el);
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  return Math.max(0, Math.floor(el.clientWidth - pad));
}

function isLocalDevHost() {
  try {
    const h = window.location.hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

/**
 * 지정한 광고 단위를 컨테이너에 렌더합니다. (호출한 곳에서만 로드·표시)
 *
 * @param {keyof typeof AD_UNITS | string} unitKey AD_UNITS 키
 * @param {string | HTMLElement} container 요소 또는 CSS 선택자
 * @returns {Promise<boolean>} 성공 여부
 */
function markAdSlotOff(el) {
  el.classList.add("is-ad-off");
  el.innerHTML = "";
  el.removeAttribute("data-adsense-empty");
}

export async function showAdSense(unitKey, container) {
  await applyRuntimeAdSense();

  const el = resolveContainer(container);
  if (!el) {
    console.warn(`[adsense] container not found: ${container}`);
    return false;
  }

  const resolved = resolveAdUnit(_siteCfg || { adsense: { enabled: !_adsDisabled, client: _client, units: {} }, tools: {} }, unitKey);
  if (resolved.off) {
    markAdSlotOff(el);
    return false;
  }
  el.classList.remove("is-ad-off");
  configureAdSense({ client: resolved.client });

  const unit = { ...(AD_UNITS[unitKey === "editorAbovePath" ? "editorAboveWorkspace" : unitKey] || {}), slot: resolved.slot };
  if (!unit || !String(unit.slot || "").trim()) {
    console.warn(`[adsense] unknown or empty unit: ${unitKey}`);
    markAdSlotEmpty(el);
    return false;
  }

  // 이미 push 한 슬롯을 다시 넣거나, display:none 인 칸에 요청하면 가이드 위반
  if (el.querySelector("ins.adsbygoogle")) {
    return true;
  }
  try {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") {
      console.info(`[adsense] skip ${unitKey}: container is hidden`);
      return false;
    }
  } catch {
    /* ignore */
  }

  // localhost: Google 광고 스크립트(ss:/ui config 콘솔 스팸) 로드 자체를 생략
  if (isLocalDevHost()) {
    markAdSlotEmpty(el);
    return false;
  }

  // 폭이 부족하면 adsbygoogle.push() 가 TagError("No slot size for availableWidth")를 던지고,
  // 그 실패가 광고 차단으로 오탐돼 안내 팝업까지 뜬다. 아예 요청하지 않는다.
  if (unit.minWidth && availableAdWidth(el) < unit.minWidth) {
    console.info(
      `[adsense] skip ${unitKey}: 컨테이너 폭 ${availableAdWidth(el)}px < 필요 ${unit.minWidth}px`,
    );
    markAdSlotEmpty(el);
    return false;
  }

  try {
    await ensureAdSenseScript();
  } catch (e) {
    _scriptUnavailable = true;
    markAdSlotEmpty(el);
    logScriptUnavailableOnce(e);
    notifyAdSlotFailed(unitKey);
    return false;
  }

  el.innerHTML = "";
  el.removeAttribute("data-adsense-empty");

  const ins = document.createElement("ins");
  const heightPx = bannerAdHeightPx();
  ins.className = "adsbygoogle itz-ad-unit";
  ins.style.cssText = "display:block;width:100%;height:" + heightPx + "px";
  ins.setAttribute("data-ad-client", resolved.client || _client);
  ins.setAttribute("data-ad-slot", unit.slot);

  el.appendChild(ins);

  try {
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  } catch (e) {
    console.warn("[adsense] push failed", e);
    markAdSlotEmpty(el);
    notifyAdSlotFailed(unitKey);
    return false;
  }

  scheduleFillWatch(ins, el, unitKey);
  return true;
}

/**
 * 컨테이너 비우기 (다이얼로그 닫을 때 등)
 * @param {string | HTMLElement} container
 */
export function clearAdSense(container) {
  const el = resolveContainer(container);
  if (el) el.innerHTML = "";
}

/**
 * site-guard 등: 광고 차단 오탐 방지용 스냅샷 (DOM + 내부 플래그)
 * @returns {{
 *   scriptLoaded: boolean,
 *   scriptUnavailable: boolean,
 *   liveInsCount: number,
 *   filledCount: number,
 *   unfilledCount: number,
 *   emptyContainerCount: number,
 *   pendingInsCount: number,
 * }}
 */
export function getAdSenseGuardSnapshot() {
  const slots = document.querySelectorAll("ins.adsbygoogle");
  let filledCount = 0;
  let unfilledCount = 0;
  let pendingInsCount = 0;
  for (const ins of slots) {
    const st = ins.getAttribute("data-ad-status");
    if (st === "filled") filledCount += 1;
    else if (st === "unfilled") unfilledCount += 1;
    else pendingInsCount += 1;
  }
  return {
    scriptLoaded: _scriptLoaded,
    scriptUnavailable: _scriptUnavailable,
    liveInsCount: slots.length,
    filledCount,
    unfilledCount,
    emptyContainerCount: document.querySelectorAll("[data-adsense-empty]").length,
    pendingInsCount,
  };
}

if (typeof window !== "undefined") {
  window.__itmatzipGetAdSenseGuardSnapshot = getAdSenseGuardSnapshot;
  window.__itmatzipPageShowsAdCreative = pageShowsAdCreative;
}
