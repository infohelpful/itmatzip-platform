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
 * 테스트 중: 구글 공식 보상형 테스트 유닛 (계정 정지 방지)
 * 실전 전환 시 아래 PRODUCTION 값으로 교체하거나 configureGptRewardedAds({ adUnitPath }) 사용
 */
const DEFAULT_REWARDED_AD_UNIT = "/21775744923/example/rewarded";
/** @type {string} 실전: Ad Manager 보상형 슬롯 — 테스트 완료 후 DEFAULT_REWARDED_AD_UNIT 대신 사용 */
// const PRODUCTION_REWARDED_AD_UNIT = "/23358308038/rewarded_ai_tools";

/** @type {string} */
let adUnitPath = DEFAULT_REWARDED_AD_UNIT;

/** @type {import("googletag").Slot | null} */
let rewardedSlot = null;

/** @type {((evt?: unknown) => void) | null} */
let onRewardGranted = null;

/** @type {Promise<void> | null} */
let initPromise = null;

/** @type {Promise<void> | null} */
let gptScriptPromise = null;

/** GPT 스크립트 영구 로드 실패(차단 등) — 재시도마다 팝업만 반복하지 않도록 안내 다이얼로그로 고정 */
let gptScriptUnavailable = false;

let pubadsListenersAttached = false;
let servicesEnabled = false;
let slotSetupGeneration = 0;

/** @type {ReturnType<typeof setTimeout> | null} */
let displayFailureTimer = null;

/** 진행 중인 광고 요청 시퀀스 — 타임아웃·취소 후 늦게 도착한 이벤트 무시 */
let requestSeq = 0;
/** @type {number} */
let activeRequestSeq = 0;
let activeRequestAborted = false;

/** 광고 로드 대기 (ready 미수신 시 타임아웃) */
const REWARDED_LOAD_TIMEOUT_MS = 12_000;

/**
 * @typedef {"blocked" | "no-fill" | "timeout" | "slot-missing"} RewardedFailureKind
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
  "no-fill": {
    title: "안내",
    message: "현재 준비된 광고가 없습니다.\n잠시 후 다시 시도해 주세요.",
  },
  timeout: {
    title: "안내",
    message: "광고 로드 시간이 초과되었습니다.\n잠시 후 다시 시도해 주세요.",
  },
};

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

function abortActiveRewardedRequest() {
  activeRequestAborted = true;
  clearDisplayFailureTimer();

  const googletag = ensureGoogletag();
  googletag.cmd.push(() => {
    if (rewardedSlot) {
      googletag.destroySlots([rewardedSlot]);
      rewardedSlot = null;
    }
    void setupRewardedSlot();
  });
}

/** @param {number} seq */
function scheduleDisplayFailureCheck(seq) {
  clearDisplayFailureTimer();
  displayFailureTimer = setTimeout(() => {
    displayFailureTimer = null;
    if (!isActiveRewardedRequest(seq)) return;
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
      existing.addEventListener("load", () => resolve(), { once: true });
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
    clearDisplayFailureTimer();
    evt.makeRewardedVisible();
  });

  googletag.pubads().addEventListener("rewardedSlotGranted", (evt) => {
    if (shouldIgnoreRewardedEvent()) return;
    clearDisplayFailureTimer();
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
    if (rewardedSlot) {
      googletag.destroySlots([rewardedSlot]);
      rewardedSlot = null;
    }
    void setupRewardedSlot();
  });

  googletag.pubads().addEventListener("slotRenderEnded", (evt) => {
    if (shouldIgnoreRewardedEvent()) return;
    if (evt.slot !== rewardedSlot) return;

    clearDisplayFailureTimer();

    if (!evt.isEmpty) return;

    abortActiveRewardedRequest();
    void showRewardedFailureAlert("no-fill");
  });
}

/**
 * defineOutOfPageSlot + REWARDED 포맷으로 슬롯 정의
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

      rewardedSlot = googletag.defineOutOfPageSlot(
        adUnitPath,
        googletag.enums.OutOfPageFormat.REWARDED,
      );

      if (rewardedSlot) {
        rewardedSlot.addService(googletag.pubads());
        attachPubadsListeners(googletag);
      }

      if (!servicesEnabled) {
        googletag.pubads().enableSingleRequest();
        googletag.enableServices();
        servicesEnabled = true;
      }

      resolve(!!rewardedSlot);
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

  if (gptScriptUnavailable) {
    throw new Error("GPT script unavailable");
  }

  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      await ensureGptScript();
      await setupRewardedSlot();
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
  return !!rewardedSlot;
}

/**
 * 분석/처리 버튼 클릭 시 호출 — 보상형 광고 표시 후 시청 완료 시 onRewardGranted 실행
 * 차단·로드 실패 시 안내 팝업만 표시 (AI 미실행)
 *
 * @returns {Promise<void>}
 */
export async function requestRewardedAd() {
  if (!onRewardGranted) {
    console.warn("[gpt-rewarded] onRewardGranted 미설정 — initGptRewardedAds()를 먼저 호출하세요.");
    return;
  }

  if (gptScriptUnavailable) {
    await showRewardedFailureAlert("blocked");
    return;
  }

  try {
    await initGptRewardedAds();
  } catch {
    await showRewardedFailureAlert("blocked");
    return;
  }

  if (!rewardedSlot) {
    await showRewardedFailureAlert("slot-missing");
    return;
  }

  const requestId = startRewardedRequest();
  const googletag = ensureGoogletag();

  googletag.cmd.push(() => {
    if (!isActiveRewardedRequest(requestId)) return;

    if (!rewardedSlot) {
      abortActiveRewardedRequest();
      void showRewardedFailureAlert("slot-missing");
      return;
    }

    scheduleDisplayFailureCheck(requestId);
    googletag.display(rewardedSlot);
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
