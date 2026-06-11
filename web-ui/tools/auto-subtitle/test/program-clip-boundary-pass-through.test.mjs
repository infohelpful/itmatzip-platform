import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyGapTransition, classifyListOrderGapTransition } from "../shared/clip-boundary-ssot.js";
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

test("continuous adjacent blocks — raw classify allows pass-through", () => {
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

test("list-order literal — different blocks never pass-through when source touches", () => {
  const blocks = [
    makeBlock({ id: "a", words: [makeWord(0, 5)] }),
    makeBlock({ id: "b", words: [makeWord(5, 8)] }),
  ];
  const clips = programClipsToTimelineClips(buildProgramClips(blocks));
  const cur = clips[0];
  const next = clips[1];
  const cls = classifyListOrderGapTransition({
    cur,
    next,
    clips,
    curPos: 0,
    nextPos: 1,
    skipRanges: [],
  });
  assert.equal(cls.kind, "edit");
  assert.equal(cls.literalBlockJump, true);
  assert.equal(
    shouldPassThroughClipTransition(cur, next, 5.0, 5.0, cls),
    false,
  );
});

test("reorder 2-3-1 — line1 clip ends at its source span only", () => {
  const blocks = [
    makeBlock({ id: "line2", words: [makeWord(2, 5)] }),
    makeBlock({ id: "line3", words: [makeWord(5, 7)] }),
    makeBlock({ id: "line1", words: [makeWord(0, 2)] }),
  ];
  const clips = programClipsToTimelineClips(buildProgramClips(blocks));
  assert.equal(clips.length, 3);
  const line1 = clips[2];
  assert.equal(line1.mediaStart, 0);
  assert.ok(line1.effectiveSourceEnd <= 2.01, `line1 effEnd=${line1.effectiveSourceEnd}`);
  assert.equal(
    atProgramPlaybackBoundary(programClipPlaybackEnd(line1), line1),
    true,
  );
  const line3to1 = classifyListOrderGapTransition({
    cur: clips[1],
    next: clips[2],
    clips,
    curPos: 1,
    nextPos: 2,
    skipRanges: [],
  });
  assert.equal(shouldPassThroughClipTransition(clips[1], clips[2], 7, 0, line3to1), false);
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
