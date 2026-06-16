/**
 * Block SSOT ↔ SubtitleLine 어댑터 (Phase 0).
 * Virtual 시간은 _virtualIndex 전용; cue/word start/end = 미디어 축.
 */

import { getCueSourceEnd, getCueSourceStart, getWordSourceEnd, getWordSourceStart } from "./dual-axis.js?v=1";
import { makeRowWordBlockId } from "./block-ids.js";
import { visibleSubtitleWords, wordIsDeleted, wordIsSilence } from "./subtitles.js?v=24";

const EPS = 1e-6;
const VIRTUAL_GAP_FALLBACK_SEC = 0.02;

/**
 * @typedef {Object} WordBlock
 * @property {string} id
 * @property {string} text
 * @property {number} duration
 * @property {number} sourceIn
 * @property {number} sourceOut
 * @property {boolean} [isDeleted]
 * @property {boolean} [isSilence]
 * @property {boolean} [mergedByEdgeTrim]
 * @property {string} [splitChain]
 */

/**
 * @typedef {Object} Block
 * @property {string} id
 * @property {string} text
 * @property {number} duration
 * @property {number} sourceIn
 * @property {number} sourceOut
 * @property {boolean} [isDeleted]
 * @property {boolean} [isSilence]
 * @property {WordBlock[]} [words]
 */

/**
 * @typedef {Object} VirtualIndexEntry
 * @property {string} id
 * @property {number} virtualStart
 * @property {number} virtualEnd
 * @property {number} blockIndex
 */

/**
 * @param {import("./subtitles.js").SubtitleLine} line
 */
function readLineSourceIn(line) {
  const s = line.sourceStart ?? line.source_start;
  if (Number.isFinite(Number(s))) return Number(s);
  const words = line.words || [];
  if (words.length) {
    let min = Infinity;
    for (const w of words) {
      if (wordIsDeleted(w) && !w.mergedByEdgeTrim && !w.merged_by_edge_trim) continue;
      min = Math.min(min, getWordSourceStart(w, line));
    }
    if (Number.isFinite(min)) return min;
  }
  return Number(line.start) || 0;
}

/**
 * @param {import("./subtitles.js").SubtitleLine} line
 */
function readLineSourceOut(line) {
  const e = line.sourceEnd ?? line.source_end;
  if (Number.isFinite(Number(e))) return Number(e);
  const words = line.words || [];
  if (words.length) {
    let max = -Infinity;
    for (const w of words) {
      if (wordIsDeleted(w) && !w.mergedByEdgeTrim && !w.merged_by_edge_trim) continue;
      max = Math.max(max, getWordSourceEnd(w, line));
    }
    if (Number.isFinite(max)) return max;
  }
  return Number(line.end) || readLineSourceIn(line);
}

/**
 * @param {readonly Block[]} blocks
 * @returns {VirtualIndexEntry[]}
 */
export function rebuildVirtualIndexFromBlocks(blocks) {
  /** @type {VirtualIndexEntry[]} */
  const index = [];
  let offset = 0;
  for (let blockIndex = 0; blockIndex < (blocks || []).length; blockIndex += 1) {
    const block = blocks[blockIndex];
    if (!block || block.isDeleted) continue;
    const dur = Math.max(0, Number(block.duration) || 0);
    const virtualStart = offset;
    const virtualEnd = offset + dur;
    index.push({
      id: block.id,
      virtualStart,
      virtualEnd,
      blockIndex,
    });
    offset = virtualEnd;
  }
  return index;
}

/**
 * @param {Block} block
 */
function blockStructuralFingerprint(block) {
  return {
    id: block.id,
    duration: block.duration,
    sourceIn: block.sourceIn,
    sourceOut: block.sourceOut,
    isDeleted: !!block.isDeleted,
    isSilence: !!block.isSilence,
    words: (block.words || []).map((w) => ({
      id: w.id,
      duration: w.duration,
      sourceIn: w.sourceIn,
      sourceOut: w.sourceOut,
      isDeleted: !!w.isDeleted,
      isSilence: !!w.isSilence,
    })),
  };
}

/**
 * @param {readonly Block[]} a
 * @param {readonly Block[]} b
 */
export function blocksStructurallyEqual(a, b) {
  const left = a || [];
  const right = b || [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (JSON.stringify(blockStructuralFingerprint(left[i])) !== JSON.stringify(blockStructuralFingerprint(right[i]))) {
      return false;
    }
  }
  return true;
}

/**
 * @param {readonly Block[]} a
 * @param {readonly Block[]} b
 */
export function blocksMeaningfullyChanged(a, b) {
  if (a === b) return false;
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * @param {Block | undefined} existing
 * @param {number} sourceIn
 * @param {number} sourceOut
 */
function resolveBlockDuration(existing, sourceIn, sourceOut) {
  const span = Math.max(0, sourceOut - sourceIn);
  if (
    existing &&
    Math.abs(Number(existing.sourceIn) - sourceIn) < EPS &&
    Math.abs(Number(existing.sourceOut) - sourceOut) < EPS &&
    Number.isFinite(Number(existing.duration))
  ) {
    return Number(existing.duration);
  }
  return span;
}

/**
 * @param {import("./subtitles.js").SubtitleWord} word
 * @param {import("./subtitles.js").SubtitleLine} line
 * @param {number} row1Based
 * @param {number} slot1Based
 * @param {WordBlock | undefined} existingWord
 */
function wordToWordBlock(word, line, row1Based, slot1Based, existingWord) {
  const sourceIn = getWordSourceStart(word, line);
  const sourceOut = getWordSourceEnd(word, line);
  const duration = resolveBlockDuration(existingWord, sourceIn, sourceOut);
  const chain = word.split_chain ?? word.splitChain;
  const baseId = makeRowWordBlockId(row1Based, slot1Based);
  const id = word.id || existingWord?.id || (chain ? `${baseId}_${chain}` : baseId);
  const hss = Number(word.hintStart ?? word.hint_start);
  const hse = Number(word.hintEnd ?? word.hint_end);
  return {
    id,
    text: String(word.word ?? ""),
    duration,
    sourceIn,
    sourceOut,
    isDeleted: wordIsDeleted(word),
    isSilence: wordIsSilence(word),
    mergedByEdgeTrim: word.merged_by_edge_trim === true || word.mergedByEdgeTrim === true,
    splitChain: chain || undefined,
    ...(Number.isFinite(hss) ? { hintStart: hss } : {}),
    ...(Number.isFinite(hse) ? { hintEnd: hse } : {}),
  };
}

/**
 * @param {import("./subtitles.js").SubtitleLine} line
 * @param {number} lineIndex
 * @param {Block | undefined} existingBlock
 */
function lineToBlock(line, lineIndex, existingBlock) {
  const sourceIn = readLineSourceIn(line);
  const sourceOut = Math.max(sourceIn, readLineSourceOut(line));
  const row1Based = lineIndex + 1;
  const id =
    line.blockId ||
    existingBlock?.id ||
    `block_row_${row1Based}`;
  const duration = resolveBlockDuration(existingBlock, sourceIn, sourceOut);
  const rawWords = line.words || [];
  /** @type {WordBlock[]} */
  const words = rawWords.map((w, wi) =>
    wordToWordBlock(w, line, row1Based, wi + 1, existingBlock?.words?.[wi]),
  );
  return {
    id,
    text: String(line.text ?? ""),
    duration,
    sourceIn,
    sourceOut,
    isDeleted: line.is_deleted === true || line.isDeleted === true,
    isSilence: line.is_silence === true || line.isSilence === true,
    words: words.length ? words : undefined,
    ...(line.flags ? { flags: { ...line.flags } } : {}),
  };
}

/**
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 * @param {{ preserveIds?: readonly Block[] }} [opts]
 * @returns {Block[]}
 */
export function subtitleLinesToBlocks(lines, opts = {}) {
  const preserve = opts.preserveIds || [];
  const byId = new Map(preserve.map((b) => [b.id, b]));
  return (lines || []).map((line, i) => {
    const blockId = line.blockId || preserve[i]?.id;
    const existing = (blockId && byId.get(blockId)) || preserve[i];
    const block = lineToBlock(line, i, existing);
    if (line.blockId) block.id = line.blockId;
    return block;
  });
}

/**
 * @param {WordBlock} w
 * @param {import("./subtitles.js").SubtitleLine} cue
 */
function wordBlockToSubtitleWord(w, cue) {
  const sourceIn = Number(w.sourceIn) || 0;
  const sourceOut = Math.max(sourceIn, Number(w.sourceOut) || sourceIn);
  /** @type {import("./subtitles.js").SubtitleWord} */
  const out = {
    id: w.id,
    word: w.text,
    start: sourceIn,
    end: sourceOut,
    sourceStart: sourceIn,
    sourceEnd: sourceOut,
    source_start: sourceIn,
    source_end: sourceOut,
  };
  if (w.isDeleted) {
    out.is_deleted = true;
    out.isDeleted = true;
  }
  if (w.isSilence) {
    out.is_silence = true;
    out.isSilence = true;
  }
  if (w.mergedByEdgeTrim) {
    out.merged_by_edge_trim = true;
    out.mergedByEdgeTrim = true;
  }
  if (w.splitChain) {
    out.split_chain = w.splitChain;
    out.splitChain = w.splitChain;
  }
  if (Number.isFinite(Number(w.hintStart))) out.hintStart = Number(w.hintStart);
  if (Number.isFinite(Number(w.hintEnd))) out.hintEnd = Number(w.hintEnd);
  void cue;
  return out;
}

/**
 * @param {Block} block
 */
function blockMediaSpan(block) {
  const words = block.words || [];
  if (words.length) {
    let min = Infinity;
    let max = -Infinity;
    for (const w of words) {
      if (w.isDeleted && !w.mergedByEdgeTrim) continue;
      min = Math.min(min, w.sourceIn);
      max = Math.max(max, w.sourceOut);
    }
    if (Number.isFinite(min) && Number.isFinite(max)) {
      return { start: min, end: Math.max(min, max) };
    }
  }
  const sourceIn = Number(block.sourceIn) || 0;
  const sourceOut = Math.max(sourceIn, Number(block.sourceOut) || sourceIn);
  return { start: sourceIn, end: sourceOut };
}

/**
 * @param {readonly Block[]} blocks
 * @param {readonly VirtualIndexEntry[]} virtualIndex
 * @returns {import("./subtitles.js").SubtitleLine[]}
 */
export function blocksToSubtitleLines(blocks, virtualIndex) {
  void virtualIndex;
  return (blocks || []).map((block) => {
    const { start, end } = blockMediaSpan(block);
    const sourceIn = Number(block.sourceIn) || 0;
    const sourceOut = Math.max(sourceIn, Number(block.sourceOut) || sourceIn);
    /** @type {import("./subtitles.js").SubtitleLine} */
    const line = {
      blockId: block.id,
      text: block.text,
      start,
      end,
      sourceStart: sourceIn,
      sourceEnd: sourceOut,
      source_start: sourceIn,
      source_end: sourceOut,
    };
    if (block.isDeleted) {
      line.is_deleted = true;
      line.isDeleted = true;
    }
    if (block.isSilence) {
      line.is_silence = true;
      line.isSilence = true;
    }
    if (block.words?.length) {
      line.words = block.words.map((w) => wordBlockToSubtitleWord(w, line));
      const vis = visibleSubtitleWords(line.words);
      if (vis.length) {
        line.start = vis[0].start;
        line.end = Math.max(vis[0].start + 0.1, vis[vis.length - 1].end);
      }
    }
    if (block.flags) line.flags = { ...block.flags };
    return line;
  });
}

/**
 * @param {readonly Block[]} blocks
 */
/**
 * @param {readonly VirtualIndexEntry[]} virtualIndex
 * @param {number} blockIndex
 */
export function virtualIndexEntryForBlockIndex(virtualIndex, blockIndex) {
  return (virtualIndex || []).find((e) => e.blockIndex === blockIndex) ?? null;
}

/**
 * Vrew 리스트 타임코드: "MM:SS + X.XX초"
 * @param {number} virtualStartSec
 * @param {number} durationSec
 */
export function formatVrewBlockTimecode(virtualStartSec, durationSec) {
  const start = Math.max(0, Number(virtualStartSec) || 0);
  const dur = Math.max(0, Number(durationSec) || 0);
  const m = Math.floor(start / 60);
  const sec = start - m * 60;
  const mm = String(m).padStart(2, "0");
  const ss = sec.toFixed(2).padStart(5, "0");
  return `${mm}:${ss} + ${dur.toFixed(2)}초`;
}

/**
 * @param {readonly VirtualIndexEntry[]} virtualIndex
 * @param {number} virtualSec
 */
export function findVirtualIndexEntryByVirtualSec(virtualIndex, virtualSec) {
  const idx = virtualIndex || [];
  if (!idx.length) return null;
  const t = Math.max(0, Number(virtualSec) || 0);
  let lo = 0;
  let hi = idx.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = idx[mid];
    if (t < e.virtualStart - EPS) hi = mid - 1;
    else if (t >= e.virtualEnd + EPS) lo = mid + 1;
    else return e;
  }
  return null;
}

/**
 * @param {import("./block-timeline-adapter.js").WordBlock | undefined} w
 */
function wordBlockPlayableDuration(w) {
  const d = Number(w?.duration);
  if (Number.isFinite(d) && d > 0) return d;
  const si = Number(w?.sourceIn) || 0;
  const so = Math.max(si, Number(w?.sourceOut) || si);
  return Math.max(0, so - si);
}

/**
 * @param {WordBlock | undefined} w
 */
function isActiveWordBlockForMapping(w) {
  if (!w) return false;
  if (w.isDeleted && !w.mergedByEdgeTrim) return false;
  return true;
}

/**
 * Duration Shrink — 블록 내부 삭제 gap을 반영해 미디어→가상 offset (선형 si~so 매핑 금지).
 *
 * @param {number} mediaSec
 * @param {Block} block
 * @returns {number | null}
 */
export function mapMediaSecToVirtualOffsetInBlock(mediaSec, block) {
  if (!block || block.isDeleted) return null;
  const t = Number(mediaSec);
  if (!Number.isFinite(t)) return null;
  const blockDur = Math.max(0, Number(block.duration) || 0);

  const words = block.words || [];
  if (words.length) {
    let acc = 0;
    let lastActiveEnd = null;
    for (const w of words) {
      if (!isActiveWordBlockForMapping(w)) continue;
      const si = Number(w.sourceIn) || 0;
      const so = Math.max(si, Number(w.sourceOut) || si);
      const wDur = wordBlockPlayableDuration(w);
      if (t >= si - EPS && t < so + EPS) {
        const span = so - si;
        const inner = span > EPS ? ((t - si) / span) * wDur : 0;
        return Math.min(blockDur, acc + inner);
      }
      if (t < si - EPS) {
        if (acc > 0 && lastActiveEnd != null && t >= lastActiveEnd - EPS) {
          return Math.min(blockDur, acc);
        }
        return null;
      }
      acc += wDur;
      lastActiveEnd = so;
    }
    if (acc > 0 && lastActiveEnd != null && t >= lastActiveEnd - EPS) {
      const si = Number(block.sourceIn) || 0;
      const so = Math.max(si, Number(block.sourceOut) || si);
      if (t <= so + EPS) return Math.min(blockDur, acc);
    }
    return null;
  }

  const si = Number(block.sourceIn) || 0;
  const so = Math.max(si, Number(block.sourceOut) || si);
  if (t < si - EPS || t >= so + EPS) return null;
  const span = so - si;
  if (span <= EPS) return 0;
  return Math.min(blockDur, ((t - si) / span) * blockDur);
}

/**
 * 미디어 시계 → 가상 블록 타임라인 초.
 *
 * @param {number} mediaSec
 * @param {readonly Block[]} blocks
 * @param {readonly VirtualIndexEntry[]} virtualIndex
 * @param {readonly { start: number, end: number }[]} [skipRanges]
 * @param {(timeSec: number, ranges: readonly { start: number, end: number }[]) => number} [skipFn]
 * @param {{ listOrderClips?: readonly object[], mapMediaToProgramSec?: (mediaSec: number, clips: readonly object[]) => number }} [listOrder]
 */
export function mapMediaToBlockVirtualSec(
  mediaSec,
  blocks,
  virtualIndex,
  skipRanges = [],
  skipFn = null,
  listOrder = {},
) {
  const clips = listOrder.listOrderClips;
  const mapProgram = listOrder.mapMediaToProgramSec;
  if (clips?.length && typeof mapProgram === "function") {
    return mapProgram(Math.max(0, Number(mediaSec) || 0), clips);
  }

  let t =
    typeof skipFn === "function"
      ? skipFn(Math.max(0, Number(mediaSec) || 0), skipRanges || [])
      : Math.max(0, Number(mediaSec) || 0);

  for (const entry of virtualIndex || []) {
    const block = blocks[entry.blockIndex];
    if (!block || block.isDeleted) continue;
    const offset = mapMediaSecToVirtualOffsetInBlock(t, block);
    if (offset != null) {
      return entry.virtualStart + offset;
    }
  }

  for (const entry of virtualIndex || []) {
    const block = blocks[entry.blockIndex];
    if (!block || block.isDeleted) continue;
    const si = Number(block.sourceIn) || 0;
    if (si > t + EPS) {
      return entry.virtualStart;
    }
  }

  const lastEntry = virtualIndex?.length ? virtualIndex[virtualIndex.length - 1] : null;
  if (lastEntry) {
    const lastBlock = blocks[lastEntry.blockIndex];
    const lastOut = lastBlock ? Number(lastBlock.sourceOut) || 0 : 0;
    if (t >= lastOut - EPS) return lastEntry.virtualEnd;
    return Math.max(0, lastEntry.virtualStart);
  }

  return t + VIRTUAL_GAP_FALLBACK_SEC;
}

/**
 * @param {readonly Block[]} blocks
 */
export function countListableBlocks(blocks) {
  let n = 0;
  for (const block of blocks || []) {
    if (block.isDeleted) continue;
    if (block.isSilence) {
      n += 1;
      continue;
    }
    const words = block.words || [];
    const hasVisibleWord = words.some((w) => !w.isDeleted && !w.isSilence && String(w.text || "").trim());
    const hasText = String(block.text || "").trim().length > 0;
    if (hasVisibleWord || hasText) n += 1;
  }
  return n;
}
