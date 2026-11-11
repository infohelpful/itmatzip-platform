import { describe, expect, it } from 'vitest'
import type { SubtitleLine } from './subtitles'
import { subtitleCueLinesForExport } from './subtitles'
import {
  applySubtitleDisplayTimingEdit,
  pickDisplayedSubtitleIndex,
  subtitleAutoDisplayBounds,
  subtitleDisplayBounds,
  subtitleDisplaySpans
} from './subtitleDisplayTiming'
import { subtitlePresentationSpans } from './subtitlePresentation'
import { subtitlePreviewText } from './subtitleVisibility'
import { buildExportCueLines } from './exportCuePipeline'
import { pickActiveEditorRow } from './editorPlayback'
import { sentenceTokenTimelineToSubtitleLines, subtitleLinesToSentenceTokenTimeline } from './sentenceTokenTimelineAdapter'
import { subtitleLinesMeaningfullyChanged } from './subtitleEditHistory'
import { parseAutosubProjectFile, AUTOSUB_FILE_FORMAT, AUTOSUB_VERSION } from './autosubProject'
import { playbackIntervalsFromSubtitleLines } from './playbackIntervals'

/** 0~2초 말 + 2~6초 인트로(자막 없는 오디오, 앞 줄에 붙음) + 6~8초 다음 말 */
function introProject(): SubtitleLine[] {
  return [
    {
      start: 0, end: 6, text: '안녕하세요 여러분',
      words: [
        { id: 'w1', start: 0, end: 1, word: '안녕하세요' },
        { id: 'w2', start: 1, end: 2, word: '여러분' },
        { start: 2, end: 6, word: '오디오', isSilence: true, gapKind: 'unclassified' }
      ]
    },
    {
      start: 6, end: 8, text: '본론입니다',
      words: [{ id: 'w3', start: 6, end: 8, word: '본론입니다' }]
    }
  ]
}

describe('subtitle display timing', () => {
  it('is an exact no-op when no line is adjusted', () => {
    const lines = introProject()
    expect(subtitleDisplaySpans(lines)).toBe(subtitlePresentationSpans(lines))
    expect(subtitleDisplayBounds(lines, 0)).toEqual(subtitleAutoDisplayBounds(lines, 0))
    // 인트로 동안 앞 자막이 계속 보이는 기존 동작
    expect(subtitlePreviewText(lines, 4)).toBe('안녕하세요 여러분')
  })

  it('ends the caption before the intro without touching words, audio or the editor row', () => {
    const lines = introProject()
    const edited = applySubtitleDisplayTimingEdit(lines, 0, { kind: 'set', edge: 'end', sec: 2.2 })
    expect(edited[0]!.words).toBe(lines[0]!.words)
    expect(edited[0]!.start).toBe(0)
    expect(edited[0]!.end).toBe(6)
    expect(edited[1]).toBe(lines[1])
    expect(edited[0]!.displayEndAdj).toBeCloseTo(-3.8)

    expect(subtitlePreviewText(edited, 1.5)).toBe('안녕하세요 여러분')
    expect(subtitlePreviewText(edited, 2.5)).toBe('')
    expect(subtitlePreviewText(edited, 5.9)).toBe('')
    expect(subtitlePreviewText(edited, 6.5)).toBe('본론입니다')

    const cues = subtitleCueLinesForExport(edited)
    expect(cues.map(c => [c.start, +c.end.toFixed(3), c.text])).toEqual([[0, 2.2, '안녕하세요 여러분'], [6, 8, '본론입니다']])
    const burn = buildExportCueLines(edited, { includeWords: true })
    expect(burn[0]!.end).toBeCloseTo(2.2)
    // 단어 강조 조각은 그대로 유효(끝 > 시작)
    for (const w of burn[0]!.words ?? []) expect(w.end).toBeGreaterThan(w.start)

    // 소리·재생 구간과 편집 화면 줄 선택은 바뀌지 않는다
    expect(playbackIntervalsFromSubtitleLines(edited)).toEqual(playbackIntervalsFromSubtitleLines(lines))
    expect(pickActiveEditorRow(edited, 4)).toBe(pickActiveEditorRow(lines, 4))
    expect(subtitleAutoDisplayBounds(edited, 0)).toEqual(subtitleAutoDisplayBounds(lines, 0))
  })

  it('delays a caption start and lets the later caption win overlaps', () => {
    const lines = introProject()
    const delayed = applySubtitleDisplayTimingEdit(lines, 1, { kind: 'nudge', edge: 'start', delta: 0.5 })
    expect(subtitleDisplayBounds(delayed, 1)!.start).toBeCloseTo(6.5)
    expect(subtitlePreviewText(delayed, 6.2)).toBe('')
    const earlier = applySubtitleDisplayTimingEdit(lines, 1, { kind: 'set', edge: 'start', sec: 4 })
    expect(pickDisplayedSubtitleIndex(earlier, 4.5)).toBe(1)
    expect(subtitleDisplayBounds(earlier, 0)!.end).toBeCloseTo(4)
  })

  it('clamps to a minimum visible length and resets to automatic', () => {
    const lines = introProject()
    const squeezed = applySubtitleDisplayTimingEdit(lines, 0, { kind: 'set', edge: 'end', sec: -5 })
    const b = subtitleDisplayBounds(squeezed, 0)!
    expect(b.end - b.start).toBeGreaterThanOrEqual(0.1 - 1e-9)
    const reset = applySubtitleDisplayTimingEdit(squeezed, 0, { kind: 'reset' })
    expect(reset[0]!.displayStartAdj).toBeUndefined()
    expect(reset[0]!.displayEndAdj).toBeUndefined()
    expect(applySubtitleDisplayTimingEdit(reset, 0, { kind: 'reset' })).toBe(reset)
  })

  it('survives the sentence timeline round trip, undo history and project files', () => {
    const edited = applySubtitleDisplayTimingEdit(introProject(), 0, { kind: 'set', edge: 'end', sec: 2.2 })
    const round = sentenceTokenTimelineToSubtitleLines(subtitleLinesToSentenceTokenTimeline(edited))
    expect(round[0]!.displayEndAdj).toBeCloseTo(-3.8)
    expect(subtitleLinesMeaningfullyChanged(edited, introProject())).toBe(true)

    const parsed = parseAutosubProjectFile(JSON.parse(JSON.stringify({
      format: AUTOSUB_FILE_FORMAT, version: AUTOSUB_VERSION, savedAt: 'x', videoPath: null, mediaFingerprint: null,
      cutRanges: [], subtitles: edited,
      subtitleStyle: { fontFamily: 'a', fontSize: 40, textColor: '#fff', fontWeight: 400, bgColor: '#000', bgOpacity: 0,
        bgPaddingPct: 0, strokeColor: '#000', strokeWidth: 0, x: 50, y: 90 }
    })))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.data.subtitles[0]!.displayEndAdj).toBeCloseTo(-3.8)
  })
})
