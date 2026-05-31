/**

 * AutoSubtitle App.tsx splitWordAtEditSecFromWaveform

 */



import { displayTextFromSubtitleWords, wordIsDeleted } from "./subtitles.js?v=20";

import { splitWordTextAtMediaCut } from "./subtitle-word-text-split.js";

import { makeRowWordBlockId } from "./block-ids.js";



const MIN_SPAN = 0.01;



/**

 * @typedef {{

 *   ok: boolean,

 *   lines: readonly import("./subtitles.js").SubtitleLine[],

 *   newLeftWordId: string | null,

 *   storageIdx: number,

 *   visibleWordIndex: number,

 *   splitMediaSec: number,

 * }} SplitWordAtMediaResult

 */



/**

 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines

 * @param {number} lineIndex

 * @param {number} visibleWordIndex 가??비삭?? ?�어 ?�덱??

 * @param {number} splitMediaSec

 * @returns {SplitWordAtMediaResult}

 */

export function splitWordAtMediaSecInLines(lines, lineIndex, visibleWordIndex, splitMediaSec) {

  const reject = (/** @type {readonly import("./subtitles.js").SubtitleLine[]} */ prev) => ({

    ok: false,

    lines: prev,

    newLeftWordId: null,

    storageIdx: -1,

    visibleWordIndex,

    splitMediaSec,

  });



  if (!Number.isFinite(splitMediaSec)) return reject(lines);

  if (lineIndex < 0 || lineIndex >= lines.length) return reject(lines);

  const line = lines[lineIndex];

  const words = line.words ?? [];

  if (!words.length || visibleWordIndex < 0) return reject(lines);



  let visibleSeen = -1;

  let storageIdx = -1;

  for (let i = 0; i < words.length; i += 1) {

    if (!wordIsDeleted(words[i])) {

      visibleSeen += 1;

      if (visibleSeen === visibleWordIndex) {

        storageIdx = i;

        break;

      }

    }

  }

  if (storageIdx < 0) return reject(lines);



  const w = words[storageIdx];

  const a = Math.min(w.start, w.end);

  const b = Math.max(w.start, w.end);

  if (!(b > a + MIN_SPAN * 2)) return reject(lines);



  const t = Math.max(a + MIN_SPAN, Math.min(b - MIN_SPAN, splitMediaSec));

  if (!(t > a + 1e-6 && t < b - 1e-6)) return reject(lines);



  const { left: leftText, right: rightText } = splitWordTextAtMediaCut(w.word, a, b, t);

  const leftFinal = leftText.length > 0 ? leftText : w.word;

  const rightFinal = rightText.length > 0 ? rightText : w.word;

  const parentChain = w.split_chain ?? w.splitChain ?? "";

  const leftChain = `${parentChain}1`;

  const rightChain = `${parentChain}2`;

  const newLeftWordId = `${makeRowWordBlockId(lineIndex + 1, storageIdx + 1)}_${leftChain}`;



  const left = {

    ...w,

    start: a,

    end: t,

    word: leftFinal,

    split_chain: leftChain,

    splitChain: leftChain,

  };

  const right = {

    ...w,

    start: t,

    end: b,

    word: rightFinal,

    split_chain: rightChain,

    splitChain: rightChain,

  };



  const nextWords = [...words.slice(0, storageIdx), left, right, ...words.slice(storageIdx + 1)];

  const updated = {

    ...line,

    words: nextWords,

    text: displayTextFromSubtitleWords(nextWords),

  };

  const nextLines = [...lines.slice(0, lineIndex), updated, ...lines.slice(lineIndex + 1)];



  return {

    ok: true,

    lines: nextLines,

    newLeftWordId,

    storageIdx,

    visibleWordIndex,

    splitMediaSec: t,

  };

}



/**

 * @param {readonly import("./subtitles.js").SubtitleLine[]} lines

 * @param {number} lineIndex

 * @param {number} visibleWordIndex

 * @param {number} splitEditSec

 * @param {(editSec: number) => number} mapEditToMediaSec

 */

export function splitWordAtEditSecInLines(

  lines,

  lineIndex,

  visibleWordIndex,

  splitEditSec,

  mapEditToMediaSec,

) {

  const splitMediaSec = Number.isFinite(splitEditSec)

    ? mapEditToMediaSec(splitEditSec)

    : Number.NaN;

  return splitWordAtMediaSecInLines(lines, lineIndex, visibleWordIndex, splitMediaSec);

}


