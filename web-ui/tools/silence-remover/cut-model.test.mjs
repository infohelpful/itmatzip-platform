import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCut, addSplit, buildSegments, commitCuts, cutFrameTotal, cutsToSegments, editsEqual, findCutAt, findCutAtSec,
  formatClock, keepsFromCuts, moveBoundary, moveCut, moveEdge, normalizeCuts, parseFps, programFrameAt, removeCut,
  secToFrame, segmentIndexAt, segmentsToCuts, setRangeCut, subtractRange,
} from './cut-model.js';

const NTSC = { num: 30000, den: 1001 };

test('parseFps reads rationals and maps NTSC decimals', () => {
  assert.deepEqual(parseFps('30000/1001'), NTSC);
  assert.deepEqual(parseFps('', 29.97), NTSC);
  assert.deepEqual(parseFps(null, 23.976), { num: 24000, den: 1001 });
  assert.deepEqual(parseFps('25'), { num: 25, den: 1 });
  assert.deepEqual(parseFps('2997/100'), NTSC);
  assert.deepEqual(parseFps('25/1'), { num: 25, den: 1 });
  assert.deepEqual(parseFps(null, 30), { num: 30, den: 1 });
  assert.equal(parseFps('0/1'), null);
  assert.equal(parseFps('', 0), null);
});

test('segmentsToCuts snaps to frames and merges touching ranges', () => {
  const cuts = segmentsToCuts(
    [{ start_sec: 1.0, end_sec: 2.0 }, { start_sec: 2.0, end_sec: 2.5 }, { start_sec: 5, end_sec: 99 }],
    { num: 30, den: 1 }, 300,
  );
  assert.deepEqual(cuts, [[30, 75], [150, 300]]);
  assert.deepEqual(cutsToSegments([[30, 75]], { num: 30, den: 1 }), [{ start_sec: 1, end_sec: 2.5 }]);
});

test('keepsFromCuts is the complement', () => {
  assert.deepEqual(keepsFromCuts([[0, 10], [20, 30]], 50), [[10, 20], [30, 50]]);
  assert.deepEqual(keepsFromCuts([], 50), [[0, 50]]);
  assert.deepEqual(keepsFromCuts([[0, 50]], 50), []);
  assert.equal(cutFrameTotal([[0, 10], [20, 30]]), 20);
});

test('findCutAt / findCutAtSec use half-open ranges', () => {
  const cuts = [[10, 20], [40, 41], [90, 100]];
  assert.equal(findCutAt(cuts, 9), -1);
  assert.equal(findCutAt(cuts, 10), 0);
  assert.equal(findCutAt(cuts, 19), 0);
  assert.equal(findCutAt(cuts, 20), -1);
  assert.equal(findCutAt(cuts, 40), 1);
  assert.equal(findCutAt(cuts, 99), 2);
  const fps = { num: 10, den: 1 };
  assert.equal(findCutAtSec(cuts, fps, 1.0), 0);
  assert.equal(findCutAtSec(cuts, fps, 1.99), 0);
  assert.equal(findCutAtSec(cuts, fps, 2.0), -1);
  assert.equal(findCutAtSec(cuts, fps, 4.05), 1);
});

test('programFrameAt subtracts earlier cuts', () => {
  const cuts = [[10, 20], [40, 50]];
  assert.equal(programFrameAt(cuts, 5), 5);
  assert.equal(programFrameAt(cuts, 15), 10);
  assert.equal(programFrameAt(cuts, 30), 20);
  assert.equal(programFrameAt(cuts, 60), 40);
});

test('moveEdge clamps against neighbours and keeps one frame between cuts', () => {
  const cuts = [[10, 20], [30, 40]];
  assert.deepEqual(moveEdge(cuts, 1, 'start', 5, 100), [[10, 20], [21, 40]]);
  assert.deepEqual(moveEdge(cuts, 0, 'end', 99, 100), [[10, 29], [30, 40]]);
  assert.deepEqual(moveEdge(cuts, 0, 'start', -5, 100), [[0, 20], [30, 40]]);
  assert.deepEqual(moveEdge(cuts, 1, 'end', 500, 100), [[10, 20], [30, 100]]);
  // shrinking to zero is allowed while dragging, then removed on commit
  const zero = moveEdge(cuts, 0, 'end', 3, 100);
  assert.deepEqual(zero, [[10, 10], [30, 40]]);
  assert.deepEqual(commitCuts(zero, 100), [[30, 40]]);
  assert.deepEqual(cuts, [[10, 20], [30, 40]], 'input is not mutated');
});

test('moveCut keeps length and stays between neighbours', () => {
  const cuts = [[10, 20], [30, 40], [60, 70]];
  assert.deepEqual(moveCut(cuts, 1, 5, 100), [[10, 20], [35, 45], [60, 70]]);
  assert.deepEqual(moveCut(cuts, 1, 100, 100), [[10, 20], [49, 59], [60, 70]]);
  assert.deepEqual(moveCut(cuts, 1, -100, 100), [[10, 20], [21, 31], [60, 70]]);
  assert.deepEqual(moveCut(cuts, 0, -50, 100), [[0, 10], [30, 40], [60, 70]]);
  assert.deepEqual(moveCut(cuts, 2, 99, 100), [[10, 20], [30, 40], [90, 100]]);
  assert.deepEqual(cuts, [[10, 20], [30, 40], [60, 70]], 'input is not mutated');
});

test('addCut merges overlaps; removeCut drops one', () => {
  assert.deepEqual(addCut([[10, 20], [30, 40]], 18, 32, 100), [[10, 40]]);
  assert.deepEqual(addCut([[10, 20]], 60, 50, 100), [[10, 20], [50, 60]]);
  assert.deepEqual(removeCut([[10, 20], [30, 40]], 0), [[30, 40]]);
  assert.deepEqual(normalizeCuts([[5, 5], [-3, 2], [90, 120]], 100), [[0, 2], [90, 100]]);
});

test('buildSegments splits the timeline at cut edges and blade lines', () => {
  const segs = buildSegments([[10, 20]], [5, 15], 30);
  assert.deepEqual(segs, [
    { start: 0, end: 5, cut: false },
    { start: 5, end: 10, cut: false },
    { start: 10, end: 15, cut: true },
    { start: 15, end: 20, cut: true },
    { start: 20, end: 30, cut: false },
  ]);
  assert.equal(segmentIndexAt(segs, 0), 0);
  assert.equal(segmentIndexAt(segs, 14), 2);
  assert.equal(segmentIndexAt(segs, 15), 3);
  assert.equal(segmentIndexAt(segs, 30), 4);
});

test('setRangeCut lifts and restores a bladed piece, keeping its edges', () => {
  let s = { cuts: [], splits: [] };
  s = addSplit(s, 10, 100);
  s = addSplit(s, 20, 100);
  s = setRangeCut(s, 10, 20, true, 100);
  assert.deepEqual(s, { cuts: [[10, 20]], splits: [10, 20] });
  // restore half of a cut after blading inside it
  s = addSplit(s, 15, 100);
  s = setRangeCut(s, 15, 20, false, 100);
  assert.deepEqual(s.cuts, [[10, 15]]);
  // lifting a neighbour merges the cuts but the blade line stays as a boundary
  s = setRangeCut(s, 15, 20, true, 100);
  assert.deepEqual(s.cuts, [[10, 20]]);
  assert.equal(buildSegments(s.cuts, s.splits, 100).filter((g) => g.cut).length, 2);
  assert.deepEqual(subtractRange([[0, 10], [20, 30]], 5, 25), [[0, 5], [25, 30]]);
});

test('moveBoundary trims into a cut to restore it, and back out to cut more', () => {
  const base = { cuts: [[30, 60]], splits: [] };
  const restored = moveBoundary(base, 30, 40, 100);
  assert.deepEqual(restored.cuts, [[40, 60]]);
  const fully = moveBoundary(base, 60, 30, 100);
  assert.deepEqual(fully.cuts, [], 'dragging the right edge onto the left restores the whole cut');
  const more = moveBoundary(base, 30, 10, 100);
  assert.deepEqual(more.cuts, [[10, 60]]);
  // clamped to the neighbouring segments
  const s = { cuts: [[30, 60]], splits: [20] };
  assert.deepEqual(moveBoundary(s, 30, 0, 100).cuts, [[20, 60]]);
  // a blade line between two kept pieces only moves the line
  const roll = moveBoundary({ cuts: [], splits: [50] }, 50, 70, 100);
  assert.deepEqual(roll, { cuts: [], splits: [70] });
  assert.ok(editsEqual(base, { cuts: [[30, 60]], splits: [] }));
});

test('secToFrame round-trips NTSC frames', () => {
  for (const f of [0, 1, 29, 30, 1799, 107892]) {
    assert.equal(secToFrame((f * 1001) / 30000, NTSC), f);
  }
});

test('formatClock', () => {
  assert.equal(formatClock(1.5), '0:01.50');
  assert.equal(formatClock(3725.2), '1:02:05.20');
  assert.equal(formatClock(-1), '0:00.00');
});
