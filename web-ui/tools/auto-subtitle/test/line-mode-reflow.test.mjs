import { test } from "node:test";
import assert from "node:assert/strict";
import { emitOneCue, groupWordsIntoCues, reflowCuesSkipUserMoved } from "../shared/line-mode/reflow.js";
import { findNearestSnap, buildSnapGridFromPeaks } from "../shared/line-mode/snap-engine.js";
import { splitCueByEnter, splitCueAtMediaSec } from "../shared/line-mode/cue-ops.js";
import { mapWhisperWords } from "../shared/line-mode/word-hints.js";
import {
  buildLineModeProjectSection,
  parseLineModeFromProject,
  serializeCuesForReflow,
} from "../shared/line-mode/serialize-cues.js";
import {
  computeCueContextWindow,
  CUE_WAVEFORM_DEFAULT_PAD_SEC,
} from "../shared/line-mode/cue-context-window.js";

test("mapWhisperWords filters -- tokens", () => {
  const words = mapWhisperWords([
    { word: "--", start: 0, end: 0.2 },
    { word: "안녕", start: 0.3, end: 0.5 },
  ]);
  assert.equal(words.length, 1);
  assert.equal(words[0].word, "안녕");
});

test("forced split leaves remainder when window exceeds max chars", () => {
  const window = Array.from({ length: 8 }, (_, i) => ({
    word: `가나${i}`,
    hintStart: i * 0.3,
    hintEnd: i * 0.3 + 0.2,
  }));
  const { cue, remain } = emitOneCue(window, 6);
  assert.ok(cue);
  assert.ok(remain.length > 0);
});

test("findNearestSnap uses lower_bound neighbor", () => {
  const grid = [{ t: 1.0 }, { t: 1.2 }, { t: 1.5 }];
  assert.equal(findNearestSnap(1.11, grid, 0.15), 1.2);
  assert.equal(findNearestSnap(1.11, grid, 0.15, true), 1.11);
});

test("splitCueByEnter rejects short cue", () => {
  const cue = {
    start: 0,
    end: 0.05,
    text: "ab",
    words: [
      { word: "a", start: 0, end: 0.02, hintStart: 0, hintEnd: 0.02 },
      { word: "b", start: 0.03, end: 0.05, hintStart: 0.03, hintEnd: 0.05 },
    ],
  };
  const out = splitCueByEnter(cue, 1);
  assert.equal(out.length, 1);
});

test("groupWordsIntoCues respects max chars horizontal", () => {
  const words = mapWhisperWords(
    Array.from({ length: 10 }, (_, i) => ({
      word: `단어${i}`,
      start: i * 0.3,
      end: i * 0.3 + 0.2,
    })),
  );
  const cues = groupWordsIntoCues(words, "horizontal");
  for (const cue of cues) {
    assert.ok(cue.text.length <= 28 + 9);
  }
});

test("splitCueByEnter splits at word boundary with midpoint", () => {
  const cue = {
    start: 1,
    end: 3,
    text: "hello world",
    words: [
      { word: "hello", start: 1, end: 1.8, hintStart: 1, hintEnd: 1.8 },
      { word: "world", start: 2, end: 2.8, hintStart: 2, hintEnd: 2.8 },
    ],
  };
  const parts = splitCueByEnter(cue, 1);
  assert.equal(parts.length, 2);
  assert.ok(parts[0].end <= parts[1].start + 0.001);
  assert.equal(parts[0].flags?.userMoved, false);
});

test("splitCueAtMediaSec splits at play line between words", () => {
  const cue = {
    start: 1,
    end: 3,
    text: "hello world",
    words: [
      { word: "hello", start: 1, end: 1.8, hintStart: 1, hintEnd: 1.8 },
      { word: "world", start: 2, end: 2.8, hintStart: 2, hintEnd: 2.8 },
    ],
  };
  const parts = splitCueAtMediaSec(cue, 1.9);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].words?.length, 1);
  assert.equal(parts[1].words?.length, 1);
  assert.ok(Math.abs(parts[0].end - 1.9) < 0.001);
  assert.ok(Math.abs(parts[1].start - 1.9) < 0.001);
});

test("splitCueAtMediaSec splits inside long word", () => {
  const cue = {
    start: 0,
    end: 2,
    text: "abcdef",
    words: [{ word: "abcdef", start: 0, end: 2, hintStart: 0, hintEnd: 2 }],
  };
  const parts = splitCueAtMediaSec(cue, 1);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].words?.length, 1);
  assert.equal(parts[1].words?.length, 1);
  assert.ok(parts[0].words[0].word.length > 0);
  assert.ok(parts[1].words[0].word.length > 0);
});

test("serializeCuesForReflow preserves flags", () => {
  const out = serializeCuesForReflow([
    {
      start: 0,
      end: 1,
      text: "a",
      flags: { userMoved: true },
      words: [{ word: "a", start: 0, end: 1 }],
    },
  ]);
  assert.equal(out[0].flags.userMoved, true);
});

test("reflowCuesSkipUserMoved keeps locked cue", () => {
  const out = reflowCuesSkipUserMoved([
    {
      start: 0,
      end: 1,
      text: "locked",
      flags: { userMoved: true },
      words: [{ word: "locked", start: 0, end: 1, hintStart: 0, hintEnd: 1 }],
    },
    {
      start: 1,
      end: 2,
      text: "next",
      words: [{ word: "next", start: 1, end: 2, hintStart: 1, hintEnd: 2 }],
    },
  ]);
  assert.equal(out[0].text, "locked");
});

test("lineMode project section roundtrip", () => {
  const grid = { onsets: [{ t: 0.5, kind: "onset" }], dragStartSnaps: [{ t: 0.5, kind: "onset" }] };
  const section = buildLineModeProjectSection(grid);
  const parsed = parseLineModeFromProject({ lineMode: section });
  assert.equal(parsed?.snapGrid?.onsets?.length, 1);
});

test("snap grid detects onset crossing", () => {
  const peaks = [...Array(20).fill(-40), ...Array(20).fill(-20), ...Array(20).fill(-40)];
  const grid = buildSnapGridFromPeaks(peaks, 1.0, null);
  assert.ok(grid.onsets.length > 0);
});

test("computeCueContextWindow pads cue by default 1s each side", () => {
  const win = computeCueContextWindow({ start: 5, end: 6.2 }, 120);
  assert.equal(win.lineStart, 5);
  assert.equal(win.lineEnd, 6.2);
  assert.equal(win.windowStart, 5 - CUE_WAVEFORM_DEFAULT_PAD_SEC);
  assert.equal(win.windowEnd, 6.2 + CUE_WAVEFORM_DEFAULT_PAD_SEC);
  assert.ok(win.span > 2);
});

test("computeCueContextWindow expand widens view", () => {
  const base = computeCueContextWindow({ start: 2, end: 3 }, 60);
  const wide = computeCueContextWindow({ start: 2, end: 3 }, 60, 2, 1);
  assert.ok(wide.windowStart < base.windowStart);
  assert.ok(wide.windowEnd > base.windowEnd);
});
