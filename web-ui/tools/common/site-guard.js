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

  if (killSwitchOn()) return;

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

  // ─── 3. 광고 차단 감지 (idle + 비동기, 반복 폴링 없음) ─────────────────

  const WALL_ID = "sg-adblock-wall";
  const SYNDICATION_PROBE =
    "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js";
  const RECHECK_MIN_MS = 60_000;

  let adBlockLatched = false;
  let lastAdCheckAt = 0;
  /** @type {MutationObserver | null} */
  let adsenseObserver = null;

  function getOrCreateWall() {
    let wall = document.getElementById(WALL_ID);
    if (wall) return wall;

    wall = document.createElement("div");
    wall.id = WALL_ID;
    wall.innerHTML = `
      <div class="sg-wall__backdrop"></div>
      <div class="sg-wall__dialog">
        <div class="sg-wall__icon">🛡️</div>
        <h2 class="sg-wall__title">광고 차단 프로그램이 감지되었습니다</h2>
        <p class="sg-wall__text">
          본 사이트는 무료로 제공되며, 광고 수익으로 운영됩니다.<br>
          사이트를 계속 이용하시려면 <strong>광고 차단 프로그램을 비활성화</strong>한 후<br>
          페이지를 새로고침해 주세요.
        </p>
        <div class="sg-wall__steps">
          <p><strong>해제 방법:</strong></p>
          <ol>
            <li>브라우저 주소창 오른쪽의 확장 프로그램 아이콘 클릭</li>
            <li>광고 차단 프로그램에서 이 사이트를 허용 목록에 추가</li>
            <li>페이지 새로고침 (F5 또는 Ctrl+R)</li>
          </ol>
        </div>
        <button type="button" class="sg-wall__btn" id="sg-wall-reload">새로고침</button>
      </div>
    `;
    document.body.appendChild(wall);
    wall.querySelector("#sg-wall-reload")?.addEventListener("click", () => {
      location.reload();
    });

    const style = document.createElement("style");
    style.textContent = `
      #${WALL_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: none;
        align-items: center;
        justify-content: center;
      }
      #${WALL_ID}.sg-active { display: flex; }
      .sg-wall__backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0,0,0,0.85);
        backdrop-filter: blur(8px);
      }
      .sg-wall__dialog {
        position: relative;
        background: #1a1f2e;
        border: 1px solid #3a4560;
        border-radius: 16px;
        padding: 40px 48px;
        max-width: 520px;
        width: 90%;
        text-align: center;
        color: #e6edf7;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
      }
      .sg-wall__icon { font-size: 48px; margin-bottom: 16px; }
      .sg-wall__title {
        margin: 0 0 12px;
        font-size: 1.4rem;
        font-weight: 700;
        color: #fff;
      }
      .sg-wall__text {
        margin: 0 0 20px;
        font-size: 0.95rem;
        line-height: 1.6;
        color: #b0bec5;
      }
      .sg-wall__steps {
        text-align: left;
        background: #0d1117;
        border-radius: 8px;
        padding: 16px 20px;
        margin-bottom: 24px;
        font-size: 0.88rem;
        color: #8b9cb8;
      }
      .sg-wall__steps p { margin: 0 0 8px; color: #e6edf7; }
      .sg-wall__steps ol { margin: 0; padding-left: 20px; }
      .sg-wall__steps li { margin-bottom: 4px; }
      .sg-wall__btn {
        display: inline-block;
        padding: 12px 32px;
        background: #6d4ce6;
        color: #fff;
        border: none;
        border-radius: 8px;
        font-size: 1rem;
        font-weight: 600;
        cursor: pointer;
      }
      .sg-wall__btn:hover { background: #5a3dd0; }
      body.sg-blocked { overflow: hidden !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
    return wall;
  }

  function showAdBlockWall() {
    adBlockLatched = true;
    const wall = getOrCreateWall();
    wall.classList.add("sg-active");
    document.body.classList.add("sg-blocked");
    adsenseObserver?.disconnect();
    adsenseObserver = null;
  }

  function hideAdBlockWall() {
    const wall = document.getElementById(WALL_ID);
    if (wall) wall.classList.remove("sg-active");
    document.body.classList.remove("sg-blocked");
  }

  function ensureBaitElement() {
    let bait = document.getElementById("ad-bait-test");
    if (bait) return bait;
    bait = document.createElement("div");
    bait.id = "ad-bait-test";
    bait.className = "ad-banner ads adsbox ad-placeholder";
    bait.setAttribute("aria-hidden", "true");
    bait.style.cssText =
      "position:absolute!important;width:1px!important;height:1px!important;" +
      "top:-9999px!important;left:-9999px!important;pointer-events:none!important;" +
      "opacity:0!important;";
    bait.textContent = "\u00a0";
    document.body.appendChild(bait);
    return bait;
  }

  function baitLooksBlocked(bait) {
    if (!bait) return false;
    if (
      bait.offsetParent === null ||
      bait.offsetHeight === 0 ||
      bait.offsetWidth === 0
    ) {
      return true;
    }
    const cs = getComputedStyle(bait);
    return cs.display === "none" || cs.visibility === "hidden";
  }

  function adsenseSlotLooksBlocked() {
    const ins = document.querySelector("ins.adsbygoogle");
    if (!ins) return false;
    if (ins.getAttribute("data-ad-status") === "unfilled") return false;
    if (ins.offsetHeight > 0) return false;
    return Boolean(document.querySelector("[data-adsense-empty]"));
  }

  /** @returns {Promise<boolean>} true = 차단됨 */
  async function probeSyndicationAsync() {
    try {
      const ctrl = new AbortController();
      const t = window.setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(SYNDICATION_PROBE, {
        method: "HEAD",
        mode: "no-cors",
        cache: "no-store",
        signal: ctrl.signal,
      });
      window.clearTimeout(t);
      void res;
      return false;
    } catch {
      return true;
    }
  }

  /**
   * @param {{ allowNetworkProbe?: boolean }} [opts]
   * @returns {Promise<boolean>} true = 차단 확정
   */
  async function evaluateAdBlock(opts = {}) {
    if (adBlockLatched) return true;

    const bait = ensureBaitElement();
    if (baitLooksBlocked(bait)) return true;
    if (adsenseSlotLooksBlocked()) return true;

    if (opts.allowNetworkProbe) {
      const netBlocked = await probeSyndicationAsync();
      if (netBlocked) return true;
    }
    return false;
  }

  function latchAdBlock() {
    showAdBlockWall();
  }

  function clearAdBlockLatch() {
    adBlockLatched = false;
    hideAdBlockWall();
  }

  /** @param {{ allowNetworkProbe?: boolean, force?: boolean }} [opts] */
  async function runAdBlockCheck(opts = {}) {
    if (profile !== "full") return;
    if (adBlockLatched && !opts.force) return;

    const now = Date.now();
    if (!opts.force && now - lastAdCheckAt < RECHECK_MIN_MS) return;
    lastAdCheckAt = now;

    const blocked = await evaluateAdBlock({
      allowNetworkProbe: Boolean(opts.allowNetworkProbe),
    });
    if (blocked) {
      latchAdBlock();
    } else if (!adBlockLatched) {
      hideAdBlockWall();
    }
  }

  function watchAdsenseSlot() {
    if (profile !== "full" || adBlockLatched) return;

    const ins = document.querySelector("ins.adsbygoogle");
    if (!ins) return;

    adsenseObserver?.disconnect();
    adsenseObserver = new MutationObserver(() => {
      if (adBlockLatched) {
        adsenseObserver?.disconnect();
        return;
      }
      if (adsenseSlotLooksBlocked()) {
        latchAdBlock();
        adsenseObserver?.disconnect();
        return;
      }
      const status = ins.getAttribute("data-ad-status");
      if (status === "filled" || status === "unfilled") {
        adsenseObserver?.disconnect();
        adsenseObserver = null;
      }
    });
    adsenseObserver.observe(ins, {
      attributes: true,
      attributeFilter: ["data-ad-status", "style", "class"],
    });
  }

  function installAdBlockGuard() {
    if (profile !== "full") return;

    function bootstrap() {
      if (!document.body) return;

      ensureBaitElement();

      runWhenIdle(() => {
        void runAdBlockCheck({ allowNetworkProbe: true });
        watchAdsenseSlot();
      }, 5000);

      // AdSense 삽입이 늦는 페이지: 슬롯 등장 시 1회만 관찰
      if (!document.querySelector("ins.adsbygoogle")) {
        const rootObs = new MutationObserver(() => {
          if (!document.querySelector("ins.adsbygoogle")) return;
          rootObs.disconnect();
          watchAdsenseSlot();
          void runAdBlockCheck({ allowNetworkProbe: false });
        });
        rootObs.observe(document.body, { childList: true, subtree: true });
        scheduler.setTimeout(() => rootObs.disconnect(), 120_000);
      }

      const onVisibleAgain = scheduler.debounce(() => {
        if (adBlockLatched) return;
        void runAdBlockCheck({ allowNetworkProbe: false, force: true });
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
  installAdBlockGuard();

  window.__siteGuard = {
    profile,
    recheckAds: () => runAdBlockCheck({ allowNetworkProbe: true, force: true }),
    clearAdLatch: clearAdBlockLatch,
  };
})();
