/**
 * 단어 자동정렬 — Kiwi(kiwipiepy) API + cue 분할 적용
 */

import { requestAgent } from "../common/bridge.js?v=lna15";
import { visibleSubtitleWords } from "./shared/subtitles.js?v=24";
import { explodeCueByWordBreaks } from "./shared/subtitle-edit-actions.js";
import { markCaretListStructuralMutation } from "./subtitle-list/word-caret-ui.js?v=54";

export const KIWI_LGPL_URL = "https://github.com/bab2min/kiwipiepy";

const MIN_VISIBLE_WORDS = 2;

/**
 * @param {string} langValue
 */
export function isKoreanLanguageSelected(langValue) {
  return String(langValue ?? "").trim().toLowerCase() === "ko";
}

/**
 * @param {import("./shared/subtitles.js").SubtitleLine} cue
 */
function cueEligibleForWordAlign(cue) {
  if (!cue || cue.is_deleted || cue.isDeleted) return false;
  if (cue.is_silence || cue.isSilence) return false;
  const vis = visibleSubtitleWords(cue.words);
  return vis.length >= MIN_VISIBLE_WORDS;
}

/**
 * @param {import("./shared/subtitles.js").SubtitleLine[]} cues
 */
export function collectWordAlignTargetIndices(cues) {
  const out = [];
  for (let i = 0; i < cues.length; i += 1) {
    if (cueEligibleForWordAlign(cues[i])) out.push(i);
  }
  return out;
}

/**
 * @param {import("./hub/app-hub.js").SubtitleAppHub} hub
 * @param {number[]} targetIndices ascending
 * @param {Array<{ break_after_storage_indices: number[] }>} results parallel to targets
 */
function applyAlignResultsToHub(hub, targetIndices, results) {
  hub.applySubtitleChange((prev) => {
    let next = prev;
    for (let t = targetIndices.length - 1; t >= 0; t -= 1) {
      const ci = targetIndices[t];
      if (ci < 0 || ci >= next.length) continue;
      const breaks = results[t]?.break_after_storage_indices ?? [];
      if (!breaks.length) continue;
      const parts = explodeCueByWordBreaks(next[ci], breaks);
      if (parts.length <= 1) continue;
      next = [...next.slice(0, ci), ...parts, ...next.slice(ci + 1)];
    }
    return next;
  });
}

/**
 * @param {(pct: number, message: string) => void} onProgress
 * @param {import("./hub/app-hub.js").SubtitleAppHub} hub
 */
export async function runWordAutoAlign(hub, onProgress) {
  const cues = hub.cues;
  const targets = collectWordAlignTargetIndices(cues);
  if (!targets.length) {
    throw new Error("자동정렬할 말소리 자막(단어 2개 이상)이 없습니다.");
  }

  onProgress(5, "단어 칩 분석 요청 중…");

  const payload = {
    cues: targets.map((ci) => ({
      words: (cues[ci].words ?? []).map((w) => ({
        start: w.start,
        end: w.end,
        word: w.word ?? "",
        is_silence: Boolean(w.is_silence ?? w.isSilence),
        is_deleted: Boolean(w.is_deleted ?? w.isDeleted),
        isSilence: Boolean(w.is_silence ?? w.isSilence),
        isDeleted: Boolean(w.is_deleted ?? w.isDeleted),
      })),
    })),
    min_chars: 14,
    max_chars: 22,
  };

  onProgress(25, "Kiwi 형태소 분석 중…");

  const data = await requestAgent({
    method: "POST",
    path: "/api/tools/auto-subtitle/words/auto-align",
    json: payload,
  });

  const results = Array.isArray(data?.results) ? data.results : [];
  if (results.length !== targets.length) {
    throw new Error("에이전트 응답 형식이 올바르지 않습니다.");
  }

  onProgress(70, "줄 나눔 적용 중…");
  markCaretListStructuralMutation(120);
  applyAlignResultsToHub(hub, targets, results);

  const splitCount = results.filter((r) => (r?.break_after_storage_indices?.length ?? 0) > 0).length;
  onProgress(
    100,
    splitCount > 0
      ? `${splitCount}개 자막 줄을 나누었습니다.`
      : "추가로 나눌 줄이 없습니다.",
  );

  return { targets: targets.length, splitCount };
}
