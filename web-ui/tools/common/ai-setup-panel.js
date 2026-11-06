/** Shared installation status for AI tools. The agent remains the source of truth. */
import { checkAgentConnection, fetchAgent, getAgentOrigin } from './bridge.js?v=lna26';
import { getAgentDownloadHref } from './agent-install-ui.js?v=lna22';
import { TOOLS, running, failed, setupRows, setupGatePhase } from './ai-setup-state.js?v=2';
const number = v => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
const mb = v => `${(v / 1048576).toFixed(0)} MB`;

async function json(path, method = 'GET') {
  const res = await fetchAgent(`${getAgentOrigin()}${path}`, { method, cache: 'no-store' });
  if (!res.ok) throw new Error(`설치 상태 요청 실패 (${res.status})`);
  return res.json();
}

export function mountAiSetupPanel(toolId) {
  const config = TOOLS[toolId];
  if (!config || document.getElementById('itz-ai-setup')) return;
  window.__itzSetupPanel = true;
  const root = document.createElement('aside');
  root.id = 'itz-ai-setup';
  root.className = 'itz-setup';
  root.setAttribute('aria-label', `${config.name} 설치 현황`);
  root.innerHTML = '<button type="button" class="itz-setup__head" aria-expanded="true"><span class="itz-setup__title"></span><span class="itz-setup__summary" role="status"></span></button><div class="itz-setup__body"></div>';
  document.body.append(root);
  const head = root.querySelector('.itz-setup__head');
  const body = root.querySelector('.itz-setup__body');
  root.querySelector('.itz-setup__title').textContent = `${config.name} 준비`;
  const gate = document.createElement('dialog');
  gate.className = 'itz-agent-gate';
  gate.setAttribute('aria-labelledby', 'itz-agent-gate-title');
  gate.setAttribute('aria-describedby', 'itz-agent-gate-description');
  gate.innerHTML = `<div class="itz-agent-gate__content">
    <div class="itz-agent-gate__eyebrow"><span class="itz-agent-gate__pulse" aria-hidden="true"></span> AI 도구 시작 준비</div>
    <h2 id="itz-agent-gate-title">로컬 에이전트를 연결해 주세요</h2>
    <p id="itz-agent-gate-description" class="itz-agent-gate__lead">${config.name}은 내 컴퓨터의 로컬 에이전트에서 실행됩니다. 에이전트를 설치하고 연결해야 AI 모델과 필수 라이브러리를 다운로드·설치할 수 있습니다.</p>
    <div class="itz-agent-gate__steps" data-agent-phase aria-label="준비 순서">
      <div class="itz-agent-gate__step"><span>01</span><strong>에이전트 설치</strong><small>설치 파일을 내려받아 실행</small></div>
      <div class="itz-agent-gate__step"><span>02</span><strong>에이전트 연결</strong><small>프로그램 실행 후 자동 확인</small></div>
      <div class="itz-agent-gate__step"><span>03</span><strong>AI 환경 준비</strong><small>모델·필수 라이브러리 설치</small></div>
    </div>
    <div class="itz-agent-gate__progress" data-setup-phase hidden><p class="itz-agent-gate__count"></p><div class="itz-agent-gate__rows"></div></div>
    <p class="itz-agent-gate__status" role="status" aria-live="polite"></p>
    <div class="itz-agent-gate__actions"><a class="itz-agent-gate__download" href="#">로컬 에이전트 다운로드</a><button type="button" class="itz-agent-gate__retry">연결 다시 확인</button></div>
    <p class="itz-agent-gate__footnote">준비가 완료되면 작업 화면이 자동으로 열립니다.</p>
  </div>`;
  document.body.append(gate);
  gate.addEventListener('cancel', event => event.preventDefault());
  const gateTitle = gate.querySelector('#itz-agent-gate-title');
  const gateDescription = gate.querySelector('#itz-agent-gate-description');
  const gateAgentSteps = gate.querySelector('[data-agent-phase]');
  const gateSetup = gate.querySelector('[data-setup-phase]');
  const gateCount = gate.querySelector('.itz-agent-gate__count');
  const gateRows = gate.querySelector('.itz-agent-gate__rows');
  const gateStatus = gate.querySelector('.itz-agent-gate__status');
  const gateDownload = gate.querySelector('.itz-agent-gate__download');
  const gateRetry = gate.querySelector('.itz-agent-gate__retry');
  gateDownload.addEventListener('click', event => { if (!agentHref) event.preventDefault(); });
  gateRetry.addEventListener('click', () => { if (error && !readiness) void tick(); else if (setupGatePhase(toolId, { agentOk, apiStarting, readiness, job, optionalJobs: [optional.gpuJob, optional.alignmentJob] }) === 'setup' && readiness && (failed(job) || autoStarted)) void start(true); else void tick(); });
  let expanded = true, readiness = null, job = null, agentOk = false, checkedAgent = false, apiStarting = false, busy = false, stopped = false, autoStarted = false, readyNotified = false, collapsedOnReady = false, legacySilence = false, error = '', optional = {}, lastOptionalAt = 0, agentHref = '';
  void getAgentDownloadHref().then(href => { agentHref = href; render(); }).catch(() => {});
  head.addEventListener('click', () => { expanded = !expanded; body.hidden = !expanded; head.setAttribute('aria-expanded', String(expanded)); });
  function addRow(label, state, detail = '', action = null, pct = null, container = body) {
    const row = document.createElement('div'); row.className = 'itz-setup__row';
    const line = document.createElement('div'); line.className = 'itz-setup__line';
    const name = document.createElement('span'); name.className = 'itz-setup__name'; name.textContent = label;
    const stateEl = document.createElement('span'); stateEl.className = 'itz-setup__state'; stateEl.textContent = state;
    line.append(name, stateEl); row.append(line);
    if (detail) { const p = document.createElement('p'); p.className = `itz-setup__detail${error && detail === error ? ' itz-setup__error' : ''}`; p.textContent = detail; row.append(p); }
    if (pct !== null) { const track = document.createElement('div'); track.className = 'itz-setup__bar'; track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', label); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100'); track.setAttribute('aria-valuenow', String(Math.round(pct))); const fill = document.createElement('div'); fill.className = 'itz-setup__fill'; fill.style.width = `${pct}%`; track.append(fill); row.append(track); }
    if (action) { const wrap = document.createElement('div'); wrap.className = 'itz-setup__actions'; wrap.append(action); row.append(wrap); }
    container.append(row);
  }
  function button(label, fn) { const el = document.createElement('button'); el.type = 'button'; el.className = 'itz-setup__action'; el.textContent = label; el.addEventListener('click', fn); return el; }
  function downloadLink() { const el = document.createElement('a'); el.className = 'itz-setup__action'; el.textContent = agentHref ? '에이전트 다운로드' : '다운로드 준비 중'; el.href = agentHref || '#'; if (agentHref) { el.target = '_blank'; el.rel = 'noopener noreferrer'; } else { el.setAttribute('aria-disabled', 'true'); el.addEventListener('click', e => e.preventDefault()); } return el; }
  function renderGate() {
    const phase = setupGatePhase(toolId, { agentOk, apiStarting, readiness, job, optionalJobs: [optional.gpuJob, optional.alignmentJob] });
    const blocked = phase !== 'ready';
    root.hidden = blocked;
    if (!blocked) { if (gate.open) gate.close(); return; }
    if (!gate.open) gate.showModal();
    const agentPhase = phase === 'agent';
    gateAgentSteps.hidden = !agentPhase;
    gateSetup.hidden = agentPhase;
    const upgrade = !agentPhase && /\(404\)/.test(error);
    gateTitle.textContent = agentPhase ? '로컬 에이전트를 연결해 주세요' : upgrade ? '로컬 에이전트를 업데이트해 주세요' : `${config.name} 준비 중`;
    gateDescription.textContent = agentPhase
      ? `${config.name}은 내 컴퓨터의 로컬 에이전트에서 실행됩니다. 에이전트를 설치하고 연결해야 AI 모델과 필수 라이브러리를 다운로드·설치할 수 있습니다.`
      : upgrade ? '현재 에이전트에서 이 도구의 설치 상태를 확인할 수 없습니다. 최신 에이전트를 설치한 뒤 다시 연결해 주세요.' : '필수 AI 모델과 라이브러리를 내 컴퓨터에 설치하고 있습니다. 준비가 완료되면 작업 화면이 자동으로 열립니다.';
    gateStatus.textContent = agentPhase
      ? !checkedAgent ? '로컬 에이전트 연결을 확인하고 있습니다…' : apiStarting ? '에이전트가 연결되었습니다. AI 서비스를 시작하고 있습니다…' : error || '에이전트 연결을 기다리고 있습니다. 설치 후 실행하면 자동으로 감지합니다.'
      : error || (running(optional.gpuJob) ? optional.gpuJob.stage || optional.gpuJob.step : '') || (running(optional.alignmentJob) ? optional.alignmentJob.stage || optional.alignmentJob.step : '') || job?.step || job?.stage || job?.message || (readiness ? '필수 항목을 확인하고 있습니다…' : '설치 상태를 확인하고 있습니다…');
    gateStatus.classList.toggle('itz-agent-gate__status--error', !!error);
    gateDownload.hidden = (agentPhase && apiStarting) || (!agentPhase && !upgrade);
    gateDownload.textContent = agentHref ? '로컬 에이전트 다운로드' : '다운로드 링크 확인 중…';
    gateDownload.href = agentHref || '#';
    gateDownload.setAttribute('aria-disabled', String(!agentHref));
    if (agentHref) { gateDownload.target = '_blank'; gateDownload.rel = 'noopener noreferrer'; }
    gateRetry.textContent = agentPhase || upgrade ? '연결 다시 확인' : failed(job) ? '설치 다시 시도' : '상태 다시 확인';
    gateRetry.hidden = !agentPhase && (running(job) || running(optional.gpuJob) || running(optional.alignmentJob));
    if (!agentPhase) {
      gateRows.replaceChildren();
      const rows = setupRows(toolId, readiness, job);
      gateCount.textContent = `필수 항목 ${rows.filter(row => row.state === 'ready').length} / ${rows.length} 완료`;
      if (error && !readiness) addRow('설치 상태 확인', '확인 필요', error, null, null, gateRows);
      else {
        const bytesDone = Number(job?.bytesDone ?? job?.bytes_done);
        const bytesTotal = Number(job?.bytesTotal ?? job?.bytes_total);
        const overallPct = number(job?.percent ?? job?.progress ?? job?.pct);
        for (const row of rows) {
          const hasBytes = row.state === 'running' && bytesTotal > 0 && bytesDone >= 0 && /다운로드/.test(String(job?.step || job?.stage || ''));
          const pct = hasBytes ? number(bytesDone / bytesTotal * 100) : null;
          const size = hasBytes ? `${mb(bytesDone)} / ${mb(bytesTotal)}` : '';
          const detail = row.state === 'running' ? [job?.step || job?.stage || job?.message || '설치 중', size, !hasBytes && overallPct !== null ? `전체 준비 ${Math.round(overallPct)}%` : ''].filter(Boolean).join(' · ') : row.state === 'failed' ? error || job?.error || '설치에 실패했습니다.' : '';
          addRow(row.label, row.state === 'ready' ? '완료' : row.state === 'running' ? '진행 중' : row.state === 'failed' ? '실패' : '대기', detail, null, pct, gateRows);
        }
      }
      for (const [label, optionalJob] of [['GPU 가속', optional.gpuJob], ['정밀 정렬 AI 모델', optional.alignmentJob]]) {
        if (running(optionalJob)) addRow(label, '진행 중', optionalJob.stage || optionalJob.step || '설치 중', null, number(optionalJob.pct ?? optionalJob.percent), gateRows);
      }
    }
  }
  function render() {
    renderGate();
    body.replaceChildren();
    const rows = setupRows(toolId, readiness, job);
    const complete = rows.filter(r => r.state === 'ready').length;
    root.querySelector('.itz-setup__summary').textContent = !agentOk ? error ? '연결 설정 확인' : checkedAgent ? '에이전트 설치·실행 필요' : '에이전트 연결 확인' : apiStarting ? 'API 시작 중' : error && !readiness ? '확인 필요' : readiness && config.ready(readiness) ? '준비 완료' : `${complete}/${rows.length} 완료`;
    if (!agentOk) return;
    addRow('로컬 에이전트', apiStarting ? 'API 시작 중' : '연결됨');
    if (apiStarting) return;
    if (error && !readiness) {
      const upgrade = /\(404\)/.test(error);
      const action = upgrade ? downloadLink() : button('다시 확인', () => void tick());
      addRow(upgrade ? '에이전트 업데이트 필요' : '준비 상태 확인 실패', '확인 필요', error, action);
      return;
    }
    const overallPct = number(job?.percent ?? job?.progress ?? job?.pct);
    const bytesDone = Number(job?.bytesDone ?? job?.bytes_done);
    const bytesTotal = Number(job?.bytesTotal ?? job?.bytes_total);
    const size = Number.isFinite(bytesDone) && bytesDone > 0 ? `${mb(bytesDone)}${bytesTotal > 0 ? ` / ${mb(bytesTotal)}` : ''}` : '';
    const firstMissing = rows.find(row => row.state !== 'ready')?.key;
    for (const row of rows) {
      const hasBytes = row.state === 'running' && bytesTotal > 0 && bytesDone >= 0 && /다운로드/.test(String(job?.step || job?.stage || ''));
      const pct = hasBytes ? number(bytesDone / bytesTotal * 100) : null;
      const retry = row.state === 'failed' || row.state === 'waiting' && row.key === firstMissing && autoStarted && !running(job);
      const detail = row.state === 'running' ? [job?.step || job?.stage || job?.message || '설치 중', size, !hasBytes && overallPct !== null ? `전체 준비 ${Math.round(overallPct)}%` : ''].filter(Boolean).join(' · ') : row.state === 'failed' ? error || job?.error || '설치에 실패했습니다.' : retry ? '설치 상태를 확인해 주세요.' : '';
      const action = retry ? button('다시 시도', () => void start(true)) : null;
      addRow(row.label, row.state === 'ready' ? '완료' : row.state === 'running' ? '진행 중' : row.state === 'failed' ? '실패' : '대기', detail, action, row.state === 'running' ? pct : null);
    }
    if (toolId === 'auto-subtitle' && readiness?.engineReady) addOptionalRows();
  }
  function addOptionalRows() {
    const label = document.createElement('p'); label.className = 'itz-setup__optional'; label.textContent = '선택 설치'; body.append(label);
    if (optional.gpu?.nvidiaPresent) {
      const active = running(optional.gpuJob);
      const hasFailed = failed(optional.gpuJob);
      const action = !optional.gpu.installed && !active && optional.gpu.canInstall ? button(hasFailed ? '다시 시도' : '설치', () => void startOptional('gpu')) : null;
      addRow('GPU 가속', optional.gpu.installed ? '완료' : active ? '진행 중' : hasFailed ? '실패' : '선택', active ? optional.gpuJob.stage || '' : hasFailed ? optional.gpuJob.error || '' : '', action, active ? number(optional.gpuJob.pct) : null);
    }
    if (optional.alignment) {
      const active = running(optional.alignmentJob);
      const hasFailed = failed(optional.alignmentJob);
      const action = !optional.alignment.ready && !active ? button(hasFailed ? '다시 시도' : '설치', () => void startOptional('alignment')) : null;
      addRow('정밀 정렬 AI 모델', optional.alignment.ready ? '완료' : active ? '진행 중' : hasFailed ? '실패' : '선택', active ? optional.alignmentJob.stage || '' : hasFailed ? optional.alignmentJob.error || '' : '', action, active ? number(optional.alignmentJob.pct) : null);
    }
  }
  async function startOptional(kind) {
    const path = kind === 'gpu' ? '/gpu/install' : '/alignment/install';
    optional[`${kind}Job`] = { state: 'running', stage: '설치 시작' }; render();
    try { optional[`${kind}Job`] = await json(config.base + path, 'POST'); error = ''; }
    catch (e) { error = e instanceof Error ? e.message : String(e); optional[`${kind}Job`] = { state: 'error', error }; }
    render();
  }
  async function start(force = false) {
    if (busy || !agentOk) return;
    busy = true; error = ''; job = { state: 'running', step: '설치 시작' }; render();
    try {
      job = await json(config.base + (legacySilence ? '/prepare' : config.job) + (force && toolId !== 'auto-subtitle' && !legacySilence ? '?force=true' : ''), 'POST');
      if (legacySilence) job = { state: 'done', step: '완료' };
    }
    catch (e) { error = e instanceof Error ? e.message : String(e); job = { state: 'error', error }; }
    finally { busy = false; render(); }
  }
  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      const agent = await checkAgentConnection(); checkedAgent = true; agentOk = !!agent.ok; apiStarting = agentOk && agent.apiReady === false;
      if (!agentOk) { error = agent.failureKind === 'client_blocked' ? '브라우저의 로컬 네트워크 접근을 허용해 주세요.' : ''; readiness = null; job = null; autoStarted = false; readyNotified = false; render(); return; }
      if (apiStarting) { render(); return; }
      error = '';
      job = await json(config.base + (config.jobStatus || config.job + (toolId === 'auto-subtitle' ? '' : '/status'))).catch(e => {
        if (toolId === 'silence-remover' && /\(404\)/.test(String(e))) legacySilence = true;
        return legacySilence ? job : null;
      });
      try { readiness = await json(config.base + config.status); }
      catch (e) { if (!running(job) || !readiness) throw e; }
      if (toolId === 'auto-subtitle' && readiness.engineReady && (Date.now() - lastOptionalAt > 5000 || running(optional.gpuJob) || running(optional.alignmentJob))) {
        const results = await Promise.allSettled(['/gpu', '/alignment', '/gpu/install', '/alignment/install'].map(path => json(config.base + path)));
        ['gpu', 'alignment', 'gpuJob', 'alignmentJob'].forEach((key, i) => { if (results[i].status === 'fulfilled') optional[key] = results[i].value; });
        lastOptionalAt = Date.now();
      }
      if (readiness?.ok === false) throw new Error(readiness.error || '준비 상태를 확인하지 못했습니다.');
      render();
      if (config.ready(readiness)) {
        autoStarted = true;
        if (!readyNotified) { readyNotified = true; window.dispatchEvent(new CustomEvent('itz:ai-setup-ready', { detail: { toolId } })); }
        if (!collapsedOnReady && expanded && !running(job) && !running(optional.gpuJob) && !running(optional.alignmentJob)) { collapsedOnReady = true; expanded = false; body.hidden = true; head.setAttribute('aria-expanded', 'false'); }
      } else {
        readyNotified = false;
        if (!running(job) && !failed(job) && !autoStarted) { autoStarted = true; busy = false; await start(); }
      }
    } catch (e) { error = e instanceof Error ? e.message : String(e); render(); }
    finally { busy = false; }
  }
  render(); void tick();
  const timer = window.setInterval(() => { if (!document.hidden) void tick(); }, 1500);
  window.addEventListener('pagehide', () => { stopped = true; window.clearInterval(timer); }, { once: true });
  window.addEventListener('focus', () => void tick());
}

const toolId = document.currentScript?.dataset?.tool || location.pathname.split('/').filter(Boolean).at(-1);
if (toolId) mountAiSetupPanel(toolId === 'fixed-area-remover' ? 'watermark-remover' : toolId);
