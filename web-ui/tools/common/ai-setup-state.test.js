import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { TOOLS, setupRows, setupGatePhase, running, failed } from './ai-setup-state.js';

test('all nine AI sites have a tool-specific setup definition', () => {
  assert.equal(Object.keys(TOOLS).length, 9);
  for (const [id, config] of Object.entries(TOOLS)) {
    assert.ok(config.base.startsWith('/api/tools/'), id);
    assert.ok(config.parts.length > 0, id);
    assert.equal(typeof config.ready, 'function', id);
  }
});

test('all AI entry pages load the common panel before their tool script', () => {
  for (const id of Object.keys(TOOLS)) {
    const dir = id === 'watermark-remover' ? 'fixed-area-remover' : id;
    const html = readFileSync(new URL(`../${dir}/index.html`, import.meta.url), 'utf8');
    const panelAt = html.indexOf('ai-setup-panel.js');
    assert.ok(panelAt > 0, dir);
    assert.ok(html.indexOf('ai-setup-panel.css') > 0, dir);
    assert.ok(panelAt < html.lastIndexOf('script.js') || dir === 'auto-subtitle', dir);
  }
});

test('the shared panel parses as a browser module', () => {
  const source = readFileSync(new URL('./ai-setup-panel.js', import.meta.url), 'utf8');
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('AutoSubtitle reports actual completed prerequisites and the active model', () => {
  const rows = setupRows('auto-subtitle', { packagesOk: true, ffmpegOk: true, modelPresent: false },
    { state: 'running', step: 'Whisper 모델 다운로드' });
  assert.deepEqual(rows.map(row => row.state), ['ready', 'ready', 'running']);
});

test('failed and running phases remain distinct from waiting rows', () => {
  assert.equal(running({ phase: 'downloading_models' }), true);
  assert.equal(failed({ phase: 'failed' }), true);
  const rows = setupRows('voice-changer', { binaries: { ffmpeg: true, torch: true, pip_stack: false } },
    { phase: 'failed', step: '패키지 설치' });
  assert.equal(rows[0].state, 'ready');
  assert.equal(rows[1].state, 'ready');
  assert.equal(rows.filter(row => row.state === 'failed').length, 1);
});

test('all AI tools block work until required setup is complete', () => {
  for (const [toolId, config] of Object.entries(TOOLS)) {
    const ready = { binaries: {}, all_ready: true, engineReady: true, packagesOk: true, ffmpegOk: true, modelPresent: true };
    for (const [key] of config.parts) ready.binaries[key] = true;
    assert.equal(setupGatePhase(toolId), 'agent', toolId);
    assert.equal(setupGatePhase(toolId, { agentOk: true, readiness: null }), 'setup', toolId);
    assert.equal(setupGatePhase(toolId, { agentOk: true, readiness: {} }), 'setup', toolId);
    assert.equal(setupGatePhase(toolId, { agentOk: true, readiness: ready, job: { state: 'running' } }), 'setup', toolId);
    assert.equal(setupGatePhase(toolId, { agentOk: true, readiness: ready }), 'ready', toolId);
  }
  assert.equal(setupGatePhase('auto-subtitle', { agentOk: true, readiness: { engineReady: true }, optionalJobs: [{ state: 'running' }] }), 'setup');
});
