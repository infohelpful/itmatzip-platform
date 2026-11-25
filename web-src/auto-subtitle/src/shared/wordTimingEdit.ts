import type { SubtitleLine, SubtitleWord } from './subtitles'
import { markWordEdited } from './wordAlignmentMeta'
import { snapTimelineSec } from './timelineCollapse'
import { SILENCE_PLACEHOLDER_TEXT } from './wordContract'
export type TimingWordRef = { lineIndex: number; wordIndex: number }
export type TimingChip = TimingWordRef & { word: SubtitleWord }
type Entry = TimingChip
const EPS = 1e-9
const US = 1_000_000
const minWidth = (word: SubtitleWord) => word.isDeleted ? 1 / US : Math.min(.01, word.end - word.start)

/** Every chip on the source timeline in time order: live chips and cuts, not chips absorbed by a trim. */
export function orderedTimingChips(lines: readonly SubtitleLine[]): Entry[] {
  return lines.flatMap((line, lineIndex) => (line.words ?? []).flatMap((word, wordIndex) =>
    word.isDeleted && word.mergedByEdgeTrim ? [] : [{word,lineIndex,wordIndex}]))
    .sort((a,b)=>a.word.start-b.word.start || a.word.end-b.word.end || a.lineIndex-b.lineIndex || a.wordIndex-b.wordIndex)
}

export function timingNeighbours(lines: readonly SubtitleLine[], target: TimingWordRef) {
  const ordered=orderedTimingChips(lines)
  const index=ordered.findIndex(entry=>entry.lineIndex===target.lineIndex && entry.wordIndex===target.wordIndex)
  return {word:ordered[index]?.word, previous:ordered[index-1], next:ordered[index+1]}
}

/** Speech merges only inside its caption row; non-caption audio can be absorbed across rows. */
function canAbsorb(self: TimingWordRef, neighbour: Entry | undefined): boolean {
  return !!neighbour && !neighbour.word.isDeleted && (neighbour.lineIndex===self.lineIndex || neighbour.word.isSilence===true)
}

export function wordTimingLimits(lines: readonly SubtitleLine[], target: TimingWordRef, duration: number) {
  const {word,previous,next}=timingNeighbours(lines,target)
  if (!word || word.isDeleted) throw new Error('선택한 단어가 삭제되었거나 변경되었습니다. 다시 선택해 주세요.')
  return {
    // Reaching an absorbable neighbour's far edge merges it into the selected chip.
    startMin:!previous ? 0 : canAbsorb(target,previous) ? previous.word.start : snapTimelineSec(previous.word.start+minWidth(previous.word)),
    endMax:!next ? duration : canAbsorb(target,next) ? next.word.end : snapTimelineSec(next.word.end-minWidth(next.word)),
    minDuration:minWidth(word)
  }
}

export function syncTimingLine(line: SubtitleLine, words: SubtitleWord[]): SubtitleLine {
  const alive=words.filter(w=>!w.isDeleted)
  const spans=alive.length ? alive : words
  return {...line,words,isDeleted:alive.length===0,
    start:Math.min(...spans.map(w=>w.start)),end:Math.max(...spans.map(w=>w.end))}
}

/** A hidden audio interval is an editable cut, including where no ASR word exists. */
export function deletedAudioRow(start: number, end: number): SubtitleLine {
  return {start,end,text:'',isDeleted:true,words:[{start,end,word:'',isSilence:true,isDeleted:true,
    manualStartLocked:true,manualEndLocked:true}]}
}

/** Rows stay in source-time order (row numbers, active-line lookup); existing rows keep their relative order. */
export function insertRowsByTime(lines: readonly SubtitleLine[], rows: readonly SubtitleLine[]): SubtitleLine[] {
  const out=[...lines]
  for (const row of rows) {
    const at=out.findIndex(line=>line.start>row.start)
    out.splice(at<0 ? out.length : at,0,row)
  }
  return out
}

type Label = Pick<SubtitleWord,'word'|'isSilence'|'joinPrev'|'gapKind'|'charSpans'>
const labelOf=(w: SubtitleWord): Label => ({word:w.word,isSilence:w.isSilence,joinPrev:w.joinPrev,gapKind:w.gapKind,charSpans:w.charSpans})
const visibleChars=(text: string)=>Array.from(text).filter(c=>!/\s/.test(c)).length

/** Chip label after `right` is absorbed into `left` (storage-adjacent split pieces join without a space). */
function joinLabels(left: Label, right: Label, adjacent: boolean): Label {
  if (left.isSilence && right.isSilence) return left
  if (left.isSilence) return {...right,joinPrev:undefined}
  if (right.isSilence) return left
  const glue=right.joinPrev && adjacent ? '' : ' '
  const charSpans=left.charSpans && right.charSpans ? [...left.charSpans,...right.charSpans] : undefined
  return {word:left.word+glue+right.word,isSilence:undefined,joinPrev:left.joinPrev,gapKind:undefined,charSpans}
}

/** Give revived chips their text back: remove it from the end (or start) of the absorbing chip. */
function releaseLabel(label: Label, revived: readonly SubtitleWord[], edge: 'start'|'end'): Label {
  const speech=revived.filter(w=>!w.isSilence)
  if (!speech.length || label.isSilence) return label
  let returned=''
  speech.forEach((w,i)=>{returned+=(i>0 && !w.joinPrev ? ' ' : '')+w.word})
  const text=label.word
  if (text===returned) return {word:'오디오',isSilence:true,gapKind:'unclassified'}
  const spans=label.charSpans,cut=visibleChars(returned)
  if (edge==='end' && text.endsWith(returned)) {
    const rest=text.slice(0,-returned.length)
    if (!speech[0]!.joinPrev && !rest.endsWith(' ')) return label
    return {...label,word:rest.trimEnd(),charSpans:spans && spans.length>cut ? spans.slice(0,-cut) : undefined}
  }
  if (edge==='start' && text.startsWith(returned)) {
    const rest=text.slice(returned.length)
    return {...label,word:rest.trimStart(),joinPrev:!rest.startsWith(' ') || undefined,
      charSpans:spans && spans.length>cut ? spans.slice(cut) : undefined}
  }
  return label
}

const sameLabel=(a: Label, b: Label)=>a.word===b.word && !!a.isSilence===!!b.isSilence && !!a.joinPrev===!!b.joinPrev

/**
 * Source coordinates only. Shared boundaries include deleted words and caption-row boundaries.
 * Dragging onto an absorbable neighbour's far edge merges it (`mergedByEdgeTrim`, its audio is kept);
 * shrinking back over an absorbed chip revives it with its text.
 */
export function editWordTiming(lines: readonly SubtitleLine[], target: TimingWordRef, start: number, end: number, duration: number): SubtitleLine[] {
  if (![start,end,duration].every(Number.isFinite) || duration<=0) throw new Error('올바른 시간을 입력해 주세요.')
  start=snapTimelineSec(start);end=snapTimelineSec(end)
  const {word,previous,next}=timingNeighbours(lines,target)
  const limits=wordTimingLimits(lines,target,duration)
  if (start<0 || end>duration+EPS || end-start<limits.minDuration-EPS) {
    throw new Error('시작은 끝보다 빨라야 하며 단어 길이를 최소 0.01초 유지해 주세요.')
  }
  if (start<limits.startMin-EPS || end>limits.endMax+EPS) {
    throw new Error('이웃 단어 전체를 넘을 수 없습니다.')
  }
  if (word!.start===start && word!.end===end) return lines as SubtitleLine[]
  const updated=new Map<number,SubtitleWord[]>()
  const wordsOf=(lineIndex:number)=>{
    let words=updated.get(lineIndex)
    if (!words) {words=[...lines[lineIndex].words!];updated.set(lineIndex,words)}
    return words
  }
  const update=(ref:TimingWordRef,s:number,e:number,label?:Label) => {
    const words=wordsOf(ref.lineIndex)
    const old=words[ref.wordIndex]
    const value=markWordEdited(old,{...old,start:s,end:e,word:label?.word ?? old.word})
    if (label) {
      for (const key of ['isSilence','joinPrev','gapKind','charSpans'] as const) {
        if (label[key]===undefined) delete value[key]
        else (value as Record<string,unknown>)[key]=label[key]
      }
    }
    if (s!==old.start) value.manualStartLocked=true
    if (e!==old.end) value.manualEndLocked=true
    if (!value.isSilence && (s!==old.start || e!==old.end)) value.alignmentStatus='manual'
    words[ref.wordIndex]=value
  }
  const tombstone=(ref:TimingWordRef)=>{
    const words=wordsOf(ref.lineIndex)
    words[ref.wordIndex]={...words[ref.wordIndex],isDeleted:true,mergedByEdgeTrim:true}
  }
  /** Chips this one absorbed earlier by trimming (they lie inside its span), in storage order. */
  const absorbed=():Entry[]=>lines.flatMap((line,lineIndex)=>(line.words ?? []).flatMap((w,wordIndex)=>
    w.isDeleted && w.mergedByEdgeTrim && w.start>=word!.start-EPS && w.end<=word!.end+EPS ? [{word:w,lineIndex,wordIndex}] : []))
  let label:Label=labelOf(word!)
  const revive=(entries:Entry[],edge:'start'|'end')=>{
    for (const entry of entries) {
      const words=wordsOf(entry.lineIndex)
      const value:SubtitleWord={...words[entry.wordIndex],
        start:edge==='end' ? Math.max(entry.word.start,end) : entry.word.start,
        end:edge==='start' ? Math.min(entry.word.end,start) : entry.word.end}
      delete value.isDeleted;delete value.mergedByEdgeTrim
      words[entry.wordIndex]=value
    }
    label=releaseLabel(label,entries.map(entry=>entry.word),edge)
  }
  const extra:SubtitleLine[]=[]
  if (start!==word!.start) {
    const back=start>word!.start ? absorbed().filter(entry=>entry.word.start<start-EPS) : []
    if (previous && canAbsorb(target,previous) && start<=previous.word.start+EPS) {
      const adjacent=previous.lineIndex===target.lineIndex && previous.wordIndex===target.wordIndex-1
      label=joinLabels(labelOf(previous.word),label,adjacent)
      tombstone(previous)
    } else if (back.length) {
      revive(back,'start')
    } else {
      // A deleted neighbour is a cut: trimming toward it moves the cut edge across any ASR gap,
      // so the gap and the trimmed lead-in are removed too. Widening into the gap leaves the cut alone.
      const cutFollows=previous?.word.isDeleted===true && start>word!.start
      if (previous && (Math.abs(previous.word.end-word!.start)<EPS || start<previous.word.end || cutFollows)) {
        update(previous,previous.word.start,start)
      } else if (!previous && start>word!.start) extra.push(deletedAudioRow(word!.start,start))
    }
  }
  if (end!==word!.end) {
    const back=end<word!.end ? absorbed().filter(entry=>entry.word.end>end+EPS) : []
    if (next && canAbsorb(target,next) && end>=next.word.end-EPS) {
      const adjacent=next.lineIndex===target.lineIndex && next.wordIndex===target.wordIndex+1
      label=joinLabels(label,labelOf(next.word),adjacent)
      tombstone(next)
    } else if (back.length) {
      revive(back,'end')
    } else {
      const cutFollows=next?.word.isDeleted===true && end<word!.end
      if (next && (Math.abs(next.word.start-word!.end)<EPS || end>next.word.start || cutFollows)) {
        update(next,end,next.word.end)
      } else if (!next && end<word!.end) extra.push(deletedAudioRow(end,word!.end))
    }
  }
  update(target,start,end,sameLabel(label,labelOf(word!)) ? undefined : label)
  return insertRowsByTime(lines.map((line,i)=>updated.has(i) ? syncTimingLine(line,updated.get(i)!) : line),extra)
}

/** Shortest piece a split may leave on either side. */
export const MIN_SPLIT_PIECE_SEC = .01

export type SplitLabel = {
  left: string; right: string; joinPrev: boolean
  leftSpans?: SubtitleWord['charSpans']; rightSpans?: SubtitleWord['charSpans']
}

/**
 * Where the chip's text divides for a cut at `t`: the character boundary nearest `t` from the aligner's
 * per-character times, or the character-count ratio when the word has none. Null when it cannot split.
 */
export function splitWordLabel(word: SubtitleWord, t: number): SplitLabel | null {
  if (!(t>=word.start+MIN_SPLIT_PIECE_SEC-EPS && t<=word.end-MIN_SPLIT_PIECE_SEC+EPS)) return null
  if (word.isSilence) return {left:word.word,right:word.word,joinPrev:false}
  const chars=Array.from(word.word)
  const visible=chars.flatMap((c,i)=>/\s/.test(c) ? [] : [i])
  const n=visible.length
  if (n<2) return null
  const spans=word.charSpans
  const timed=spans?.length===n && spans.every((span,i)=>span.char===chars[visible[i]!] && Number.isFinite(span.start) && Number.isFinite(span.end))
  let k=Math.max(1,Math.min(n-1,Math.round((t-word.start)/(word.end-word.start)*n)))
  if (timed) {
    let best=Infinity
    for (let j=1;j<n;j++) {
      const d=Math.abs((spans![j-1]!.end+spans![j]!.start)/2-t)
      if (d<best) {best=d;k=j}
    }
  }
  const cut=visible[k]!
  return {left:chars.slice(0,cut).join('').trimEnd(),right:chars.slice(cut).join('').trimStart(),
    joinPrev:!/\s/.test(chars[cut-1]!),leftSpans:timed ? spans!.slice(0,k) : undefined,rightSpans:timed ? spans!.slice(k) : undefined}
}

/**
 * Split one chip at source time `t` into two chips. Caption text is unchanged: the right piece is marked
 * `joinPrev`. The left piece keeps the target slot; the right piece is inserted right after it.
 */
export function splitWordAt(lines: readonly SubtitleLine[], target: TimingWordRef, t: number): { lines: SubtitleLine[]; leftId: string; rightId: string } {
  const line=lines[target.lineIndex]
  const word=line?.words?.[target.wordIndex]
  if (!word || word.isDeleted) throw new Error('선택한 단어가 삭제되었거나 변경되었습니다. 다시 선택해 주세요.')
  t=snapTimelineSec(t)
  const label=splitWordLabel(word,t)
  if (!label) throw new Error('이 위치에서는 칩을 나눌 수 없습니다.')
  const ids=new Set(lines.flatMap(l=>(l.words ?? []).map(w=>w.id)).filter(Boolean))
  const base=word.id ?? `w${Math.round(word.start*US)}`
  let suffix=''
  for (let n=2;ids.has(`${base}~1${suffix}`) || ids.has(`${base}~2${suffix}`);n++) suffix=`.${n}`
  const piece=(s:number,e:number,text:string,spans:SplitLabel['leftSpans'],side:'1'|'2'):SubtitleWord=>{
    const value:SubtitleWord={...word,start:s,end:e,word:text,id:`${base}~${side}${suffix}`,splitChain:(word.splitChain ?? '')+side}
    delete value.textSpanMap;delete value.alignmentText;delete value.readingOverride
    if (spans) value.charSpans=spans; else delete value.charSpans
    if (!word.isSilence) value.alignmentStatus='manual'
    return value
  }
  const left=piece(word.start,t,label.left,label.leftSpans,'1')
  left.manualEndLocked=true
  const right=piece(t,word.end,label.right,label.rightSpans,'2')
  right.manualStartLocked=true
  if (!word.isSilence && label.joinPrev) right.joinPrev=true; else delete right.joinPrev
  const words=[...line.words!]
  words.splice(target.wordIndex,1,left,right)
  return {lines:lines.map((l,i)=>i===target.lineIndex ? syncTimingLine(l,words) : l),leftId:left.id!,rightId:right.id!}
}

export type TimingIdentity = { id?: string; start: number; end: number }

/** Find the chip being edited again after edits, undo or redo moved it: by ID, else the live chip at its middle. */
export function resolveTimingWord(lines: readonly SubtitleLine[], identity: TimingIdentity): TimingWordRef | null {
  const live=lines.flatMap((line,lineIndex)=>(line.words ?? []).flatMap((word,wordIndex)=>word.isDeleted ? [] : [{word,lineIndex,wordIndex}]))
  const byId=identity.id ? live.find(entry=>entry.word.id===identity.id) : undefined
  const mid=(identity.start+identity.end)/2
  const found=byId ?? live.find(entry=>entry.word.start<=mid+EPS && entry.word.end>=mid-EPS)
  return found ? {lineIndex:found.lineIndex,wordIndex:found.wordIndex} : null
}

export function formatPreciseTime(seconds: number): string {
  const micros=Math.max(0,Math.round(seconds*US))
  const whole=Math.floor(micros/US)
  return `${String(Math.floor(whole/3600)).padStart(2,'0')}:${String(Math.floor(whole/60)%60).padStart(2,'0')}:${String(whole%60).padStart(2,'0')}.${String(micros%US).padStart(6,'0')}`
}
export function parsePreciseTime(value: string): number | null {
  const text=value.trim()
  if (/^\d+(?:\.\d{1,6})?$/.test(text)) {
    const result=Number(text)
    return Number.isSafeInteger(Math.round(result*US)) ? snapTimelineSec(result) : null
  }
  const match=/^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?$/.exec(text)
  if (!match) return null
  const result=Number(match[1])*3600+Number(match[2])*60+Number(match[3])+Number((match[4]??'').padEnd(6,'0'))/US
  return Number.isSafeInteger(Math.round(result*US)) ? snapTimelineSec(result) : null
}
