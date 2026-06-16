import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWordEdgeDrag } from "../shared/subtitle-word-edge-drag.js";
import { applyCueWordEdgeDrag } from "../subtitle-words.js";
import { syncCuesAfterWordEdit } from "../shared/cues-ssot.js";
import { subtitleLinesToBlocks } from "../shared/block-timeline-adapter.js";
import {
  enforceCrossLineSpokenBoundaryOnLines,
  applyCrossCueBoundaryPatchesToBlocks,
  crossCueBoundaryPatchForWordTrim,
  enforceAdjacentCrossLineBlockBoundaries,
} from "../shared/cross-cue-boundary-sync.js";

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

test("full pipeline: trim end → blocks share source boundary", () => {
  const cues = [
    {
      start: 0,
      end: 2.5,
      text: "hello world",
      words: [spoken(0, 1, "hello"), spoken(1, 2, "world"), silence(2, 2.5)],
    },
    {
      start: 2,
      end: 4,
      text: "foo bar",
      words: [spoken(2, 3, "foo"), spoken(3, 4, "bar")],
    },
  ];

  let lines = applyCueWordEdgeDrag(cues, 0, 1, "end", 2.35, true);
  lines = enforceCrossLineSpokenBoundaryOnLines(lines, 0, 1, "end");
  lines = syncCuesAfterWordEdit(lines);
  const blocks = subtitleLinesToBlocks(lines);
  const patch = crossCueBoundaryPatchForWordTrim(lines, 0, 1, "end");
  assert.ok(patch);
  const patched = applyCrossCueBoundaryPatchesToBlocks(blocks, [patch]);

  const world = patched[0].words[1];
  const foo = patched[1].words[0];
  assert.equal(world.sourceOut, 2.35);
  assert.equal(foo.sourceIn, 2.35);
  assert.equal(world.sourceOut, foo.sourceIn);
});

test("extend last spoken end couples to next line first spoken (skips trailing silence)", () => {
  const cues = [
    {
      start: 0,
      end: 2.5,
      text: "hello world",
      words: [spoken(0, 1, "hello"), spoken(1, 2, "world"), silence(2, 2.5)],
    },
    {
      start: 2,
      end: 4,
      text: "foo bar",
      words: [spoken(2, 3, "foo"), spoken(3, 4, "bar")],
    },
  ];

  const { subtitles } = applyWordEdgeDrag({
    subtitles: cues,
    target: { lineIndex: 0, wordIndex: 1 },
    edge: "end",
    newSec: 2.3,
    commitMode: true,
  });

  const world = subtitles[0].words[1];
  const foo = subtitles[1].words[0];
  assert.equal(world.end, 2.3);
  assert.equal(foo.start, 2.3);
  assert.ok(world.end <= foo.start + 1e-6);
});

test("shrink first spoken start couples to previous line last spoken", () => {
  const cues = [
    {
      start: 0,
      end: 2,
      text: "hello world",
      words: [spoken(0, 1, "hello"), spoken(1, 2, "world")],
    },
    {
      start: 2,
      end: 4,
      text: "foo bar",
      words: [spoken(2, 3, "foo"), spoken(3, 4, "bar")],
    },
  ];

  const { subtitles } = applyWordEdgeDrag({
    subtitles: cues,
    target: { lineIndex: 1, wordIndex: 0 },
    edge: "start",
    newSec: 1.7,
    commitMode: true,
  });

  const world = subtitles[0].words[1];
  const foo = subtitles[1].words[0];
  assert.equal(foo.start, 1.7);
  assert.equal(world.end, 1.7);
});

test("extend last spoken end shrinks next line start (no overlap)", () => {
  const cues = [
    {
      start: 0,
      end: 2,
      text: "aa bb",
      words: [spoken(0, 1, "aa"), spoken(1, 2, "bb")],
    },
    {
      start: 2,
      end: 3.5,
      text: "cc",
      words: [spoken(2, 3.5, "cc")],
    },
  ];

  const { subtitles } = applyWordEdgeDrag({
    subtitles: cues,
    target: { lineIndex: 0, wordIndex: 1 },
    edge: "end",
    newSec: 2.4,
    commitMode: true,
  });

  const bb = subtitles[0].words[1];
  const cc = subtitles[1].words[0];
  assert.equal(bb.end, 2.4);
  assert.equal(cc.start, 2.4);
  assert.ok(bb.end <= cc.start + 1e-6);
});

test("enforceAdjacentCrossLineBlockBoundaries couples block words at shared source", () => {
  const blocks = [
    {
      id: "b1",
      text: "world",
      duration: 1,
      sourceIn: 0,
      sourceOut: 2.5,
      words: [
        { id: "w1", text: "world", duration: 1, sourceIn: 1, sourceOut: 2, isDeleted: false, isSilence: false },
        { id: "s1", text: "--", duration: 0.5, sourceIn: 2, sourceOut: 2.5, isDeleted: false, isSilence: true },
      ],
    },
    {
      id: "b2",
      text: "foo",
      duration: 1,
      sourceIn: 2,
      sourceOut: 3,
      words: [
        { id: "w2", text: "foo", duration: 1, sourceIn: 2, sourceOut: 3, isDeleted: false, isSilence: false },
      ],
    },
  ];
  const patched = enforceAdjacentCrossLineBlockBoundaries(blocks);
  assert.equal(patched[0].words[1].sourceIn, 2);
  assert.equal(patched[0].words[1].sourceOut, 2.01);
  assert.equal(patched[0].words[0].sourceOut, 2);
  assert.equal(patched[1].words[0].sourceIn, 2);
});

test("last spoken + trailing silence: end trim couples next line and clamps tail silence", () => {
  const cues = [
    {
      start: 0,
      end: 2.5,
      text: "hello world",
      words: [spoken(0, 1, "hello"), spoken(1, 2, "world"), silence(2, 2.5)],
    },
    {
      start: 2,
      end: 4,
      text: "foo bar",
      words: [spoken(2, 3, "foo"), spoken(3, 4, "bar")],
    },
  ];

  let lines = applyCueWordEdgeDrag(cues, 0, 1, "end", 2.35, true);
  lines = enforceCrossLineSpokenBoundaryOnLines(lines, 0, 1, "end");
  const tailSilence = lines[0].words[2];
  const world = lines[0].words[1];
  const foo = lines[1].words[0];
  assert.equal(world.end, 2.35);
  assert.equal(foo.start, 2.35);
  assert.ok(Number(tailSilence.end) <= 2.35 + 0.02);
  assert.ok(Number(tailSilence.start) >= 2.35 - 1e-6);

  const blocks = subtitleLinesToBlocks(lines);
  const patch = crossCueBoundaryPatchForWordTrim(lines, 0, 1, "end");
  const patched = applyCrossCueBoundaryPatchesToBlocks(blocks, [patch]);
  assert.equal(patched[0].words[1].sourceOut, 2.35);
  assert.equal(patched[1].words[0].sourceIn, 2.35);
  assert.ok(Number(patched[0].words[2].sourceIn) >= 2.35 - 1e-6);
});
