import { describe, expect, it } from 'vitest'
import { insertionRows, moveOverlayEdge, overlayRowSpan, rowEndAnchor, rowStartAnchor } from './mediaEditOps'
import type { MediaEdits } from './mediaComposition'
import type { SubtitleLine } from './subtitles'

const lines: SubtitleLine[] = [
  { start: 0, end: 2, text: '가 나', words: [{ id: 'a', start: 0, end: 1, word: '가' }, { id: 'b', start: 1, end: 2, word: '나' }] },
  { start: 2, end: 4, text: '다', words: [{ id: 'c', start: 2, end: 3, word: '다' }, { id: 'x', start: 3, end: 4, word: '라', isDeleted: true }] },
  { start: 4, end: 5, text: '', isDeleted: true, words: [{ id: 'gone', start: 4, end: 5, word: '마', isDeleted: true }] },
  { start: 5, end: 7, text: '바', words: [{ id: 'd', start: 5, end: 7, word: '바' }] }
]
const asset = { id: 'img', kind: 'image' as const, path: 'C:/a.png', name: 'a.png' }
const edits = (insertions: MediaEdits['insertions']): MediaEdits => ({ version: 1, assets: [asset], insertions, overlays: [] })
const clip = (id: string, at: MediaEdits['insertions'][number]['at']) =>
  ({ id, assetId: 'img', at, duration: 2, sourceStart: 0, fit: 'contain' as const, muted: false })

describe('row anchors', () => {
  it('anchor to the last / first remaining word of a row', () => {
    expect(rowEndAnchor(lines, 1)).toEqual({ sourceTime: 3, wordId: 'c', edge: 'end' })
    expect(rowStartAnchor(lines, 3)).toEqual({ sourceTime: 5, wordId: 'd', edge: 'start' })
    expect(rowEndAnchor(lines, 2)).toEqual({ sourceTime: 5 })
  })
})

describe('insertion rows', () => {
  it('lists a clip after the row it follows, a start-of-row clip after the previous visible row, and the first one before row 0', () => {
    const rows = insertionRows(lines, edits([
      clip('one', rowEndAnchor(lines, 0)),
      clip('two', rowStartAnchor(lines, 3)),
      clip('lead', rowStartAnchor(lines, 0)),
      clip('three', rowEndAnchor(lines, 0))
    ]), 7)
    expect(rows.get(0)).toEqual({ before: ['lead'], after: ['one', 'three'] })
    // Row 2 is removed: the clip before row 3 is listed after row 1.
    expect(rows.get(1)).toEqual({ before: [], after: ['two'] })
  })
  it('follows split pieces of the anchor word', () => {
    const split: SubtitleLine[] = [{ ...lines[0]!, words: [lines[0]!.words![0]!, { id: 'b~1', start: 1, end: 1.5, word: 'ㄴ' }] },
      { start: 1.5, end: 2, text: '', words: [{ id: 'b~2', start: 1.5, end: 2, word: '나' }] }]
    expect(insertionRows(split, edits([clip('one', { sourceTime: 2, wordId: 'b', edge: 'end' })]), 7).get(0)?.after).toEqual(['one'])
  })
})

describe('overlay range by rows', () => {
  const overlay = { id: 'o', assetId: 'img', start: rowStartAnchor(lines, 0), end: rowEndAnchor(lines, 0), fit: 'cover' as const }
  it('covers the rows of its anchors', () => {
    expect(overlayRowSpan(lines, overlay, 7)).toEqual({ startRow: 0, endRow: 0 })
  })
  it('grows and shrinks by visible rows, skipping removed rows and keeping at least one row', () => {
    const grown = moveOverlayEdge(lines, overlay, 7, 'end', 1)!
    expect(grown.end).toEqual({ sourceTime: 3, wordId: 'c', edge: 'end' })
    const grown2 = moveOverlayEdge(lines, grown, 7, 'end', 1)!
    expect(overlayRowSpan(lines, grown2, 7)).toEqual({ startRow: 0, endRow: 3 })
    expect(moveOverlayEdge(lines, grown2, 7, 'end', 1)).toBeNull()
    expect(moveOverlayEdge(lines, overlay, 7, 'end', -1)).toBeNull()
    expect(moveOverlayEdge(lines, overlay, 7, 'start', -1)).toBeNull()
    const later = moveOverlayEdge(lines, grown2, 7, 'start', 1)!
    expect(overlayRowSpan(lines, later, 7)).toEqual({ startRow: 1, endRow: 3 })
  })
})
