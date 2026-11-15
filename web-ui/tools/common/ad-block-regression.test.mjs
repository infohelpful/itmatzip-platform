import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const guardSource = readFileSync(new URL('./site-guard.js', import.meta.url), 'utf8');
const adsSource = readFileSync(new URL('./adsense.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/m, '').replaceAll('export ', '');

function harness({ loader = false, existing = false, network = null } = {}) {
  let now = 100000, seq = 0, shown = 0, dismissed = 0, active = null, modalShown = 0, notice = null, modalOptions = null;
  const session = new Map();
  const timers = new Map(), listeners = new Map(), scripts = [];
  const state = { hiding: false, hideControl: false, snapshot: {
    scriptLoaded: false, scriptUnavailable: true, filledCount: 0, unfilledCount: 0,
  } };
  const addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  const dispatchEvent = (e) => { for (const fn of listeners.get(e.type) || []) fn(e); };
  const createElement = (tag) => {
    const handlers = new Map();
    const el = { tag, style: {}, className: '', isConnected: true,
      setAttribute() {}, getAttribute() { return null; },
      getBoundingClientRect() { return { width: 10, height: 10 }; },
      addEventListener(type, fn) { handlers.set(type, fn); },
      removeEventListener(type) { handlers.delete(type); },
      fire(type) { handlers.get(type)?.(); },
      children: [], append(...children) { el.children.push(...children); },
      remove() { el.isConnected = false; if (el.tag === 'aside') { dismissed++; notice = null; } else if (scripts.includes(el)) scripts.splice(scripts.indexOf(el), 1); },
    };
    return el;
  };
  if (existing) scripts.push(createElement('script'));
  const document = { currentScript: network ? { src: 'https://tools.itmatzip.com/common/site-guard.js?v=19' } : null, hidden: false, visibilityState: 'visible', readyState: 'complete',
    addEventListener, dispatchEvent, createElement,
    body: { appendChild(el) { if (el.tag === 'aside') { shown++; notice = el; } } }, head: { appendChild(el) { scripts.push(el); } },
    documentElement: { getAttribute() { return ''; } },
    querySelectorAll() { return []; },
    querySelector(selector) { return selector.startsWith('script') ? scripts[0] || null : null; },
    getElementById() { return null; },
  };
  const context = vm.createContext({ document, console, URLSearchParams, URL, AbortController,
    fetch: network ? (url) => network(url) : undefined,
    Date: { now: () => now }, navigator: { onLine: true, userAgent: 'Chrome' },
    location: { hostname: 'tools.itmatzip.com', search: '' },
    localStorage: { getItem() { return null; } },
    sessionStorage: { getItem: key => session.get(key), setItem: (key,value) => session.set(key,value) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: (el) => ({ display:
      (state.hiding && el.className.includes('adsbox')) ||
      (state.hideControl && el.className === 'itz-layout-check') ? 'none' : 'block', visibility: 'visible' }),
    setTimeout(fn, delay) { const id = ++seq; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, addEventListener,
    ItzSiteModal: {
      isAgentBlockDialogOpen: () => active === 'agent-block',
      isAdBlockDialogOpen: () => active === 'ad-block',
      showSiteDialog(options) { shown++; modalShown++; modalOptions = options; active = 'ad-block'; return new Promise(() => {}); },
      dismissActiveSiteModal() { dismissed++; active = null; },
    },
    __itmatzipGetAdSenseGuardSnapshot: () => state.snapshot,
    __itmatzipPageShowsAdCreative: () => false,
  });
  context.window = context;
  vm.runInContext(loader ? adsSource : guardSource, context);
  return { context, state, scripts, dispatchEvent,
    get shown() { return shown; }, get modalShown() { return modalShown; }, get modalOptions() { return modalOptions; }, get notice() { return notice; }, get dismissed() { return dismissed; },
    set active(value) { active = value; }, get active() { return active; },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a,b) => a[1].at-b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    },
    recheck() { context.__siteGuard.recheckAds(); },
  };
}

for (const [name, setup] of [
  ['network/CSP failure with blocker OFF', () => {}],
  ['slow loading', h => { h.state.snapshot.scriptUnavailable = false; h.state.hiding = true; }],
  ['loaded but no-fill with residual cosmetic rules', h => { h.state.snapshot.scriptLoaded = true; h.state.hiding = true; }],
  ['unfilled ad', h => { h.state.snapshot.unfilledCount = 1; h.state.hiding = true; }],
  ['ads disabled', h => { h.state.snapshot.adsDisabled = true; h.state.hiding = true; }],
  ['offline', h => { h.context.navigator.onLine = false; h.state.hiding = true; }],
  ['both control and ad probe hidden', h => { h.state.hiding = h.state.hideControl = true; }],
]) {
  test(`no wall: ${name}`, () => { const h=harness(); setup(h); h.advance(30000); assert.equal(h.shown,0); });
}

test('repeated selective hiding plus load failure shows blocking popup and verified recovery clears without filled ad', () => {
  const h=harness(); h.state.hiding=true;
  h.advance(12000); assert.equal(h.shown,0);
  h.advance(1500); assert.equal(h.shown,1);
  h.state.hiding=false; h.state.snapshot.scriptLoaded=true; h.state.snapshot.scriptUnavailable=false;
  h.advance(1500); assert.equal(h.dismissed,0); h.advance(3000);
  assert.equal(h.dismissed,1); assert.equal(h.active,null);
});
test('late library success clears popup without waiting for ad inventory', () => {
  const h=harness(); h.state.hiding=true; h.advance(14000);
  h.state.snapshot.scriptLoaded=true; h.state.snapshot.scriptUnavailable=false; h.state.hiding=false;
  h.dispatchEvent({type:'itz:adsense-script-state'});
  assert.equal(h.dismissed,0); h.advance(3000);
  assert.equal(h.dismissed,1);
});
test('clearing ad state never dismisses an agent dialog', () => {
  const h=harness(); h.active='agent-block'; h.context.__siteGuard.clearAdLatch();
  assert.equal(h.dismissed,0); assert.equal(h.active,'agent-block');
});
test('recovery cannot dismiss a different dialog that opened in place of the popup', () => {
  const h=harness(); h.state.hiding=true; h.advance(14000); h.active='agent-block';
  h.state.hiding=false; h.recheck(); assert.equal(h.active,'agent-block');
});
test('legacy script tag alone is not a failure even after grace period', () => {
  const h=harness({existing:true}); delete h.context.__itmatzipGetAdSenseGuardSnapshot;
  h.state.hiding=true; h.advance(30000); assert.equal(h.shown,0);
});
test('loader failure does not claim blocker, can retry and recover', async () => {
  const h=harness({loader:true});
  const first=h.context.ensureAdSenseScript();
  const rejected=assert.rejects(first,/cause unknown/);
  h.scripts[0].fire('error'); await rejected;
  assert.notEqual(h.context.__itmatzipAdSenseBlocked,true);
  assert.equal(h.scripts.length,0);
  await assert.rejects(h.context.ensureAdSenseScript(),/cooldown/);
  h.advance(5000);
  const retry=h.context.ensureAdSenseScript();
  assert.equal(h.context.ensureAdSenseScript(),retry);
  h.scripts[0].fire('load'); await retry;
  const snap=h.context.getAdSenseGuardSnapshot();
  assert.equal(snap.scriptLoaded,true); assert.equal(snap.scriptUnavailable,false);
});
test('existing loading script must wait for load event', async () => {
  const h=harness({loader:true,existing:true}); let settled=false;
  const promise=h.context.ensureAdSenseScript().then(()=>{settled=true;});
  await Promise.resolve(); assert.equal(settled,false);
  assert.equal(h.context.getAdSenseGuardSnapshot().scriptLoaded,false);
  h.scripts[0].fire('load'); await promise; assert.equal(settled,true);
});
test('stalled script times out without claiming ad blocking', async () => {
  const h=harness({loader:true}); const rejected=assert.rejects(h.context.ensureAdSenseScript());
  h.advance(20000); await rejected;
  assert.equal(h.context.getAdSenseGuardSnapshot().scriptUnavailable,true);
  assert.notEqual(h.context.__itmatzipAdSenseBlocked,true);
});

test('transient hiding does not latch', () => {
  const h=harness(); h.state.hiding=true; h.advance(12000);
  h.state.hiding=false; h.advance(1500); assert.equal(h.shown,0);
});
test('failed pre-existing script can be replaced on retry', async () => {
  const h=harness({loader:true,existing:true});
  const failure=assert.rejects(h.context.ensureAdSenseScript());
  h.scripts[0].fire('error'); await failure; assert.equal(h.scripts.length,0);
  h.advance(5000); const retry=h.context.ensureAdSenseScript();
  h.scripts[0].fire('load'); await retry;
  assert.equal(h.context.getAdSenseGuardSnapshot().scriptLoaded,true);
});

test('confirmed blocking opens a persistent popup with reload as the only action', () => {
  const h = harness();
  // A previous version's dismissed banner must not bypass the blocking dialog.
  h.context.sessionStorage.setItem('itz-ad-notice-dismissed', '1');
  h.state.hiding = true; h.advance(14000);
  assert.equal(h.modalShown, 1);
  assert.equal(h.modalOptions.persistent, true);
  assert.equal(h.modalOptions.dialogKind, 'ad-block');
  assert.deepEqual(Array.from(h.modalOptions.buttons, b => b.act), ['reload']);
  assert.equal(h.modalOptions.rebuild().persistent, true);
  h.advance(30000);
  assert.equal(h.active, 'ad-block');
  assert.equal(h.dismissed, 0);
});

async function flushNetwork() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function probeResponse(ok = true) { return { ok, text: async () => '/* itz-guard-check-v1 */' }; }
test('network-only filtering triggers persistent popup after two selective failures and recovers', async () => {
  let blocking = true;
  const h = harness({ network: async url => {
    if (blocking && url.includes('/ads/banner/')) throw new TypeError('Failed to fetch');
    return probeResponse();
  } });
  h.advance(12000); await flushNetwork(); assert.equal(h.shown, 0);
  h.advance(8000); await flushNetwork(); assert.equal(h.shown, 1);
  assert.equal(h.modalOptions.persistent, true);
  blocking = false; h.state.snapshot.scriptLoaded = true; h.state.snapshot.scriptUnavailable = false;
  h.advance(8000); await flushNetwork(); assert.equal(h.active, "ad-block");
  h.advance(8000); await flushNetwork(); h.advance(3000);
  assert.equal(h.active, null);
});
test('both network probes failing does not imply ad blocking', async () => {
  const h = harness({ network: async () => { throw new TypeError('offline'); } });
  h.advance(12000); await flushNetwork(); h.advance(10000); await flushNetwork();
  assert.equal(h.shown, 0);
});
test('missing ad probe on server does not imply ad blocking', async () => {
  const h = harness({ network: async url => probeResponse(!url.includes('/ads/banner/')) });
  h.advance(12000); await flushNetwork(); h.advance(10000); await flushNetwork();
  assert.equal(h.shown, 0);
});
test('CSP-blocked probe does not imply extension blocking', async () => {
  const h = harness({ network: async url => {
    if (url.includes('/ads/banner/')) throw new TypeError('CSP');
    return probeResponse();
  } });
  h.dispatchEvent({ type: 'securitypolicyviolation', blockedURI: 'https://tools.itmatzip.com/common/ads/banner/ads.js' });
  h.advance(12000); await flushNetwork(); h.advance(10000); await flushNetwork();
  assert.equal(h.shown, 0);
});
test('loaded library with pending ad requests still detects network-only filtering', async () => {
  const h = harness({ network: async url => {
    if (url.includes('/ads/banner/')) throw new TypeError('blocked');
    return probeResponse();
  } });
  h.state.snapshot.scriptLoaded = true;
  h.state.snapshot.scriptUnavailable = false;
  h.state.snapshot.pendingInsCount = 2;
  h.advance(12000); await flushNetwork(); h.advance(8000); await flushNetwork();
  assert.equal(h.shown, 1);
});

test('retry pending, hidden tab and offline never release a confirmed block', () => {
  const h=harness(); h.state.hiding=true; h.advance(14000);
  h.state.snapshot.scriptUnavailable=false;
  h.recheck(); h.advance(3000); assert.equal(h.dismissed,0);
  h.context.document.hidden=true; h.recheck(); assert.equal(h.dismissed,0);
  h.context.document.hidden=false; h.context.navigator.onLine=false;
  h.recheck(); assert.equal(h.dismissed,0);
  h.context.navigator.onLine=true; h.state.snapshot.scriptUnavailable=true;
  h.recheck(); assert.equal(h.shown,1);
});
test('brief healthy state cannot close and reopen the popup', () => {
  const h=harness(); h.state.hiding=true; h.advance(14000);
  h.state.hiding=false; h.state.snapshot.scriptLoaded=true; h.state.snapshot.scriptUnavailable=false;
  h.recheck(); h.advance(1000);
  h.state.hiding=true; h.state.snapshot.scriptLoaded=false; h.state.snapshot.scriptUnavailable=true;
  h.recheck(); h.advance(4000);
  assert.equal(h.dismissed,0); assert.equal(h.shown,1);
});
test('an inconclusive probe after confirmed blocking keeps the popup open', async () => {
  let unknown=false;
  const h=harness({network:async url => {
    if (unknown || url.includes('/ads/banner/')) throw new TypeError('failed');
    return probeResponse();
  }});
  h.advance(12000); await flushNetwork(); h.advance(8000); await flushNetwork();
  assert.equal(h.shown,1); unknown=true;
  h.advance(8000); await flushNetwork(); h.advance(4000);
  assert.equal(h.dismissed,0); assert.equal(h.shown,1);
});
