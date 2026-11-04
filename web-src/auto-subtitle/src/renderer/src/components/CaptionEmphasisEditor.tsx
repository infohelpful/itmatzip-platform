/**
 * 자막 편집 textarea 의 글자 강조 UI.
 *
 * - `CaptionEmphasisOverlay`: textarea 위에 같은 글자 배치로 겹쳐, 강조된 글자 뒤에 강조 색을 은은하게 깐다.
 *   클릭·선택·입력은 그대로 textarea 가 받는다(pointer-events: none).
 * - `CaptionEmphasisToolbar`: 글자를 드래그하면 카드 머리(「영상 · 자막」 오른쪽)에 뜨는 강조 막대.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { captionEmphasisSegments, type CaptionEmphasis } from '../../../shared/captionEmphasis'
import './CaptionEmphasisEditor.css'

const MIRRORED_STYLE_PROPS = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing',
  'textTransform', 'textIndent', 'tabSize', 'whiteSpace', 'wordBreak', 'overflowWrap', 'direction',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing'
] as const

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return `rgba(79, 70, 229, ${alpha})`
  const n = Number.parseInt(m[1]!, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

export function CaptionEmphasisOverlay({ textareaRef, text, ranges, defaultColor }: {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  text: string
  ranges: readonly CaptionEmphasis[] | undefined
  defaultColor: string
}) {
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const segments = captionEmphasisSegments(text, ranges, defaultColor)
  const active = segments.some(seg => seg.color)

  useLayoutEffect(() => {
    const ta = textareaRef.current
    const overlay = overlayRef.current
    if (!active || !ta || !overlay) return
    const sync = () => {
      const cs = window.getComputedStyle(ta)
      for (const prop of MIRRORED_STYLE_PROPS) {
        ;(overlay.style as unknown as Record<string, string>)[prop] = cs[prop]
      }
      overlay.scrollTop = ta.scrollTop
    }
    sync()
    const onScroll = () => { overlay.scrollTop = ta.scrollTop }
    ta.addEventListener('scroll', onScroll)
    const ro = new ResizeObserver(sync)
    ro.observe(ta)
    return () => {
      ta.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [active, textareaRef, text])

  if (!active) return null
  return <div ref={overlayRef} className="caption-emphasis-overlay" aria-hidden="true">
    {segments.map((seg, i) => seg.color
      ? <mark key={i} style={{ backgroundColor: hexToRgba(seg.color, 0.38), boxShadow: `inset 0 -2px 0 ${seg.color}` }}>{seg.text}</mark>
      : <span key={i}>{seg.text}</span>)}
    {/* textarea 는 끝 줄바꿈 뒤에 빈 줄을 하나 더 그린다 */}
    {'​'}
  </div>
}

/** 「▾」 색상표 견본 */
const EMPHASIS_SWATCHES = [
  '#4F46E5', '#2563EB', '#0891B2', '#059669', '#65A30D', '#CA8A04',
  '#EA580C', '#DC2626', '#DB2777', '#9333EA', '#475569', '#111827'
]
/** 막대에 바로 보이는 자주 쓰는 색(전체 강조 색은 「강조」 버튼이 쓴다) */
const QUICK_COLORS = ['#DC2626', '#EA580C', '#059669', '#2563EB']

/** 편집 칸에서 지금 고른 범위(막대를 누르는 순간의 textarea 값 기준) */
export type CaptionEmphasisSelection = { text: string; start: number; end: number }

/**
 * 카드 머리(「영상 · 자막」 오른쪽)의 강조 막대.
 * 글자를 드래그하면 [강조][자주 쓰는 색][▾][해제], 강조된 글자에 커서만 있으면 [강조 해제]만 보인다.
 * 버튼을 눌러도 편집 칸의 포커스·선택이 유지된다(mousedown 기본 동작 막음).
 */
export function CaptionEmphasisToolbar({ selection, canAdd, canRemove, defaultColor, onEmphasize, onRemove, onPaletteOpenChange }: {
  selection: CaptionEmphasisSelection
  canAdd: boolean
  canRemove: boolean
  defaultColor: string
  onEmphasize: (selection: CaptionEmphasisSelection, color?: string) => void
  onRemove: (selection: CaptionEmphasisSelection) => void
  /** 색상표가 열려 있는 동안에는 편집 칸에서 포커스가 빠져도 막대를 유지한다 */
  onPaletteOpenChange: (open: boolean) => void
}) {
  const [paletteAt, setPaletteAt] = useState<{ left: number; top: number } | null>(null)
  const [custom, setCustom] = useState(defaultColor)
  const paletteRef = useRef<HTMLDivElement | null>(null)
  // 색상표를 여는 순간의 선택을 붙잡아 둔다(색 입력칸을 누르면 편집 칸 선택이 풀리므로).
  const heldSelection = useRef(selection)
  if (!paletteAt) heldSelection.current = selection

  const setPalette = (at: { left: number; top: number } | null) => {
    setPaletteAt(at)
    onPaletteOpenChange(at !== null)
  }

  useEffect(() => {
    if (!paletteAt) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && paletteRef.current?.contains(event.target)) return
      setPalette(null)
    }
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPalette(null) }
    }
    const close = () => setPalette(null)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', key, true)
    window.addEventListener('resize', close)
    document.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', close)
      document.removeEventListener('scroll', close, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteAt])
  useEffect(() => () => onPaletteOpenChange(false), [onPaletteOpenChange])

  const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault()
  const pick = (color?: string) => {
    const sel = heldSelection.current
    setPalette(null)
    onEmphasize(sel, color)
  }

  return <span className="caption-emphasis-toolbar" role="group" aria-label="글자 강조" data-waveform-no-dismiss="1"
    onMouseDown={(event) => { event.stopPropagation(); keepFocus(event) }} onClick={(event) => event.stopPropagation()}>
    {canAdd && <>
      <button type="button" className="caption-emphasis-toolbar-main" title="고른 글자를 전체 강조 색으로 강조 (Ctrl+B)"
        onClick={() => pick()}>
        <span className="caption-emphasis-menu-dot" style={{ backgroundColor: defaultColor }} />강조
      </button>
      {QUICK_COLORS.map(color => <button key={color} type="button" className="caption-emphasis-toolbar-swatch"
        title={`${color} 로 강조`} aria-label={`${color} 로 강조`} style={{ backgroundColor: color }} onClick={() => pick(color)} />)}
      <button type="button" className="caption-emphasis-toolbar-more" title="다른 색으로 강조" aria-label="다른 색으로 강조"
        aria-haspopup="dialog" aria-expanded={paletteAt !== null}
        onClick={(event) => {
          if (paletteAt) { setPalette(null); return }
          const rect = event.currentTarget.getBoundingClientRect()
          setPalette({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 232)), top: rect.bottom + 6 })
        }}>▾</button>
    </>}
    {canRemove && <button type="button" className="caption-emphasis-toolbar-remove" title="강조 해제 (Ctrl+B)"
      onClick={() => onRemove(selection)}>{canAdd ? '해제' : '강조 해제'}</button>}
    {paletteAt && createPortal(<div ref={paletteRef} className="caption-emphasis-menu caption-emphasis-palette" role="dialog"
      aria-label="강조 색" style={paletteAt} data-waveform-no-dismiss="1"
      onMouseDown={(event) => { event.stopPropagation(); if (!(event.target instanceof HTMLInputElement)) event.preventDefault() }}
      onClick={(event) => event.stopPropagation()}>
      <div className="caption-emphasis-menu-swatches" role="group" aria-label="강조 색">
        {EMPHASIS_SWATCHES.map(color => <button key={color} type="button" title={color}
          aria-label={`${color} 로 강조`} style={{ backgroundColor: color }} onClick={() => pick(color)} />)}
      </div>
      <label className="caption-emphasis-menu-custom">
        <span>직접 지정</span>
        <input type="color" value={custom} aria-label="강조 색 직접 지정" onChange={(event) => setCustom(event.target.value)} />
        <button type="button" onClick={() => pick(custom)}>적용</button>
      </label>
    </div>, document.body)}
  </span>
}
