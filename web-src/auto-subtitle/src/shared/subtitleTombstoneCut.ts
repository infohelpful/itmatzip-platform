/** Exact source-time cuts. Deleted pieces stay in storage for Undo and boundary editing. */
import type { SubtitleLine, SubtitleWord } from './subtitles'
import { displayTextFromSubtitleWords } from './subtitles'
import { mergeCutRanges, snapTimelineSec } from './timelineCollapse'
import { deletedAudioRow, insertRowsByTime, syncTimingLine } from './wordTimingEdit'

const EPS=1e-9

export function tombstoneSplitSubtitleWord(word: SubtitleWord, start: number, end: number): SubtitleWord[] {
  if (word.isDeleted || end<=word.start+EPS || start>=word.end-EPS || end<=start) return [word]
  if (start<=word.start+EPS && end>=word.end-EPS) return [{...word,isDeleted:true,mergedByEdgeTrim:false}]
  const a=Math.max(start,word.start), b=Math.min(end,word.end)
  const chars=Array.from(word.word)
  const offset=(t:number)=>Math.round(chars.length*(t-word.start)/(word.end-word.start))
  const spans=[[word.start,a,false],[a,b,true],[b,word.end,false]] as const
  return spans.filter(([s,e])=>e>s+EPS).map(([s,e,deleted],i)=>{
    // A silence chip's label is not speech: every piece keeps it rather than a proportional slice.
    const text=word.isSilence ? word.word : chars.slice(offset(s),offset(e)).join('').trim()
    const piece:SubtitleWord={...word,start:s,end:e,word:text,isDeleted:deleted,mergedByEdgeTrim:false,
      splitChain:`${word.splitChain??''}${i===0?'1':i===1?'21':'22'}`,
      manualStartLocked:true,manualEndLocked:true}
    if (word.id) piece.id=`${word.id}:cut:${Math.round(s*1e6)}:${Math.round(e*1e6)}`
    delete piece.charSpans;delete piece.textSpanMap;delete piece.readingOverride;delete piece.alignmentText
    if (!word.isSilence && text) {
      piece.alignmentStatus='manual'
      piece.reviewReasons=[...new Set([...(word.reviewReasons??[]),'time_range_cut'])]
    } else if (!text) {
      piece.isSilence=true;piece.gapKind='unclassified'
      delete piece.alignmentStatus
    }
    return piece
  })
}

/** Legacy name retained for callers; all input/output timestamps are SOURCE seconds. */
export function applyProgramTimeRangeTombstoneCutToSubtitleLines(
  lines: readonly SubtitleLine[], cutStart: number, cutEnd: number
): SubtitleLine[] {
  if (![cutStart,cutEnd].every(Number.isFinite)) return lines as SubtitleLine[]
  const start=snapTimelineSec(Math.max(0,Math.min(cutStart,cutEnd)))
  const end=snapTimelineSec(Math.max(cutStart,cutEnd))
  if (end<=start+EPS) return lines as SubtitleLine[]
  const next=lines.map(line=>{
    const original=line.words?.length ? line.words : [{start:line.start,end:line.end,word:line.text,
      ...(line.isDeleted ? {isDeleted:true} : {})}]
    const words=original.flatMap(w=>tombstoneSplitSubtitleWord(w,start,end))
    if (words.length===original.length && words.every((w,i)=>w===original[i])) return line
    const result=syncTimingLine(line,words)
    result.text=result.isDeleted ? '' : line.captionText ?? displayTextFromSubtitleWords(words)
    return result
  })
  // Word coverage is not complete: persist selected audio between/before/after words too.
  const covered=mergeCutRanges(next.flatMap(line=>(line.words??[])
    .filter(w=>w.isDeleted && !w.mergedByEdgeTrim)
    .map(w=>({start:Math.max(start,w.start),end:Math.min(end,w.end)}))))
  const gaps:SubtitleLine[]=[]
  let cursor=start
  for(const range of covered) {
    if(range.start>cursor+EPS) gaps.push(deletedAudioRow(cursor,range.start))
    cursor=Math.max(cursor,range.end)
  }
  if(end>cursor+EPS) gaps.push(deletedAudioRow(cursor,end))
  return insertRowsByTime(next,gaps)
}
