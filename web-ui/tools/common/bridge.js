/**
 * 로컬 에이전트와 통신하는 공통 브리지.
 * - 연결 상태 확인
 * - 미연결 시 설치 안내 다이얼로그
 * - 작업 요청 + 진행률(폴링·동기 완료 모두 지원)
 *
 * 사용 예 (type="module"):
 *   import * as Bridge from '../common/bridge.js';
 *   Bridge.configureBridge({ origin: 'http://localhost:19876' });
 *   Bridge.startConnectionMonitor({ onChange: (ok) => { ... } });
 */

import { AGENT_ORIGIN_FALLBACKS, AGENT_PORT, agentWebSocketUrl } from "./agent-endpoints.js";

/** @typedef {{ progress: number | null, phase: string, message?: string, raw?: unknown }} ProgressEvent */

/** @type {string} */
let _origin = AGENT_ORIGIN_FALLBACKS[1];

/** @type {string} */
let _healthPath = "/health";

/** @type {(id: string) => string} */
let _jobStatusUrl = (id) => `/api/jobs/${encodeURIComponent(id)}/status`;

/** @type {number} */
let _jobPollMs = 400;

/** @type {number} */
let _wsReconnectMs = 2000;

/** @type {number} */
let _connectTimeoutMs = 8000;

/** @type {number} */
let _agentLongOpDepth = 0;

/** @param {boolean} active */
export function setAgentLongOperationActive(active) {
  if (active) {
    _agentLongOpDepth += 1;
  } else {
    _agentLongOpDepth = Math.max(0, _agentLongOpDepth - 1);
  }
}

export function isAgentLongOperationActive() {
  return _agentLongOpDepth > 0;
}

/** @type {"CLOSED" | "OPEN" | "HALF_OPEN"} */
let _circuitState = "CLOSED";
let _circuitFailCount = 0;
let _circuitOpenUntil = 0;

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_LONG_OP_THRESHOLD = 15;
const CIRCUIT_COOLDOWN_MS = 10_000;
const POLL_FAIL_STREAK_MAX = 15;
/** 연속 실패 이 횟수 이상일 때만 UI·팝업에 ‘끊김’ 반영 (일시적 타임아웃 무시) */
const MONITOR_DISCONNECT_UI_STREAK = 2;
const MONITOR_DISCONNECT_DIALOG_STREAK = 3;
const INSTALL_DIALOG_SUPPRESS_MS = 5 * 60 * 1000;

function circuitThreshold() {
  return isAgentLongOperationActive() ? CIRCUIT_LONG_OP_THRESHOLD : CIRCUIT_THRESHOLD;
}

/** @returns {{ state: string, failCount: number }} */
export function getAgentCircuitBreakerState() {
  return { state: _circuitState, failCount: _circuitFailCount };
}

/** @param {number} [status] */
function isTransientHttpStatus(status) {
  return status === 502 || status === 503 || status === 504 || status === 429;
}

/** @param {unknown} [err] @param {number} [status] */
function isTransientAgentError(err, status) {
  if (typeof status === "number" && isTransientHttpStatus(status)) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /Failed to fetch|NetworkError|ERR_FAILED|Load failed|timeout|abort|unavailable|준비|sidecar|502|503|504/i.test(
    msg,
  );
}

function assertCircuitAllowsRequest() {
  if (_circuitState === "OPEN") {
    if (Date.now() >= _circuitOpenUntil) {
      _circuitState = "HALF_OPEN";
    } else {
      throw new Error(
        "에이전트 통신이 불안정하여 일시적으로 연결이 차단되었습니다. 잠시 후 다시 시도하세요.",
      );
    }
  }
}

function recordCircuitSuccess() {
  if (_circuitState !== "CLOSED") {
    _circuitState = "CLOSED";
  }
  _circuitFailCount = 0;
}

function recordCircuitFailure() {
  _circuitFailCount += 1;
  if (_circuitFailCount >= circuitThreshold()) {
    _circuitState = "OPEN";
    _circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    _circuitFailCount = 0;
  }
}

/** @param {number} streak */
function pollBackoffMs(streak) {
  return Math.min(30_000, _jobPollMs * 2 ** Math.min(streak, 6));
}

/** @type {WebSocket | null} */
let _ws = null;

/** @type {number} */
let _wsReconnectTimer = 0;

/** @type {boolean} */
let _wsManualClose = false;

/** @type {Set<(event: Record<string, unknown>) => void>} */
const _wsListeners = new Set();

/** @type {((connected: boolean) => void) | null} */
let _wsConnectionListener = null;

/**
 * @typedef {{
 *   reconnectMs?: number,
 *   onConnectionChange?: (connected: boolean) => void,
 * }} AgentWebSocketOptions
 */

/**
 * Go/Python agent WebSocket 이벤트를 FastAPI prepare status 형태로 변환
 * @param {Record<string, unknown>} event
 * @returns {{ phase: string, progress?: number, message?: string, step?: string, detail?: string } | null}
 */
export function mapAgentEventToPrepareStatus(event) {
  if (!event || typeof event !== "object") return null;
  const type = String(event.type || "");
  const status = String(event.status || "");
  const progress =
    typeof event.progress === "number" && Number.isFinite(event.progress) ? event.progress : undefined;
  const message = typeof event.message === "string" ? event.message : "";
  const modelId = typeof event.model_id === "string" ? event.model_id : "";

  if (type === "download") {
    if (status === "completed") {
      return { phase: "ready", progress: 100, message: message || "Download complete", step: modelId };
    }
    if (status === "failed") {
      return { phase: "failed", progress: progress ?? 0, message: message || "Download failed", step: modelId };
    }
    return {
      phase: "downloading_models",
      progress,
      message: message || "Downloading model…",
      step: modelId ? `model: ${modelId}` : "download",
    };
  }

  if (type === "install") {
    if (status === "completed") {
      return { phase: "ready", progress: 100, message: message || "Install complete" };
    }
    if (status === "failed") {
      return { phase: "failed", message: message || "Install failed" };
    }
    return { phase: "installing_dependencies", progress: progress ?? 0, message: message || "Installing…" };
  }

  if (type === "install_progress") {
    if (status === "installed") {
      return { phase: "ready", progress: 100, message: message || "Model ready", step: modelId };
    }
    if (status === "failed") {
      return { phase: "failed", message: message || "Install failed", step: modelId };
    }
    return {
      phase: "downloading_models",
      progress,
      message: message || "Installing model…",
      step: modelId,
    };
  }

  return null;
}

/**
 * @param {Record<string, unknown>} event
 * @returns {ProgressEvent | null}
 */
export function mapAgentEventToProgress(event) {
  const prepare = mapAgentEventToPrepareStatus(event);
  if (prepare) {
    return {
      progress: typeof prepare.progress === "number" ? prepare.progress : null,
      phase: prepare.phase,
      message: prepare.message ?? prepare.detail,
      raw: event,
    };
  }
  const type = String(event?.type || "");
  if (type === "heartbeat" || type === "worker_status") {
    return {
      progress: null,
      phase: String(event.status || type),
      message: typeof event.message === "string" ? event.message : undefined,
      raw: event,
    };
  }
  return null;
}

/**
 * @param {(event: Record<string, unknown>) => void} listener
 * @returns {() => void}
 */
export function subscribeAgentEvents(listener) {
  _wsListeners.add(listener);
  return () => _wsListeners.delete(listener);
}

function _emitAgentEvent(event) {
  for (const listener of _wsListeners) {
    try {
      listener(event);
    } catch (err) {
      console.warn("[ItMatZipBridge] ws listener error", err);
    }
  }
}

function _setWsConnected(connected) {
  _wsConnectionListener?.(connected);
}

function _scheduleWsReconnect() {
  if (_wsManualClose || _wsReconnectTimer) return;
  _wsReconnectTimer = globalThis.setTimeout(() => {
    _wsReconnectTimer = 0;
    void connectAgentWebSocket();
  }, _wsReconnectMs);
}

/**
 * @param {AgentWebSocketOptions} [opts]
 * @returns {Promise<boolean>} connected
 */
export function connectAgentWebSocket(opts = {}) {
  if (opts.reconnectMs != null) _wsReconnectMs = Math.max(500, opts.reconnectMs);
  if (typeof opts.onConnectionChange === "function") _wsConnectionListener = opts.onConnectionChange;

  _wsManualClose = false;
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
    return Promise.resolve(_ws.readyState === WebSocket.OPEN);
  }

  const url = agentWebSocketUrl(_origin);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    try {
      _ws = new WebSocket(url);
    } catch (err) {
      console.warn("[ItMatZipBridge] ws connect failed", err);
      _scheduleWsReconnect();
      finish(false);
      return;
    }

    _ws.addEventListener("open", () => {
      _setWsConnected(true);
      finish(true);
    });

    _ws.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(String(ev.data || ""));
        if (data && typeof data === "object") _emitAgentEvent(/** @type {Record<string, unknown>} */ (data));
      } catch {
        _emitAgentEvent({ type: "log", message: String(ev.data || ""), source: "ws" });
      }
    });

    _ws.addEventListener("close", () => {
      _setWsConnected(false);
      _ws = null;
      if (!_wsManualClose) _scheduleWsReconnect();
      finish(false);
    });

    _ws.addEventListener("error", () => {
      finish(false);
    });
  });
}

export function disconnectAgentWebSocket() {
  _wsManualClose = true;
  if (_wsReconnectTimer) {
    globalThis.clearTimeout(_wsReconnectTimer);
    _wsReconnectTimer = 0;
  }
  if (_ws) {
    try {
      _ws.close();
    } catch {
      /* ignore */
    }
    _ws = null;
  }
  _setWsConnected(false);
}

export function isAgentWebSocketConnected() {
  return _ws != null && _ws.readyState === WebSocket.OPEN;
}

/**
 * @param {AgentWebSocketOptions & {
 *   onEvent?: (event: Record<string, unknown>) => void,
 *   types?: string[],
 * }} [opts]
 * @returns {Promise<{ connected: boolean, unsubscribe: () => void }>}
 */
export async function startAgentEventStream(opts = {}) {
  const types = opts.types ? new Set(opts.types) : null;
  const unsubscribe = opts.onEvent
    ? subscribeAgentEvents((event) => {
        if (types && !types.has(String(event.type || ""))) return;
        opts.onEvent?.(event);
      })
    : () => {};

  const connected = await connectAgentWebSocket({
    reconnectMs: opts.reconnectMs,
    onConnectionChange: opts.onConnectionChange,
  });
  return { connected, unsubscribe };
}


/** @type {string[]} */
const _originFallbacks = AGENT_ORIGIN_FALLBACKS;

/**
 * @returns {string}
 */
function defaultAgentOriginForPage() {
  if (typeof window === "undefined") return _originFallbacks[0];
  const h = window.location.hostname;
  if (h === "localhost") return `http://localhost:${AGENT_PORT}`;
  if (h === "127.0.0.1" || h === "[::1]") return `http://127.0.0.1:${AGENT_PORT}`;
  return _originFallbacks[0];
}

/** @type {HTMLDialogElement | null} */
let _installDialog = null;

/** @type {(() => void) | null} */
let _installPendingResolve = null;

/** @type {InstallDialogOptions | null} */
let _installDialogOptions = null;

/** @type {boolean} */
let _installDialogHandlersBound = false;

/** 사용자가 닫기 누른 뒤 자동 팝업 억제 (ms, Date.now 기준) */
let _installAutoShowSuppressedUntil = 0;

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
 * @param {string} origin 예: http://localhost:19876
 */
export function setAgentOrigin(origin) {
  _origin = origin.replace(/\/+$/, "");
}

/** @type {boolean | null} */
let _targetAddressSpaceSupported = null;

function supportsTargetAddressSpace() {
  if (_targetAddressSpaceSupported != null) return _targetAddressSpaceSupported;
  if (typeof Request === "undefined") {
    _targetAddressSpaceSupported = false;
    return false;
  }
  try {
    new Request("http://127.0.0.1/", { targetAddressSpace: "loopback" });
    _targetAddressSpaceSupported = true;
  } catch {
    _targetAddressSpaceSupported = false;
  }
  return _targetAddressSpaceSupported;
}

/**
 * Chrome Local Network Access — fetch 대상 address space
 * @see https://wicg.github.io/local-network-access/
 * @param {string} [url]
 * @returns {"loopback" | "local" | undefined}
 */
function targetAddressSpaceForUrl(url) {
  if (!supportsTargetAddressSpace()) return undefined;
  if (!url) return "loopback";
  try {
    const { hostname } = new URL(url);
    const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost")) {
      return "loopback";
    }
    if (
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      /^169\.254\./.test(h)
    ) {
      return "local";
    }
  } catch {
    /* ignore */
  }
  return "loopback";
}

/**
 * 로컬 에이전트용 fetch (Chrome `targetAddressSpace` 적용)
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
/**
 * Error / FastAPI detail / { message } 등을 사용자용 문자열로 변환
 * @param {unknown} raw
 * @returns {string}
 */
export function extractAgentErrorMessage(raw, depth = 0) {
  if (raw == null || depth > 8) return "";
  if (typeof raw === "string") return raw.trim();
  if (raw instanceof Error) return raw.message?.trim() || String(raw);
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (Array.isArray(raw)) {
    return raw
      .map((item) => extractAgentErrorMessage(item, depth + 1))
      .filter(Boolean)
      .join("; ");
  }
  if (typeof raw === "object") {
    const o = /** @type {Record<string, unknown>} */ (raw);
    if (o.message != null) return extractAgentErrorMessage(o.message, depth + 1);
    if (o.detail != null) return extractAgentErrorMessage(o.detail, depth + 1);
    if (o.error != null) return extractAgentErrorMessage(o.error, depth + 1);
    if (typeof o.msg === "string") return o.msg.trim();
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function formatAgentConnectionError(raw) {
  const msg = extractAgentErrorMessage(raw);
  if (/address space/i.test(msg)) {
    return "브라우저 로컬 연결 정책 — 강력 새로고침(Ctrl+Shift+R) 후 주소창에서 「로컬 네트워크」 허용";
  }
  if (/Failed to fetch|NetworkError|ERR_FAILED|Load failed/i.test(msg)) {
    return "Failed to fetch — 에이전트 실행 중이면 Chrome 주소창 → 사이트 설정 → 로컬 네트워크 「허용」";
  }
  return msg || "연결할 수 없습니다";
}

/**
 * 웹툴 index 헤더의 #connection-status 문구·색상 (끊김 시 상세는 title 툴팁만)
 * @param {HTMLElement | null} el
 * @param {boolean} ok
 * @param {{ agentVersion?: string, latencyMs?: number, error?: string, rawError?: string } | null} [detail]
 */
export function applyConnectionStatusDot(el, ok, detail) {
  if (!el) return;
  const apiReady = detail?.apiReady !== false;
  const longOp = detail?.longOp === true || isAgentLongOperationActive();
  if (ok && !apiReady) {
    const ver =
      detail && "agentVersion" in detail && detail.agentVersion
        ? ` v${detail.agentVersion}`
        : "";
    if (longOp) {
      el.textContent = `에이전트 작업 중${ver}`;
      el.style.color = "#f59e0b";
      el.title = "긴 작업 중입니다. FastAPI 응답이 느려질 수 있으나 연결은 유지됩니다.";
      return;
    }
    el.textContent = `에이전트 API 준비 중${ver}`;
    el.style.color = "#f59e0b";
    el.title = "FastAPI가 재시작 중입니다. 10~30초 후 자동으로 복구됩니다.";
    return;
  }
  if (ok) {
    const ver =
      detail && "agentVersion" in detail && detail.agentVersion
        ? ` v${detail.agentVersion}`
        : "";
    const ms = detail?.latencyMs != null ? ` (${detail.latencyMs}ms)` : "";
    el.textContent = `에이전트 연결됨${ver}${ms}`;
    el.style.color = "#10b981";
    el.title = "";
    return;
  }
  el.textContent = "에이전트 연결 끊김";
  el.style.color = "#ef4444";
  const errText = formatAgentConnectionError(
    detail?.error ?? /** @type {{ rawError?: string }} */ (detail)?.rawError,
  );
  el.title = errText || "";
}

export async function fetchAgent(url, init = {}) {
  const space = targetAddressSpaceForUrl(url);
  if (!space) return fetch(url, init);
  return fetch(url, { ...init, targetAddressSpace: space });
}

/** @param {string} [err] */
function isLikelyLocalNetworkBlock(err) {
  const m = err != null ? String(err) : "";
  return /Failed to fetch|NetworkError|ERR_FAILED|Load failed|address space|blocked/i.test(m);
}

/** @type {Promise<void> | null} */
let _lnaPrimePromise = null;

/** Chrome LNA 권한 프롬프트 유도 (세션당 1회) */
export function primeLocalNetworkAccess() {
  if (_lnaPrimePromise) return _lnaPrimePromise;
  _lnaPrimePromise = (async () => {
    try {
      if (navigator.permissions?.query) {
        try {
          const perm = await navigator.permissions.query(
            /** @type {PermissionDescriptor} */ (
              /** @type {unknown} */ ({ name: "local-network-access" })
            ),
          );
          if (perm.state === "granted") return;
        } catch {
          /* 미지원 브라우저 */
        }
      }
      const origin = _originFallbacks[0] ?? `http://127.0.0.1:${AGENT_PORT}`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      try {
        await fetchAgent(`${origin.replace(/\/+$/, "")}${_healthPath}`, {
          method: "GET",
          cache: "no-store",
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(t);
      }
    } catch {
      /* 사용자 거부·에이전트 미실행 */
    }
  })();
  return _lnaPrimePromise;
}

/**
 * @param {string} origin
 * @param {AbortSignal | undefined} signal
 */
/** ItMatZip 에이전트 /health 본문인지 (다른 프로세스의 200 응답 제외) */
function isItmatzipHealthPayload(data) {
  return (
    data != null &&
    typeof data === "object" &&
    data.status === "ok" &&
    typeof data.agent_version === "string" &&
    data.agent_version.length > 0
  );
}

async function pingAgentOrigin(origin, signal) {
  const url = `${origin.replace(/\/+$/, "")}${_healthPath}`;
  const ctrl = new AbortController();
  const longOp = isAgentLongOperationActive();
  const healthTimeoutMs = longOp
    ? Math.min(15_000, _connectTimeoutMs)
    : Math.min(4500, _connectTimeoutMs);
  const t = setTimeout(() => ctrl.abort(), healthTimeoutMs);
  const merged = mergeSignals(signal, ctrl.signal);
  const started = performance.now();
  try {
    const res = await fetchAgent(url, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      signal: merged,
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) {
      return { ok: false, status: res.status, latencyMs, error: `HTTP ${res.status}`, origin };
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        status: res.status,
        latencyMs,
        error: "health 응답 파싱 실패",
        origin,
      };
    }
    if (!isItmatzipHealthPayload(body)) {
      return {
        ok: false,
        status: res.status,
        latencyMs,
        error: "ItMatZip 에이전트가 아닙니다",
        origin,
      };
    }
    return {
      ok: true,
      status: res.status,
      latencyMs,
      origin,
      agentVersion: body.agent_version,
      apiReady: body.fastapi_ready !== false,
    };
  } catch (e) {
    const latencyMs = Math.round(performance.now() - started);
    const err = e instanceof Error ? e.message : String(e);
    return { ok: false, latencyMs, error: err, origin };
  } finally {
    clearTimeout(t);
  }
}

export async function checkAgentConnection(signal) {
  await primeLocalNetworkAccess();
  const candidates = [...new Set([_origin, ..._originFallbacks])];
  /** @type {{ ok: boolean, status?: number, latencyMs?: number, error?: string } | null} */
  let lastFail = null;

  for (let i = 0; i < candidates.length; i++) {
    const origin = candidates[i];
    const detail = await pingAgentOrigin(origin, signal);
    if (detail.ok) {
      _origin = origin.replace(/\/+$/, "");
      recordCircuitSuccess();
      return {
        ok: true,
        status: detail.status,
        latencyMs: detail.latencyMs,
        origin: _origin,
        agentVersion: detail.agentVersion,
        apiReady: detail.apiReady !== false,
      };
    }
    lastFail = {
      ok: false,
      status: detail.status,
      latencyMs: detail.latencyMs,
      error: detail.error,
    };
    if (isLikelyLocalNetworkBlock(detail.error)) break;
  }

  const err = lastFail?.error;
  if (err) recordCircuitFailure();
  return {
    ok: false,
    status: lastFail?.status,
    latencyMs: lastFail?.latencyMs,
    error: formatAgentConnectionError(err),
    rawError: err,
  };
}

/**
 * @param {InstallDialogOptions | (() => InstallDialogOptions | Promise<InstallDialogOptions>) | undefined} source
 * @returns {Promise<InstallDialogOptions>}
 */
async function resolveInstallDialogOptions(source) {
  if (typeof source === "function") {
    return /** @type {InstallDialogOptions} */ (await source());
  }
  return source ?? {};
}

/**
 * @typedef {{
 *   intervalMs?: number,
 *   immediate?: boolean,
 *   onChange?: (ok: boolean, detail: { ok: boolean, status?: number, latencyMs?: number, error?: string }) => void,
 *   onDisconnected?: (detail: { ok: boolean, error?: string }) => void,
 *   autoShowInstallDialog?: boolean,
 *   installDialogOptions?: InstallDialogOptions | (() => InstallDialogOptions | Promise<InstallDialogOptions>),
 * }} MonitorOptions
 * @param {MonitorOptions} opts
 * @returns {{ stop: () => void, refresh: () => Promise<void> }}
 */
export function startConnectionMonitor(opts = {}) {
  const baseIntervalMs = opts.intervalMs ?? 5000;
  let stopped = false;
  let lastOk = /** @type {boolean | null} */ (null);
  let firstTick = true;
  let failStreak = 0;
  let disconnectDialogShown = false;
  let timeoutId = 0;

  function nextDelayMs() {
    if (failStreak <= 0) return baseIntervalMs;
    return Math.min(60_000, baseIntervalMs * 2 ** Math.min(failStreak - 1, 3));
  }

  function scheduleNext() {
    if (stopped) return;
    globalThis.clearTimeout(timeoutId);
    timeoutId = globalThis.setTimeout(() => void tick(), nextDelayMs());
  }

  async function tick() {
    if (stopped) return;

    // 음악 생성·환경 준비 등으로 FastAPI가 바쁠 때 /health 타임아웃 → 오탐 끊김 방지
    if (isAgentLongOperationActive() && lastOk === true) {
      opts.onChange?.(true, {
        ok: true,
        longOp: true,
        apiReady: false,
      });
      scheduleNext();
      return;
    }

    const detail = await checkAgentConnection();
    if (stopped) return;

    const prevReportOk = lastOk === true;

    if (detail.ok) {
      failStreak = 0;
      recordCircuitSuccess();
      disconnectDialogShown = false;
      _installAutoShowSuppressedUntil = 0;
      if (_installBackdrop && !_installBackdrop.hasAttribute("hidden")) dismissInstallAgentDialog();
      void connectAgentWebSocket();
      lastOk = true;
    } else if (!isAgentLongOperationActive()) {
      failStreak += 1;
      recordCircuitFailure();
      if (failStreak >= MONITOR_DISCONNECT_DIALOG_STREAK) disconnectAgentWebSocket();
      if (failStreak >= MONITOR_DISCONNECT_UI_STREAK) lastOk = false;
    }

    const reportOk = lastOk === true;
    const changed = prevReportOk !== reportOk;
    if (firstTick) firstTick = false;

    opts.onChange?.(reportOk, { ...detail, ok: reportOk });

    if (!reportOk) {
      if (changed) opts.onDisconnected?.(detail);
      const shouldAlert =
        opts.autoShowInstallDialog &&
        !disconnectDialogShown &&
        failStreak >= MONITOR_DISCONNECT_DIALOG_STREAK &&
        !isAgentLongOperationActive() &&
        Date.now() >= _installAutoShowSuppressedUntil;
      if (shouldAlert && !(_installBackdrop && !_installBackdrop.hasAttribute("hidden"))) {
        disconnectDialogShown = true;
        void resolveInstallDialogOptions(opts.installDialogOptions).then((dialogOpts) =>
          showInstallAgentDialog(dialogOpts),
        );
      }
    }
    scheduleNext();
  }

  if (opts.immediate !== false) void tick();
  else scheduleNext();

  return {
    stop() {
      stopped = true;
      globalThis.clearTimeout(timeoutId);
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
function _finishInstallDialogPromise() {
  if (_installPendingResolve) {
    const finish = _installPendingResolve;
    _installPendingResolve = null;
    finish();
  }
}

function _closeInstallDialogElement() {
  if (!_installBackdrop) return;
  const isHidden = _installBackdrop.hasAttribute("hidden");
  if (isHidden) return;
  _installBackdrop.setAttribute("hidden", "");
  _installDialog?.setAttribute("hidden", "");
  document.body?.classList.remove("itz-install-visible");
}

function _closeInstallDialogByUser() {
  _installAutoShowSuppressedUntil = Date.now() + INSTALL_DIALOG_SUPPRESS_MS;
  _finishInstallDialogPromise();
  _closeInstallDialogElement();
}

async function _retryInstallDialogConnection() {
  const dlg = _installDialog;
  const opts = _installDialogOptions;
  if (!dlg || !opts) return;

  const statusEl = dlg.querySelector("[data-install-status]");
  const retryBtn = dlg.querySelector('button[data-act="retry"]');
  if (retryBtn instanceof HTMLButtonElement) retryBtn.disabled = true;
  if (statusEl) {
    statusEl.textContent = "연결 확인 중…";
    statusEl.className = "itz-install__status";
  }

  try {
    let detail = await Promise.resolve(opts.onPrimary?.());
    if (!detail || typeof detail !== "object" || !("ok" in detail)) {
      detail = await checkAgentConnection();
    }
    if (detail?.ok) {
      _installAutoShowSuppressedUntil = 0;
      if (statusEl) {
        statusEl.textContent = "연결되었습니다.";
        statusEl.className = "itz-install__status is-ok";
      }
      _finishInstallDialogPromise();
      _closeInstallDialogElement();
      return;
    }
    const err = detail?.error || "연결할 수 없습니다.";
    if (statusEl) {
      statusEl.textContent = `아직 연결되지 않았습니다. (${err})`;
      statusEl.className = "itz-install__status is-err";
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (statusEl) {
      statusEl.textContent = `확인 실패: ${msg}`;
      statusEl.className = "itz-install__status is-err";
    }
  } finally {
    if (retryBtn instanceof HTMLButtonElement) retryBtn.disabled = false;
  }
}

function _bindInstallDialogHandlersOnce() {
  const dlg = _installDialog;
  if (!dlg || _installDialogHandlersBound) return;
  _installDialogHandlersBound = true;

  dlg.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    const btn = t.closest("button[data-act]");
    if (!btn || !dlg.contains(btn)) return;
    const act = btn.getAttribute("data-act");
    if (act === "retry") {
      ev.preventDefault();
      void _retryInstallDialogConnection();
    }
  });
}

export function showInstallAgentDialog(options = {}) {
  if (Date.now() < _installAutoShowSuppressedUntil) {
    return Promise.resolve();
  }

  ensureInstallDialog();
  const dlg = _installDialog;
  _bindInstallDialogHandlersOnce();
  _installDialogOptions = options;
  const alreadyOpen = !_installBackdrop?.hasAttribute("hidden");
  const title = options.title ?? "로컬 에이전트에 연결할 수 없습니다";
  const body =
    options.bodyHtml ??
    `<p style="margin:0">PC에서 ItMatZip 로컬 에이전트를 실행한 뒤 다시 연결해 주세요.</p>`;

  dlg.innerHTML = `
    <div class="itz-install">
      <header class="itz-install__head">
        <h2 class="itz-install__title">${escapeHtml(title)}</h2>
      </header>
      <div class="itz-install__body">
        ${body}
        <p class="itz-install__status" data-install-status aria-live="polite"></p>
      </div>
      <footer class="itz-install__foot">
        <button type="button" class="itz-install__btn itz-install__btn--primary" data-act="retry">${escapeHtml(
          options.primaryLabel ?? "다시 연결 확인"
        )}</button>
      </footer>
    </div>
  `;

  return new Promise((resolve) => {
    _installPendingResolve = resolve;
    if (!alreadyOpen) {
      _installBackdrop?.removeAttribute("hidden");
      dlg.removeAttribute("hidden");
      document.body?.classList.add("itz-install-visible");
      requestAnimationFrame(() => {
        _positionDialogBetweenAds();
        dlg.scrollIntoView({ behavior: "smooth", block: "center" });
        dlg.focus?.();
      });
    }
    requestAnimationFrame(() => {
      options.onShown?.();
    });
  });
}

export function dismissInstallAgentDialog() {
  _installAutoShowSuppressedUntil = Date.now() + INSTALL_DIALOG_SUPPRESS_MS;
  _finishInstallDialogPromise();
  _closeInstallDialogElement();
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
  assertCircuitAllowsRequest();
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

  let res;
  try {
    res = await fetchAgent(url, init);
  } catch (err) {
    if (isTransientAgentError(err)) recordCircuitFailure();
    throw err;
  }

  if (res.ok) {
    recordCircuitSuccess();
  } else if (isTransientHttpStatus(res.status)) {
    recordCircuitFailure();
  }

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
        ? extractAgentErrorMessage(/** @type {any} */ (data).detail)
        : `HTTP ${res.status}`;
    throw new Error(msg || `HTTP ${res.status}`);
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
  let pollFailStreak = 0;
  while (true) {
    if (Date.now() > deadline) {
      onProgress({ progress: null, phase: "timeout", message: "작업 상태 폴링 시간 초과(2시간)" });
      throw new Error("작업 상태 폴링 시간 초과");
    }
    if (outer?.aborted) throw new DOMException("Aborted", "AbortError");
    assertCircuitAllowsRequest();
    const ctrl = new AbortController();
    const pollTimeoutMs = isAgentLongOperationActive()
      ? Math.min(15_000, _connectTimeoutMs)
      : _connectTimeoutMs;
    const t = setTimeout(() => ctrl.abort(), pollTimeoutMs);
    let res;
    try {
      res = await fetchAgent(statusUrl, {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: mergeSignals(outer, ctrl.signal),
      });
    } catch (err) {
      if (isTransientAgentError(err) && pollFailStreak < POLL_FAIL_STREAK_MAX) {
        pollFailStreak += 1;
        recordCircuitFailure();
        onProgress({
          progress: null,
          phase: "retry",
          message: `에이전트 응답 지연 — 재시도 (${pollFailStreak}/${POLL_FAIL_STREAK_MAX})`,
        });
        await delay(pollBackoffMs(pollFailStreak), outer);
        continue;
      }
      recordCircuitFailure();
      throw err;
    } finally {
      clearTimeout(t);
    }

    const body = await safeJson(res);
    if (!res.ok) {
      if (isTransientHttpStatus(res.status) && pollFailStreak < POLL_FAIL_STREAK_MAX) {
        pollFailStreak += 1;
        recordCircuitFailure();
        onProgress({
          progress: null,
          phase: "retry",
          message: `상태 조회 재시도 (${pollFailStreak}/${POLL_FAIL_STREAK_MAX}) — HTTP ${res.status}`,
          raw: body,
        });
        await delay(pollBackoffMs(pollFailStreak), outer);
        continue;
      }
      onProgress({ progress: null, phase: "error", message: `상태 조회 실패 HTTP ${res.status}`, raw: body });
      recordCircuitFailure();
      throw new Error(`작업 상태 조회 실패: HTTP ${res.status}`);
    }

    pollFailStreak = 0;
    recordCircuitSuccess();

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
    .itz-install-backdrop {
      position: fixed;
      inset: 0;
      z-index: 9990;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      background: rgba(8, 10, 14, 0.52);
      pointer-events: none;
    }
    .itz-install-backdrop[hidden] {
      display: none !important;
    }
    /* 광고 영역: 블러 위에 표시 */
    body.itz-install-visible .editor-ad,
    body.itz-install-visible [class*="ad-exempt"] {
      position: relative !important;
      z-index: 9995 !important;
    }
    /* 다이얼로그: 광고 사이 중앙에 absolute 배치 */
    #itmatzip-bridge-install-dialog {
      position: absolute;
      z-index: 9993;
      left: 50%;
      transform: translateX(-50%);
      pointer-events: auto;
      border: 1px solid #2d333f;
      border-radius: 16px;
      padding: 0;
      width: 820px;
      max-width: min(820px, 92vw);
      box-shadow: 0 28px 80px rgba(0, 0, 0, 0.55);
      background: #1a1d23;
      color: #e2e8f0;
    }
    #itmatzip-bridge-install-dialog[hidden] {
      display: none !important;
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
      border-radius: 16px 16px 0 0;
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
    .itz-install__status {
      margin: 0.85rem 0 0;
      font-size: 0.9rem;
      line-height: 1.5;
      color: #94a3b8;
      min-height: 1.35em;
    }
    .itz-install__status.is-ok {
      color: #86efac;
    }
    .itz-install__status.is-err {
      color: #fca5a5;
    }
    .itz-install__btn--primary:disabled {
      opacity: 0.55;
      cursor: not-allowed;
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
      border-radius: 0 0 16px 16px;
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

/** @type {HTMLElement|null} */
let _installBackdrop = null;

function _getAbsoluteTop(el) {
  let top = 0;
  let current = el;
  while (current) {
    top += current.offsetTop || 0;
    current = current.offsetParent;
  }
  return top;
}

function _positionDialogBetweenAds() {
  const dlg = _installDialog;
  if (!dlg) return;

  const ads = Array.from(document.querySelectorAll(".editor-ad, [class*='ad-exempt']"));
  const unique = [...new Set(ads)];

  const adRects = [];
  for (const ad of unique) {
    if (ad.offsetWidth === 0 && ad.offsetHeight === 0) continue;
    const absTop = _getAbsoluteTop(ad);
    adRects.push({ top: absTop, bottom: absTop + ad.offsetHeight });
  }

  if (adRects.length === 0) {
    const pageH = document.documentElement.scrollHeight;
    dlg.style.top = (pageH / 2) + "px";
    return;
  }

  adRects.sort((a, b) => a.top - b.top);

  const topAd = adRects[0];
  const bottomAd = adRects[adRects.length - 1];

  let firstAdBottom, lastAdTop;

  if (adRects.length === 1) {
    firstAdBottom = topAd.bottom;
    lastAdTop = document.documentElement.scrollHeight;
  } else if (bottomAd.top >= topAd.bottom) {
    firstAdBottom = topAd.bottom;
    lastAdTop = bottomAd.top;
  } else {
    const maxBottom = Math.max(...adRects.map(r => r.bottom));
    firstAdBottom = maxBottom;
    lastAdTop = document.documentElement.scrollHeight;
  }

  const centerY = firstAdBottom + (lastAdTop - firstAdBottom) / 2;
  const dlgH = dlg.offsetHeight || 600;
  const top = Math.max(firstAdBottom + 16, centerY - dlgH / 2);

  dlg.style.top = top + "px";
}

function ensureInstallDialog() {
  ensureInstallDialogStyles();
  if (_installDialog) return;

  const backdrop = document.createElement("div");
  backdrop.className = "itz-install-backdrop";
  backdrop.setAttribute("hidden", "");

  const dlg = document.createElement("div");
  dlg.id = "itmatzip-bridge-install-dialog";
  dlg.setAttribute("hidden", "");
  dlg.setAttribute("tabindex", "-1");

  const root = document.body ?? document.documentElement;
  root.appendChild(backdrop);
  root.appendChild(dlg);

  _installBackdrop = backdrop;
  _installDialog = dlg;
  _bindInstallDialogHandlersOnce();
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
  fetchAgent,
  extractAgentErrorMessage,
  formatAgentConnectionError,
  applyConnectionStatusDot,
  primeLocalNetworkAccess,
  checkAgentConnection,
  startConnectionMonitor,
  showInstallAgentDialog,
  dismissInstallAgentDialog,
  requestAgent,
  connectAgentWebSocket,
  disconnectAgentWebSocket,
  isAgentWebSocketConnected,
  subscribeAgentEvents,
  startAgentEventStream,
  getAgentCircuitBreakerState,
  mapAgentEventToPrepareStatus,
  mapAgentEventToProgress,
  setAgentLongOperationActive,
  isAgentLongOperationActive,
  getAgentCircuitBreakerState,
};

const g = typeof globalThis !== "undefined" ? globalThis : window;
// @ts-ignore 레거시 스크립트에서 전역으로 접근
g.ItMatZipBridge = Bridge;

export default Bridge;
