/**
 * 로컬 에이전트 주소 — agent/agent_config.py 의 AGENT_PORT 와 동일하게 유지
 */
export const AGENT_HOST = "127.0.0.1";
export const AGENT_PORT = 19876;
export const AGENT_WS_PATH = "/ws";

/** @type {string[]} */
export const AGENT_ORIGIN_FALLBACKS = [
  `http://127.0.0.1:${AGENT_PORT}`,
  `http://localhost:${AGENT_PORT}`,
];

/** @param {string} host */
function isLoopbackHost(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/**
 * UI가 로컬 에이전트(19876)에서 제공될 때 — 페이지 origin 그대로 사용.
 * @returns {string | null}
 */
export function getPageLocalAgentOrigin() {
  if (typeof window === "undefined") return null;
  const loc = window.location;
  if (!isLoopbackHost(loc.hostname)) return null;
  if (loc.port !== String(AGENT_PORT)) return null;
  return loc.origin.replace(/\/+$/, "");
}

export function isPageServedFromLocalAgent() {
  return getPageLocalAgentOrigin() != null;
}

/**
 * @param {string} [origin] HTTP origin (ws:// derived from it)
 * @returns {string}
 */
export function agentWebSocketUrl(origin) {
  const base = (origin || AGENT_ORIGIN_FALLBACKS[0]).replace(/\/+$/, "");
  const wsBase = base.replace(/^http/i, "ws");
  return `${wsBase}${AGENT_WS_PATH}`;
}
