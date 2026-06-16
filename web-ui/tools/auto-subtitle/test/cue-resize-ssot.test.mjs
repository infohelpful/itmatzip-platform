import test from "node:test";
import assert from "node:assert/strict";
import { resizeCueStart, resizeCueEnd } from "../shared/line-mode/cue-ops.js";
import { syncSubtitleLineFromWords } from "../shared/subtitles.js";

function cue(words, start, end) {
  return { start, end, text: "x", words };
}

test("resizeCueStart persists after syncSubtitleLineFromWords", () => {
  const line = cue(
    [
      { word: "a", start: 2, end: 3, hintStart: 2, hintEnd: 3 },
      { word: "b", start: 3, end: 5, hintStart: 3, hintEnd: 5 },
    ],
    2,
    5,
  );
  const trimmed = resizeCueStart(line, 2.8, 60);
  const synced = syncSubtitleLineFromWords(trimmed);
  assert.equal(synced.start, 2.8);
  assert.equal(synced.end, 5);
});

test("resizeCueEnd persists after syncSubtitleLineFromWords", () => {
  const line = cue(
    [
      { word: "a", start: 2, end: 3, hintStart: 2, hintEnd: 3 },
      { word: "b", start: 3, end: 5, hintStart: 3, hintEnd: 5 },
    ],
    2,
    5,
  );
  const trimmed = resizeCueEnd(line, 4.2, 60);
  const synced = syncSubtitleLineFromWords(trimmed);
  assert.equal(synced.start, 2);
  assert.equal(synced.end, 4.2);
});

test("resizeCueStart can extend before first word", () => {
  const line = cue(
    [{ word: "a", start: 2, end: 4, hintStart: 2, hintEnd: 4 }],
    2,
    4,
  );
  const extended = resizeCueStart(line, 1.5, 60);
  const synced = syncSubtitleLineFromWords(extended);
  assert.equal(synced.start, 1.5);
  assert.equal(synced.words[0].start, 1.5);
});
