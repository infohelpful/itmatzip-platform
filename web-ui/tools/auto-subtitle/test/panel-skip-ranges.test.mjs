import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPanelSkipRanges } from "../waveform/panel-skip-ranges.js";

/** @param {number} start @param {number} end @param {string} word */
function spoken(start, end, word) {
  return { word, start, end, sourceStart: start, sourceEnd: end };
}

/** @param {number} start @param {number} end */
function deletedSilence(start, end) {
  return {
    word: "--",
    start,
    end,
    sourceStart: start,
    sourceEnd: end,
    is_silence: true,
    isSilence: true,
    is_deleted: true,
    isDeleted: true,
  };
}

test("coupled panel skips omit tombstone over next line first spoken", () => {
  const cue = {
    words: [
      spoken(6.39, 6.52, "되었습니다."),
      deletedSilence(6.52, 9.0),
    ],
  };
  const viewWin = { start: 6.1, end: 7.1 };
  const cross = {
    coupled: true,
    prevWord: { start: 6.39, end: 6.52 },
    nextWord: { start: 6.52, end: 6.9 },
  };
  const skips = buildPanelSkipRanges(viewWin, [], cue, cross);
  assert.equal(skips.length, 0);
});

test("non-coupled panel keeps local deleted tombstone skips", () => {
  const cue = {
    words: [spoken(6.39, 6.52, "되었습니다."), deletedSilence(6.52, 9.0)],
  };
  const viewWin = { start: 6.1, end: 7.1 };
  const skips = buildPanelSkipRanges(viewWin, [], cue, null);
  assert.equal(skips.length, 1);
  assert.equal(skips[0].start, 6.52);
  assert.equal(skips[0].end, 7.1);
});
