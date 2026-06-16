/**
 * 단일 칩 Micro-Realign — 파동 패널 「다시 맞추기」
 */

import { requestAgent } from "../common/bridge.js?v=lna16";
import { applyCrossCueBoundaryPatchesToBlocks } from "./shared/cross-cue-boundary-sync.js?v=1";
import {
  getWordSourceEnd,
  getWordSourceStart,
  sourceSecToVirtualSec,
} from "./shared/dual-axis.js?v=2";
import { normalizeAgentMediaPath } from "./shared/media-timing-ssot.js?v=9";
import { wordIsDeleted, wordIsSilence } from "./shared/subtitles.js?v=24";
import { getCueWords } from "./subtitle-words.js?v=21";
import { applyValleyPatches } from "./word-valley-align.js?v=21";

const MICRO_REALIGN_TIMEOUT_MS = 3000;

/**
 * @param {import("./shared/subtitles.js").SubtitleLine} cue
 * @param {number} storageIndex
 */
function wordPayload(cues, cueIndex, storageIndex) {
  const cue = cues[cueIndex];
  if (!cue) return null;
  const w = getCueWords(cue)[storageIndex];
  if (!w || wordIsDeleted(w) || wordIsSilence(w)) return null;
  const text = String(w.word ?? "").trim();
  if (!text || text === "--") return null;
  return {
    cue_index: cueIndex,
    word_index: storageIndex,
    start: getWordSourceStart(w, cue),
    end: getWordSourceEnd(w, cue),
    text,
  };
}

/**
 * @param {readonly import("./shared/subtitles.js").SubtitleLine[]} cues
 * @param {number} cueIndex
 * @param {number} storageIndex
 */
export function resolveMicroRealignNeighbors(cues, cueIndex, storageIndex) {
  const cue = cues[cueIndex];
  if (!cue) return { target: null, prev: null, next: null };

  const words = getCueWords(cue);
  const target = wordPayload(cues, cueIndex, storageIndex);
  if (!target) return { target: null, prev: null, next: null };

  /** @type {ReturnType<typeof wordPayload> | null} */
  let prev = null;
  for (let wi = storageIndex - 1; wi >= 0; wi -= 1) {
    prev = wordPayload(cues, cueIndex, wi);
    if (prev) break;
  }
  if (!prev && cueIndex > 0) {
    for (let ci = cueIndex - 1; ci >= 0; ci -= 1) {
      const c = cues[ci];
      if (!c || c.is_silence || c.isSilence) continue;
      const ws = getCueWords(c);
      for (let wi = ws.length - 1; wi >= 0; wi -= 1) {
        prev = wordPayload(cues, ci, wi);
        if (prev) break;
      }
      if (prev) break;
    }
  }

  /** @type {ReturnType<typeof wordPayload> | null} */
  let next = null;
  for (let wi = storageIndex + 1; wi < words.length; wi += 1) {
    next = wordPayload(cues, cueIndex, wi);
    if (next) break;
  }
  if (!next && cueIndex < cues.length - 1) {
    for (let ci = cueIndex + 1; ci < cues.length; ci += 1) {
      const c = cues[ci];
      if (!c || c.is_silence || c.isSilence) continue;
      const ws = getCueWords(c);
      for (let wi = 0; wi < ws.length; wi += 1) {
        next = wordPayload(cues, ci, wi);
        if (next) break;
      }
      if (next) break;
    }
  }

  return { target, prev, next };
}

/**
 * @param {import("./shared/subtitles.js").SubtitleLine} cue
 * @param {number} sourceSec
 */
export function sourceSecToEditSecForCue(cue, sourceSec) {
  const t = Number(sourceSec);
  if (!Number.isFinite(t)) return NaN;
  return sourceSecToVirtualSec(cue, t);
}

/**
 * @param {import("./hub/app-hub.js").SubtitleAppHub | null} hub
 * @param {string} mediaPath
 * @param {number} cueIndex
 * @param {number} wordIndex
 */
export async function runMicroRealign(hub, mediaPath, cueIndex, wordIndex) {
  if (!hub) throw new Error("자막 데이터가 없습니다.");
  const cues = hub.cues;
  const { target, prev, next } = resolveMicroRealignNeighbors(cues, cueIndex, wordIndex);
  if (!target) throw new Error("다시 맞출 단어를 찾을 수 없습니다.");
  if (!next) {
    throw new Error("다음 단어가 없습니다. 끝 경계 맞추기는 다음 단어가 있을 때만 가능합니다.");
  }

  const path = normalizeAgentMediaPath(mediaPath);
  if (!path) throw new Error("미디어 경로가 없습니다.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MICRO_REALIGN_TIMEOUT_MS);

  let data;
  try {
    data = await requestAgent({
      method: "POST",
      path: "/api/tools/auto-subtitle/words/micro-realign",
      json: {
        video_path: path,
        target,
        prev: prev ?? null,
        next: next ?? null,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const applied = Boolean(data?.applied);
  const patches = Array.isArray(data?.boundary_patches) ? data.boundary_patches : [];
  const reason = data?.reason != null ? String(data.reason) : null;

  if (!applied || !patches.length) {
    return {
      applied: false,
      reason: reason || "no_change",
      patches: [],
      editRange: null,
    };
  }

  hub.applySubtitleChange((prevCues) => applyValleyPatches(prevCues, patches));
  hub.applyBlockChange(
    (blocks) => applyCrossCueBoundaryPatchesToBlocks(blocks, patches),
    { recordHistory: false },
  );
  hub._derivedCues = null;
  hub._syncVirtualTimelineDeleted();
  hub._notify();

  const cue = hub.cues[cueIndex];
  const w = getCueWords(cue)[wordIndex];
  const editStart = sourceSecToEditSecForCue(cue, getWordSourceStart(w, cue));
  const editEnd = sourceSecToEditSecForCue(cue, getWordSourceEnd(w, cue));

  return {
    applied: true,
    reason: null,
    patches,
    editRange:
      Number.isFinite(editStart) && Number.isFinite(editEnd)
        ? { start: Math.min(editStart, editEnd), end: Math.max(editStart, editEnd) }
        : null,
    stats: data?.stats ?? {},
  };
}
