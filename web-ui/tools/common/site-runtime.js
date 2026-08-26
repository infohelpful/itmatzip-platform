/**
 * 숨긴 도구 직접 URL 차단. HEAD에서 동기적으로 화면을 가린 뒤 설정을 확인합니다.
 */
(function () {
  "use strict";

  try {
    var path = String(location.pathname || "");
    if (/\/admin(?:\/|$)/i.test(path)) return;

    var parts = path.split("/").filter(Boolean);
    if (!parts.length) return;
    var id = parts[0];
    if (id.indexOf(".") !== -1) return;
    if (id === "assets" || id === "common" || id === "admin") return;

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
