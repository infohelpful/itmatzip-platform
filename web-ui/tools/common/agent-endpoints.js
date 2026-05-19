/**
 * 로컬 에이전트 주소 — agent/agent_config.py 의 AGENT_PORT 와 동일하게 유지
 */
export const AGENT_HOST = "127.0.0.1";
export const AGENT_PORT = 19876;

/** @type {string[]} */
export const AGENT_ORIGIN_FALLBACKS = [
  `http://127.0.0.1:${AGENT_PORT}`,
  `http://localhost:${AGENT_PORT}`,
];
