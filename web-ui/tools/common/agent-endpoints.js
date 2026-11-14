/**
 * 로컬 에이전트 주소 — agent/agent_config.py 의 AGENT_PORT 와 동일하게 유지
 */
export const AGENT_HOST = "127.0.0.1";
export const AGENT_PORT = 19876;
export const AGENT_WS_PATH = "/ws";

/**
 * HTTPS 진입점 — local.itmatzip.com(공개 DNS → 127.0.0.1) + 에이전트가 내려받은 전용 인증서.
 * go-agent/tls_local.go 의 defaultTLSPort / localTLSHostname 와 동일하게 유지.
 */
export const AGENT_TLS_HOST = "local.itmatzip.com";
export const AGENT_TLS_PORT = 19878;

/**
 * 연결 후보 (앞에서부터 우선). 광고 차단기는 127.0.0.1·localhost 같은 IP/호스트 문자열을 막는 경우가 있어
 * 호스트 이름이 다른 후보를 뒤에 둔다. 인덱스 0/1 은 bridge.js 가 기본값으로 쓰므로 순서를 바꾸지 말 것.
 * @type {string[]}
 */
export const AGENT_ORIGIN_FALLBACKS = [
  `http://127.0.0.1:${AGENT_PORT}`,
  `http://localhost:${AGENT_PORT}`,
  `http://itmatzip.localhost:${AGENT_PORT}`,
  `https://${AGENT_TLS_HOST}:${AGENT_TLS_PORT}`,
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
