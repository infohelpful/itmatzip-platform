import { describe, expect, it } from 'vitest'
import type { SubtitleLine } from '../../shared/subtitles'
import { applyAiEditorOps, describeAiOps, parseAiEditorOps, sanitizeStylePatch } from './aiEditorOps'
import { lineDisplayAdjust } from '../../shared/subtitleDisplayTiming'

const line = (i: number, words: string[]): SubtitleLine => ({
  start: i * 2, end: i * 2 + 1.8, text: words.join(' '),
  words: words.map((w, k) => ({ id: `w${i}-${k}`, word: w, start: i * 2 + k * 0.4, end: i * 2 + k * 0.4 + 0.35 })),
})
const lines = [line(0, ['오늘은', '포토크래프트를']), line(1, ['소개해', '드리겠습니다'])]
const ids = lines.flatMap(l => l.words!.map(w => w.id!))

describe('parseAiEditorOps', () => {
  it('keeps only valid values', () => {
    const ops = parseAiEditorOps({
      hide: [1, -1, 'x', 1], emphasisColored: [{ index: 0, color: '#FF0000' }, { index: 1, color: 'red' }],
      displayTiming: [{ index: 2, startAdj: -0.3 }, { index: 3 }], style: { fontSize: 999, textColor: '#ffffff', boxStyle: 'round' },
    })
    expect(ops).toEqual({
      hide: [1], emphasisColored: [{ index: 0, color: '#ff0000' }],
      displayTiming: [{ index: 2, startAdj: -0.3, endAdj: undefined }], style: { fontSize: 200, textColor: '#ffffff' },
    })
    expect(parseAiEditorOps({ corrections: [] })).toBeNull()
    expect(sanitizeStylePatch({ nope: 1 })).toBeNull()
  })
})

describe('applyAiEditorOps', () => {
  it('hides, shows, times, colors and unemphasizes lines by word index', () => {
    const { lines: out, summary } = applyAiEditorOps(lines, ids, {
      hide: [3], emphasisColored: [{ index: 1, color: '#ff0000' }], displayTiming: [{ index: 0, startAdj: -0.5 }],
    })
    expect(out[1]!.isHidden).toBe(true)
    expect(out[0]!.emphasis).toEqual([{ start: 4, end: 11, text: '포토크래프트를', color: '#ff0000' }])
    expect(lineDisplayAdjust(out[0]).start).toBe(-0.5)
    expect(describeAiOps(summary)).toBe('색 강조 1 · 숨김 1줄 · 표시 시간 1줄')

    const back = applyAiEditorOps(out, ids, { show: [2], unemphasize: [1] })
    expect(back.lines[1]!.isHidden).toBeUndefined()
    expect(back.lines[0]!.emphasis).toBeUndefined()
    expect(back.summary.unemphasized).toBe(1)
  })

  it('emphasizes only the named part of a word (no particles)', () => {
    const { lines: out, summary } = applyAiEditorOps(lines, ids, parseAiEditorOps({ emphasisParts: [{ index: 1, text: '포토크래프트' }, { index: 2, text: '없는글자' }] }))
    expect(out[0]!.emphasis).toEqual([{ start: 4, end: 10, text: '포토크래프트' }])
    expect(out[1]!.emphasis).toEqual([{ start: 0, end: 3, text: '소개해' }])
    expect(summary.parts).toBe(2)
  })

  it('soft-deletes words without touching other lines', () => {
    const { lines: out, summary } = applyAiEditorOps(lines, ids, { deleteWords: [2] })
    expect(summary.deleted).toBe(1)
    expect(out[1]!.words!.filter(w => !w.isDeleted).map(w => w.word)).toEqual(['드리겠습니다'])
    expect(out[0]!.words!.every(w => !w.isDeleted)).toBe(true)
  })

  it('reports style changes without editing lines', () => {
    const { lines: out, summary } = applyAiEditorOps(lines, ids, { style: { fontSize: 40, wordHighlight: false } })
    expect(out).toBe(lines)
    expect(describeAiOps(summary)).toBe('서식(글자 크기, 단어 강조)')
  })
})
