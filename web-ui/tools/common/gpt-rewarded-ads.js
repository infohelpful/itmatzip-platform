/**
 * Google Ad Manager — Rewarded Ads for Web (GPT)
 *
 * 다른 툴/페이지에서 재사용:
 *
 *   <!-- <head> 에 GPT 라이브러리 선로드 (선택, 없으면 모듈이 자동 주입) -->
 *   <script async src="https://securepubads.g.doubleclick.net/tag/js/gpt.js" crossorigin="anonymous"></script>
 *
 *   import { initGptRewardedAds, requestRewardedAd } from "../common/gpt-rewarded-ads.js";
 *
 *   await initGptRewardedAds({
 *     onRewardGranted: () => { void runYourAiJob(); },
 *   });
 *
 *   analyzeBtn.addEventListener("click", () => { void requestRewardedAd(); });
 */

import { showSiteAlert, showSiteDialog } from "./site-modal.js";

const GPT_SCRIPT_SRC =
  "https://securepubads.g.doubleclick.net/tag/js/gpt.js";

/**
 * 웹 보상형 GPT 공식 데모 유닛 (로컬·개발 테스트 권장)
 * 실전 전환: configureGptRewardedAds({ adUnitPath: "/23358308038/rewarded_ai_tools" })
 */
const DEFAULT_REWARDED_AD_UNIT = "/22639388115/rewarded_web_example";
/** 모바일 SDK용 테스트 유닛 — 웹 GPT에서는 fill 안 될 수 있음 */
// const MOBILE_SDK_TEST_UNIT = "/21775744923/example/rewarded";
/** @type {string} 실전: Ad Manager 보상형 슬롯 */
// const PRODUCTION_REWARDED_AD_UNIT = "/23358308038/rewarded_ai_tools";

/** @type {string} */
let adUnitPath = DEFAULT_REWARDED_AD_UNIT;

/**
 * localhost / ?skip_rewarded=1 — 보상형 광고 없이 onRewardGranted 바로 호출
 * (데스크톱·로컬에서 GPT rewarded canRun이 false로 자주 막힘)
 */
function shouldBypassRewardedAd() {
  try {
    const h = window.location.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost")) {
      return true;
    }
    return new URLSearchParams(window.location.search).has("skip_rewarded");
  } catch {
    return false;
  }
}

/** @type {import("googletag").Slot | null} */
let rewardedSlot = null;

/** @type {import("googletag").RewardedSlotReadyEvent | null} */
let pendingReadyEvent = null;

/** @type {((evt?: unknown) => void) | null} */
let onRewardGranted = null;

/** @type {Promise<void> | null} */
let initPromise = null;

/** @type {Promise<void> | null} */
let gptScriptPromise = null;

/** GPT 스크립트 영구 로드 실패(차단 등) */
let gptScriptUnavailable = false;

let pubadsListenersAttached = false;
let servicesEnabled = false;
let slotSetupGeneration = 0;

/** 현재 슬롯에 display() 호출 완료 여부 (GPT: 슬롯당 1회 display 후 ready 대기) */
let slotDisplayed = false;

/** 분석하기 클릭 후 ready 이벤트 대기 중 */
let userAwaitingShow = false;

/** @type {ReturnType<typeof setTimeout> | null} */
let displayFailureTimer = null;

let requestSeq = 0;
/** @type {number} */
let activeRequestSeq = 0;
let activeRequestAborted = false;

const REWARDED_LOAD_TIMEOUT_MS = 12_000;

/**
 * @typedef {"blocked" | "no-fill" | "timeout" | "slot-missing" | "unsupported"} RewardedFailureKind
 */

/** @type {Record<RewardedFailureKind, { title: string, message: string, offerReload?: boolean }>} */
const FAILURE_COPY = {
  blocked: {
    title: "광고가 차단되었습니다",
    message:
      "광고가 차단되었습니다.\n광고 차단 확장 프로그램을 해제한 뒤 페이지를 새로고침해 주세요.",
    offerReload: true,
  },
  "slot-missing": {
    title: "광고가 차단되었습니다",
    message:
      "광고가 차단되었습니다.\n광고 차단 확장 프로그램을 해제한 뒤 페이지를 새로고침해 주세요.",
    offerReload: true,
  },
  unsupported: {
    title: "보상형 광고 미지원",
    message:
      "이 브라우저·화면 크기에서는 보상형 광고를 표시할 수 없습니다.\n모바일 뷰 또는 다른 브라우저에서 시도해 주세요.",
    offerReload: true,
  },
  "no-fill": {
    title: "안내",
    message: "현재 준비된 광고가 없습니다.\n잠시 후 다시 시도해 주세요.",
  },
  timeout: {
    title: "안내",
    message: "광고 로드 시간이 초과되었습니다.\n잠시 후 다시 시도해 주세요.",
  },
};

function debugLog(...args) {
  try {
    if (
      typeof window !== "undefined" &&
      (window.__ITZ_GPT_REWARDED_DEBUG ||
        new URLSearchParams(window.location.search).has("gpt_debug"))
    ) {
      console.log("[gpt-rewarded]", ...args);
    }
  } catch {
    /* ignore */
  }
}

function clearDisplayFailureTimer() {
  if (displayFailureTimer) {
    clearTimeout(displayFailureTimer);
    displayFailureTimer = null;
  }
}

/** @returns {number} */
function startRewardedRequest() {
  activeRequestSeq = ++requestSeq;
  activeRequestAborted = false;
  clearDisplayFailureTimer();
  return activeRequestSeq;
}

/** @param {number} seq */
function isActiveRewardedRequest(seq) {
  return seq === activeRequestSeq && !activeRequestAborted;
}

function shouldIgnoreRewardedEvent() {
  return activeRequestAborted;
}

function resetReadyState() {
  pendingReadyEvent = null;
  userAwaitingShow = false;
  slotDisplayed = false;
}

function abortActiveRewardedRequest() {
  activeRequestAborted = true;
  userAwaitingShow = false;
  clearDisplayFailureTimer();
  pendingReadyEvent = null;

  const googletag = ensureGoogletag();
  googletag.cmd.push(() => {
    if (rewardedSlot) {
      googletag.destroySlots([rewardedSlot]);
      rewardedSlot = null;
    }
    slotDisplayed = false;
    void setupRewardedSlot().then((ok) => {
      if (ok) void prefetchRewardedAd();
    });
  });
}

/** @param {number} seq */
function scheduleDisplayFailureCheck(seq) {
  clearDisplayFailureTimer();
  displayFailureTimer = setTimeout(() => {
    displayFailureTimer = null;
    if (!isActiveRewardedRequest(seq)) return;
    debugLog("load timeout");
    abortActiveRewardedRequest();
    void showRewardedFailureAlert("timeout");
  }, REWARDED_LOAD_TIMEOUT_MS);
}

/**
 * @param {RewardedFailureKind} kind
 * @returns {Promise<void>}
 */
async function showRewardedFailureAlert(kind) {
  const copy = FAILURE_COPY[kind];
  if (!copy) return;

  if (copy.offerReload) {
    const act = await showSiteDialog({
      title: copy.title,
      message: copy.message,
      dialogKind: "gpt-rewarded-block",
      buttons: [
        { label: "새로고침", primary: true, act: "reload" },
        { label: "닫기", act: "close" },
      ],
    });
    if (act === "reload") location.reload();
    return;
  }

  await showSiteAlert(copy.message, copy.title);
}

/**
 * @param {import("googletag").RewardedSlotReadyEvent} evt
 * @returns {boolean}
 */
function tryShowPendingRewardedAd(evt) {
  if (shouldIgnoreRewardedEvent()) return false;
  if (!userAwaitingShow) return false;
  if (evt.slot !== rewardedSlot) return false;

  userAwaitingShow = false;
  clearDisplayFailureTimer();

  const shown = evt.makeRewardedVisible();
  debugLog("makeRewardedVisible", shown);
  if (!shown) {
    abortActiveRewardedRequest();
    void showRewardedFailureAlert("no-fill");
    return false;
  }
  return true;
}

/**
 * @param {{ adUnitPath?: string }} [cfg]
 */
export function configureGptRewardedAds(cfg = {}) {
  const path = cfg.adUnitPath?.trim();
  if (path) adUnitPath = path;
}

function ensureGoogletag() {
  window.googletag = window.googletag || { cmd: /** @type {Array<() => void>} */ ([]) };
  return window.googletag;
}

/**
 * @returns {Promise<void>}
 */
function ensureGptScript() {
  if (gptScriptUnavailable) {
    return Promise.reject(new Error("GPT script unavailable"));
  }
  if (gptScriptPromise) return gptScriptPromise;

  gptScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GPT_SCRIPT_SRC}"]`);
    if (existing) {
      if (existing.getAttribute("data-gpt-loaded") === "1") {
        resolve();
        return;
      }
      existing.addEventListener(
        "load",
        () => {
          existing.setAttribute("data-gpt-loaded", "1");
          resolve();
        },
        { once: true },
      );
      existing.addEventListener(
        "error",
        () => {
          gptScriptUnavailable = true;
          gptScriptPromise = null;
          reject(new Error("GPT script load failed"));
        },
        { once: true },
      );
      return;
    }

    const script = document.createElement("script");
    script.async = true;
    script.src = GPT_SCRIPT_SRC;
    script.crossOrigin = "anonymous";
    script.onload = () => {
      script.setAttribute("data-gpt-loaded", "1");
      resolve();
    };
    script.onerror = () => {
      gptScriptUnavailable = true;
      gptScriptPromise = null;
      reject(new Error("GPT script load failed"));
    };
    (document.head || document.documentElement).appendChild(script);
  });

  return gptScriptPromise;
}

function attachPubadsListeners(googletag) {
  if (pubadsListenersAttached) return;
  pubadsListenersAttached = true;

  googletag.pubads().addEventListener("rewardedSlotReady", (evt) => {
    if (shouldIgnoreRewardedEvent()) return;
    if (evt.slot !== rewardedSlot) return;

    debugLog("rewardedSlotReady");
    pendingReadyEvent = evt;
    tryShowPendingRewardedAd(evt);
  });

  googletag.pubads().addEventListener("rewardedSlotGranted", (evt) => {
    if (shouldIgnoreRewardedEvent()) return;
    clearDisplayFailureTimer();
    userAwaitingShow = false;
    pendingReadyEvent = null;
    console.log(
      "[gpt-rewarded] 구글 보상 확인 완료! AI 연산 및 다운로드를 시작합니다.",
    );
    try {
      onRewardGranted?.(evt);
    } catch (err) {
      console.error("[gpt-rewarded] onRewardGranted handler failed", err);
    }
  });

  googletag.pubads().addEventListener("rewardedSlotClosed", () => {
    if (shouldIgnoreRewardedEvent()) return;
    clearDisplayFailureTimer();
    userAwaitingShow = false;
    pendingReadyEvent = null;
    slotDisplayed = false;

    if (rewardedSlot) {
      googletag.destroySlots([rewardedSlot]);
      rewardedSlot = null;
    }
    void setupRewardedSlot().then((ok) => {
      if (ok) void prefetchRewardedAd();
    });
  });
}

/**
 * @returns {Promise<boolean>}
 */
function setupRewardedSlot() {
  const generation = ++slotSetupGeneration;
  const googletag = ensureGoogletag();

  return new Promise((resolve) => {
    googletag.cmd.push(() => {
      if (generation !== slotSetupGeneration) {
        resolve(!!rewardedSlot);
        return;
      }

      if (rewardedSlot) {
        googletag.destroySlots([rewardedSlot]);
        rewardedSlot = null;
      }

      resetReadyState();

      rewardedSlot = googletag.defineOutOfPageSlot(
        adUnitPath,
        googletag.enums.OutOfPageFormat.REWARDED,
      );

      if (rewardedSlot) {
        rewardedSlot.addService(googletag.pubads());
        attachPubadsListeners(googletag);
        debugLog("slot defined", adUnitPath);
      } else {
        debugLog("defineOutOfPageSlot returned null (unsupported environment)");
      }

      if (!servicesEnabled) {
        // Google 보상형 샘플: enableServices()만 사용 (SRA 미사용)
        googletag.enableServices();
        servicesEnabled = true;
      }

      resolve(!!rewardedSlot);
    });
  });
}

/**
 * Google 권장: 슬롯 정의 후 display()로 프리로드 → ready 시 makeRewardedVisible()
 * @returns {Promise<void>}
 */
function prefetchRewardedAd() {
  const googletag = ensureGoogletag();
  return new Promise((resolve) => {
    googletag.cmd.push(() => {
      if (!rewardedSlot || slotDisplayed) {
        resolve();
        return;
      }
      debugLog("prefetch display");
      googletag.display(rewardedSlot);
      slotDisplayed = true;
      resolve();
    });
  });
}

/**
 * GPT 보상형 광고 초기화 (페이지당 1회)
 *
 * @param {{ onRewardGranted?: (evt?: unknown) => void, adUnitPath?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function initGptRewardedAds(opts = {}) {
  if (opts.adUnitPath?.trim()) adUnitPath = opts.adUnitPath.trim();
  if (typeof opts.onRewardGranted === "function") {
    onRewardGranted = opts.onRewardGranted;
  }

  if (shouldBypassRewardedAd()) {
    debugLog("init skipped (localhost/dev bypass)");
    return;
  }

  if (gptScriptUnavailable) {
    throw new Error("GPT script unavailable");
  }

  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      await ensureGptScript();
      const ok = await setupRewardedSlot();
      if (!ok) {
        throw new Error("Rewarded slot unsupported");
      }
      await prefetchRewardedAd();
    } catch (err) {
      initPromise = null;
      console.warn("[gpt-rewarded] 초기화 실패", err);
      throw err;
    }
  })();

  return initPromise;
}

/** @returns {boolean} */
export function isRewardedSlotReady() {
  return !!pendingReadyEvent;
}

/**
 * @returns {Promise<void>}
 */
export async function requestRewardedAd() {
  if (!onRewardGranted) {
    console.warn("[gpt-rewarded] onRewardGranted 미설정 — initGptRewardedAds()를 먼저 호출하세요.");
    return;
  }

  if (shouldBypassRewardedAd()) {
    console.log("[gpt-rewarded] localhost/dev bypass — 광고 없이 AI 시작");
    try {
      onRewardGranted();
    } catch (err) {
      console.error("[gpt-rewarded] onRewardGranted handler failed", err);
    }
    return;
  }

  if (gptScriptUnavailable) {
    await showRewardedFailureAlert("blocked");
    return;
  }

  try {
    await initGptRewardedAds();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unsupported")) {
      await showRewardedFailureAlert("unsupported");
    } else {
      await showRewardedFailureAlert("blocked");
    }
    return;
  }

  if (!rewardedSlot) {
    await showRewardedFailureAlert("unsupported");
    return;
  }

  const requestId = startRewardedRequest();
  userAwaitingShow = true;
  scheduleDisplayFailureCheck(requestId);

  if (pendingReadyEvent && pendingReadyEvent.slot === rewardedSlot) {
    debugLog("ready event already pending — show immediately");
    if (tryShowPendingRewardedAd(pendingReadyEvent)) return;
  }

  const googletag = ensureGoogletag();
  googletag.cmd.push(() => {
    if (!isActiveRewardedRequest(requestId)) return;

    if (!rewardedSlot) {
      abortActiveRewardedRequest();
      void showRewardedFailureAlert("unsupported");
      return;
    }

    if (!slotDisplayed) {
      debugLog("display on click");
      googletag.display(rewardedSlot);
      slotDisplayed = true;
    }
  });
}

if (typeof window !== "undefined") {
  window.ItMatZipGptRewarded = {
    configure: configureGptRewardedAds,
    init: initGptRewardedAds,
    request: requestRewardedAd,
    isReady: isRewardedSlotReady,
  };
}
