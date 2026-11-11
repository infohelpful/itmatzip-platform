/**
 * 자막 표시 타이밍(줄 단위 수동 보정).
 *
 * - 단어 시간(`word.start/end`)·줄 `start/end` 는 **절대 바꾸지 않는다** — 그 값은 소리·컷·재생 구간이다.
 * - 줄에 `displayStartAdj` / `displayEndAdj`(초) 만 저장하고, 자동 표시 구간
 *   (`subtitlePresentationSpans`) 계산이 **모두 끝난 뒤** 그 위에 더한다.
 *   (안쪽에서 더하면 "다음 자막까지 유지" 규칙이 당긴 끝 시간을 다시 늘린다.)
 * - 보정이 없는 줄만 있으면 자동 구간 배열을 그대로 돌려준다 — 기존 동작과 100% 같다.
 * - 편집 화면(카드 시간·단어 칩 강조)은 자동 구간을 그대로 쓰고, 미리보기·내보내기만 이 구간을 쓴다.
 */
import type { SubtitleLine } from './subtitles'
import { subtitlePresentationSpans, type SubtitlePresentationSpan } from './subtitlePresentation'

/** 보정 후 한 줄이 최소한 보여야 하는 길이(초) */
export const MIN_DISPLAY_SPAN_SEC = 0.1
/** 저장할 수 있는 보정 크기 상한(초) — 잘못된 프로젝트 값 방어 */
export const MAX_DISPLAY_ADJ_SEC = 600

const EPS = 1e-6

function cleanAdj(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  if (Math.abs(value) < 0.0005) return 0
  return Math.max(-MAX_DISPLAY_ADJ_SEC, Math.min(MAX_DISPLAY_ADJ_SEC, value))
}

export function lineDisplayAdjust(line: Pick<SubtitleLine, 'displayStartAdj' | 'displayEndAdj'> | undefined): {
  start: number
  end: number
} {
  return { start: cleanAdj(line?.displayStartAdj), end: cleanAdj(line?.displayEndAdj) }
}

export function hasDisplayTimingAdjust(line: Pick<SubtitleLine, 'displayStartAdj' | 'displayEndAdj'> | undefined): boolean {
  const adj = lineDisplayAdjust(line)
  return adj.start !== 0 || adj.end !== 0
}

/** 보정값을 붙이거나(0 이면) 지운 줄 — 바뀐 게 없으면 같은 객체 */
export function withDisplayTiming(line: SubtitleLine, startAdj: number, endAdj: number): SubtitleLine {
  const s = Math.round(cleanAdj(startAdj) * 1000) / 1000
  const e = Math.round(cleanAdj(endAdj) * 1000) / 1000
  const stored = (v: number) => (v !== 0 ? v : undefined)
  if (line.displayStartAdj === stored(s) && line.displayEndAdj === stored(e)) return line
  const next: SubtitleLine = { ...line }
  if (s !== 0) next.displayStartAdj = s
  else delete next.displayStartAdj
  if (e !== 0) next.displayEndAdj = e
  else delete next.displayEndAdj
  return next
}

/**
 * 한 줄이 둘로 나뉜 결과 보정: 시작 보정은 앞 줄, 끝 보정은 뒤 줄에만 남긴다.
 * (`{ ...line }` 복사로 두 줄 모두에 같은 값이 들어간 경우를 바로잡는다.)
 */
export function splitDisplayTiming(
  before: readonly SubtitleLine[],
  after: SubtitleLine[],
  index: number
): SubtitleLine[] {
  const source = before[index]
  if (!hasDisplayTimingAdjust(source) || after.length !== before.length + 1) return after
  const adj = lineDisplayAdjust(source)
  const out = [...after]
  if (out[index]) out[index] = withDisplayTiming(out[index]!, adj.start, 0)
  if (out[index + 1]) out[index + 1] = withDisplayTiming(out[index + 1]!, 0, adj.end)
  return out
}

/** 두 줄이 하나로 합쳐진 결과 보정: 앞 줄의 시작 보정 + 뒤 줄의 끝 보정 */
export function mergedDisplayTiming(merged: SubtitleLine, first: SubtitleLine, last: SubtitleLine): SubtitleLine {
  if (!hasDisplayTimingAdjust(first) && !hasDisplayTimingAdjust(last) && !hasDisplayTimingAdjust(merged)) return merged
  return withDisplayTiming(merged, lineDisplayAdjust(first).start, lineDisplayAdjust(last).end)
}

/** 자동 표시 구간에서 줄 `index` 의 처음 시작·마지막 끝(조각이 여럿이면 양 끝) */
export function subtitleAutoDisplayBounds(
  lines: readonly SubtitleLine[],
  index: number
): { start: number; end: number } | null {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const span of subtitlePresentationSpans(lines)) {
    if (span.index !== index) continue
    if (span.start < start) start = span.start
    if (span.end > end) end = span.end
  }
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null
}

const displayCache = new WeakMap<readonly SubtitleLine[], SubtitlePresentationSpan[]>()

/**
 * 화면(미리보기)·내보내기에 쓰는 실제 자막 표시 구간.
 * 자동 구간 + 줄별 보정. 보정이 겹치면 **뒤 자막이 이긴다**(앞 자막 끝을 뒤 자막 시작에서 자른다).
 */
export function subtitleDisplaySpans(lines: readonly SubtitleLine[]): SubtitlePresentationSpan[] {
  const auto = subtitlePresentationSpans(lines)
  if (!lines.some(hasDisplayTimingAdjust)) return auto
  const cached = displayCache.get(lines)
  if (cached) return cached

  const firstPos = new Map<number, number>()
  const lastPos = new Map<number, number>()
  auto.forEach((span, pos) => {
    if (!firstPos.has(span.index)) firstPos.set(span.index, pos)
    lastPos.set(span.index, pos)
  })
  const spans = auto.map(span => ({ ...span }))
  for (const [index, fp] of firstPos) {
    const adj = lineDisplayAdjust(lines[index])
    if (adj.start === 0 && adj.end === 0) continue
    const lp = lastPos.get(index)!
    spans[fp]!.start = Math.max(0, spans[fp]!.start + adj.start)
    spans[lp]!.end = Math.max(0, spans[lp]!.end + adj.end)
    if (fp === lp && spans[fp]!.end < spans[fp]!.start + MIN_DISPLAY_SPAN_SEC) {
      spans[fp]!.end = spans[fp]!.start + MIN_DISPLAY_SPAN_SEC
    }
  }
  spans.sort((a, b) => a.start - b.start || a.index - b.index)
  for (let i = 0; i + 1 < spans.length; i++) {
    const current = spans[i]!
    const next = spans[i + 1]!
    if (next.start < current.end) current.end = Math.max(current.start, next.start)
  }
  const out = spans.filter(span => span.end - span.start > EPS)
  displayCache.set(lines, out)
  return out
}

/** 시각 `time` 에 화면에 보이는 자막 줄 — `pickActiveSubtitleIndex` 의 표시용(보정 반영) 판 */
export function pickDisplayedSubtitleIndex(lines: readonly SubtitleLine[], time: number): number | null {
  if (!Number.isFinite(time)) return null
  const spans = subtitleDisplaySpans(lines)
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (spans[mid]!.start <= time) lo = mid + 1
    else hi = mid - 1
  }
  const span = spans[hi]
  return span && time < span.end ? span.index : null
}

/** 카드에 보일 실제 표시 구간(보정·겹침 정리 반영). 화면에 안 보이는 줄이면 null */
export function subtitleDisplayBounds(
  lines: readonly SubtitleLine[],
  index: number
): { start: number; end: number } | null {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const span of subtitleDisplaySpans(lines)) {
    if (span.index !== index) continue
    if (span.start < start) start = span.start
    if (span.end > end) end = span.end
  }
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null
}

export type SubtitleDisplayTimingEdit =
  | { kind: 'nudge'; edge: 'start' | 'end'; delta: number }
  | { kind: 'set'; edge: 'start' | 'end'; sec: number }
  | { kind: 'reset' }

/**
 * 카드 팝오버의 조작을 줄 보정값으로 바꾼다.
 * 시작은 0 이상, 끝은 시작 + `MIN_DISPLAY_SPAN_SEC` 이상이 되게 막는다.
 */
export function applySubtitleDisplayTimingEdit(
  lines: SubtitleLine[],
  index: number,
  edit: SubtitleDisplayTimingEdit
): SubtitleLine[] {
  const line = lines[index]
  if (!line) return lines
  let next: SubtitleLine
  if (edit.kind === 'reset') {
    next = withDisplayTiming(line, 0, 0)
  } else {
    const auto = subtitleAutoDisplayBounds(lines, index)
    if (!auto) return lines
    const adj = lineDisplayAdjust(line)
    let startSec = auto.start + adj.start
    let endSec = auto.end + adj.end
    if (edit.edge === 'start') {
      startSec = edit.kind === 'set' ? edit.sec : startSec + edit.delta
      if (!Number.isFinite(startSec)) return lines
      startSec = Math.max(0, Math.min(startSec, endSec - MIN_DISPLAY_SPAN_SEC))
    } else {
      endSec = edit.kind === 'set' ? edit.sec : endSec + edit.delta
      if (!Number.isFinite(endSec)) return lines
      endSec = Math.max(endSec, startSec + MIN_DISPLAY_SPAN_SEC, MIN_DISPLAY_SPAN_SEC)
    }
    next = withDisplayTiming(line, startSec - auto.start, endSec - auto.end)
  }
  if (next === line) return lines
  return lines.map((l, i) => (i === index ? next : l))
}
