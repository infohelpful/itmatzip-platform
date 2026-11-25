/** Fixed time scale for the word timing strip: every chip is drawn at the same pixels per second. */
export const TIMING_PX_PER_SEC = 400
/** Prepared audio cache format (shared/pcmAudio.ts): interleaved s16le stereo, 48 kHz. */
export const TIMING_PCM_RATE = 48000
export const TIMING_PCM_CHANNELS = 2
/** Audio shown around a chip that has no neighbouring chip on that side (media start/end). */
export const TIMING_EDGE_MARGIN_SEC = .5

/** Strip range: from the previous chip's start to the next chip's end (only the chips connected to this one). */
export function timingStripRange(
  word: { start: number; end: number },
  previous: { start: number } | undefined,
  next: { end: number } | undefined,
  duration: number
): { start: number; end: number } {
  const start = previous ? Math.min(previous.start, word.start) : Math.max(0, word.start - TIMING_EDGE_MARGIN_SEC)
  const end = next ? Math.max(next.end, word.end) : Math.min(Math.max(duration, word.end), word.end + TIMING_EDGE_MARGIN_SEC)
  return { start, end: Math.max(end, start + .01) }
}

/** `mm:ss.cc` (or `h:mm:ss.cc`) for box and play line labels. */
export function formatStripTime(sec: number, decimals = 2): string {
  const unit = 10 ** decimals
  const total = Math.max(0, Math.round(sec * unit))
  const frac = String(total % unit).padStart(decimals, '0')
  const whole = Math.floor(total / unit)
  const mmss = `${String(Math.floor(whole / 60) % 60).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
  return `${whole >= 3600 ? `${Math.floor(whole / 3600)}:` : ''}${mmss}.${frac}`
}

/** One-second PCM chunks keyed by second index (chunk k covers [k, k+1) s). */
export type PcmChunks = ReadonlyMap<number, Int16Array>

/**
 * Min/max of the mono mix over frames [f0, f1) as -1..1 of full scale (no auto-gain, so the vertical
 * scale is identical for every chip). A pixel narrower than one frame uses the nearest frame.
 * Null when a needed chunk is not loaded yet.
 */
export function chunkEnvelope(chunks: PcmChunks, f0: number, f1: number): { min: number; max: number } | null {
  let a = Math.max(0, Math.floor(f0))
  let b = Math.ceil(f1)
  if (b <= a) {
    a = Math.max(0, Math.round((f0 + f1) / 2))
    b = a + 1
  }
  let min = Infinity
  let max = -Infinity
  let f = a
  while (f < b) {
    const k = Math.floor(f / TIMING_PCM_RATE)
    const chunk = chunks.get(k)
    if (!chunk) return null
    const frames = Math.floor(chunk.length / TIMING_PCM_CHANNELS)
    const stop = Math.min(b, (k + 1) * TIMING_PCM_RATE)
    for (let local = f - k * TIMING_PCM_RATE; f < stop && local < frames; f++, local++) {
      const v = (chunk[local * 2]! + chunk[local * 2 + 1]!) / 2 / 32768
      if (v < min) min = v
      if (v > max) max = v
    }
    if (f < stop) f = stop // short chunk at the end of the media: nothing more in this second
  }
  return min === Infinity ? { min: 0, max: 0 } : { min, max }
}

/** Interleaved stereo frames [f0, f1) copied out of the chunks, or null while any chunk is missing. */
export function chunkSlice(chunks: PcmChunks, f0: number, f1: number): Int16Array | null {
  const a = Math.max(0, Math.floor(f0))
  const b = Math.max(a, Math.ceil(f1))
  const out = new Int16Array((b - a) * TIMING_PCM_CHANNELS)
  for (let f = a; f < b;) {
    const k = Math.floor(f / TIMING_PCM_RATE)
    const chunk = chunks.get(k)
    if (!chunk) return null
    const stop = Math.min(b, (k + 1) * TIMING_PCM_RATE)
    const local = f - k * TIMING_PCM_RATE
    const part = chunk.subarray(local * 2, Math.min(chunk.length, (local + stop - f) * 2))
    out.set(part, (f - a) * 2)
    f = stop
  }
  return out
}

/** Second indices whose chunks cover [startSec, endSec). */
export function chunkIndices(startSec: number, endSec: number): number[] {
  const out: number[] = []
  for (let k = Math.max(0, Math.floor(startSec)); k < Math.ceil(endSec); k++) out.push(k)
  return out
}

// ---- strip layout: chips at real length, cut audio between them as a narrow gap ----------------

/** Hidden (cut) audio between two chips is drawn as this narrow gap, whatever its real length. */
export const TIMING_CUT_GAP_PX = 10
/** Chips closer than this share a boundary (no gap drawn). */
export const TIMING_SHARED_EDGE_SEC = 1e-6

export type StripSpan = { start: number; end: number }
/** `xs[i]`: left px of span i; `right`: px just after the last span. */
export type StripLayout = { xs: number[]; right: number }

/** Drawn width of the hidden audio between two chips: its real width, capped at the cut gap. */
export function cutGapPx(gapSec: number, pxPerSec = TIMING_PX_PER_SEC): number {
  return Math.max(0, Math.min(TIMING_CUT_GAP_PX, gapSec * pxPerSec))
}

/**
 * Lays time-ordered spans left to right. Without an anchor the first span starts at `pad`; with one,
 * source time `anchor.time` inside span `anchor.index` lands on `anchor.x` (the edge that is not being
 * dragged stays put while the other edge moves).
 */
export function layoutStrip(
  spans: readonly StripSpan[], pad: number, anchor?: { index: number; time: number; x: number } | null,
  pxPerSec = TIMING_PX_PER_SEC
): StripLayout {
  const rel: number[] = []
  let acc = 0
  spans.forEach((span, i) => {
    if (i > 0) acc += cutGapPx(span.start - spans[i - 1]!.end, pxPerSec)
    rel.push(acc)
    acc += (span.end - span.start) * pxPerSec
  })
  const a = anchor && spans[anchor.index] ? anchor : null
  const offset = a ? a.x - (rel[a.index]! + (a.time - spans[a.index]!.start) * pxPerSec) : pad
  return { xs: rel.map(r => r + offset), right: offset + acc }
}

/** Px of source time `t` (inside the hidden audio after span i it moves along the narrow gap). */
export function stripX(spans: readonly StripSpan[], layout: StripLayout, t: number, pxPerSec = TIMING_PX_PER_SEC): number {
  if (!spans.length) return 0
  if (t < spans[0]!.start) return layout.xs[0]! - (spans[0]!.start - t) * pxPerSec
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!
    if (t <= span.end) return layout.xs[i]! + Math.max(0, t - span.start) * pxPerSec
    const next = spans[i + 1]
    if (next && t < next.start) return layout.xs[i]! + (span.end - span.start) * pxPerSec + cutGapPx(t - span.end, pxPerSec)
  }
  const last = spans.length - 1
  return layout.xs[last]! + (t - spans[last]!.start) * pxPerSec
}

/** Source time under px; a px in a gap snaps to the nearer chip edge. */
export function stripTime(spans: readonly StripSpan[], layout: StripLayout, px: number, pxPerSec = TIMING_PX_PER_SEC): number {
  if (!spans.length) return 0
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!
    const x0 = layout.xs[i]!
    if (px < x0) {
      if (i === 0) return span.start
      const prevEnd = layout.xs[i - 1]! + (spans[i - 1]!.end - spans[i - 1]!.start) * pxPerSec
      return px - prevEnd < x0 - px ? spans[i - 1]!.end : span.start
    }
    if (px <= x0 + (span.end - span.start) * pxPerSec) return span.start + (px - x0) / pxPerSec
  }
  return spans[spans.length - 1]!.end
}

/**
 * Where a neighbour chip sits while the selected chip's edge is dragged to `edge`, mirroring
 * `editWordTiming`: a shared boundary follows the edge both ways, a cut follows a shrinking edge, and
 * any neighbour gives way to (or is absorbed by) a growing edge. Null when nothing of it is left.
 */
export function draftNeighbour(
  neighbour: StripSpan & { isDeleted?: boolean }, side: 'previous' | 'next',
  word: StripSpan, edge: number
): StripSpan | null {
  let { start, end } = neighbour
  if (side === 'previous') {
    const shared = Math.abs(end - word.start) < TIMING_SHARED_EDGE_SEC
    if (shared || edge < end || (neighbour.isDeleted && edge > word.start)) end = edge
  } else {
    const shared = Math.abs(start - word.end) < TIMING_SHARED_EDGE_SEC
    if (shared || edge > start || (neighbour.isDeleted && edge < word.end)) start = edge
  }
  return end - start > 1e-9 ? { start, end } : null
}
