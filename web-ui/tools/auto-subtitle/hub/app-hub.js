/**
 * AutoSubtitle App.tsx 오케스트레이션 — 웹 SSOT·undo/redo·축 매핑·가시 줄.
 */

import { mergeCutRanges } from "../shared/timeline-collapse.js";
import {
  mergeWaveformPeaksStitchCutRanges,
  mergeDeletedMediaIntoTimeline,
} from "../shared/virtual-timeline.js";
import { visibleSubtitleWords, wordIsDeleted } from "../shared/subtitles.js?v=24";
import {
  syncCuesAfterWordEdit,
  postProcessCuesAfterTranscribe,
  normalizeCuesFromAgent,
  applyLeadingSilenceSplitOnly,
} from "../shared/cues-ssot.js?v=32";
import { commitSubtitleLinesThroughTimeline } from "../shared/sentence-token-timeline-adapter.js?v=3";
import { syncAllSubtitleLinesFromWords } from "../shared/subtitles.js?v=24";
import { reconcileAllCuesWordsToLineText } from "../subtitle-words.js?v=24";

const MAX_HISTORY = 100;

/**
 * @typedef {{
 *   cues: import("../shared/subtitles.js").SubtitleLine[],
 *   cutRanges: { start: number, end: number }[],
 *   virtualTimelineDeleted: import("../shared/virtual-timeline.js").VirtualTimelineBlock[],
 *   gapFillWhenBuildingVrew: boolean,
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
   * @param {{ onStateChange?: () => void }} [opts]
   */
  constructor(opts = {}) {
    /** @type {import("../shared/subtitles.js").SubtitleLine[]} */
    this.cues = [];
    /** @type {{ start: number, end: number }[]} */
    this.cutRanges = [];
    /** @type {import("../shared/virtual-timeline.js").VirtualTimelineBlock[]} */
    this.virtualTimelineDeleted = [];
    this.gapFillWhenBuildingVrew = false;
    /** @type {number | null} transcribe Whisper info.duration — pcm timeline_sec 와 비교용 */
    this.transcribeWhisperDurationSec = null;
    /** @type {SubtitleHistoryEntry[]} */
    this._undoStack = [];
    /** @type {SubtitleHistoryEntry[]} */
    this._redoStack = [];
    this.onStateChange = opts.onStateChange || (() => {});
  }

  get mergedCutRanges() {
    return mergeCutRanges(this.cutRanges);
  }

  getPlaybackSkipRanges() {
    return mergeWaveformPeaksStitchCutRanges(
      this.mergedCutRanges,
      this.cues,
      this.virtualTimelineDeleted,
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

  canUndo() {
    return this._undoStack.length > 0;
  }

  canRedo() {
    return this._redoStack.length > 0;
  }

  _notify() {
    this.onStateChange();
  }

  /**
   * @param {SubtitleHistoryEntry} snap
   */
  _pushHistory(snap) {
    this._undoStack.push({
      cues: JSON.parse(JSON.stringify(snap.cues)),
      cutRanges: JSON.parse(JSON.stringify(snap.cutRanges)),
      virtualTimelineDeleted: JSON.parse(JSON.stringify(snap.virtualTimelineDeleted)),
      gapFillWhenBuildingVrew: snap.gapFillWhenBuildingVrew,
    });
    if (this._undoStack.length > MAX_HISTORY) this._undoStack.shift();
    this._redoStack = [];
  }

  _snapshot() {
    return {
      cues: this.cues,
      cutRanges: this.cutRanges,
      virtualTimelineDeleted: this.virtualTimelineDeleted,
      gapFillWhenBuildingVrew: this.gapFillWhenBuildingVrew,
    };
  }

  /**
   * @param {import("../shared/subtitles.js").SubtitleLine[]} cues
   * @param {{ cutRanges?: { start: number, end: number }[], recordHistory?: boolean, gapFill?: boolean }} [opts]
   */
  _commitLines(lines) {
    return syncCuesAfterWordEdit(lines || []);
  }

  setCues(cues, opts = {}) {
    const recordHistory = opts.recordHistory !== false;
    const prev = this._snapshot();
    this.cues = this._commitLines(cues);
    if (opts.cutRanges) this.cutRanges = opts.cutRanges;
    if (recordHistory && cuesMeaningfullyChanged(prev.cues, this.cues)) {
      this._pushHistory(prev);
    }
    this._notify();
  }

  /**
   * @param {(prev: import("../shared/subtitles.js").SubtitleLine[]) => import("../shared/subtitles.js").SubtitleLine[]} updater
   * @param {{ recordHistory?: boolean, afterCommit?: (hub: SubtitleAppHub) => void }} [opts]
   */
  applySubtitleChange(updater, opts = {}) {
    const recordHistory = opts.recordHistory !== false;
    const prev = this._snapshot();
    const next = updater(this.cues);
    if (!cuesMeaningfullyChanged(prev.cues, next)) return;
    this.cues = this._commitLines(next);
    opts.afterCommit?.(this);
    if (recordHistory) this._pushHistory(prev);
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
   * 피크 로드 후 추출 2단계(leading split) 재적용.
   *
   * @param {import("../peaks-metrics.js").PeaksTimelineMetrics} peaksMetrics
   * @param {{ gapFill?: boolean }} [opts]
   */
  reapplyExtractPostProcessWithPeaks(peaksMetrics) {
    const lines = applyLeadingSilenceSplitOnly(this.cues, peaksMetrics);
    this.setCues(lines, { recordHistory: false });
  }

  /**
   * @param {unknown} raw
   * @param {{ gapFill?: boolean, peaksMetrics?: import("../peaks-metrics.js").PeaksTimelineMetrics | null, whisperDurationSec?: number | null }} [opts]
   */
  ingestFromTranscribe(raw, opts = {}) {
    this.cutRanges = [];
    this.virtualTimelineDeleted = [];
    this.gapFillWhenBuildingVrew = false;
    this._undoStack = [];
    this._redoStack = [];
    const gapFill = opts.gapFill === true;
    const whisperDur =
      opts.whisperDurationSec != null && Number(opts.whisperDurationSec) > 0
        ? Number(opts.whisperDurationSec)
        : null;
    this.transcribeWhisperDurationSec = whisperDur;
    const lines = postProcessCuesAfterTranscribe(normalizeCuesFromAgent(raw), {
      gapFill,
      peaksMetrics: opts.peaksMetrics ?? null,
      whisperDurationSec: whisperDur,
    });
    this.setCues(lines, { recordHistory: false });
  }

  /**
   * 저장 프로젝트 — 추출 후처리 재실행 없음.
   *
   * @param {unknown} raw
   * @param {{ cutRanges?: { start: number, end: number }[] }} [opts]
   */
  ingestFromProject(raw, opts = {}) {
    const lines = commitSubtitleLinesThroughTimeline(
      syncAllSubtitleLinesFromWords(
        reconcileAllCuesWordsToLineText(normalizeCuesFromAgent(raw)),
      ),
    );
    this.setCues(lines, { cutRanges: opts.cutRanges, recordHistory: false });
  }

  reset() {
    this.cues = [];
    this.cutRanges = [];
    this.virtualTimelineDeleted = [];
    this._undoStack = [];
    this._redoStack = [];
    this._notify();
  }

  undo() {
    if (!this._undoStack.length) return false;
    const cur = this._snapshot();
    this._redoStack.push({
      cues: JSON.parse(JSON.stringify(cur.cues)),
      cutRanges: JSON.parse(JSON.stringify(cur.cutRanges)),
      virtualTimelineDeleted: JSON.parse(JSON.stringify(cur.virtualTimelineDeleted)),
      gapFillWhenBuildingVrew: cur.gapFillWhenBuildingVrew,
    });
    const entry = this._undoStack.pop();
    this.cues = entry.cues;
    this.cutRanges = entry.cutRanges;
    this.virtualTimelineDeleted = entry.virtualTimelineDeleted || [];
    this.gapFillWhenBuildingVrew = entry.gapFillWhenBuildingVrew;
    this.cues = syncCuesAfterWordEdit(this.cues);
    this._notify();
    return true;
  }

  redo() {
    if (!this._redoStack.length) return false;
    const cur = this._snapshot();
    this._undoStack.push({
      cues: JSON.parse(JSON.stringify(cur.cues)),
      cutRanges: JSON.parse(JSON.stringify(cur.cutRanges)),
      virtualTimelineDeleted: JSON.parse(JSON.stringify(cur.virtualTimelineDeleted)),
      gapFillWhenBuildingVrew: cur.gapFillWhenBuildingVrew,
    });
    const entry = this._redoStack.pop();
    this.cues = entry.cues;
    this.cutRanges = entry.cutRanges;
    this.virtualTimelineDeleted = entry.virtualTimelineDeleted || [];
    this.gapFillWhenBuildingVrew = entry.gapFillWhenBuildingVrew;
    this.cues = syncCuesAfterWordEdit(this.cues);
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
