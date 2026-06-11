import test from "node:test";
import assert from "node:assert/strict";
import {
  pickActiveWordIndexForHighlight,
  sourceSecToProgramSecInClip,
} from "../playback.js";

const programClip = {
  id: "b0",
  blockIndex: 0,
  sourceStart: 10,
  sourceEnd: 20,
  programStart: 0,
  programEnd: 10,
  isSilence: false,
};

const cue = {
  start: 10,
  end: 20,
  words: [
    { start: 10, end: 12, text: "a" },
    { start: 12, end: 15, text: "b" },
    { start: 15, end: 18, text: "c" },
  ],
};

test("sourceSecToProgramSecInClip maps within active clip", () => {
  assert.equal(sourceSecToProgramSecInClip(10, programClip), 0);
  assert.equal(sourceSecToProgramSecInClip(15, programClip), 5);
});

test("pickActiveWordIndexForHighlight uses program axis when programClip given", () => {
  assert.equal(
    pickActiveWordIndexForHighlight(cue, 1, programClip),
    0,
  );
  assert.equal(
    pickActiveWordIndexForHighlight(cue, 5, programClip),
    1,
  );
  assert.equal(
    pickActiveWordIndexForHighlight(cue, 8, programClip),
    2,
  );
});

test("program highlight ignores words outside shrunk programEnd", () => {
  const shrunk = { ...programClip, programEnd: 4 };
  assert.equal(pickActiveWordIndexForHighlight(cue, 5, shrunk), -1);
});
