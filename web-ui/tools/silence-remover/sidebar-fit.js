/**
 * 왼쪽 패널이 스크롤 없이 한 화면에 모두 보이는 범위에서 글자·간격을 가장 크게 맞춘다.
 * 패널 크기 배율(--us)을 이진 탐색으로 정하고, 창 크기나 패널 내용이 바뀌면 다시 맞춘다.
 * 1100px 미만(모바일 안내 화면)에서는 아무것도 하지 않는다.
 */
(function () {
  const MIN_SCALE = 0.7; // 기준 시안과 같은 크기. 이보다 작아야 들어가는 낮은 화면에서는 패널이 스크롤된다
  const sidebar = document.querySelector(".studio-sidebar");
  const inspector = sidebar && sidebar.querySelector(".settings-inspector");
  if (!sidebar || !inspector) return;

  let frame = 0;

  /** CSS 의 --u 와 같은 식: clamp(1, min(폭/1700, 높이/820), 2.4) */
  function baseScale() {
    return Math.min(2.4, Math.max(1, Math.min(window.innerWidth / 1700, window.innerHeight / 820)));
  }

  function overflows() {
    return inspector.scrollHeight > inspector.clientHeight + 1;
  }

  function fit() {
    frame = 0;
    if (window.innerWidth < 1100) {
      sidebar.style.removeProperty("--us");
      return;
    }
    let lo = MIN_SCALE;
    let hi = Math.min(2.4, baseScale() * 1.2);
    sidebar.style.setProperty("--us", hi + "px");
    if (!overflows()) return;
    for (let i = 0; i < 8; i += 1) {
      const mid = (lo + hi) / 2;
      sidebar.style.setProperty("--us", mid + "px");
      if (overflows()) hi = mid;
      else lo = mid;
    }
    sidebar.style.setProperty("--us", lo + "px");
  }

  function schedule() {
    if (frame) return;
    frame = window.requestAnimationFrame(fit);
  }

  window.addEventListener("resize", schedule);
  window.addEventListener("pageshow", schedule);
  // 패널 안 내용이 바뀌면 다시 맞춘다. 패널 자신의 style(--us) 변경은 무시해 무한 반복을 막는다.
  new MutationObserver((records) => {
    if (records.every((r) => r.target === sidebar && r.attributeName === "style")) return;
    schedule();
  }).observe(sidebar, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["hidden", "class", "style"],
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
  schedule();
})();
