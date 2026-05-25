/**
 * site-guard.js — 사이트 보호 모듈
 * 우클릭/복사/DevTools 차단 + 광고 차단 확장 감지 시 콘텐츠 접근 차단
 *
 * 사용법: <script type="module" src="../common/site-guard.js"></script>
 * import 시 자동 실행
 *
 * Kill switch: URL에 ?_sg_off=1 또는 localStorage에 _sg_off=1 설정 시 비활성화
 */

(function () {
  "use strict";

  const KILL_SWITCH_KEY = "_sg_off";
  if (
    new URLSearchParams(location.search).get(KILL_SWITCH_KEY) === "1" ||
    (() => { try { return localStorage.getItem(KILL_SWITCH_KEY) === "1"; } catch { return false; } })()
  ) {
    return;
  }

  // ─── 1. 우클릭 / 복사 / 드래그 차단 ────────────────────────────────────

  document.addEventListener("contextmenu", (e) => e.preventDefault(), true);
  document.addEventListener("selectstart", (e) => e.preventDefault(), true);
  document.addEventListener("dragstart", (e) => e.preventDefault(), true);
  document.addEventListener("copy", (e) => e.preventDefault(), true);
  document.addEventListener("cut", (e) => e.preventDefault(), true);

  // ─── 2. DevTools 단축키 차단 ───────────────────────────────────────────

  const BLOCKED_KEYS = new Set([
    "F12",
    "KeyI", // Ctrl+Shift+I
    "KeyJ", // Ctrl+Shift+J
    "KeyU", // Ctrl+U
    "KeyC", // Ctrl+Shift+C (element inspector)
  ]);

  document.addEventListener("keydown", (e) => {
    if (e.key === "F12") {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
    if (e.ctrlKey && e.shiftKey && BLOCKED_KEYS.has(e.code)) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
    if (e.ctrlKey && !e.shiftKey && e.code === "KeyU") {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
  }, true);

  // ─── 3. DevTools 열림 감지 ─────────────────────────────────────────────

  let devtoolsOpen = false;
  const DEVTOOLS_THRESHOLD = 160;

  function checkDevTools() {
    const widthDiff = window.outerWidth - window.innerWidth > DEVTOOLS_THRESHOLD;
    const heightDiff = window.outerHeight - window.innerHeight > DEVTOOLS_THRESHOLD;
    const prev = devtoolsOpen;
    devtoolsOpen = widthDiff || heightDiff;
    if (devtoolsOpen && !prev) {
      onDevToolsDetected();
    }
  }

  function onDevToolsDetected() {
    console.clear();
    console.log(
      "%c⚠️ 경고",
      "font-size:40px;color:red;font-weight:bold;"
    );
    console.log(
      "%c이 브라우저 기능은 개발자를 위한 것입니다.\n누군가 여기에 무언가를 복사-붙여넣기하라고 했다면 사기일 가능성이 높습니다.",
      "font-size:16px;"
    );
  }

  setInterval(checkDevTools, 1000);

  // debugger trap (DevTools가 열려있으면 무한 breakpoint)
  (function dbgLoop() {
    const start = performance.now();
    debugger;
    if (performance.now() - start > 100) {
      devtoolsOpen = true;
    }
    setTimeout(dbgLoop, 3000);
  })();

  // ─── 4. console 출력 무력화 ────────────────────────────────────────────

  const noop = () => {};
  if (typeof window.__sg_console_patched === "undefined") {
    window.__sg_console_patched = true;
    const keep = console.error.bind(console);
    Object.defineProperty(window, "console", {
      get() {
        return new Proxy(console, {
          get(target, prop) {
            if (prop === "error") return keep;
            if (typeof target[prop] === "function") return noop;
            return target[prop];
          },
        });
      },
      configurable: false,
    });
  }

  // ─── 5. 광고 차단 감지 ─────────────────────────────────────────────────

  let adBlockDetected = false;
  let adBlockCheckDone = false;
  const AD_CHECK_INTERVAL = 5000;

  function createBaitElement() {
    const bait = document.createElement("div");
    bait.className = "ad-banner ads adsbox ad-placeholder";
    bait.setAttribute("id", "ad-bait-test");
    bait.style.cssText =
      "position:absolute!important;width:1px!important;height:1px!important;" +
      "top:-1000px!important;left:-1000px!important;pointer-events:none!important;opacity:0!important;";
    bait.innerHTML = "&nbsp;";
    document.body.appendChild(bait);
    return bait;
  }

  function checkAdBlock() {
    const bait = document.getElementById("ad-bait-test") || createBaitElement();
    const hidden =
      bait.offsetParent === null ||
      bait.offsetHeight === 0 ||
      bait.offsetWidth === 0 ||
      getComputedStyle(bait).display === "none" ||
      getComputedStyle(bait).visibility === "hidden";

    if (hidden) {
      adBlockDetected = true;
      adBlockCheckDone = true;
      showAdBlockWall();
      return;
    }

    const adsenseIns = document.querySelector("ins.adsbygoogle");
    if (adsenseIns) {
      const status = adsenseIns.getAttribute("data-ad-status");
      if (status === "unfilled") {
        // unfilled는 재고 없음이므로 차단으로 보지 않음
      }
      const insHeight = adsenseIns.offsetHeight;
      if (insHeight === 0 && document.querySelector("[data-adsense-empty]")) {
        adBlockDetected = true;
      }
    }

    if (!adBlockDetected) {
      try {
        const testReq = new XMLHttpRequest();
        testReq.open(
          "GET",
          "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
          false
        );
        testReq.send();
        if (testReq.status === 0) adBlockDetected = true;
      } catch {
        adBlockDetected = true;
      }
    }

    adBlockCheckDone = true;
    if (adBlockDetected) {
      showAdBlockWall();
    } else {
      hideAdBlockWall();
    }
  }

  // ─── 6. 차단 UI ───────────────────────────────────────────────────────

  const WALL_ID = "sg-adblock-wall";

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
        <button class="sg-wall__btn" onclick="location.reload()">새로고침</button>
      </div>
    `;
    document.body.appendChild(wall);

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
      #${WALL_ID}.sg-active {
        display: flex;
      }
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
      .sg-wall__icon {
        font-size: 48px;
        margin-bottom: 16px;
      }
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
      .sg-wall__steps p {
        margin: 0 0 8px;
        color: #e6edf7;
      }
      .sg-wall__steps ol {
        margin: 0;
        padding-left: 20px;
      }
      .sg-wall__steps li {
        margin-bottom: 4px;
      }
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
        transition: background 0.2s;
      }
      .sg-wall__btn:hover {
        background: #5a3dd0;
      }
      body.sg-blocked {
        overflow: hidden !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);

    return wall;
  }

  function showAdBlockWall() {
    const wall = getOrCreateWall();
    wall.classList.add("sg-active");
    document.body.classList.add("sg-blocked");
  }

  function hideAdBlockWall() {
    const wall = document.getElementById(WALL_ID);
    if (wall) {
      wall.classList.remove("sg-active");
      document.body.classList.remove("sg-blocked");
    }
  }

  // ─── 7. 초기화 ────────────────────────────────────────────────────────

  function init() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", init);
      return;
    }
    createBaitElement();
    setTimeout(checkAdBlock, 2000);
    setInterval(() => {
      adBlockDetected = false;
      checkAdBlock();
    }, AD_CHECK_INTERVAL);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
