import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const guardSource = readFileSync(new URL('./site-guard.js', import.meta.url), 'utf8');
const adsSource = readFileSync(new URL('./adsense.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/m, '').replaceAll('export ', '');

function harness({ loader = false, existing = false } = {}) {
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
  const document = { hidden: false, visibilityState: 'visible', readyState: 'complete',
    addEventListener, dispatchEvent, createElement,
    body: { appendChild(el) { if (el.tag === 'aside') { shown++; notice = el; } } }, head: { appendChild(el) { scripts.push(el); } },
    documentElement: { getAttribute() { return ''; } },
    querySelectorAll() { return []; },
    querySelector(selector) { return selector.startsWith('script') ? scripts[0] || null : null; },
    getElementById() { return null; },
  };
  const context = vm.createContext({ document, console, URLSearchParams,
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

test('repeated selective hiding plus load failure shows blocking popup and OFF clears without filled ad', () => {
  const h=harness(); h.state.hiding=true;
  h.advance(12000); assert.equal(h.shown,0);
  h.advance(1500); assert.equal(h.shown,1);
  h.state.hiding=false; h.advance(1500);
  assert.equal(h.dismissed,1); assert.equal(h.active,null);
});
test('late library success clears popup without waiting for ad inventory', () => {
  const h=harness(); h.state.hiding=true; h.advance(14000);
  h.state.snapshot.scriptLoaded=true;
  h.dispatchEvent({type:'itz:adsense-script-state'});
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
