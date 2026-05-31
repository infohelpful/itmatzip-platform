/**
 * AutoSubtitle subtitleWordEdgeDrag.ts (ported)
 */
import { wordIsDeleted, wordIsSilence } from "./subtitles.js?v=20";

export const MIN_WORD_DURATION_SEC = 0.01;

/**
 * ?¨ì–´ ë¸”ë¡ ì¢ŒÂ·ìš° ?£ì? ?œë˜ê·?Edge Drag) ?íƒœ ?…ë°?´íŠ¸ ? í‹¸ë¦¬í‹° ??Vrew ?¤í???**?ì  ?¡ìˆ˜** ?•ì±….
 *
 * ?•ì±…:
 *  1) **tombstone(`isDeleted: true`) ë¬´ì‹œ** ???¸ì ‘Â·?¡ìˆ˜ ë¡œì§?€ ??ƒ *?œì„±* ?¨ì–´???¬ì´?ì„œë§?
 *  2) **?œë˜ê·?ì¤?preview)?ëŠ” ?´ë–¤ ?¨ì–´ ?ìŠ¤?¸ë„ ?ˆë? ?ë?ì§€ ?ŠëŠ”??** target ??`start/end` ë§??€ì§ì´ê³?
 *     ì¹¨ë²”???´ì›ƒ?€ *?œê°„ë§? ì¤„ì–´? ë‹¤(prev.end ??newStart, next.start ??newEnd).
 *  3) **?¡ìˆ˜(Absorb)??commit ?œì—ë§? ?ì  ?„ë‹¬???Œë§Œ**:
 *     - ?¼ìª½ ?¸ë“¤??`prev.start` ê¹Œì? ?„ë‹¬(`newStart <= prev.start + eps`) ??prev ?µì§¸ ?¡ìˆ˜ (`mergedByEdgeTrim`).
 *     - ?¤ë¥¸ìª??¸ë“¤??`next.end` ê¹Œì? ?„ë‹¬(`newEnd >= next.end - eps`) ??next ?µì§¸ ?¡ìˆ˜.
 *     - ê·??¸ì—??commit ?œì—???¡ìˆ˜ê°€ ë°œìƒ?˜ì? ?Šìœ¼ë©? ?´ì›ƒ ?¨ì–´???œê°„ë§?ì¤„ì–´??ì±„ë¡œ ?¨ëŠ”??
 *  4) **Same-card only** ???¤ë¥¸ ì¹´ë“œ???¨ì–´?€???´ë–¤ ê²½ìš°?ë„ ?í˜¸?‘ìš©?˜ì? ?ŠëŠ”??cross-line clamp).
 *  5) **Revive(de-merge)** ???´ì „ ?¡ìˆ˜ë¡?tombstone ??*ê°™ì? ì¤? ?¨ì–´ê°€ ??gap ?ˆì— ?¤ì–´?¤ë©´ ?ë™ ë¶€??
 *  6) **ë¶€ëª?SubtitleLine ?™ê¸°??* ??ì¹´ë“œ??`start/end/text` ë¥??œì„± ?¨ì–´ë¡??¬ê³„??
 *
 * êµ¬í˜„ ?„ëµ:
 *   (a) Flatten ??`subtitles` ??`(lineIndex, wordIndex)` ë©”í??€ ?¨ê»˜ 1ì°¨ì› ?‰íƒ„??
 *   (b) Filter & Link ???œì„± ?¨ì–´ë¡?prev/next ?°ì‡„ êµ¬ì„±.
 *   (c) Calculate ??target ??edge ?œê°???´ë™?œì¼œ ?¡ìˆ˜Â·ë¶€???ìš© (commitMode ê°€ ?¡ìˆ˜ ê°€???¬ë?ë¥?ê²°ì •).
 *   (d) Unflatten & Sync ??ê²°ê³¼ë¥??ë³¸ ?„ì¹˜???˜ëŒë¦¬ê³  ì¹´ë“œ ë©”í??°ì´???¬ê³„??
 *
 * ëª¨ë“  ?¨ìˆ˜??**ë¶ˆë?(pure)** ???…ë ¥??ë³€?•í•˜ì§€ ?Šê³  ??ë°°ì—´/ê°ì²´ë¥?ë°˜í™˜?œë‹¤. ?œê°„ ?¨ìœ„??*ì´?.
 */

// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
// (a) Flatten
// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€

/** `subtitles` ??ëª¨ë“  ?¨ì–´ë¥?`(lineIndex, wordIndex)` ë©”í??€ ?¨ê»˜ 1ì°¨ì› ë°°ì—´ë¡??¼ì¹œ?? */
export function flattenSubtitleWords(subtitles) {
  const out = []
  for (let li = 0; li < subtitles.length; li++) {
    const line = subtitles[li];
    const words = line.words ?? []
    for (let wi = 0; wi < words.length; wi++) {
      const w = words[wi];
      out.push({
        lineIndex: li,
        wordIndex: wi,
        start: Number(w.start),
        end: Number(w.end),
        word: w.word,
        isSilence: wordIsSilence(w),
        isDeleted: wordIsDeleted(w),
        mergedByEdgeTrim: w.merged_by_edge_trim === true || w.mergedByEdgeTrim === true,
      })
    }
  }
  return out
}

// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
// (b) Filter & Link
// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€

/** ?œì„± ?¨ì–´ë§?ì¶”ì¶œ??`activeIndex` (?œì„± ë°°ì—´?ì„œ???„ì¹˜) ë¥?ë¶€?? */
export function activeWordsLinked(flat) {
  const out = []
  for (const fw of flat) {
    if (fw.isDeleted) continue
    out.push({ ...fw, activeIndex: out.length })
  }
  return out
}

/** `(lineIndex, wordIndex)` ??`activeIndex` ë§¤í•‘. */
export function buildActiveIndexMap(active) {
  const m = new Map();
  for (const a of active) m.set(`${a.lineIndex}:${a.wordIndex}`, a.activeIndex)
  return m
}

// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
// (c) Calculate ???µì‹¬ ?Œê³ ë¦¬ì¦˜
// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€

/** ??ì¹´ë“œ ???œì„± ?¨ì–´?¤ì˜ ?ìŠ¤??join ??ê³µë°± ?•ë¦¬ */
function joinWords(words) {
  return words.map((w) => String(w ?? '').trim()).filter((w) => w.length > 0).join(' ')
}

/** flat ë°°ì—´?ì„œ (li, wi) ?„ì¹˜ë¥?ì§ì ‘ ì°¾ëŠ”?? (`findFlat` ê³??™ì¼ ?˜ë„, ?´ë? ?¬í¼) */
function flatAt(flat, li, wi) {
  for (const fw of flat) {
    if (fw.lineIndex === li && fw.wordIndex === wi) return fw
  }
  return null
}

/** flat ??(li, wi) ?„ì¹˜ ?¸ë±????cross-line revive ??flat ?œì„œë¡?ì¢ŒÂ·ìš°ë¡??´ë™?˜ê¸° ?„í•¨. */
function flatIndexOf(flat, li, wi) {
  for (let i = 0; i < flat.length; i++) {
    const fw = flat[i];
    if (fw.lineIndex === li && fw.wordIndex === wi) return i
  }
  return -1
}

/**
 * target ??edge ?œê°??newSec ë¡??´ë™?œí‚¤ë©??¡ìˆ˜Â·ë¶€??ê²°ê³¼ë¥??œì„±/?‰íƒ„ ë°°ì—´??in-place ë¡?ë°˜ì˜.
 *
 * - **commitMode=false (preview)**: ?ìŠ¤?¸ëŠ” ?ˆë? ??ë°”ë€? target ??edge ë§??´ë™, ì¹¨ë²”???´ì›ƒ???œê°„ë§?ì¤„ì–´??
 * - **commitMode=true**: preview ?€ ?™ì¼?˜ë˜, ?¸ë“¤???´ì›ƒ??**?ì **???„ë‹¬?ˆì„ ?Œë§Œ ?µì§¸ ?¡ìˆ˜.
 * - **Revive(de-merge)**: ê°™ì? ì¤„ì—??ì§ì „ ?¡ìˆ˜ë¡?tombstone ???¨ì–´ê°€ ??gap ?ˆì— ?¤ì–´?¤ë©´ ë¶€??preview/commit ê³µí†µ).
 */
function applyEdgeChangeInPlace(
  active,
  flat,
  targetActiveIdx,
  edge,
  newSec,
  minWidthSec,
  onTombstone,
  onRevive,
  commitMode,
) {
  if (!Number.isFinite(newSec)) return
  const target = active[targetActiveIdx]
  if (!target) return

  /**
   * **Same-card only ?•ì±…** ???¤ë¥¸ ì¹´ë“œ ?¨ì–´?€???´ë–¤ ê²½ìš°?ë„ ?í˜¸?‘ìš©?˜ì? ?ŠëŠ”??
   * target ????edge ??cross-line prev.end / next.start ê¹Œì?ë¡œë§Œ clamp.
   */
  const crossPrev = (() => {
    const i = active.indexOf(target)
    const p = i > 0 ? active[i - 1] : null
    return p && p.lineIndex !== target.lineIndex ? p : null
  })()
  const crossNext = (() => {
    const i = active.indexOf(target)
    const n = i >= 0 && i < active.length - 1 ? active[i + 1] : null
    return n && n.lineIndex !== target.lineIndex ? n : null
  })()

  if (edge === 'start') {
    const ownEnd = target.end
    let newStart = newSec
    if (newStart > ownEnd - minWidthSec) newStart = ownEnd - minWidthSec
    if (crossPrev && newStart < crossPrev.end) newStart = crossPrev.end

    if (newStart < target.start) {
      /**
       * Expand left ???ì  ?¡ìˆ˜ë§?
       *  - prev.start < newStart < prev.end : prev ?ìŠ¤??ë³´ì¡´, prev.end ??newStart (?œê°„ë§?ì¤„ì„).
       *  - newStart <= prev.start (?ì  ?„ë‹¬) **AND** commitMode : prev ?µì§¸ ?¡ìˆ˜.
       *  - ?ì ???„ë‹¬?ˆì–´??commitMode=false ?´ë©´ prev.end ??prev.start ê¹Œì?ë§?(?œê°??prev ê°€ 0 ??.
       */
      while (true) {
        const prev = findPrevActive(active, target)
        if (!prev) break
        if (prev.lineIndex !== target.lineIndex) break
        if (newStart >= prev.end) break

        if (newStart > prev.start + 1e-9) {
          prev.end = newStart
          break
        }

        if (!commitMode) {
          /** ?ì  ?„ë‹¬?ˆì?ë§?preview ?¨ê³„ ??prev ??0 ??œ¼ë¡?ë³´ì´ê²Œë§Œ ?ê³  ?¡ìˆ˜??ë³´ë¥˜. */
          prev.end = prev.start
          break
        }

        /** commit + ?ì  ?„ë‹¬ ???µì§¸ ?¡ìˆ˜. */
        target.word = joinWords([prev.word, target.word])
        prev.isDeleted = true
        prev.mergedByEdgeTrim = true
        onTombstone(prev)
        removeActive(active, prev)
        if (newStart >= prev.start) break
      }
      target.start = newStart
    } else if (newStart > target.start) {
      /**
       * Shrink right ??revive ?°ì„ , ?†ìœ¼ë©?prev.end ë¥??˜ë ¤ ë¹?ê³µê°„ ì±„ì?(?ìŠ¤??ë³´ì¡´).
       *  revive ???¨ì–´???ë˜ ?ìŠ¤??ê·¸ë?ë¡??´ì•„?˜ë?ë¡?target.word ???ë?ì§€ ?ŠëŠ”??
       */
      const revived = reviveTombstonedPrevs(flat, target, newStart, onRevive)
      target.start = newStart
      if (revived.length === 0) {
        const prev = findPrevActive(active, target)
        if (prev && prev.lineIndex === target.lineIndex) {
          prev.end = newStart
        }
      } else {
        insertActiveBefore(active, target, revived)
        const rightmost = revived[0]
        if (rightmost && target.start > rightmost.end) target.start = rightmost.end
      }
    }
    return
  }

  // edge === 'end'
  const ownStart = target.start
  let newEnd = newSec
  if (newEnd < ownStart + minWidthSec) newEnd = ownStart + minWidthSec
  if (crossNext && newEnd > crossNext.start) newEnd = crossNext.start

  if (newEnd > target.end) {
    /**
     * Expand right ???ì  ?¡ìˆ˜ë§?
     *  - next.start < newEnd < next.end : next ?ìŠ¤??ë³´ì¡´, next.start ??newEnd (?œê°„ë§?ì¤„ì„).
     *  - newEnd >= next.end (?ì  ?„ë‹¬) **AND** commitMode : next ?µì§¸ ?¡ìˆ˜.
     */
    while (true) {
      const next = findNextActive(active, target)
      if (!next) break
      if (next.lineIndex !== target.lineIndex) break
      if (newEnd <= next.start) break

      if (newEnd < next.end - 1e-9) {
        next.start = newEnd
        break
      }

      if (!commitMode) {
        next.start = next.end
        break
      }

      target.word = joinWords([target.word, next.word])
      next.isDeleted = true
      next.mergedByEdgeTrim = true
      onTombstone(next)
      removeActive(active, next)
      if (newEnd <= next.end + 1e-9) break
    }
    target.end = newEnd
  } else if (newEnd < target.end) {
    /**
     * Shrink left ??revive ?°ì„ , ?†ìœ¼ë©?next.start ë¥??¹ê²¨ ë¹?ê³µê°„ ì±„ì?(?ìŠ¤??ë³´ì¡´).
     */
    const revived = reviveTombstonedNexts(flat, target, newEnd, onRevive)
    target.end = newEnd
    if (revived.length === 0) {
      const next = findNextActive(active, target)
      if (next && next.lineIndex === target.lineIndex) {
        next.start = newEnd
      }
    } else {
      insertActiveAfter(active, target, revived)
      const leftmost = revived[0]
      if (leftmost && target.end < leftmost.start) target.end = leftmost.start
    }
  }
}

/**
 * target ??storage-prev (?¼ìª½) tombstone ??ì¤? ??left-edge `newStart` ê°€ ë§Œë“ 
 * **gap `[oldStart, newStart]`** ?ˆìœ¼ë¡??¤ì–´?¤ëŠ” ?¨ì–´ë¥?ë¶€?œì‹œ?¨ë‹¤.
 *
 * ê°??¨ì–´ `fw = [origStart, origEnd]` ???€??
 *  - `origStart >= newStart` : ?¨ì–´ ?„ì²´ê°€ ??target ë²”ìœ„ ????ë¶€?œí•˜ì§€ ?ŠìŒ (ê³„ì† ?¤ìŒ prev ?•ì¸)
 *  - `origStart < newStart < origEnd` : straddle ??ë¶€ë¶?ë¶€??`[newStart, origEnd]`. **ê³„ì†** ???¼ìª½ ê²€??
 *    (gap ???¤ë¥¸ìª?ê²½ê³„ê°€ ???¨ì–´??`origStart` ë³´ë‹¤ ?¼ìª½?´ë?ë¡?ì¶”ê? prev ë¶€?œì? ë³´í†µ ?†ìŒ)
 *  - `origEnd <= newStart` : ?¨ì–´ ?„ì²´ê°€ gap ?????„ì „ ë¶€??`[origStart, origEnd]`. ê³„ì† ê²€??
 *  - ?´ì•„?ˆëŠ” ?¨ì–´ë¥?ë§Œë‚˜ë©??•ì?.
 */
function reviveTombstonedPrevs(
  flat,
  target,
  newStart,
  onRevive,
) {
  const revived = []
  const targetFlatIdx = flatIndexOf(flat, target.lineIndex, target.wordIndex)
  if (targetFlatIdx < 0) return revived
  for (let i = targetFlatIdx - 1; i >= 0; i--) {
    const fw = flat[i];
    /** same-card only ???¤ë¥¸ ì¹´ë“œ ?¨ì–´ ê¹Œì? ë¶€?œí•˜ë©?cross-line ë³€?•ì´ ?¼ì–´?œë‹¤. */
    if (fw.lineIndex !== target.lineIndex) break
    if (!fw.isDeleted) break
    const origStart = fw.start
    const origEnd = fw.end
    if (origStart >= newStart - 1e-9) break
    fw.isDeleted = false
    /** revive ???¸ë¦¼ ?¡ìˆ˜ ë©”í????¨ê»˜ ?´ì œ ???¤ì‹œ ?´ì•„???¨ì–´???¼ë°˜ ?œì„± ?¨ì–´ë¡?ì·¨ê¸‰. */
    fw.mergedByEdgeTrim = false
    if (origEnd <= newStart + 1e-9) {
      fw.start = origStart
      fw.end = origEnd
    } else {
      fw.start = origStart
      fw.end = newStart
    }
    onRevive(fw)
    revived.push(fw)
  }
  return revived
}

/**
 * target ??storage-next (?¤ë¥¸ìª? tombstone ??ì¤? ??right-edge `newEnd` ê°€ ë§Œë“ 
 * **gap `[newEnd, oldEnd]`** ?ˆìœ¼ë¡??¤ì–´?¤ëŠ” ?¨ì–´ë¥?ë¶€?œì‹œ?¨ë‹¤.
 *
 *  - `origEnd <= newEnd` : ?¨ì–´ ?„ì²´ê°€ ??target ë²”ìœ„ ????ë¶€?œí•˜ì§€ ?ŠìŒ (?¤ìŒ next ê²€??
 *  - `origStart < newEnd < origEnd` : straddle ??ë¶€ë¶?ë¶€??`[newEnd, origEnd]`. ê³„ì† ?¤ìŒ ê²€??
 *  - `origStart >= newEnd` : ?¨ì–´ ?„ì²´ê°€ gap ?????„ì „ ë¶€?? ê³„ì†.
 *  - ?´ì•„?ˆëŠ” ?¨ì–´ë¥?ë§Œë‚˜ë©??•ì?.
 */
function reviveTombstonedNexts(
  flat,
  target,
  newEnd,
  onRevive,
) {
  const revived = []
  const targetFlatIdx = flatIndexOf(flat, target.lineIndex, target.wordIndex)
  if (targetFlatIdx < 0) return revived
  for (let i = targetFlatIdx + 1; i < flat.length; i++) {
    const fw = flat[i];
    /** same-card only ???¤ë¥¸ ì¹´ë“œë¡?ê±´ë„ˆê°€ë©?cross-line ë³€?•ì´ ?¼ì–´?œë‹¤. */
    if (fw.lineIndex !== target.lineIndex) break
    if (!fw.isDeleted) break
    const origStart = fw.start
    const origEnd = fw.end
    if (origEnd <= newEnd + 1e-9) continue
    fw.isDeleted = false
    fw.mergedByEdgeTrim = false
    if (origStart >= newEnd - 1e-9) {
      fw.start = origStart
      fw.end = origEnd
    } else {
      fw.start = newEnd
      fw.end = origEnd
    }
    onRevive(fw)
    revived.push(fw)
  }
  return revived
}

function insertActiveAfter(active, anchor, items) {
  const i = active.indexOf(anchor)
  if (i < 0) return
  const wrap = items.map((fw) => ({ ...fw, activeIndex: 0 }))
  active.splice(i + 1, 0, ...wrap)
}

function insertActiveBefore(active, anchor, items) {
  const i = active.indexOf(anchor)
  if (i < 0) return
  const wrap = items.map((fw) => ({ ...fw, activeIndex: 0 }))
  active.splice(i, 0, ...wrap)
}

function findPrevActive(active, from) {
  const i = active.indexOf(from)
  return i > 0 ? active[i - 1] : null;
}

function findNextActive(active, from) {
  const i = active.indexOf(from)
  return i >= 0 && i < active.length - 1 ? active[i + 1] : null;
}

function removeActive(active, target) {
  const i = active.indexOf(target)
  if (i >= 0) active.splice(i, 1)
}

// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
// (d) Unflatten & Sync
// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€

/** flat ë°°ì—´??ìµœì‹  ê°’ìœ¼ë¡??ë³¸ `subtitles` ë¥???ê°ì²´ë¡??¬êµ¬??+ SubtitleLine ë©”í? ?™ê¸°?? */
export function unflattenAndSync(
  original,
  flat
) {
  /** lineIndex ??wordIndex ??ìµœì‹  FlatWord */
  const byLine = original.map(() => []);
  for (const fw of flat) {
    const arr = byLine[fw.lineIndex]
    if (arr) arr[fw.wordIndex] = fw
  }

  const out = original.map((line, li) => {
    const flatRow = byLine[li] ?? []
    const newWords = (line.words ?? []).map((w, wi) => {
      const fw = flatRow[wi]
      if (!fw) return w
      const next = {
        ...w,
        start: fw.start,
        end: fw.end,
        word: fw.word,
        is_deleted: fw.isDeleted ? true : false,
        isDeleted: fw.isDeleted ? true : false,
      };
      if (fw.mergedByEdgeTrim) {
        next.merged_by_edge_trim = true;
        next.mergedByEdgeTrim = true;
      } else {
        delete next.merged_by_edge_trim;
        delete next.mergedByEdgeTrim;
      }
      return next;
    });

    const activeWords = newWords.filter((w) => !wordIsDeleted(w));
    if (activeWords.length === 0) {
      return {
        ...line,
        words: newWords,
        isDeleted: true
      }
    }

    /**
     * ëª¨ë“  active ?¨ì–´???ìŠ¤?¸ê? trim ??0 ê¸€?ë¼ë©??¼ì¸?€ ?œê°ë§??¨ê³  ê¸€?ê? ë¹„ì–´ ë³´ì¸??
     * ì¹´ë“œ UI ???œë‹¨?´ë¸”ë¡??˜ë‚˜ ?†ì´ ë¹??¨ì–´ì¹´ë“œ??ê°€ ?¨ëŠ” ê±?ë§‰ê¸° ?„í•´ ì¤??„ì²´ë¥?tombstone ì²˜ë¦¬.
     */
    const visibleText = joinWords(activeWords.map((w) => w.word)).trim()
    if (visibleText.length === 0) {
      const tombstoned = newWords.map((w) =>
        wordIsDeleted(w) ? w : { ...w, is_deleted: true, isDeleted: true },
      );
      return {
        ...line,
        words: tombstoned,
        isDeleted: true
      }
    }

    const first = activeWords[0];
    const last = activeWords[activeWords.length - 1];
    return {
      ...line,
      start: first.start,
      end: last.end,
      text: joinWords(activeWords.map((w) => w.word)),
      words: newWords,
      isDeleted: false
    }
  })

  return out
}

// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
// Public API ????ë²ˆì˜ ?£ì? ?œë˜ê·?ê²°ê³¼ë¥??ìš©
// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€

/**
 * ??ë²ˆì˜ ?£ì? ?œë˜ê·?ë§ˆìš°???´ë™ ???„ë ˆ???ëŠ” ???€ ??ë²? ê²°ê³¼ë¥?`subtitles` ?íƒœ ?¸ë¦¬??ë°˜ì˜?œë‹¤.
 *
 * - ?…ë ¥??ë³€?•í•˜ì§€ ?Šìœ¼ë©???`subtitles` ë°°ì—´??ë°˜í™˜.
 * - target ?¨ì–´ê°€ tombstone ?´ê±°??ì¡´ì¬?˜ì? ?Šìœ¼ë©??…ë ¥ê³??™ì¹˜??ê²°ê³¼ë¥?ê·¸ë?ë¡?ë°˜í™˜.
 * - **?¡ìˆ˜??`commitMode=true` ???Œë§Œ**, ?¸ë“¤???´ì›ƒ???ì ???„ë‹¬?ˆì„ ?Œì— ?œí•´ ?¼ì–´?œë‹¤.
 */
export function applyWordEdgeDrag(input) {
  const {
    subtitles,
    target,
    edge,
    newSec,
    minWordWidthSec = MIN_WORD_DURATION_SEC,
    commitMode = false
  } = input

  if (!Number.isFinite(newSec)) {
    return { subtitles: subtitles.slice(), mutated: [], tombstoned: [] }
  }

  const flat = flattenSubtitleWords(subtitles)
  const active = activeWordsLinked(flat)
  const indexMap = buildActiveIndexMap(active)

  const targetKey = `${target.lineIndex}:${target.wordIndex}`
  const targetActiveIdx = indexMap.get(targetKey)
  if (targetActiveIdx == null) {
    return { subtitles: subtitles.slice(), mutated: [], tombstoned: [] }
  }

  const tombstonedRefs = []
  const revivedRefs = []
  applyEdgeChangeInPlace(
    active,
    flat,
    targetActiveIdx,
    edge,
    newSec,
    Math.max(1e-6, minWordWidthSec),
    (a) => {
      tombstonedRefs.push({ lineIndex: a.lineIndex, wordIndex: a.wordIndex })
    },
    (fw) => {
      revivedRefs.push({ lineIndex: fw.lineIndex, wordIndex: fw.wordIndex })
    },
    commitMode
  )

  /** active ??(start/end/word) ë³€ê²??¬í•­??flat ?¼ë¡œ ?˜ëŒ??ë°˜ì˜. */
  for (const a of active) {
    const fw = findFlat(flat, a.lineIndex, a.wordIndex)
    if (!fw) continue
    fw.start = a.start
    fw.end = a.end
    fw.word = a.word
    fw.isDeleted = false
    fw.mergedByEdgeTrim = false
  }
  /**
   * tombstone ?œì‹œ ??active ?ì„œ ë¹ ì§„ ?¨ì–´. `mergedByEdgeTrim` ???¨ê»˜ ë§ˆí‚¹??stitched ?Œí˜• cut
   * ?¼ë¡œ ?¤ì–´ê°€ì§€ ?Šë„ë¡??œë‹¤(SubtitleWord.mergedByEdgeTrim ?Œë˜ê·¸ê? ê·??¨ê³¼ë¥?ë§Œë“ ??.
   */
  for (const ref of tombstonedRefs) {
    const fw = findFlat(flat, ref.lineIndex, ref.wordIndex)
    if (fw) {
      fw.isDeleted = true
      fw.mergedByEdgeTrim = true
    }
  }

  const nextSubtitles = unflattenAndSync(subtitles, flat)

  const mutated = [{ lineIndex: target.lineIndex, wordIndex: target.wordIndex }]
  for (const r of revivedRefs) mutated.push(r)
  return { subtitles: nextSubtitles, mutated, tombstoned: tombstonedRefs }
}

function findFlat(flat, li, wi) {
  // flat ë°°ì—´?€ (lineIndex, wordIndex) ?¬ì „?œìœ¼ë¡??¤ì–´ ?ˆìœ¼ë¯€ë¡?? í˜• ?ìƒ‰??ì¶©ë¶„??ë¹ ë¥´??
  for (const fw of flat) {
    if (fw.lineIndex === li && fw.wordIndex === wi) return fw
  }
  return null
}
