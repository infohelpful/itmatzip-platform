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
    "audio-join",
    "thumbnail-grabber",
    "ico-maker",
    "image-combiner",
    "online-clock",
    "unattend-maker",
    "json-formatter",
    "currency-calculator",
  ];
  var DEFAULT_MOBILE_IDS = ["thumbnail-grabber", "ico-maker", "image-combiner", "online-clock", "unattend-maker", "json-formatter", "currency-calculator"];

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
    if (/Android|webOS|iPhone|iPod|iPad|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
      return true;
    }
    try {
      if (navigator.userAgentData && navigator.userAgentData.mobile) return true;
    } catch (e) {
      /* ignore */
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
    if (attr && KNOWN_TOOL_IDS.indexOf(attr) !== -1) return attr;
    const parts = path.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      if (KNOWN_TOOL_IDS.indexOf(parts[i]) !== -1) return parts[i];
    }
    return "";
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
    if (!toolId) return true;
    return mobileEnabledIds(cfg).indexOf(toolId) !== -1;
  }

  function itzT(key, fallback) {
    try {
      var v = window.ITZ_I18N && window.ITZ_I18N.t && window.ITZ_I18N.t(key);
      if (v && v !== key) return v;
    } catch (e) {
      /* ignore */
    }
    return fallback;
  }

  function applyMobileCopy(overlay) {
    if (!overlay) overlay = document.getElementById("mobile-only-overlay");
    if (!overlay) return;
    var title = overlay.querySelector(".mobile-only-title") || overlay.querySelector("#mobile-only-title");
    var desc = overlay.querySelector(".mobile-only-desc");
    if (title) title.textContent = itzT("mobileTitle", "PC에서만 이용할 수 있습니다");
    if (desc) {
      var html = itzT(
        "mobileDesc",
        "이 도구는 데스크톱 PC 환경에 최적화되어 있습니다.<br>PC 브라우저로 접속해 주세요.",
      );
      if (String(html).indexOf("<") !== -1) desc.innerHTML = html;
      else desc.textContent = html;
    }
  }

  function ensureOverlay() {
    let overlay = document.getElementById("mobile-only-overlay");
    if (overlay) {
      applyMobileCopy(overlay);
      return overlay;
    }
    if (!document.getElementById("itz-mobile-only-fallback-css")) {
      const style = document.createElement("style");
      style.id = "itz-mobile-only-fallback-css";
      style.textContent =
        ".mobile-only-overlay{position:fixed;inset:0;z-index:20000;display:none;align-items:center;justify-content:center;padding:24px;background:rgba(15,17,21,.72)}" +
        ".mobile-only-overlay.is-open{display:flex!important}" +
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
    overlay.setAttribute("aria-labelledby", "mobile-only-title");
    overlay.innerHTML =
      '<div class="mobile-only-card">' +
      '<div class="mobile-only-icon" aria-hidden="true">🖥️</div>' +
      '<h2 id="mobile-only-title" class="mobile-only-title">PC에서만 이용할 수 있습니다</h2>' +
      '<p class="mobile-only-desc">이 도구는 데스크톱 PC 환경에 최적화되어 있습니다.<br>PC 브라우저로 접속해 주세요.</p>' +
      "</div>";
    document.body.appendChild(overlay);
    applyMobileCopy(overlay);
    return overlay;
  }

  function showMobileOnlyOverlay() {
    const overlay = ensureOverlay();
    overlay.hidden = false;
    overlay.classList.add("is-open");
    overlay.classList.remove("is-hidden");
    document.body.classList.add("mobile-only-active");
    applyMobileCopy(overlay);
  }

  function hideMobileOnlyOverlay() {
    const overlay = document.getElementById("mobile-only-overlay");
    if (!overlay) {
      document.body.classList.remove("mobile-only-active");
      return;
    }
    overlay.hidden = true;
    overlay.classList.remove("is-open");
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
    if (!isMobileEnvironment()) {
      hideMobileOnlyOverlay();
      return;
    }
    const toolId = currentToolId();
    if (toolId === null) return;

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
  document.addEventListener("itz:lang-change", function () {
    applyMobileCopy();
  });
})();
