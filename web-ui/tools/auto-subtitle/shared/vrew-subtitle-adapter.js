/**
 * AutoSubtitle vrewSubtitleAdapter.ts — Peaks 행 어댑터 (웹).
 */

import {
  displayTextFromSubtitleWords,
  subtitleLineEditDisplayText,
  visibleSubtitleWords,
  wordIsDeleted,
} from "./subtitles.js";
import {
  DEFAULT_GAP_THRESHOLD_SEC,
  fillGapsInSubtitleWords,
  lineEditDisplayFromVrewWordParts,
} from "./word-contract.js";
import { assignSequentialBlockIds, makeRowWordBlockId } from "./block-ids.js";

/**
 * @typedef {{ id: string, start: number, end: number, text: string, isSilence?: boolean }} VrewWord
 * @typedef {{ rowId: string, lineIndex: number, start: number, end: number, textEditBuffer: string, words: VrewWord[] }} SubtitleRow
 */

/**
 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines
 * @param {{ gapFill?: boolean, mapWordMediaToProgram?: (ms: number, me: number) => { start: number, end: number } }} [options]
 * @returns {SubtitleRow[]}
 */
export function subtitleLinesToVrewRows(lines, options = {}) {
  /** Electron: gapFillWhenBuildingVrew 기본 false — 명시 true 일 때만 */
  const gapFill = options.gapFill === true;
  const mapMP = options.mapWordMediaToProgram;

  const toProg = (start, end) => (mapMP ? mapMP(start, end) : { start, end });

  return (lines || []).map((line, idx) => buildVrewRowFromLine(line, idx, gapFill, toProg));
}

/**
 * @param {import("./subtitles.js").SubtitleLine} line
 * @param {number} idx
 * @param {boolean} gapFill
 * @param {(ms: number, me: number) => { start: number, end: number }} toProg
 */
function buildVrewRowFromLine(line, idx, gapFill, toProg) {
  const rowId = `row_${idx + 1}`;
  let rawWords = line.words ?? [];

  if (rawWords.length === 0 && String(line.text || "").trim()) {
    const { start, end } = line;
    rawWords = [{ start, end, word: String(line.text).trim() }];
  }

  if (!gapFill) {
    /** @type {VrewWord[]} */
    const vrewWords = [];
    for (let storageIdx = 0; storageIdx < rawWords.length; storageIdx += 1) {
      const w = rawWords[storageIdx];
      if (wordIsDeleted(w)) continue;
      const prog = toProg(w.start, w.end);
      const baseId = makeRowWordBlockId(idx + 1, storageIdx + 1);
      const chain = w.split_chain ?? w.splitChain;
      const id = chain ? `${baseId}_${chain}` : baseId;
      vrewWords.push({
        id,
        start: prog.start,
        end: prog.end,
        text: String(w.word ?? ""),
        isSilence: w.is_silence === true || w.isSilence === true,
      });
    }

    const textEditBuffer =
      vrewWords.length > 0
        ? lineEditDisplayFromVrewWordParts(vrewWords)
        : subtitleLineEditDisplayText(line);

    const vis = visibleSubtitleWords(rawWords);
    const start = vis.length > 0 ? vis[0].start : line.start;
    const end = vis.length > 0 ? vis[vis.length - 1].end : line.end;

    return {
      rowId,
      lineIndex: idx,
      start,
      end,
      textEditBuffer,
      words: vrewWords,
    };
  }

  let words = rawWords.filter((w) => !wordIsDeleted(w));
  if (gapFill && words.length > 0) {
    words = fillGapsInSubtitleWords(
      { start: line.start, end: line.end, words },
      { gapThresholdSec: DEFAULT_GAP_THRESHOLD_SEC },
    );
  }
  words = assignSequentialBlockIds(words, idx + 1);

  /** @type {VrewWord[]} */
  const vrewWords = words.map((w, wi) => {
    const prog = toProg(w.start, w.end);
    return {
      id: w.id || makeRowWordBlockId(idx + 1, wi + 1),
      start: prog.start,
      end: prog.end,
      text: String(w.word ?? ""),
      isSilence: w.is_silence === true || w.isSilence === true,
    };
  });

  const textEditBuffer =
    vrewWords.length > 0
      ? lineEditDisplayFromVrewWordParts(vrewWords)
      : subtitleLineEditDisplayText(line);

  const vis = visibleSubtitleWords(words);
  const start = vis.length > 0 ? vis[0].start : line.start;
  const end = vis.length > 0 ? vis[vis.length - 1].end : line.end;

  return {
    rowId,
    lineIndex: idx,
    start,
    end,
    textEditBuffer,
    words: vrewWords,
  };
}
