import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampProgramSec,
  resolveMediaSecFromProgram,
  resolveProgramSecFromMedia,
  resolveSegmentPlaybackAnchor,
  resolveSourceSecFromProgram,
} from "../shared/program-playback-clock.js";
import { deriveCutRangesFromProgramClips } from "../shared/program-clips-ssot.js";

/** @type {import("../shared/timeline-mapping.js").TimelineClip[]} */
const timelineClips = [
  {
    editStart: 0,
    editEnd: 5,
    mediaStart: 10,
    mediaEnd: 15,
    cueIndex: 0,
  },
  {
    editStart: 5,
    editEnd: 10,
    mediaStart: 20,
    mediaEnd: 25,
    cueIndex: 1,
  },
];

test("program ↔ media mapping roundtrip", () => {
  assert.equal(resolveMediaSecFromProgram(2.5, timelineClips), 12.5);
  assert.equal(resolveProgramSecFromMedia(12.5, timelineClips), 2.5);
  assert.equal(resolveProgramSecFromMedia(22, timelineClips), 7);
});

test("clampProgramSec respects program duration", () => {
  assert.equal(clampProgramSec(12, 10), 10);
  assert.equal(clampProgramSec(-1, 10), 0);
});

test("resolveSegmentPlaybackAnchor preserves clip hint", () => {
  const anchor = resolveSegmentPlaybackAnchor(6, timelineClips, 1);
  assert.equal(anchor.clipPos, 1);
  assert.ok(anchor.mediaSec >= 20 && anchor.mediaSec < 25);
});

test("resolveSourceSecFromProgram maps program to source", () => {
  const programClips = [
    {
      sourceStart: 10,
      sourceEnd: 15,
      programStart: 0,
      programEnd: 5,
      isSilence: false,
    },
    {
      sourceStart: 20,
      sourceEnd: 25,
      programStart: 5,
      programEnd: 10,
      isSilence: false,
    },
  ];
  assert.equal(resolveSourceSecFromProgram(2, programClips), 12);
  assert.equal(resolveSourceSecFromProgram(7, programClips), 22);
});

test("deriveCutRangesFromProgramClips inverts kept spans", () => {
  const clips = [
    {
      sourceStart: 2,
      sourceEnd: 5,
      programStart: 0,
      programEnd: 3,
      isSilence: false,
    },
    {
      sourceStart: 8,
      sourceEnd: 10,
      programStart: 3,
      programEnd: 5,
      isSilence: false,
    },
  ];
  const cuts = deriveCutRangesFromProgramClips(clips, 12);
  assert.deepEqual(cuts, [
    { start: 0, end: 2 },
    { start: 5, end: 8 },
    { start: 10, end: 12 },
  ]);
});
