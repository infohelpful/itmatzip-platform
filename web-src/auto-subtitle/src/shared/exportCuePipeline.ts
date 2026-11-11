/**
 * Phase 6 — 파일 내보내기(SRT·VTT·ASS·TXT)·영상 번인(`export:by-format`) 전에만 사용하는 큐.
 * 렌더러는 편집 SSOT(`SubtitleLine[]`)를 여기로 넘겨, tombstone·무음 더미를 제외한 보이는 텍스트 구간만 만든다.
 */
import type { SubtitleLine } from './subtitles'
import { subtitleCueLinesForExport, subtitleLineEditDisplayText, subtitleWordPiecesForExport } from './subtitles'
import { resolveCaptionEmphasis, type CaptionEmphasis } from './captionEmphasis'
import { hasDisplayTimingAdjust, subtitleDisplaySpans } from './subtitleDisplayTiming'

export type ExportCueWord = {
  start: number
  end: number
  text: string
}

export type ExportCueLine = {
  start: number
  end: number
  text: string
  /** 단어 강조 버닝용 발화 구간(원본 시간). 줄 `start`/`end` 와 별개이며 줄 텍스트 조각과 1:1 이다. */
  words?: ExportCueWord[]
  /** 영상 버닝용 강조 글자 범위(`text` 기준). `includeEmphasis` 일 때만 */
  emphasis?: CaptionEmphasis[]
}

export type BuildExportCueLinesOptions = {
  /** true 이면 영상 단어 강조 버닝용으로 단어 조각을 함께 싣는다. 기본 false(줄 단위만). */
  includeWords?: boolean
  /** true 이면 영상 버닝용으로 줄의 강조 글자 범위를 큐 텍스트 기준으로 옮겨 싣는다. 기본 false. */
  includeEmphasis?: boolean
}

/** 줄 강조(편집 텍스트 기준)를 내보내기 큐 텍스트 기준으로 옮긴다. */
function cueEmphasis(line: SubtitleLine | undefined, cueText: string): CaptionEmphasis[] {
  if (!line?.emphasis?.length) return []
  const source = subtitleLineEditDisplayText(line)
  const lead = source.length - source.trimStart().length
  const shifted = line.emphasis.map(r => ({ ...r, start: r.start - lead, end: r.end - lead }))
  return resolveCaptionEmphasis(cueText, shifted)
}

function captionWordPieces(text: string, source: ExportCueWord[]): ExportCueWord[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  if (!tokens.length || !source.length || tokens.join(' ') !== text) return source
  if (source.map(word => word.text).join(' ') === text) return source
  if (tokens.length === source.length) {
    return source.map((word, i) => ({ ...word, text: tokens[i]! }))
  }
  // Changed word counts have no measured alignment. Keep the original chips
  // untouched and distribute export-only highlight spans across their range.
  const start = source[0]!.start
  const end = source[source.length - 1]!.end
  const weights = tokens.map(token => Math.max(1, Array.from(token).length))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let used = 0
  return tokens.map((token, i) => {
    const wordStart = start + (end - start) * used / total
    used += weights[i]!
    return { start: wordStart, end: start + (end - start) * used / total, text: token }
  })
}

/** IPC `ExportRequest.subtitles` 및 메인 `buildMappedSubtitles` 입력 형태와 동일한 플랫 큐 */
export function buildExportCueLines(
  lines: readonly SubtitleLine[],
  options?: BuildExportCueLinesOptions
): ExportCueLine[] {
  const cues = subtitleCueLinesForExport(lines)
  const withEmphasis = options?.includeEmphasis === true && lines.some(line => line.emphasis?.length)
  if (!options?.includeWords && !withEmphasis) return cues
  // subtitleCueLinesForExport 는 tombstone·빈 텍스트 줄을 건너뛰므로 같은 규칙으로 줄을 다시 고른다.
  const kept: SubtitleLine[] = []
  for (const span of subtitleDisplaySpans(lines)) {
    const line = lines[span.index]
    if (subtitleCueLinesForExport([line]).length > 0) kept.push(line)
  }
  if (!options?.includeWords) {
    return cues.map((cue, i) => {
      const emphasis = cueEmphasis(kept[i], cue.text)
      return emphasis.length > 0 ? { ...cue, emphasis } : cue
    })
  }
  return cues.map((cue, i) => {
    const emphasis = withEmphasis ? cueEmphasis(kept[i], cue.text) : []
    const pieces = subtitleWordPiecesForExport(kept[i]?.words)
    const lastWord = kept[i]?.words?.filter(word => !word.isDeleted).at(-1)
    if (pieces.length > 0 && lastWord?.isSilence && lastWord.gapKind === 'unclassified') {
      const last = pieces[pieces.length - 1]
      // 수동으로 표시 끝을 당긴 줄은 단어 강조를 소리 끝보다 짧게 자르지 않는다.
      const end = hasDisplayTimingAdjust(kept[i]) ? Math.max(last.end, cue.end) : cue.end
      pieces[pieces.length - 1] = { ...last, end }
    }
    const captionPieces = captionWordPieces(cue.text, pieces)
    const out: ExportCueLine = captionPieces.length > 0 ? { ...cue, words: captionPieces } : cue
    return emphasis.length > 0 ? { ...out, emphasis } : out
  })
}
