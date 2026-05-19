(function () {
  function isMobileEnvironment() {
    const ua = navigator.userAgent || "";
    if (/Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
      return true;
    }
    if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) {
      return true;
    }
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const narrow = window.matchMedia("(max-width: 900px)").matches;
    return coarse && narrow;
  }

  function showMobileOnlyOverlay() {
    const overlay = document.getElementById("mobile-only-overlay");
    if (!overlay) return;
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
