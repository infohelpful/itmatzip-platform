/**
 * 테마 부트 + 숨긴 도구 직접 URL 차단.
 * HEAD에서 동기적으로 테마를 넣고, 숨김 도구는 화면을 가린 뒤 설정을 확인합니다.
 */
(function () {
  "use strict";

  var THEME_KEY = "itz-theme";

  function readTheme() {
    try {
      return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
    } catch (e) {
      return "light";
    }
  }

  function applyTheme(theme) {
    var html = document.documentElement;
    html.setAttribute("data-theme", theme);
    html.style.colorScheme = theme;
  }

  function writeTheme(theme) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
      /* ignore */
    }
    applyTheme(theme);
    syncThemeToggles();
  }

  applyTheme(readTheme());

  (function injectThemeCss() {
    var href = "common/theme.css?v=10";
    var src = "";
    if (document.currentScript && document.currentScript.src) {
      src = document.currentScript.src;
    } else {
      var scripts = document.getElementsByTagName("script");
      for (var i = 0; i < scripts.length; i++) {
        var s = scripts[i].getAttribute("src") || "";
        if (s.indexOf("site-runtime.js") !== -1) {
          src = scripts[i].src || s;
          break;
        }
      }
    }
    if (src) {
      href = src.replace(/site-runtime\.js[^/]*$/, "theme.css?v=10");
    }
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    (document.head || document.documentElement).appendChild(link);
  })();

  if (readTheme() === "light") {
    var boot = document.createElement("style");
    boot.id = "itz-theme-boot";
    boot.textContent =
      'html[data-theme="light"]{background:#f4f6fa;color:#0f172a;' +
      "--bg-dark:#f4f6fa;--bg-elevated:#ffffff;--panel-bg:#ffffff;" +
      "--text-main:#0f172a;--text-dim:#334155;--text-muted:#475569;--border:#d8dee8;" +
      "--bg-card:#ffffff;--bg-input:#f8fafc;--text-primary:#0f172a;--text-secondary:#475569;" +
      "--as-bg:#f4f6fa;--as-panel:#ffffff;--as-panel-2:#eef2f7;--as-border:#d8dee8;" +
      "--as-text:#0f172a;--as-text-dim:#475569}" +
      'html[data-theme="light"] body{background-color:#f4f6fa;color:#0f172a}';
    (document.head || document.documentElement).appendChild(boot);
  }

  function syncThemeToggles() {
    var light = readTheme() === "light";
    var buttons = document.querySelectorAll(".itz-theme-toggle");
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      btn.setAttribute("aria-pressed", light ? "true" : "false");
      btn.setAttribute("title", light ? "다크 모드" : "화이트 모드");
      btn.setAttribute("aria-label", light ? "다크 모드로 전환" : "화이트 모드로 전환");
    }
  }

  function bindThemeToggle(btn) {
    if (!btn || btn.getAttribute("data-itz-theme-bound") === "1") return;
    btn.setAttribute("data-itz-theme-bound", "1");
    btn.addEventListener("click", function () {
      writeTheme(readTheme() === "light" ? "dark" : "light");
    });
  }

  function createThemeToggle() {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "itz-theme-toggle";
    btn.id = "itz-theme-toggle";
    btn.innerHTML = '<span class="itz-theme-toggle-icon" aria-hidden="true"></span>';
    return btn;
  }

  function mountThemeToggle() {
    if (!document.querySelector(".itz-theme-toggle")) {
      var btn = createThemeToggle();
      var hubTitle = document.querySelector(".hub-title-cluster .hub-title, .hub-title-row .hub-title");
      if (hubTitle && hubTitle.parentNode) {
        hubTitle.parentNode.insertBefore(btn, hubTitle.nextSibling);
      } else {
        var toolTitle = document.querySelector(".logo-title-row > h1, .as-topbar-left > .as-logo");
        if (toolTitle && toolTitle.parentNode) {
          toolTitle.parentNode.insertBefore(btn, toolTitle.nextSibling);
        }
      }
    }
    var all = document.querySelectorAll(".itz-theme-toggle");
    for (var i = 0; i < all.length; i++) bindThemeToggle(all[i]);
    syncThemeToggles();
  }

  function mountSiteFooter() {
    if (/\/admin(?:\/|$)/i.test(location.pathname || "")) return;
    if (document.querySelector(".itz-site-footer")) return;

    var path = String(location.pathname || "");
    var links = [
      { href: "/", label: "홈" },
      { href: "/legal/policy.html", label: "운영정책" },
      { href: "/legal/email.html", label: "이메일 무단수집 거부" },
      { href: "/legal/copyright.html", label: "저작권 및 권리" },
      { href: "/legal/disclaimer.html", label: "책임의 한계와 법적 고지" },
      { href: "/legal/about.html", label: "ItMatzipTools 소개" }
    ];

    var nav = "";
    for (var i = 0; i < links.length; i++) {
      var item = links[i];
      var current = false;
      if (item.href === "/") {
        current = path === "/" || path === "/index.html";
      } else {
        current = path.indexOf(item.href) !== -1;
      }
      nav +=
        '<a href="' +
        item.href +
        '"' +
        (current ? ' aria-current="page"' : "") +
        ">" +
        item.label +
        "</a>";
    }

    var footer = document.createElement("footer");
    footer.className = "itz-site-footer";
    footer.innerHTML =
      '<div class="itz-site-footer-inner">' +
      '<p class="itz-site-footer-copy">© 2026 itmatzipTools</p>' +
      '<nav class="itz-site-footer-nav" aria-label="사이트 안내">' +
      nav +
      "</nav></div>";
    document.body.appendChild(footer);
  }

  function mountChrome() {
    mountThemeToggle();
    mountSiteFooter();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountChrome);
  } else {
    mountChrome();
  }

  window.addEventListener("storage", function (ev) {
    if (ev.key === THEME_KEY) {
      applyTheme(readTheme());
      syncThemeToggles();
    }
  });

  try {
    var path = String(location.pathname || "");
    if (/\/admin(?:\/|$)/i.test(path)) return;

    var parts = path.split("/").filter(Boolean);
    if (!parts.length) return;
    var id = parts[0];
    if (id.indexOf(".") !== -1) return;
    if (id === "assets" || id === "common" || id === "admin" || id === "legal") return;

    var ua = String(navigator.userAgent || "");
    var isCrawler = /Googlebot|bingbot|Yeti|NaverBot|DuckDuckBot|Slurp|YandexBot|Baiduspider|facebookexternalhit|Twitterbot|kakaotalk|Discordbot|LinkedInBot/i.test(ua);

    if (!isCrawler) {
      var style = document.createElement("style");
      style.id = "itz-boot-hide";
      style.textContent = "html{visibility:hidden !important}";
      (document.head || document.documentElement).appendChild(style);
    }

    var revealed = false;
    function reveal() {
      if (revealed) return;
      revealed = true;
      var s = document.getElementById("itz-boot-hide");
      if (s && s.parentNode) s.parentNode.removeChild(s);
    }

    function blockPage() {
      window.__itzToolHidden = true;
      try {
        if (typeof window.stop === "function") window.stop();
      } catch (e) {
        /* ignore */
      }
      document.title = "이용할 수 없습니다";
      document.documentElement.innerHTML =
        "<head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
        "<title>이용할 수 없습니다</title><style>" +
        "html,body{margin:0;min-height:100%;background:#0f1115;color:#e2e8f0;font-family:Pretendard,system-ui,sans-serif}" +
        ".wrap{max-width:440px;margin:18vh auto;padding:0 20px;text-align:center}" +
        "h1{font-size:1.35rem;margin:0 0 10px}p{color:#94a3b8;line-height:1.6}" +
        "a{color:#60a5fa;text-decoration:none}</style></head><body><div class=\"wrap\">" +
        "<h1>이용할 수 없습니다</h1><p>이 도구는 현재 공개되지 않습니다.</p>" +
        "<p><a href=\"/\">대시보드로 이동</a></p></div></body>";
    }

    function apply(cfg) {
      var hidden = cfg && Array.isArray(cfg.hiddenToolIds) ? cfg.hiddenToolIds : [];
      if (hidden.indexOf(id) !== -1) {
        blockPage();
        return;
      }
      reveal();
    }

    var timer = window.setTimeout(reveal, 3500);
    var publicUrl = "/admin/api.php?action=public";
    var fileUrl = "/admin/site-config.json";

    fetch(publicUrl, { cache: "no-store", credentials: "same-origin" })
      .then(function (res) {
        return res.ok ? res.json() : Promise.reject(new Error("api"));
      })
      .then(function (data) {
        if (data && data.ok && data.config) return data.config;
        throw new Error("api-config");
      })
      .catch(function () {
        return fetch(fileUrl, { cache: "no-store" }).then(function (res) {
          return res.ok ? res.json() : Promise.reject(new Error("file"));
        });
      })
      .then(function (cfg) {
        window.clearTimeout(timer);
        apply(cfg);
      })
      .catch(function () {
        window.clearTimeout(timer);
        reveal();
      });
  } catch (err) {
    /* fail open */
  }
})();
