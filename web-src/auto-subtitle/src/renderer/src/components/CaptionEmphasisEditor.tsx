/**
 * 자막 편집 textarea 의 글자 강조 UI.
 *
 * - `CaptionEmphasisOverlay`: textarea 위에 같은 글자 배치로 겹쳐, 강조된 글자 뒤에 강조 색을 은은하게 깐다.
 *   클릭·선택·입력은 그대로 textarea 가 받는다(pointer-events: none).
 * - `CaptionEmphasisMenu`: 글자를 드래그한 뒤 우클릭하면 뜨는 메뉴(강조 / 다른 색으로 강조 / 강조 해제).
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
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

/** 우클릭 메뉴의 「다른 색으로 강조」 견본 */
const EMPHASIS_SWATCHES = [
  '#4F46E5', '#2563EB', '#0891B2', '#059669', '#65A30D', '#CA8A04',
  '#EA580C', '#DC2626', '#DB2777', '#9333EA', '#475569', '#111827'
]

export type CaptionEmphasisMenuState = {
  x: number
  y: number
  /** 메뉴를 연 순간의 textarea 값과 선택 범위 */
  text: string
  start: number
  end: number
  /** 선택(또는 커서) 위치에 이미 강조가 있는지 */
  canRemove: boolean
}

export function CaptionEmphasisMenu({ state, defaultColor, onEmphasize, onRemove, onClose }: {
  state: CaptionEmphasisMenuState
  defaultColor: string
  onEmphasize: (color?: string) => void
  onRemove: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [showColors, setShowColors] = useState(false)
  const [custom, setCustom] = useState(defaultColor)
  const [pos, setPos] = useState<CSSProperties>({ left: state.x, top: state.y })
  const hasSelection = state.end > state.start

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const box = el.getBoundingClientRect()
    setPos({
      left: Math.max(8, Math.min(state.x, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(state.y, window.innerHeight - box.height - 8))
    })
  }, [state.x, state.y, showColors])

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return
      onClose()
    }
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    }
    const close = () => onClose()
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
  }, [onClose])

  return createPortal(<div ref={ref} className="caption-emphasis-menu" role="menu" aria-label="글자 강조"
    style={pos} data-waveform-no-dismiss="1"
    // 메뉴를 눌러도 textarea 의 포커스·선택이 유지되게 한다.
    onMouseDown={(event) => { if (!(event.target instanceof HTMLInputElement)) event.preventDefault() }}
    onContextMenu={(event) => event.preventDefault()}>
    {hasSelection && <button type="button" role="menuitem" className="caption-emphasis-menu-item"
      onClick={() => onEmphasize()}>
      <span className="caption-emphasis-menu-dot" style={{ backgroundColor: defaultColor }} />강조
    </button>}
    {hasSelection && <button type="button" role="menuitem" aria-haspopup="true" aria-expanded={showColors}
      className="caption-emphasis-menu-item" onClick={() => setShowColors(v => !v)}>
      <span className="caption-emphasis-menu-dot caption-emphasis-menu-dot--multi" />다른 색으로 강조
      <span className="caption-emphasis-menu-chevron" aria-hidden="true">{showColors ? '▾' : '▸'}</span>
    </button>}
    {hasSelection && showColors && <div className="caption-emphasis-menu-colors">
      <div className="caption-emphasis-menu-swatches" role="group" aria-label="강조 색">
        {EMPHASIS_SWATCHES.map(color => <button key={color} type="button" role="menuitem" title={color}
          aria-label={`${color} 로 강조`} style={{ backgroundColor: color }} onClick={() => onEmphasize(color)} />)}
      </div>
      <label className="caption-emphasis-menu-custom">
        <span>직접 지정</span>
        <input type="color" value={custom} aria-label="강조 색 직접 지정" onChange={(event) => setCustom(event.target.value)} />
        <button type="button" role="menuitem" onClick={() => onEmphasize(custom)}>적용</button>
      </label>
    </div>}
    {state.canRemove && <button type="button" role="menuitem" className="caption-emphasis-menu-item"
      onClick={() => onRemove()}>
      <span className="caption-emphasis-menu-dot caption-emphasis-menu-dot--none" />강조 해제
    </button>}
  </div>, document.body)
}
