import { describe, expect, it } from 'vitest'
import {
  activeWordCharRange,
  addCaptionEmphasis,
  captionEmphasisOverlaps,
  captionEmphasisSegments,
  captionEmphasisText,
  emphasisColorByWordIndex,
  emphasisRangesByWordIndex,
  emphasisRenderPieces,
  mapEmphasisThroughTextEdit,
  parseCaptionEmphasis,
  reconcileCaptionEmphasis,
  removeCaptionEmphasis,
  resolveCaptionEmphasis,
  withCaptionEmphasis,
  withUserCaptionEmphasis,
  type CaptionEmphasis
} from './captionEmphasis'
import { editSubtitleText } from './editSubtitleText'
import { subtitleLinesMeaningfullyChanged } from './subtitleEditHistory'
import { sentenceTokenTimelineToSubtitleLines, subtitleLinesToSentenceTokenTimeline } from './sentenceTokenTimelineAdapter'
import { parseAutosubProjectFile } from './autosubProject'
import { buildExportCueLines } from './exportCuePipeline'
import { buildRenderSchedule } from './exportRenderSchedule'
import type { SubtitleLine, SubtitleWord } from './subtitles'
import { mergeSubtitleIntoPrevious, splitSubtitleAtWordBoundary } from '../renderer/src/subtitleEditOps'

const projectFixture = () => ({
  format: 'autosubtitle-project', version: 2, savedAt: '2026-11-04T00:00:00Z', videoPath: 'C:/video.mp4',
  mediaFingerprint: null, cutRanges: [],
  subtitleStyle: { fontFamily: 'Arial', fontSize: 32, textColor: '#ffffff', fontWeight: 700,
    bgColor: '#000000', bgOpacity: 60, bgPaddingPct: 100, strokeColor: '#000000', strokeWidth: 2,
    x: 50, y: 10, wordHighlightEnabled: true, wordHighlightColor: '#123abc' },
  subtitles: [{ start: 0, end: 1, text: '일', words: [{ id: 'one', start: 0, end: 1, word: '일' }] }]
})

const em = (text: string, start: number, piece: string, color?: string): CaptionEmphasis => {
  expect(text.slice(start, start + piece.length)).toBe(piece)
  return color ? { start, end: start + piece.length, text: piece, color } : { start, end: start + piece.length, text: piece }
}

function lineOf(words: string[], t0 = 0): SubtitleLine {
  const ws: SubtitleWord[] = words.map((word, i) => ({ id: `w-${t0}-${i}`, start: t0 + i, end: t0 + i + 0.9, word }))
  return { start: t0, end: t0 + words.length, text: words.join(' '), words: ws }
}

const emphasized = (line: SubtitleLine) =>
  resolveCaptionEmphasis(captionEmphasisText(line), line.emphasis).map(r => [r.text, r.color ?? null])

describe('caption emphasis ranges', () => {
  it('adds a dragged selection, trims surrounding spaces and keeps per-range colors', () => {
    const text = 'AI 기능은 로그인 이후 사용이'
    let ranges = addCaptionEmphasis(text, undefined, 5, 0)
    expect(ranges).toEqual([em(text, 0, 'AI 기능')])
    // 앞뒤 공백은 강조에서 뺀다
    ranges = addCaptionEmphasis(text, ranges, 6, 11, '#DC2626')
    expect(ranges).toEqual([em(text, 0, 'AI 기능'), em(text, 7, '로그인', '#DC2626')])
    // 공백만 고르면 바뀌지 않는다
    expect(addCaptionEmphasis(text, ranges, 6, 7)).toEqual(ranges)
  })

  it('re-emphasizing inside an existing range replaces only the overlapped part', () => {
    const text = '무료 OCR 사이트를'
    const base = addCaptionEmphasis(text, undefined, 0, 6)
    const next = addCaptionEmphasis(text, base, 3, 6, '#059669')
    expect(next).toEqual([em(text, 0, '무료'), em(text, 3, 'OCR', '#059669')])
  })

  it('removes the selected part, or the whole range under a bare caret', () => {
    const text = '무료 OCR 사이트를'
    const base = addCaptionEmphasis(text, undefined, 0, 6)
    expect(removeCaptionEmphasis(text, base, 3, 6)).toEqual([em(text, 0, '무료')])
    expect(removeCaptionEmphasis(text, base, 4, 4)).toEqual([])
    expect(captionEmphasisOverlaps(text, base, 4, 4)).toBe(true)
    expect(captionEmphasisOverlaps(text, base, 7, 10)).toBe(false)
  })

  it('relocates stale offsets by their text and drops ranges whose text is gone', () => {
    expect(resolveCaptionEmphasis('  무료 OCR', [{ start: 0, end: 2, text: '무료' }])).toEqual([{ start: 2, end: 4, text: '무료' }])
    expect(resolveCaptionEmphasis('유료 OCR', [{ start: 0, end: 2, text: '무료' }])).toEqual([])
  })

  it('splits text into plain and chip segments that join back to the original', () => {
    const text = '무료 OCR 사이트를'
    const segs = captionEmphasisSegments(text, [em(text, 0, '무료'), em(text, 3, 'OCR', '#DC2626')], '#4F46E5')
    expect(segs.map(s => [s.text, s.color])).toEqual([['무료', '#4F46E5'], [' ', null], ['OCR', '#DC2626'], [' 사이트를', null]])
    expect(segs.map(s => s.text).join('')).toBe(text)
  })

  it('parses saved ranges defensively', () => {
    expect(parseCaptionEmphasis([{ start: 0, end: 2, text: '무료', color: '#123ABC' }, { start: 2, end: 1, text: 'x' },
      { start: 0, end: 3, text: '무료' }, { start: 0, end: 2, text: '무료', color: 'red' }, null])).toEqual([
      { start: 0, end: 2, text: '무료', color: '#123ABC' }, { start: 0, end: 2, text: '무료' }])
    expect(parseCaptionEmphasis([])).toBeUndefined()
    expect(parseCaptionEmphasis('x')).toBeUndefined()
  })
})

describe('emphasis through text edits', () => {
  const text = 'AI 기능은 로그인'
  const ranges = [em(text, 0, 'AI 기능')]
  it('shifts on insertion before, keeps on insertion after, grows on insertion inside', () => {
    expect(mapEmphasisThroughTextEdit(text, `새 ${text}`, ranges)[0]).toMatchObject({ start: 2, end: 7, text: 'AI 기능' })
    expect(mapEmphasisThroughTextEdit(text, `${text}!`, ranges)[0]).toBe(ranges[0])
    expect(mapEmphasisThroughTextEdit(text, 'AI 신기능은 로그인', ranges)[0]).toMatchObject({ start: 0, end: 6, text: 'AI 신기능' })
    // 강조 바로 뒤에 붙여 쓴 글자는 강조에 들어가지 않는다
    expect(mapEmphasisThroughTextEdit(text, 'AI 기능들은 로그인', ranges)[0]).toMatchObject({ text: 'AI 기능' })
  })
  it('shrinks or drops when emphasized characters are deleted', () => {
    expect(mapEmphasisThroughTextEdit(text, 'AI은 로그인', ranges)[0]).toMatchObject({ text: 'AI' })
    expect(mapEmphasisThroughTextEdit(text, '은 로그인', ranges)[0]).toBeNull()
  })
})

describe('reconcileCaptionEmphasis', () => {
  it('returns the same array when nothing has emphasis or nothing changed', () => {
    const lines = [lineOf(['가', '나'])]
    const next = [editSubtitleText(lines[0]!, '가 나 다')]
    expect(reconcileCaptionEmphasis(lines, next)).toBe(next)
    expect(reconcileCaptionEmphasis(lines, lines)).toBe(lines)
  })

  it('follows typing in the edit box and leaves other rows untouched', () => {
    const a = lineOf(['무료', 'OCR', '사이트를'])
    const b = withCaptionEmphasis(lineOf(['AI', '기능은'], 10), [{ start: 0, end: 5, text: 'AI 기능' }])
    const prev = [a, b]
    const typed = [a, editSubtitleText(b, '새 AI 기능은')]
    const out = reconcileCaptionEmphasis(prev, typed)
    expect(out[0]).toBe(a)
    expect(out[1]!.emphasis).toEqual([{ start: 2, end: 7, text: 'AI 기능' }])
  })

  it('moves emphasis into both rows when a row is split at a word', () => {
    const line = withCaptionEmphasis(lineOf(['무료', 'OCR', '사이트를', '찾아서']), [
      { start: 0, end: 2, text: '무료' }, { start: 7, end: 11, text: '사이트를', color: '#DC2626' }
    ])
    const prev = [line]
    const next = splitSubtitleAtWordBoundary(prev, 0, 2)
    expect(next).toHaveLength(2)
    const out = reconcileCaptionEmphasis(prev, next)
    expect(emphasized(out[0]!)).toEqual([['무료', null]])
    expect(emphasized(out[1]!)).toEqual([['사이트를', '#DC2626']])
  })

  it('splits one range across rows and joins ranges back when rows are merged', () => {
    const line = withCaptionEmphasis(lineOf(['무료', 'OCR', '사이트를']), [{ start: 0, end: 6, text: '무료 OCR' }])
    const split = reconcileCaptionEmphasis([line], splitSubtitleAtWordBoundary([line], 0, 1))
    expect(emphasized(split[0]!)).toEqual([['무료', null]])
    expect(emphasized(split[1]!)).toEqual([['OCR', null]])
    const merged = mergeSubtitleIntoPrevious(split, 1)!
    const out = reconcileCaptionEmphasis(split, merged)
    expect(out).toHaveLength(1)
    expect(emphasized(out[0]!)).toEqual([['무료', null], ['OCR', null]])
  })

  it('keeps emphasis of an edited caption through merge into the previous row', () => {
    const up = lineOf(['안녕하세요'])
    const cur = withCaptionEmphasis(editSubtitleText(lineOf(['AI', '기능'], 5), 'AI 기능은'), [{ start: 0, end: 5, text: 'AI 기능' }])
    const prev = [up, cur]
    const out = reconcileCaptionEmphasis(prev, mergeSubtitleIntoPrevious(prev, 1)!)
    expect(captionEmphasisText(out[0]!)).toBe('안녕하세요 AI 기능은')
    expect(emphasized(out[0]!)).toEqual([['AI 기능', null]])
  })

  it('moves an orphaned range to the neighbouring row it was joined into (same row count)', () => {
    const up = lineOf(['안녕하세요'])
    const cur = withCaptionEmphasis(lineOf(['무료'], 5), [{ start: 0, end: 2, text: '무료' }])
    const prev = [up, cur]
    const next: SubtitleLine[] = [editSubtitleText(up, '안녕하세요 무료'), { ...cur, text: '', captionText: '', isDeleted: true }]
    const out = reconcileCaptionEmphasis(prev, next)
    expect(emphasized(out[0]!)).toEqual([['무료', null]])
    expect(out[1]!.emphasis).toBeUndefined()
  })

  it('does not bring back a range the user removed from the menu', () => {
    const line = withCaptionEmphasis(lineOf(['무료', 'OCR']), [{ start: 0, end: 2, text: '무료' }])
    const removed = withUserCaptionEmphasis(line, [])
    expect(reconcileCaptionEmphasis([line], [removed])[0]!.emphasis).toBeUndefined()
    const recolored = withUserCaptionEmphasis(line, [{ start: 0, end: 2, text: '무료', color: '#059669' }])
    expect(reconcileCaptionEmphasis([line], [recolored])[0]!.emphasis).toEqual([{ start: 0, end: 2, text: '무료', color: '#059669' }])
  })

  it('keeps emphasis when only word timings change (realign, edge drag)', () => {
    const line = withCaptionEmphasis(lineOf(['무료', 'OCR']), [{ start: 3, end: 6, text: 'OCR' }])
    const retimed = { ...line, words: line.words!.map(w => ({ ...w, start: w.start + 0.05 })) }
    expect(reconcileCaptionEmphasis([line], [retimed])[0]!.emphasis).toEqual(line.emphasis)
  })
})

describe('emphasis storage round trips', () => {
  it('survives the sentence token timeline adapter', () => {
    const line = withCaptionEmphasis(lineOf(['무료', 'OCR']), [{ start: 0, end: 2, text: '무료', color: '#DC2626' }])
    const plain = withCaptionEmphasis({ start: 0, end: 1, text: '단어 없음' }, [{ start: 3, end: 5, text: '없음' }])
    const back = sentenceTokenTimelineToSubtitleLines(subtitleLinesToSentenceTokenTimeline([line, plain]))
    expect(back[0]!.emphasis).toEqual(line.emphasis)
    expect(back[1]!.emphasis).toEqual(plain.emphasis)
    // 새 객체로 다시 만든 줄도(캐시 없이) 보존된다
    const rebuilt = sentenceTokenTimelineToSubtitleLines(
      JSON.parse(JSON.stringify(subtitleLinesToSentenceTokenTimeline([line]))))
    expect(rebuilt[0]!.emphasis).toEqual(line.emphasis)
  })

  it('counts as an undoable change', () => {
    const line = lineOf(['무료', 'OCR'])
    const next = withCaptionEmphasis(line, [{ start: 0, end: 2, text: '무료' }])
    expect(subtitleLinesMeaningfullyChanged([next], [line])).toBe(true)
    expect(subtitleLinesMeaningfullyChanged([{ ...next }], [next])).toBe(false)
  })

  it('round trips through the project file with emphasis color and capsule style', () => {
    const fixture = projectFixture()
    const raw = {
      ...fixture,
      subtitleStyle: { ...fixture.subtitleStyle, emphasisColor: '#4F46E5', boxStyle: 'capsule' },
      subtitles: [{ start: 0, end: 2, text: '일 초', emphasis: [{ start: 0, end: 1, text: '일', color: '#DC2626' }],
        words: [{ id: 'a', start: 0, end: 1, word: '일' }, { id: 'b', start: 1, end: 2, word: '초' }] }]
    }
    const parsed = parseAutosubProjectFile(raw)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.data.subtitles[0]!.emphasis).toEqual([{ start: 0, end: 1, text: '일', color: '#DC2626' }])
    expect(parsed.data.subtitleStyle.emphasisColor).toBe('#4F46E5')
    expect(parsed.data.subtitleStyle.boxStyle).toBe('capsule')
    const old = parseAutosubProjectFile(projectFixture())
    expect(old.ok && old.data.subtitleStyle.boxStyle).toBeUndefined()
    expect(old.ok && old.data.subtitleStyle.emphasisColor).toBeUndefined()
  })
})

describe('emphasis in video export', () => {
  const line = withCaptionEmphasis(lineOf(['무료', 'OCR', '사이트를']), [{ start: 0, end: 6, text: '무료 OCR', color: '#DC2626' }])

  it('is carried only when requested and keeps file exports unchanged', () => {
    expect(buildExportCueLines([line])[0]).not.toHaveProperty('emphasis')
    expect(buildExportCueLines([line], { includeWords: true })[0]).not.toHaveProperty('emphasis')
    const [cue] = buildExportCueLines([line], { includeEmphasis: true })
    expect(cue!.emphasis).toEqual([{ start: 0, end: 6, text: '무료 OCR', color: '#DC2626' }])
    const [withWords] = buildExportCueLines([line], { includeEmphasis: true, includeWords: true })
    expect(withWords!.words?.map(w => w.text)).toEqual(['무료', 'OCR', '사이트를'])
    expect(withWords!.emphasis).toEqual(cue!.emphasis)
  })

  it('reaches every render state of the cue', () => {
    const cues = buildExportCueLines([line], { includeEmphasis: true, includeWords: true })
    const states = buildRenderSchedule({ cues, clips: [{ sourceStart: 0, sourceEnd: 10, programStart: 0 }] as never, fps: 30, highlightWords: true })
    expect(states.length).toBeGreaterThan(1)
    for (const s of states) expect(s.emphasis).toEqual(cues[0]!.emphasis)
    const plain = buildRenderSchedule({ cues: buildExportCueLines([line]), clips: [{ sourceStart: 0, sourceEnd: 10, programStart: 0 }] as never, fps: 30, highlightWords: false })
    for (const s of plain) expect(s).not.toHaveProperty('emphasis')
  })

  it('splits chips around the spoken word for highlight rendering', () => {
    const text = '무료 OCR 사이트를'
    const active = activeWordCharRange(['무료', 'OCR', '사이트를'], 1)
    expect(active).toEqual([3, 6])
    const pieces = emphasisRenderPieces(text, [em(text, 0, '무료 OCR')], '#4F46E5', active)
    expect(pieces).toEqual([
      { color: '#4F46E5', parts: [{ text: '무료 ', active: false }, { text: 'OCR', active: true }] },
      { color: null, parts: [{ text: ' 사이트를', active: false }] }
    ])
    expect(pieces.flatMap(p => p.parts.map(x => x.text)).join('')).toBe(text)
  })
})

describe('emphasisColorByWordIndex', () => {
  it('marks chips whose characters are emphasized', () => {
    const line = withCaptionEmphasis(lineOf(['AI', '기능은', '로그인']), [{ start: 0, end: 5, text: 'AI 기능', color: '#DC2626' }])
    expect([...emphasisColorByWordIndex(line, '#4F46E5')]).toEqual([[0, '#DC2626'], [1, '#DC2626']])
  })
  it('gives the ranges under a chip so a chip right-click can remove exactly that emphasis', () => {
    const line = withCaptionEmphasis(lineOf(['무료', 'OCR', '사이트를']), [
      { start: 0, end: 6, text: '무료 OCR' }, { start: 7, end: 11, text: '사이트를', color: '#DC2626' }])
    const byWord = emphasisRangesByWordIndex(line)
    expect(byWord.get(1)).toEqual([{ start: 0, end: 6, text: '무료 OCR' }])
    const hits = byWord.get(1)!
    const text = captionEmphasisText(line)
    const left = removeCaptionEmphasis(text, line.emphasis, Math.min(...hits.map(r => r.start)), Math.max(...hits.map(r => r.end)))
    expect(left).toEqual([{ start: 7, end: 11, text: '사이트를', color: '#DC2626' }])
  })
  it('falls back to text matching for an edited caption', () => {
    const base = editSubtitleText(lineOf(['에이아이', '기능은']), 'AI 기능은')
    const line = withCaptionEmphasis(base, [{ start: 3, end: 5, text: '기능' }])
    expect([...emphasisColorByWordIndex(line, '#4F46E5')]).toEqual([[1, '#4F46E5']])
  })
})
