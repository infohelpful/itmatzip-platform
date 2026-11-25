/**
 * Row-level editing of inserted clips and image overlays: where a clip goes when it is added after a
 * caption row, which row shows it, and how an overlay's range moves by whole rows (Vrew-style).
 * Anchors keep the word ID so later timing edits and splits move the clip with the word.
 */
import { isRemovedSubtitleRow } from './editorPlayback'
import { resolveMediaAnchor, type ImageOverlay, type MediaAnchor, type MediaEdits } from './mediaComposition'
import type { SubtitleLine, SubtitleWord } from './subtitles'

const liveWords = (line: SubtitleLine | undefined): SubtitleWord[] => (line?.words ?? []).filter(w => !w.isDeleted)

/** After the row's last remaining word (or the row's end when it has no words). */
export function rowEndAnchor(lines: readonly SubtitleLine[], row: number): MediaAnchor {
  const line = lines[row]
  const last = liveWords(line).at(-1)
  return last?.id ? { sourceTime: last.end, wordId: last.id, edge: 'end' } : { sourceTime: line?.end ?? 0 }
}

/** Before the row's first remaining word (or the row's start). */
export function rowStartAnchor(lines: readonly SubtitleLine[], row: number): MediaAnchor {
  const line = lines[row]
  const first = liveWords(line)[0]
  return first?.id ? { sourceTime: first.start, wordId: first.id, edge: 'start' } : { sourceTime: line?.start ?? 0 }
}

/** Rows still shown in the list. */
function visibleRows(lines: readonly SubtitleLine[]): number[] {
  return lines.flatMap((line, i) => (isRemovedSubtitleRow(line) ? [] : [i]))
}

/** Row whose words hold the anchor's word, or by time the last visible row starting at or before it. */
function anchorRow(lines: readonly SubtitleLine[], anchor: MediaAnchor, time: number): number | null {
  const visible = visibleRows(lines)
  if (!visible.length) return null
  if (anchor.wordId) {
    const prefix = `${anchor.wordId}~`
    const row = lines.findIndex(line => (line.words ?? []).some(w => !w.isDeleted &&
      (w.id === anchor.wordId || w.id?.startsWith(prefix))))
    if (row >= 0 && !isRemovedSubtitleRow(lines[row]!)) return row
  }
  let found = visible[0]!
  for (const i of visible) if (lines[i]!.start <= time + 1e-6) found = i
  return found
}

/** Where each inserted clip is listed: after (or, at the very start, before) a caption row, in play order. */
export function insertionRows(lines: readonly SubtitleLine[], edits: MediaEdits, sourceDuration: number):
  Map<number, { before: string[]; after: string[] }> {
  const out = new Map<number, { before: string[]; after: string[] }>()
  const items = edits.insertions.map((c, order) => ({ c, order, time: resolveMediaAnchor(c.at, lines, sourceDuration) }))
    .sort((a, b) => a.time - b.time || a.order - b.order)
  const visible = visibleRows(lines)
  for (const { c, time } of items) {
    let row = anchorRow(lines, c.at, time)
    if (row === null) continue
    // A clip anchored to a row's start goes after the previous visible row, so clips read in play order.
    let side: 'before' | 'after' = 'after'
    if (c.at.edge === 'start' || time < (lines[row]!.start ?? 0) - 1e-6) {
      const prev = visible.filter(i => i < row!).at(-1)
      if (prev === undefined) side = 'before'
      else row = prev
    }
    const slot = out.get(row) ?? { before: [], after: [] }
    slot[side].push(c.id)
    out.set(row, slot)
  }
  return out
}

/** First and last caption rows an overlay covers. */
export function overlayRowSpan(lines: readonly SubtitleLine[], overlay: ImageOverlay, sourceDuration: number):
  { startRow: number; endRow: number } | null {
  const start = resolveMediaAnchor(overlay.start, lines, sourceDuration)
  const end = resolveMediaAnchor(overlay.end, lines, sourceDuration)
  const startRow = anchorRow(lines, overlay.start, start)
  // The end edge belongs to the row whose words end there (not the next row starting at that time).
  const endRow = anchorRow(lines, overlay.end, Math.max(start, end - 1e-3))
  return startRow === null || endRow === null ? null : { startRow, endRow: Math.max(startRow, endRow) }
}

/**
 * Moves one edge of an overlay by whole visible rows (Vrew's 「적용 범위 변경」). The range always
 * keeps at least one row; null when the edge cannot move further that way.
 */
export function moveOverlayEdge(lines: readonly SubtitleLine[], overlay: ImageOverlay, sourceDuration: number,
  edge: 'start' | 'end', step: -1 | 1): ImageOverlay | null {
  const span = overlayRowSpan(lines, overlay, sourceDuration)
  if (!span) return null
  const visible = visibleRows(lines)
  const at = (row: number) => visible.indexOf(row)
  const startPos = at(span.startRow), endPos = at(span.endRow)
  if (startPos < 0 || endPos < 0) return null
  if (edge === 'start') {
    const next = startPos + step
    if (next < 0 || next > endPos) return null
    return { ...overlay, start: rowStartAnchor(lines, visible[next]!) }
  }
  const next = endPos + step
  if (next < startPos || next >= visible.length) return null
  return { ...overlay, end: rowEndAnchor(lines, visible[next]!) }
}
