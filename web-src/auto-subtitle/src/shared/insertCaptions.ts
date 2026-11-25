/**
 * Captions written on inserted clips, merged into the burn-in schedule. Original captions are never
 * shown during an inserted clip (their schedule leaves those frames empty), so the clip captions fill
 * exactly those frames; any one-frame overlap from rounding is trimmed so the states stay ordered.
 */
import { buildRenderSchedule, type RenderState } from './exportRenderSchedule'
import { insertCaptionCues, type MediaComposition } from './mediaComposition'

export function withInsertCaptions(states: readonly RenderState[], plan: MediaComposition | null | undefined, fps: number): RenderState[] {
  const cues = plan ? insertCaptionCues(plan) : []
  if (!cues.length) return [...states]
  // Identity mapping over each clip's own range: cue times are already finished-video times.
  const clips = cues.map((c, i) => ({ occurrenceId: `caption:${i}`, sourceStart: c.start, sourceEnd: c.end, programStart: c.start }))
  const captionStates = buildRenderSchedule({ cues, clips, fps, highlightWords: false })
  const merged = [...states, ...captionStates].sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame)
  const out: RenderState[] = []
  for (const state of merged) {
    const prev = out[out.length - 1]
    const startFrame = prev ? Math.max(state.startFrame, prev.endFrame) : state.startFrame
    if (state.endFrame > startFrame) out.push(startFrame === state.startFrame ? state : { ...state, startFrame })
  }
  return out
}

/** Text exports (SRT/VTT/ASS/TXT): clip captions added to the mapped cues, in time order. */
export function cuesWithInsertCaptions<T extends { start: number; end: number; text: string }>(
  cues: readonly T[], plan: MediaComposition | null | undefined
): Array<T | { start: number; end: number; text: string }> {
  const extra = plan ? insertCaptionCues(plan) : []
  return [...cues, ...extra].sort((a, b) => a.start - b.start)
}
