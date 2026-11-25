import { describe, expect, it } from 'vitest'
import { parseAutosubProjectFile } from './autosubProject'
import { ensureWordIdentities } from './wordIdentity'
import { editSubtitleText } from './editSubtitleText'
import type { SubtitleLine } from './subtitles'

export const projectFixture = () => ({
  format: 'autosubtitle-project', version: 2, savedAt: '2026-10-12T00:00:00Z', videoPath: 'C:/video.mp4',
  mediaFingerprint: { algorithm: 'sha256', size: 8, digest: 'a'.repeat(64) }, cutRanges: [{ start: 3, end: 4 }],
  subtitleStyle: { fontFamily: 'Arial', fontSize: 32, textColor: '#ffffff', fontWeight: 700,
    bgColor: '#000000', bgOpacity: 60, bgPaddingPct: 10, strokeColor: '#000000', strokeWidth: 2,
    x: 50, y: 10, wordHighlightEnabled: true, wordHighlightColor: '#123abc' },
  subtitles: [{ start: 0, end: 2, text: '일 초', words: [
    { id: 'one', start: 0, end: 1, word: '일', alignmentStatus: 'manual', manualStartLocked: true,
      sourceStart: 0.2, sourceEnd: 0.9, rawStart: 0.1, rawEnd: 1.1, alignmentScore: 0.8,
      alignmentText: '일', readingOverride: '일', modelRevision: 'abc', engine: 'whisperx', segmentId: 'seg',
      reviewReasons: ['test'], textSpanMap: [{ displayStart: 0, displayEnd: 1, alignmentStart: 0, alignmentEnd: 1 }],
      charSpans: [{ char: '일', start: 0.2, end: 0.9, score: 0.8, alignmentStart: 0, alignmentEnd: 1 }] },
    { id: 'empty', start: 1, end: 1.5, word: '', alignmentStatus: 'stale' },
    { id: 'deleted', start: 1.5, end: 2, word: '초', isDeleted: true, mergedByEdgeTrim: true, splitChain: '12' }
  ] }, { start: 3, end: 4, text: '', isDeleted: true, words: [
    { start: 3, end: 4, word: '--', isDeleted: true, isSilence: true }
  ] }],
  virtualTimeline: [{ id: 'cut', mediaStartSec: 3, mediaEndSec: 4, text: '', isDeleted: true }]
})

describe('project v2 storage', () => {
  it('preserves manual silence boundary locks through save and reopen without speech alignment status', () => {
    const words = [{ start: 0, end: 1, word: '--', isSilence: true, manualStartLocked: true, manualEndLocked: true }]
    for (const version of [1, 2]) {
      const parsed = parseAutosubProjectFile({ ...projectFixture(), version,
        subtitles: [{ start: 0, end: 1, text: '', words }] })
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) continue
      expect(parsed.data.subtitles[0].words).toEqual(words)
      const reopened = parseAutosubProjectFile(JSON.parse(JSON.stringify(parsed.data)))
      expect(reopened.ok && reopened.data.subtitles[0].words).toEqual(words)
    }
  })
  it('round trips exact text, empty slots, tombstones, split flags, highlight and all alignment metadata', () => {
    const raw = projectFixture()
    const parsed = parseAutosubProjectFile(JSON.parse(JSON.stringify(raw)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.data).toEqual(raw)
    expect(parseAutosubProjectFile(JSON.parse(JSON.stringify(parsed.data)))).toEqual(parsed)
  })
  it('migrates v1 times as estimated without realigning, preserving known extension metadata', () => {
    const raw = { ...projectFixture(), version: 1, mediaFingerprint: undefined,
      subtitles: [{ start: 0, end: 2, text: '예전 자막', words: [
        { start: 0.13, end: 0.81, word: '예전' },
        { id: 'known', start: 1, end: 2, word: '자막', alignmentStatus: 'manual', manualEndLocked: true }
      ] }] }
    const before = JSON.stringify(raw)
    const parsed = parseAutosubProjectFile(raw)
    expect(JSON.stringify(raw)).toBe(before)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.migrated).toBe(true)
    expect(parsed.data.version).toBe(2)
    expect(parsed.data.mediaFingerprint).toBeNull()
    expect(parsed.data.subtitles[0].words![0]).toMatchObject({
      start: 0.13, end: 0.81, rawStart: 0.13, rawEnd: 0.81, alignmentStatus: 'estimated', reviewReasons: ['legacy_project']
    })
    expect(parsed.data.subtitles[0].words![0].id).toBeTruthy()
    expect(parsed.data.subtitles[0].words![1]).toMatchObject({ id: 'known', alignmentStatus: 'manual', manualEndLocked: true })
    const reopened = parseAutosubProjectFile(JSON.parse(JSON.stringify(parsed.data)))
    expect(reopened.ok && reopened.data).toEqual(parsed.data)
  })
  it('rejects malformed data instead of silently dropping saved edits', () => {
    for (const bad of [
      { ...projectFixture(), version: 900 },
      { ...projectFixture(), subtitles: [{ start: 1, end: 0, text: 'bad' }] },
      { ...projectFixture(), mediaFingerprint: { algorithm: 'sha256', size: -1, digest: 'bad' } }
    ]) expect(parseAutosubProjectFile(bad).ok).toBe(false)
  })
  it('retains source slots across erase, save/reopen, retype', () => {
    const raw = projectFixture()
    const edited = editSubtitleText(raw.subtitles[0] as SubtitleLine, '')
    const parsed = parseAutosubProjectFile({ ...raw, subtitles: [edited] })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const restored = editSubtitleText(parsed.data.subtitles[0], '다시 입력')
    expect(restored.words?.map(w => w.id)).toEqual(edited.words?.map(w => w.id))
    expect(restored.words?.map(w => [w.start, w.end])).toEqual(edited.words?.map(w => [w.start, w.end]))
    expect(restored.words?.map(w => w.word)).toEqual(edited.words?.map(w => w.word))
    expect(restored.captionText).toBe('다시 입력')
    expect(parsed.data.subtitles[0].captionText).toBe('')
  })
})

it('keeps IDs through edits/reorder and repairs only duplicate/new speech identities', () => {
  const lines: SubtitleLine[] = [{ start: 0, end: 3, text: '가 나', words: [
    { id: 'a', start: 0, end: 1, word: '가' }, { id: 'a', start: 1, end: 2, word: '나', splitChain: '2' },
    { start: 2, end: 3, word: '--', isSilence: true }
  ] }]
  const identified = ensureWordIdentities(lines)
  expect(identified[0].words![0]).toBe(lines[0].words![0])
  expect(identified[0].words![1].id).not.toBe('a')
  expect(identified[0].words![2].id).toBeUndefined()
  expect(ensureWordIdentities(identified)).toBe(identified)
  const reordered = [{ ...identified[0], words: [...identified[0].words!].reverse() }]
  expect(ensureWordIdentities(reordered)).toBe(reordered)
})

describe('project mediaDuration', () => {
  it('저장된 원본 길이를 읽고, 없거나 잘못된 값은 버린다', () => {
    const ok = parseAutosubProjectFile({ ...projectFixture(), mediaDuration: 612.5 })
    expect(ok.ok && ok.data.mediaDuration).toBe(612.5)
    const old = parseAutosubProjectFile(projectFixture())
    expect(old.ok && old.data.mediaDuration).toBeUndefined()
    const bad = parseAutosubProjectFile({ ...projectFixture(), mediaDuration: -3 })
    expect(bad.ok && bad.data.mediaDuration).toBeUndefined()
  })
})

describe('split chips in project files', () => {
  it('keeps the joined-piece mark of split chips through save and reopen', () => {
    const subtitles = [{ start: 0, end: 1, text: '설치나', words: [
      { id: 'a~1', start: 0, end: .4, word: '설', splitChain: '1', manualEndLocked: true },
      { id: 'a~2', start: .4, end: 1, word: '치나', splitChain: '2', joinPrev: true, manualStartLocked: true }
    ] }]
    const parsed = parseAutosubProjectFile({ ...projectFixture(), subtitles })
    expect(parsed.ok && parsed.data.subtitles[0].words![1]!.joinPrev).toBe(true)
    const reopened = parsed.ok ? parseAutosubProjectFile(JSON.parse(JSON.stringify(parsed.data))) : parsed
    expect(reopened.ok && reopened.data.subtitles[0].words![1]!.joinPrev).toBe(true)
    expect(reopened.ok && reopened.data.subtitles[0].text).toBe('설치나')
  })
})

describe('project v3 media edits', () => {
  const media = {
    version: 1,
    assets: [{ id: 'photo', kind: 'image', path: 'C:/photo.png', name: 'photo.png' }],
    insertions: [{ id: 'clip', assetId: 'photo', at: { sourceTime: 1, wordId: 'one', edge: 'end' }, duration: 3,
      sourceStart: 0, fit: 'contain', muted: false }],
    overlays: [{ id: 'cover', assetId: 'photo', start: { sourceTime: 0 }, end: { sourceTime: 2 }, fit: 'cover' }]
  }
  it('keeps inserted clips and overlays through save and reopen as version 3', () => {
    const parsed = parseAutosubProjectFile({ ...projectFixture(), version: 3, mediaEdits: media })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.data.version).toBe(3)
    expect(parsed.data.mediaEdits).toEqual(media)
    const reopened = parseAutosubProjectFile(JSON.parse(JSON.stringify(parsed.data)))
    expect(reopened.ok && reopened.data.mediaEdits).toEqual(media)
  })
  it('a version 2 file has no media edits; a version 3 file without any is written back as version 2', () => {
    const v2 = parseAutosubProjectFile(projectFixture())
    expect(v2.ok && v2.data.mediaEdits).toBeUndefined()
    const empty = parseAutosubProjectFile({ ...projectFixture(), version: 3,
      mediaEdits: { version: 1, assets: [], insertions: [], overlays: [] } })
    expect(empty.ok && empty.data.version).toBe(2)
  })
  it('refuses damaged media edits instead of dropping them', () => {
    const bad = parseAutosubProjectFile({ ...projectFixture(), version: 3,
      mediaEdits: { ...media, insertions: [{ ...media.insertions[0], assetId: 'nope' }] } })
    expect(bad.ok).toBe(false)
  })
})
