import { describe, expect, it } from 'vitest'
import {
  TIMING_CUT_GAP_PX, TIMING_PCM_RATE, chunkEnvelope, chunkIndices, chunkSlice, draftNeighbour, formatStripTime, layoutStrip,
  stripTime, stripX, timingStripRange
} from './wordTimingWaveform'

describe('timing strip range', () => {
  it('spans from the previous chip start to the next chip end', () => {
    expect(timingStripRange({ start: 2, end: 2.3 }, { start: 1.2 }, { end: 3.1 }, 600)).toEqual({ start: 1.2, end: 3.1 })
  })
  it('shows a short margin where there is no neighbouring chip, inside the media', () => {
    expect(timingStripRange({ start: .2, end: .4 }, undefined, undefined, .6)).toEqual({ start: 0, end: .6 })
    expect(timingStripRange({ start: 10, end: 11 }, undefined, undefined, 600)).toEqual({ start: 9.5, end: 11.5 })
  })
  it('formats labels as minutes, seconds and hundredths', () => {
    expect(formatStripTime(125.284)).toBe('02:05.28')
    expect(formatStripTime(3725.5, 3)).toBe('1:02:05.500')
  })
})

describe('pcm chunks', () => {
  const chunk = (value: number) => {
    const out = new Int16Array(TIMING_PCM_RATE * 2)
    out.fill(value)
    return out
  }
  it('mixes stereo int16 frames across chunk boundaries without normalising', () => {
    const chunks = new Map([[0, chunk(16384)], [1, chunk(-32768)]])
    expect(chunkEnvelope(chunks, TIMING_PCM_RATE - 2, TIMING_PCM_RATE + 2)).toEqual({ min: -1, max: 0.5 })
    expect(chunkEnvelope(chunks, 10.2, 10.4)).toEqual({ min: 0.5, max: 0.5 })
    expect(chunkEnvelope(chunks, 2 * TIMING_PCM_RATE, 2 * TIMING_PCM_RATE + 5)).toBeNull()
  })
  it('copies exact frame ranges for loop playback and lists the chunks a range needs', () => {
    const chunks = new Map([[0, chunk(1)], [1, chunk(2)]])
    const slice = chunkSlice(chunks, TIMING_PCM_RATE - 1, TIMING_PCM_RATE + 1)!
    expect([...slice]).toEqual([1, 1, 2, 2])
    expect(chunkSlice(chunks, 0, 3 * TIMING_PCM_RATE)).toBeNull()
    expect(chunkIndices(1.2, 3)).toEqual([1, 2])
    expect(chunkIndices(1.2, 3.01)).toEqual([1, 2, 3])
  })
})

describe('strip layout', () => {
  const pps = 100
  // a [1,2] touches b [2,3]; then 2 s of cut audio; c [5,6].
  const spans = [{ start: 1, end: 2 }, { start: 2, end: 3 }, { start: 5, end: 6 }]
  it('draws chips at real length, touching chips together and cut audio as a narrow gap', () => {
    const layout = layoutStrip(spans, 16, null, pps)
    expect(layout.xs).toEqual([16, 116, 216 + TIMING_CUT_GAP_PX])
    expect(layout.right).toBe(316 + TIMING_CUT_GAP_PX)
  })
  it('a short cut keeps its real width, so a trim closing it joins the chips smoothly', () => {
    const xs = layoutStrip([{ start: 0, end: 1 }, { start: 1.04, end: 2 }], 0, null, pps).xs
    expect(xs[1]).toBeCloseTo(104, 9)
  })
  it('keeps the anchored edge in place', () => {
    // Dragging b's start: b's end (3 s) stays where it was.
    const before = layoutStrip(spans, 16, null, pps)
    const endX = stripX(spans, before, 3, pps)
    const grown = [{ start: 1, end: 1.5 }, { start: 1.5, end: 3 }, spans[2]!]
    const after = layoutStrip(grown, 16, { index: 1, time: 3, x: endX }, pps)
    expect(stripX(grown, after, 3, pps)).toBe(endX)
    expect(stripX(grown, after, 1.5, pps)).toBe(endX - 150)
  })
  it('maps px back to time, snapping a px in a gap to the nearer chip edge', () => {
    const layout = layoutStrip(spans, 16, null, pps)
    expect(stripTime(spans, layout, 66, pps)).toBe(1.5)
    expect(stripTime(spans, layout, 218, pps)).toBe(3)
    expect(stripTime(spans, layout, 216 + TIMING_CUT_GAP_PX - 1, pps)).toBe(5)
    expect(stripTime(spans, layout, 9999, pps)).toBe(6)
    expect(stripX(spans, layout, 4, pps)).toBe(216 + TIMING_CUT_GAP_PX)
  })
})

describe('neighbours while a trim is dragged', () => {
  const word = { start: 2, end: 3 }
  it('a shared boundary follows the edge both ways', () => {
    expect(draftNeighbour({ start: 1, end: 2 }, 'previous', word, 2.3)).toEqual({ start: 1, end: 2.3 })
    expect(draftNeighbour({ start: 1, end: 2 }, 'previous', word, 1.6)).toEqual({ start: 1, end: 1.6 })
    expect(draftNeighbour({ start: 3, end: 4 }, 'next', word, 2.8)).toEqual({ start: 2.8, end: 4 })
  })
  it('across cut audio a live chip stays until the edge reaches it, then gives way or is absorbed', () => {
    expect(draftNeighbour({ start: 3.5, end: 4 }, 'next', word, 3.2)).toEqual({ start: 3.5, end: 4 })
    expect(draftNeighbour({ start: 3.5, end: 4 }, 'next', word, 3.7)).toEqual({ start: 3.7, end: 4 })
    expect(draftNeighbour({ start: 3.5, end: 4 }, 'next', word, 4)).toBeNull()
    expect(draftNeighbour({ start: 1, end: 1.5 }, 'previous', word, 2.4)).toEqual({ start: 1, end: 1.5 })
  })
  it('a deleted neighbour (cut) follows a shrinking edge across the gap', () => {
    expect(draftNeighbour({ start: 3.5, end: 4, isDeleted: true }, 'next', word, 2.7)).toEqual({ start: 2.7, end: 4 })
    expect(draftNeighbour({ start: 1, end: 1.5, isDeleted: true }, 'previous', word, 2.2)).toEqual({ start: 1, end: 2.2 })
  })
})
