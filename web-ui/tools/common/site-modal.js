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
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483645;
      width: min(520px, calc(100vw - 32px));
      max-height: min(85vh, 720px);
      overflow: auto;
      margin: 0;
      padding: 0;
      border: none;
      border-radius: 16px;
      background: #1a1f2e;
      border: 1px solid #3a4560;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
      color: #e6edf7;
      font-family: inherit;
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

/** @param {HTMLElement} el */
function getAbsoluteTop(el) {
  let top = 0;
  let current = el;
  while (current) {
    top += current.offsetTop || 0;
    current = current.offsetParent;
  }
  return top;
}

/** @param {HTMLElement} dialogEl */
export function positionModalBetweenAds(dialogEl) {
  if (!dialogEl) return;

  const ads = [];
  for (const sel of AD_EXEMPT_SELECTORS) {
    document.querySelectorAll(sel).forEach((node) => {
      if (node instanceof HTMLElement) ads.push(node);
    });
  }
  const unique = [...new Set(ads)];

  /** @type {{ top: number, bottom: number }[]} */
  const adRects = [];
  for (const ad of unique) {
    if (ad.offsetWidth === 0 && ad.offsetHeight === 0) continue;
    const absTop = getAbsoluteTop(ad);
    adRects.push({ top: absTop, bottom: absTop + ad.offsetHeight });
  }

  const scrollY = window.scrollY || 0;
  const viewH = window.innerHeight || 600;

  if (!adRects.length) {
    dialogEl.style.top = `${scrollY + viewH / 2}px`;
    dialogEl.style.transform = "translate(-50%, -50%)";
    return;
  }

  adRects.sort((a, b) => a.top - b.top);
  const topAd = adRects[0];
  const bottomAd = adRects[adRects.length - 1];

  let firstAdBottom;
  let lastAdTop;
  if (adRects.length === 1) {
    firstAdBottom = topAd.bottom;
    lastAdTop = document.documentElement.scrollHeight;
  } else if (bottomAd.top >= topAd.bottom) {
    firstAdBottom = topAd.bottom;
    lastAdTop = bottomAd.top;
  } else {
    const maxBottom = Math.max(...adRects.map((r) => r.bottom));
    firstAdBottom = maxBottom;
    lastAdTop = document.documentElement.scrollHeight;
  }

  const gapCenter = firstAdBottom + (lastAdTop - firstAdBottom) / 2;
  const dlgH = dialogEl.offsetHeight || 400;
  const top = Math.max(firstAdBottom + 12, gapCenter - dlgH / 2);
  dialogEl.style.top = `${top}px`;
  dialogEl.style.transform = "translateX(-50%)";
}

function scheduleReposition(dialogEl) {
  window.clearTimeout(_repositionTimer);
  _repositionTimer = window.setTimeout(() => {
    positionModalBetweenAds(dialogEl);
  }, 50);
}

/**
 * @param {HTMLElement} dialogEl
 */
export function showModalShell(dialogEl) {
  const backdrop = ensureBackdrop();
  document.body?.classList.add(MODAL_BODY_CLASS);
  backdrop.removeAttribute("hidden");
  dialogEl.removeAttribute("hidden");
  requestAnimationFrame(() => {
    positionModalBetweenAds(dialogEl);
    dialogEl.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    dialogEl.focus?.();
  });
  if (!dialogEl._itzModalOnResize) {
    const onResize = () => scheduleReposition(dialogEl);
    dialogEl._itzModalOnResize = onResize;
    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("scroll", onResize, { passive: true });
  }
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
 * }} SiteDialogOptions
 */

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

      const title = options.title ?? "안내";
      const body = options.bodyHtml ?? messageToHtml(options.message ?? "");
      const buttons = options.buttons?.length
        ? options.buttons
        : [{ label: "확인", primary: true, act: "ok" }];

      dlg.classList.toggle("itz-modal-dialog--wide", Boolean(options.wide));

      const footHtml = buttons
        .map(
          (b) =>
            `<button type="button" class="itz-modal__btn${b.primary ? " itz-modal__btn--primary" : ""}" data-act="${esc(b.act ?? b.label)}">${esc(b.label)}</button>`,
        )
        .join("");

      dlg.innerHTML = `
        <div class="itz-modal__head">
          <h2 class="itz-modal__title">${esc(title)}</h2>
        </div>
        <div class="itz-modal__body">${body}</div>
        <footer class="itz-modal__foot">${footHtml}</footer>
      `;

      const finish = (act) => {
        _resolveCurrent = null;
        hideModalShell(dlg);
        resolve(act);
      };
      _resolveCurrent = () => finish("dismiss");

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
  if (_resolveCurrent) {
    const finish = _resolveCurrent;
    _resolveCurrent = null;
    finish();
  } else if (_alertDialog && !_alertDialog.hasAttribute("hidden")) {
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
      positionModalBetweenAds,
      ensureSiteModalStyles,
      AD_EXEMPT_SELECTORS,
      MODAL_BODY_CLASS,
    };
  }
}
