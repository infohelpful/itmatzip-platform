/**
 * 웹 Auto-Subtitle — 자막 SSOT 진입점 (로드·추출 후처리·편집 동기화).
 */

import { fillGapsInSubtitleWords } from "./word-contract.js";
import { NO_AUTO_GAP_FILL_AFTER_EDIT, shouldFillGapsWhenBuildingVrewRows } from "./phase5-edit-policy.js";
import { splitLeadingSilenceInSubtitleLines } from "./leading-silence-split-after-extract.js";
import { anchorSourceTimesIfMissing } from "./dual-axis.js?v=1";
import { commitSubtitleLinesThroughTimeline } from "./sentence-token-timeline-adapter.js?v=4";
import {
  insertMissingTemporalSilenceGapsInLine,
  linesContainDeletedWords,
  mergeConsecutiveSilenceWordsInLine,
  normalizeSilenceWordsForLineWords,
  parseSubtitleLines,
  pruneInvalidSubtitleWords,
  scaleSubtitleLinesTimes,
  repairCueLinesWordTimelines,
  syncAllSubtitleLinesFromWords,
  syncSubtitleLineFromWords,
} from "./subtitles.js?v=27";

/** 추출 직후 gap-fill 기본값 (Electron gapFillWhenBuildingVrew 기본 false) */
export const DEFAULT_GAP_FILL_ON_EXTRACT = false;

/**
 * 에이전트/프로젝트 raw cues → SSOT SubtitleLine[].
 *
 * @param {unknown} raw
 */
export function normalizeCuesFromAgent(raw) {
  return pruneInvalidSubtitleWords(parseSubtitleLines(raw));
}

/**
 * Whisper 추출 완료 직후 — peaks/Whisper 길이 비율 보정 → 피크 무음 분할 → `--` gap → 타임라인 SSOT.
 *
 * @param {import("./subtitles.js").SubtitleLine[]} lines
 * @param {{ gapFill?: boolean, peaksMetrics?: import("../peaks-metrics.js").PeaksTimelineMetrics | null, whisperDurationSec?: number | null, mediaTiming?: object | null }} [opts]
 */
export function postProcessCuesAfterTranscribe(lines, opts = {}) {
  const gapFill = opts.gapFill === true;
  let working = pruneInvalidSubtitleWords(lines || []);

  const peaksDur = opts.peaksMetrics?.durationSec;
  const mt = opts.mediaTiming;
  const mtDur =
    mt?.playback_duration_sec ?? mt?.word_timeline_duration_sec ?? mt?.video_duration_sec;
  const whisperDur = (() => {
    const fromMt = Number(mtDur);
    if (Number.isFinite(fromMt) && fromMt > 0) return fromMt;
    return Number(opts.whisperDurationSec);
  })();
  if (peaksDur > 0 && whisperDur > 0) {
    const ratio = peaksDur / whisperDur;
    if (Math.abs(ratio - 1) > 0.004) {
      working = scaleSubtitleLinesTimes(working, ratio);
    }
  }

  if (opts.peaksMetrics) {
    working = splitLeadingSilenceInSubtitleLines(working, opts.peaksMetrics);
  }

  let out = working.map((line) => {
    if (line.is_silence || line.isSilence) return line;
    let next = line;
    if (opts.peaksMetrics) {
      next = insertMissingTemporalSilenceGapsInLine(line, undefined, opts.peaksMetrics ?? null);
    }
    if (gapFill && next.words?.length) {
      const filled = fillGapsInSubtitleWords(
        { start: next.start, end: next.end, words: next.words },
        { stripPreviousSilences: true },
      );
      next = mergeConsecutiveSilenceWordsInLine({ ...next, words: filled });
    } else if (next.words?.length) {
      next = mergeConsecutiveSilenceWordsInLine({
        ...next,
        words: normalizeSilenceWordsForLineWords(next.words),
      });
    }
    return syncSubtitleLineFromWords(next);
  });
  const repaired = repairCueLinesWordTimelines(out, opts.peaksMetrics ?? null);
  const synced = commitSubtitleLinesThroughTimeline(syncAllSubtitleLinesFromWords(repaired));
  return anchorSourceTimesIfMissing(synced);
}

/**
 * 이미 temporal gap 처리된 cues에 피크 무음 분할만 추가 적용.
 *
 * @param {import("./subtitles.js").SubtitleLine[]} lines
 * @param {import("../peaks-metrics.js").PeaksTimelineMetrics} peaksMetrics
 */
export function applyLeadingSilenceSplitOnly(lines, peaksMetrics) {
  if (!peaksMetrics) return commitSubtitleLinesThroughTimeline(lines);
  let working = splitLeadingSilenceInSubtitleLines(lines, peaksMetrics);
  working = working.map((line) => {
    if (line.is_silence || line.isSilence) return line;
    const merged = mergeConsecutiveSilenceWordsInLine({
      ...line,
      words: normalizeSilenceWordsForLineWords(line.words),
    });
    return syncSubtitleLineFromWords(merged);
  });
  const repaired = repairCueLinesWordTimelines(working, peaksMetrics);
  return commitSubtitleLinesThroughTimeline(syncAllSubtitleLinesFromWords(repaired));
}

/**
 * 단어 편집 후 — Phase5: 자동 gap-fill 없음, 줄 메타만 동기화.
 *
 * @param {import("./subtitles.js").SubtitleLine[]} lines
 */
export function syncCuesAfterWordEdit(lines) {
  void NO_AUTO_GAP_FILL_AFTER_EDIT;
  return commitSubtitleLinesThroughTimeline(syncAllSubtitleLinesFromWords(lines));
}

/**
 * Peaks/Vrew 행 빌드 시 gap-fill 여부.
 *
 * @param {boolean} gapFillWhenBuildingVrew
 * @param {import("./subtitles.js").SubtitleLine[]} lines
 */
export function shouldApplyGapFillForLines(gapFillWhenBuildingVrew, lines) {
  return shouldFillGapsWhenBuildingVrewRows(
    gapFillWhenBuildingVrew,
    linesContainDeletedWords(lines),
  );
}

export { repairCueLinesWordTimelines } from "./subtitles.js?v=27";
