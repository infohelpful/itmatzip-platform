(function () {
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

  function showMobileOnlyOverlay() {
    const overlay = document.getElementById("mobile-only-overlay");
    if (!overlay) return;
    overlay.hidden = false;
    overlay.classList.remove("is-hidden");
    document.body.classList.add("mobile-only-active");
  }

  function init() {
    if (!isMobileEnvironment()) return;
    showMobileOnlyOverlay();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
