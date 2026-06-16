/**
 * AutoSubtitle App.tsx 오케스트레이션 — 웹 SSOT·undo/redo·축 매핑·가시 줄.
 * Phase 0: Block SSOT + SubtitleLine derived via adapter.
 */

import { mergeCutRanges } from "../shared/timeline-collapse.js";
import {
  mergeWaveformPeaksStitchCutRanges,
  mergeDeletedMediaIntoTimeline,
  virtualTimelineBlocksFromCueSoftDeletes,
} from "../shared/virtual-timeline.js";
import { visibleSubtitleWords, wordIsDeleted } from "../shared/subtitles.js?v=24";
import {
  syncCuesAfterWordEdit,
  postProcessCuesAfterTranscribe,
  normalizeCuesFromAgent,
  applyLeadingSilenceSplitOnly,
  repairCueLinesWordTimelines,
} from "../shared/cues-ssot.js?v=40";
import { anchorSourceTimesIfMissing } from "../shared/dual-axis.js?v=1";
import { commitSubtitleLinesThroughTimeline } from "../shared/sentence-token-timeline-adapter.js?v=4";
import { syncAllSubtitleLinesFromWords, syncSubtitleLineFromWords } from "../shared/subtitles.js?v=24";
import { reconcileAllCuesWordsToLineText } from "../subtitle-words.js?v=24";
import {
  blocksMeaningfullyChanged,
  blocksStructurallyEqual,
  blocksToSubtitleLines,
  rebuildVirtualIndexFromBlocks,
  subtitleLinesToBlocks,
  virtualIndexEntryForBlockIndex,
} from "../shared/block-timeline-adapter.js?v=4";
import {
  reorderBlocksByListInsert,
  reorderBlocksByListPosition,
} from "../shared/block-edit-ops.js?v=2";
import {
  applySoftDeleteWordRangeOnBlocks,
  mergeBlocksAt as spliceMergeBlocksAt,
} from "../shared/block-word-edit-ops.js?v=2";
import { splitCueByEnter, splitCueAtMediaSec } from "../shared/line-mode/cue-ops.js?v=7";
import { reflowCuesSkipUserMoved } from "../shared/line-mode/reflow.js?v=2";
import {
  mergeEmptyBlockWithPrevious,
  spliceSplitBlockAtTextCursor,
  spliceSplitBlockAtWordIndex,
  spliceSplitBlockByWordBreaks,
} from "../shared/block-split-merge-ops.js?v=1";

const MAX_HISTORY = 100;

/**
 * @param {unknown} raw
 */
function isAutoSubtitleProjectDocument(raw) {
  return (
    raw != null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw.format === "autosubtitle-project" ||
      Array.isArray(raw.blocks) ||
      Array.isArray(raw.subtitles))
  );
}

/**
 * @typedef {import("../shared/block-timeline-adapter.js").Block} Block
 * @typedef {import("../shared/block-timeline-adapter.js").VirtualIndexEntry} VirtualIndexEntry
 * @typedef {{
 *   blocks: Block[],
 *   cutRanges: { start: number, end: number }[],
 *   virtualTimelineDeleted: import("../shared/virtual-timeline.js").VirtualTimelineBlock[],
 *   hardDeletedMediaSkips: { start: number, end: number }[],
 *   gapFillWhenBuildingVrew: boolean,
 *   playbackSnapshot?: { programSec: number, listPlaybackClipPos: number } | null,
 * }} SubtitleHistoryEntry
 */

/**
 * @param {import("../shared/subtitles.js").SubtitleLine[]} lines
 */
function cuesMeaningfullyChanged(a, b) {
  if (a === b) return false;
  if (a.length !== b.length) return true;
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * @param {import("../shared/subtitles.js").SubtitleLine[]} lines
 */
export function deriveVisibleSubtitleLinesForUi(lines) {
  const out = [];
  for (const line of lines || []) {
    if (line.is_deleted || line.isDeleted) continue;
    if (line.is_silence || line.isSilence) {
      out.push(line);
      continue;
    }
    const vis = visibleSubtitleWords(line.words);
    const text = String(line.text || "").trim();
    if (vis.length > 0 || text.length > 0) out.push(line);
  }
  return out;
}

export class SubtitleAppHub {
  /**
   * @param {{ onStateChange?: () => void, playbackSnapshotProvider?: () => { programSec: number, listPlaybackClipPos: number } | null }} [opts]
   */
  constructor(opts = {}) {
    /** @type {Block[]} */
    this.blocks = [];
    /** @type {VirtualIndexEntry[]} */
    this._virtualIndex = [];
    /** @type {import("../shared/subtitles.js").SubtitleLine[] | null} */
    this._derivedCues = null;
    /** @type {{ start: number, end: number }[]} */
    this.cutRanges = [];
    /** @type {import("../shared/virtual-timeline.js").VirtualTimelineBlock[]} */
    this.virtualTimelineDeleted = [];
    /** @type {{ start: number, end: number }[]} preview-only orphan media skips (Phase 3B) */
    this.hardDeletedMediaSkips = [];
    this.gapFillWhenBuildingVrew = false;
    /** @type {number | null} transcribe Whisper info.duration — pcm timeline_sec 와 비교용 */
    this.transcribeWhisperDurationSec = null;
    /** @type {import("../shared/line-mode/snap-engine.js").ReturnType<import("../shared/line-mode/snap-engine.js").buildSnapGridFromPeaks> | null} */
    this.snapGrid = null;
    /** @type {SubtitleHistoryEntry[]} */
    this._undoStack = [];
    /** @type {SubtitleHistoryEntry[]} */
    this._redoStack = [];
    this.onStateChange = opts.onStateChange || (() => {});
    /** @type {(() => { programSec: number, listPlaybackClipPos: number } | null) | null} */
    this._playbackSnapshotProvider = opts.playbackSnapshotProvider || null;
    /** @type {{ programSec: number, listPlaybackClipPos: number } | null} */
    this._restoredPlaybackSnapshot = null;

    Object.defineProperty(this, "cues", {
      configurable: true,
      enumerable: true,
      get: () => this._getDerivedCues(),
      set() {
        throw new Error(
          "SubtitleAppHub.cues is read-only; use applySubtitleChange, setCues, or applyBlockChange.",
        );
      },
    });
  }

  _getDerivedCues() {
    if (!this._derivedCues) {
      this._derivedCues = blocksToSubtitleLines(this.blocks, this._virtualIndex);
    }
    return this._derivedCues;
  }

  /**
   * @param {Block[]} nextBlocks
   * @param {{ recordHistory?: boolean }} [opts]
   */
  applyBlockChange(updater, opts = {}) {
    void opts;
    const prevBlocks = this.blocks;
    const nextBlocks = updater(prevBlocks) ?? [];
    if (!blocksMeaningfullyChanged(prevBlocks, nextBlocks)) return;

    const structural = !blocksStructurallyEqual(prevBlocks, nextBlocks);
    this.blocks = nextBlocks;
    if (structural) {
      this._rebuildVirtualIndex();
    }
    this._derivedCues = null;
  }

  _rebuildVirtualIndex() {
    this._virtualIndex = rebuildVirtualIndexFromBlocks(this.blocks);
  }

  _commitBlocks(nextBlocks) {
    this.applyBlockChange(() => nextBlocks, { recordHistory: false });
  }

  _syncVirtualTimelineDeleted() {
    this.virtualTimelineDeleted = virtualTimelineBlocksFromCueSoftDeletes(this.cues);
  }

  get mergedCutRanges() {
    return mergeCutRanges(this.cutRanges);
  }

  getPlaybackSkipRanges() {
    const base = mergeWaveformPeaksStitchCutRanges(
      this.mergedCutRanges,
      this.cues,
      this.virtualTimelineDeleted,
    );
    if (!this.hardDeletedMediaSkips?.length) return base;
    return mergeCutRanges([...base, ...mergeCutRanges(this.hardDeletedMediaSkips)]);
  }

  /**
   * @param {Block | null | undefined} block
   */
  _appendHardDeletedMediaSkipFromBlock(block) {
    if (!block) return;
    const start = Number(block.sourceIn) || 0;
    const end = Number(block.sourceOut) || 0;
    if (end <= start + 1e-6) return;
    this.hardDeletedMediaSkips = mergeCutRanges([
      ...this.hardDeletedMediaSkips,
      { start, end },
    ]);
  }

  /**
   * Phase 3B — hard delete (direct applyBlockChange).
   * @param {number} blockIndex
   * @param {{ recordHistory?: boolean }} [opts]
   */
  deleteBlockAt(blockIndex, opts = {}) {
    const recordHistory = opts.recordHistory !== false;
    if (blockIndex < 0 || blockIndex >= this.blocks.length) return;
    const prev = this._snapshot();
    this._appendHardDeletedMediaSkipFromBlock(this.blocks[blockIndex]);
    this.applyBlockChange((blocks) => [
      ...blocks.slice(0, blockIndex),
      ...blocks.slice(blockIndex + 1),
    ]);
    this._syncVirtualTimelineDeleted();
    if (recordHistory) this._pushHistory(prev);
    this._notify();
  }

  /**
   * @param {readonly number[]} blockIndices storage indices, any order
   * @param {{ recordHistory?: boolean }} [opts]
   */
  deleteBlocksAt(blockIndices, opts = {}) {
    const recordHistory = opts.recordHistory !== false;
    const unique = [...new Set(blockIndices)].filter((i) => i >= 0).sort((a, b) => b - a);
    if (!unique.length) return;
    const prev = this._snapshot();
    for (const i of unique) {
      if (i >= 0 && i < this.blocks.length) {
        this._appendHardDeletedMediaSkipFromBlock(this.blocks[i]);
      }
    }
    this.applyBlockChange((blocks) => {
      let next = blocks;
      for (const i of unique) {
        if (i < 0 || i >= next.length) continue;
        next = [...next.slice(0, i), ...next.slice(i + 1)];
      }
      return next;
    });
    this._syncVirtualTimelineDeleted();
    if (recordHistory) this._pushHistory(prev);
    this._notify();
  }

  /**
   * @param {number} fromListPos
   * @param {number} insertBeforeListPos
   * @param {{ recordHistory?: boolean }} [opts]
   */
  reorderBlocksByListInsert(fromListPos, insertBeforeListPos, opts = {}) {
    const recordHistory = opts.recordHistory !== false;
    const prev = this._snapshot();
    const cues = this.cues;
    const next = reorderBlocksByListInsert(this.blocks, cues, fromListPos, insertBeforeListPos);
    if (next === this.blocks) return { ok: true, changed: false };
    this.applyBlockChange(() => next);
    this._syncVirtualTimelineDeleted();
    if (recordHistory) this._pushHistory(prev);
    this._notify();
    return { ok: true, changed: true };
  }

  /**
   * @param {number} fromListPos
   * @param {number} toListPos
   * @param {{ recordHistory?: boolean }} [opts]
   */
  reorderBlocksByListPosition(fromListPos, toListPos, opts = {}) {
    const recordHistory = opts.recordHistory !== false;
    const prev = this._snapshot();
    const cues = this.cues;
    const next = reorderBlocksByListPosition(this.blocks, cues, fromListPos, toListPos);
    if (next === this.blocks) return { ok: true, changed: false };
    this.applyBlockChange(() => next);
    this._syncVirtualTimelineDeleted();
    if (recordHistory) this._pushHistory(prev);
    this._notify();
    return { ok: true, changed: true };
  }

  /**
   * Phase 3C — block structural edit with optional hard-delete skip capture.
   * @param {(blocks: Block[]) => { blocks: Block[], hardDeletedBlock?: Block | null }} mutator
   * @param {{ recordHistory?: boolean }} [opts]
   */
  _runBlockStructuralEdit(mutator, opts = {}) {
    const recordHistory = opts.recordHistory !== false;
    const prev = this._snapshot();
    const result = mutator(this.blocks);
    const nextBlocks = result?.blocks ?? this.blocks;
    if (!blocksMeaningfullyChanged(prev.blocks, nextBlocks)) return false;
    if (result?.hardDeletedBlock) {
      this._appendHardDeletedMediaSkipFromBlock(result.hardDeletedBlock);
    }
    this.applyBlockChange(() => nextBlocks);
    this._syncVirtualTimelineDeleted();
    if (recordHistory) this._pushHistory(prev);
    this._notify();
    return true;
  }

  /**
   * @param {number} blockIndex
   * @param {number} fromWordIndex
   * @param {number} toWordIndexExclusive
   * @param {{ recordHistory?: boolean }} [opts]
   */
  softDeleteWordRangeAt(blockIndex, fromWordIndex, toWordIndexExclusive, opts = {}) {
    return this._runBlockStructuralEdit(
      (blocks) =>
        applySoftDeleteWordRangeOnBlocks(blocks, blockIndex, fromWordIndex, toWordIndexExclusive),
      opts,
    );
  }

  /**
   * @param {number} leftIndex
   * @param {number} rightIndex
   * @param {string} [mergedText]
   * @param {{ recordHistory?: boolean }} [opts]
   */
  mergeBlocksAt(leftIndex, rightIndex, mergedText, opts = {}) {
    return this._runBlockStructuralEdit(
      (blocks) => spliceMergeBlocksAt(blocks, leftIndex, rightIndex, mergedText),
      opts,
    );
  }

  /**
   * @param {number} blockIndex
   * @param {number} cursorPos
   * @param {{ recordHistory?: boolean }} [opts]
   */
  splitBlockAtTextCursor(blockIndex, cursorPos, opts = {}) {
    return this._runBlockStructuralEdit(
      (blocks) => spliceSplitBlockAtTextCursor(blocks, blockIndex, cursorPos),
      opts,
    );
  }

  /**
   * @param {number} blockIndex
   * @param {number} wordIndex
   * @param {{ recordHistory?: boolean }} [opts]
   */
  splitBlockAtWordIndex(blockIndex, wordIndex, opts = {}) {
    return this._runBlockStructuralEdit(
      (blocks) => spliceSplitBlockAtWordIndex(blocks, blockIndex, wordIndex),
      opts,
    );
  }

  /**
   * Line Mode v4 — Enter 분할 (hint midpoint, userMoved=false).
   * @param {number} blockIndex
   * @param {number} wordIndex
   * @param {{ recordHistory?: boolean }} [opts]
   */
  splitLineCueAtWordIndex(blockIndex, wordIndex, opts = {}) {
    let didSplit = false;
    this.applySubtitleChange(
      (lines) => {
        const cue = lines[blockIndex];
        if (!cue) return lines;
        const parts = splitCueByEnter(cue, wordIndex);
        if (parts.length < 2) return lines;
        didSplit = true;
        const next = lines.slice();
        next.splice(
          blockIndex,
          1,
          ...parts.map((part) => syncSubtitleLineFromWords(part)),
        );
        return next;
      },
      { ...opts, forceCommit: true },
    );
    return didSplit;
  }

  /**
   * Line Mode — 재생 라인 시각에서 줄 분할.
   * @param {number} blockIndex
   * @param {number} splitMediaSec
   * @param {{ recordHistory?: boolean }} [opts]
   */
  splitLineCueAtMediaSec(blockIndex, splitMediaSec, opts = {}) {
    let didSplit = false;
    this.applySubtitleChange(
      (lines) => {
        const cue = lines[blockIndex];
        if (!cue) return lines;
        const parts = splitCueAtMediaSec(cue, splitMediaSec);
        if (parts.length < 2) return lines;
        didSplit = true;
        const next = lines.slice();
        next.splice(
          blockIndex,
          1,
          ...parts.map((part) => syncSubtitleLineFromWords(part)),
        );
        return next;
      },
      { ...opts, forceCommit: true },
    );
    return didSplit;
  }

  /**
   * Line Mode Phase C — userMoved cue 유지 후 줄 재정리.
   * @param {"horizontal" | "vertical"} [mode]
   * @param {{ recordHistory?: boolean }} [opts]
   */
  reflowLineMode(mode = "horizontal", opts = {}) {
    const next = reflowCuesSkipUserMoved(this.cues, mode);
    this.setCues(next, opts);
    return true;
  }

  /**
   * @param {number} blockIndex
   * @param {readonly number[]} breakAfterStorageIndices
   * @param {{ recordHistory?: boolean }} [opts]
   */
  splitBlockByWordBreaks(blockIndex, breakAfterStorageIndices, opts = {}) {
    return this._runBlockStructuralEdit(
      (blocks) => spliceSplitBlockByWordBreaks(blocks, blockIndex, breakAfterStorageIndices),
      opts,
    );
  }

  /**
   * @param {readonly { blockIndex: number, breakAfterStorageIndices: readonly number[] }[]} splits
   * @param {{ recordHistory?: boolean }} [opts]
   */
  applyBatchBlockByWordBreaks(splits, opts = {}) {
    if (!splits?.length) return false;
    return this._runBlockStructuralEdit((blocks) => {
      let next = blocks;
      for (let i = splits.length - 1; i >= 0; i -= 1) {
        const { blockIndex, breakAfterStorageIndices } = splits[i];
        if (blockIndex < 0 || blockIndex >= next.length) continue;
        ({ blocks: next } = spliceSplitBlockByWordBreaks(next, blockIndex, breakAfterStorageIndices));
      }
      return { blocks: next };
    }, opts);
  }

  /**
   * @param {number} blockIndex
   * @param {{ recordHistory?: boolean }} [opts]
   */
  mergeEmptyBlockAt(blockIndex, opts = {}) {
    return this._runBlockStructuralEdit(
      (blocks) => {
        const next = mergeEmptyBlockWithPrevious(blocks, blockIndex);
        return next ? { blocks: next } : { blocks };
      },
      opts,
    );
  }

  /** EDL-only: UI·칩·파형 좌표 = 미디어 축 (항등). */
  getMediaTimeFromEditTime(editSec) {
    return editSec;
  }

  /** EDL-only: UI·칩·파형 좌표 = 미디어 축 (항등). */
  getEditTimeFromMediaTime(mediaSec) {
    return mediaSec;
  }

  /**
   * @param {{ start: number, end: number }} mediaCut
   * @param {string} [textHint]
   */
  mergeVirtualTimelineDeleted(mediaCut, textHint = "") {
    this.virtualTimelineDeleted = mergeDeletedMediaIntoTimeline(
      this.virtualTimelineDeleted,
      mediaCut,
      textHint,
    );
  }

  getCuesForList() {
    return deriveVisibleSubtitleLinesForUi(this.cues);
  }

  /** @param {number} blockIndex cue storage index (= blockIndex when 1:1) */
  getVirtualIndexForBlock(blockIndex) {
    return virtualIndexEntryForBlockIndex(this._virtualIndex, blockIndex);
  }

  canUndo() {
    return this._undoStack.length > 0;
  }

  canRedo() {
    return this._redoStack.length > 0;
  }

  _notify() {
    this.onStateChange();
  }

  _capturePlaybackSnapshot() {
    if (typeof this._playbackSnapshotProvider !== "function") return null;
    const snap = this._playbackSnapshotProvider();
    if (!snap || !Number.isFinite(Number(snap.programSec))) return null;
    return {
      programSec: Number(snap.programSec) || 0,
      listPlaybackClipPos: Number.isInteger(snap.listPlaybackClipPos)
        ? snap.listPlaybackClipPos
        : -1,
    };
  }

  consumeRestoredPlaybackSnapshot() {
    const snap = this._restoredPlaybackSnapshot;
    this._restoredPlaybackSnapshot = null;
    return snap;
  }

  /**
   * @param {SubtitleHistoryEntry} snap
   */
  _pushHistory(snap) {
    this._undoStack.push({
      blocks: JSON.parse(JSON.stringify(snap.blocks)),
      cutRanges: JSON.parse(JSON.stringify(snap.cutRanges)),
      virtualTimelineDeleted: JSON.parse(JSON.stringify(snap.virtualTimelineDeleted)),
      hardDeletedMediaSkips: JSON.parse(JSON.stringify(snap.hardDeletedMediaSkips || [])),
      gapFillWhenBuildingVrew: snap.gapFillWhenBuildingVrew,
      playbackSnapshot: snap.playbackSnapshot
        ? { ...snap.playbackSnapshot }
        : this._capturePlaybackSnapshot(),
    });
    if (this._undoStack.length > MAX_HISTORY) this._undoStack.shift();
    this._redoStack = [];
  }

  _snapshot() {
    return {
      blocks: this.blocks,
      cutRanges: this.cutRanges,
      virtualTimelineDeleted: this.virtualTimelineDeleted,
      hardDeletedMediaSkips: this.hardDeletedMediaSkips,
      gapFillWhenBuildingVrew: this.gapFillWhenBuildingVrew,
      playbackSnapshot: this._capturePlaybackSnapshot(),
    };
  }

  /**
   * @param {import("../shared/subtitles.js").SubtitleLine[]} lines
   */
  _commitLines(lines) {
    return syncCuesAfterWordEdit(lines || []);
  }

  /**
   * B) Direct lines
   * @param {import("../shared/subtitles.js").SubtitleLine[]} cues
   * @param {{ cutRanges?: { start: number, end: number }[], recordHistory?: boolean }} [opts]
   */
  setCues(cues, opts = {}) {
    const recordHistory = opts.recordHistory !== false;
    const prev = this._snapshot();
    const nextLines = this._commitLines(cues);
    const nextBlocks = subtitleLinesToBlocks(nextLines, { preserveIds: this.blocks });
    this._commitBlocks(nextBlocks);
    if (opts.cutRanges) this.cutRanges = opts.cutRanges;
    this._syncVirtualTimelineDeleted();
    if (recordHistory && blocksMeaningfullyChanged(prev.blocks, this.blocks)) {
      this._pushHistory(prev);
    }
    this._notify();
  }

  /**
   * A) Mutating
   * @param {(prev: import("../shared/subtitles.js").SubtitleLine[]) => import("../shared/subtitles.js").SubtitleLine[]} updater
   * @param {{ recordHistory?: boolean, afterCommit?: (hub: SubtitleAppHub) => void, forceCommit?: boolean }} [opts]
   */
  applySubtitleChange(updater, opts = {}) {
    const recordHistory = opts.recordHistory !== false;
    const prev = this._snapshot();
    const prevLines = this.cues;
    const next = updater(prevLines);
    if (!opts.forceCommit && !cuesMeaningfullyChanged(prevLines, next)) return;
    const nextLines = this._commitLines(next);
    const nextBlocks = subtitleLinesToBlocks(nextLines, { preserveIds: this.blocks });
    this._commitBlocks(nextBlocks);
    this._syncVirtualTimelineDeleted();
    if (recordHistory) this._pushHistory(prev);
    opts.afterCommit?.(this);
    this._notify();
  }

  /**
   * @param {{ start: number, end: number }[]} cuts
   * @param {{ recordHistory?: boolean }} [opts]
   */
  appendMediaCuts(cuts, opts = {}) {
    if (!cuts?.length) return;
    const merged = mergeCutRanges([...this.cutRanges, ...cuts]);
    this.setCutRanges(merged, opts);
  }

  /**
   * @param {{ start: number, end: number }[]} ranges
   * @param {{ recordHistory?: boolean }} [opts]
   */
  setCutRanges(ranges, opts = {}) {
    const recordHistory = opts.recordHistory !== false;
    const prev = this._snapshot();
    this.cutRanges = ranges || [];
    if (recordHistory) this._pushHistory(prev);
    this._notify();
  }

  /**
   * @param {import("../peaks-metrics.js").PeaksTimelineMetrics} peaksMetrics
   */
  reapplyExtractPostProcessWithPeaks(peaksMetrics) {
    const lines = applyLeadingSilenceSplitOnly(this.cues, peaksMetrics);
    this.setCues(lines, { recordHistory: false });
  }

  /**
   * @param {unknown} raw
   * @param {{ gapFill?: boolean, lineMode?: boolean, peaksMetrics?: import("../peaks-metrics.js").PeaksTimelineMetrics | null, whisperDurationSec?: number | null, mediaTiming?: object | null, snapGrid?: object | null }} [opts]
   */
  ingestFromTranscribe(raw, opts = {}) {
    this.cutRanges = [];
    this.virtualTimelineDeleted = [];
    this.hardDeletedMediaSkips = [];
    this.gapFillWhenBuildingVrew = false;
    this._undoStack = [];
    this._redoStack = [];
    if (opts.snapGrid) {
      this.snapGrid = opts.snapGrid;
    }
    const gapFill = opts.gapFill === true;
    const whisperDur =
      opts.whisperDurationSec != null && Number(opts.whisperDurationSec) > 0
        ? Number(opts.whisperDurationSec)
        : null;
    this.transcribeWhisperDurationSec = whisperDur;
    const lines = postProcessCuesAfterTranscribe(normalizeCuesFromAgent(raw), {
      gapFill,
      lineMode: opts.lineMode,
      peaksMetrics: opts.peaksMetrics ?? null,
      whisperDurationSec: whisperDur,
      mediaTiming: opts.mediaTiming ?? null,
    });
    this.setCues(lines, { recordHistory: false });
  }

  /**
   * @param {object | null} grid
   */
  setSnapGrid(grid) {
    this.snapGrid = grid;
    this._notify();
  }

  /**
   * @param {unknown} raw cues[] or project document
   * @param {{ cutRanges?: { start: number, end: number }[], hardDeletedMediaSkips?: { start: number, end: number }[] }} [opts]
   */
  ingestFromProject(raw, opts = {}) {
    if (isAutoSubtitleProjectDocument(raw)) {
      this._ingestProjectDocument(raw, opts);
      return;
    }
    this._ingestLegacyProjectCues(raw, opts);
  }

  /**
   * @param {unknown} doc
   * @param {{ cutRanges?: { start: number, end: number }[], hardDeletedMediaSkips?: { start: number, end: number }[] }} [opts]
   */
  _ingestProjectDocument(doc, opts = {}) {
    this.virtualTimelineDeleted = [];
    this.gapFillWhenBuildingVrew = false;
    this._undoStack = [];
    this._redoStack = [];

    const version = Number(doc.version) || 1;
    const cutRanges = doc.cutRanges ?? opts.cutRanges ?? [];
    const hardSkips = doc.hardDeletedMediaSkips ?? opts.hardDeletedMediaSkips ?? [];

    if (version >= 2 && Array.isArray(doc.blocks) && doc.blocks.length) {
      this.blocks = JSON.parse(JSON.stringify(doc.blocks));
      this._rebuildVirtualIndex();
      this._derivedCues = null;
      this.cutRanges = cutRanges;
      this.hardDeletedMediaSkips = JSON.parse(JSON.stringify(hardSkips));
      if (doc.lineMode?.snapGrid) {
        this.snapGrid = JSON.parse(JSON.stringify(doc.lineMode.snapGrid));
      }
      this._syncVirtualTimelineDeleted();
      this._notify();
      return;
    }

    const lines = anchorSourceTimesIfMissing(
      repairCueLinesWordTimelines(
        commitSubtitleLinesThroughTimeline(
          syncAllSubtitleLinesFromWords(
            reconcileAllCuesWordsToLineText(normalizeCuesFromAgent(doc.subtitles || [])),
          ),
        ),
      ),
    );
    this.setCues(lines, { cutRanges, recordHistory: false });
    if (hardSkips?.length) {
      this.hardDeletedMediaSkips = JSON.parse(JSON.stringify(hardSkips));
    }
  }

  /**
   * @param {unknown} raw
   * @param {{ cutRanges?: { start: number, end: number }[] }} [opts]
   */
  _ingestLegacyProjectCues(raw, opts = {}) {
    this.virtualTimelineDeleted = [];
    this.hardDeletedMediaSkips = [];
    this.gapFillWhenBuildingVrew = false;
    this._undoStack = [];
    this._redoStack = [];
    const lines = anchorSourceTimesIfMissing(
      repairCueLinesWordTimelines(
        commitSubtitleLinesThroughTimeline(
          syncAllSubtitleLinesFromWords(
            reconcileAllCuesWordsToLineText(normalizeCuesFromAgent(raw)),
          ),
        ),
      ),
    );
    this.setCues(lines, { cutRanges: opts.cutRanges, recordHistory: false });
  }

  /** D) Reset */
  reset() {
    this.blocks = [];
    this._virtualIndex = [];
    this._derivedCues = null;
    this.cutRanges = [];
    this.virtualTimelineDeleted = [];
    this.hardDeletedMediaSkips = [];
    this._undoStack = [];
    this._redoStack = [];
    this.snapGrid = null;
    this._notify();
  }

  /** C) Snapshot restore */
  undo() {
    if (!this._undoStack.length) return false;
    const cur = this._snapshot();
    this._redoStack.push({
      blocks: JSON.parse(JSON.stringify(cur.blocks)),
      cutRanges: JSON.parse(JSON.stringify(cur.cutRanges)),
      virtualTimelineDeleted: JSON.parse(JSON.stringify(cur.virtualTimelineDeleted)),
      hardDeletedMediaSkips: JSON.parse(JSON.stringify(cur.hardDeletedMediaSkips || [])),
      gapFillWhenBuildingVrew: cur.gapFillWhenBuildingVrew,
      playbackSnapshot: cur.playbackSnapshot ? { ...cur.playbackSnapshot } : null,
    });
    const entry = this._undoStack.pop();
    this.blocks = JSON.parse(JSON.stringify(entry.blocks));
    this.cutRanges = entry.cutRanges;
    this.virtualTimelineDeleted = entry.virtualTimelineDeleted || [];
    this.hardDeletedMediaSkips = entry.hardDeletedMediaSkips || [];
    this.gapFillWhenBuildingVrew = entry.gapFillWhenBuildingVrew;
    this._restoredPlaybackSnapshot = entry.playbackSnapshot
      ? { ...entry.playbackSnapshot }
      : null;
    this._rebuildVirtualIndex();
    this._derivedCues = null;
    this._notify();
    return true;
  }

  /** C) Snapshot restore */
  redo() {
    if (!this._redoStack.length) return false;
    const cur = this._snapshot();
    this._undoStack.push({
      blocks: JSON.parse(JSON.stringify(cur.blocks)),
      cutRanges: JSON.parse(JSON.stringify(cur.cutRanges)),
      virtualTimelineDeleted: JSON.parse(JSON.stringify(cur.virtualTimelineDeleted)),
      hardDeletedMediaSkips: JSON.parse(JSON.stringify(cur.hardDeletedMediaSkips || [])),
      gapFillWhenBuildingVrew: cur.gapFillWhenBuildingVrew,
      playbackSnapshot: cur.playbackSnapshot ? { ...cur.playbackSnapshot } : null,
    });
    const entry = this._redoStack.pop();
    this.blocks = JSON.parse(JSON.stringify(entry.blocks));
    this.cutRanges = entry.cutRanges;
    this.virtualTimelineDeleted = entry.virtualTimelineDeleted || [];
    this.hardDeletedMediaSkips = entry.hardDeletedMediaSkips || [];
    this.gapFillWhenBuildingVrew = entry.gapFillWhenBuildingVrew;
    this._restoredPlaybackSnapshot = entry.playbackSnapshot
      ? { ...entry.playbackSnapshot }
      : null;
    this._rebuildVirtualIndex();
    this._derivedCues = null;
    this._notify();
    return true;
  }

  /**
   * @param {number} cueIndex
   * @param {number} storageIndex
   */
  tombstoneWord(cueIndex, storageIndex) {
    this.applySubtitleChange((cues) => {
      const cue = cues[cueIndex];
      if (!cue?.words?.[storageIndex]) return cues;
      const words = [...cue.words];
      const w = { ...words[storageIndex] };
      w.is_deleted = true;
      w.isDeleted = true;
      words[storageIndex] = w;
      cues[cueIndex] = { ...cue, words };
      return [...cues];
    });
  }
}
