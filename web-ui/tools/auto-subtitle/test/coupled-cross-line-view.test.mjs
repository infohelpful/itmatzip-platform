import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWordContextForCue } from "../line-zoom-window.js";

/** @param {number} start @param {number} end @param {string} word */
function spoken(start, end, word) {
  return { word, start, end, sourceStart: start, sourceEnd: end };
}

/** @param {number} start @param {number} end */
function silence(start, end) {
  return {
    word: "--",
    start,
    end,
    sourceStart: start,
    sourceEnd: end,
    is_silence: true,
    isSilence: true,
  };
}

test("coupled view: upper last and lower first share identical windowStart/windowEnd", () => {
  const cues = [
    {
      start: 5.0,
      end: 9.0,
      text: "…되었습니다.",
      words: [
        spoken(5.0, 5.5, "수"),
        spoken(5.5, 6.39, "있는"),
        spoken(6.39, 6.52, "되었습니다."),
        silence(6.52, 9.0),
      ],
    },
    {
      start: 6.52,
      end: 10.0,
      text: "예전에는 이런…",
      words: [
        spoken(6.52, 6.9, "예전에는"),
        spoken(6.9, 7.2, "이런"),
        spoken(7.2, 7.5, "기술을"),
      ],
    },
  ];

  const upper = computeWordContextForCue(cues, 0, 2, 120);
  const lower = computeWordContextForCue(cues, 1, 0, 120);

  assert.ok(upper);
  assert.ok(lower);
  assert.equal(upper.windowStart, lower.windowStart);
  assert.equal(upper.windowEnd, lower.windowEnd);
  assert.equal(upper.crossLineBounds?.coupled, true);
  assert.equal(lower.crossLineBounds?.coupled, true);
  assert.equal(upper.crossLineBounds?.role, "upper_end");
  assert.equal(lower.crossLineBounds?.role, "lower_start");
  assert.equal(upper.lineStart, 6.39);
  assert.equal(upper.lineEnd, 6.9);
  assert.ok(upper.windowStart <= 6.52);
  assert.ok(upper.windowEnd >= 6.9);
});

test("coupled view skips silence-only line between spoken cues", () => {
  const cues = [
    {
      words: [spoken(0, 1, "a"), spoken(1, 2, "b")],
    },
    {
      words: [silence(2, 2.5)],
    },
    {
      words: [spoken(2, 3, "c"), spoken(3, 4, "d")],
    },
  ];

  const upper = computeWordContextForCue(cues, 0, 1, 60);
  const lower = computeWordContextForCue(cues, 2, 0, 60);

  assert.ok(upper?.crossLineBounds?.coupled);
  assert.ok(lower?.crossLineBounds?.coupled);
  assert.equal(upper.windowStart, lower.windowStart);
  assert.equal(upper.windowEnd, lower.windowEnd);
  assert.equal(upper.lineEnd, 3);
});
