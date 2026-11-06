/**
 * 영상 위 프리뷰 자막 글자 — 재생 RAF 마다 불리므로 DOM 을 직접 고친다.
 * 강조(키워드 칩)도 단어 강조도 없는 줄은 예전과 똑같이 `textContent` 로만 쓴다.
 * 단어 강조는 영상 내보내기(번인)와 같은 단어 조각·같은 판정(`resolveHighlightWordIndex`)·같은
 * 칩/글자 분할(`emphasisRenderPieces`)을 써서, 미리보기와 내보낸 영상이 같은 글자를 같은 색으로 칠한다.
 * 같은 줄·같은 색·같은 활성 단어면 다시 만들지 않는다.
 */
import type { SubtitleLine } from '../../shared/subtitles'
import { activeWordCharRange, emphasisRenderPieces } from '../../shared/captionEmphasis'
import { emphasisChipStyle } from '../../shared/subtitleCapsule'
import { subtitlePreviewLine, subtitlePreviewText } from '../../shared/subtitleVisibility'
import { buildExportCueLines, type ExportCueLine } from '../../shared/exportCuePipeline'
import { resolveHighlightWordIndex } from '../../shared/activeWordResolver'

export type PreviewEmphasisCache = {
  el: HTMLElement
  line: SubtitleLine
  color: string
  highlightColor: string | null
  activeIndex: number
} | null

/** 줄 → 내보내기 큐(단어 조각 포함). 같은 줄 객체면 다시 계산하지 않는다. */
const cueCache = new WeakMap<SubtitleLine, ExportCueLine | null>()

function previewCue(line: SubtitleLine): ExportCueLine | null {
  if (cueCache.has(line)) return cueCache.get(line) ?? null
  const cue = buildExportCueLines([line], { includeWords: true, includeEmphasis: true })[0] ?? null
  cueCache.set(line, cue)
  return cue
}

/** 내보내기 스케줄의 `usableWords` 와 같은 조건: 줄 텍스트와 단어 조각이 정확히 맞을 때만 강조한다. */
function highlightWords(cue: ExportCueLine | null): { text: string; words: NonNullable<ExportCueLine['words']> } | null {
  if (!cue?.words?.length) return null
  const text = cue.text.trim()
  for (const w of cue.words) {
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end <= w.start || !w.text) return null
  }
  return cue.words.map((w) => w.text).join(' ') === text ? { text, words: cue.words } : null
}

function chip(text: string, color: string | null, activeColor: string | null, active: boolean): Node {
  const textNode = (value: string): Node => {
    if (!active || !activeColor) return document.createTextNode(value)
    const span = document.createElement('span')
    span.style.color = activeColor
    span.textContent = value
    return span
  }
  if (!color) return textNode(text)
  const span = document.createElement('span')
  span.className = 'preview-subtitle-emphasis'
  for (const [key, value] of Object.entries(emphasisChipStyle(color))) {
    // React 식 이름(WebkitBoxDecorationBreak) → CSS 이름(-webkit-box-decoration-break)
    span.style.setProperty(key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), String(value))
  }
  span.appendChild(textNode(text))
  return span
}

export function renderPreviewSubtitleText(
  el: HTMLElement,
  lines: readonly SubtitleLine[],
  time: number,
  emphasisColor: string,
  cache: { current: PreviewEmphasisCache },
  /** 단어 강조 색 — 단어 강조를 끄면 null */
  highlightColor: string | null = null
): void {
  const line = subtitlePreviewLine(lines, time)
  const hl = line && highlightColor ? highlightWords(previewCue(line)) : null
  if (!line || (!line.emphasis?.length && !hl)) {
    cache.current = null
    el.textContent = subtitlePreviewText(lines, time)
    return
  }
  const activeIndex = hl ? resolveHighlightWordIndex(hl.words, time) : -1
  const hit = cache.current
  if (hit && hit.el === el && hit.line === line && hit.color === emphasisColor &&
      hit.highlightColor === highlightColor && hit.activeIndex === activeIndex) return

  let nodes: Node[]
  if (hl) {
    // 번인과 같이 큐 텍스트·큐 강조 범위 기준으로 그린다.
    const cue = previewCue(line)!
    const pieces = emphasisRenderPieces(hl.text, cue.emphasis, emphasisColor,
      activeWordCharRange(hl.words.map((w) => w.text), activeIndex))
    nodes = pieces.flatMap((piece) => {
      if (!piece.color) return piece.parts.map((part) => chip(part.text, null, highlightColor, part.active))
      const span = chip('', piece.color, null, false) as HTMLElement
      span.replaceChildren(...piece.parts.map((part) => chip(part.text, null, highlightColor, part.active)))
      return [span]
    })
  } else {
    nodes = emphasisRenderPieces(line.text, line.emphasis, emphasisColor)
      .map((piece) => chip(piece.parts.map((p) => p.text).join(''), piece.color, null, false))
  }
  el.replaceChildren(...nodes)
  cache.current = { el, line, color: emphasisColor, highlightColor, activeIndex }
}
