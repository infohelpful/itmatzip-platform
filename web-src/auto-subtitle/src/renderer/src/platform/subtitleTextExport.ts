/**
 * Subtitle text exports, copied verbatim from the desktop main process (src/main/index.ts) so the
 * web build writes byte-identical SRT/VTT/ASS/TXT. Regenerate from the desktop repo, don't edit.
 */
import type { CutRange, ExportSubtitleStyle } from '../../../shared/ipc'
import { toAssTimestamp, toSrtTimestamp, toWebVttTimestamp } from '../../../shared/subtitleTimestamp'

type MappedSubtitle = { start: number; end: number; text: string }

export function normalizeCutRanges(ranges: CutRange[]): CutRange[] {
  const sorted = ranges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .map((r) => ({ start: Math.max(0, r.start), end: Math.max(0, r.end) }))
    .sort((a, b) => a.start - b.start)
  if (sorted.length <= 1) return sorted
  const out: CutRange[] = [sorted[0]]
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i]
    const last = out[out.length - 1]
    if (cur.start <= last.end + 0.001) last.end = Math.max(last.end, cur.end)
    else out.push({ ...cur })
  }
  return out
}

export function remapTimeByCuts(sec: number, cuts: CutRange[]): number {
  let shift = 0
  for (const c of cuts) {
    if (sec >= c.end) shift += c.end - c.start
    else if (sec > c.start) shift += sec - c.start
    else break
  }
  return Math.max(0, sec - shift)
}

export function buildMappedSubtitles(
  subtitles: Array<{ start: number; end: number; text: string }>,
  cuts: CutRange[]
): MappedSubtitle[] {
  const out: MappedSubtitle[] = []
  for (const item of subtitles) {
    const mappedStart = remapTimeByCuts(Number(item.start), cuts)
    const mappedEnd = remapTimeByCuts(Number(item.end), cuts)
    if (!(mappedEnd > mappedStart + 0.01)) continue
    const text = String(item.text ?? '').trim()
    if (!text) continue
    out.push({ start: mappedStart, end: mappedEnd, text })
  }
  return out
}

export function normalizeMappedSubtitles(subtitles: MappedSubtitle[]): MappedSubtitle[] {
  if (subtitles.length <= 1) return subtitles
  const sorted = [...subtitles].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: MappedSubtitle[] = []
  for (const cur of sorted) {
    const text = cur.text.trim()
    if (!text) continue
    if (out.length === 0) {
      if (cur.end > cur.start + 0.02) out.push({ ...cur, text })
      continue
    }
    const last = out[out.length - 1]
    // Touching cues replace each other directly; an inserted 10 ms gap flashes blank.
    const nextStart = Math.max(cur.start, last.end)
    if (cur.end <= nextStart + 0.01) continue
    out.push({ start: nextStart, end: cur.end, text })
  }
  return out
}

/**
 * Plain SubRip without SSA override tags. Players lay SRT out on a 384x288
 * script canvas, so a \pos() in video pixels pushed every cue off-screen.
 * Positioned captions belong in the ASS export.
 */
export function buildSrtText(subtitles: MappedSubtitle[]): string {
  const lines: string[] = []
  let cue = 1
  for (const item of subtitles) {
    const body = item.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (body.length === 0) continue
    lines.push(String(cue))
    lines.push(`${toSrtTimestamp(item.start)} --> ${toSrtTimestamp(item.end)}`)
    lines.push(...body)
    lines.push('')
    cue += 1
  }
  // CRLF is the SubRip convention; some Windows players require it.
  return lines.join('\r\n')
}

export function escapeWebVttText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function buildWebVttText(subtitles: MappedSubtitle[], style?: ExportSubtitleStyle): string {
  const xPct = Math.max(5, Math.min(95, Number(style?.x ?? 50)))
  const yFromBottom = Math.max(2, Math.min(98, Number(style?.y ?? 10)))
  const lineFromTopPct = Math.max(0, Math.min(100, 100 - yFromBottom))
  const cues = subtitles.map((item, i) => {
    const start = toWebVttTimestamp(item.start)
    const end = toWebVttTimestamp(item.end)
    const settings = `align:center position:${xPct}% line:${lineFromTopPct}%`
    const body = escapeWebVttText(item.text.trim())
    return `${i + 1}\n${start} --> ${end} ${settings}\n${body}`
  })
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

export function buildTxtText(subtitles: MappedSubtitle[]): string {
  const flatten = (s: string) =>
    s.replace(/\r\n|\r|\n/g, ' ').replace(/\s+/g, ' ').trim()
  return subtitles
    .map((item) => flatten(item.text))
    .filter((t) => t.length > 0)
    .join(' ')
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '').trim()
  const norm = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  if (!/^[0-9a-fA-F]{6}$/.test(norm)) return { r: 255, g: 255, b: 255 }
  const n = Number.parseInt(norm, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function toAssColor(hex: string, opacityPct = 100): string {
  const { r, g, b } = hexToRgb(hex)
  const alpha = Math.round(255 * (1 - Math.max(0, Math.min(1, opacityPct / 100))))
  const aa = alpha.toString(16).padStart(2, '0').toUpperCase()
  const bb = b.toString(16).padStart(2, '0').toUpperCase()
  const gg = g.toString(16).padStart(2, '0').toUpperCase()
  const rr = r.toString(16).padStart(2, '0').toUpperCase()
  return `&H${aa}${bb}${gg}${rr}`
}

export function escapeAssText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N')
}

export function buildAssText(subtitles: MappedSubtitle[], style?: ExportSubtitleStyle): string {
  const playResX = Math.max(320, Math.round(style?.videoWidth ?? 1920))
  const playResY = Math.max(240, Math.round(style?.videoHeight ?? 1080))
  const fontFamily = (style?.fontFamily?.trim() || 'Malgun Gothic').replace(/,/g, ' ')
  // 프리뷰와 1:1 매칭을 위해 보정 없이 그대로 사용
  const fontSize = Math.max(8, Math.round(style?.fontSize ?? 26))
  const bold = (style?.fontWeight ?? 700) >= 600 ? -1 : 0
  const outline = Math.max(0, Number(style?.strokeWidth ?? 2))
  const primary = toAssColor(style?.textColor ?? '#f4f6fb', 100)
  const strokeColor = toAssColor(style?.strokeColor ?? '#000000', 100)
  const bgOpacity = Math.max(0, Math.min(100, Number(style?.bgOpacity ?? 62)))
  const backColor = toAssColor(style?.bgColor ?? '#080a10', bgOpacity)
  const borderStyle = bgOpacity > 0 ? 3 : 1
  const outlineColor = borderStyle === 3 ? backColor : strokeColor
  // BorderStyle=3에서 Outline은 박스 패딩 역할도 하므로 과도하지 않게 고정
  const appliedOutline = borderStyle === 3 ? Math.max(1, Math.round(Math.max(1, outline))) : outline
  const marginH = Math.round(playResX * 0.05)

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    `Style: Default,${fontFamily},${fontSize},${primary},${primary},${outlineColor},${backColor},${bold},0,0,0,100,100,0,0,${borderStyle},${appliedOutline},0,2,${marginH},${marginH},20,1`,
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text'
  ]
  const lines = subtitles.map(
    (item) =>
      `Dialogue: 0,${toAssTimestamp(item.start)},${toAssTimestamp(item.end)},Default,,0,0,0,,${escapeAssText(item.text)}`
  )
  return [...header, ...lines, ''].join('\n')
}

