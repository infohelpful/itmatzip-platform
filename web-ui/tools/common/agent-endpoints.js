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

/**
 * @param {string} [origin] HTTP origin (ws:// derived from it)
 * @returns {string}
 */
export function agentWebSocketUrl(origin) {
  const base = (origin || AGENT_ORIGIN_FALLBACKS[0]).replace(/\/+$/, "");
  const wsBase = base.replace(/^http/i, "ws");
  return `${wsBase}${AGENT_WS_PATH}`;
}
