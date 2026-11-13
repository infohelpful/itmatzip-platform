/**
 * AI 자막 채팅이 오타·줄바꿈·강조 말고도 편집기 기능을 쓰게 하는 작업들.
 *
 * - 줄 작업(강조 해제·색 지정 강조·숨김/표시·표시 시간·단어 삭제)은 단어 index(채팅에 보낸 `words[].index`)로
 *   대상을 고른다. `applyProofread` 로 글자·줄을 바꾼 **뒤**의 줄에 단어 id 로 찾아 적용하므로 줄이 다시 나뉘어도 맞다.
 * - 서식(`style`)은 줄과 별개인 편집기 설정이라 적용할 때 App 이 setter 로 반영한다.
 * - 모든 값은 여기서 다시 검사한다 — 모델 응답은 믿지 않는다.
 */
import type { SubtitleLine } from '../../shared/subtitles'
import {
  addCaptionEmphasis, captionEmphasisText, emphasisRangesByWordIndex, isEmphasisHexColor,
  resolveCaptionEmphasis, withUserCaptionEmphasis,
} from '../../shared/captionEmphasis'
import { setSubtitleVisibility } from '../../shared/subtitleVisibility'
import { lineDisplayAdjust, MAX_DISPLAY_ADJ_SEC, withDisplayTiming } from '../../shared/subtitleDisplayTiming'
import { subtitleLinesAfterSoftDeleteWordRange } from '../../shared/virtualTimeline'
import { scrubTimelineNoiseFromWordPiece, shouldOmitFromSubtitleEditLineText } from '../../shared/wordContract'
import type { SubtitleBoxStyle } from '../../shared/subtitleCapsule'

export type AiStylePatch = Partial<{
  fontFamily: string
  fontSize: number
  fontWeight: number
  textColor: string
  strokeColor: string
  strokeWidth: number
  bgColor: string
  bgOpacity: number
  bgPaddingPct: number
  x: number
  y: number
  boxStyle: SubtitleBoxStyle
  emphasisColor: string
  wordHighlight: boolean
  wordHighlightColor: string
}>

export type AiEditorOps = {
  /** 강조를 지울 단어 index */
  unemphasize?: number[]
  /** 지정한 색으로 강조할 단어 index */
  emphasisColored?: { index: number; color: string }[]
  /** 이 단어가 든 줄을 「자막 숨김」 */
  hide?: number[]
  /** 이 단어가 든 줄을 다시 표시 */
  show?: number[]
  /** 이 단어가 든 줄의 자막 표시 시작·끝 보정(초, 자동 구간 기준) */
  displayTiming?: { index: number; startAdj?: number; endAdj?: number }[]
  /** 지울 단어 index(편집기 Delete 와 같은 비파괴 삭제 — 그 소리 구간이 영상에서 빠진다) */
  deleteWords?: number[]
  style?: AiStylePatch
}

export type AiOpsSummary = {
  unemphasized: number
  colored: number
  hidden: number
  shown: number
  timed: number
  deleted: number
  styleKeys: string[]
}

const STYLE_LABELS: Record<keyof AiStylePatch, string> = {
  fontFamily: '글꼴', fontSize: '글자 크기', fontWeight: '굵기', textColor: '글자색', strokeColor: '테두리 색',
  strokeWidth: '테두리 두께', bgColor: '배경색', bgOpacity: '배경 투명도', bgPaddingPct: '배경 여백', x: '좌우 위치',
  y: '상하 위치', boxStyle: '박스 모양', emphasisColor: '강조색', wordHighlight: '단어 강조', wordHighlightColor: '단어 강조색',
}

export function styleKeyLabel(key: string): string {
  return STYLE_LABELS[key as keyof AiStylePatch] ?? key
}

const MAX_OPS = 40_000

function indexList(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.slice(0, MAX_OPS).filter((v): v is number => Number.isInteger(v) && v >= 0))]
}

function num(raw: unknown, min: number, max: number): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(min, Math.min(max, raw)) : undefined
}

/** 모델이 준 서식 값을 편집기 범위 안의 값만 남긴다. 남는 게 없으면 null */
export function sanitizeStylePatch(raw: unknown): AiStylePatch | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const out: AiStylePatch = {}
  if (typeof r.fontFamily === 'string' && r.fontFamily.trim() && r.fontFamily.length <= 100) out.fontFamily = r.fontFamily.trim()
  const fontSize = num(r.fontSize, 8, 200); if (fontSize !== undefined) out.fontSize = Math.round(fontSize)
  const fontWeight = num(r.fontWeight, 100, 900); if (fontWeight !== undefined) out.fontWeight = Math.round(fontWeight / 100) * 100
  for (const key of ['textColor', 'strokeColor', 'bgColor', 'emphasisColor', 'wordHighlightColor'] as const) {
    if (isEmphasisHexColor(r[key])) out[key] = (r[key] as string).toLowerCase()
  }
  const strokeWidth = num(r.strokeWidth, 0, 20); if (strokeWidth !== undefined) out.strokeWidth = strokeWidth
  const bgOpacity = num(r.bgOpacity, 0, 100); if (bgOpacity !== undefined) out.bgOpacity = Math.round(bgOpacity)
  const bgPaddingPct = num(r.bgPaddingPct, 0, 100); if (bgPaddingPct !== undefined) out.bgPaddingPct = bgPaddingPct
  const x = num(r.x, 0, 100); if (x !== undefined) out.x = x
  const y = num(r.y, 0, 100); if (y !== undefined) out.y = y
  if (r.boxStyle === 'classic' || r.boxStyle === 'capsule') out.boxStyle = r.boxStyle
  if (typeof r.wordHighlight === 'boolean') out.wordHighlight = r.wordHighlight
  return Object.keys(out).length ? out : null
}

/** 수정안 JSON 에서 편집기 작업만 골라 검사한다. 할 일이 없으면 null */
export function parseAiEditorOps(raw: Record<string, unknown>): AiEditorOps | null {
  const ops: AiEditorOps = {}
  const unemphasize = indexList(raw.unemphasize); if (unemphasize.length) ops.unemphasize = unemphasize
  const hide = indexList(raw.hide); if (hide.length) ops.hide = hide
  const show = indexList(raw.show); if (show.length) ops.show = show
  const deleteWords = indexList(raw.deleteWords); if (deleteWords.length) ops.deleteWords = deleteWords
  if (Array.isArray(raw.emphasisColored)) {
    const colored = raw.emphasisColored.slice(0, MAX_OPS).flatMap(item => {
      const o = item as Record<string, unknown> | null
      return o && Number.isInteger(o.index) && (o.index as number) >= 0 && isEmphasisHexColor(o.color)
        ? [{ index: o.index as number, color: (o.color as string).toLowerCase() }] : []
    })
    if (colored.length) ops.emphasisColored = colored
  }
  if (Array.isArray(raw.displayTiming)) {
    const timing = raw.displayTiming.slice(0, MAX_OPS).flatMap(item => {
      const o = item as Record<string, unknown> | null
      if (!o || !Number.isInteger(o.index) || (o.index as number) < 0) return []
      const startAdj = num(o.startAdj, -MAX_DISPLAY_ADJ_SEC, MAX_DISPLAY_ADJ_SEC)
      const endAdj = num(o.endAdj, -MAX_DISPLAY_ADJ_SEC, MAX_DISPLAY_ADJ_SEC)
      return startAdj === undefined && endAdj === undefined ? [] : [{ index: o.index as number, startAdj, endAdj }]
    })
    if (timing.length) ops.displayTiming = timing
  }
  const style = sanitizeStylePatch(raw.style); if (style) ops.style = style
  return Object.keys(ops).length ? ops : null
}

/** 단어 id → (줄 index, 줄 안 단어 저장 index) */
function locateWords(lines: readonly SubtitleLine[]): Map<string, { line: number; word: number }> {
  const out = new Map<string, { line: number; word: number }>()
  lines.forEach((line, li) => {
    if (line.isDeleted) return
    line.words?.forEach((w, wi) => { if (w.id && !w.isDeleted) out.set(w.id, { line: li, word: wi }) })
  })
  return out
}

/** 줄 편집 글자에서 단어 칩 하나가 차지하는 글자 범위(못 찾으면 null) */
function wordCharRange(line: SubtitleLine, wordIndex: number): [number, number] | null {
  const text = captionEmphasisText(line)
  const pieces: { wi: number; piece: string }[] = []
  line.words?.forEach((w, wi) => {
    if (w.isDeleted || w.isSilence) return
    const piece = scrubTimelineNoiseFromWordPiece(w.word)
    if (piece.length === 0 || shouldOmitFromSubtitleEditLineText(piece)) return
    pieces.push({ wi, piece })
  })
  if (pieces.map(p => p.piece).join(' ') === text) {
    let offset = 0
    for (const { wi, piece } of pieces) {
      if (wi === wordIndex) return [offset, offset + piece.length]
      offset += piece.length + 1
    }
    return null
  }
  // 사용자가 문구를 고친 줄: 같은 순서의 토큰 위치로 맞춘다.
  const order = pieces.findIndex(p => p.wi === wordIndex)
  const tokens = [...text.matchAll(/\S+/g)]
  if (order < 0 || tokens.length !== pieces.length) return null
  const tok = tokens[order]!
  return [tok.index!, tok.index! + tok[0].length]
}

/**
 * `wordIds[g]` = 채팅에 보낸 단어 index g 의 단어 id. `lines` 는 글자·줄 수정을 이미 적용한 줄.
 * 서식(`style`)은 여기서 바꾸지 않는다 — 요약에만 남긴다.
 */
export function applyAiEditorOps(
  lines: SubtitleLine[],
  wordIds: readonly string[],
  ops: AiEditorOps | null,
): { lines: SubtitleLine[]; summary: AiOpsSummary } {
  const summary: AiOpsSummary = {
    unemphasized: 0, colored: 0, hidden: 0, shown: 0, timed: 0, deleted: 0,
    styleKeys: ops?.style ? Object.keys(ops.style) : [],
  }
  if (!ops) return { lines, summary }
  let next = lines
  const idOf = (g: number) => (g >= 0 && g < wordIds.length ? wordIds[g] : undefined)
  const where = () => locateWords(next)

  // 강조 해제 · 색 지정 강조
  if (ops.unemphasize?.length || ops.emphasisColored?.length) {
    const loc = where()
    const byLine = new Map<number, { off: number[]; color: { word: number; color: string }[] }>()
    const bucket = (li: number) => byLine.get(li) ?? (byLine.set(li, { off: [], color: [] }), byLine.get(li)!)
    for (const g of ops.unemphasize ?? []) {
      const at = loc.get(idOf(g) ?? '')
      if (at) bucket(at.line).off.push(at.word)
    }
    for (const { index, color } of ops.emphasisColored ?? []) {
      const at = loc.get(idOf(index) ?? '')
      if (at) bucket(at.line).color.push({ word: at.word, color })
    }
    next = next.map((line, li) => {
      const job = byLine.get(li)
      if (!job) return line
      const text = captionEmphasisText(line)
      let ranges = resolveCaptionEmphasis(text, line.emphasis)
      if (job.off.length) {
        const hits = emphasisRangesByWordIndex(line)
        const drop = new Set(job.off.flatMap(wi => hits.get(wi) ?? []).map(r => `${r.start}:${r.end}`))
        const before = ranges.length
        ranges = ranges.filter(r => !drop.has(`${r.start}:${r.end}`))
        summary.unemphasized += before - ranges.length
      }
      for (const { word, color } of job.color) {
        const span = wordCharRange(line, word)
        if (!span) continue
        ranges = addCaptionEmphasis(text, ranges, span[0], span[1], color)
        summary.colored++
      }
      return withUserCaptionEmphasis(line, ranges)
    })
  }

  // 숨김 · 표시
  const linesOf = (indexes: number[] | undefined) => {
    const loc = where()
    return new Set((indexes ?? []).flatMap(g => { const at = loc.get(idOf(g) ?? ''); return at ? [at.line] : [] }))
  }
  const hide = linesOf(ops.hide)
  if (hide.size) {
    const before = next
    next = setSubtitleVisibility(next, hide, true)
    summary.hidden = [...hide].filter(li => before[li] !== next[li]).length
  }
  const show = linesOf(ops.show)
  if (show.size) {
    const before = next
    next = setSubtitleVisibility(next, show, false)
    summary.shown = [...show].filter(li => before[li] !== next[li]).length
  }

  // 자막 표시 시간 보정
  if (ops.displayTiming?.length) {
    const loc = where()
    const out = [...next]
    for (const { index, startAdj, endAdj } of ops.displayTiming) {
      const at = loc.get(idOf(index) ?? '')
      if (!at) continue
      const cur = lineDisplayAdjust(out[at.line])
      const updated = withDisplayTiming(out[at.line]!, startAdj ?? cur.start, endAdj ?? cur.end)
      if (updated !== out[at.line]) { out[at.line] = updated; summary.timed++ }
    }
    next = out
  }

  // 단어 삭제 — 뒤 줄·뒤 단어부터 지워 앞쪽 index 가 바뀌지 않게 한다.
  if (ops.deleteWords?.length) {
    const loc = where()
    const targets = ops.deleteWords.flatMap(g => { const at = loc.get(idOf(g) ?? ''); return at ? [at] : [] })
      .sort((a, b) => b.line - a.line || b.word - a.word)
    let i = 0
    while (i < targets.length) {
      // 같은 줄에서 붙어 있는 단어는 한 번에 지운다.
      const { line } = targets[i]!
      let from = targets[i]!.word
      const to = from + 1
      let j = i + 1
      while (j < targets.length && targets[j]!.line === line && targets[j]!.word === from - 1) { from--; j++ }
      const result = subtitleLinesAfterSoftDeleteWordRange(next, line, from, to, [])
      if (result) { next = result.lines; summary.deleted += to - from }
      i = j
    }
  }

  return { lines: next, summary }
}

/** 채팅 요약 한 줄(바뀐 것만) */
export function describeAiOps(summary: AiOpsSummary): string {
  const parts: string[] = []
  if (summary.colored) parts.push(`색 강조 ${summary.colored}`)
  if (summary.unemphasized) parts.push(`강조 해제 ${summary.unemphasized}`)
  if (summary.hidden) parts.push(`숨김 ${summary.hidden}줄`)
  if (summary.shown) parts.push(`표시 ${summary.shown}줄`)
  if (summary.timed) parts.push(`표시 시간 ${summary.timed}줄`)
  if (summary.deleted) parts.push(`단어 삭제 ${summary.deleted}`)
  if (summary.styleKeys.length) parts.push(`서식(${summary.styleKeys.map(styleKeyLabel).join(', ')})`)
  return parts.join(' · ')
}
