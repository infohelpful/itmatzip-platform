/**
 * 사이트 공통 모달 — 브라우저 alert 대신 사용.
 * 광고 슬롯(.editor-ad, ins.adsbygoogle, *ad-exempt*)은 블러·딤에서 제외하고,
 * 광고와 광고 사이 세로 중앙에 다이얼로그를 배치합니다.
 */

/** @type {string[]} */
export const AD_EXEMPT_SELECTORS = [
  ".editor-ad",
  ".as-ad-slot",
  "ins.adsbygoogle",
  "[class*='ad-exempt']",
  "[id^='editor-ad-']",
  "[id^='dl-ad-']",
];

const MODAL_BODY_CLASS = "itz-modal-visible";
const STYLE_ID = "itz-site-modal-styles";
const BACKDROP_ID = "itz-modal-backdrop";

/** @type {HTMLDivElement | null} */
let _backdrop = null;
/** @type {HTMLDivElement | null} */
let _alertDialog = null;
/** @type {Promise<void> | null} */
let _queue = Promise.resolve();
/** @type {(() => void) | null} */
let _resolveCurrent = null;
/** @type {((act: string) => void) | null} */
let _pendingDialogResolve = null;
/** @type {number} */
let _repositionTimer = 0;

/** @param {string} s */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** @param {string} message */
function messageToHtml(message) {
  const parts = String(message ?? "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!parts.length) return `<p class="itz-modal__msg">—</p>`;
  return parts.map((p) => `<p class="itz-modal__msg">${esc(p)}</p>`).join("");
}

export function ensureSiteModalStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  const exempt = AD_EXEMPT_SELECTORS.join(",\n    ");
  style.textContent = `
    body.${MODAL_BODY_CLASS} {
      overflow: hidden;
    }
    body.${MODAL_BODY_CLASS} ${exempt} {
      position: relative;
      z-index: 2147483646 !important;
      isolation: isolate;
      filter: none !important;
      -webkit-filter: none !important;
    }
  #${BACKDROP_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483640;
      background: rgba(6, 9, 14, 0.52);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      pointer-events: auto;
    }
    #${BACKDROP_ID}[hidden] {
      display: none !important;
    }
    .itz-modal-dialog {
      position: fixed;
      left: 50%;
      transform: translate(-50%, 0);
      z-index: 2147483645;
      width: min(520px, calc(100vw - 32px));
      max-height: min(85vh, 720px);
      overflow: hidden;
      overflow-x: hidden;
      margin: 0;
      padding: 0;
      border: none;
      border-radius: 16px;
      background: #1a1f2e;
      border: 1px solid #3a4560;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
      color: #e6edf7;
      font-family: inherit;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
    }
    .itz-modal-dialog[hidden] {
      display: none !important;
    }
    .itz-modal-dialog--wide {
      width: min(640px, calc(100vw - 32px));
    }
    .itz-modal__head {
      padding: 1.25rem 1.5rem 0.75rem;
      border-bottom: 1px solid #2d333f;
      flex-shrink: 0;
    }
    .itz-modal__title {
      margin: 0;
      font-size: 1.2rem;
      font-weight: 700;
      color: #f8fafc;
      line-height: 1.35;
    }
    .itz-modal__body {
      padding: 1rem 1.5rem 1.25rem;
      font-size: 0.95rem;
      line-height: 1.65;
      color: #b0bec5;
      overflow-x: hidden;
      overflow-y: auto;
      flex: 1 1 auto;
      min-height: 0;
      scrollbar-gutter: stable;
      scrollbar-color: #4b5563 #151820;
    }
    .itz-modal__body::-webkit-scrollbar {
      width: 10px;
    }
    .itz-modal__body::-webkit-scrollbar-thumb {
      background: #4b5563;
      border-radius: 8px;
    }
    .itz-modal__body::-webkit-scrollbar-track {
      background: #151820;
    }
    .itz-modal__steps {
      margin: 0.75rem 0 0;
      padding-left: 1.25rem;
      color: #cbd5e1;
    }
    .itz-modal__steps li {
      margin-bottom: 0.55rem;
    }
    .itz-modal__hint {
      margin: 0.85rem 0 0;
      font-size: 0.88rem;
      color: #8b9cb8;
    }
    .itz-modal__status {
      margin: 0 1.5rem 0.75rem;
      font-size: 0.9rem;
      line-height: 1.5;
      min-height: 1.25em;
      color: #94a3b8;
    }
    .itz-modal__status:empty {
      display: none;
    }
    .itz-modal__status.is-ok {
      color: #86efac;
    }
    .itz-modal__status.is-err {
      color: #fca5a5;
    }
    .itz-modal__msg {
      margin: 0 0 0.65rem;
    }
    .itz-modal__msg:last-child {
      margin-bottom: 0;
    }
    .itz-modal__foot {
      display: flex;
      gap: 0.65rem;
      justify-content: flex-end;
      padding: 0.85rem 1.5rem 1.25rem;
      border-top: 1px solid #2d333f;
      background: #151820;
      border-radius: 0 0 16px 16px;
      flex-shrink: 0;
    }
    .itz-modal__btn {
      min-width: 6.5rem;
      padding: 0.55rem 1.1rem;
      border-radius: 10px;
      font-size: 0.92rem;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      border: 1px solid #3d4554;
      background: #22262e;
      color: #94a3b8;
    }
    .itz-modal__btn:hover {
      border-color: #64748b;
      color: #e2e8f0;
    }
    .itz-modal__btn--primary {
      border: none;
      background: #6d4ce6;
      color: #fff;
    }
    .itz-modal__btn--primary:hover {
      background: #5a3dd0;
    }
    .itz-modal-dialog .itz-install {
      color: inherit;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function ensureBackdrop() {
  ensureSiteModalStyles();
  if (_backdrop) return _backdrop;
  const el = document.createElement("div");
  el.id = BACKDROP_ID;
  el.setAttribute("hidden", "");
  el.addEventListener("click", (e) => {
    if (e.target === el && _resolveCurrent) _resolveCurrent();
  });
  (document.body || document.documentElement).appendChild(el);
  _backdrop = el;
  return el;
}

/** @returns {HTMLElement[]} */
function collectAdElements() {
  const ads = [];
  for (const sel of AD_EXEMPT_SELECTORS) {
    document.querySelectorAll(sel).forEach((node) => {
      if (node instanceof HTMLElement) ads.push(node);
    });
  }
  return [...new Set(ads)];
}

/**
 * @returns {{ topEl: HTMLElement, bottomEl: HTMLElement } | null}
 */
function findPageEditorAdPair() {
  const topEl =
    document.querySelector('[id^="editor-ad-above"]') ||
    document.querySelector('[id^="dl-ad-above"]');
  const bottomEl =
    document.querySelector('[id^="editor-ad-below"]') ||
    document.querySelector('[id^="dl-ad-below"]');
  if (
    !(topEl instanceof HTMLElement) ||
    !(bottomEl instanceof HTMLElement) ||
    topEl === bottomEl
  ) {
    return null;
  }
  return { topEl, bottomEl };
}

/**
 * 상·하단 editor-ad 슬롯 사이가 뷰포트 중앙에 오도록 스크롤 (모달 표시 전 호출).
 * @returns {Promise<boolean>}
 */
export function scrollToEditorAdGapCenter() {
  const pair = findPageEditorAdPair();
  if (!pair) return Promise.resolve(false);

  const viewH = window.innerHeight || document.documentElement.clientHeight || 600;
  const topRect = pair.topEl.getBoundingClientRect();
  const bottomRect = pair.bottomEl.getBoundingClientRect();
  const gapTopDoc = topRect.bottom + window.scrollY;
  const gapBottomDoc = bottomRect.top + window.scrollY;
  if (gapBottomDoc - gapTopDoc < 80) return Promise.resolve(false);

  const gapCenterDoc = (gapTopDoc + gapBottomDoc) / 2;
  const maxScroll = Math.max(
    0,
    (document.documentElement.scrollHeight || document.body.scrollHeight || 0) - viewH,
  );
  const targetScroll = Math.min(maxScroll, Math.max(0, gapCenterDoc - viewH / 2));

  if (Math.abs(window.scrollY - targetScroll) < 6) return Promise.resolve(true);

  return new Promise((resolve) => {
    try {
      window.scrollTo({ top: targetScroll, behavior: "smooth" });
    } catch {
      window.scrollTo(0, targetScroll);
    }
    let ticks = 0;
    const done = () => resolve(true);
    const poll = () => {
      ticks += 1;
      if (Math.abs(window.scrollY - targetScroll) < 6 || ticks > 45) {
        done();
        return;
      }
      requestAnimationFrame(poll);
    };
    window.setTimeout(() => requestAnimationFrame(poll), 40);
    window.setTimeout(done, 520);
  });
}

/**
 * @param {number} viewH
 * @returns {{ top: number, bottom: number } | null}
 */
function findAdGapForModal(viewH) {
  const pair = findPageEditorAdPair();
  if (pair) {
    const pad = 12;
    const topR = pair.topEl.getBoundingClientRect();
    const bottomR = pair.bottomEl.getBoundingClientRect();
    const gapTop = topR.bottom + pad;
    const gapBottom = bottomR.top - pad;
    if (gapBottom - gapTop >= 80) {
      return { top: gapTop, bottom: gapBottom };
    }
  }
  return findViewportAdGap(viewH);
}

/**
 * 화면(뷰포트) 좌표에서 광고 사이 가장 넓은 구간 — 보이는 영역 기준
 * @param {number} viewH
 * @returns {{ top: number, bottom: number } | null}
 */
function findViewportAdGap(viewH) {
  /** @type {{ top: number, bottom: number }[]} */
  const rects = [];
  for (const ad of collectAdElements()) {
    if (ad.offsetWidth === 0 && ad.offsetHeight === 0) continue;
    const r = ad.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= viewH) continue;
    rects.push({
      top: Math.max(0, r.top),
      bottom: Math.min(viewH, r.bottom),
    });
  }
  if (!rects.length) return null;

  rects.sort((a, b) => a.top - b.top);
  const viewportMid = viewH / 2;
  const pad = 12;

  /** @type {{ top: number, bottom: number, score: number } | null} */
  let best = null;

  for (let i = 0; i < rects.length - 1; i += 1) {
    const gapTop = rects[i].bottom + pad;
    const gapBottom = rects[i + 1].top - pad;
    const gapH = gapBottom - gapTop;
    if (gapH < 100) continue;
    const mid = (gapTop + gapBottom) / 2;
    const score = gapH - Math.abs(mid - viewportMid) * 0.35;
    if (!best || score > best.score) {
      best = { top: gapTop, bottom: gapBottom, score };
    }
  }

  if (rects.length === 1) {
    const gapTop = rects[0].bottom + pad;
    const gapBottom = viewH - pad;
    if (gapBottom - gapTop >= 100) {
      return { top: gapTop, bottom: gapBottom };
    }
  }

  if (best) return { top: best.top, bottom: best.bottom };
  return null;
}

/**
 * @param {number} dlgH
 * @param {number} viewH
 * @param {{ top: number, bottom: number } | null} gap
 */
function computeDialogTopPx(dlgH, viewH, gap) {
  const margin = 16;
  const maxTop = Math.max(margin, viewH - dlgH - margin);

  let centerY;
  if (gap && gap.bottom - gap.top >= dlgH + 8) {
    centerY = (gap.top + gap.bottom) / 2;
  } else if (gap) {
    centerY = (gap.top + gap.bottom) / 2;
  } else {
    centerY = viewH / 2;
  }

  let top = centerY - dlgH / 2;
  top = Math.max(margin, Math.min(maxTop, top));
  return top;
}

/** @param {HTMLElement} dialogEl */
export function positionModalBetweenAds(dialogEl) {
  if (!dialogEl) return;

  const viewH = window.innerHeight || document.documentElement.clientHeight || 600;
  const gap = findAdGapForModal(viewH);
  const dlgH = Math.min(dialogEl.offsetHeight || 0, viewH - 32) || 320;
  const top = computeDialogTopPx(dlgH, viewH, gap);

  dialogEl.style.top = `${top}px`;
  dialogEl.style.transform = "translate(-50%, 0)";
  dialogEl.style.maxHeight = `${viewH - 32}px`;
}

function scheduleReposition(dialogEl) {
  window.clearTimeout(_repositionTimer);
  _repositionTimer = window.setTimeout(() => {
    positionModalBetweenAds(dialogEl);
  }, 50);
}

function bindModalRepositionListeners(dialogEl) {
  if (!dialogEl || dialogEl._itzModalOnResize) return;
  const onResize = () => scheduleReposition(dialogEl);
  dialogEl._itzModalOnResize = onResize;
  window.addEventListener("resize", onResize, { passive: true });
  window.addEventListener("scroll", onResize, { passive: true });
}

/**
 * @param {HTMLElement} dialogEl
 */
export function showModalShell(dialogEl) {
  const backdrop = ensureBackdrop();

  const revealAndPlace = () => {
    document.body?.classList.add(MODAL_BODY_CLASS);
    backdrop.removeAttribute("hidden");
    dialogEl.removeAttribute("hidden");
    const place = () => positionModalBetweenAds(dialogEl);
    place();
    requestAnimationFrame(() => {
      place();
      requestAnimationFrame(place);
    });
    window.setTimeout(place, 120);
    window.setTimeout(place, 480);
    bindModalRepositionListeners(dialogEl);
  };

  void scrollToEditorAdGapCenter().then(revealAndPlace);
}

/**
 * @param {HTMLElement} dialogEl
 */
export function hideModalShell(dialogEl) {
  if (dialogEl?._itzModalOnResize) {
    window.removeEventListener("resize", dialogEl._itzModalOnResize);
    window.removeEventListener("scroll", dialogEl._itzModalOnResize);
    delete dialogEl._itzModalOnResize;
  }
  dialogEl?.setAttribute("hidden", "");
  if (_alertDialog === dialogEl) {
    _alertDialog = null;
  }
  const anyVisible = document.querySelector(".itz-modal-dialog:not([hidden])");
  if (!anyVisible) {
    _backdrop?.setAttribute("hidden", "");
    document.body?.classList.remove(MODAL_BODY_CLASS);
  }
}

/**
 * @typedef {{
 *   title?: string,
 *   bodyHtml?: string,
 *   message?: string,
 *   wide?: boolean,
 *   buttons?: Array<{ label: string, primary?: boolean, act?: string }>,
 *   persistent?: boolean,
 *   dialogKind?: "ad-block" | "agent-block" | string,
 * }} SiteDialogOptions
 */

export function getActiveSiteDialogKind() {
  if (!_alertDialog || _alertDialog.hasAttribute("hidden")) return null;
  return _alertDialog.dataset.dialogKind || null;
}

export function isAgentBlockDialogOpen() {
  return getActiveSiteDialogKind() === "agent-block";
}

export function isAdBlockDialogOpen() {
  return getActiveSiteDialogKind() === "ad-block";
}

export function isPersistentSiteModalOpen() {
  return Boolean(
    _alertDialog &&
      !_alertDialog.hasAttribute("hidden") &&
      _alertDialog.dataset.persistent === "1",
  );
}

/**
 * @param {string} text
 * @param {"ok" | "err" | ""} [kind]
 */
export function setSiteDialogStatus(text, kind = "") {
  const el = _alertDialog?.querySelector("[data-modal-status]");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("is-ok", "is-err");
  if (kind === "ok") el.classList.add("is-ok");
  if (kind === "err") el.classList.add("is-err");
}

/**
 * @param {SiteDialogOptions} options
 * @returns {Promise<string | void>}
 */
export function showSiteDialog(options) {
  const run = () =>
    new Promise((resolve) => {
      ensureSiteModalStyles();
      let dlg = _alertDialog;
      if (!dlg) {
        dlg = document.createElement("div");
        dlg.className = "itz-modal-dialog";
        dlg.id = "itz-site-alert-dialog";
        dlg.setAttribute("hidden", "");
        (document.body || document.documentElement).appendChild(dlg);
        _alertDialog = dlg;
      }

      if (
        options.persistent &&
        dlg &&
        !dlg.hasAttribute("hidden") &&
        dlg.dataset.persistent === "1"
      ) {
        setSiteDialogStatus("");
        scheduleReposition(dlg);
        return;
      }

      const title = options.title ?? "안내";
      const body = options.bodyHtml ?? messageToHtml(options.message ?? "");
      const buttons = options.buttons?.length
        ? options.buttons
        : [{ label: "확인", primary: true, act: "ok" }];
      const persistent = Boolean(options.persistent);

      dlg.classList.toggle("itz-modal-dialog--wide", Boolean(options.wide));
      if (persistent) {
        dlg.dataset.persistent = "1";
      } else {
        delete dlg.dataset.persistent;
      }
      if (options.dialogKind) {
        dlg.dataset.dialogKind = options.dialogKind;
      } else {
        delete dlg.dataset.dialogKind;
      }

      const footHtml = buttons
        .map(
          (b) =>
            `<button type="button" class="itz-modal__btn${b.primary ? " itz-modal__btn--primary" : ""}" data-act="${esc(b.act ?? b.label)}">${esc(b.label)}</button>`,
        )
        .join("");

      const statusRow = persistent
        ? '<p class="itz-modal__status" data-modal-status aria-live="polite"></p>'
        : "";

      dlg.innerHTML = `
        <div class="itz-modal__head">
          <h2 class="itz-modal__title">${esc(title)}</h2>
        </div>
        <div class="itz-modal__body">${body}</div>
        ${statusRow}
        <footer class="itz-modal__foot">${footHtml}</footer>
      `;

      const finish = (act) => {
        _resolveCurrent = null;
        _pendingDialogResolve = null;
        delete dlg.dataset.persistent;
        delete dlg.dataset.dialogKind;
        hideModalShell(dlg);
        resolve(act);
      };

      _pendingDialogResolve = finish;
      _resolveCurrent = persistent ? null : () => finish("dismiss");

      dlg.onclick = (ev) => {
        const t = ev.target;
        if (!(t instanceof HTMLElement)) return;
        const btn = t.closest("button[data-act]");
        if (!btn || !dlg.contains(btn)) return;
        ev.preventDefault();
        finish(btn.getAttribute("data-act") || "ok");
      };

      showModalShell(dlg);
    });

  _queue = _queue.then(run, run);
  return _queue;
}

/**
 * @param {string} message
 * @param {string} [title]
 * @returns {Promise<void>}
 */
export function showSiteAlert(message, title) {
  return showSiteDialog({ title: title ?? "안내", message }).then(() => {});
}

/** @param {typeof window.alert} native */
export function installSiteAlertOverride(native) {
  if (typeof window === "undefined") return;
  if (window.__itzAlertOverrideInstalled) return;
  window.__itzAlertOverrideInstalled = true;
  const prev = native ?? window.alert.bind(window);
  window.__itzNativeAlert = prev;
  window.alert = function itzAlertOverride(msg) {
    void showSiteAlert(String(msg ?? ""));
  };
}

export function dismissActiveSiteModal() {
  _resolveCurrent = null;
  if (_pendingDialogResolve) {
    const finish = _pendingDialogResolve;
    _pendingDialogResolve = null;
    finish("auto");
    return;
  }
  if (_alertDialog && !_alertDialog.hasAttribute("hidden")) {
    delete _alertDialog.dataset.persistent;
    delete _alertDialog.dataset.dialogKind;
    hideModalShell(_alertDialog);
  }
}

export function installGlobals() {
  installSiteAlertOverride(
    typeof window.__itzNativeAlert === "function" ? window.__itzNativeAlert : undefined,
  );
  if (typeof window !== "undefined") {
    window.ItzSiteModal = {
      showSiteAlert,
      showSiteDialog,
      showModalShell,
      hideModalShell,
      dismissActiveSiteModal,
      isPersistentSiteModalOpen,
      isAgentBlockDialogOpen,
      isAdBlockDialogOpen,
      getActiveSiteDialogKind,
      setSiteDialogStatus,
  positionModalBetweenAds,
  scrollToEditorAdGapCenter,
  ensureSiteModalStyles,
      AD_EXEMPT_SELECTORS,
      MODAL_BODY_CLASS,
    };
  }
}
