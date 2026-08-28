(function () {
  var KNOWN_TOOL_IDS = [
    "silence-remover",
    "auto-subtitle",
    "vocal-remover",
    "image-enhancer",
    "background-remover",
    "create-music",
    "magic-eraser",
    "voice-changer",
    "watermark-remover",
    "thumbnail-grabber",
    "ico-maker",
    "online-clock",
    "unattend-maker",
  ];
  var DEFAULT_MOBILE_IDS = ["thumbnail-grabber", "ico-maker", "online-clock", "unattend-maker"];

  /** Windows·macOS·Linux 데스크톱 UA — 좁은 창·터치 노트북만으로 모바일 판정하지 않음 */
  function isDesktopPlatform() {
    const ua = navigator.userAgent || "";
    if (/Windows NT|Win64|WOW64/i.test(ua)) return true;
    if (/iPhone|iPod|iPad|Android/i.test(ua)) return false;
    if (/Macintosh|Mac OS X/i.test(ua)) {
      if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) {
        return false;
      }
      return true;
    }
    if (/Linux|X11|CrOS/i.test(ua)) return true;
    return false;
  }

  function isMobileEnvironment() {
    const ua = navigator.userAgent || "";
    if (/Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
      return true;
    }
    if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) {
      return true;
    }
    if (isDesktopPlatform()) {
      return false;
    }
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const narrow = window.matchMedia("(max-width: 900px)").matches;
    return coarse && narrow;
  }

  function currentToolId() {
    const path = String(location.pathname || "");
    if (/\/admin(?:\/|$)/i.test(path)) return null;
    const attr = document.documentElement.getAttribute("data-tool-id");
    if (attr) return attr;
    const parts = path.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      if (KNOWN_TOOL_IDS.indexOf(parts[i]) !== -1) return parts[i];
    }
    if (!parts.length) return "";
    const id = parts[0];
    if (id.indexOf(".") !== -1) return "";
    if (id === "assets" || id === "common" || id === "admin") return "";
    return id;
  }

  function mobileEnabledIds(cfg) {
    if (!cfg || !Object.prototype.hasOwnProperty.call(cfg, "mobileEnabledToolIds")) {
      return DEFAULT_MOBILE_IDS.slice();
    }
    if (!Array.isArray(cfg.mobileEnabledToolIds)) return [];
    return cfg.mobileEnabledToolIds.filter(function (id) {
      return typeof id === "string" && id;
    });
  }

  function isMobileAllowed(cfg, toolId) {
    const allowed = mobileEnabledIds(cfg);
    if (toolId === "") {
      return allowed.length > 0;
    }
    return allowed.indexOf(toolId) !== -1;
  }

  function ensureOverlay() {
    let overlay = document.getElementById("mobile-only-overlay");
    if (overlay) return overlay;
    if (!document.getElementById("itz-mobile-only-fallback-css")) {
      const style = document.createElement("style");
      style.id = "itz-mobile-only-fallback-css";
      style.textContent =
        ".mobile-only-overlay{position:fixed;inset:0;z-index:20000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,17,21,.72)}" +
        ".mobile-only-overlay.is-hidden,[hidden].mobile-only-overlay{display:none!important}" +
        ".mobile-only-card{width:min(100%,360px);padding:32px 28px;border-radius:16px;border:1px solid #2d333f;background:#1a1d23;text-align:center;color:#e2e8f0;font-family:Pretendard,system-ui,sans-serif}" +
        ".mobile-only-title{margin:0 0 10px;font-size:1.2rem}.mobile-only-desc{margin:0;color:#94a3b8;line-height:1.6}";
      document.head.appendChild(style);
    }
    overlay = document.createElement("div");
    overlay.id = "mobile-only-overlay";
    overlay.className = "mobile-only-overlay is-hidden";
    overlay.hidden = true;
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML =
      '<div class="mobile-only-card">' +
      '<div class="mobile-only-icon" aria-hidden="true">🖥️</div>' +
      '<h2 class="mobile-only-title">PC에서만 이용할 수 있습니다</h2>' +
      '<p class="mobile-only-desc">이 도구는 데스크톱 PC 환경에 최적화되어 있습니다.<br>PC 브라우저로 접속해 주세요.</p>' +
      "</div>";
    document.body.appendChild(overlay);
    return overlay;
  }

  function showMobileOnlyOverlay() {
    const overlay = ensureOverlay();
    overlay.hidden = false;
    overlay.classList.remove("is-hidden");
    document.body.classList.add("mobile-only-active");
  }

  function hideMobileOnlyOverlay() {
    const overlay = document.getElementById("mobile-only-overlay");
    if (!overlay) return;
    overlay.hidden = true;
    overlay.classList.add("is-hidden");
    document.body.classList.remove("mobile-only-active");
  }

  function apply(cfg) {
    const toolId = currentToolId();
    if (toolId === null) return;
    if (isMobileAllowed(cfg, toolId)) {
      hideMobileOnlyOverlay();
      return;
    }
    showMobileOnlyOverlay();
  }

  function publicConfigUrls() {
    const origin = window.location.origin;
    return [
      origin + "/admin/api.php?action=public",
      origin + "/admin/site-config.json",
      "../admin/api.php?action=public",
      "../admin/site-config.json",
      "/admin/api.php?action=public",
      "/admin/site-config.json",
    ];
  }

  function fetchConfig(url) {
    return fetch(url, { cache: "no-store", credentials: "same-origin" }).then(function (res) {
      if (!res.ok) throw new Error("http");
      return res.json();
    }).then(function (data) {
      if (data && data.ok && data.config) return data.config;
      if (data && Array.isArray(data.mobileEnabledToolIds)) return data;
      if (data && data.hiddenToolIds) return data;
      throw new Error("shape");
    });
  }

  function loadConfig() {
    const urls = publicConfigUrls();
    let chain = Promise.reject(new Error("start"));
    urls.forEach(function (url) {
      chain = chain.catch(function () {
        return fetchConfig(url);
      });
    });
    return chain;
  }

  function init() {
    if (!isMobileEnvironment()) return;
    const toolId = currentToolId();
    if (toolId === null) return;

    // 설정 응답 전에 기본 허용 도구·대시보드는 바로 통과. 예전 스크립트처럼 전체를 막지 않음.
    apply({ mobileEnabledToolIds: DEFAULT_MOBILE_IDS.slice() });

    loadConfig()
      .then(function (cfg) {
        apply(cfg);
      })
      .catch(function () {
        apply({ mobileEnabledToolIds: DEFAULT_MOBILE_IDS.slice() });
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
