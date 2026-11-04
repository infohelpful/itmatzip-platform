/**
 * 캡슐 자막 프리셋과 강조 칩 스타일 — 프리뷰(`App.tsx`)와 영상 버닝(`ExportSubtitleFrame`)이 같은 값을 쓴다.
 *
 * 기준 디자인(글자 46px 기준): 배경 rgba(12,13,18,.66), 곡률 34px, 1px 흰색 8% 테두리,
 * 그림자 0 6px 24px 검정 35%, 여백 좌우 34px·위아래 16px, 1480px 를 넘으면 줄바꿈,
 * 글자 그림자 검정 35% 블러 6px, 외곽선 없음. 강조 칩은 곡률 10px 둥근 사각형.
 * 글자 크기를 바꾸면 여백·곡률·그림자·최대 너비도 같은 비율로 바뀐다.
 */
import type { CSSProperties } from 'react'

export type SubtitleBoxStyle = 'classic' | 'capsule'

export const CAPSULE_FONT_FAMILY = 'Pretendard'

/** 「캡슐 프리셋」 버튼이 한 번에 적용하는 값 */
export const CAPSULE_PRESET = {
  fontFamily: CAPSULE_FONT_FAMILY,
  fontWeight: 800,
  fontSize: 46,
  textColor: '#FFFFFF',
  bgColor: '#0C0D12',
  bgOpacity: 66,
  bgPaddingPct: 100,
  strokeWidth: 0
} as const

const REF_FONT_PX = 46

export function parseSubtitleBoxStyle(raw: unknown): SubtitleBoxStyle {
  return raw === 'capsule' ? 'capsule' : 'classic'
}

function strokeShadows(color: string, width: number): string[] {
  const w = Math.max(0, Math.min(6, width))
  if (w <= 0) return []
  return [`-${w}px 0 ${color}`, `0 ${w}px ${color}`, `${w}px 0 ${color}`, `0 -${w}px ${color}`]
}

/**
 * 캡슐 배경일 때 기본 자막 스타일 위에 덮어쓸 값. `layoutWidth` 는 영상 원래 가로 픽셀(자막 무대 폭).
 */
export function capsuleBoxOverrides(args: {
  fontSizePx: number
  bgPaddingPct: number
  layoutWidth: number
  strokeColor: string
  strokeWidth: number
}): CSSProperties {
  const f = Math.max(0.1, args.fontSizePx / REF_FONT_PX)
  const pad = Math.max(30, Math.min(150, Number.isFinite(args.bgPaddingPct) ? args.bgPaddingPct : 100)) / 100
  const px = (v: number) => `${Math.round(v * 100) / 100}px`
  const stageMax = args.layoutWidth > 0 ? Math.floor(args.layoutWidth * 0.9) : 0
  const capsuleMax = Math.round(1480 * f)
  return {
    padding: `${px(16 * f * pad)} ${px(34 * f * pad)}`,
    borderRadius: px(34 * f),
    border: '1px solid rgba(255, 255, 255, 0.08)',
    boxShadow: `0 ${px(6 * f)} ${px(24 * f)} rgba(0, 0, 0, 0.35)`,
    lineHeight: 1.3,
    maxWidth: stageMax > 0 ? `${Math.min(capsuleMax, stageMax)}px` : `${capsuleMax}px`,
    textShadow: [...strokeShadows(args.strokeColor, args.strokeWidth), `0 0 ${px(6 * f)} rgba(0, 0, 0, 0.35)`].join(', ')
  }
}

/** 강조 칩 — 글자 크기에 비례(46px 기준 곡률 10px). 줄이 나뉘어도 조각마다 둥근 모서리를 유지한다. */
export function emphasisChipStyle(color: string): CSSProperties {
  return {
    backgroundColor: color,
    borderRadius: '0.2174em',
    padding: '0.03em 0.14em',
    margin: '0 0.02em',
    WebkitBoxDecorationBreak: 'clone',
    boxDecorationBreak: 'clone'
  }
}
