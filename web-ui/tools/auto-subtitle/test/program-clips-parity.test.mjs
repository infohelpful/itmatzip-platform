import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertLiteralBakeParity,
  buildProgramClips,
  getProgramDurationSec,
  programClipsToExportCues,
} from "../shared/program-clips-ssot.js";
import { programClipEnd } from "../shared/program-clip-boundary-ssot.js";

/**
 * @param {object} opts
 */
function makeWord(sourceIn, sourceOut, text = "w") {
  return {
    id: `w-${sourceIn}`,
    text,
    sourceIn,
    sourceOut,
    isDeleted: false,
    isSilence: false,
  };
}

/**
 * @param {object} opts
 */
function makeBlock(opts) {
  const words = opts.words ?? [makeWord(0, 1)];
  const si = words[0]?.sourceIn ?? 0;
  const so = words[words.length - 1]?.sourceOut ?? si + 1;
  return {
    id: opts.id ?? "b0",
    text: opts.text ?? "line",
    duration: opts.duration ?? Math.max(0.5, so - si),
    sourceIn: si,
    sourceOut: so,
    isDeleted: !!opts.isDeleted,
    isSilence: !!opts.isSilence,
    words,
  };
}

/**
 * @param {readonly object[]} blocks
 */
function listableBlockIndices(blocks) {
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (!b || b.isDeleted) continue;
    out.push(i);
  }
  return out;
}

/**
 * @param {readonly object[]} blocks
 * @param {readonly import("../shared/program-clips-ssot.js").ProgramClip[]} clips
 */
function assertEveryListableBlockHasClip(blocks, clips) {
  for (const bi of listableBlockIndices(blocks)) {
    const n = clips.filter((c) => c.blockIndex === bi).length;
    assert.ok(n >= 1, `listable blockIndex ${bi} must appear >=1 in programClips (got ${n})`);
  }
}

test("programDurationSec equals last programEnd", () => {
  const blocks = [
    makeBlock({ id: "a", words: [makeWord(0, 2)] }),
    makeBlock({ id: "b", words: [makeWord(5, 7)] }),
  ];
  const clips = buildProgramClips(blocks);
  assert.ok(clips.length >= 2);
  assert.equal(getProgramDurationSec(clips), programClipEnd(clips[clips.length - 1]));
});

test("each listable blockIndex appears in programClips", () => {
  const blocks = [
    makeBlock({ id: "a", words: [makeWord(0, 2)] }),
    makeBlock({ id: "b", words: [makeWord(3, 5)] }),
    makeBlock({ id: "c", words: [makeWord(6, 8)] }),
  ];
  const clips = buildProgramClips(blocks);
  assertEveryListableBlockHasClip(blocks, clips);
});

test("overlap same sourceStart keeps both clips in queue (Policy A)", () => {
  const blocks = [
    makeBlock({ id: "a", words: [makeWord(0, 3)] }),
    makeBlock({ id: "b", words: [makeWord(0, 2.5)] }),
  ];
  const clips = buildProgramClips(blocks);
  assert.equal(clips.length, 2);
  assert.equal(clips[0].blockIndex, 0);
  assert.equal(clips[1].blockIndex, 1);
  assertEveryListableBlockHasClip(blocks, clips);
});

test("reorder-shaped blocks preserve blockIndex coverage", () => {
  const blocks = [
    makeBlock({ id: "l1", words: [makeWord(0, 2)] }),
    makeBlock({ id: "l3", words: [makeWord(10, 12)] }),
    makeBlock({ id: "l2", words: [makeWord(5, 8)] }),
    makeBlock({ id: "l4", words: [makeWord(11.94, 12.5)] }),
    makeBlock({ id: "l5", words: [makeWord(11.94, 13)] }),
  ];
  const clips = buildProgramClips(blocks);
  assert.equal(clips.length, 5);
  for (let i = 0; i < 5; i += 1) {
    assert.ok(clips.some((c) => c.blockIndex === i), `missing block ${i}`);
  }
});

test("reorder 1-3-2 with overlapping source keeps line 2 playable duration", () => {
  const blocks = [
    makeBlock({ id: "l1", words: [makeWord(0, 2)] }),
    makeBlock({ id: "l3", words: [makeWord(10, 12)] }),
    makeBlock({ id: "l2", words: [makeWord(5, 11)] }),
    makeBlock({ id: "l4", words: [makeWord(11.94, 12.5)] }),
    makeBlock({ id: "l5", words: [makeWord(11.94, 13)] }),
  ];
  const clips = buildProgramClips(blocks);
  assert.equal(clips.length, 5);
  const line2 = clips.find((c) => c.blockIndex === 2);
  assert.ok(line2, "line 2 clip must exist");
  const dur = line2.programEnd - line2.programStart;
  assert.ok(dur > 0.5, `line 2 program duration must be playable, got ${dur}`);
  assert.ok(line2.sourceStart < 6, "line 2 must keep original source start");
});

test("silence block yields clip with isSilence", () => {
  const blocks = [
    makeBlock({ id: "a", words: [makeWord(0, 1)] }),
    makeBlock({
      id: "sil",
      isSilence: true,
      words: [],
      duration: 0.8,
      sourceIn: 0,
      sourceOut: 0.8,
    }),
    makeBlock({ id: "b", words: [makeWord(2, 3)] }),
  ];
  const clips = buildProgramClips(blocks);
  assert.ok(clips.some((c) => c.isSilence && c.blockIndex === 1));
  assertEveryListableBlockHasClip(blocks, clips);
});

test("literal bake parity — reorder 1-3-2 clip count and duration", () => {
  const blocks = [
    makeBlock({ id: "l1", words: [makeWord(0, 2)] }),
    makeBlock({ id: "l3", words: [makeWord(10, 12)] }),
    makeBlock({ id: "l2", words: [makeWord(5, 11)] }),
    makeBlock({ id: "l4", words: [makeWord(11.94, 12.5)] }),
    makeBlock({ id: "l5", words: [makeWord(11.94, 13)] }),
  ];
  const clips = buildProgramClips(blocks);
  const parity = assertLiteralBakeParity(clips);
  assert.equal(parity.clipCount, 5);
  assert.ok(Math.abs(parity.segmentDurationSec - parity.programDurationSec) < 0.08);
});

test("export cues use programStart/End from programClips SSOT", () => {
  const blocks = [
    makeBlock({ id: "a", words: [makeWord(0, 2)] }),
    makeBlock({ id: "b", words: [makeWord(10, 12)] }),
  ];
  const clips = buildProgramClips(blocks);
  const cues = programClipsToExportCues(clips, blocks);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, clips[0].programStart);
  assert.equal(cues[1].start, clips[1].programStart);
});
