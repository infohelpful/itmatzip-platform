import { describe, expect, it } from 'vitest'
import { buildRenderSchedule } from './exportRenderSchedule'
import { buildMediaComposition, compositionSourceClips, type MediaEdits } from './mediaComposition'
import { cuesWithInsertCaptions, withInsertCaptions } from './insertCaptions'
import type { SubtitleLine } from './subtitles'

const lines: SubtitleLine[] = [{ start: 0, end: 10, text: '앞 뒤', words: [
  { id: 'first', start: 0, end: 2, word: '앞' }, { id: 'second', start: 2, end: 10, word: '뒤' }
] }]
const edits: MediaEdits = { version: 1,
  assets: [{ id: 'photo', kind: 'image', name: '사진', path: 'C:/photo.png' }],
  insertions: [{ id: 'intro', assetId: 'photo', at: { sourceTime: 2, wordId: 'first', edge: 'end' },
    duration: 3, sourceStart: 0, fit: 'contain', muted: true, caption: '삽입 자막' }],
  overlays: [] }

describe('captions on inserted clips in the export', () => {
  const plan = buildMediaComposition(10, [], lines, edits)
  it('fill exactly the clip frames between the original captions, in order', () => {
    const source = buildRenderSchedule({ cues: [{ start: 0, end: 10, text: '원본' }], clips: compositionSourceClips(plan), fps: 30, highlightWords: false })
    const merged = withInsertCaptions(source, plan, 30)
    expect(merged.map(s => [s.startFrame, s.endFrame, s.text])).toEqual([[0, 60, '원본'], [60, 150, '삽입 자막'], [150, 390, '원본']])
  })
  it('text exports get the clip caption at its finished-video time', () => {
    expect(cuesWithInsertCaptions([{ start: 0, end: 2, text: '원본' }, { start: 5, end: 13, text: '원본' }], plan))
      .toEqual([{ start: 0, end: 2, text: '원본' }, { start: 2, end: 5, text: '삽입 자막' }, { start: 5, end: 13, text: '원본' }])
  })
  it('without a plan nothing changes', () => {
    expect(withInsertCaptions([], null, 30)).toEqual([])
  })
})
