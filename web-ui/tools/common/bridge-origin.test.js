import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_ORIGIN_FALLBACKS, AGENT_TLS_HOST, AGENT_TLS_PORT, agentWebSocketUrl } from './agent-endpoints.js';

// bridge.js 는 import 시점에 브라우저 전역(window/document)을 건드린다 — tools.itmatzip.com 페이지를 흉내 낸다.
const noop = () => {};
globalThis.window = {
  location: { hostname: 'tools.itmatzip.com', protocol: 'https:', port: '', origin: 'https://tools.itmatzip.com', href: 'https://tools.itmatzip.com/kr/', search: '' },
  addEventListener: noop,
  removeEventListener: noop,
  setTimeout,
  clearTimeout,
  alert: noop,
  confirm: () => true,
  prompt: () => null,
};
const { checkAgentConnection, primeLocalNetworkAccess, getAgentOrigin } = await import('./bridge.js');

const HEALTH = { status: 'ok', agent_version: '9.9.9', fastapi_ready: true };

/** fetch 가짜: reachable(origin) 이 true 인 주소만 health 200, 나머지는 브라우저의 차단 에러처럼 실패 */
function stubFetch(reachable) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const origin = new URL(url).origin;
    calls.push({ origin, space: init.targetAddressSpace });
    if (!reachable(origin)) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(HEALTH), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

test('fallback list keeps the legacy order and ends with the https local domain', () => {
  assert.equal(AGENT_ORIGIN_FALLBACKS[0], 'http://127.0.0.1:19876');
  assert.equal(AGENT_ORIGIN_FALLBACKS[1], 'http://localhost:19876');
  assert.ok(AGENT_ORIGIN_FALLBACKS.includes('http://itmatzip.localhost:19876'));
  assert.equal(AGENT_ORIGIN_FALLBACKS.at(-1), `https://${AGENT_TLS_HOST}:${AGENT_TLS_PORT}`);
});

test('https origin turns into a wss websocket url', () => {
  assert.equal(
    agentWebSocketUrl(`https://${AGENT_TLS_HOST}:${AGENT_TLS_PORT}`),
    `wss://${AGENT_TLS_HOST}:${AGENT_TLS_PORT}/ws`,
  );
});

test('connection check: one request when the preferred origin works, bypass origin when 127.0.0.1 is blocked', async () => {
  // LNA 권한 확인용 1회성 요청을 먼저 소진
  stubFetch(() => true);
  await primeLocalNetworkAccess();

  // 1) 정상: 요청 1건
  let calls = stubFetch(() => true);
  let result = await checkAgentConnection();
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1, 'healthy agent must cost exactly one request per check');
  assert.ok(calls[0].space, 'targetAddressSpace must be declared');

  // 2) 광고 차단기가 127.0.0.1 / localhost 만 막는 상황 → 우회 호스트 이름으로 연결
  const blocked = new Set(['http://127.0.0.1:19876', 'http://localhost:19876']);
  calls = stubFetch((origin) => !blocked.has(origin));
  result = await checkAgentConnection();
  assert.equal(result.ok, true, 'must not give up after the first blocked origin');
  assert.equal(result.origin, 'http://itmatzip.localhost:19876');
  assert.equal(getAgentOrigin(), 'http://itmatzip.localhost:19876');

  // 3) 다음 폴링은 성공했던 주소부터 → 요청 1건
  calls = stubFetch((origin) => !blocked.has(origin));
  result = await checkAgentConnection();
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].origin, 'http://itmatzip.localhost:19876');

  // 4) 그것도 막히면 마지막 후보(https local.itmatzip.com)까지 시도
  const httpsOrigin = `https://${AGENT_TLS_HOST}:${AGENT_TLS_PORT}`;
  calls = stubFetch((origin) => origin === httpsOrigin);
  result = await checkAgentConnection();
  assert.equal(result.ok, true);
  assert.equal(result.origin, httpsOrigin);
  assert.ok(calls.some((c) => c.origin === httpsOrigin));

  // 5) 전부 실패하면 실패로 보고
  calls = stubFetch(() => false);
  result = await checkAgentConnection();
  assert.equal(result.ok, false);
});
