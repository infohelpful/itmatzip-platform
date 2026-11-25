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

function FitToggle(props: { value: MediaFit; onChange: (fit: MediaFit) => void }) {
  return <div className="clip-fit" role="radiogroup" aria-label="화면 맞춤">
    {([['contain', '맞추기'], ['cover', '채우기']] as const).map(([fit, label]) =>
      <button key={fit} type="button" role="radio" aria-checked={props.value === fit}
        title={fit === 'contain' ? '전체가 보이게 (남는 곳은 검은색/투명)' : '화면을 가득 채우게 (넘치는 곳은 잘림)'}
        onClick={() => props.onChange(fit)}>{label}</button>)}
  </div>
}

/** Caption shown over the clip; committed once (blur or Enter) so one edit is one undo step. */
function ClipCaptionInput(props: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    setDraft(null)
    if (draft !== props.value) props.onCommit(draft)
  }
  return <input type="text" className="clip-row-caption-input" maxLength={2000} aria-label="클립 자막"
    placeholder="클립 위에 표시할 자막을 입력하세요" value={draft ?? props.value}
    onChange={e => setDraft(e.target.value)} onBlur={commit}
    onKeyDown={e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); e.currentTarget.blur() }
      else if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur() }
    }} />
}

/** One chip per second of an inserted clip (the last one holds the remainder), as in Vrew. */
export function clipSecondChips(duration: number): number[] {
  const out: number[] = []
  for (let t = 0; t < duration - 1e-6; t += 1) out.push(Math.min(1, duration - t))
  return out
}

export type InsertedClipRowProps = {
  insertion: MediaInsertion
  asset: MediaAsset | undefined
  ready: boolean
  missing: boolean
  /** Row number in the list (inserted clips are numbered like caption rows). */
  number: number
  /** Where the clip starts in the finished video. */
  programStart: number | null
  active: boolean
  selected: boolean
  formatTime: (sec: number) => string
  canMoveUp: boolean
  canMoveDown: boolean
  onSelect: (checked: boolean) => void
  onChange: (patch: Partial<MediaInsertion>) => void
  /** Removes these one-second chips (by index); a video keeps the remaining parts in order. */
  onDeleteSeconds: (indices: number[]) => void
  onExtend: () => void
  onMove: (step: -1 | 1) => void
  onRemove: () => void
  onReplace: () => void
  onPlay: () => void
}

/**
 * An inserted image/video clip listed as its own numbered row, like a caption row: `[??]` chips per
 * second (select and press Delete to cut seconds), and — when its checkbox is ticked — a toolbar above
 * it with play, mute, fit, replace, order and delete.
 */
export function InsertedClipRow(p: InsertedClipRowProps) {
  const { insertion: c, asset } = p
  const isVideo = asset?.kind === 'video'
  const chips = clipSecondChips(c.duration)
  const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set())
  useEffect(() => setPicked(new Set()), [c.duration, c.sourceStart])
  const toggleChip = (i: number) => setPicked(prev => {
    const next = new Set(prev)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    return next
  })
  const deletePicked = (fallback?: number) => {
    const indices = picked.size ? [...picked] : fallback !== undefined ? [fallback] : []
    if (!indices.length) return
    setPicked(new Set())
    p.onDeleteSeconds(indices)
  }
  const picks = [...picked].reduce((sum, i) => sum + (chips[i] ?? 0), 0)
  return <article className={`subtitle-card subtitle-card--virtual inserted-clip-row${p.selected ? ' subtitle-card--selected' : ''}${p.active ? ' subtitle-card--active' : ''}`}
    data-waveform-no-dismiss="1" aria-label={`${p.number}번 ${isVideo ? '비디오' : '이미지'} 클립`}
    onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}
    onKeyDown={e => {
      e.stopPropagation()
      if ((e.target as HTMLElement).closest('input,textarea')) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const focused = (e.target as HTMLElement).dataset?.clipSecond
        e.preventDefault()
        deletePicked(focused !== undefined ? Number(focused) : undefined)
      } else if (e.key === 'Escape') setPicked(new Set())
    }}>
    {p.selected ? <div className="clip-row-toolbar" role="toolbar" aria-label="클립 편집">
      <button type="button" onClick={p.onPlay} title="이 클립부터 재생">▶ 재생</button>
      {isVideo ? <button type="button" aria-pressed={c.muted} className={c.muted ? 'is-on' : ''}
        onClick={() => p.onChange({ muted: !c.muted })} title="클립 소리 끄기/켜기">{c.muted ? '🔇 음소거됨' : '🔊 음소거'}</button> : null}
      <span className="clip-row-toolbar-sep" />
      <FitToggle value={c.fit} onChange={fit => p.onChange({ fit })} />
      <span className="clip-row-toolbar-sep" />
      {!isVideo ? <button type="button" onClick={p.onExtend} title="1초 늘리기">＋1초</button> : null}
      {picked.size ? <button type="button" onClick={() => deletePicked()} title="선택한 칩 구간 지우기">선택 {picks.toFixed(1)}초 삭제</button> : null}
      <button type="button" onClick={p.onReplace}>교체</button>
      {p.canMoveUp ? <button type="button" aria-label="앞 클립과 순서 바꾸기" onClick={() => p.onMove(-1)}>↑</button> : null}
      {p.canMoveDown ? <button type="button" aria-label="뒤 클립과 순서 바꾸기" onClick={() => p.onMove(1)}>↓</button> : null}
      <button type="button" className="is-danger" onClick={p.onRemove}>삭제</button>
    </div> : null}
    <div className="subtitle-row-index" onKeyDown={e => e.stopPropagation()}>
      <span>{p.number}</span>
      <input type="checkbox" aria-label={`${p.number}번 클립 선택`} checked={p.selected} onChange={e => p.onSelect(e.target.checked)} />
    </div>
    {/* Top line: 영상편집 + one chip per second (Vrew). */}
    <div className="clip-row-line">
      <span className="clip-row-kind"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h13v12H3zM16 10.5l5-3v9l-5-3" /></svg>영상편집</span>
      <div className="inserted-clip-chips" role="group" aria-label="1초 단위 칩 (선택 후 Delete로 지우기)">
        {chips.map((len, i) => <button key={i} type="button" data-clip-second={i}
          className={`subtitle-word-chip inserted-clip-chip${picked.has(i) ? ' is-picked' : ''}`}
          title={`${i}~${(i + len).toFixed(1)}초`} onClick={() => toggleChip(i)}>{len >= 0.95 ? '[ ?? ]' : '[ ? ]'}</button>)}
      </div>
      {p.programStart !== null ? <div className="subtitle-card-times clip-row-times" aria-label="클립 구간">
        <span className="subtitle-time">{p.formatTime(p.programStart)}</span>
        <span className="subtitle-time-sep">→</span>
        <span className="subtitle-time">{p.formatTime(p.programStart + c.duration)}</span>
      </div> : null}
    </div>
    {/* Bottom line: caption icon and an empty caption (inserted clips carry no original caption). */}
    <div className="clip-row-line clip-row-line--caption">
      <span className="clip-row-caption-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M7 11h6M15 11h2M7 14.5h3M12 14.5h5" /></svg></span>
      <ClipCaptionInput value={c.caption ?? ''} onCommit={caption => p.onChange({ caption })} />
      <button type="button" className="inserted-clip-thumb" onClick={p.onPlay}
        title={`${isVideo ? '비디오' : '이미지'} · ${asset?.name ?? '알 수 없는 파일'} — 이 클립부터 재생`}>
        <AssetThumb asset={asset} ready={p.ready} />
      </button>
    </div>
    {p.missing ? <p className="inserted-clip-missing" role="alert">파일을 찾을 수 없습니다. 체크 후 「교체」로 다시 연결해 주세요.</p> : null}
  </article>
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
