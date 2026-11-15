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
    // Text the user types (subtitle editor, inputs) must stay selectable, copyable and cuttable.
    const editable = (target) => {
      const el = target instanceof Element ? target : target?.parentElement;
      return Boolean(el?.closest?.('textarea, input, select, [contenteditable=""], [contenteditable="true"]'));
    };
    const block = (e) => {
      if (editable(e.target)) return;
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

  // ─── 3. 광고 차단 감지 (로드 실패와 독립적인 숨김 증거를 함께 확인) ─────
  // 로드 실패, 광고 표식 숨김 어느 하나만으로 차단을 확정하지 않는다.

  const RECHECK_MIN_MS = 8000;
  const AD_BLOCK_GRACE_MS = 12_000;
  const AD_BLOCK_POLL_MS = [800, 3000, 7000, AD_BLOCK_GRACE_MS, AD_BLOCK_GRACE_MS + 5000];
  const AD_BLOCK_DISMISS_POLL_MS = 1500;
  const AD_BLOCK_DISMISS_MAX_MS = 90_000;
  const pageLoadedAt = Date.now();

  let adBlockLatched = false;
  let lastAdCheckAt = 0;
  let evidenceSince = 0;
  let probePair = null;
  const guardScriptUrl = document.currentScript?.src;
  let networkProbeRunning = false;
  let networkProbeAt = 0;
  let selectiveNetworkFailures = 0;
  let networkSuccesses = 0;
  let latchedNetworkBlock = false;
  let recoverySince = 0;
  const policyBlockedUrls = new Set();
  document.addEventListener("securitypolicyviolation", (event) => {
    if (event.blockedURI) policyBlockedUrls.add(event.blockedURI);
  });
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
        if (ins.getAttribute("data-ad-status") !== "filled") continue;
        const rect = ins.getBoundingClientRect();
        const style = getComputedStyle(ins);
        if (rect.width >= 20 && rect.height >= 20 && style.visibility === "visible" &&
            style.display !== "none" && Number(style.opacity) !== 0 &&
            (!ins.checkVisibility || ins.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) return true;
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
      runAdBlockCheck({ force: true });
      if (!adBlockLatched) return;
      if (Date.now() >= adBlockDismissWatchUntil) return;
      scheduler.setTimeout(tick, AD_BLOCK_DISMISS_POLL_MS);
    };
    scheduler.setTimeout(tick, AD_BLOCK_DISMISS_POLL_MS);
  }

  function isLabAudit() {
    try {
      if (navigator.webdriver) return true;
    } catch {
      /* ignore */
    }
    const ua = String(navigator.userAgent || "");
    return /Chrome-Lighthouse|PageSpeed|PTST|GTmetrix|WebPageTest|HeadlessChrome/i.test(ua);
  }

  function showAdBlockWall() {
    if (isLabAudit()) return;
    if (adBlockLatched) return;
    if (isAgentBlockDialogOpenSync()) return;
    if (!evaluateAdBlock()) return;

    const modal = window.ItzSiteModal;
    if (!modal?.showSiteDialog) {
      scheduler.setTimeout(() => showAdBlockWall(), 400);
      return;
    }

    adBlockLatched = true;
    latchedNetworkBlock = selectiveNetworkFailures >= 2;
    recoverySince = 0;
    watchAdsenseSlot();
    startAdBlockDismissWatch();

    const adBlockOptions = () => ({
      title: braveAdBlockTitle(),
      bodyHtml: adBlockWallBodyHtml(),
      dialogKind: "ad-block",
      persistent: true,
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
    if (window.ItzSiteModal?.isAdBlockDialogOpen?.()) {
      window.ItzSiteModal.dismissActiveSiteModal?.();
    }
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
    // Script presence or a command queue alone says nothing about load completion.
    const scriptUnavailable = window.__itmatzipAdSenseBlocked === true;
    return {
      scriptLoaded: window.adsbygoogle?.loaded === true,
      scriptUnavailable,
      liveInsCount: slots.length,
      filledCount,
      unfilledCount,
      emptyContainerCount: document.querySelectorAll("[data-adsense-empty]").length,
      pendingInsCount,
    };
  }

  function hasSelectiveAdHiding() {
    if (!document.body || document.hidden) return false;
    if (!probePair) {
      probePair = ["itz-layout-check", "adsbox ad-banner ad-placement"].map((name) => {
        const el = document.createElement("div");
        el.className = name;
        el.setAttribute("aria-hidden", "true");
        el.style.cssText = "position:fixed;left:-10000px;top:0;width:10px;height:10px;pointer-events:none;";
        document.body.appendChild(el);
        return el;
      });
    }
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return el.isConnected && style.display !== "none" && style.visibility !== "hidden" &&
        style.visibility !== "collapse" && rect.width >= 10 && rect.height >= 10;
    };
    return visible(probePair[0]) && !visible(probePair[1]);
  }

  // Same-origin control and ad-pattern resource distinguish selective filtering from
  // a disconnected server. HTTP errors, timeouts and CSP failures are inconclusive.
  async function checkSelectiveNetworkBlocking() {
    if (!guardScriptUrl || typeof fetch !== "function" || networkProbeRunning ||
        document.hidden || navigator.onLine === false || !adBlockGraceExpired() ||
        Date.now() - networkProbeAt < 8000) return;
    const snap = readAdSenseSnapshot();
    if (snap?.adsDisabled || pageShowsAdCreative() ||
        (!adBlockLatched && !snap?.scriptUnavailable && !(snap?.pendingInsCount > 0))) return;
    networkProbeRunning = true;
    networkProbeAt = Date.now();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);
    const controlUrl = new URL("guard-check.js", guardScriptUrl).href;
    const adUrl = new URL("ads/banner/ads.js", guardScriptUrl).href;
    const request = async (url) => {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        if (!response.ok) return "unknown";
        return (await response.text()).trim() === "/* itz-guard-check-v1 */" ? "ok" : "unknown";
      } catch {
        return controller.signal.aborted || policyBlockedUrls.has(url) ? "unknown" : "failed";
      }
    };
    try {
      const [control, ad] = await Promise.all([request(controlUrl), request(adUrl)]);
      const selective = control === "ok" && ad === "failed" && !policyBlockedUrls.has(adUrl);
      selectiveNetworkFailures = selective ? selectiveNetworkFailures + 1 : 0;
      networkSuccesses = control === "ok" && ad === "ok" ? networkSuccesses + 1 : 0;
    } finally {
      window.clearTimeout(timer);
      networkProbeRunning = false;
    }
    runAdBlockCheck({ force: true });
    if (selectiveNetworkFailures > 0 || adBlockLatched) {
      scheduler.setTimeout(() => runAdBlockCheck({ force: true }), 8000);
    }
  }

  // Script errors cannot distinguish blockers from DNS/CSP/network failures.
  // Require repeated selective filtering or selective hiding plus a real load failure.
  function evaluateAdBlock() {
    const snap = readAdSenseSnapshot();
    if (navigator.onLine === false || document.hidden || !adBlockGraceExpired() ||
        snap?.adsDisabled ||
        snap?.unfilledCount > 0 || pageShowsAdCreative()) {
      evidenceSince = 0;
      return false;
    }
    if (selectiveNetworkFailures >= 2) return true;
    if (snap?.scriptLoaded || !snap?.scriptUnavailable || !hasSelectiveAdHiding()) {
      evidenceSince = 0;
      return false;
    }
    if (!evidenceSince) {
      evidenceSince = Date.now();
      scheduler.setTimeout(() => runAdBlockCheck({ force: true }), 1500);
      return false;
    }
    return Date.now() - evidenceSince >= 1000;
  }

  // Unknown/loading/offline is not recovery. Require positive evidence to remain stable.
  function confirmAdRecovery() {
    const snap = readAdSenseSnapshot();
    if (document.hidden || navigator.onLine === false) {
      recoverySince = 0;
      return false;
    }
    const recovered = snap?.adsDisabled || pageShowsAdCreative() ||
      (snap?.scriptLoaded && !snap?.scriptUnavailable && !hasSelectiveAdHiding() &&
        (!latchedNetworkBlock || networkSuccesses >= 2));
    if (!recovered) {
      recoverySince = 0;
      return false;
    }
    if (!recoverySince) {
      recoverySince = Date.now();
      scheduler.setTimeout(() => runAdBlockCheck({ force: true }), 3000);
      return false;
    }
    return Date.now() - recoverySince >= 3000;
  }

  function latchAdBlock() {
    if (isAgentBlockDialogOpenSync()) return;
    showAdBlockWall();
  }

  function clearAdBlockLatch() {
    const wasLatched = adBlockLatched;
    adBlockLatched = false;
    latchedNetworkBlock = false;
    recoverySince = 0;
    selectiveNetworkFailures = 0;
    networkSuccesses = 0;
    evidenceSince = 0;
    adBlockDismissWatchUntil = 0;
    try {
      window.__itmatzipAdSenseBlocked = false;
    } catch {
      /* ignore */
    }
    if (wasLatched) hideAdBlockWall();
  }

  /** @param {{ force?: boolean }} [opts] */
  function runAdBlockCheck(opts = {}) {
    if (profile !== "full") return;
    try {
      const now = Date.now();
      if (!opts.force && now - lastAdCheckAt < RECHECK_MIN_MS) return;
      lastAdCheckAt = now;
      void checkSelectiveNetworkBlocking();

      if (adBlockLatched) {
        if (confirmAdRecovery()) clearAdBlockLatch();
        return;
      }
      if (evaluateAdBlock()) latchAdBlock();
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
        runAdBlockCheck({ force: true });
      });
    } catch (e) {
      console.warn("[site-guard] 광고 차단 감시 등록 실패", e);
    }

    // The overlay blocks pointer input; also keep keyboard interaction inside the wall.
    window.addEventListener("keydown", (event) => {
      if (!adBlockLatched) return;
      const dialog = document.getElementById("itz-site-alert-dialog");
      if (!dialog || dialog.hasAttribute("hidden") || dialog.dataset.dialogKind !== "ad-block") return;
      if (event.key === "Tab" || event.key === "Escape" || !dialog.contains(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        dialog.querySelector("button[data-act]")?.focus();
      }
    }, true);

    document.addEventListener("itz:adsense-script-state", () => runAdBlockCheck({ force: true }));
    window.addEventListener("online", () => runAdBlockCheck({ force: true }));
    window.addEventListener("focus", () => runAdBlockCheck({ force: true }));

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
