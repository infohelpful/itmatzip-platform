import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { ImageOverlay, MediaAsset, MediaFit, MediaInsertion } from '../../../shared/mediaComposition'
import { useAssetUrl } from '../platform/assetUrl'
import './mediaClips.css'

export type ClipAddKind = 'image' | 'video' | 'overlay'

/** Thin bar between caption rows; 「클립 추가」 opens the choice of clip (Vrew style). */
export function ClipAddBar(props: { onAdd: (kind: ClipAddKind) => void; allowOverlay: boolean; label?: string; edge?: 'top' | 'bottom' }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [open])
  const pick = (kind: ClipAddKind) => {
    setOpen(false)
    props.onAdd(kind)
  }
  return <div ref={rootRef} className={`clip-add-bar clip-add-bar--${props.edge ?? 'inline'}${open ? ' is-open' : ''}`} data-waveform-no-dismiss="1"
    onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()} onKeyDown={e => {
      e.stopPropagation()
      if (e.key === 'Escape') setOpen(false)
    }}>
    <button type="button" className="clip-add-btn" aria-expanded={open} onClick={() => setOpen(v => !v)}>
      <span aria-hidden="true">＋</span> {props.label ?? '클립 추가'}
    </button>
    {open ? <div className="clip-add-menu" role="menu">
      <button type="button" role="menuitem" onClick={() => pick('image')}>
        <ClipIcon kind="image" /><span>이미지 클립</span><small>이 위치에 이미지를 끼워 넣기</small>
      </button>
      <button type="button" role="menuitem" onClick={() => pick('video')}>
        <ClipIcon kind="video" /><span>비디오 클립</span><small>이 위치에 영상을 끼워 넣기</small>
      </button>
      {props.allowOverlay ? <button type="button" role="menuitem" onClick={() => pick('overlay')}>
        <ClipIcon kind="overlay" /><span>이미지 덮기</span><small>위 줄이 나오는 동안 화면에 이미지 표시</small>
      </button> : null}
    </div> : null}
  </div>
}

function ClipIcon({ kind }: { kind: ClipAddKind }) {
  const d = kind === 'video' ? 'M3 5h13v14H3zM16 10l5-3v10l-5-3'
    : kind === 'image' ? 'M3 5h18v14H3zM7 15l3-4 3 3 2-2 3 3M8 9.5h.01'
      : 'M4 4h12v12H4zM8 8h12v12H8'
  return <svg className="clip-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>
}

export function AssetThumb(props: { asset: MediaAsset | undefined; ready: boolean; className?: string }) {
  const url = useAssetUrl(props.asset?.path, props.ready)
  const cls = `asset-thumb ${props.className ?? ''}`
  if (!props.asset) return <span className={`${cls} asset-thumb--missing`}>?</span>
  if (!url) return <span className={`${cls} asset-thumb--missing`} title="파일을 찾을 수 없습니다">!</span>
  return props.asset.kind === 'image'
    ? <img className={cls} src={url} alt="" draggable={false} />
    : <video className={cls} src={`${url}#t=0.1`} muted playsInline preload="metadata" />
}

/** Number field that commits once (blur or Enter), so one change is one undo step. */
function SecondsField(props: { label: string; value: number; min: number; max: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const v = Number(draft)
    setDraft(null)
    if (Number.isFinite(v)) props.onCommit(Math.max(props.min, Math.min(props.max, Math.round(v * 100) / 100)))
  }
  return <label className="clip-field">
    <span>{props.label}</span>
    <input type="number" step={0.1} min={props.min} max={props.max} value={draft ?? props.value.toFixed(2)}
      onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit() } }} />
    <span>초</span>
  </label>
}

function FitToggle(props: { value: MediaFit; onChange: (fit: MediaFit) => void }) {
  return <div className="clip-fit" role="radiogroup" aria-label="화면 맞춤">
    {([['contain', '맞추기'], ['cover', '채우기']] as const).map(([fit, label]) =>
      <button key={fit} type="button" role="radio" aria-checked={props.value === fit}
        title={fit === 'contain' ? '이미지 전체가 보이게 (남는 곳은 검은색/투명)' : '화면을 가득 채우게 (넘치는 곳은 잘림)'}
        onClick={() => props.onChange(fit)}>{label}</button>)}
  </div>
}

export type InsertedClipCardProps = {
  insertion: MediaInsertion
  asset: MediaAsset | undefined
  ready: boolean
  missing: boolean
  /** Where the clip starts in the finished video (shown as the card time). */
  programStart: number | null
  active: boolean
  formatTime: (sec: number) => string
  canMoveUp: boolean
  canMoveDown: boolean
  onChange: (patch: Partial<MediaInsertion>) => void
  onMove: (step: -1 | 1) => void
  onRemove: () => void
  onReplace: () => void
  onPlay: () => void
}

export function InsertedClipCard(p: InsertedClipCardProps) {
  const { insertion: c, asset } = p
  const isVideo = asset?.kind === 'video'
  const videoLength = asset?.duration ?? c.sourceStart + c.duration
  return <div className={`inserted-clip-card${p.active ? ' is-active' : ''}`} data-waveform-no-dismiss="1"
    onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
    <button type="button" className="inserted-clip-thumb" onClick={p.onPlay} title="이 클립부터 재생">
      <AssetThumb asset={asset} ready={p.ready} />
      <span className="inserted-clip-play" aria-hidden="true">▶</span>
    </button>
    <div className="inserted-clip-body">
      <div className="inserted-clip-head">
        <span className="inserted-clip-kind"><ClipIcon kind={isVideo ? 'video' : 'image'} />{isVideo ? '비디오 클립' : '이미지 클립'}</span>
        <span className="inserted-clip-name" title={asset?.path}>{asset?.name ?? '알 수 없는 파일'}</span>
        {p.programStart !== null ? <span className="inserted-clip-time">{p.formatTime(p.programStart)} → {p.formatTime(p.programStart + c.duration)}</span> : null}
      </div>
      {p.missing ? <p className="inserted-clip-missing" role="alert">파일을 찾을 수 없습니다. 「교체」로 다시 연결해 주세요.</p> : null}
      <div className="inserted-clip-controls">
        {isVideo ? <>
          <SecondsField label="시작" value={c.sourceStart} min={0} max={Math.max(0, videoLength - 0.1)}
            onCommit={v => p.onChange({ sourceStart: v, duration: Math.min(c.duration, Math.max(0.1, videoLength - v)) })} />
          <SecondsField label="길이" value={c.duration} min={0.1} max={Math.max(0.1, videoLength - c.sourceStart)}
            onCommit={v => p.onChange({ duration: v })} />
          <label className="clip-check"><input type="checkbox" checked={c.muted} onChange={e => p.onChange({ muted: e.target.checked })} />소리 끄기</label>
        </> : <SecondsField label="길이" value={c.duration} min={0.1} max={600} onCommit={v => p.onChange({ duration: v })} />}
        <FitToggle value={c.fit} onChange={fit => p.onChange({ fit })} />
      </div>
    </div>
    <div className="inserted-clip-actions">
      {p.canMoveUp ? <button type="button" title="앞 클립과 순서 바꾸기" aria-label="앞으로" onClick={() => p.onMove(-1)}>↑</button> : null}
      {p.canMoveDown ? <button type="button" title="뒤 클립과 순서 바꾸기" aria-label="뒤로" onClick={() => p.onMove(1)}>↓</button> : null}
      <button type="button" onClick={p.onReplace}>교체</button>
      <button type="button" className="is-danger" onClick={p.onRemove}>삭제</button>
    </div>
  </div>
}

export type OverlayBadgeProps = {
  overlay: ImageOverlay
  asset: MediaAsset | undefined
  ready: boolean
  missing: boolean
  rows: number
  canMove: { startUp: boolean; startDown: boolean; endUp: boolean; endDown: boolean; front: boolean; back: boolean }
  onChange: (patch: Partial<ImageOverlay>) => void
  onMoveEdge: (edge: 'start' | 'end', step: -1 | 1) => void
  onReorder: (step: -1 | 1) => void
  onRemove: () => void
  onReplace: () => void
}

/** Thumbnail on the first row an overlay covers; opens its settings (fit, range by rows, order, replace, delete). */
export function OverlayBadge(p: OverlayBadgeProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [open])
  const row = (label: string, children: ReactNode) => <div className="overlay-menu-row"><span>{label}</span>{children}</div>
  return <div ref={rootRef} className="overlay-badge" data-waveform-no-dismiss="1"
    onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setOpen(false) }}>
    <button type="button" className={`overlay-thumb-btn${p.missing ? ' is-missing' : ''}`} aria-expanded={open}
      aria-label={`이미지 덮기 설정 · ${p.asset?.name ?? ''} (${p.rows}줄)`} title={`${p.asset?.name ?? ''} · ${p.rows}줄에 표시`}
      onClick={() => setOpen(v => !v)}>
      <AssetThumb asset={p.asset} ready={p.ready} />
    </button>
    {open ? <div className="overlay-menu" role="dialog" aria-label="이미지 덮기 설정">
      <p className="overlay-menu-title" title={p.asset?.path}>{p.asset?.name ?? '이미지'}</p>
      {p.missing ? <p className="inserted-clip-missing">파일을 찾을 수 없습니다. 「교체」로 다시 연결해 주세요.</p> : null}
      {row('화면', <FitToggle value={p.overlay.fit} onChange={fit => p.onChange({ fit })} />)}
      {row('시작 줄', <span className="overlay-step">
        <button type="button" disabled={!p.canMove.startUp} onClick={() => p.onMoveEdge('start', -1)} aria-label="시작을 한 줄 위로">▲</button>
        <button type="button" disabled={!p.canMove.startDown} onClick={() => p.onMoveEdge('start', 1)} aria-label="시작을 한 줄 아래로">▼</button>
      </span>)}
      {row('끝 줄', <span className="overlay-step">
        <button type="button" disabled={!p.canMove.endUp} onClick={() => p.onMoveEdge('end', -1)} aria-label="끝을 한 줄 위로">▲</button>
        <button type="button" disabled={!p.canMove.endDown} onClick={() => p.onMoveEdge('end', 1)} aria-label="끝을 한 줄 아래로">▼</button>
      </span>)}
      {row('순서', <span className="overlay-step">
        <button type="button" disabled={!p.canMove.front} onClick={() => p.onReorder(1)}>앞으로</button>
        <button type="button" disabled={!p.canMove.back} onClick={() => p.onReorder(-1)}>뒤로</button>
      </span>)}
      <div className="overlay-menu-actions">
        <button type="button" onClick={() => { setOpen(false); p.onReplace() }}>교체</button>
        <button type="button" className="is-danger" onClick={() => { setOpen(false); p.onRemove() }}>삭제</button>
      </div>
    </div> : null}
  </div>
}

export type OverlayLane = Omit<OverlayBadgeProps, 'rows'> & {
  rows: number
  /** Horizontal lane (overlapping overlays sit side by side). */
  lane: number
  isStart: boolean
  isEnd: boolean
  dragging: boolean
}

/**
 * Left of a caption row: the image overlay's range line (continuous over the rows it covers), the
 * thumbnail on its first row, and handles on both ends to drag the range over rows (Vrew style).
 */
export function OverlayGutter(props: {
  lanes: OverlayLane[]
  onHandleDown: (overlayId: string, edge: 'start' | 'end', event: ReactPointerEvent<HTMLElement>) => void
}) {
  const starts = props.lanes.filter(l => l.isStart)
  return <div className="overlay-gutter" data-waveform-no-dismiss="1" onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>
    {props.lanes.map(l => (
      <div key={l.overlay.id} className={`overlay-lane${l.isStart ? ' is-start' : ''}${l.isEnd ? ' is-end' : ''}${l.dragging ? ' is-dragging' : ''}`}
        style={{ left: 38 + l.lane * 6 }}>
        {l.isStart ? <span className="overlay-handle overlay-handle--start" role="slider" aria-label="이미지 표시 시작 줄 (끌어서 변경)"
          aria-valuenow={0} title="끌어서 시작 줄 변경" onPointerDown={e => props.onHandleDown(l.overlay.id, 'start', e)} /> : null}
        {l.isEnd ? <span className="overlay-handle overlay-handle--end" role="slider" aria-label="이미지 표시 끝 줄 (끌어서 변경)"
          aria-valuenow={l.rows} title="끌어서 끝 줄 변경" onPointerDown={e => props.onHandleDown(l.overlay.id, 'end', e)} /> : null}
      </div>
    ))}
    {starts.map((l, i) => <div key={l.overlay.id} className="overlay-thumb-slot" style={{ top: 12 + i * 40 }}>
      <OverlayBadge {...l} />
    </div>)}
  </div>
}
