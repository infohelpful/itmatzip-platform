/**
 * 자막 카드 머리의 「자막 표시」 시간 + 조절 팝오버.
 *
 * 카드 오른쪽 위 기존 시간(영상·소리 기준)은 그대로 두고, 자막이 화면에 실제로 뜨는 구간을 따로 보여 준다.
 * 조절해도 단어·소리·컷은 바뀌지 않는다(`shared/subtitleDisplayTiming.ts`).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import type { SubtitleLine } from '../../../shared/subtitles'
import {
  lineDisplayAdjust,
  subtitleAutoDisplayBounds,
  subtitleDisplayBounds,
  type SubtitleDisplayTimingEdit
} from '../../../shared/subtitleDisplayTiming'
import { useSubtitleData } from '../subtitleDataContext'

type Props = {
  lines: readonly SubtitleLine[]
  index: number
  rowNumber?: number
  formatTimecode: (sec: number) => string
  /** 미디어 축 현재 재생 위치(초) */
  playheadSecRef: MutableRefObject<number>
  onEdit: (index: number, edit: SubtitleDisplayTimingEdit) => void
  onTogglePlayback?: () => void
}

const POPUP_WIDTH = 330

function formatAdj(v: number): string {
  if (v === 0) return '보정 없음'
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}초`
}

/** 카드 클릭(재생 위치 이동)·카드 키보드 처리로 번지지 않게 막는다. 포털 안 이벤트도 React 트리로는 버블된다. */
const stop = (e: SyntheticEvent) => e.stopPropagation()

export function SubtitleDisplayTimingControl(props: Props) {
  const { index, formatTimecode, playheadSecRef, onEdit, onTogglePlayback } = props
  // 카드 행은 자기 줄이 바뀔 때만 다시 그려진다(memo). 표시 구간은 이웃 줄 보정에도 영향받으므로
  // 컨텍스트의 최신 자막 배열을 직접 구독한다.
  const { subtitles: fromContext } = useSubtitleData()
  const lines = fromContext.length > 0 ? fromContext : props.lines
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  const line = lines[index]
  const shown = subtitleDisplayBounds(lines, index)
  const auto = subtitleAutoDisplayBounds(lines, index)
  const adj = lineDisplayAdjust(line)
  const adjusted = adj.start !== 0 || adj.end !== 0

  const place = useCallback(() => {
    const btn = buttonRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const width = Math.min(POPUP_WIDTH, window.innerWidth - 16)
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))
    const popupH = popupRef.current?.offsetHeight ?? 220
    const below = r.bottom + 6
    const top = below + popupH > window.innerHeight - 8 ? Math.max(8, r.top - popupH - 6) : below
    setPos({ left, top })
  }, [])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (popupRef.current?.contains(t) || buttonRef.current?.contains(t)) return
      setOpen(false)
    }
    const onReflow = () => place()
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open, place])

  // 줄이 지워지거나(병합 등) 표시 구간이 없어지면 닫는다.
  useEffect(() => {
    if (open && !auto) setOpen(false)
  }, [open, auto])

  if (!line || !auto) return null

  const edit = (e: SubtitleDisplayTimingEdit) => onEdit(index, e)
  const edgeRow = (edge: 'start' | 'end') => {
    const label = edge === 'start' ? '시작' : '끝'
    const value = shown ? (edge === 'start' ? shown.start : shown.end) : null
    const edgeAdj = edge === 'start' ? adj.start : adj.end
    return (
      <div className="subtitle-display-timing-row" role="group" aria-label={`자막 표시 ${label}`}>
        <span className="subtitle-display-timing-label">{label}</span>
        <button type="button" onClick={() => edit({ kind: 'nudge', edge, delta: -0.5 })} title={`${label} 0.5초 앞으로`}>−0.5</button>
        <button type="button" onClick={() => edit({ kind: 'nudge', edge, delta: -0.1 })} title={`${label} 0.1초 앞으로`}>−0.1</button>
        <span className="subtitle-display-timing-value">{value === null ? '—' : formatTimecode(value)}</span>
        <button type="button" onClick={() => edit({ kind: 'nudge', edge, delta: 0.1 })} title={`${label} 0.1초 뒤로`}>+0.1</button>
        <button type="button" onClick={() => edit({ kind: 'nudge', edge, delta: 0.5 })} title={`${label} 0.5초 뒤로`}>+0.5</button>
        <button type="button" className="subtitle-display-timing-here"
          onClick={() => edit({ kind: 'set', edge, sec: playheadSecRef.current })}
          title={`지금 재생 위치를 자막 표시 ${label}으로`}>현재 위치</button>
        <span className={`subtitle-display-timing-adj${edgeAdj !== 0 ? ' is-on' : ''}`}>{formatAdj(edgeAdj)}</span>
      </div>
    )
  }

  const popup = open ? createPortal(
    <div
      ref={popupRef}
      className="subtitle-display-timing-popup"
      role="dialog"
      aria-label={`${props.rowNumber ?? index + 1}번 자막 표시 시간`}
      data-waveform-no-dismiss="1"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: Math.min(POPUP_WIDTH, window.innerWidth - 16) }}
      onClick={stop}
      onDoubleClick={stop}
      onMouseDown={stop}
      onPointerDown={stop}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          setOpen(false)
          buttonRef.current?.focus()
        } else if (e.code === 'Space' && !e.repeat) {
          // 팝오버를 연 채로 재생·정지하며 위치를 찾을 수 있게: 버튼 누름 대신 재생 토글.
          e.preventDefault()
          onTogglePlayback?.()
        }
      }}
    >
      <div className="subtitle-display-timing-head">
        <strong>자막 표시 시간</strong>
        <button type="button" className="subtitle-display-timing-close" aria-label="닫기" onClick={() => setOpen(false)}>×</button>
      </div>
      <p className="subtitle-display-timing-auto">
        자동: {formatTimecode(auto.start)} → {formatTimecode(auto.end)}
      </p>
      {edgeRow('start')}
      {edgeRow('end')}
      <div className="subtitle-display-timing-foot">
        <button type="button" disabled={!adjusted} onClick={() => edit({ kind: 'reset' })}>자동으로 되돌리기</button>
      </div>
      <p className="subtitle-display-timing-note">영상·소리는 그대로 두고, 자막이 화면에 뜨는 시점만 바뀝니다. (Space: 재생/정지)</p>
    </div>,
    document.body
  ) : null

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`subtitle-display-timing-btn${adjusted ? ' is-adjusted' : ''}${open ? ' is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={adjusted ? '자막 표시 시간(수동 보정됨) — 눌러서 조절' : '자막이 화면에 보이는 시간 — 눌러서 조절'}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
        onMouseDown={stop}
        onPointerDown={stop}
        onDoubleClick={stop}
        onKeyDown={stop}
      >
        <span className="subtitle-display-timing-btn-label">자막{adjusted ? ' · 수동' : ''}</span>
        <span>{shown ? formatTimecode(shown.start) : '—'}</span>
        <span className="subtitle-time-sep">→</span>
        <span>{shown ? formatTimecode(shown.end) : '—'}</span>
      </button>
      {popup}
    </>
  )
}
