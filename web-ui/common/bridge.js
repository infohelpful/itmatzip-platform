/**
 * 로컬 에이전트와 통신하는 공통 브리지.
 * - 연결 상태 확인
 * - 미연결 시 설치 안내 다이얼로그
 * - 작업 요청 + 진행률(폴링·동기 완료 모두 지원)
 *
 * 사용 예 (type="module"):
 *   import * as Bridge from '../common/bridge.js';
 *   Bridge.configureBridge({ origin: 'http://localhost:8000' });
 *   Bridge.startConnectionMonitor({ onChange: (ok) => { ... } });
 */

/** @typedef {{ progress: number | null, phase: string, message?: string, raw?: unknown }} ProgressEvent */

/** @type {string} */
let _origin = "http://localhost:8000";

/** @type {string} */
let _healthPath = "/health";

/** @type {(id: string) => string} */
let _jobStatusUrl = (id) => `/api/jobs/${encodeURIComponent(id)}/status`;

/** @type {number} */
let _jobPollMs = 400;

/** @type {number} */
let _connectTimeoutMs = 8000;

/** @type {string[]} */
const _originFallbacks = ["http://127.0.0.1:8000", "http://localhost:8000"];

/**
 * @returns {string}
 */
function defaultAgentOriginForPage() {
  if (typeof window === "undefined") return _originFallbacks[0];
  const h = window.location.hostname;
  if (h === "localhost") return "http://localhost:8000";
  if (h === "127.0.0.1" || h === "[::1]") return "http://127.0.0.1:8000";
  return _originFallbacks[0];
}

/** @type {HTMLDialogElement | null} */
let _installDialog = null;

/** @type {(() => void) | null} */
let _installPendingResolve = null;

/**
 * @typedef {{
 *   origin?: string,
 *   healthPath?: string,
 *   jobStatusUrl?: (jobId: string) => string,
 *   jobPollIntervalMs?: number,
 *   connectTimeoutMs?: number,
 * }} BridgeConfig
 * @param {BridgeConfig} [cfg]
 */
export function configureBridge(cfg = {}) {
  if (cfg.origin != null) {
    _origin = cfg.origin.replace(/\/+$/, "");
  } else if (typeof window !== "undefined") {
    _origin = defaultAgentOriginForPage();
  }
  if (cfg.healthPath != null) _healthPath = cfg.healthPath.startsWith("/") ? cfg.healthPath : `/${cfg.healthPath}`;
  if (typeof cfg.jobStatusUrl === "function") _jobStatusUrl = cfg.jobStatusUrl;
  if (cfg.jobPollIntervalMs != null) _jobPollMs = Math.max(100, cfg.jobPollIntervalMs);
  if (cfg.connectTimeoutMs != null) _connectTimeoutMs = Math.max(200, cfg.connectTimeoutMs);
}

export function getAgentOrigin() {
  return _origin;
}

/**
 * @param {string} origin 예: http://localhost:8000
 */
export function setAgentOrigin(origin) {
  _origin = origin.replace(/\/+$/, "");
}

/**
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ ok: boolean, status?: number, latencyMs?: number, error?: string }>}
 */
/**
 * @param {string} origin
 * @param {AbortSignal | undefined} signal
 */
async function pingAgentOrigin(origin, signal) {
  const url = `${origin.replace(/\/+$/, "")}${_healthPath}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), _connectTimeoutMs);
  const merged = mergeSignals(signal, ctrl.signal);
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      signal: merged,
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) {
      return { ok: false, status: res.status, latencyMs, error: `HTTP ${res.status}`, origin };
    }
    return { ok: true, status: res.status, latencyMs, origin };
  } catch (e) {
    const latencyMs = Math.round(performance.now() - started);
    const err = e instanceof Error ? e.message : String(e);
    return { ok: false, latencyMs, error: err, origin };
  } finally {
    clearTimeout(t);
  }
}

export async function checkAgentConnection(signal) {
  const candidates = [...new Set([_origin, ..._originFallbacks])];
  /** @type {{ ok: boolean, status?: number, latencyMs?: number, error?: string } | null} */
  let lastFail = null;

  for (const origin of candidates) {
    const detail = await pingAgentOrigin(origin, signal);
    if (detail.ok) {
      _origin = origin.replace(/\/+$/, "");
      return { ok: true, status: detail.status, latencyMs: detail.latencyMs };
    }
    lastFail = {
      ok: false,
      status: detail.status,
      latencyMs: detail.latencyMs,
      error: detail.error,
    };
  }

  return (
    lastFail ?? {
      ok: false,
      error: "에이전트에 연결할 수 없습니다.",
    }
  );
}

/**
 * @typedef {{
 *   intervalMs?: number,
 *   immediate?: boolean,
 *   onChange?: (ok: boolean, detail: { ok: boolean, status?: number, latencyMs?: number, error?: string }) => void,
 *   onDisconnected?: (detail: { ok: boolean, error?: string }) => void,
 *   autoShowInstallDialog?: boolean,
 *   installDialogOptions?: InstallDialogOptions,
 * }} MonitorOptions
 * @param {MonitorOptions} opts
 * @returns {{ stop: () => void, refresh: () => Promise<void> }}
 */
export function startConnectionMonitor(opts = {}) {
  const intervalMs = opts.intervalMs ?? 5000;
  let stopped = false;
  let lastOk = /** @type {boolean | null} */ (null);
  let firstTick = true;

  async function tick() {
    const detail = await checkAgentConnection();
    if (stopped) return;
    const changed = lastOk !== detail.ok;
    if (firstTick || changed) {
      const wasFirstCheck = lastOk === null;
      if (firstTick) firstTick = false;
      const wasConnected = lastOk === true;
      lastOk = detail.ok;
      opts.onChange?.(detail.ok, detail);
      if (!detail.ok) {
        opts.onDisconnected?.(detail);
        if (opts.autoShowInstallDialog && (wasFirstCheck || wasConnected)) {
          showInstallAgentDialog(opts.installDialogOptions);
        }
      }
    }
  }

  let id = 0;
  if (opts.immediate !== false) void tick();
  id = globalThis.setInterval(() => void tick(), intervalMs);

  return {
    stop() {
      stopped = true;
      globalThis.clearInterval(id);
    },
    refresh: tick,
  };
}

/**
 * @typedef {{
 *   title?: string,
 *   bodyHtml?: string,
 *   downloadHref?: string,
 *   downloadLabel?: string,
 *   primaryLabel?: string,
 *   onPrimary?: () => void | Promise<void>,
 *   onShown?: () => void,
 * }} InstallDialogOptions
 * @param {InstallDialogOptions} [options]
 * @returns {Promise<void>} 닫힐 때 resolve
 */
export function showInstallAgentDialog(options = {}) {
  if (_installPendingResolve) {
    const finish = _installPendingResolve;
    _installPendingResolve = null;
    finish();
  }
  if (_installDialog?.open) _installDialog.close();

  ensureInstallDialog();
  const dlg = /** @type {HTMLDialogElement} */ (_installDialog);
  const title = options.title ?? "로컬 에이전트에 연결할 수 없습니다";
  const body =
    options.bodyHtml ??
    `<p style="margin:0">PC에서 ItMatZip 로컬 에이전트를 실행한 뒤 다시 연결해 주세요.</p>`;

  dlg.innerHTML = `
    <div class="itz-install">
      <header class="itz-install__head">
        <h2 class="itz-install__title">${escapeHtml(title)}</h2>
      </header>
      <div class="itz-install__body">${body}</div>
      <footer class="itz-install__foot">
        <button type="button" class="itz-install__btn itz-install__btn--ghost" data-act="close">닫기</button>
        <button type="button" class="itz-install__btn itz-install__btn--primary" data-act="retry">${escapeHtml(
          options.primaryLabel ?? "다시 연결 확인"
        )}</button>
      </footer>
    </div>
  `;

  return new Promise((resolve) => {
    _installPendingResolve = resolve;

    /** @param {Event} ev */
    function onClick(ev) {
      const t = /** @type {HTMLElement} */ (ev.target);
      const act = t.closest("button")?.getAttribute("data-act");
      if (act === "close") {
        dlg.close();
      }
      if (act === "retry") {
        void Promise.resolve(options.onPrimary?.()).finally(() => dlg.close());
      }
    }
    dlg.addEventListener("click", onClick);
    dlg.addEventListener(
      "close",
      () => {
        dlg.removeEventListener("click", onClick);
        if (_installPendingResolve === resolve) {
          _installPendingResolve = null;
        }
        resolve();
      },
      { once: true }
    );
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    requestAnimationFrame(() => {
      options.onShown?.();
    });
  });
}

export function dismissInstallAgentDialog() {
  if (_installDialog?.open) _installDialog.close();
}

/**
 * @typedef {{
 *   method?: string,
 *   path: string,
 *   json?: unknown,
 *   headers?: Record<string, string>,
 *   signal?: AbortSignal,
 *   onProgress?: (e: ProgressEvent) => void,
 * }} AgentRequestOptions
 * @param {AgentRequestOptions} opts
 * @returns {Promise<unknown>} JSON 본문(에이전트가 JSON이 아닌 경우 그대로 text로 파싱 시도)
 */
export async function requestAgent(opts) {
  const method = (opts.method ?? "GET").toUpperCase();
  const url = `${_origin}${opts.path.startsWith("/") ? opts.path : `/${opts.path}`}`;
  /** @type {(e: ProgressEvent) => void} */
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};

  onProgress({ progress: 0, phase: "request", message: "에이전트에 요청 전송" });

  const init = /** @type {RequestInit} */ ({
    method,
    headers: { Accept: "application/json", ...opts.headers },
    cache: "no-store",
    signal: opts.signal,
  });
  if (opts.json !== undefined && method !== "GET" && method !== "HEAD") {
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.json);
  }

  const res = await fetch(url, init);

  if (res.status === 202) {
    const body = await safeJson(res);
    const jobId = body && typeof body === "object" ? /** @type {any} */ (body).job_id ?? /** @type {any} */ (body).jobId : null;
    if (!jobId || typeof jobId !== "string") {
      onProgress({ progress: null, phase: "accepted", message: "202 응답이나 job_id 없음", raw: body });
      return body;
    }
    onProgress({ progress: 5, phase: "queued", message: "작업 큐 등록", raw: body });
    return pollJobUntilDone(jobId, onProgress, opts.signal);
  }

  const data = await safeJson(res);
  if (!res.ok) {
    onProgress({ progress: null, phase: "error", message: `HTTP ${res.status}`, raw: data });
    const msg =
      data && typeof data === "object" && "detail" in /** @type {any} */ (data)
        ? String(/** @type {any} */ (data).detail)
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }

  onProgress({ progress: 100, phase: "done", message: "완료", raw: data });
  return data;
}

/**
 * @param {string} jobId
 * @param {(e: ProgressEvent) => void} onProgress
 * @param {AbortSignal} [outer]
 */
async function pollJobUntilDone(jobId, onProgress, outer) {
  const statusUrl = `${_origin}${_jobStatusUrl(jobId)}`;
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  while (true) {
    if (Date.now() > deadline) {
      onProgress({ progress: null, phase: "timeout", message: "작업 상태 폴링 시간 초과(2시간)" });
      throw new Error("작업 상태 폴링 시간 초과");
    }
    if (outer?.aborted) throw new DOMException("Aborted", "AbortError");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), _connectTimeoutMs);
    let res;
    try {
      res = await fetch(statusUrl, {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: mergeSignals(outer, ctrl.signal),
      });
    } finally {
      clearTimeout(t);
    }

    const body = await safeJson(res);
    if (!res.ok) {
      onProgress({ progress: null, phase: "error", message: `상태 조회 실패 HTTP ${res.status}`, raw: body });
      throw new Error(`작업 상태 조회 실패: HTTP ${res.status}`);
    }

    const st = body && typeof body === "object" ? /** @type {any} */ (body).status : null;
    const progressRaw = body && typeof body === "object" ? /** @type {any} */ (body).progress : null;
    const progress =
      typeof progressRaw === "number" && Number.isFinite(progressRaw)
        ? clamp(progressRaw, 0, 100)
        : null;

    onProgress({
      progress,
      phase: typeof st === "string" ? st : "running",
      message: typeof /** @type {any} */ (body)?.message === "string" ? /** @type {any} */ (body).message : undefined,
      raw: body,
    });

    if (st === "completed" || st === "done" || st === "success") {
      const result = /** @type {any} */ (body)?.result ?? body;
      onProgress({ progress: 100, phase: "done", message: "완료", raw: body });
      return result;
    }
    if (st === "failed" || st === "error") {
      const err = /** @type {any} */ (body)?.error ?? /** @type {any} */ (body)?.detail ?? "작업 실패";
      onProgress({ progress, phase: "failed", message: String(err), raw: body });
      throw new Error(String(err));
    }

    await delay(_jobPollMs, outer);
  }
}

function ensureInstallDialogStyles() {
  if (document.getElementById("itmatzip-bridge-install-dialog-styles")) return;
  const style = document.createElement("style");
  style.id = "itmatzip-bridge-install-dialog-styles";
  style.textContent = `
    #itmatzip-bridge-install-dialog {
      border: 1px solid #2d333f;
      border-radius: 16px;
      padding: 0;
      width: 820px;
      max-width: 820px;
      box-shadow: 0 28px 80px rgba(0, 0, 0, 0.55);
      background: #1a1d23;
      color: #e2e8f0;
    }
    #itmatzip-bridge-install-dialog::backdrop {
      background: rgba(0, 0, 0, 0.72);
    }
    .itz-install {
      font-family: "Pretendard", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #e2e8f0;
      line-height: 1.65;
    }
    .itz-install__head {
      padding: 1.35rem 2rem 1.1rem;
      border-bottom: 1px solid #2d333f;
      background: #151820;
    }
    .itz-install__title {
      margin: 0;
      font-size: 1.35rem;
      font-weight: 700;
      line-height: 1.35;
      color: #f1f5f9;
      letter-spacing: -0.02em;
    }
    .itz-install__body {
      padding: 1.35rem 2rem 1.5rem;
      font-size: 0.95rem;
      color: #94a3b8;
    }
    .itz-install__intro p {
      margin: 0 0 0.85rem;
      line-height: 1.8;
      font-size: 0.95rem;
    }
    .itz-install__intro p:last-child {
      margin-bottom: 0;
    }
    .itz-install__intro strong {
      color: #e2e8f0;
      font-weight: 600;
    }
    .itz-install__cards {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      margin-top: 1.35rem;
    }
    .itz-install__body section {
      display: block;
      margin: 0;
      padding: 1.15rem 1.35rem;
      border-radius: 14px;
      border: 1px solid #2d333f;
    }
    .itz-install__card--new {
      background: linear-gradient(165deg, rgba(59, 130, 246, 0.14) 0%, rgba(30, 41, 59, 0.5) 100%);
      border-color: rgba(59, 130, 246, 0.45);
    }
    .itz-install__card--installed {
      background: #22262e;
      border-color: #3d4554;
    }
    .itz-install__card-title {
      margin: 0 0 0.45rem;
      font-size: 1rem;
      font-weight: 700;
      color: #f8fafc;
      line-height: 1.4;
    }
    .itz-install__card--new .itz-install__card-title {
      color: #93c5fd;
    }
    .itz-install__card--installed .itz-install__card-title {
      color: #cbd5e1;
    }
    .itz-install__card-text {
      margin: 0;
      font-size: 0.92rem;
      line-height: 1.7;
      color: #94a3b8;
    }
    .itz-install__card-text strong {
      color: #e2e8f0;
    }
    .itz-install__card-note {
      margin-top: 0.65rem;
      font-size: 0.88rem;
    }
    .itz-install__card-text code {
      font-size: 0.85em;
      padding: 0.1em 0.35em;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.35);
      color: #93c5fd;
    }
    .itz-install__ad-slot {
      box-sizing: border-box;
      width: 100%;
      min-height: 110px;
      margin-top: 1rem;
      padding: 0.5rem;
      border-radius: 10px;
      border: 1px dashed #3d4554;
      background: #0f1115;
      overflow: hidden;
    }
    .itz-install__ad-slot:empty::after {
      content: "";
      display: block;
      min-height: 100px;
    }
    .itz-install__download-btn {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      margin-top: 1rem;
      padding: 0.9rem 1.5rem;
      border: none;
      border-radius: 12px;
      background: linear-gradient(180deg, #3b82f6 0%, #2563eb 100%);
      color: #fff !important;
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: -0.01em;
      text-decoration: none;
      cursor: pointer;
      box-shadow: 0 6px 20px rgba(37, 99, 235, 0.45);
      transition: background 0.15s ease, box-shadow 0.15s ease, transform 0.12s ease;
    }
    .itz-install__download-btn:hover {
      background: linear-gradient(180deg, #60a5fa 0%, #3b82f6 100%);
      box-shadow: 0 8px 24px rgba(59, 130, 246, 0.5);
      transform: translateY(-1px);
    }
    .itz-install__download-btn:active {
      transform: translateY(0);
    }
    .itz-install__foot {
      display: flex;
      gap: 0.65rem;
      justify-content: flex-end;
      padding: 1rem 2rem 1.4rem;
      border-top: 1px solid #2d333f;
      background: #151820;
    }
    .itz-install__btn {
      min-width: 7rem;
      padding: 0.6rem 1.15rem;
      border-radius: 10px;
      font-size: 0.92rem;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    .itz-install__btn--ghost {
      border: 1px solid #3d4554;
      background: #22262e;
      color: #94a3b8;
    }
    .itz-install__btn--ghost:hover {
      border-color: #64748b;
      color: #e2e8f0;
    }
    .itz-install__btn--primary {
      border: none;
      background: #3b82f6;
      color: #fff;
    }
    .itz-install__btn--primary:hover {
      background: #60a5fa;
    }
  `;
  (document.head ?? document.documentElement).appendChild(style);
}

function ensureInstallDialog() {
  ensureInstallDialogStyles();
  if (_installDialog) return;
  const dlg = document.createElement("dialog");
  dlg.id = "itmatzip-bridge-install-dialog";
  const root = document.body ?? document.documentElement;
  root.appendChild(dlg);
  _installDialog = dlg;
}

/**
 * @param {AbortSignal} [a]
 * @param {AbortSignal} [b]
 */
function mergeSignals(a, b) {
  if (!a) return b;
  if (!b) return a;
  const c = new AbortController();
  const onAbort = () => c.abort(a.aborted ? a.reason : b.reason);
  if (a.aborted || b.aborted) {
    onAbort();
    return c.signal;
  }
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return c.signal;
}

/** @param {Response} res */
async function safeJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * @param {number} ms
 * @param {AbortSignal} [sig]
 */
function delay(ms, sig) {
  return new Promise((resolve, reject) => {
    const id = globalThis.setTimeout(resolve, ms);
    if (!sig) return;
    if (sig.aborted) {
      globalThis.clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    sig.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(id);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

const Bridge = {
  configureBridge,
  getAgentOrigin,
  setAgentOrigin,
  checkAgentConnection,
  startConnectionMonitor,
  showInstallAgentDialog,
  dismissInstallAgentDialog,
  requestAgent,
};

const g = typeof globalThis !== "undefined" ? globalThis : window;
// @ts-ignore 레거시 스크립트에서 전역으로 접근
g.ItMatZipBridge = Bridge;

export default Bridge;
