/**
 * 컷 편집 모델 (순수 함수). 모든 경계는 편집 FPS 프레임 정수이고, 컷은 [a, b) 로 정렬·겹침 없음.
 * 설계: docs/silence-remover-cut-editor-spec.md §3
 */

/** @typedef {{ num: number, den: number }} Fps */
/** @typedef {[number, number]} Range */

const NTSC_BASES = [24, 30, 48, 60, 120];

/**
 * "30000/1001" 또는 29.97 → { num, den }
 * @param {string | null | undefined} rational
 * @param {number} [fallback]
 * @returns {Fps | null}
 */
export function parseFps(rational, fallback) {
  const s = String(rational ?? "").trim();
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
  if (m) {
    const num = Number(m[1]);
    const den = Number(m[2]);
    if (num > 0 && den > 0 && num / den <= 240) return snapNtsc({ num, den });
  }
  const f = Number(s && !m ? s : fallback);
  if (!Number.isFinite(f) || f <= 0 || f > 240) return null;
  if (Number.isInteger(f)) return { num: f, den: 1 };
  return snapNtsc({ num: Math.round(f * 1000), den: 1000 });
}

/** 29.97(2997/100) · 23.976 · 59.94 처럼 NTSC 에 가까운 값은 ×1000/1001 분수로 맞춘다. @param {Fps} fps */
function snapNtsc(fps) {
  const f = fps.num / fps.den;
  for (const base of NTSC_BASES) {
    if (Math.abs(f - (base * 1000) / 1001) < 0.006 && Math.abs(f - base) > 1e-9) {
      return { num: base * 1000, den: 1001 };
    }
  }
  return fps;
}

/** @param {Fps} fps */
export function fpsString(fps) {
  return `${fps.num}/${fps.den}`;
}

/** @param {number} sec @param {Fps} fps */
export function secToFrame(sec, fps) {
  return Math.round((sec * fps.num) / fps.den);
}

/** @param {number} frame @param {Fps} fps */
export function frameToSec(frame, fps) {
  return (frame * fps.den) / fps.num;
}

/**
 * 정렬하고, 겹치거나 맞닿은 컷은 합치고, [0, total] 로 자르고, 길이 0 은 버린다.
 * @param {Range[]} cuts @param {number} totalFrames
 * @returns {Range[]}
 */
export function normalizeCuts(cuts, totalFrames) {
  const sorted = cuts
    .map(([a, b]) => [Math.max(0, Math.round(a)), Math.min(totalFrames, Math.round(b))])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  /** @type {Range[]} */
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * 분석 무음 구간(초) → 컷(프레임)
 * @param {Array<{ start_sec: number, end_sec: number }>} segments
 * @param {Fps} fps @param {number} totalFrames
 */
export function segmentsToCuts(segments, fps, totalFrames) {
  return normalizeCuts(
    (segments || []).map((s) => [secToFrame(Number(s.start_sec) || 0, fps), secToFrame(Number(s.end_sec) || 0, fps)]),
    totalFrames,
  );
}

/** @param {Range[]} cuts @param {Fps} fps */
export function cutsToSegments(cuts, fps) {
  return cuts.map(([a, b]) => ({ start_sec: frameToSec(a, fps), end_sec: frameToSec(b, fps) }));
}

/** @param {Range[]} cuts @param {number} totalFrames @returns {Range[]} */
export function keepsFromCuts(cuts, totalFrames) {
  /** @type {Range[]} */
  const keeps = [];
  let cursor = 0;
  for (const [a, b] of cuts) {
    if (a > cursor) keeps.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < totalFrames) keeps.push([cursor, totalFrames]);
  return keeps;
}

/** @param {Range[]} cuts */
export function cutFrameTotal(cuts) {
  return cuts.reduce((sum, [a, b]) => sum + (b - a), 0);
}

/**
 * frame 을 포함하는 컷 index (없으면 -1). 이진 탐색.
 * @param {Range[]} cuts @param {number} frame
 */
export function findCutAt(cuts, frame) {
  let lo = 0;
  let hi = cuts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = cuts[mid];
    if (frame < a) hi = mid - 1;
    else if (frame >= b) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * 시간 t(초)가 들어 있는 컷 index (없으면 -1). 재생 루프용.
 * @param {Range[]} cuts @param {Fps} fps @param {number} t
 */
export function findCutAtSec(cuts, fps, t) {
  let lo = 0;
  let hi = cuts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const a = frameToSec(cuts[mid][0], fps);
    const b = frameToSec(cuts[mid][1], fps);
    if (t < a) hi = mid - 1;
    else if (t >= b - 1e-6) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * 원본 프레임 → 결과 타임라인 프레임 (컷 안이면 그 컷 시작 위치).
 * @param {Range[]} cuts @param {number} frame
 */
export function programFrameAt(cuts, frame) {
  let removed = 0;
  for (const [a, b] of cuts) {
    if (a >= frame) break;
    removed += Math.min(b, frame) - a;
  }
  return frame - removed;
}

/**
 * 컷 하나의 경계를 옮긴다. 이웃 컷과는 최소 1프레임 유지 구간을 남기고, 길이는 0 까지 줄일 수 있다(놓을 때 정리).
 * @param {Range[]} cuts @param {number} index @param {"start" | "end"} edge @param {number} frame
 * @param {number} totalFrames
 * @returns {Range[]}
 */
export function moveEdge(cuts, index, edge, frame, totalFrames) {
  const next = cuts.map((c) => /** @type {Range} */ ([c[0], c[1]]));
  const cut = next[index];
  if (!cut) return next;
  const f = Math.round(frame);
  if (edge === "start") {
    const min = index > 0 ? next[index - 1][1] + 1 : 0;
    cut[0] = Math.min(cut[1], Math.max(min, f));
  } else {
    const max = index < next.length - 1 ? next[index + 1][0] - 1 : totalFrames;
    cut[1] = Math.max(cut[0], Math.min(max, f));
  }
  return next;
}

/**
 * 컷 하나를 길이 그대로 옮긴다. 이웃 컷과 최소 1프레임 유지 구간을 남기고 [0, total] 안에 둔다.
 * @param {Range[]} cuts @param {number} index @param {number} deltaFrames @param {number} totalFrames
 * @returns {Range[]}
 */
export function moveCut(cuts, index, deltaFrames, totalFrames) {
  const next = cuts.map((c) => /** @type {Range} */ ([c[0], c[1]]));
  const cut = next[index];
  if (!cut) return next;
  const len = cut[1] - cut[0];
  const min = index > 0 ? next[index - 1][1] + 1 : 0;
  const max = (index < next.length - 1 ? next[index + 1][0] - 1 : totalFrames) - len;
  if (max < min) return next;
  const start = Math.min(max, Math.max(min, cut[0] + Math.round(deltaFrames)));
  cut[0] = start;
  cut[1] = start + len;
  return next;
}

/** 길이 0 이 된 컷 제거 + 정규화 @param {Range[]} cuts @param {number} totalFrames */
export function commitCuts(cuts, totalFrames) {
  return normalizeCuts(cuts, totalFrames);
}

/** @param {Range[]} cuts @param {number} a @param {number} b @param {number} totalFrames */
export function addCut(cuts, a, b, totalFrames) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return normalizeCuts([...cuts, [lo, hi]], totalFrames);
}

/** @param {Range[]} cuts @param {number} index */
export function removeCut(cuts, index) {
  return cuts.filter((_, i) => i !== index);
}

/** @param {Range[]} a @param {Range[]} b */
export function cutsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

// -- 블레이드(자르기 선) · 구간 모델 ------------------------------------------------------
// 편집 상태 = { cuts, splits }. splits 는 화면에만 있는 자르기 선(프레임)으로 결과에는 영향이 없다.
// 타임라인은 0, total, 컷 경계, 자르기 선으로 나뉜 "구간" 들이고, 각 구간은 유지 또는 컷이다.

/** @typedef {{ cuts: Range[], splits: number[] }} EditState */
/** @typedef {{ start: number, end: number, cut: boolean }} Segment */

/** @param {number[]} splits @param {number} totalFrames @returns {number[]} */
export function normalizeSplits(splits, totalFrames) {
  return [...new Set((splits || []).map((f) => Math.round(Number(f))))]
    .filter((f) => Number.isFinite(f) && f > 0 && f < totalFrames)
    .sort((a, b) => a - b);
}

/**
 * @param {Range[]} cuts @param {number[]} splits @param {number} totalFrames
 * @returns {Segment[]}
 */
export function buildSegments(cuts, splits, totalFrames) {
  const set = new Set([0, totalFrames]);
  for (const [a, b] of cuts) {
    set.add(a);
    set.add(b);
  }
  for (const f of splits) set.add(f);
  const pts = [...set].filter((f) => f >= 0 && f <= totalFrames).sort((a, b) => a - b);
  /** @type {Segment[]} */
  const segs = [];
  let ci = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const start = pts[i];
    while (ci < cuts.length && cuts[ci][1] <= start) ci += 1;
    segs.push({ start, end: pts[i + 1], cut: ci < cuts.length && cuts[ci][0] <= start });
  }
  return segs;
}

/** frame 이 들어 있는 구간 index (끝 프레임은 마지막 구간) @param {Segment[]} segs @param {number} frame */
export function segmentIndexAt(segs, frame) {
  if (!segs.length) return -1;
  if (frame >= segs[segs.length - 1].end) return segs.length - 1;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frame < segs[mid].start) hi = mid - 1;
    else if (frame >= segs[mid].end) lo = mid + 1;
    else return mid;
  }
  return frame < 0 ? 0 : -1;
}

/** 컷에서 [a, b) 를 뺀다 @param {Range[]} cuts @param {number} a @param {number} b @returns {Range[]} */
export function subtractRange(cuts, a, b) {
  /** @type {Range[]} */
  const out = [];
  for (const [x, y] of cuts) {
    if (y <= a || x >= b) out.push([x, y]);
    else {
      if (x < a) out.push([x, a]);
      if (y > b) out.push([b, y]);
    }
  }
  return out;
}

/** 자르기 선 추가 @param {EditState} state @param {number} frame @param {number} totalFrames @returns {EditState} */
export function addSplit(state, frame, totalFrames) {
  return { cuts: state.cuts, splits: normalizeSplits([...state.splits, frame], totalFrames) };
}

/**
 * 구간 [a, b) 를 컷(잘라내기) 또는 유지(복원)로 바꾼다. 구간 경계는 자르기 선으로 남겨 다시 고를 수 있게 한다.
 * @param {EditState} state @param {number} a @param {number} b @param {boolean} cut @param {number} totalFrames
 * @returns {EditState}
 */
export function setRangeCut(state, a, b, cut, totalFrames) {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(totalFrames, Math.max(a, b));
  const cuts = cut ? addCut(state.cuts, lo, hi, totalFrames) : normalizeCuts(subtractRange(state.cuts, lo, hi), totalFrames);
  return { cuts, splits: normalizeSplits([...state.splits, lo, hi], totalFrames) };
}

/**
 * 구간 경계 하나를 옮긴다 (다빈치 트림). 왼쪽·오른쪽 구간은 각자 유지/컷 상태를 그대로 가진 채 길이만 바뀐다.
 * - 유지|컷 경계: 끌어서 컷 쪽으로 넓히면 잘렸던 부분이 복원되고, 반대로 끌면 더 잘린다.
 * - 같은 상태끼리의 경계(자르기 선): 선만 옮겨진다.
 * 이웃 구간 끝을 넘지 않으며, 한쪽 길이가 0 이 되면 그 구간은 사라진다.
 * @param {EditState} state @param {number} boundary 현재 경계 프레임 @param {number} target 옮길 프레임
 * @param {number} totalFrames
 * @returns {EditState}
 */
export function moveBoundary(state, boundary, target, totalFrames) {
  const segs = buildSegments(state.cuts, state.splits, totalFrames);
  const ri = segmentIndexAt(segs, boundary);
  if (ri <= 0 || segs[ri].start !== boundary) return state;
  const left = segs[ri - 1];
  const right = segs[ri];
  const t = Math.max(left.start, Math.min(right.end, Math.round(target)));
  /** @type {Range[]} */
  const add = [];
  if (left.cut && t > left.start) add.push([left.start, t]);
  if (right.cut && right.end > t) add.push([t, right.end]);
  const cuts = normalizeCuts([...subtractRange(state.cuts, left.start, right.end), ...add], totalFrames);
  const splits = normalizeSplits(
    [...state.splits.filter((f) => f !== boundary), t, left.start, right.end],
    totalFrames,
  );
  return { cuts, splits };
}

/** @param {EditState} a @param {EditState} b */
export function editsEqual(a, b) {
  if (!cutsEqual(a.cuts, b.cuts) || a.splits.length !== b.splits.length) return false;
  for (let i = 0; i < a.splits.length; i += 1) if (a.splits[i] !== b.splits[i]) return false;
  return true;
}

/** 짧은 문자열 지문 (djb2) @param {string} s */
export function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * 1.5 → "0:01.50", 3725.2 → "1:02:05.20"
 * @param {number} sec
 */
export function formatClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const cs = Math.floor(sec * 100 + 1e-6);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const tail = `${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${tail}` : `${m}:${tail}`;
}
