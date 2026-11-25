import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import './wordTimingEditor.css'
import type { SubtitleLine, SubtitleWord } from '../../../shared/subtitles'
import { orderedTimingChips, splitWordLabel, timingNeighbours, wordTimingLimits, type TimingWordRef } from '../../../shared/wordTimingEdit'
import { snapTimelineSec } from '../../../shared/timelineCollapse'
import { ChipLoopPlayer } from './chipLoopPlayer'
import {
  TIMING_PCM_RATE, TIMING_PX_PER_SEC, chunkEnvelope, chunkIndices, chunkSlice, draftNeighbour, formatStripTime, layoutStrip,
  stripTime, stripX, timingStripRange
} from './wordTimingWaveform'

export type WordTimingEditorProps = {
  lines: readonly SubtitleLine[]; target: TimingWordRef; duration: number
  /** Applies both boundaries once, when a trim line is released. Throws when they are invalid. */
  onApply: (start: number, end: number) => void
  /** Splits the chip at source time `t` (the play line). */
  onSplit: (t: number) => void
  /** Undoes the last edit (same as Ctrl+Z). */
  onUndo: () => void
  onDelete: () => void
  /** Pauses the main video player; the chip plays on its own. */
  onPause: () => void
  /** `outside`: a click outside the editor and its chip closed it. */
  onClose: (reason?: 'outside') => void
  /** Interleaved stereo s16 48 kHz samples for [startSec, endSec). */
  loadPcm?: (startSec: number, endSec: number) => Promise<Int16Array | null>
  /** DOM id of the selected chip, for the lines that join it to its trim lines. */
  chipElementId?: string
}

/** Track geometry (px): play line bubble, box start labels, waveform boxes, length label. */
const PAD = 16
const LABEL_TOP = 26
const WAVE_TOP = 44
const WAVE_H = 84
/** Length label, then the icon buttons, centred under the selected chip. */
const LENGTH_TOP = WAVE_TOP + WAVE_H + 6
const ACTIONS_TOP = LENGTH_TOP + 24
const ACTION_SIZE = 30
const TRACK_H = ACTIONS_TOP + ACTION_SIZE + 6
/** Trim handles reach past the box top and bottom by this much. */
const TRIM_OVERHANG = 5
const EPS = 1e-6

type Box = { start: number; end: number; kind: 'current' | 'chip' | 'deleted'; word: SubtitleWord }
type Links = { chipLeft: number; chipRight: number; chipBottom: number; startX: number; endX: number; waveTop: number }

const COLORS = {
  current: { fill: 'rgba(110,196,255,.16)', stroke: '#5ec8f8', wave: '#eef7ff' },
  chip: { fill: 'rgba(255,255,255,.035)', stroke: '#3d4c5d', wave: '#8796a8' },
  deleted: { fill: 'rgba(244,93,105,.13)', stroke: '#7c3b46', wave: '#b2626d' },
  gap: { wave: '#4d5866' }
}

const curve = (v: number) => Math.sign(v) * Math.sqrt(Math.abs(v))

function isTextTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('textarea,input,select,[contenteditable="true"]')
}

export function WordTimingEditor(props: WordTimingEditorProps) {
  const { lines, target, duration, onApply, onSplit, onUndo, onDelete, onPause, onClose, loadPcm, chipElementId } = props
  const { word, previous, next } = useMemo(() => timingNeighbours(lines, target), [lines, target])
  const limits = useMemo(() => {
    try {
      return word && !word.isDeleted ? wordTimingLimits(lines, target, duration) : null
    } catch {
      return null
    }
  }, [lines, target, duration, word])
  const range = useMemo(() => word ? timingStripRange(word, previous?.word, next?.word, duration) : { start: 0, end: 1 },
    [word, previous, next, duration])
  // Only the chips connected to this one: previous, selected, next (cuts included).
  const chips = useMemo(() => {
    const self = orderedTimingChips(lines).find(c => c.lineIndex === target.lineIndex && c.wordIndex === target.wordIndex)
    return [previous, self, next].filter((c): c is NonNullable<typeof c> => !!c)
  }, [lines, target, previous, next])

  const [draft, setDraftState] = useState<{ start: number; end: number } | null>(null)
  // Pointer up can arrive before React re-renders the last move: the release reads the ref, not state.
  const draftRef = useRef<{ start: number; end: number } | null>(null)
  const setDraft = useCallback((next: { start: number; end: number } | null) => {
    draftRef.current = next
    setDraftState(next)
  }, [])
  const [playhead, setPlayhead] = useState(() => word?.start ?? 0)
  const [playing, setPlaying] = useState(false)
  const [message, setMessage] = useState('')
  const [chunkVersion, setChunkVersion] = useState(0)
  const [viewWidth, setViewWidth] = useState(0)
  const [links, setLinks] = useState<Links | null>(null)
  const chunksRef = useRef(new Map<number, Int16Array>())
  const pendingRef = useRef(new Set<number>())
  const playerRef = useRef<ChipLoopPlayer | null>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<'start' | 'end' | 'playhead' | null>(null)

  const start = draft?.start ?? word?.start ?? 0
  const end = draft?.end ?? word?.end ?? 0
  const startTrimRef = useRef(start)
  startTrimRef.current = start
  // The play line rides on the start trim line: moving the start trim (dragging, keys, undo) moves it too.
  useEffect(() => {
    playerRef.current?.stop()
    setPlaying(false)
    setPlayhead(start)
  }, [start])
  const boxes = useMemo<Box[]>(() => chips.flatMap(c => {
    const current = c.lineIndex === target.lineIndex && c.wordIndex === target.wordIndex
    const kind: Box['kind'] = current ? 'current' : c.word.isDeleted ? 'deleted' : 'chip'
    if (current) return end - start > EPS ? [{ start, end, kind, word: c.word }] : []
    if (!word) return []
    // Neighbours move with the dragged trim line the way the edit will move them.
    const span = c === previous ? draftNeighbour(c.word, 'previous', word, start)
      : c === next ? draftNeighbour(c.word, 'next', word, end) : c.word
    return span ? [{ start: span.start, end: span.end, kind, word: c.word }] : []
  }), [chips, target, word, previous, next, start, end])

  /**
   * While a trim line is moved, the opposite edge of the chip stays where it was on screen and the
   * moved edge follows the pointer at the fixed scale; everything else is laid out around them.
   */
  const [anchor, setAnchorState] = useState<{ edge: 'start' | 'end'; time: number; x: number } | null>(null)
  const anchorRef = useRef(anchor)
  const setAnchor = useCallback((next: typeof anchor) => {
    anchorRef.current = next
    setAnchorState(next)
  }, [])
  const currentIndex = boxes.findIndex(box => box.kind === 'current')
  // The anchor stays after the trim is applied, so releasing it does not shift the strip. It is dropped
  // when it no longer lies on the chip (split, undo) or, between drags, would push the selected chip off
  // the left edge (a neighbour may be cut off a little; reopening lays the strip out afresh).
  const layout = useMemo(() => {
    const current = boxes[currentIndex]
    const usable = anchor && current && anchor.time >= current.start - 1e-6 && anchor.time <= current.end + 1e-6
    if (!usable) return layoutStrip(boxes, PAD)
    const held = layoutStrip(boxes, PAD, { index: currentIndex, time: anchor.time, x: anchor.x })
    return draft || (held.xs[currentIndex] ?? 0) >= 0 ? held : layoutStrip(boxes, PAD)
  }, [boxes, anchor, currentIndex, draft])
  const x = useCallback((t: number) => stripX(boxes, layout, t), [boxes, layout])
  const timeAt = useCallback((px: number) => stripTime(boxes, layout, px), [boxes, layout])
  const trackWidth = Math.ceil(layout.right) + PAD
  const anchorFor = (edge: 'start' | 'end') => {
    const time = edge === 'start' ? word!.end : word!.start
    return { edge, time, x: x(time) }
  }

  // ---- audio chunks for the strip -------------------------------------------------------------
  useEffect(() => {
    if (!loadPcm) return
    let live = true
    for (const k of chunkIndices(range.start, Math.min(range.end, Math.max(duration, range.end)))) {
      if (chunksRef.current.has(k) || pendingRef.current.has(k)) continue
      pendingRef.current.add(k)
      loadPcm(k, k + 1).then(samples => {
        pendingRef.current.delete(k)
        if (!samples) return
        chunksRef.current.set(k, samples)
        if (live) setChunkVersion(v => v + 1)
      }, () => { pendingRef.current.delete(k) })
    }
    return () => { live = false }
  }, [loadPcm, range.start, range.end, duration])

  // ---- chip playback: once from the start trim, then the play line returns to the start trim ------
  const player = () => (playerRef.current ??= new ChipLoopPlayer())
  const stopLoop = useCallback(() => {
    playerRef.current?.stop()
    setPlaying(false)
  }, [])
  const startLoop = useCallback((at: number) => {
    if (!word) return
    const f0 = Math.floor(word.start * TIMING_PCM_RATE)
    const pcm = chunkSlice(chunksRef.current, f0, Math.ceil(word.end * TIMING_PCM_RATE))
    if (!pcm) {
      setMessage('오디오를 불러오는 중입니다. 잠시 후 다시 재생해 주세요.')
      return
    }
    onPause()
    try {
      player().play(pcm, f0 / TIMING_PCM_RATE, at >= word.start && at < word.end ? at : word.start, () => {
        // Finished: back on the start trim line, and no repeat (Space plays it again).
        setPlaying(false)
        setPlayhead(startTrimRef.current)
      })
      setPlaying(true)
      setMessage('')
    } catch {
      setMessage('이 브라우저에서는 오디오를 재생할 수 없습니다.')
    }
  }, [word, onPause])
  // Play always starts on the start trim line.
  const togglePlay = useCallback(() => {
    if (playerRef.current?.playing) {
      stopLoop()
      return
    }
    if (!word) return
    setPlayhead(word.start)
    startLoop(word.start)
  }, [word, startLoop, stopLoop])

  // Follow playback with the play line.
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const tick = () => {
      const at = playerRef.current?.position()
      if (at != null) setPlayhead(at)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing])

  // A changed chip range (trim applied, split, undo) stops playback of the old range.
  useEffect(() => {
    if (playerRef.current?.playing) stopLoop()
  }, [word?.start, word?.end]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => playerRef.current?.stop(), [])

  // The main player starting stops chip playback (one sound at a time).
  useEffect(() => {
    const onMediaPlay = (event: Event) => {
      if (event.target instanceof HTMLMediaElement) stopLoop()
    }
    document.addEventListener('play', onMediaPlay, true)
    return () => document.removeEventListener('play', onMediaPlay, true)
  }, [stopLoop])

  // ---- keyboard: Space plays the chip, Delete removes it, Escape closes ----------------------
  const keysRef = useRef({ togglePlay, onDelete, onClose })
  keysRef.current = { togglePlay, onDelete, onClose }
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (isTextTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return
      const t = event.target instanceof HTMLElement ? event.target : null
      const ours = !t || t === document.body || !!sectionRef.current?.contains(t) || (!!chipElementId && t.id === chipElementId)
      if (event.key === 'Escape') {
        event.preventDefault()
        keysRef.current.onClose()
      } else if (event.key === ' ') {
        // Whatever has focus (chip list, line waveform, player), Space plays the edited chip while the editor is open.
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!event.repeat) keysRef.current.togglePlay()
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && ours) {
        event.preventDefault()
        event.stopImmediatePropagation()
        keysRef.current.onDelete()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [chipElementId])

  // Any press outside the editor and its own chip closes it (pressing another chip only closes; a
  // further double click opens that chip).
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onDown = (event: globalThis.PointerEvent) => {
      const t = event.target
      if (!(t instanceof Node) || sectionRef.current?.contains(t)) return
      const chip = chipElementId ? document.getElementById(chipElementId) : null
      if (chip?.contains(t)) return
      closeRef.current('outside')
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [chipElementId])

  // ---- trims ----------------------------------------------------------------------------------
  const clampEdge = useCallback((edge: 'start' | 'end', value: number, other: number) => {
    if (!limits) return value
    const v = snapTimelineSec(value)
    return edge === 'start'
      ? Math.max(limits.startMin, Math.min(other - limits.minDuration, v))
      : Math.min(limits.endMax, Math.max(other + limits.minDuration, v))
  }, [limits])
  const commit = useCallback((next: { start: number; end: number } | null) => {
    setDraft(null)
    if (!next || !word || (Math.abs(next.start - word.start) < EPS && Math.abs(next.end - word.end) < EPS)) return
    try {
      onApply(next.start, next.end)
      setMessage('')
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    }
  }, [word, onApply, setDraft])

  const pointerX = (event: PointerEvent) => event.clientX - (trackRef.current?.getBoundingClientRect().left ?? 0)
  const onTrackDown = (event: PointerEvent<HTMLDivElement>) => {
    // The icon buttons sit inside the track; clicking them must not move the play line.
    if (event.button !== 0 || !word || (event.target as HTMLElement).closest('button')) return
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-trim-edge]')
    const kind = (handle?.dataset.trimEdge as 'start' | 'end' | undefined) ?? 'playhead'
    dragRef.current = kind
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // A pointer the browser no longer tracks cannot be captured; the click still places the play line.
    }
    event.preventDefault()
    if (kind !== 'playhead') {
      setAnchor(anchorFor(kind))
      setDraft({ start, end })
      return
    }
    const t = snapTimelineSec(timeAt(pointerX(event)))
    setPlayhead(t)
    if (playerRef.current?.playing) {
      if (t >= word.start && t < word.end) startLoop(t)
      else stopLoop()
    }
  }
  const onTrackMove = (event: PointerEvent<HTMLDivElement>) => {
    const kind = dragRef.current
    if (!kind) return
    const px = pointerX(event)
    if (kind === 'playhead') {
      if (playerRef.current?.playing) stopLoop()
      setPlayhead(snapTimelineSec(timeAt(px)))
    } else {
      // The moved edge follows the pointer at the fixed scale from the anchored opposite edge.
      const held = anchorRef.current ?? anchorFor(kind)
      const t = held.time + (px - held.x) / TIMING_PX_PER_SEC
      const cur = draftRef.current ?? { start, end }
      setDraft(kind === 'start' ? { ...cur, start: clampEdge('start', t, cur.end) } : { ...cur, end: clampEdge('end', t, cur.start) })
    }
  }
  const onTrackUp = () => {
    const kind = dragRef.current
    dragRef.current = null
    if (kind === 'start' || kind === 'end') commit(draftRef.current)
  }
  const onTrackCancel = () => {
    dragRef.current = null
    setDraft(null)
  }
  const onHandleKey = (edge: 'start' | 'end') => (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const step = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? .01 : .001)
    if (!anchorRef.current) setAnchor(anchorFor(edge))
    const cur = draftRef.current ?? { start, end }
    setDraft(edge === 'start' ? { ...cur, start: clampEdge('start', cur.start + step, cur.end) } : { ...cur, end: clampEdge('end', cur.end + step, cur.start) })
  }
  const onHandleKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') commit(draftRef.current)
  }

  // ---- split / undo ---------------------------------------------------------------------------
  const splitLabel = word && !draft ? splitWordLabel(word, snapTimelineSec(playhead)) : null
  const split = () => {
    if (!splitLabel) return
    try {
      onSplit(snapTimelineSec(playhead))
      setMessage('')
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    }
  }

  // ---- drawing --------------------------------------------------------------------------------
  const paint = () => {
    const canvas = canvasRef.current
    const scroll = scrollRef.current
    if (!canvas || !scroll) return
    const view = scroll.clientWidth
    const left = scroll.scrollLeft
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.max(1, Math.round(view * dpr))
    canvas.height = Math.round(TRACK_H * dpr)
    let ctx: CanvasRenderingContext2D | null = null
    try {
      ctx = canvas.getContext('2d')
    } catch {
      ctx = null
    }
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, view, TRACK_H)
    const mid = WAVE_TOP + WAVE_H / 2
    const amp = WAVE_H / 2 - 6
    const paths = { current: new Path2D(), chip: new Path2D(), deleted: new Path2D() }
    boxes.forEach((box, i) => {
      const x0 = layout.xs[i]! - left
      const w = (box.end - box.start) * TIMING_PX_PER_SEC
      if (x0 > view || x0 + w < 0) return
      ctx!.beginPath()
      ctx!.roundRect(x0 + 1, WAVE_TOP, Math.max(1, w - 2), WAVE_H, Math.min(6, Math.max(1, w - 2) / 2))
      ctx!.fillStyle = COLORS[box.kind].fill
      ctx!.fill()
      ctx!.lineWidth = box.kind === 'current' ? 1.5 : 1
      ctx!.strokeStyle = COLORS[box.kind].stroke
      ctx!.stroke()
      const from = Math.max(0, Math.floor(x0 + 1))
      const to = Math.min(view, Math.ceil(x0 + w - 1))
      // Baseline keeps silence visible instead of leaving holes in the box.
      ctx!.strokeStyle = '#33414f'
      ctx!.lineWidth = 1
      ctx!.beginPath()
      ctx!.moveTo(from, Math.round(mid) + .5)
      ctx!.lineTo(to, Math.round(mid) + .5)
      ctx!.stroke()
      for (let px = from; px < to; px++) {
        const t0 = box.start + (px - x0) / TIMING_PX_PER_SEC
        const t1 = Math.min(box.end, t0 + 1 / TIMING_PX_PER_SEC)
        const env = chunkEnvelope(chunksRef.current, t0 * TIMING_PCM_RATE, t1 * TIMING_PCM_RATE)
        if (!env) continue
        // Fixed square-root curve: quiet speech stays readable and loud audio never clips (same for every chip).
        const top = mid - curve(env.max) * amp
        const bottom = mid - curve(env.min) * amp
        paths[box.kind].moveTo(px + .5, top)
        paths[box.kind].lineTo(px + .5, Math.max(bottom, top + 1))
      }
    })
    for (const kind of ['deleted', 'chip', 'current'] as const) {
      ctx.strokeStyle = COLORS[kind].wave
      ctx.stroke(paths[kind])
    }
  }
  const paintRef = useRef(paint)
  paintRef.current = paint
  useLayoutEffect(() => paintRef.current())

  // ---- layout: strip width, scroll to the chip, chip-to-trim lines ------------------------------
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const measure = () => setViewWidth(scroll.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [])
  // Keep the selected chip in view when the strip is wider than the panel (long neighbours).
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || !word || scroll.clientWidth <= 0) return
    const a = x(word.start)
    const b = x(word.end)
    if (a < scroll.scrollLeft + PAD || b > scroll.scrollLeft + scroll.clientWidth - PAD) {
      // A chip wider than the panel opens at its start trim line; a shorter one is centred.
      scroll.scrollLeft = Math.max(0, b - a > scroll.clientWidth - 4 * PAD ? a - 3 * PAD : (a + b) / 2 - scroll.clientWidth / 2)
    }
  }, [word, x, viewWidth])
  // The mouse wheel scrolls a strip wider than the panel sideways (native listener: wheel must not be passive).
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const onWheel = (event: WheelEvent) => {
      if (scroll.scrollWidth <= scroll.clientWidth || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      event.preventDefault()
      scroll.scrollLeft += event.deltaY
    }
    scroll.addEventListener('wheel', onWheel, { passive: false })
    return () => scroll.removeEventListener('wheel', onWheel)
  }, [])

  const measureLinks = useCallback(() => {
    const section = sectionRef.current
    const scroll = scrollRef.current
    const chip = chipElementId ? document.getElementById(chipElementId) : null
    if (!section || !scroll || !chip) {
      setLinks(null)
      return
    }
    const s = section.getBoundingClientRect()
    const v = scroll.getBoundingClientRect()
    const c = chip.getBoundingClientRect()
    const clampX = (px: number) => Math.max(v.left - s.left, Math.min(v.right - s.left, px))
    const next: Links = {
      chipLeft: c.left - s.left, chipRight: c.right - s.left, chipBottom: c.bottom - s.top,
      startX: clampX(v.left - s.left + x(start) - scroll.scrollLeft),
      endX: clampX(v.left - s.left + x(end) - scroll.scrollLeft),
      waveTop: v.top - s.top + WAVE_TOP
    }
    setLinks(prev => prev && Object.keys(next).every(k => Math.abs(prev[k as keyof Links] - next[k as keyof Links]) < .5) ? prev : next)
  }, [chipElementId, x, start, end])
  useLayoutEffect(() => measureLinks())
  // Chips animate into place after edits; follow them for a moment.
  useEffect(() => {
    let frame = 0
    const until = performance.now() + 450
    const follow = () => {
      measureLinks()
      if (performance.now() < until) frame = requestAnimationFrame(follow)
    }
    frame = requestAnimationFrame(follow)
    return () => cancelAnimationFrame(frame)
  }, [lines, measureLinks])
  useEffect(() => {
    const section = sectionRef.current
    if (!section || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measureLinks())
    observer.observe(section)
    const chip = chipElementId ? document.getElementById(chipElementId) : null
    if (chip?.parentElement) observer.observe(chip.parentElement)
    return () => observer.disconnect()
  }, [chipElementId, measureLinks])

  if (!word || word.isDeleted || !limits) return null
  // Keep the icon row inside the strip when the chip sits at its very edge.
  const actionsHalf = ACTION_SIZE * 1.5 + 8
  const actionsX = Math.max(actionsHalf, Math.min(Math.max(trackWidth, viewWidth) - actionsHalf, x((start + end) / 2)))
  const playheadInStrip = boxes.some(box => playhead >= box.start - EPS && playhead <= box.end + EPS)
  // Where the moved edge was before this drag: the anchored edge plus or minus the chip's length.
  const originalX = draft && anchor
    ? anchor.x + (anchor.edge === 'end' ? 1 : -1) * (word.end - word.start) * TIMING_PX_PER_SEC : null
  return (
    <section ref={sectionRef} className="word-timing-editor" aria-label={`단어 시간 편집 · ${word.word || '오디오'}`}
      data-subtitle-edit data-waveform-no-dismiss="1"
      onClick={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
      onKeyDown={event => {
        // Keep arrows and typing inside the editor; parent caret handlers edit the transcript. Undo/redo still bubble.
        if (!((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase()))) event.stopPropagation()
      }}>
      {links ? (
        <svg className="word-timing-links" aria-hidden="true" width="1" height="1">
          <line x1={links.chipLeft + 1} y1={links.chipBottom} x2={links.startX} y2={links.waveTop} />
          <line x1={links.chipRight - 1} y1={links.chipBottom} x2={links.endX} y2={links.waveTop} />
        </svg>
      ) : null}
      <div ref={scrollRef} className="word-timing-scroll" onScroll={() => { paintRef.current(); measureLinks() }}>
        <div ref={trackRef} className="word-timing-track" style={{ width: Math.max(trackWidth, viewWidth), height: TRACK_H }}
          onPointerDown={onTrackDown} onPointerMove={onTrackMove} onPointerUp={onTrackUp} onPointerCancel={onTrackCancel}>
          <canvas ref={canvasRef} className="word-timing-canvas" style={{ width: viewWidth || '100%', height: TRACK_H }}
            role="img" aria-label="선택한 칩과 앞뒤 칩의 오디오 파형" />
          {boxes.map(box => box.kind === 'current' || (box.end - box.start) * TIMING_PX_PER_SEC >= 56 ? (
            <span key={`${box.kind}:${box.word.id ?? box.word.start}`} className={`word-timing-box-label word-timing-box-label--${box.kind}`}
              style={{ left: x(box.start) + 2, top: LABEL_TOP }}>{formatStripTime(box.start)}</span>
          ) : null)}
          {originalX != null ? (
            <div className="word-timing-original" style={{ left: originalX, top: WAVE_TOP - TRIM_OVERHANG, height: WAVE_H + TRIM_OVERHANG * 2 }}
              aria-hidden="true" />
          ) : null}
          {playheadInStrip ? (
            <div className="word-timing-playhead-hit" style={{ left: x(playhead), top: 0, height: WAVE_TOP + WAVE_H }} aria-hidden="true" />
          ) : null}
          {(['start', 'end'] as const).map(edge => {
            const value = edge === 'start' ? start : end
            const dragging = !!draft && dragRef.current === edge
            // Centred on the trim line: the dark centre line is exactly the boundary.
            return (
              <div key={edge} role="slider" tabIndex={0} data-trim-edge={edge}
                className={`word-timing-trim word-timing-trim--${edge}${dragging ? ' word-timing-trim--dragging' : ''}`}
                style={{ left: x(value), top: WAVE_TOP - TRIM_OVERHANG, height: WAVE_H + TRIM_OVERHANG * 2 }}
                aria-label={edge === 'start' ? '시작 트림' : '끝 트림'}
                aria-valuemin={range.start} aria-valuemax={range.end} aria-valuenow={value}
                aria-valuetext={formatStripTime(value, 3)}
                onKeyDown={onHandleKey(edge)} onKeyUp={onHandleKeyUp}>
                <span className="word-timing-knob" />
                {dragging ? <span className="word-timing-trim-time">{formatStripTime(value, 3)}</span> : null}
              </div>
            )
          })}
          {playheadInStrip ? (
            <div className="word-timing-playhead" style={{ left: x(playhead), height: WAVE_TOP + WAVE_H }} aria-hidden="true">
              <span className="word-timing-playhead-bubble">
                {formatStripTime(playhead)}
                {splitLabel && !word.isSilence ? <em>{splitLabel.left}|{splitLabel.right}</em> : null}
              </span>
            </div>
          ) : null}
          <span className="word-timing-length" style={{ left: x((start + end) / 2), top: LENGTH_TOP }}>
            {(end - start).toFixed(2)}초
          </span>
          {/* Icon buttons centred under the selected chip's waveform (names show as tooltips). */}
          <div className="word-timing-actions" style={{ left: actionsX, top: ACTIONS_TOP }}>
            <button type="button" className="word-timing-action word-timing-action--play" aria-label={playing ? '정지' : '재생'}
              aria-pressed={playing} onClick={togglePlay} data-tip={playing ? '정지 (Space)' : '재생 (Space)'}>
              {playing ? <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="3.5" width="8" height="9" rx="1" /></svg>
                : <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.2v9.6L13 8z" /></svg>}
            </button>
            <button type="button" className="word-timing-action" aria-label="구간 나누기" disabled={!splitLabel} onClick={split}
              data-tip={splitLabel ? '구간 나누기' : '구간 나누기 (재생 라인을 칩 안에 두세요)'}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v13M4.5 5.5 2 8l2.5 2.5M11.5 5.5 14 8l-2.5 2.5" /></svg>
            </button>
            <button type="button" className="word-timing-action" aria-label="구간 되돌리기" onClick={() => { setMessage(''); onUndo() }}
              data-tip="구간 되돌리기 (Ctrl+Z)">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3 2.5 6l3 3M2.8 6h6.7a4 4 0 0 1 0 8H6" /></svg>
            </button>
          </div>
        </div>
      </div>
      <div className="word-timing-footer">
        {message ? <p role="alert" className="word-timing-message">{message}</p> : null}
        <button type="button" className="word-timing-close" onClick={() => onClose()}>닫기</button>
      </div>
    </section>
  )
}
