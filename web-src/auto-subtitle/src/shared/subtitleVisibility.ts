import type { SubtitleLine } from './subtitles'
import { pickDisplayedSubtitleIndex } from './subtitleDisplayTiming'

export function setSubtitleVisibility(lines: readonly SubtitleLine[], selected: ReadonlySet<number>, hidden: boolean): SubtitleLine[] {
  return lines.map((line, i) => {
    if (!selected.has(i) || line.isDeleted || !!line.isHidden === hidden) return line
    const next = {...line}
    if (hidden) next.isHidden = true
    else delete next.isHidden
    return next
  })
}
export function subtitlePreviewText(lines: readonly SubtitleLine[], time: number): string {
  const index = pickDisplayedSubtitleIndex(lines, time)
  const line = index === null ? undefined : lines[index]
  return line && !line.isHidden ? line.text : ''
}

/** 프리뷰에 보일 줄(숨김이면 null) — `subtitlePreviewText` 와 같은 규칙. 강조 칩 렌더용. */
export function subtitlePreviewLine(lines: readonly SubtitleLine[], time: number): SubtitleLine | null {
  const index = pickDisplayedSubtitleIndex(lines, time)
  const line = index === null ? undefined : lines[index]
  return line && !line.isHidden ? line : null
}
