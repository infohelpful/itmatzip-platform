/**
 * 영상 위 프리뷰 자막 글자 — 재생 RAF 마다 불리므로 DOM 을 직접 고친다.
 * 강조가 없는 줄은 예전과 똑같이 `textContent` 로만 쓴다. 강조가 있는 줄만 칩(span)으로 그리고,
 * 같은 줄·같은 색이면 다시 만들지 않는다.
 */
import type { SubtitleLine } from '../../shared/subtitles'
import { captionEmphasisSegments } from '../../shared/captionEmphasis'
import { emphasisChipStyle } from '../../shared/subtitleCapsule'
import { subtitlePreviewLine, subtitlePreviewText } from '../../shared/subtitleVisibility'

export type PreviewEmphasisCache = { el: HTMLElement; line: SubtitleLine; color: string } | null

export function renderPreviewSubtitleText(
  el: HTMLElement,
  lines: readonly SubtitleLine[],
  time: number,
  emphasisColor: string,
  cache: { current: PreviewEmphasisCache }
): void {
  const line = subtitlePreviewLine(lines, time)
  if (!line?.emphasis?.length) {
    cache.current = null
    el.textContent = subtitlePreviewText(lines, time)
    return
  }
  const hit = cache.current
  if (hit && hit.el === el && hit.line === line && hit.color === emphasisColor) return
  const segments = captionEmphasisSegments(line.text, line.emphasis, emphasisColor)
  const nodes: Node[] = segments.map((seg) => {
    if (!seg.color) return document.createTextNode(seg.text)
    const span = document.createElement('span')
    span.className = 'preview-subtitle-emphasis'
    for (const [key, value] of Object.entries(emphasisChipStyle(seg.color))) {
      // React 식 이름(WebkitBoxDecorationBreak) → CSS 이름(-webkit-box-decoration-break)
      span.style.setProperty(key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), String(value))
    }
    span.textContent = seg.text
    return span
  })
  el.replaceChildren(...nodes)
  cache.current = { el, line, color: emphasisColor }
}
