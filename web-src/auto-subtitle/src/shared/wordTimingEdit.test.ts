import { describe, it, expect } from 'vitest'
import { editWordTiming, formatPreciseTime, parsePreciseTime, resolveTimingWord, splitWordAt, splitWordLabel } from './wordTimingEdit'
import { mergeWaveformPeaksStitchCutRanges, subtitleLinesAfterSoftDeleteWordRange } from './virtualTimeline'
import { applyProgramTimeRangeTombstoneCutToSubtitleLines as cut } from './subtitleTombstoneCut'
import { mediaToEditTime, mergeCutRanges } from './timelineCollapse'
import { displayTextFromSubtitleWords, subtitleWordPiecesForExport, type SubtitleLine, type SubtitleWord } from './subtitles'
import { sentenceTokenTimelineToSubtitleLines, subtitleLinesToSentenceTokenTimeline } from './sentenceTokenTimelineAdapter'

const row = (word: string, start: number, end: number): SubtitleLine => ({start,end,text:word,words:[{id:word,word,start,end}]})
const ranges = (lines: SubtitleLine[]) => mergeWaveformPeaksStitchCutRanges([],lines,[])
describe('precise word boundaries', () => {
  it('moves a shared boundary across caption rows without rewriting later source times or text', () => {
    const lines=[row('앞',0,1),row('뒤',1,2),row('다음',2,3)]
    const result=editWordTiming(lines,{lineIndex:1,wordIndex:0},1.125001,2,3)
    expect(result[0].words![0].end).toBe(1.125001)
    expect(result[0].end).toBe(1.125001)
    expect(result[1].start).toBe(1.125001)
    expect(result[2]).toBe(lines[2])
    expect(result.map(l=>l.text)).toEqual(lines.map(l=>l.text))
    expect(lines[0].end).toBe(1)
    expect(ranges(result)).toEqual([])
  })
  it('extends the deleted interval instead of stretching live speech across it', () => {
    const lines=[row('앞',0,1),row('삭제',1,2),row('뒤',2,3)]
    const deleted=subtitleLinesAfterSoftDeleteWordRange(lines,1,0,1,[])!.lines
    const first=editWordTiming(deleted,{lineIndex:0,wordIndex:0},0,.95,3)
    const result=editWordTiming(first,{lineIndex:2,wordIndex:0},2.050001,3,3)
    expect(result[0].words![0].end).toBe(.95)
    expect(ranges(result)).toEqual([{start:.95,end:2.050001}])
    expect(mediaToEditTime(2.050001,ranges(result))).toBeCloseTo(.95,8)
    const restored=editWordTiming(result,{lineIndex:2,wordIndex:0},1.98,3,3)
    expect(ranges(restored)).toEqual([{start:.95,end:1.98}])
  })
  it('a deleted chip takes the short gaps to its neighbours; trimming moves that edge, widening a live chip plays what it covers', () => {
    // 앞(0-1) 삭제(1.05-1.5) 틈(1.5-1.58) 뒤(1.58-2.2) 틈 끝(2.25-3)
    const lines=[row('앞',0,1),row('삭제',1.05,1.5),row('뒤',1.58,2.2),row('끝',2.25,3)]
    const deleted=subtitleLinesAfterSoftDeleteWordRange(lines,1,0,1,[])!.lines
    expect(ranges(deleted)).toEqual([{start:1,end:1.58}])
    const trimmedHead=editWordTiming(deleted,{lineIndex:2,wordIndex:0},1.62,2.2,3)
    expect(ranges(trimmedHead)).toEqual([{start:1,end:1.62}])
    const widened=editWordTiming(deleted,{lineIndex:2,wordIndex:0},1.53,2.2,3)
    expect(ranges(widened)).toEqual([{start:1,end:1.53}])
    // The same rule on the other side: a deleted next neighbour follows an earlier end.
    const tailDeleted=subtitleLinesAfterSoftDeleteWordRange(lines,3,0,1,[])!.lines
    const trimmedTail=editWordTiming(tailDeleted,{lineIndex:2,wordIndex:0},1.58,2.1,3)
    expect(ranges(trimmedTail)).toEqual([{start:2.1,end:3}])
    // A live neighbour across a gap is never moved.
    expect(editWordTiming(lines,{lineIndex:2,wordIndex:0},1.62,2.2,3)[1]).toBe(lines[1])
  })
  it('preserves an unselected audio gap and rejects crossing a whole neighbour', () => {
    const lines=[row('앞',0,1),row('뒤',1.4,2)]
    const result=editWordTiming(lines,{lineIndex:1,wordIndex:0},1.45,2,2)
    expect(result[0]).toBe(lines[0])
    expect(ranges(result)).toEqual([])
    expect(()=>editWordTiming(lines,{lineIndex:1,wordIndex:0},0,2,2)).toThrow()
    expect(()=>editWordTiming(lines,{lineIndex:1,wordIndex:0},2,1,2)).toThrow()
    expect(()=>editWordTiming(lines,{lineIndex:1,wordIndex:0},NaN,2,2)).toThrow()
  })
  it('locks one-microsecond manual edits and keeps microsecond gaps between cuts', () => {
    const result=editWordTiming([row('앞',0,1),row('뒤',1,2)],{lineIndex:1,wordIndex:0},1.000001,2,2)
    expect(result[1].words![0]).toMatchObject({manualStartLocked:true,alignmentStatus:'manual'})
    expect(mergeCutRanges([{start:1,end:1.1},{start:1.100002,end:2}])).toHaveLength(2)
  })
  it('retains deleted records for prefix/suffix trims at media edges', () => {
    const result=editWordTiming([row('하나',0,3)],{lineIndex:0,wordIndex:0},.1,2.9,3)
    expect(ranges(result)).toEqual([{start:0,end:.1},{start:2.9,end:3}])
  })
})
describe('exact time selection cuts', () => {
  it('deletes a gap with no word and retains all fully deleted rows', () => {
    const lines=[row('앞',0,1),row('뒤',2,3)]
    expect(ranges(cut(lines,1.1,1.8))).toEqual([{start:1.1,end:1.8}])
    const result=cut(lines,0,3)
    expect(result.every(l=>l.isDeleted)).toBe(true)
    expect(ranges(result)).toEqual([{start:0,end:3}])
  })
  it('inserts deleted audio rows in source-time order without moving existing rows', () => {
    const lines=[row('앞',1,2),row('중',3,4),row('뒤',5,6)]
    const starts=(ls:SubtitleLine[])=>ls.map(l=>l.start)
    const gap=cut(lines,2.2,2.8)
    expect(starts(gap)).toEqual([1,2.2,3,5])
    expect(gap[0]).toBe(lines[0]);expect(gap[2]).toBe(lines[1]);expect(gap[3]).toBe(lines[2])
    expect(starts(cut(lines,0,.5))).toEqual([0,1,3,5])
    expect(starts(cut(lines,2.5,3.5))).toEqual([1,2.5,3.5,5])
    expect(starts(editWordTiming(lines,{lineIndex:0,wordIndex:0},1.3,2,6))).toEqual([1,1.3,3,5])
    expect(starts(editWordTiming(lines,{lineIndex:2,wordIndex:0},5,5.5,6))).toEqual([1,3,5,5.5])
  })
  it('keeps the silence label on every piece instead of splitting it like speech', () => {
    const silent:SubtitleLine={start:1,end:2,text:'',words:[{word:'오디오',start:1,end:2,isSilence:true,gapKind:'unclassified'}]}
    const words=cut([row('앞',0,1),silent,row('뒤',2,3)],1.2,1.8)[1].words!
    expect(words.map(w=>[w.word,w.start,w.end,!!w.isDeleted,!!w.isSilence])).toEqual([
      ['오디오',1,1.2,false,true],['오디오',1.2,1.8,true,true],['오디오',1.8,2,false,true]])
    expect(words.every(w=>w.alignmentStatus===undefined&&w.reviewReasons===undefined)).toBe(true)
  })
  it('preserves exact sub-word cut intervals with unique piece IDs and review metadata', () => {
    const result=cut([row('가나다라',0,4)],1.000001,2.000002)
    expect(ranges(result)).toEqual([{start:1.000001,end:2.000002}])
    const words=result.flatMap(l=>l.words??[])
    expect(new Set(words.map(w=>w.id)).size).toBe(words.length)
    expect(words.filter(w=>!w.isDeleted).every(w=>w.reviewReasons?.includes('time_range_cut'))).toBe(true)
  })
})
it('round trips microsecond time input without accepting invalid fields',()=>{
  expect(formatPreciseTime(61.000001)).toBe('00:01:01.000001')
  expect(parsePreciseTime('00:01:01.000001')).toBe(61.000001)
  expect(parsePreciseTime('1.000001')).toBe(1.000001)
  for(const value of ['','-1','NaN','00:60:00.000000','1.0000001']) expect(parsePreciseTime(value)).toBeNull()
})

const line = (...words: Array<[string, number, number, Partial<SubtitleWord>?]>): SubtitleLine => ({
  start: words[0]![1], end: words.at(-1)![2], text: words.map(w => w[0]).join(' '),
  words: words.map(([word, start, end, extra]) => ({ id: word, word, start, end, ...extra }))
})
const labels = (l: SubtitleLine) => (l.words ?? []).filter(w => !w.isDeleted).map(w => w.word)
describe('trim merge and revive', () => {
  it('absorbs a whole neighbour in the same row without cutting its audio, and revives it when shrunk back', () => {
    const lines = [line(['앞', 0, 1], ['중간', 1, 2], ['뒤', 2, 3])]
    const merged = editWordTiming(lines, { lineIndex: 0, wordIndex: 0 }, 0, 2, 3)
    expect(labels(merged[0]!)).toEqual(['앞 중간', '뒤'])
    expect(merged[0]!.words![1]).toMatchObject({ isDeleted: true, mergedByEdgeTrim: true })
    expect(ranges(merged)).toEqual([])
    expect(merged[0]!.text).toBe('앞 중간 뒤')
    const revived = editWordTiming(merged, { lineIndex: 0, wordIndex: 0 }, 0, 1.4, 3)
    expect(labels(revived[0]!)).toEqual(['앞', '중간', '뒤'])
    expect(revived[0]!.words![1]).toMatchObject({ start: 1.4, end: 2 })
    expect(revived[0]!.words![1]!.isDeleted).toBeUndefined()
    expect(ranges(revived)).toEqual([])
  })
  it('never merges speech across caption rows, but absorbs neighbouring audio across rows', () => {
    const lines = [line(['앞', 0, 1]), line(['뒤', 1, 2])]
    expect(() => editWordTiming(lines, { lineIndex: 1, wordIndex: 0 }, 0, 2, 3)).toThrow()
    const audio = [line(['앞', 0, 1]), line(['오디오', 1, 2, { isSilence: true, gapKind: 'unclassified' }])]
    const merged = editWordTiming(audio, { lineIndex: 0, wordIndex: 0 }, 0, 2, 3)
    expect(labels(merged[0]!)).toEqual(['앞'])
    expect(merged[1]!.isDeleted).toBe(true)
    expect(ranges(merged)).toEqual([])
  })
})
describe('split chip at the play line', () => {
  const spans = [{ char: '설', start: 0, end: .16, score: 1 }, { char: '치', start: .16, end: .28, score: 1 },
    { char: '나', start: .28, end: .4, score: 1 }]
  it('divides text at the aligner character boundary nearest the play line and keeps the caption text', () => {
    const lines = [line(['지금', 0, .5]), line(['설치나', 1, 1.4, { charSpans: spans.map(s => ({ ...s, start: s.start + 1, end: s.end + 1 })) }])]
    expect(splitWordLabel(lines[1]!.words![0]!, 1.17)).toMatchObject({ left: '설', right: '치나', joinPrev: true })
    const { lines: out, leftId, rightId } = splitWordAt(lines, { lineIndex: 1, wordIndex: 0 }, 1.17)
    const [left, right] = out[1]!.words!
    expect([left!.word, left!.start, left!.end, right!.word, right!.start, right!.end]).toEqual(['설', 1, 1.17, '치나', 1.17, 1.4])
    expect([left!.id, right!.id]).toEqual([leftId, rightId])
    expect(new Set(out.flatMap(l => l.words!.map(w => w.id))).size).toBe(3)
    expect(left!.charSpans!.map(c => c.char)).toEqual(['설'])
    expect(right).toMatchObject({ joinPrev: true, manualStartLocked: true, splitChain: '2' })
    expect(out[1]!.text).toBe('설치나')
    expect(displayTextFromSubtitleWords(out[1]!.words)).toBe('설치나')
    expect(out[0]).toBe(lines[0])
    // Trimming the left piece over its sibling merges the word back without a space.
    const back = editWordTiming(out, { lineIndex: 1, wordIndex: 0 }, 1, 1.4, 3)
    expect(labels(back[1]!)).toEqual(['설치나'])
    expect(back[1]!.words![0]!.charSpans!.map(c => c.char)).toEqual(['설', '치', '나'])
  })
  it('falls back to the character ratio without aligner times and refuses impossible splits', () => {
    expect(splitWordLabel({ word: 'ISO', start: 0, end: .3 }, .1)).toMatchObject({ left: 'I', right: 'SO' })
    expect(splitWordLabel({ word: '앞 뒤', start: 0, end: 1 }, .5)).toMatchObject({ left: '앞', right: '뒤', joinPrev: false })
    expect(splitWordLabel({ word: '이', start: 0, end: .3 }, .1)).toBeNull()
    expect(splitWordLabel({ word: '설치', start: 0, end: .3 }, .005)).toBeNull()
    expect(() => splitWordAt([line(['이', 0, .3])], { lineIndex: 0, wordIndex: 0 }, .1)).toThrow()
  })
  it('splits audio chips into two locked audio chips that survive the timeline round trip', () => {
    const lines = [line(['오디오', 0, 2, { isSilence: true, gapKind: 'unclassified' }])]
    const { lines: out } = splitWordAt(lines, { lineIndex: 0, wordIndex: 0 }, .8)
    const back = sentenceTokenTimelineToSubtitleLines(subtitleLinesToSentenceTokenTimeline(out))
    expect(back[0]!.words!.map(w => [w.word, w.start, w.end, !!w.joinPrev])).toEqual([['오디오', 0, .8, false], ['오디오', .8, 2, false]])
  })
  it('joins split pieces only while the left piece is visible, and keeps the mark through save and reopen', () => {
    const { lines: out } = splitWordAt([line(['지금', 0, .5], ['윈도우', .5, 1])], { lineIndex: 0, wordIndex: 1 }, .75)
    expect(subtitleWordPiecesForExport(out[0]!.words)).toEqual([{ start: 0, end: .5, text: '지금' }, { start: .5, end: 1, text: '윈도우' }])
    const leftDeleted = out[0]!.words!.map((w, i) => i === 1 ? { ...w, isDeleted: true } : w)
    expect(displayTextFromSubtitleWords(leftDeleted)).toBe('지금 우')
    const round = sentenceTokenTimelineToSubtitleLines(subtitleLinesToSentenceTokenTimeline(out))
    expect(round[0]!.words![2]!.joinPrev).toBe(true)
    expect(round[0]!.text).toBe('지금 윈도우')
  })
  it('finds the edited chip again by ID, or by time after the ID disappeared (undo of a split)', () => {
    const lines = [line(['지금', 0, .5], ['윈도우', .5, 1])]
    const { lines: out, leftId } = splitWordAt(lines, { lineIndex: 0, wordIndex: 1 }, .75)
    expect(resolveTimingWord(out, { id: leftId, start: .5, end: .75 })).toEqual({ lineIndex: 0, wordIndex: 1 })
    expect(resolveTimingWord(lines, { id: leftId, start: .5, end: .75 })).toEqual({ lineIndex: 0, wordIndex: 1 })
    expect(resolveTimingWord(lines, { id: 'gone', start: 5, end: 6 })).toBeNull()
  })
})
