import type { SubtitleLine } from './subtitles'
import type { CutRange } from './ipc'
import type { VirtualTimelineBlock } from './virtualTimeline'
import { mergeCutRanges } from './timelineCollapse'
import { applyProgramTimeRangeTombstoneCutToSubtitleLines } from './subtitleTombstoneCut'

/** Older files store the same cut in words, hard cuts and a derived virtual snapshot.
 * Materialize external ranges once at load so shrinking a cut cannot leave its old snapshot behind.
 * Word records then own every editable cut; save must not duplicate derived ranges again.
 */
export function materializeProjectCuts(
  lines: readonly SubtitleLine[], hardCuts: readonly CutRange[], blocks: readonly VirtualTimelineBlock[]
): SubtitleLine[] {
  const external=mergeCutRanges([...hardCuts,...blocks.filter(b=>b.isDeleted)
    .map(b=>({start:b.mediaStartSec,end:b.mediaEndSec}))])
  return external.reduce((result,cut)=>applyProgramTimeRangeTombstoneCutToSubtitleLines(result,cut.start,cut.end),lines as SubtitleLine[])
}
