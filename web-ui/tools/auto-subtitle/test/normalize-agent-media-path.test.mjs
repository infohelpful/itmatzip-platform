import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAgentMediaPath } from "../shared/media-timing-ssot.js";

test("normalizeAgentMediaPath — won/yen to backslash", () => {
  const raw = "D:\u20a91. 유튜브\u20a91. 컨테크\u20a9Rec 0001.mp4";
  const out = normalizeAgentMediaPath(raw);
  assert.match(out, /^D:\\1\. 유튜브\\1\. 컨테크\\Rec 0001\.mp4$/);
});

test("normalizeAgentMediaPath — strips zero-width chars", () => {
  const raw = "D:\\foo\u200b\\bar.mp4";
  assert.equal(normalizeAgentMediaPath(raw), "D:\\foo\\bar.mp4");
});

test("normalizeAgentMediaPath — empty", () => {
  assert.equal(normalizeAgentMediaPath(""), "");
  assert.equal(normalizeAgentMediaPath(null), "");
});
