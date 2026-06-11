import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyGapTransition } from "../shared/clip-boundary-ssot.js";
import { buildProgramClips } from "../shared/program-clips-ssot.js";
import { programClipsToTimelineClips } from "../shared/program-clips-adapter.js";
import {
  atProgramPlaybackBoundary,
  programClipPlaybackEnd,
  programClipEnd,
  shouldPassThroughClipTransition,
} from "../shared/program-clip-boundary-ssot.js";

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

test("adjacent blocks — playback end excludes tail pad past next sourceStart", () => {
  const blocks = [
    makeBlock({ id: "a", words: [makeWord(0, 5)] }),
    makeBlock({ id: "b", words: [makeWord(5, 8)] }),
  ];
  const clips = programClipsToTimelineClips(buildProgramClips(blocks));
  const cur = clips[0];
  assert.equal(cur.mediaEnd, 5);
  assert.equal(cur.effectiveSourceEnd, 5);
  assert.equal(programClipPlaybackEnd(cur), programClipEnd(cur));
  assert.equal(
    atProgramPlaybackBoundary(programClipPlaybackEnd(cur), cur),
    true,
  );
  assert.equal(
    atProgramPlaybackBoundary(programClipPlaybackEnd(cur) - 0.01, cur),
    false,
  );
});

test("continuous adjacent blocks — pass-through without seek", () => {
  const blocks = [
    makeBlock({ id: "a", words: [makeWord(0, 5)] }),
    makeBlock({ id: "b", words: [makeWord(5, 8)] }),
  ];
  const clips = programClipsToTimelineClips(buildProgramClips(blocks));
  const cur = clips[0];
  const next = clips[1];
  const cls = classifyGapTransition({
    cur,
    next,
    clips,
    curPos: 0,
    nextPos: 1,
    skipRanges: [],
  });
  assert.equal(cls.kind, "continuous");
  assert.equal(
    shouldPassThroughClipTransition(cur, next, 5.0, 5.0, cls),
    true,
  );
});

test("reorder backward jump — seek required", () => {
  const blocks = [
    makeBlock({ id: "a", words: [makeWord(10, 12)] }),
    makeBlock({ id: "b", words: [makeWord(0, 2)] }),
  ];
  const clips = programClipsToTimelineClips(buildProgramClips(blocks));
  const cur = clips[0];
  const next = clips[1];
  const cls = classifyGapTransition({
    cur,
    next,
    clips,
    curPos: 0,
    nextPos: 1,
    skipRanges: [],
  });
  assert.equal(cls.kind, "edit");
  assert.equal(
    shouldPassThroughClipTransition(cur, next, 12.0, 0.0, cls),
    false,
  );
});

test("natural pause — pass-through when audio already at next start", () => {
  const blocks = [
    makeBlock({ id: "a", words: [makeWord(0, 5)] }),
    makeBlock({ id: "b", words: [makeWord(5.15, 8)] }),
  ];
  const clips = programClipsToTimelineClips(buildProgramClips(blocks));
  const cur = clips[0];
  const next = clips[1];
  const cls = classifyGapTransition({
    cur,
    next,
    clips,
    curPos: 0,
    nextPos: 1,
    skipRanges: [],
  });
  assert.equal(cls.kind, "natural");
  assert.equal(
    shouldPassThroughClipTransition(cur, next, 5.15, 5.15, cls),
    true,
  );
});
