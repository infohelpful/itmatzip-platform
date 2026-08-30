/**
 * site-guard.js — 사이트 보호 (경량 아키텍처)
 *
 * 이전 버전의 지속 폴링(setInterval), debugger 루프, 동기 XHR, console Proxy는
 * 메인 스레드·DevTools·도구 페이지 디버깅에 부담이 커서 제거했습니다.
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │ 프로필                                                       │
 * │  local  — 127.0.0.1 / localhost: 보호 비활성 (에이전트 UI)    │
 * │  tools  — 공개 도구: 우클릭·단축키만, 감시 루프 없음          │
 * │  full   — 광고 차단 감지(이벤트·idle·최대 1회/탭)             │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Kill switch: ?_sg_off=1 또는 localStorage._sg_off=1
 * 강제 full: ?_sg_full=1
 */

(function () {
  "use strict";

  const KILL_SWITCH_KEY = "_sg_off";
  const FORCE_FULL_KEY = "_sg_full";

  function killSwitchOn() {
    try {
      if (new URLSearchParams(location.search).get(KILL_SWITCH_KEY) === "1") return true;
      return localStorage.getItem(KILL_SWITCH_KEY) === "1";
    } catch {
      return false;
    }
  }

  function forceFullOn() {
    try {
      if (new URLSearchParams(location.search).get(FORCE_FULL_KEY) === "1") return true;
      return localStorage.getItem(FORCE_FULL_KEY) === "1";
    } catch {
      return false;
    }
  }

  if (killSwitchOn()) {
    console.info(
      "[site-guard] 보호가 꺼져 있습니다(?_sg_off=1). 광고 차단 안내·일부 보호가 동작하지 않습니다. URL에서 _sg_off=1 을 제거하세요.",
    );
    return;
  }

  /** @param {() => void} fn @param {number} [timeoutMs] */
  function runWhenIdle(fn, timeoutMs = 4000) {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => fn(), { timeout: timeoutMs });
      return;
    }
    setTimeout(fn, 1);
  }

  function isLocalAgentHost() {
    const h = location.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  }

  /** @returns {"off" | "tools" | "full"} */
  function resolveProfile() {
    if (forceFullOn()) return "full";
    if (isLocalAgentHost()) return "off";
    return "full";
  }

  const profile = resolveProfile();
  if (profile === "off") return;

  // ─── 스케줄러: 탭 비활성 시 작업 중단, 중복 실행 방지 ─────────────────

  const scheduler = {
    _paused: false,
    _timers: new Set(),

    pause() {
      this._paused = true;
    },
    resume() {
      this._paused = false;
    },

    /** @param {() => void} fn @param {number} delayMs */
    setTimeout(fn, delayMs) {
      const id = window.setTimeout(() => {
        this._timers.delete(id);
        if (!this._paused) fn();
      }, delayMs);
      this._timers.add(id);
      return id;
    },

    /** @param {() => void} fn @param {number} ms */
    debounce(fn, ms) {
      let t = 0;
      return () => {
        window.clearTimeout(t);
        t = window.setTimeout(() => {
          if (!this._paused) fn();
        }, ms);
      };
    },

    dispose() {
      for (const id of this._timers) window.clearTimeout(id);
      this._timers.clear();
    },
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") scheduler.pause();
    else scheduler.resume();
  });
  if (document.visibilityState === "hidden") scheduler.pause();

  // ─── 1. 콘텐츠 보호 (이벤트만 — 백그라운드 비용 0) ─────────────────────

  function installContentProtection() {
    const block = (e) => {
      e.preventDefault();
    };
    document.addEventListener("contextmenu", block, true);
    document.addEventListener("selectstart", block, true);
    document.addEventListener("dragstart", block, true);
    document.addEventListener("copy", block, true);
    document.addEventListener("cut", block, true);
  }

  // ─── 2. DevTools 단축키 (선택적, 폴링 없음) ───────────────────────────

  const BLOCKED_DEV_KEYS = new Set(["KeyI", "KeyJ", "KeyU", "KeyC"]);

  function installDevToolsKeyBlock() {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "F12") {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.ctrlKey && e.shiftKey && BLOCKED_DEV_KEYS.has(e.code)) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.ctrlKey && !e.shiftKey && e.code === "KeyU") {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );
  }

  /** resize 1회성 경고 — setInterval / debugger 없음 */
  function installDevToolsResizeHint() {
    if (profile !== "full") return;

    let warned = false;
    const THRESHOLD = 160;

    const maybeWarn = scheduler.debounce(() => {
      if (warned || document.hidden) return;
      const w = window.outerWidth - window.innerWidth > THRESHOLD;
      const h = window.outerHeight - window.innerHeight > THRESHOLD;
      if (!w && !h) return;
      warned = true;
      window.removeEventListener("resize", onResize);
      console.info(
        "%c⚠️ 개발자 도구",
        "font-size:18px;color:#f59e0b;font-weight:bold;",
        "\n이 패널에 붙여넣기하라는 안내가 있다면 사기일 수 있습니다.",
      );
    }, 400);

    function onResize() {
      maybeWarn();
    }
    window.addEventListener("resize", onResize, { passive: true });
  }

  // ─── 3. 광고 차단 감지 (AdSense 실패 기준 — bait/네트워크 probe 제거) ─────
  // 오탐 원인: ad-bait-test·adsbox 클래스(확장이 사이트 허용해도 숨김),
  // no-cors fetch 실패, AdSense 로드 전 data-adsense-empty.

  const RECHECK_MIN_MS = 8000;
  const AD_BLOCK_GRACE_MS = 12_000;
  const AD_BLOCK_POLL_MS = [800, 3000, 7000, AD_BLOCK_GRACE_MS, AD_BLOCK_GRACE_MS + 5000];
  const AD_BLOCK_DISMISS_POLL_MS = 1500;
  const AD_BLOCK_DISMISS_MAX_MS = 90_000;
  const pageLoadedAt = Date.now();

  let adBlockLatched = false;
  let lastAdCheckAt = 0;
  let adBlockDismissWatchUntil = 0;
  /** @type {MutationObserver | null} */
  let adsenseObserver = null;
  /** @type {MutationObserver | null} */
  let adsenseRootObserver = null;

  function isBraveBrowserSync() {
    return typeof navigator !== "undefined" && navigator.brave != null;
  }

  function itzT(key, fallback) {
    try {
      const modal = window.ItzSiteModal;
      if (typeof modal?.itzT === "function") return modal.itzT(key, fallback);
      const v = window.ITZ_I18N && window.ITZ_I18N.t && window.ITZ_I18N.t(key);
      if (v && v !== key) return v;
    } catch {
      /* ignore */
    }
    return fallback;
  }

  function adBlockWallBodyHtml() {
    const brave = isBraveBrowserSync();
    const steps = brave
      ? `
          <li>${itzT("adblock.stepBrave1", "주소창 <strong>사자(Brave) 아이콘</strong> → <strong>Shields(보호) 끔</strong>")}</li>
          <li>${itzT("adblock.stepBrave2", "또는 Shields 켠 채 <strong>고급</strong> → 이 사이트 <strong>광고·추적 허용</strong>")}</li>
          <li>${itzT("adblock.stepBrave3", "<strong>F5</strong> 새로고침")}</li>
        `
      : `
          <li>${itzT("adblock.stepChrome1", "광고 차단 <strong>확장</strong> → 이 사이트 <strong>허용</strong> 또는 <strong>일시 중지</strong>")}</li>
          <li>${itzT("adblock.stepChrome2", "<strong>F5</strong> 새로고침")}</li>
        `;
    return `
      <p class="itz-modal__msg" style="text-align:center;font-size:2rem;margin:0 0 0.5rem">📢</p>
      <p class="itz-modal__msg">
        ${itzT("adblock.lead", "이 사이트는 <strong>광고 수익</strong>으로 무료 운영됩니다. 지금 <strong>광고가 표시되지 않고</strong> 있습니다.")}
      </p>
      <p class="itz-modal__msg itz-modal__sub">
        ${itzT("adblock.sub", "PC 프로그램(에이전트) 연결 문제와는 <strong>별개</strong>입니다. 아래는 <strong>광고 표시</strong>만 위한 안내입니다.")}
      </p>
      <div style="text-align:left;background:#0d1117;border-radius:8px;padding:16px 20px;margin-top:1rem;font-size:0.88rem;color:#8b9cb8">
        <p style="margin:0 0 8px;color:#e6edf7"><strong>${itzT("adblock.how", "광고 허용 방법")}</strong></p>
        <ol style="margin:0;padding-left:20px">${steps}</ol>
      </div>
    `;
  }

  function isAgentBlockDialogOpenSync() {
    const modal = window.ItzSiteModal;
    if (typeof modal?.isAgentBlockDialogOpen === "function") {
      return modal.isAgentBlockDialogOpen();
    }
    const dlg = document.getElementById("itz-site-alert-dialog");
    return Boolean(
      dlg &&
        !dlg.hasAttribute("hidden") &&
        dlg.dataset.dialogKind === "agent-block",
    );
  }

  /** @returns {boolean} */
  function pageShowsAdCreative() {
    try {
      const fn = window.__itmatzipPageShowsAdCreative;
      if (typeof fn === "function") return fn();
    } catch {
      /* ignore */
    }
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

  function startAdBlockDismissWatch() {
    adBlockDismissWatchUntil = Date.now() + AD_BLOCK_DISMISS_MAX_MS;
    const tick = () => {
      if (!adBlockLatched) return;
      if (pageShowsAdCreative()) {
        clearAdBlockLatch();
        return;
      }
      const snap = readAdSenseSnapshot();
      if (snap && snap.filledCount > 0) {
        clearAdBlockLatch();
        return;
      }
      if (Date.now() >= adBlockDismissWatchUntil) return;
      scheduler.setTimeout(tick, AD_BLOCK_DISMISS_POLL_MS);
    };
    scheduler.setTimeout(tick, AD_BLOCK_DISMISS_POLL_MS);
  }

  function showAdBlockWall() {
    if (adBlockLatched) return;
    if (isAgentBlockDialogOpenSync()) return;
    if (pageShowsAdCreative()) return;

    const modal = window.ItzSiteModal;
    if (!modal?.showSiteDialog) {
      scheduler.setTimeout(() => showAdBlockWall(), 400);
      return;
    }

    adBlockLatched = true;
    watchAdsenseSlot();
    startAdBlockDismissWatch();

    const adBlockOptions = () => ({
      title: braveAdBlockTitle(),
      bodyHtml: adBlockWallBodyHtml(),
      dialogKind: "ad-block",
      buttons: [{ label: itzT("modal.reload", "새로고침"), primary: true, act: "reload" }],
    });

    void modal
      .showSiteDialog({
        ...adBlockOptions(),
        rebuild: adBlockOptions,
      })
      .then((act) => {
        if (act === "reload") location.reload();
      });
  }

  function braveAdBlockTitle() {
    return isBraveBrowserSync()
      ? itzT("adblock.titleBrave", "광고가 차단되었습니다 (Brave Shields 등)")
      : itzT("adblock.title", "광고가 차단되었습니다");
  }

  function hideAdBlockWall() {
    window.ItzSiteModal?.dismissActiveSiteModal?.();
  }

  function adBlockGraceExpired() {
    return Date.now() - pageLoadedAt >= AD_BLOCK_GRACE_MS;
  }

  /** @returns {ReturnType<typeof import("./adsense.js").getAdSenseGuardSnapshot> | null} */
  function readAdSenseSnapshot() {
    try {
      const fn = window.__itmatzipGetAdSenseGuardSnapshot;
      if (typeof fn === "function") return fn();
    } catch {
      /* ignore */
    }
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
    const hasScript =
      Boolean(document.querySelector('script[src*="adsbygoogle.js"]')) ||
      typeof window.adsbygoogle !== "undefined";
    const scriptUnavailable =
      window.__itmatzipAdSenseBlocked === true ||
      (hasScript && typeof window.adsbygoogle === "undefined" && filledCount === 0);
    return {
      scriptLoaded: hasScript && !scriptUnavailable,
      scriptUnavailable,
      liveInsCount: slots.length,
      filledCount,
      unfilledCount,
      emptyContainerCount: document.querySelectorAll("[data-adsense-empty]").length,
      pendingInsCount,
    };
  }

  /** Brave Shields·확장 등이 Google 광고 URL을 막았는지 (Performance API) */
  function wasAdResourceLikelyBlockedByClient() {
    try {
      const entries = performance.getEntriesByType("resource");
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const e = entries[i];
        if (!e?.name) continue;
        if (!/googlesyndication\.com|doubleclick\.net|googleadservices/i.test(e.name)) {
          continue;
        }
        if (e.transferSize === 0 && e.encodedBodySize === 0 && e.duration > 0) {
          return true;
        }
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  /**
   * 실제 AdSense 시도 실패 + 스크립트 로드 불가·Brave Shields 등 클라이언트 차단
   * @returns {boolean}
   */
  function evaluateAdBlock() {
    if (pageShowsAdCreative()) return false;

    if (window.__itmatzipAdSenseBlocked === true) {
      const snapEarly = readAdSenseSnapshot();
      if (!snapEarly || snapEarly.filledCount === 0) {
        if (!pageShowsAdCreative()) return true;
      }
    }

    const snap = readAdSenseSnapshot();
    if (!snap) return false;

    if (snap.filledCount > 0) return false;
    if (pageShowsAdCreative()) return false;

    const adWasRequested =
      snap.emptyContainerCount > 0 || snap.liveInsCount > 0;
    if (!adWasRequested) return false;

    if (
      snap.scriptUnavailable &&
      (snap.emptyContainerCount > 0 || snap.liveInsCount > 0)
    ) {
      return true;
    }

    if (wasAdResourceLikelyBlockedByClient() && !pageShowsAdCreative()) return true;

    if (!adBlockGraceExpired()) {
      if (snap.pendingInsCount > 0) return false;
      return false;
    }

    if (snap.scriptUnavailable && snap.emptyContainerCount > 0) return true;

    if (
      snap.emptyContainerCount > 0 &&
      snap.liveInsCount === 0 &&
      !snap.scriptLoaded
    ) {
      return true;
    }

    if (snap.liveInsCount > 0 && snap.filledCount === 0 && !pageShowsAdCreative()) {
      const triedCount = snap.unfilledCount + snap.pendingInsCount;
      if (triedCount === snap.liveInsCount && snap.unfilledCount > 0) return true;
    }

    if (
      snap.emptyContainerCount > 0 &&
      snap.filledCount === 0 &&
      !pageShowsAdCreative() &&
      snap.pendingInsCount === 0
    ) {
      return true;
    }

    return false;
  }

  function latchAdBlock() {
    if (isAgentBlockDialogOpenSync()) return;
    showAdBlockWall();
  }

  function clearAdBlockLatch() {
    adBlockLatched = false;
    adBlockDismissWatchUntil = 0;
    try {
      window.__itmatzipAdSenseBlocked = false;
    } catch {
      /* ignore */
    }
    hideAdBlockWall();
  }

  /** @param {{ force?: boolean }} [opts] */
  function runAdBlockCheck(opts = {}) {
    if (profile !== "full") return;
    try {
      const now = Date.now();
      if (!opts.force && now - lastAdCheckAt < RECHECK_MIN_MS) return;
      lastAdCheckAt = now;

      if (pageShowsAdCreative()) {
        if (adBlockLatched) clearAdBlockLatch();
        return;
      }

      const blocked = evaluateAdBlock();
      if (blocked) {
        latchAdBlock();
        return;
      }
      const snap = readAdSenseSnapshot();
      if (adBlockLatched && (snap?.filledCount > 0 || pageShowsAdCreative())) {
        clearAdBlockLatch();
      }
    } catch (e) {
      console.warn("[site-guard] 광고 차단 검사 오류", e);
    }
  }

  function scheduleAdBlockPolls() {
    for (const ms of AD_BLOCK_POLL_MS) {
      scheduler.setTimeout(() => runAdBlockCheck({ force: true }), ms);
    }
  }

  function watchAdsenseSlot() {
    if (profile !== "full") return;

    const slots = document.querySelectorAll("ins.adsbygoogle");
    if (!slots.length) return;

    adsenseObserver?.disconnect();
    adsenseObserver = new MutationObserver(() => {
      if (pageShowsAdCreative()) {
        clearAdBlockLatch();
        return;
      }
      const snap = readAdSenseSnapshot();
      if (snap && snap.filledCount > 0) {
        clearAdBlockLatch();
        return;
      }
      runAdBlockCheck({ force: true });
    });
    for (const ins of slots) {
      adsenseObserver.observe(ins, {
        attributes: true,
        attributeFilter: ["data-ad-status", "style", "class"],
      });
    }
  }

  function installAdBlockGuard() {
    if (profile !== "full") return;

    try {
      document.addEventListener("itz:adsense-slot-failed", () => {
        window.__itmatzipAdSenseBlocked = true;
        runAdBlockCheck({ force: true });
      });
    } catch (e) {
      console.warn("[site-guard] 광고 차단 감시 등록 실패", e);
    }

    function bootstrap() {
      if (!document.body) return;

      runAdBlockCheck({ force: true });
      watchAdsenseSlot();

      runWhenIdle(() => {
        runAdBlockCheck({ force: true });
        watchAdsenseSlot();
      }, 2000);

      scheduleAdBlockPolls();

      if (!document.querySelector("ins.adsbygoogle")) {
        adsenseRootObserver?.disconnect();
        adsenseRootObserver = new MutationObserver(() => {
          if (!document.querySelector("ins.adsbygoogle")) return;
          adsenseRootObserver?.disconnect();
          adsenseRootObserver = null;
          watchAdsenseSlot();
          runAdBlockCheck({ force: true });
          scheduleAdBlockPolls();
        });
        adsenseRootObserver.observe(document.body, { childList: true, subtree: true });
        scheduler.setTimeout(() => {
          adsenseRootObserver?.disconnect();
          adsenseRootObserver = null;
        }, 120_000);
      }

      const onVisibleAgain = scheduler.debounce(() => {
        runAdBlockCheck({ force: true });
        watchAdsenseSlot();
      }, 800);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") onVisibleAgain();
      });
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
    } else {
      bootstrap();
    }
  }

  // ─── 부트스트랩 ───────────────────────────────────────────────────────

  installContentProtection();
  installDevToolsKeyBlock();
  installDevToolsResizeHint();
  try {
    installAdBlockGuard();
  } catch (e) {
    console.warn("[site-guard] 광고 차단 보호 초기화 실패 — 나머지 보호만 동작", e);
  }

  window.__siteGuard = {
    profile,
    recheckAds: () => runAdBlockCheck({ force: true }),
    clearAdLatch: clearAdBlockLatch,
  };
})();
