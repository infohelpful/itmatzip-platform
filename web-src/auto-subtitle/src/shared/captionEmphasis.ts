/**
 * 자막 글자 강조(키워드 칩) — 편집 textarea 에서 드래그한 글자 범위를 줄에 저장한다.
 *
 * - 위치는 `subtitleLineEditDisplayText(line)`(= 편집 textarea 값)의 UTF-16 오프셋이다.
 * - `text` 는 저장 당시 강조된 글자 그대로다. 오프셋이 어긋나면(트림·정리 차이 등) 이 글자로 위치를 다시 찾는다.
 * - `color` 가 없으면 전체 강조 색을 따른다. 있으면 그 색이 우선한다.
 * - 단어 칩·타이밍과는 독립이다. 줄 텍스트가 바뀌면 `reconcileCaptionEmphasis` 가 위치를 따라 옮긴다.
 */
import { subtitleLineEditDisplayText, type SubtitleLine } from './subtitles'
import { scrubTimelineNoiseFromWordPiece, shouldOmitFromSubtitleEditLineText } from './wordContract'

export type CaptionEmphasis = {
  start: number
  end: number
  text: string
  /** 개별 강조 색(#rrggbb). 없으면 전체 강조 색 */
  color?: string
}

export const DEFAULT_EMPHASIS_COLOR = '#4F46E5'

const HEX_COLOR = /^#[0-9a-f]{6}$/i

export function isEmphasisHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value)
}

/** 저장 파일·외부 입력 → 안전한 범위 배열. 비면 `undefined`. */
export function parseCaptionEmphasis(raw: unknown): CaptionEmphasis[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: CaptionEmphasis[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    const start = r.start
    const end = r.end
    if (typeof start !== 'number' || typeof end !== 'number') continue
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) continue
    if (typeof r.text !== 'string' || r.text.length !== end - start) continue
    const range: CaptionEmphasis = { start, end, text: r.text }
    if (isEmphasisHexColor(r.color)) range.color = r.color
    out.push(range)
  }
  return out.length > 0 ? out : undefined
}

function sameRange(a: CaptionEmphasis, b: CaptionEmphasis): boolean {
  return a.start === b.start && a.end === b.end && a.text === b.text && (a.color ?? '') === (b.color ?? '')
}

export function sameCaptionEmphasis(
  a: readonly CaptionEmphasis[] | undefined,
  b: readonly CaptionEmphasis[] | undefined
): boolean {
  if (a === b) return true
  const x = a ?? []
  const y = b ?? []
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i++) if (!sameRange(x[i]!, y[i]!)) return false
  return true
}

function nearestOccurrence(text: string, needle: string, near: number): number {
  if (!needle) return -1
  let best = -1
  let bestDist = Infinity
  let from = text.indexOf(needle)
  while (from !== -1) {
    const dist = Math.abs(from - near)
    if (dist < bestDist) { best = from; bestDist = dist }
    from = text.indexOf(needle, from + 1)
  }
  return best
}

/**
 * 범위를 `text` 기준으로 검증한다. 오프셋의 글자가 다르면 같은 글자를 가장 가까운 곳에서 다시 찾고,
 * 못 찾으면 버린다. 시작 순으로 정렬하고 겹치는 범위는 앞의 것만 남긴다.
 */
export function resolveCaptionEmphasis(
  text: string,
  ranges: readonly CaptionEmphasis[] | undefined
): CaptionEmphasis[] {
  if (!ranges || ranges.length === 0 || !text) return []
  const found: CaptionEmphasis[] = []
  for (const r of ranges) {
    if (!r || typeof r.text !== 'string' || r.text.length === 0) continue
    let start = r.start
    if (text.slice(r.start, r.end) !== r.text || r.end - r.start !== r.text.length) {
      start = nearestOccurrence(text, r.text, r.start)
      if (start < 0) continue
    }
    const range: CaptionEmphasis = { start, end: start + r.text.length, text: r.text }
    if (isEmphasisHexColor(r.color)) range.color = r.color
    found.push(range)
  }
  found.sort((a, b) => a.start - b.start || a.end - b.end)
  const out: CaptionEmphasis[] = []
  for (const r of found) {
    const last = out[out.length - 1]
    if (last && r.start < last.end) continue
    out.push(r)
  }
  return out
}

export type EmphasisSegment = {
  start: number
  end: number
  text: string
  /** 강조 칩 색, 강조가 아니면 null */
  color: string | null
}

/** 텍스트를 강조/일반 조각으로 나눈다. 조각을 이어 붙이면 원문과 같다. */
export function captionEmphasisSegments(
  text: string,
  ranges: readonly CaptionEmphasis[] | undefined,
  defaultColor: string
): EmphasisSegment[] {
  const resolved = resolveCaptionEmphasis(text, ranges)
  const out: EmphasisSegment[] = []
  let cursor = 0
  for (const r of resolved) {
    if (r.start > cursor) out.push({ start: cursor, end: r.start, text: text.slice(cursor, r.start), color: null })
    out.push({ start: r.start, end: r.end, text: r.text, color: r.color ?? defaultColor })
    cursor = r.end
  }
  if (cursor < text.length) out.push({ start: cursor, end: text.length, text: text.slice(cursor), color: null })
  return out
}

function trimSelection(text: string, start: number, end: number): [number, number] {
  let s = Math.max(0, Math.min(start, end, text.length))
  let e = Math.min(text.length, Math.max(start, end, 0))
  while (s < e && /\s/.test(text[s]!)) s++
  while (e > s && /\s/.test(text[e - 1]!)) e--
  return [s, e]
}

/** `[start, end)` 와 겹치는 부분을 잘라낸다(바깥 부분은 남긴다). */
function cutRanges(text: string, ranges: readonly CaptionEmphasis[], start: number, end: number): CaptionEmphasis[] {
  const out: CaptionEmphasis[] = []
  const keep = (r: CaptionEmphasis, s: number, e: number) => {
    const [ts, te] = trimSelection(text, s, e)
    if (te <= ts) return
    const piece: CaptionEmphasis = { start: ts, end: te, text: text.slice(ts, te) }
    if (r.color) piece.color = r.color
    out.push(piece)
  }
  for (const r of ranges) {
    if (r.end <= start || r.start >= end) { out.push(r); continue }
    if (r.start < start) keep(r, r.start, start)
    if (r.end > end) keep(r, end, r.end)
  }
  return out
}

/** 선택 범위를 강조한다. 기존 강조와 겹치는 부분은 새 강조로 바뀐다. 선택이 공백뿐이면 그대로 둔다. */
export function addCaptionEmphasis(
  text: string,
  ranges: readonly CaptionEmphasis[] | undefined,
  selStart: number,
  selEnd: number,
  color?: string
): CaptionEmphasis[] {
  const current = resolveCaptionEmphasis(text, ranges)
  const [s, e] = trimSelection(text, selStart, selEnd)
  if (e <= s) return current
  const next = cutRanges(text, current, s, e)
  const added: CaptionEmphasis = { start: s, end: e, text: text.slice(s, e) }
  if (isEmphasisHexColor(color)) added.color = color
  next.push(added)
  return resolveCaptionEmphasis(text, next)
}

/** 선택 범위의 강조를 지운다. 선택이 없으면(커서만) 커서가 있는 강조 하나를 지운다. */
export function removeCaptionEmphasis(
  text: string,
  ranges: readonly CaptionEmphasis[] | undefined,
  selStart: number,
  selEnd: number
): CaptionEmphasis[] {
  const current = resolveCaptionEmphasis(text, ranges)
  const s = Math.min(selStart, selEnd)
  const e = Math.max(selStart, selEnd)
  if (s === e) return current.filter(r => !(r.start <= s && s <= r.end))
  return resolveCaptionEmphasis(text, cutRanges(text, current, s, e))
}

/** 선택 범위와 겹치는 강조가 있는지(강조 막대의 「해제」 표시·Ctrl+B 판단용). */
export function captionEmphasisOverlaps(
  text: string,
  ranges: readonly CaptionEmphasis[] | undefined,
  selStart: number,
  selEnd: number
): boolean {
  const s = Math.min(selStart, selEnd)
  const e = Math.max(selStart, selEnd)
  return resolveCaptionEmphasis(text, ranges).some(r => (s === e ? r.start <= s && s <= r.end : r.start < e && r.end > s))
}

/**
 * 한 텍스트가 다른 텍스트로 바뀔 때(입력·삭제·붙여넣기) 범위를 옮긴다.
 * 공통 앞부분·뒷부분 밖의 바뀐 구간만 편집으로 본다. 결과는 입력과 같은 순서이며, 사라진 범위는 null.
 */
export function mapEmphasisThroughTextEdit(
  prevText: string,
  nextText: string,
  ranges: readonly CaptionEmphasis[]
): Array<CaptionEmphasis | null> {
  if (prevText === nextText) return ranges.map(r => (prevText.slice(r.start, r.end) === r.text ? r : null))
  const la = prevText.length
  const lb = nextText.length
  const max = Math.min(la, lb)
  let p = 0
  while (p < max && prevText[p] === nextText[p]) p++
  let s = 0
  while (s < max - p && prevText[la - 1 - s] === nextText[lb - 1 - s]) s++
  const d = lb - la
  const aEnd = la - s
  const bEnd = lb - s
  const mapStart = (x: number) => (x < p ? x : x >= aEnd ? x + d : bEnd)
  const mapEnd = (y: number) => (y > aEnd ? y + d : y <= p ? y : bEnd)
  return ranges.map(r => {
    if (prevText.slice(r.start, r.end) !== r.text) {
      // 이미 어긋난 범위는 글자로 다시 찾는다.
      const at = nearestOccurrence(nextText, r.text, r.start)
      if (at < 0) return null
      return r.start === at ? r : { ...r, start: at, end: at + r.text.length }
    }
    const [ns, ne] = trimSelection(nextText, mapStart(r.start), mapEnd(r.end))
    if (ne <= ns) return null
    const out: CaptionEmphasis = { start: ns, end: ne, text: nextText.slice(ns, ne) }
    if (r.color) out.color = r.color
    return sameRange(out, r) ? r : out
  })
}

/** 줄의 강조 기준 텍스트(편집 textarea 값과 같다). */
export function captionEmphasisText(line: SubtitleLine): string {
  return subtitleLineEditDisplayText(line)
}

/** 줄에 강조 배열을 넣는다. 비면 키를 지운다. 내용이 같으면 원래 객체를 돌려준다. */
export function withCaptionEmphasis(line: SubtitleLine, ranges: readonly CaptionEmphasis[] | undefined): SubtitleLine {
  const next = ranges && ranges.length > 0 ? [...ranges] : undefined
  if (sameCaptionEmphasis(line.emphasis, next)) return line
  const out: SubtitleLine = { ...line }
  if (next) out.emphasis = next
  else delete out.emphasis
  return out
}

/** 사용자가 강조 메뉴로 직접 바꾼 줄 — 다음 `reconcileCaptionEmphasis` 에서 그대로 둔다. */
const userSetEmphasisLines = new WeakSet<SubtitleLine>()

/**
 * 강조 메뉴(강조·다른 색·해제)용. `withCaptionEmphasis` 와 같지만, 이 줄의 강조를 이번 변경의 최종값으로 표시해
 * 위치 추적이 이전 강조를 되살리지 않게 한다.
 */
export function withUserCaptionEmphasis(line: SubtitleLine, ranges: readonly CaptionEmphasis[] | undefined): SubtitleLine {
  const out = withCaptionEmphasis(line, ranges)
  if (out !== line) userSetEmphasisLines.add(out)
  return out
}

function hasEmphasis(lines: readonly SubtitleLine[]): boolean {
  for (const line of lines) if (line.emphasis && line.emphasis.length > 0) return true
  return false
}

/** 공통 앞뒤를 뺀 바뀐 구간으로 문자 위치를 옮기는 함수(바뀐 구간 안이면 null). */
function diffIndexMapper(a: string, b: string): (k: number) => number | null {
  if (a === b) return (k) => k
  const max = Math.min(a.length, b.length)
  let p = 0
  while (p < max && a[p] === b[p]) p++
  let s = 0
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  const aEnd = a.length - s
  const d = b.length - a.length
  return (k) => (k < p ? k : k >= aEnd ? k + d : null)
}

type CharRef = { line: number; offset: number }

/** 공백을 뺀 글자들과 각 글자의 (줄, 오프셋). */
function nonSpaceChars(texts: readonly string[]): { chars: string; refs: CharRef[] } {
  let chars = ''
  const refs: CharRef[] = []
  texts.forEach((text, line) => {
    for (let offset = 0; offset < text.length; offset++) {
      const ch = text[offset]!
      if (/\s/.test(ch)) continue
      chars += ch
      refs.push({ line, offset })
    }
  })
  return { chars, refs }
}

function mergeOwn(carried: CaptionEmphasis[], own: CaptionEmphasis[], text: string): CaptionEmphasis[] {
  if (own.length === 0) return resolveCaptionEmphasis(text, carried)
  // 이번 변경에서 새로 넣은 강조가 겹치는 기존 강조보다 우선한다.
  let base = resolveCaptionEmphasis(text, carried)
  for (const r of resolveCaptionEmphasis(text, own)) base = cutRanges(text, base, r.start, r.end)
  return resolveCaptionEmphasis(text, [...base, ...own])
}

/**
 * 줄 배열 변경(`prev` → `next`) 후 강조 위치를 새 텍스트에 맞춘다.
 *
 * - 바뀌지 않은 줄(같은 객체)은 건드리지 않는다.
 * - 줄 수가 같으면 같은 자리의 줄끼리 텍스트 차이로 옮긴다. 한 줄에서 사라진 강조는 바로 옆의 바뀐 줄에서
 *   같은 글자를 찾아 옮긴다(앞 줄로 합치기 등).
 * - 줄 수가 다르면(나누기·합치기·줄 삭제) 바뀐 구간의 줄들을 공백을 뺀 글자 순서로 이어 붙여 대응시킨다.
 * - 이번 변경에서 새로 넣은 강조(이전 줄들에 없던 객체)는 그대로 살린다.
 */
export function reconcileCaptionEmphasis(prev: readonly SubtitleLine[], next: SubtitleLine[]): SubtitleLine[] {
  if (prev === next) return next
  if (!hasEmphasis(prev) && !hasEmphasis(next)) return next

  const prevRangeObjects = new Set<CaptionEmphasis>()
  for (const line of prev) for (const r of line.emphasis ?? []) prevRangeObjects.add(r)
  const ownOf = (line: SubtitleLine) => (line.emphasis ?? []).filter(r => !prevRangeObjects.has(r))

  const assigned = new Map<number, CaptionEmphasis[]>()
  const textCache = new Map<SubtitleLine, string>()
  const textOf = (line: SubtitleLine) => {
    let t = textCache.get(line)
    if (t === undefined) { t = captionEmphasisText(line); textCache.set(line, t) }
    return t
  }

  if (prev.length === next.length) {
    const orphans: Array<{ range: CaptionEmphasis; from: number }> = []
    for (let i = 0; i < next.length; i++) {
      const p = prev[i]!
      const n = next[i]!
      if (p === n || userSetEmphasisLines.has(n)) continue
      const own = ownOf(n)
      const carried: CaptionEmphasis[] = []
      if (p.emphasis?.length) {
        const mapped = mapEmphasisThroughTextEdit(textOf(p), textOf(n), p.emphasis)
        mapped.forEach((r, k) => {
          if (r) carried.push(r)
          else orphans.push({ range: p.emphasis![k]!, from: i })
        })
      }
      if (carried.length || own.length || n.emphasis?.length) assigned.set(i, mergeOwn(carried, own, textOf(n)))
    }
    for (const { range, from } of orphans) {
      for (const j of [from - 1, from + 1]) {
        if (j < 0 || j >= next.length || next[j] === prev[j] || userSetEmphasisLines.has(next[j]!)) continue
        const text = textOf(next[j]!)
        const list = assigned.get(j) ?? resolveCaptionEmphasis(text, next[j]!.emphasis)
        if (!range.text) continue
        const at = j < from ? text.lastIndexOf(range.text) : text.indexOf(range.text)
        if (at < 0) continue
        const end = at + range.text.length
        // 옮겨 온 글자만 대상으로 한다: 앞 줄이면 원래 텍스트 뒤에 붙은 부분, 뒤 줄이면 앞에 붙은 부분.
        const grown = text.length - textOf(prev[j]!).length
        if (grown <= 0) continue
        if (j < from ? at < textOf(prev[j]!).length : end > grown) continue
        if (list.some(r => r.start < end && r.end > at)) continue
        const moved: CaptionEmphasis = { start: at, end, text: range.text }
        if (range.color) moved.color = range.color
        assigned.set(j, resolveCaptionEmphasis(text, [...list, moved]))
        break
      }
    }
  } else {
    let a = 0
    const minLen = Math.min(prev.length, next.length)
    while (a < minLen && prev[a] === next[a]) a++
    let k = 0
    while (k < minLen - a && prev[prev.length - 1 - k] === next[next.length - 1 - k]) k++
    const prevWin = prev.slice(a, prev.length - k)
    const nextWin = next.slice(a, next.length - k)
    const prevTexts = prevWin.map(textOf)
    const nextTexts = nextWin.map(textOf)
    const pa = nonSpaceChars(prevTexts)
    const na = nonSpaceChars(nextTexts)
    const mapIndex = diffIndexMapper(pa.chars, na.chars)
    // (이전 줄, 오프셋) → 공백 제외 글자 번호
    const prevIndexOf = prevWin.map(() => new Map<number, number>())
    pa.refs.forEach((ref, idx) => prevIndexOf[ref.line]!.set(ref.offset, idx))
    const carried = nextWin.map(() => [] as CaptionEmphasis[])
    prevWin.forEach((line, li) => {
      for (const r of resolveCaptionEmphasis(prevTexts[li]!, line.emphasis)) {
        const byLine = new Map<number, { s: number; e: number }>()
        for (let off = r.start; off < r.end; off++) {
          const idx = prevIndexOf[li]!.get(off)
          if (idx === undefined) continue
          const mapped = mapIndex(idx)
          if (mapped === null) continue
          const ref = na.refs[mapped]
          if (!ref) continue
          const span = byLine.get(ref.line)
          if (span) { span.s = Math.min(span.s, ref.offset); span.e = Math.max(span.e, ref.offset + 1) }
          else byLine.set(ref.line, { s: ref.offset, e: ref.offset + 1 })
        }
        for (const [nl, { s, e }] of byLine) {
          const [ts, te] = trimSelection(nextTexts[nl]!, s, e)
          if (te <= ts) continue
          const piece: CaptionEmphasis = { start: ts, end: te, text: nextTexts[nl]!.slice(ts, te) }
          if (r.color) piece.color = r.color
          carried[nl]!.push(piece)
        }
      }
    })
    nextWin.forEach((line, nl) => {
      if (userSetEmphasisLines.has(line)) return
      const own = ownOf(line)
      if (carried[nl]!.length || own.length || line.emphasis?.length) {
        assigned.set(a + nl, mergeOwn(carried[nl]!, own, nextTexts[nl]!))
      }
    })
  }

  if (assigned.size === 0) return next
  let changed = false
  const out = next.map((line, i) => {
    const ranges = assigned.get(i)
    if (ranges === undefined) return line
    const updated = withCaptionEmphasis(line, ranges)
    if (updated !== line) changed = true
    return updated
  })
  return changed ? out : next
}

/**
 * 단어 칩(저장 인덱스)별로 그 칩 글자와 겹치는 강조 범위.
 * 줄 텍스트가 칩 문장 그대로면 위치로, 사용자가 문구를 고쳤으면 칩 글자가 강조 글자에 들어 있는지로 판단한다
 * (이때는 처음 맞는 강조 하나만).
 */
export function emphasisRangesByWordIndex(line: SubtitleLine): Map<number, CaptionEmphasis[]> {
  const out = new Map<number, CaptionEmphasis[]>()
  if (!line.emphasis?.length || !line.words?.length) return out
  const text = captionEmphasisText(line)
  const ranges = resolveCaptionEmphasis(text, line.emphasis)
  if (ranges.length === 0) return out
  const pieces: Array<{ wi: number; piece: string }> = []
  line.words.forEach((w, wi) => {
    if (w.isDeleted || w.isSilence) return
    const piece = scrubTimelineNoiseFromWordPiece(w.word)
    if (piece.length === 0 || shouldOmitFromSubtitleEditLineText(piece)) return
    pieces.push({ wi, piece })
  })
  if (pieces.map(p => p.piece).join(' ') === text) {
    let offset = 0
    for (const { wi, piece } of pieces) {
      const s = offset
      const e = offset + piece.length
      const hits = ranges.filter(r => r.start < e && r.end > s)
      if (hits.length) out.set(wi, hits)
      offset = e + 1
    }
    return out
  }
  const norm = (s: string) => s.normalize('NFC').toLowerCase()
  for (const { wi, piece } of pieces) {
    const p = norm(piece)
    const hit = ranges.find(r => {
      const t = norm(r.text)
      return t.includes(p) || (p.length > 0 && p.includes(t))
    })
    if (hit) out.set(wi, [hit])
  }
  return out
}

/** 단어 칩(저장 인덱스)별 강조 색 — 칩 테두리 표시용(겹치는 첫 강조의 색). */
export function emphasisColorByWordIndex(line: SubtitleLine, defaultColor: string): Map<number, string> {
  const out = new Map<number, string>()
  for (const [wi, hits] of emphasisRangesByWordIndex(line)) out.set(wi, hits[0]!.color ?? defaultColor)
  return out
}

export type EmphasisRenderPiece = {
  /** 강조 칩 색, 일반 글자면 null */
  color: string | null
  /** `active` 는 현재 발화 단어(단어 강조) 글자 */
  parts: Array<{ text: string; active: boolean }>
}

/**
 * 렌더용 조각 — 강조 칩 단위로 나누고, 그 안을 현재 발화 단어 구간(`activeRange`)으로 다시 나눈다.
 * 모든 조각의 글자를 이어 붙이면 `text` 와 같다.
 */
export function emphasisRenderPieces(
  text: string,
  ranges: readonly CaptionEmphasis[] | undefined,
  defaultColor: string,
  activeRange?: readonly [number, number] | null
): EmphasisRenderPiece[] {
  return captionEmphasisSegments(text, ranges, defaultColor).map(seg => {
    const parts: EmphasisRenderPiece['parts'] = []
    const push = (s: number, e: number, active: boolean) => {
      if (e > s) parts.push({ text: text.slice(s, e), active })
    }
    if (!activeRange || activeRange[1] <= seg.start || activeRange[0] >= seg.end) {
      push(seg.start, seg.end, false)
    } else {
      const as = Math.max(seg.start, activeRange[0])
      const ae = Math.min(seg.end, activeRange[1])
      push(seg.start, as, false)
      push(as, ae, true)
      push(ae, seg.end, false)
    }
    return { color: seg.color, parts }
  })
}

/** `words.join(' ') === text` 일 때 `activeIndex` 단어의 글자 구간. */
export function activeWordCharRange(words: readonly string[] | undefined, activeIndex: number | undefined): [number, number] | null {
  if (!words || activeIndex === undefined || activeIndex < 0 || activeIndex >= words.length) return null
  let offset = 0
  for (let i = 0; i < activeIndex; i++) offset += words[i]!.length + 1
  return [offset, offset + words[activeIndex]!.length]
}
