/**
 * Google AdSense — 스크립트는 최초 showAdSense() 호출 시 1회만 로드합니다.
 *
 * 사용 예:
 *   import { showAdSense } from "../common/adsense.js";
 *   await showAdSense("downloadTop", "#dl-ad-top");
 */

/** @type {string} */
let _client = "ca-pub-2088466558007407";

/** @type {Promise<void> | null} */
let _scriptLoadPromise = null;

/** 광고 차단·네트워크 실패 등으로 스크립트를 더 이상 시도하지 않음 */
let _scriptUnavailable = false;

/** @type {boolean} */
let _blockedLogged = false;

/**
 * @typedef {Object} AdSenseUnit
 * @property {string} slot
 * @property {string} [adFormat] `data-ad-format` (예: "horizontal", "auto")
 * @property {boolean} [fullWidthResponsive]
 * @property {string} [style]
 */

/**
 * 광고 단위 정의 (슬롯 추가 시 여기만 수정)
 * @type {Record<string, AdSenseUnit>}
 */
export const AD_UNITS = {
  /** EDL 다운로드 페이지 상단 */
  downloadTop: {
    slot: "5724069500",
    adFormat: "horizontal",
    fullWidthResponsive: true,
    style: "display:block",
  },
  /** EDL 다운로드 페이지 하단 */
  downloadBottom: {
    slot: "5724069500",
    adFormat: "horizontal",
    fullWidthResponsive: true,
    style: "display:block",
  },
  /** 편집 화면 — 옵션·미디어 요약 위 */
  editorAboveWorkspace: {
    slot: "5724069500",
    adFormat: "horizontal",
    fullWidthResponsive: true,
    style: "display:block",
  },
  /** 편집 화면 — 좌측 사이드바 */
  editorSidebar: {
    slot: "5724069500",
    adFormat: "horizontal",
    fullWidthResponsive: true,
    style: "display:block",
  },
  /** 편집 화면 — EDL 다운로드 버튼 아래 */
  editorBelowExport: {
    slot: "5724069500",
    adFormat: "horizontal",
    fullWidthResponsive: true,
    style: "display:block",
  },
  /** 메인 대시보드 — 상단 배너 */
  dashboardBanner: {
    slot: "5724069500",
    adFormat: "horizontal",
    fullWidthResponsive: true,
    style: "display:block",
  },
  /** 메인 대시보드 — 좌측 사이드바 */
  dashboardSidebar: {
    slot: "5724069500",
    adFormat: "horizontal",
    fullWidthResponsive: true,
    style: "display:block",
  },
};

/**
 * @param {{ client?: string }} [cfg]
 */
export function configureAdSense(cfg = {}) {
  if (cfg.client?.trim()) _client = cfg.client.trim();
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
    if (document.querySelector('script[data-itmatzip-adsense="1"]')) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(_client)}`;
    s.crossOrigin = "anonymous";
    s.dataset.itmatzipAdsense = "1";
    s.onload = () => resolve();
    s.onerror = () => {
      _scriptUnavailable = true;
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
 * 지정한 광고 단위를 컨테이너에 렌더합니다. (호출한 곳에서만 로드·표시)
 *
 * @param {keyof typeof AD_UNITS | string} unitKey AD_UNITS 키
 * @param {string | HTMLElement} container 요소 또는 CSS 선택자
 * @returns {Promise<boolean>} 성공 여부
 */
export async function showAdSense(unitKey, container) {
  const unit = AD_UNITS[unitKey];
  if (!unit) {
    console.warn(`[adsense] unknown unit: ${unitKey}`);
    return false;
  }

  const el = resolveContainer(container);
  if (!el) {
    console.warn(`[adsense] container not found: ${container}`);
    return false;
  }

  try {
    await ensureAdSenseScript();
  } catch (e) {
    _scriptUnavailable = true;
    markAdSlotEmpty(el);
    logScriptUnavailableOnce(e);
    return false;
  }

  el.innerHTML = "";
  el.removeAttribute("data-adsense-empty");

  const ins = document.createElement("ins");
  ins.className = "adsbygoogle";
  ins.style.cssText = unit.style ?? "display:block";
  ins.setAttribute("data-ad-client", _client);
  ins.setAttribute("data-ad-slot", unit.slot);
  if (unit.adFormat) ins.setAttribute("data-ad-format", unit.adFormat);
  if (unit.fullWidthResponsive) {
    ins.setAttribute("data-full-width-responsive", "true");
  }

  el.appendChild(ins);

  try {
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  } catch (e) {
    console.warn("[adsense] push failed", e);
    return false;
  }

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
