import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePaddedSilenceColumnRanges, drawSilenceWaveform,
  exportSilenceTimeSegments, WaveformRenderer,
} from './waveform-canvas.js';

globalThis.window = { devicePixelRatio: 1, innerWidth: 800 };
const data = {
  peaks: [1, 0.001, 0.001, 1], peaks_db: [-1, -70, -70, -1],
  timeline_sec: 4, column_count: 4, mean_volume_db: -20,
};
function canvasStub() {
  const fills = [];
  const ctx = new Proxy({ fillRect(...args) { fills.push({ color: this.fillStyle, args }); } }, {
    get(target, key) { return key in target ? target[key] : () => {}; },
  });
  return { canvas: { clientWidth: 400, style: {}, getContext: () => ctx }, fills };
}

test('explicit empty detector results never infer silence from quiet peaks', () => {
  assert.deepEqual(computePaddedSilenceColumnRanges(data, {
    rawSilences: [], paddingMs: 100, minSilenceSec: 0.3,
  }), []);
  for (const opts of [{ silenceTimeSegments: [] }, { silenceColumnRanges: [] }]) {
    const { canvas, fills } = canvasStub();
    drawSilenceWaveform(canvas, data, {
      noiseDb: -30, minSilenceSec: 0.3, pxPerSec: 100, canvasWidth: 400,
      showRuler: false, showSilenceOverlay: true, flattenSilence: true, ...opts,
    });
    assert.equal(fills.filter(f => f.color === 'rgba(244, 63, 94, 0.16)').length, 0);
  }
});

test('overlay uses exact time positions at different zoom/scroll positions', () => {
  for (const [pxPerSec, scrollLeftPx] of [[100, 0], [250, 200], [50, 0]]) {
    const { canvas, fills } = canvasStub();
    drawSilenceWaveform(canvas, data, {
      noiseDb: -30, minSilenceSec: 0.3, pxPerSec, scrollLeftPx,
      canvasWidth: 600, showRuler: false, showSilenceOverlay: true,
      silenceTimeSegments: [{ start_sec: 1.2, end_sec: 1.8 }],
    });
    const overlays = fills.filter(f => f.color === 'rgba(244, 63, 94, 0.16)');
    assert.equal(overlays.length, 1);
    assert.equal(overlays[0].args[0], Math.floor(1.2 * pxPerSec - scrollLeftPx));
    assert.equal(overlays[0].args[2], Math.ceil(1.8 * pxPerSec - scrollLeftPx) - overlays[0].args[0]);
  }
});

test('renderer preserves quiet audio outside actual cuts', () => {
  const renderer = WaveformRenderer.fromPeaks(data.peaks, data.timeline_sec, data.peaks_db);
  let rendered;
  renderer._drawWaveform = (_ctx, _w, _h, peaks, silent) => { rendered = { peaks, silent }; };
  const { canvas } = canvasStub();
  renderer.render(canvas, {
    pxPerSec: 100, canvasWidth: 400, showRuler: false, flattenSilence: true,
    silenceThresholdDb: -30, silenceTimeSegments: [{ start_sec: 2, end_sec: 3 }],
  });
  assert.equal(rendered.silent[150], 0);
  assert.ok(rendered.peaks[150] > 0);
  assert.equal(rendered.silent[250], 1);
});

test('export overlay is the complement of frame-rounded XML source clips', () => {
  assert.deepEqual(exportSilenceTimeSegments([[1000, 3000], [5000, 9000]], 10, 30), [
    { start_sec: 0, end_sec: 1 }, { start_sec: 3, end_sec: 5 }, { start_sec: 9, end_sec: 10 },
  ]);
  assert.deepEqual(exportSilenceTimeSegments([[0, 10000]], 10, 30), []);
  assert.deepEqual(exportSilenceTimeSegments([], 10, 30), [{ start_sec: 0, end_sec: 10 }]);
  assert.deepEqual(exportSilenceTimeSegments([[250, 1250]], 2, 2), [{ start_sec: 1, end_sec: 2 }]);
});
