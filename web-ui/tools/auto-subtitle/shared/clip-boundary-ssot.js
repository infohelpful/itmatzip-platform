/**

 * 클립 경계 전환 SSOT — classifyGapTransition, effectiveSourceEnd, merged cuts.

 */



import { mergeCutRanges } from "./timeline-collapse.js?v=1";

import { isSourceVideoPtsTimeline } from "./media-timing-ssot.js?v=7";



export const PASS_THROUGH_EPS_SEC = 0.015;

export const PASS_THROUGH_EPS_VFR_SEC = 0.03;

export const MICRO_GAP_MAX_SEC = 0.03;

export const NATURAL_PAUSE_GAP_SEC = 0.12;

/** edit 처치(in-place vs layer switch) 분기만 — 분류에 사용 금지 */

export const DELETED_WORD_MEDIA_GAP_SEC = 0.35;



/**

 * @typedef {'continuous' | 'micro' | 'natural' | 'edit'} GapTransitionKind

 * @typedef {{

 *   kind: GapTransitionKind,

 *   realDiscontinuity: boolean,

 *   passThrough: boolean,

 *   hasCutData: boolean,

 *   hasSourceJump: boolean,

 *   sameBlockSplit: boolean,

 *   interEffectiveGap: number,

 *   literalBlockJump?: boolean,

 * }} GapTransitionClassification

 */



/**

 * @param {import("./timeline-mapping.js").TimelineClip} clip

 */

export function effectiveSourceEndForClip(clip) {

  const raw = clip?.effectiveSourceEnd ?? clip?.effectiveMediaEnd;

  if (Number.isFinite(Number(raw))) return Number(raw);

  return Number(clip?.mediaEnd) || 0;

}



/**

 * @param {import("./timeline-mapping.js").TimelineClip} cur

 * @param {import("./timeline-mapping.js").TimelineClip} next

 */

export function interClipEffectiveGap(cur, next) {

  return Number(next?.mediaStart) - effectiveSourceEndForClip(cur);

}



/**

 * @param {readonly { start: number, end: number }[]} skipRanges

 * @param {number} fromSec

 * @param {number} toSec

 */

export function hasSkipRangeBetween(skipRanges, fromSec, toSec) {

  const a = Math.min(fromSec, toSec);

  const b = Math.max(fromSec, toSec);

  if (b <= a + 1e-6) return false;

  for (const r of skipRanges || []) {

    const rs = Number(r.start);

    const re = Number(r.end);

    if (!Number.isFinite(rs) || !Number.isFinite(re)) continue;

    if (re > a + 1e-6 && rs < b - 1e-6) return true;

  }

  return false;

}



/**

 * @param {readonly { start: number, end: number }[]} cutRanges

 * @param {readonly { start: number, end: number }[]} skipRanges

 * @param {readonly { start: number, end: number }[]} [softDeleteSourceSkips]

 */

export function mergedPlaybackCuts(cutRanges, skipRanges, softDeleteSourceSkips = []) {

  return mergeCutRanges([

    ...(cutRanges || []),

    ...(skipRanges || []),

    ...(softDeleteSourceSkips || []),

  ]);

}



/**

 * blocks SSOT — soft-delete 단어 sourceIn~sourceOut (list-order gap triage용).

 *

 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks

 * @returns {{ start: number, end: number }[]}

 */

export function collectSoftDeletedWordSourceSkips(blocks) {

  /** @type {{ start: number, end: number }[]} */

  const ranges = [];

  for (const block of blocks || []) {

    if (!block || block.isDeleted) continue;

    for (const w of block.words || []) {

      if (!w?.isDeleted || w.mergedByEdgeTrim) continue;

      const si = Number(w.sourceIn) || 0;

      const so = Math.max(si, Number(w.sourceOut) || si);

      if (so > si + 1e-6) ranges.push({ start: si, end: so });

    }

  }

  return mergeCutRanges(ranges);

}



/**

 * blocks list-order preview skip SSOT (hard delete + soft delete source spans).

 *

 * @param {readonly { start: number, end: number }[]} hardDeletedMediaSkips

 * @param {readonly import("./block-timeline-adapter.js").Block[]} blocks

 */

export function buildBlocksPreviewPlaybackSkips(hardDeletedMediaSkips, blocks) {

  return mergedPlaybackCuts(

    [],

    mergeCutRanges([...(hardDeletedMediaSkips || [])]),

    collectSoftDeletedWordSourceSkips(blocks),

  );

}



/**

 * @param {{ vfr?: boolean }} [opts]

 */

export function passThroughEpsilonSec(opts = {}) {

  const vfr = opts.vfr ?? isSourceVideoPtsTimeline();

  return vfr ? PASS_THROUGH_EPS_VFR_SEC : PASS_THROUGH_EPS_SEC;

}



/**

 * @param {number} a0

 * @param {number} a1

 * @param {number} b0

 * @param {number} b1

 */

function intervalOverlap(a0, a1, b0, b1) {

  return b1 > a0 + 1e-6 && b0 < a1 - 1e-6;

}



/**

 * @param {readonly import("./timeline-mapping.js").TimelineClip[]} clips

 * @param {number} curPos

 * @param {number} nextPos

 * @param {number} effEnd

 * @param {number} nextStart

 */

export function hasKeptSourceOverlapBetween(clips, curPos, nextPos, effEnd, nextStart) {

  const openA = Math.min(effEnd, nextStart);

  const openB = Math.max(effEnd, nextStart);

  if (openB <= openA + 1e-6) return false;

  for (let i = 0; i < clips.length; i += 1) {

    if (i === curPos || i === nextPos) continue;

    const c = clips[i];

    if (c?.isSilence) continue;

    const cs = Number(c.mediaStart) || 0;

    const ce = Number(c.mediaEnd) || 0;

    if (intervalOverlap(openA, openB, cs, ce)) return true;

  }

  return false;

}



/**

 * @param {import("./timeline-mapping.js").TimelineClip} cur

 * @param {import("./timeline-mapping.js").TimelineClip} next

 * @param {number} interEffectiveGap

 * @param {{ vfr?: boolean }} [opts]

 */

export function isSameBlockSplitGap(cur, next, interEffectiveGap, opts = {}) {

  if (interEffectiveGap <= passThroughEpsilonSec(opts)) return false;

  const curBlock = cur?.blockIndex ?? cur?.cueIndex;

  const nextBlock = next?.blockIndex ?? next?.cueIndex;

  if (!Number.isFinite(Number(curBlock)) || Number(curBlock) !== Number(nextBlock)) {

    return false;

  }

  return true;

}



/**

 * @param {{

 *   cur: import("./timeline-mapping.js").TimelineClip,

 *   next: import("./timeline-mapping.js").TimelineClip,

 *   clips: readonly import("./timeline-mapping.js").TimelineClip[],

 *   curPos: number,

 *   nextPos: number,

 *   skipRanges: readonly { start: number, end: number }[],

 *   cutRanges?: readonly { start: number, end: number }[],

 *   softDeleteSourceSkips?: readonly { start: number, end: number }[],

 *   vfr?: boolean,

 * }} params

 * @returns {GapTransitionClassification}

 */

export function classifyGapTransition(params) {

  const {

    cur,

    next,

    clips,

    curPos,

    nextPos,

    skipRanges,

    cutRanges = [],

    softDeleteSourceSkips = [],

  } = params;

  const vfr = params.vfr ?? isSourceVideoPtsTimeline();

  const eps = passThroughEpsilonSec({ vfr });

  const interEffectiveGap = interClipEffectiveGap(cur, next);

  const effEnd = effectiveSourceEndForClip(cur);

  const nextStart = Number(next.mediaStart) || 0;

  const merged = mergedPlaybackCuts(cutRanges, skipRanges, softDeleteSourceSkips);



  const hasCutData = hasSkipRangeBetween(merged, effEnd, nextStart);

  const hasSourceJump = hasKeptSourceOverlapBetween(

    clips,

    curPos,

    nextPos,

    effEnd,

    nextStart,

  );

  const isBackward = nextStart < effEnd - 0.02;

  const sameBlockSplit = isSameBlockSplitGap(cur, next, interEffectiveGap, { vfr });



  const base = {

    hasCutData,

    hasSourceJump,

    sameBlockSplit,

    interEffectiveGap,

  };



  if (hasCutData || hasSourceJump || isBackward || sameBlockSplit) {

    return {

      kind: "edit",

      realDiscontinuity: true,

      passThrough: false,

      ...base,

    };

  }



  const absGap = Math.abs(interEffectiveGap);

  if (absGap <= eps) {

    return {

      kind: "continuous",

      realDiscontinuity: false,

      passThrough: true,

      ...base,

    };

  }



  if (interEffectiveGap > eps && interEffectiveGap <= MICRO_GAP_MAX_SEC) {

    return {

      kind: "micro",

      realDiscontinuity: false,

      passThrough: true,

      ...base,

    };

  }



  if (interEffectiveGap > MICRO_GAP_MAX_SEC && nextStart > effEnd + eps) {

    return {

      kind: "natural",

      realDiscontinuity: false,

      passThrough: true,

      ...base,

    };

  }



  return {

    kind: "edit",

    realDiscontinuity: true,

    passThrough: false,

    ...base,

  };

}

/** @param {import("./timeline-mapping.js").TimelineClip | null | undefined} clip */
export function clipBlockKey(clip) {
  if (!clip) return null;
  if (clip.blockId != null && clip.blockId !== "") return String(clip.blockId);
  if (Number.isInteger(clip.blockIndex) && clip.blockIndex >= 0) {
    return `idx:${clip.blockIndex}`;
  }
  if (Number.isInteger(clip.cueIndex) && clip.cueIndex >= 0) {
    return `cue:${clip.cueIndex}`;
  }
  return null;
}

/** @param {import("./timeline-mapping.js").TimelineClip | null | undefined} cur @param {import("./timeline-mapping.js").TimelineClip | null | undefined} next */
export function clipBlockKeysMatch(cur, next) {
  const a = clipBlockKey(cur);
  const b = clipBlockKey(next);
  return a != null && b != null && a === b;
}

/**
 * List-order — natural/micro passThrough 금지 (continuous·edit 유지).
 * @param {GapTransitionClassification} cls
 */
export function applyListOrderGapOverride(cls) {
  if (!cls || cls.kind === "continuous" || cls.kind === "edit") {
    return cls;
  }
  if (cls.kind === "micro" || cls.kind === "natural") {
    return {
      ...cls,
      kind: "edit",
      realDiscontinuity: true,
      passThrough: false,
    };
  }
  return cls;
}

/**
 * PC-LITERAL — program 큐: 다른 block이면 source ε-adjacent여도 discontinuity.
 *
 * @param {import("./timeline-mapping.js").TimelineClip} cur
 * @param {import("./timeline-mapping.js").TimelineClip} next
 * @param {GapTransitionClassification} cls
 */
export function applyListOrderLiteralOverride(cur, next, cls) {
  if (!cls) return cls;
  if (cls.kind === "edit") return cls;

  const sameBlock = clipBlockKeysMatch(cur, next);

  if (cls.sameBlockSplit) {
    if (cls.kind === "continuous") return cls;
    return applyListOrderGapOverride(cls);
  }

  if (!sameBlock) {
    return {
      ...cls,
      kind: "edit",
      passThrough: false,
      realDiscontinuity: true,
      literalBlockJump: true,
    };
  }

  if (cls.kind === "continuous") return cls;
  return applyListOrderGapOverride(cls);
}

/**
 * @param {{
 *   cur: import("./timeline-mapping.js").TimelineClip,
 *   next: import("./timeline-mapping.js").TimelineClip,
 *   clips: readonly import("./timeline-mapping.js").TimelineClip[],
 *   curPos: number,
 *   nextPos: number,
 *   skipRanges: readonly { start: number, end: number }[],
 *   cutRanges?: readonly { start: number, end: number }[],
 *   softDeleteSourceSkips?: readonly { start: number, end: number }[],
 *   vfr?: boolean,
 * }} params
 * @returns {GapTransitionClassification}
 */
export function classifyListOrderGapTransition(params) {
  return applyListOrderLiteralOverride(
    params.cur,
    params.next,
    classifyGapTransition(params),
  );
}

/** @deprecated — classifyGapTransition(kind:'continuous') 사용 */

export function isFullyContinuousTransition(cur, next, skipRanges, opts = {}) {

  const cls = classifyGapTransition({

    cur,

    next,

    clips: [cur, next],

    curPos: 0,

    nextPos: 1,

    skipRanges,

    vfr: opts.vfr,

  });

  return cls.kind === "continuous";

}



/** @deprecated — classifyGapTransition(kind:'micro'|'natural') 사용 */

export function isForwardGapTransition(cur, next, skipRanges, interEffectiveGap) {

  void interEffectiveGap;

  const cls = classifyGapTransition({

    cur,

    next,

    clips: [cur, next],

    curPos: 0,

    nextPos: 1,

    skipRanges,

  });

  return cls.kind === "micro" || cls.kind === "natural";

}



/** @deprecated */

export function isNaturalPauseTransition(cur, next, skipRanges, interEffectiveGap) {

  const cls = classifyGapTransition({

    cur,

    next,

    clips: [cur, next],

    curPos: 0,

    nextPos: 1,

    skipRanges,

  });

  return cls.kind === "natural" && interEffectiveGap >= NATURAL_PAUSE_GAP_SEC;

}



/** @deprecated */

export function isRealDiscontinuityTransition(cur, next, skipRanges, mediaSec, interEffectiveGap) {

  void mediaSec;

  void interEffectiveGap;

  const cls = classifyGapTransition({

    cur,

    next,

    clips: [cur, next],

    curPos: 0,

    nextPos: 1,

    skipRanges,

  });

  return cls.kind === "edit";

}


