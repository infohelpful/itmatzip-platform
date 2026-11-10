import { describe, expect, it } from 'vitest'
import { DEFAULT_WATERMARK, exportWatermarkOf, fillScheduleGaps, normalizeWatermark, watermarkRect } from './watermark'

describe('watermarkRect', () => {
  it('places the image in each corner with a margin of 3% of the short side', () => {
    const p = { sizePct: 10 }
    // 1920x1080, 200x100 image -> 192x96, margin 32.4
    expect(watermarkRect(1920, 1080, 200, 100, { ...p, corner: 'top-left' })).toEqual({ x: 32.4, y: 32.4, width: 192, height: 96 })
    const br = watermarkRect(1920, 1080, 200, 100, { ...p, corner: 'bottom-right' })
    expect(br.x).toBeCloseTo(1920 - 32.4 - 192)
    expect(br.y).toBeCloseTo(1080 - 32.4 - 96)
  })

  it('scales with the frame so a downscaled render keeps the same relative position', () => {
    const full = watermarkRect(1920, 1080, 300, 300, { corner: 'top-right', sizePct: 20 })
    const half = watermarkRect(960, 540, 300, 300, { corner: 'top-right', sizePct: 20 })
    expect(half.x * 2).toBeCloseTo(full.x)
    expect(half.width * 2).toBeCloseTo(full.width)
  })

  it('limits tall images to the frame height', () => {
    const r = watermarkRect(1920, 1080, 100, 1000, { corner: 'top-left', sizePct: 50 })
    expect(r.y + r.height).toBeLessThanOrEqual(1080)
    expect(r.width / r.height).toBeCloseTo(0.1)
  })
})

describe('fillScheduleGaps', () => {
  it('covers the whole program with blank states between subtitles', () => {
    const s = [
      { startFrame: 10, endFrame: 20, text: 'a', activeIndex: -1 },
      { startFrame: 20, endFrame: 30, text: 'b', activeIndex: -1 },
      { startFrame: 40, endFrame: 50, text: 'c', activeIndex: -1 }
    ]
    const out = fillScheduleGaps(s, 60)
    expect(out.map((x) => [x.startFrame, x.endFrame, x.text])).toEqual([
      [0, 10, ''], [10, 20, 'a'], [20, 30, 'b'], [30, 40, ''], [40, 50, 'c'], [50, 60, '']
    ])
  })

  it('makes one blank state when there are no subtitles', () => {
    expect(fillScheduleGaps([], 90)).toEqual([{ startFrame: 0, endFrame: 90, text: '', activeIndex: -1 }])
  })
})

describe('normalizeWatermark', () => {
  it('falls back to defaults and clamps values', () => {
    expect(normalizeWatermark(null)).toEqual(DEFAULT_WATERMARK)
    const n = normalizeWatermark({ corner: 'middle', transparency: 500, sizePct: -1, imageDataUrl: 'javascript:alert(1)' })
    expect(n.corner).toBe('bottom-right')
    expect(n.transparency).toBe(90)
    expect(n.sizePct).toBe(3)
    expect(n.imageDataUrl).toBeNull()
  })

  it('only exports when enabled with an image', () => {
    const img = 'data:image/png;base64,AAAA'
    expect(exportWatermarkOf({ ...DEFAULT_WATERMARK, imageDataUrl: img })).toMatchObject({ imageDataUrl: img })
    expect(exportWatermarkOf({ ...DEFAULT_WATERMARK, imageDataUrl: img, enabled: false })).toBeUndefined()
    expect(exportWatermarkOf(DEFAULT_WATERMARK)).toBeUndefined()
  })
})
