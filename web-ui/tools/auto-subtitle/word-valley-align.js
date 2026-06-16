/**
 * 파형 V 바닥(valley) 기준 단어 경계 재정렬.
 * cross-cue: block sourceIn/Out SSOT에 경계를 직접 기록 (재생·파형 축).
 */

import { requestAgent } from "../common/bridge.js?v=lna16";
import { applyCrossCueBoundaryPatchesToBlocks } from "./shared/cross-cue-boundary-sync.js?v=1";
import {
  getCueSourceEnd,
  getCueSourceStart,
  getWordSourceEnd,
  getWordSourceStart,
  sourceSecToVirtualSec,
  syncCueWordSourcesFromEdit,
} from "./shared/dual-axis.js?v=2";
import { normalizeAgentMediaPath } from "./shared/media-timing-ssot.js?v=9";
import { diagLogBufferPush } from "./shared/diag-log-export.js?v=1";
import { visibleSubtitleWords } from "./shared/subtitles.js?v=24";
import { syncCueFromWords } from "./subtitle-words.js?v=21";

/** @param {import("./shared/subtitles.js").SubtitleLine} cue */
function cueHasSpokenWords(cue) {
  if (!cue || cue.is_deleted || cue.isDeleted) return false;
  if (cue.is_silence || cue.isSilence) return false;
  return visibleSubtitleWords(cue.words).length > 0;
}

/** @param {import("./shared/subtitles.js").SubtitleLine[]} cues */
export function countSpokenWordsForValleyAlign(cues) {
  let n = 0;
  for (const cue of cues || []) {
    if (!cueHasSpokenWords(cue)) continue;
    n += visibleSubtitleWords(cue.words).length;
  }
  return n;
}

/** @param {import("./shared/subtitles.js").SubtitleLine[]} cues */
function buildValleyAlignPayload(cues) {
  return (cues || []).map((cue) => ({
    start: getCueSourceStart(cue),
    end: getCueSourceEnd(cue),
    text: String(cue.text ?? ""),
    words: (cue.words ?? []).map((w) => ({
      start: getWordSourceStart(w, cue),
      end: getWordSourceEnd(w, cue),
      word: String(w.word ?? ""),
      is_silence: Boolean(w.is_silence ?? w.isSilence),
      is_deleted: Boolean(w.is_deleted ?? w.isDeleted),
      isSilence: Boolean(w.is_silence ?? w.isSilence),
      isDeleted: Boolean(w.is_deleted ?? w.isDeleted),
    })),
  }));
}

/** @param {import("./shared/subtitles.js").SubtitleLine} cue @param {number} boundarySourceSec */
function boundarySourceToEditSec(cue, boundarySourceSec) {
  const t = Number(boundarySourceSec);
  if (!Number.isFinite(t)) return NaN;
  return sourceSecToVirtualSec(cue, t);
}

export { syncCueWordSourcesFromEdit };

const MIN_BOUNDARY_WORD_SEC = 0.01;

/**
 * @param {import("./shared/subtitles.js").SubtitleLine[]} cues
 * @param {{ cue_index: number, word_index: number }} left
 * @param {{ cue_index: number, word_index: number }} right
 * @param {number} srcBoundary
 */
function applyCrossCueBoundaryPatch(cues, left, right, srcBoundary) {
  const next = (cues || []).map((c) => ({
    ...c,
    words: (c.words || []).map((w) => ({ ...w })),
  }));

  const leftCue = next[left.cue_index];
  const rightCue = next[right.cue_index];
  if (!leftCue?.words?.length || !rightCue?.words?.length) return cues;

  const lwi = left.word_index;
  const rwi = right.word_index;
  const lw = leftCue.words[lwi];
  const rw = rightCue.words[rwi];
  if (!lw || !rw || lw.is_deleted || lw.isDeleted || rw.is_deleted || rw.isDeleted) {
    return cues;
  }

  const t = Number(srcBoundary);
  if (!Number.isFinite(t)) return cues;

  const editEnd = boundarySourceToEditSec(leftCue, t);
  const editStart = boundarySourceToEditSec(rightCue, t);
  if (!Number.isFinite(editEnd) || !Number.isFinite(editStart)) return cues;

  const ls = Number(lw.start);
  const re = Number(rw.end);
  if (editEnd < ls + MIN_BOUNDARY_WORD_SEC || re < editStart + MIN_BOUNDARY_WORD_SEC) {
    return cues;
  }

  lw.end = editEnd;
  lw.sourceEnd = t;
  lw.source_end = t;
  rw.start = editStart;
  rw.sourceStart = t;
  rw.source_start = t;

  leftCue.sourceEnd = t;
  leftCue.source_end = t;
  rightCue.sourceStart = t;
  rightCue.source_start = t;

  next[left.cue_index] = syncCueFromWords(leftCue);
  next[right.cue_index] = syncCueFromWords(rightCue);
  return next;
}

/**
 * @typedef {{

 *   left: { cue_index: number, word_index: number },

 *   right: { cue_index: number, word_index: number },

 *   boundary_sec: number,

 *   same_cue?: boolean,

 * }} ValleyAlignPatch

 */

/**
 * @param {import("./shared/subtitles.js").SubtitleLine[]} cues
 * @param {{ cue_index: number, word_index: number }} left
 * @param {{ cue_index: number, word_index: number }} right
 * @param {number} srcBoundary
 */
function applySameCueValleyBoundaryPatch(cues, left, right, srcBoundary) {
  const next = (cues || []).map((c) => ({
    ...c,
    words: (c.words || []).map((w) => ({ ...w })),
  }));

  const cue = next[left.cue_index];
  if (!cue?.words?.length) return cues;

  const lw = cue.words[left.word_index];
  const rw = cue.words[right.word_index];
  if (!lw || !rw || lw.is_deleted || lw.isDeleted || rw.is_deleted || rw.isDeleted) {
    return cues;
  }

  const t = Number(srcBoundary);
  if (!Number.isFinite(t)) return cues;

  const editEnd = boundarySourceToEditSec(cue, t);
  const editStart = boundarySourceToEditSec(cue, t);
  if (!Number.isFinite(editEnd) || !Number.isFinite(editStart)) return cues;

  const ls = Number(lw.start);
  const re = Number(rw.end);
  if (editEnd < ls + MIN_BOUNDARY_WORD_SEC || re < editStart + MIN_BOUNDARY_WORD_SEC) {
    return cues;
  }

  lw.end = editEnd;
  lw.sourceEnd = t;
  lw.source_end = t;
  rw.start = editStart;
  rw.sourceStart = t;
  rw.source_start = t;

  next[left.cue_index] = syncCueFromWords(cue);
  return next;
}

/** @param {import("./shared/subtitles.js").SubtitleLine[]} cues @param {ValleyAlignPatch[]} patches */
export function applyValleyPatches(cues, patches) {
  if (!patches?.length) return cues;

  const sorted = [...patches].sort(
    (a, b) => Number(a.boundary_sec) - Number(b.boundary_sec),
  );

  let next = cues;
  for (const patch of sorted) {
    const { left, right } = patch;
    const srcBoundary = Number(patch.boundary_sec);
    if (
      !left ||
      !right ||
      !Number.isInteger(left.cue_index) ||
      !Number.isInteger(left.word_index) ||
      !Number.isInteger(right.cue_index) ||
      !Number.isInteger(right.word_index) ||
      !Number.isFinite(srcBoundary)
    ) {
      continue;
    }

    const sameCue =
      patch.same_cue === true ||
      (patch.same_cue !== false && left.cue_index === right.cue_index);

    if (!sameCue) {
      next = applyCrossCueBoundaryPatch(next, left, right, srcBoundary);
      continue;
    }

    next = applySameCueValleyBoundaryPatch(next, left, right, srcBoundary);
  }

  return next;
}

/**
 * @param {import("./hub/app-hub.js").SubtitleAppHub} hub
 * @param {string} mediaPath
 * @param {(pct: number, message: string) => void} onProgress
 */
export async function runWordValleyAlign(hub, mediaPath, onProgress) {
  const cues = hub.cues;
  const spoken = countSpokenWordsForValleyAlign(cues);
  if (spoken < 2) {
    throw new Error("타이밍 맞출 말소리 단어가 2개 이상 필요합니다.");
  }
  const path = normalizeAgentMediaPath(mediaPath);
  if (!path) {
    throw new Error("미디어 경로가 없습니다. 영상을 선택하거나 자막 추출을 먼저 실행해 주세요.");
  }

  onProgress(8, "오디오 파형 분석 중…");

  const data = await requestAgent({
    method: "POST",
    path: "/api/tools/auto-subtitle/words/valley-align",
    json: {
      video_path: path,
      cues: buildValleyAlignPayload(cues),
    },
  });

  const stats = data?.stats && typeof data.stats === "object" ? data.stats : {};
  const patches = Array.isArray(data?.patches)
    ? data.patches
    : Array.isArray(stats.patches)
      ? stats.patches
      : [];

  onProgress(65, "단어 경계 적용 중…");

  hub.applySubtitleChange((prev) => applyValleyPatches(prev, patches));

  if (patches.length > 0) {
    hub.applyBlockChange(
      (blocks) => applyCrossCueBoundaryPatchesToBlocks(blocks, patches),
      { recordHistory: false },
    );
    hub._derivedCues = null;
    hub._syncVirtualTimelineDeleted();
    hub._notify();
  }

  const adjusted = Number(stats.pairs_adjusted) || patches.length || 0;
  const total = Number(stats.pairs_total) || 0;
  const skipped = Number(stats.pairs_skipped) || 0;
  const rateGlobal = stats.rate_global ?? null;
  const rateGlobalMeta =
    stats.rate_global_meta && typeof stats.rate_global_meta === "object"
      ? stats.rate_global_meta
      : null;
  const rateGlobalLabel =
    rateGlobal != null
      ? `rate ${rateGlobal}s/자${
          rateGlobalMeta?.fallback ? " (fallback 0.14)" : ""
        }${
          rateGlobalMeta?.spoken_char_count != null
            ? ` · ${rateGlobalMeta.spoken_char_count}자`
            : ""
        }`
      : "";
  const valleyReport = {
    media_path: path,
    engine_rev: stats.engine_rev ?? null,
    rate_global: rateGlobal,
    rate_global_meta: rateGlobalMeta,
    pairs_total: total,
    pairs_adjusted: adjusted,
    pairs_skipped: skipped,
    patches_applied: patches.length,
    patches: patches.slice(0, 50),
    skip_reasons: stats.skip_reasons ?? {},
    max_delta_start_ms: stats.max_delta_start_ms ?? 0,
    max_delta_end_ms: stats.max_delta_end_ms ?? 0,
    applied: stats.applied === true,
  };
  diagLogBufferPush("valley-align", "log", "complete", valleyReport);
  if (typeof window !== "undefined") {
    window.__lastValleyAlign = valleyReport;
  }
  console.info("[valley-align] 완료", valleyReport);
  if (rateGlobal != null) {
    console.info(
      `[valley-align] rate_global=${rateGlobal}s/자` +
        (rateGlobalMeta ? ` (meta: ${JSON.stringify(rateGlobalMeta)})` : ""),
    );
  }
  onProgress(
    100,
    adjusted > 0
      ? `${adjusted}개 단어 경계를 V 바닥 기준으로 맞췄습니다. (${total}쌍 분석${
          rateGlobalLabel ? ` · ${rateGlobalLabel}` : ""
        })`
      : total > 0
        ? `추가로 맞출 경계가 없거나 V 골이 뚜렷하지 않습니다.${
            rateGlobalLabel ? ` (${rateGlobalLabel})` : ""
          }`
        : "맞출 인접 단어 쌍이 없습니다.",
  );

  return { adjusted, total, stats, patches };
}
