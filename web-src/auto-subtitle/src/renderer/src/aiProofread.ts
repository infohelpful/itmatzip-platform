/**
 * AI 교정(Claude) — 보낼 단어 목록을 만들고, 돌아온 답을 기존 단어 위에 적용한다.
 *
 * - Claude 에는 글자만 간다: 보이는 단어 조각을 순서대로 번호 매긴 목록 + 각 줄이 시작하는 번호.
 * - 답은 단어 번호 기준(고친 글자, 새 줄 시작, 애매한 단어, 강조할 단어)이라 단어 시간·싱크는 그대로다.
 *   고친 글자는 줄의 편집 문구(`captionText`)로만 들어가고 칩·시간은 원본을 유지한다(`editSubtitleText` 와 같은 원칙).
 * - 줄 나누기·합치기는 편집기의 기존 연산(`splitSubtitleAtWordBoundary`, `mergeSubtitleIntoPrevious`)을 쓴다.
 * - 사용자가 문구를 직접 고쳐 단어 조각과 개수가 어긋난 줄은 글자를 바꾸지 않는다(어느 단어인지 보장 못 함).
 */
import type { SubtitleLine } from '../../shared/subtitles'
import { sourcePieces, editedCaptionOf, withCaption } from '../../shared/captionSplit'
import { addCaptionEmphasis, resolveCaptionEmphasis, withUserCaptionEmphasis } from '../../shared/captionEmphasis'
import { mergeSubtitleIntoPrevious, splitSubtitleAtWordBoundary } from './subtitleEditOps'
import { textDisplayUnits } from '../../shared/lineBreak'
import type { ProofreadAnswer } from './platform/aiAgent'

/** 이만큼 말이 끊긴 곳(인트로·음악·긴 쉼)은 앞뒤 줄을 합치지 않고, AI 에 쉼으로 알려 준다. */
export const PAUSE_HINT_SEC = 1
/** 이만큼 말이 끊긴 곳은 AI 답과 상관없이 반드시 줄을 나눈다. */
export const FORCE_SPLIT_SEC = 2

export type ProofreadUnit = {
  /** 단어 id(`SubtitleWord.id`) */
  id: string
  /** 보낼 때의 줄 인덱스 */
  line: number
  /** 지금 화면 문구 기준 글자 */
  text: string
  /** 문구를 직접 고쳐 단어와 어긋난 줄의 단어 — 글자를 바꾸지 않는다 */
  locked: boolean
  start: number
  end: number
  /** 바로 앞 말소리(보이는 단어) 끝에서 이 단어 시작까지 쉰 시간(초). 첫 단어는 0 */
  gapBefore: number
}

export type ProofreadSource = {
  units: ProofreadUnit[]
  lineStarts: number[]
  /** `PAUSE_HINT_SEC` 이상 쉰 뒤 시작하는 단어 번호와 쉰 시간 */
  pauses: { id: number; sec: number }[]
}

export function proofreadSource(lines: readonly SubtitleLine[]): ProofreadSource {
  const units: ProofreadUnit[] = []
  const lineStarts: number[] = []
  lines.forEach((line, li) => {
    if (line.isDeleted || !line.words?.length) return
    const perWord = line.words.map(w => (w.isDeleted || w.isSilence ? [] : sourcePieces([w])))
    const total = perWord.reduce((n, p) => n + p.length, 0)
    if (total === 0) return
    const caption = editedCaptionOf(line)
    const capTokens = caption === undefined ? null : caption.split(/\s+/).filter(Boolean)
    const aligned = capTokens === null || capTokens.length === total
    let k = 0
    let first = true
    line.words.forEach((w, wi) => {
      const pieces = perWord[wi]!
      if (pieces.length === 0 || !w.id) return
      const text = capTokens && aligned ? capTokens.slice(k, k + pieces.length).join(' ') : pieces.join(' ')
      k += pieces.length
      if (first) { lineStarts.push(units.length); first = false }
      const prev = units[units.length - 1]
      const gapBefore = prev ? Math.max(0, w.start - prev.end) : 0
      units.push({ id: w.id, line: li, text, locked: !aligned, start: w.start, end: w.end, gapBefore })
    })
  })
  const pauses = units.flatMap((u, g) =>
    g > 0 && u.gapBefore >= PAUSE_HINT_SEC ? [{ id: g, sec: Math.round(u.gapBefore * 10) / 10 }] : [])
  return { units, lineStarts, pauses }
}

export type ProofreadChange = { id: string; before: string; after: string; start: number }
export type ProofreadFlag = { id: string; text: string; reason: string; start: number }

export type ProofreadResult = {
  lines: SubtitleLine[]
  changes: ProofreadChange[]
  uncertain: ProofreadFlag[]
  emphasized: string[]
  lineCountBefore: number
  lineCountAfter: number
  /** 말소리 없는 줄을 묶어 줄어든 줄 수 */
  silentMerged: number
}

function liveLineCount(lines: readonly SubtitleLine[]): number {
  return lines.filter(l => !l.isDeleted && (l.words ?? []).some(w => !w.isDeleted && !w.isSilence)).length
}

/** 화면 폭 단위 — 한글·전각 1, 영문·숫자·공백·문장부호 0.5 (AI 에 알려 준 규칙과 같다) */
export function lineWidthUnits(text: string): number {
  return textDisplayUnits(text)
}

/** 끊기 좋은 자리: 문장 끝 > 쉼표·연결 어미 > 목적어·부사어 조사 뒤 */
const STRONG_END = /[.?!…]["')\]]*$/
const SOFT_END = new RegExp('[,;:]$|(?:고|는데|은데|던데|인데|서|면|지만|며|면서|니까|으니|어서|아서|해서|하고|거나|든지|'
  + '도록|려고|게|는지|은지|을지|던지|다가|어도|아도|해도|므로|라서|이라|이고|구요|고요|는데요|어요|아요|죠)$')
const PHRASE_END = /(?:을|를|에서|에게|에서는|에는|으로|로|와|과|하고|부터|까지|처럼|보다|만|도|은|는|이|가)$/
/** 목표 길이의 이 배수를 넘는 줄은 읽기 쉽게 나눈다(18자 목표 → 24자 넘으면) */
const SOFT_LIMIT_RATIO = 4 / 3
/** 한쪽이 이보다 짧으면(한두 단어) 피한다 */
const MIN_SIDE_UNITS = 6
/** 문장 끝 — 이 뒤는 새 줄(문장끼리 한 줄에 섞지 않는다). 구두점이 없는 자막은 다/요/죠/까/네 로 끝나는 말도 문장 끝으로 본다. */
const SENTENCE_END = /(?:[.?!…]|[다요죠까네])["')\]]*$/
/** 이어지는 말인데 이보다 짧게 혼자 남은 줄(예: "했습니다.")은 앞 말과 다시 맞춘다 */
const ORPHAN_UNITS = 10

// 사이를 끊으면 어색한 짝: "쓸 | 수 있는", "하시는 | 분들도", "이어지기 | 때문에", "하지 | 않는"
const BOUND_NOUN = /^(?:수|것|거|때|줄|번|적|데|뿐|듯|분|바|리)(?:들)?(?:[은는이가을를도만의에])?$|^(?:뒤|후|동안|사이|만큼|대로)(?:[에는도은이가])?$/
const ATTACH_AFTER = /^(?:때문|위해|위한|통해|대해|대한|따라|같은|같이)/
function endsAdnominal(token: string): boolean {
  const ch = token.replace(/["')\]]+$/, '').slice(-1)
  if (!ch) return false
  if ('는은을던'.includes(ch)) return true
  const code = ch.charCodeAt(0) - 0xac00
  return code >= 0 && code <= 11171 && (code % 28 === 4 || code % 28 === 8) // 받침 ㄴ·ㄹ
}
/** `prev` 와 `next` 사이에서 줄을 끊으면 읽을 때 어색한가 */
export function tightPair(prev: string, next: string): boolean {
  if (ATTACH_AFTER.test(next)) return true
  if (BOUND_NOUN.test(next) && endsAdnominal(prev)) return true
  return /^(?:않|못|말)/.test(next) && /지$/.test(prev)
}

/**
 * 줄을 나눌 단어 위치(왼쪽 줄 단어 수, 1..n-1). 왼쪽이 `maxUnits` 안에 들어가는 자리 중
 * 문장 끝 > 쉼표·연결 어미 > 조사 뒤 순으로 고르고, 너무 짧은 쪽이 생기는 자리는 피하며,
 * 같으면 양쪽 길이가 고른 쪽.
 */
export function bestBreak(tokens: readonly string[], maxUnits: number, minSide: number = MIN_SIDE_UNITS): number {
  const widths = tokens.map(t => lineWidthUnits(t))
  const total = widths.reduce((a, b) => a + b, 0) + Math.max(0, tokens.length - 1) * 0.5
  let best = Math.ceil(tokens.length / 2)
  let bestScore = -Infinity
  let left = 0
  for (let k = 1; k < tokens.length; k++) {
    left += widths[k - 1]! + (k > 1 ? 0.5 : 0)
    const right = total - left - 0.5
    const prev = tokens[k - 1]!
    let score = -Math.abs(left - right)
    if (STRONG_END.test(prev)) score += 1000
    else if (SOFT_END.test(prev)) score += 500
    else if (PHRASE_END.test(prev)) score += 200
    if (Math.min(left, right) < minSide) score -= 600
    if (tightPair(prev, tokens[k]!)) score -= 800
    if (left > maxUnits) score -= 10_000
    if (score > bestScore) { bestScore = score; best = k }
  }
  return best
}

export function applyProofread(
  lines: readonly SubtitleLine[],
  source: ProofreadSource,
  answer: ProofreadAnswer,
  options: { emphasisColor?: string; maxUnits?: number; targetUnits?: number; fitLines?: boolean } = {}
): ProofreadResult {
  const { units } = source
  const n = units.length
  const inRange = (g: unknown): g is number => Number.isInteger(g) && (g as number) >= 0 && (g as number) < n
  const corrections = new Map<number, string>()
  for (const c of answer.corrections) {
    if (inRange(c.id) && !units[c.id]!.locked && typeof c.text === 'string' && c.text !== units[c.id]!.text) {
      corrections.set(c.id, c.text.trim().replace(/\s+/g, ' '))
    }
  }
  const starts = new Set(answer.lineStarts.filter(inRange))
  starts.add(0)
  // 말소리가 없는 긴 구간(인트로·음악 등) 뒤는 무조건 새 줄 — 다른 말과 한 줄로 섞이지 않게.
  units.forEach((u, g) => { if (g > 0 && u.gapBefore >= FORCE_SPLIT_SEC) starts.add(g) })
  const gOf = new Map(units.map((u, g) => [u.id, g]))

  let next = [...lines]
  const lineOf = (id: string): number => next.findIndex(l => l.words?.some(w => w.id === id))
  const unitsOfLine = (li: number): number[] => (next[li]?.words ?? [])
    .map(w => (w.id ? gOf.get(w.id) : undefined)).filter((g): g is number => g !== undefined)
  const textOf = (gs: number[]) => gs.map(g => corrections.get(g) ?? units[g]!.text).filter(Boolean).join(' ')

  // 1) 지금은 줄 시작인데 답에서는 아닌 곳 → 바로 앞 줄과 합친다(배열에서 이웃이고 숨김 상태가 같을 때만).
  for (const s of [...source.lineStarts].reverse()) {
    if (s === 0 || starts.has(s) || units[s]!.gapBefore >= PAUSE_HINT_SEC) continue
    const li = lineOf(units[s]!.id)
    const pli = lineOf(units[s - 1]!.id)
    if (li <= 0 || pli !== li - 1 || !!next[li]!.isHidden !== !!next[pli]!.isHidden) continue
    // AI 가 이상하게 답해도 화면 한 줄을 넘는 줄은 만들지 않는다.
    // (fitLines 는 AI 가 정한 줄 구조를 먼저 그대로 만든 뒤 아래 2a 에서 길이를 맞춘다)
    if (options.maxUnits && !options.fitLines
      && lineWidthUnits(textOf([...unitsOfLine(pli), ...unitsOfLine(li)])) > options.maxUnits) continue
    next = mergeSubtitleIntoPrevious(next, li) ?? next
  }
  // 2) 답에서 새로 생긴 줄 시작 → 그 단어 앞에서 나눈다.
  for (const s of [...starts].sort((a, b) => a - b)) {
    if (s === 0) continue
    const id = units[s]!.id
    const li = lineOf(id)
    if (li < 0 || li !== lineOf(units[s - 1]!.id)) continue
    const wi = next[li]!.words!.findIndex(w => w.id === id)
    next = splitSubtitleAtWordBoundary(next, li, wi)
  }

  // 2a) 읽기 좋은 줄 맞춤(fitLines): AI 는 끊을 자리(문맥)만 정하고, 길이 규칙은 여기서 지킨다.
  //     - 한 문장이 화면 한 줄에 들어가면 한 줄로 합친다.
  //     - 한 줄에 안 들어가는 문장은 AI 가 정한 자리에서 나누되, 끝에 "했습니다." 같은 짧은 토막만 남으면
  //       앞에서 다시 끊어 이어지는 말을 같이 넘긴다.
  //     - 문장 끝·쉬는 구간(1초 이상)·숨김 상태가 다른 줄 사이는 건드리지 않는다.
  if (options.fitLines && options.maxUnits) {
    const limit = options.maxUnits
    const tokenOf = (g: number) => corrections.get(g) ?? units[g]!.text
    const widthOf = (gs: number[]) => lineWidthUnits(gs.map(tokenOf).filter(Boolean).join(' '))
    const continues = (i: number): boolean => {
      if (i <= 0) return false
      const prev = unitsOfLine(i - 1)
      const cur = unitsOfLine(i)
      if (prev.length === 0 || cur.length === 0) return false
      if (!!next[i]!.isHidden !== !!next[i - 1]!.isHidden) return false
      if (units[cur[0]!]!.gapBefore >= PAUSE_HINT_SEC) return false
      if ([...prev, ...cur].some(g => units[g]!.locked)) return false
      return !SENTENCE_END.test(tokenOf(prev[prev.length - 1]!))
    }
    for (let pass = 0; pass < 6; pass++) {
      let changed = false
      for (let i = next.length - 1; i > 0; i--) {
        if (!continues(i)) continue
        const prev = unitsOfLine(i - 1)
        const cur = unitsOfLine(i)
        const merged = [...prev, ...cur]
        if (widthOf(merged) <= limit) {
          const m = mergeSubtitleIntoPrevious(next, i)
          if (m) { next = m; changed = true }
          continue
        }
        const tight = tightPair(tokenOf(prev[prev.length - 1]!), tokenOf(cur[0]!))
        if (widthOf(cur) >= ORPHAN_UNITS && !tight) continue
        const k = bestBreak(merged.map(tokenOf), limit, ORPHAN_UNITS)
        if (k === prev.length) continue
        const m = mergeSubtitleIntoPrevious(next, i)
        if (!m) continue
        const li = i - 1
        const split = splitSubtitleAtWordBoundary(m, li, m[li]!.words!.findIndex(w => w.id === units[merged[k]!]!.id))
        if (split.length === m.length + 1) { next = split; changed = true }
      }
      if (!changed) break
    }
  }

  // 2b) 그래도 화면 한 줄을 넘는 줄은 두 줄로 넘어가지 않게 의미 단위에서 더 나눈다.
  // 2b') 읽기 쉽게: 목표보다 많이 긴 줄은 AI 답과 상관없이 의미 단위에서 나눈다(작은 모델은 줄 나누기를 잘 안 지킨다).
  //       한쪽이 한두 단어만 남는 자리밖에 없으면 그대로 둔다.
  const splitWider = (limit: number, allowShort: boolean): void => {
    const skip = new Set<string>()
    for (let guard = 0; guard < 10_000; guard++) {
      const li = next.findIndex((line, i) => {
        const gs = unitsOfLine(i)
        return gs.length >= 2 && !skip.has(units[gs[0]!]!.id) && !gs.some(g => units[g]!.locked)
          && lineWidthUnits(textOf(gs)) > limit
      })
      if (li < 0) break
      const gs = unitsOfLine(li)
      const tokens = gs.map(g => corrections.get(g) ?? units[g]!.text)
      const k = bestBreak(tokens, limit)
      const leftW = lineWidthUnits(tokens.slice(0, k).filter(Boolean).join(' '))
      const rightW = lineWidthUnits(tokens.slice(k).filter(Boolean).join(' '))
      if (!allowShort && Math.min(leftW, rightW) < MIN_SIDE_UNITS) { skip.add(units[gs[0]!]!.id); continue }
      const wi = next[li]!.words!.findIndex(w => w.id === units[gs[k]!]!.id)
      const split = splitSubtitleAtWordBoundary(next, li, wi)
      if (split.length === next.length) { skip.add(units[gs[0]!]!.id); continue }
      next = split
    }
  }
  if (options.maxUnits) splitWider(options.maxUnits, true)
  if (options.targetUnits) {
    const soft = Math.min(options.maxUnits ?? Infinity, Math.round(options.targetUnits * SOFT_LIMIT_RATIO))
    splitWider(soft, false)
  }

  // 2c) 말소리가 없는 줄(오프닝·음악 등 "--"·"오디오" 칩만 있는 줄)이 연달아 있으면 한 줄로 묶는다.
  const silentRow = (i: number): boolean => {
    const line = next[i]!
    return !line.isDeleted && (line.words?.length ?? 0) > 0 && unitsOfLine(i).length === 0
  }
  let silentMerged = 0
  for (let i = next.length - 1; i > 0; i--) {
    if (silentRow(i) && silentRow(i - 1) && !!next[i]!.isHidden === !!next[i - 1]!.isHidden) {
      const merged = mergeSubtitleIntoPrevious(next, i)
      if (merged) { next = merged; silentMerged++ }
    }
  }

  // 3) 줄 문구 · 강조
  const emphasisIds = new Set(answer.emphasis.filter(inRange))
  const emphasized: string[] = []
  next = next.map(line => {
    const gs = (line.words ?? []).map(w => (w.id ? gOf.get(w.id) : undefined)).filter((g): g is number => g !== undefined)
    if (gs.length === 0 || gs.some(g => units[g]!.locked)) return line
    const touched = gs.some(g => corrections.has(g) || emphasisIds.has(g))
    if (!touched) return line
    const tokens = gs.map(g => corrections.get(g) ?? units[g]!.text)
    const text = tokens.filter(Boolean).join(' ')
    let out = withCaption(line, text)
    const marks = gs.filter(g => emphasisIds.has(g))
    if (marks.length > 0) {
      let ranges = resolveCaptionEmphasis(text, out.emphasis)
      let offset = 0
      gs.forEach((g, i) => {
        const tok = tokens[i]!
        if (!tok) return
        if (emphasisIds.has(g)) {
          ranges = addCaptionEmphasis(text, ranges, offset, offset + tok.length, options.emphasisColor)
          emphasized.push(units[g]!.id)
        }
        offset += tok.length + 1
      })
      out = withUserCaptionEmphasis(out, ranges)
    }
    return out
  })

  return {
    lines: next,
    changes: [...corrections].map(([g, after]) => ({ id: units[g]!.id, before: units[g]!.text, after, start: units[g]!.start })),
    uncertain: answer.uncertain.filter(u => inRange(u.id)).map(u => ({
      id: units[u.id]!.id, text: units[u.id]!.text, reason: u.reason, start: units[u.id]!.start
    })),
    emphasized,
    lineCountBefore: liveLineCount(lines),
    lineCountAfter: liveLineCount(next),
    silentMerged
  }
}
