/**
 * 워터마크 — 자막 입힌 영상 내보내기에서 모든 프레임의 한 모서리에 이미지를 찍는다.
 *
 * 설정은 브라우저(localStorage)에 남겨 다음 작업에서도 그대로 쓴다.
 * 위치·크기는 영상 크기에 대한 비율이라 렌더 해상도(최대 1080p로 줄인 캔버스)와 상관없이 같은 자리에 놓인다.
 */
import type { RenderState } from './exportRenderSchedule'

export type WatermarkCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export type WatermarkSettings = {
  /** 꺼 두면 이미지는 남기고 내보내기에만 넣지 않는다 */
  enabled: boolean
  /** data: URL (PNG/WebP). 없으면 워터마크 없음 */
  imageDataUrl: string | null
  corner: WatermarkCorner
  /** 0 = 선명, 90 = 거의 안 보임 */
  transparency: number
  /** 영상 너비에 대한 워터마크 너비(%) */
  sizePct: number
}

/** 내보내기 요청에 싣는 값 — 켜져 있고 이미지가 있을 때만 만든다 */
export type ExportWatermark = {
  imageDataUrl: string
  corner: WatermarkCorner
  transparency: number
  sizePct: number
}

export const WATERMARK_STORAGE_KEY = 'autosubtitle.watermark'
export const WATERMARK_SIZE_MIN = 3
export const WATERMARK_SIZE_MAX = 50
export const WATERMARK_TRANSPARENCY_MAX = 90
/** 모서리에서 띄우는 거리 — 영상 짧은 변의 비율 */
export const WATERMARK_MARGIN_RATIO = 0.03

export const WATERMARK_CORNERS: ReadonlyArray<{ value: WatermarkCorner; label: string }> = [
  { value: 'top-left', label: '왼쪽 위' },
  { value: 'top-right', label: '오른쪽 위' },
  { value: 'bottom-left', label: '왼쪽 아래' },
  { value: 'bottom-right', label: '오른쪽 아래' }
]

export const DEFAULT_WATERMARK: WatermarkSettings = {
  enabled: true,
  imageDataUrl: null,
  corner: 'bottom-right',
  transparency: 20,
  sizePct: 15
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function normalizeWatermark(raw: unknown): WatermarkSettings {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const corner = WATERMARK_CORNERS.some((c) => c.value === src.corner) ? (src.corner as WatermarkCorner) : DEFAULT_WATERMARK.corner
  const url = typeof src.imageDataUrl === 'string' && /^data:image\/(png|jpeg|webp|gif|svg\+xml);/.test(src.imageDataUrl)
    ? src.imageDataUrl
    : null
  return {
    enabled: src.enabled !== false,
    imageDataUrl: url,
    corner,
    transparency: clampNumber(src.transparency, 0, WATERMARK_TRANSPARENCY_MAX, DEFAULT_WATERMARK.transparency),
    sizePct: clampNumber(src.sizePct, WATERMARK_SIZE_MIN, WATERMARK_SIZE_MAX, DEFAULT_WATERMARK.sizePct)
  }
}

export function exportWatermarkOf(settings: WatermarkSettings): ExportWatermark | undefined {
  if (!settings.enabled || !settings.imageDataUrl) return undefined
  return {
    imageDataUrl: settings.imageDataUrl,
    corner: settings.corner,
    transparency: settings.transparency,
    sizePct: settings.sizePct
  }
}

/** 프레임(frameW×frameH) 안에서 워터마크를 그릴 사각형 */
export function watermarkRect(
  frameW: number, frameH: number, imageW: number, imageH: number,
  placement: { corner: WatermarkCorner; sizePct: number }
): { x: number; y: number; width: number; height: number } {
  const margin = Math.min(frameW, frameH) * WATERMARK_MARGIN_RATIO
  let width = frameW * placement.sizePct / 100
  let height = imageW > 0 ? width * imageH / imageW : 0
  // 세로로 긴 이미지가 화면을 넘지 않게 높이도 막는다.
  const maxH = Math.max(1, frameH - margin * 2)
  if (height > maxH) {
    width = width * maxH / height
    height = maxH
  }
  const right = placement.corner === 'top-right' || placement.corner === 'bottom-right'
  const bottom = placement.corner === 'bottom-left' || placement.corner === 'bottom-right'
  return {
    x: right ? frameW - margin - width : margin,
    y: bottom ? frameH - margin - height : margin,
    width,
    height
  }
}

/**
 * 에이전트는 상태가 없는 프레임을 빈 오버레이로 채운다. 워터마크는 자막이 없는 구간에도 보여야 하므로
 * 빈 구간을 텍스트 없는 상태로 채워 0 ~ totalFrames 전체를 덮는다.
 */
export function fillScheduleGaps(schedule: readonly RenderState[], totalFrames: number): RenderState[] {
  const out: RenderState[] = []
  let cursor = 0
  const blank = (startFrame: number, endFrame: number): RenderState => ({ startFrame, endFrame, text: '', activeIndex: -1 })
  for (const state of schedule) {
    if (state.startFrame > cursor) out.push(blank(cursor, state.startFrame))
    out.push(state)
    cursor = Math.max(cursor, state.endFrame)
  }
  if (totalFrames > cursor) out.push(blank(cursor, totalFrames))
  return out
}
