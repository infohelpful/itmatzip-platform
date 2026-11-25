import { describe, expect, it } from 'vitest'
import { buildMediaComposition, compositionPositionAt, compositionSourceClips, insertCaptionCues, insertionGroups, overlaySourceRanges,
  parseMediaEdits, pruneMediaAssets, sourceBoundaryToProgram, type MediaEdits } from './mediaComposition'
import { buildRenderSchedule } from './exportRenderSchedule'
import { mapSourceIntervalToProgram } from './clipPlan'
import type { SubtitleLine } from './subtitles'

const lines: SubtitleLine[] = [{ start: 0, end: 10, text: '앞 뒤', words: [
  { id: 'first', start: 0, end: 2, word: '앞' }, { id: 'second', start: 2, end: 10, word: '뒤' }
] }]
const fixture = (): MediaEdits => ({ version: 1,
  assets: [{ id: 'photo', kind: 'image', name: '사진', path: 'C:/photo.png' },
    { id: 'movie', kind: 'video', name: '삽입 영상', path: 'C:/movie.mp4', duration: 8 }],
  insertions: [{ id: 'intro', assetId: 'photo', at: { sourceTime: 2, wordId: 'first', edge: 'end' },
    duration: 3, sourceStart: 0, fit: 'contain', muted: true },
  { id: 'video', assetId: 'movie', at: { sourceTime: 2 }, duration: 2, sourceStart: 1, fit: 'cover', muted: false }],
  overlays: [{ id: 'cover', assetId: 'photo', start: { sourceTime: 1 }, end: { sourceTime: 4 }, fit: 'cover' }]
})

describe('media composition', () => {
  it('inserts image silence and the inserted video before resuming the SAME original source position', () => {
    const before = JSON.stringify(lines)
    const plan = buildMediaComposition(10, [], lines, fixture())
    expect(plan.duration).toBe(15)
    expect(plan.clips.map(c => [c.kind, c.programStart, c.duration])).toEqual([
      ['source', 0, 2], ['image', 2, 3], ['video', 5, 2], ['source', 7, 8]
    ])
    expect(compositionPositionAt(plan, 2)).toMatchObject({ originalSourceTime: null, assetTime: null })
    expect(compositionPositionAt(plan, 6)).toMatchObject({ originalSourceTime: null, assetTime: 2 })
    expect(compositionPositionAt(plan, 7)).toMatchObject({ originalSourceTime: 2, assetTime: null })
    expect(compositionPositionAt(plan, 15)).toMatchObject({ originalSourceTime: 10 })
    expect(JSON.stringify(lines)).toBe(before)
  })
  it('distinguishes seeking before and after a group inserted at a word boundary', () => {
    const plan = buildMediaComposition(10, [], lines, fixture())
    expect(sourceBoundaryToProgram(plan, 2, 'before')).toBe(2)
    expect(sourceBoundaryToProgram(plan, 2, 'after')).toBe(7)
    expect(sourceBoundaryToProgram(plan, 3)).toBe(8)
  })
  it('splits overlays around insertions and removes deleted source time from their range', () => {
    const plan = buildMediaComposition(10, [{ start: 3, end: 4 }], lines, fixture())
    expect(plan.duration).toBe(14)
    expect(plan.overlays.map(o => [o.start, o.end])).toEqual([[1, 2], [7, 8]])
    expect(plan.clips.at(-1)).toMatchObject({ sourceStart: 4, programStart: 8 })
  })
  it('never displays original captions in inserted media, including a cue spanning the insertion', () => {
    const plan = buildMediaComposition(10, [], lines, fixture())
    const clips = compositionSourceClips(plan)
    const schedule = buildRenderSchedule({ cues: [{ start: 0, end: 10, text: '원본 자막' }],
      clips, fps: 30, highlightWords: false })
    expect(schedule.map(s => [s.startFrame, s.endFrame])).toEqual([[0, 60], [210, 450]])
    expect(mapSourceIntervalToProgram(2, 4, clips)).toMatchObject([{ start: 7, end: 9 }])
  })
  it('keeps independent insertions when their anchor is inside a source deletion', () => {
    const plan = buildMediaComposition(10, [{ start: 1, end: 4 }], lines, fixture())
    expect(plan.clips.map(c => [c.kind, c.programStart, c.duration])).toEqual([
      ['source', 0, 1], ['image', 1, 3], ['video', 4, 2], ['source', 6, 6]
    ])
  })
  it('supports insertions at the beginning/end and a completely cut original', () => {
    const edits = fixture()
    edits.insertions[0].at = { sourceTime: 0 }
    edits.insertions[1].at = { sourceTime: 10 }
    expect(buildMediaComposition(10, [], [], edits).clips.map(c => c.kind)).toEqual(['image', 'source', 'video'])
    const plan = buildMediaComposition(10, [{ start: 0, end: 10 }], [], edits)
    expect(plan.duration).toBe(5)
    expect(compositionSourceClips(plan)).toEqual([])
    expect(plan.overlays).toEqual([])
  })
  it('follows an edited word edge and uses its saved source boundary if the ID disappears', () => {
    const edits = fixture()
    edits.insertions = [edits.insertions[0]]
    const moved = [{ ...lines[0], words: [{ id: 'first', word: '앞', start: 0, end: 4 }] }]
    expect(buildMediaComposition(10, [], moved, edits).clips[1].programStart).toBe(4)
    expect(buildMediaComposition(10, [], [], edits).clips[1].programStart).toBe(2)
  })
  it('round trips edit data without losing asset references or anchors', () => {
    const original = fixture()
    expect(parseMediaEdits(JSON.parse(JSON.stringify(original)))).toEqual(original)
  })
  it('namespaces derived overlay IDs separately from source clips', () => {
    const edits = fixture()
    edits.overlays[0].id = 'source'
    const plan = buildMediaComposition(10, [], [], edits)
    const ids = [...plan.clips, ...plan.overlays].map(item => item.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('keeps an anchored outside edge after its word is split and retimed', () => {
    const edits = fixture()
    edits.insertions = [edits.insertions[0]]
    const split = [{ start: 0, end: 4, text: '나눈 단어', words: [
      { id: 'first~1', start: 0, end: 1, word: '나' },
      { id: 'first~2~1', start: 1, end: 3, word: '눈' },
      { id: 'first~2~2', start: 3, end: 4, word: '단어' }
    ] }]
    expect(buildMediaComposition(10, [], split, edits).clips[1].programStart).toBe(4)
  })
  it('rejects missing assets, duplicates, bad durations and out-of-source video trims', () => {
    const cases = [
      (e: MediaEdits) => { e.insertions[0].assetId = 'missing' },
      (e: MediaEdits) => { e.insertions[1].id = e.insertions[0].id },
      (e: MediaEdits) => { e.insertions[0].duration = NaN },
      (e: MediaEdits) => { e.insertions[1].sourceStart = 7 },
      (e: MediaEdits) => { e.insertions[0].at = { sourceTime: 2, wordId: 'first' } },
      (e: MediaEdits) => { e.overlays[0].assetId = 'movie' }
    ]
    for (const mutate of cases) { const e = fixture(); mutate(e); expect(() => parseMediaEdits(e)).toThrow() }
  })
})

describe('preview helpers', () => {
  it('groups back-to-back inserted clips with where the original stops and resumes', () => {
    const plan = buildMediaComposition(10, [{ start: 2, end: 3 }], lines, fixture())
    const groups = insertionGroups(plan)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ programStart: 2, duration: 5, stopSource: 2, resumeSource: 3 })
    expect(groups[0]!.clips.map(c => c.kind)).toEqual(['image', 'video'])
  })
  it('a leading group stops at 0 and a trailing group has nothing to resume', () => {
    const edits = fixture()
    edits.insertions = [
      { ...edits.insertions[0]!, id: 'lead', at: { sourceTime: 0 } },
      { ...edits.insertions[0]!, id: 'tail', at: { sourceTime: 10 } }
    ]
    const groups = insertionGroups(buildMediaComposition(10, [], lines, edits))
    expect(groups.map(g => [g.programStart, g.stopSource, g.resumeSource])).toEqual([[0, 0, 0], [13, 10, null]])
  })
  it('gives overlays in original time and drops unused files', () => {
    expect(overlaySourceRanges(fixture(), lines, 10)).toEqual([{ id: 'cover', assetId: 'photo', start: 1, end: 4, fit: 'cover' }])
    const edits = { ...fixture(), insertions: [], overlays: [] }
    expect(pruneMediaAssets(edits).assets).toEqual([])
    const kept = fixture()
    expect(pruneMediaAssets(kept)).toBe(kept)
  })
})

describe('captions on inserted clips', () => {
  it('are kept through parsing and become cues in finished-video time', () => {
    const edits = fixture()
    edits.insertions[0] = { ...edits.insertions[0]!, caption: '  인트로 화면  ' }
    expect(parseMediaEdits(edits).insertions[0]!.caption).toBe('  인트로 화면  ')
    const plan = buildMediaComposition(10, [], lines, edits)
    expect(insertCaptionCues(plan)).toEqual([{ start: 2, end: 5, text: '인트로 화면' }])
  })
  it('a blank caption is dropped and an oversized one is refused', () => {
    const edits = fixture()
    edits.insertions[0] = { ...edits.insertions[0]!, caption: '   ' }
    expect(parseMediaEdits(edits).insertions[0]!.caption).toBeUndefined()
    edits.insertions[0] = { ...edits.insertions[0]!, caption: 'x'.repeat(2001) }
    expect(() => parseMediaEdits(edits)).toThrow()
  })
})
