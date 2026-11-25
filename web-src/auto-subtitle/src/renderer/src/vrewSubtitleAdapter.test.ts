import { describe, expect, it } from 'vitest'
import { mergeVrewRowsIntoSubtitleLines, subtitleLinesToVrewRows } from './vrewSubtitleAdapter'
import { editSubtitleText } from '../../shared/editSubtitleText'
import { subtitleLineEditDisplayText } from '../../shared/subtitles'

describe('mergeVrewRowsIntoSubtitleLines', () => {
  it.each([false, true])('keeps an edited caption after a waveform timing edit (gapFill: %s)', (gapFill) => {
    const source = [{
      start: 0,
      end: 2,
      text: '원래 자막',
      words: [
        { start: 0, end: 1, word: '원래' },
        { start: 1, end: 2, word: '자막' }
      ]
    }]
    const edited = [editSubtitleText(source[0]!, '교정된 문구')]
    const rows = subtitleLinesToVrewRows(edited, { gapFill })
    expect(rows[0]!.lineText).toBe('교정된 문구')
    const dragged = rows.map(row => ({
      ...row,
      words: row.words.map((word, index) => index === 0 ? { ...word, end: 0.8 } : word)
    }))
    const [result] = mergeVrewRowsIntoSubtitleLines(edited, dragged)
    expect(result.text).toBe('교정된 문구')
    expect(result.captionText).toBe('교정된 문구')
    expect(subtitleLineEditDisplayText(result)).toBe('교정된 문구')
    expect(result.words?.map(word => word.word)).toEqual(['원래', '자막'])
  })

  it('preserves isDeleted tombstones when Peaks edits visible words only', () => {
    const prev = [
      {
        start: 0,
        end: 3,
        text: 'b',
        words: [
          { start: 0, end: 1, word: 'a', isDeleted: true },
          { start: 1, end: 2, word: 'b' },
          { start: 2, end: 3, word: 'c', isDeleted: true }
        ]
      }
    ]
    const rows = subtitleLinesToVrewRows(prev, { gapFill: false })
    const bumped = rows.map((r) => ({
      ...r,
      words: r.words.map((w) => ({ ...w, start: w.start + 0.5, end: w.end + 0.5 }))
    }))
    const merged = mergeVrewRowsIntoSubtitleLines(prev, bumped)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.words!.length).toBe(3)
    expect(merged[0]!.words![0]!.isDeleted).toBe(true)
    expect(merged[0]!.words![1]!.start).toBeCloseTo(1.5, 4)
    expect(merged[0]!.words![2]!.isDeleted).toBe(true)
  })

  it('falls back to full conversion when line count differs', () => {
    const prev = [
      {
        start: 0,
        end: 1,
        text: 'a',
        words: [{ start: 0, end: 1, word: 'a', isDeleted: true }]
      }
    ]
    const rows = subtitleLinesToVrewRows(
      [
        { start: 0, end: 0.5, text: 'x', words: [{ start: 0, end: 0.5, word: 'x' }] },
        { start: 0.5, end: 1, text: 'y', words: [{ start: 0.5, end: 1, word: 'y' }] }
      ],
      { gapFill: false }
    )
    const merged = mergeVrewRowsIntoSubtitleLines(prev, rows)
    expect(merged.length).toBe(2)
    expect(merged[0]!.words?.some((w) => w.isDeleted)).not.toBe(true)
  })
})

describe('alignment metadata through Peaks edits', () => {
  const aligned = {
    start: 1,
    end: 2,
    word: '안녕',
    id: 'seg-0:word:0',
    alignmentStatus: 'aligned' as const,
    alignmentScore: 0.9,
    sourceStart: 1,
    sourceEnd: 2
  }
  const prev = [{ start: 1, end: 3, text: '안녕 하세요', words: [aligned, { start: 2, end: 3, word: '하세요' }] }]

  it('keeps ids and aligned status when rows come back unchanged', () => {
    const rows = subtitleLinesToVrewRows(prev, { gapFill: false })
    const merged = mergeVrewRowsIntoSubtitleLines(prev, rows)
    expect(merged[0]!.words![0]).toMatchObject({ id: 'seg-0:word:0', alignmentStatus: 'aligned', sourceEnd: 2 })
    expect(merged[0]!.words![0]!.manualStartLocked).toBeUndefined()
  })

  it('locks a dragged edge as manual and keeps the engine estimate', () => {
    const rows = subtitleLinesToVrewRows(prev, { gapFill: false })
    const edited = rows.map((r) => ({
      ...r,
      words: r.words.map((w, i) => (i === 0 ? { ...w, end: 2.25 } : w))
    }))
    const merged = mergeVrewRowsIntoSubtitleLines(prev, edited)
    expect(merged[0]!.words![0]).toMatchObject({
      alignmentStatus: 'manual',
      manualEndLocked: true,
      end: 2.25,
      sourceEnd: 2
    })
  })

  it('marks an aligned word stale when its text changes', () => {
    const rows = subtitleLinesToVrewRows(prev, { gapFill: false })
    const edited = rows.map((r) => ({
      ...r,
      words: r.words.map((w, i) => (i === 0 ? { ...w, text: '안녕하' } : w))
    }))
    const merged = mergeVrewRowsIntoSubtitleLines(prev, edited)
    expect(merged[0]!.words![0]).toMatchObject({ alignmentStatus: 'stale', word: '안녕하', start: 1, end: 2 })
  })
})
