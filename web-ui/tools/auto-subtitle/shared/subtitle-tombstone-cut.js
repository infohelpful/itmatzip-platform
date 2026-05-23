/**
 * AutoSubtitle subtitleTombstoneCut.ts — 프로그램 축 tombstone 컷.
 */

import {
  displayTextFromSubtitleWords,
  visibleSubtitleWords,
  wordIsDeleted,
} from "./subtitles.js";
import { snapTimelineSec } from "./timeline-collapse.js";
import { splitWordTextAtMediaCut } from "./subtitle-word-text-split.js";

const EPS = 1e-4;

function sliceCharsStart(text, dropCount) {
  if (dropCount <= 0) return text;
  const chars = [...text];
  return chars.slice(dropCount).join("");
}

function sliceCharsEnd(text, dropCount) {
  if (dropCount <= 0) return text;
  const chars = [...text];
  if (dropCount >= chars.length) return "";
  return chars.slice(0, chars.length - dropCount).join("");
}

/**
 * @param {import("./subtitles.js").SubtitleWord} w
 * @param {number} cs
 * @param {number} ce
 */
export function tombstoneSplitSubtitleWord(w, cs, ce) {
  const ws = w.start;
  const we = w.end;
  if (!(ce - cs > EPS) || !(we - ws > EPS)) return [w];
  if (ce <= ws + EPS || cs >= we - EPS) return [w];

  const o0 = Math.max(ws, cs);
  const o1 = Math.min(we, ce);
  if (o1 - o0 < EPS) return [w];

  if (cs <= ws + EPS && ce >= we - EPS) {
    return [{ ...w, is_deleted: true, isDeleted: true }];
  }

  const dur = we - ws;
  const chars = [...w.word];

  if (!chars.length) {
    return [{ ...w, is_deleted: true, isDeleted: true }];
  }

  if (o0 <= ws + EPS && o1 < we - EPS) {
    const ratio = (o1 - ws) / dur;
    const n = Math.min(chars.length, Math.max(0, Math.round(chars.length * ratio)));
    const out = [];
    if (o1 - ws > EPS) {
      out.push({
        ...w,
        start: ws,
        end: o1,
        word: chars.slice(0, n).join(""),
        is_deleted: true,
        isDeleted: true,
      });
    }
    const rest = sliceCharsStart(w.word, n).trim();
    if (rest && we - o1 > EPS) {
      out.push({ ...w, start: o1, end: we, word: rest });
    }
    return out.filter((x) => x.end - x.start > EPS);
  }

  if (o0 > ws + EPS && o1 >= we - EPS) {
    const ratio = (we - o0) / dur;
    const n = Math.min(chars.length, Math.max(0, Math.round(chars.length * ratio)));
    const rest = sliceCharsEnd(w.word, n).trim();
    const out = [];
    if (rest && o0 - ws > EPS) {
      out.push({ ...w, start: ws, end: o0, word: rest });
    }
    if (we - o0 > EPS) {
      out.push({
        ...w,
        start: o0,
        end: we,
        word: chars.slice(chars.length - n).join(""),
        is_deleted: true,
        isDeleted: true,
      });
    }
    return out.filter((x) => x.end - x.start > EPS);
  }

  if (o0 > ws + EPS && o1 < we - EPS) {
    const { left, right } = splitWordTextAtMediaCut(w.word, ws, we, o0);
    const out = [];
    if (left.trim() && o0 - ws > EPS) {
      out.push({ ...w, start: ws, end: o0, word: left.trim() });
    }
    if (o1 - o0 > EPS) {
      out.push({
        ...w,
        start: o0,
        end: o1,
        word: chars.slice(Math.round((left.length / Math.max(chars.length, 1)) * chars.length)).join("").trim() || " ",
        is_deleted: true,
        isDeleted: true,
      });
    }
    if (right.trim() && we - o1 > EPS) {
      out.push({ ...w, start: o1, end: we, word: right.trim() });
    }
    return out.filter((x) => x.end - x.start > EPS);
  }

  return [w];
}

/**
 * @param {import("./subtitles.js").SubtitleLine} cue
 * @param {import("./subtitles.js").SubtitleWord[]} newWords
 */
function rebuildCueAfterWordCuts(cue, newWords) {
  const vis = visibleSubtitleWords(newWords);
  if (!vis.length) return null;
  cue.words = newWords;
  cue.start = Math.min(...vis.map((w) => w.start));
  cue.end = Math.max(...vis.map((w) => w.end));
  cue.text = displayTextFromSubtitleWords(newWords);
  return cue;
}

/**
 * @param {import("./subtitles.js").SubtitleLine[]} cues
 * @param {number} cutStart
 * @param {number} cutEnd
 */
export function applyProgramTimeRangeTombstoneCutToCues(cues, cutStart, cutEnd) {
  const cs = snapTimelineSec(Math.min(cutStart, cutEnd));
  const ce = snapTimelineSec(Math.max(cutStart, cutEnd));
  if (!(ce > cs + EPS)) return cues;

  let anyVisible = false;
  for (const cue of cues || []) {
    if (cue.is_silence || cue.isSilence) continue;
    let words = cue.words ? [...cue.words] : [];
    if (!words.length) {
      const syn = {
        start: cue.start,
        end: cue.end,
        word: String(cue.text || "").trim() || " ",
        is_silence: false,
        is_deleted: false,
      };
      words = tombstoneSplitSubtitleWord(syn, cs, ce);
    } else {
      const flat = [];
      for (const w of words) {
        if (wordIsDeleted(w)) {
          flat.push(w);
          continue;
        }
        flat.push(...tombstoneSplitSubtitleWord(w, cs, ce));
      }
      words = flat;
    }
    const rebuilt = rebuildCueAfterWordCuts(cue, words);
    if (rebuilt) anyVisible = true;
  }

  if (!anyVisible) return cues;
  return cues.filter((c) => {
    if (c.is_silence || c.isSilence) return false;
    return visibleSubtitleWords(c.words).length > 0;
  });
}
