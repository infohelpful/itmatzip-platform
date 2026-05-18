/**
 * Google AdSense — 스크립트는 최초 showAdSense() 호출 시 1회만 로드합니다.
 *
 * 사용 예:
 *   import { showAdSense } from "../../common/adsense.js";
 *   await showAdSense("installDialog", "#itz-install-ad-slot");
 */

/** @type {string} */
let _client = "ca-pub-2088466558007407";

/** @type {Promise<void> | null} */
let _scriptLoadPromise = null;

/**
 * 광고 단위 정의 (슬롯 추가 시 여기만 수정)
 * @type {Record<string, { slot: string, format?: string, fullWidthResponsive?: boolean, style?: string }>}
 */
export const AD_UNITS = {
  /** IT맛집 중간광고 — 에이전트 설치 안내 팝업 */
  installDialog: {
    slot: "5724069500",
    format: "auto",
    fullWidthResponsive: true,
    style: "display:block",
  },
  /** EDL 다운로드 페이지 상단 */
  downloadTop: {
    slot: "5724069500",
    format: "auto",
    fullWidthResponsive: true,
    style: "display:block",
  },
  /** EDL 다운로드 페이지 하단 */
  downloadBottom: {
    slot: "5724069500",
    format: "auto",
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
    console.warn("[adsense] script load failed", e);
    return false;
  }

  el.innerHTML = "";
  el.removeAttribute("data-adsense-empty");

  const ins = document.createElement("ins");
  ins.className = "adsbygoogle";
  ins.style.cssText = unit.style ?? "display:block";
  ins.setAttribute("data-ad-client", _client);
  ins.setAttribute("data-ad-slot", unit.slot);
  if (unit.format) ins.setAttribute("data-ad-format", unit.format);
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
