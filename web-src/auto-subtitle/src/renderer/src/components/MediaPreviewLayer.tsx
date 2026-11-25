import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { InsertionGroup, MediaAsset, MediaFit } from '../../../shared/mediaComposition'
import { useAssetUrl } from '../platform/assetUrl'
import './mediaClips.css'

/**
 * Inserted clips playing (or parked) in the preview. The original video and its WebAudio sound are
 * stopped for the whole session; `offset` is seconds into the group where this session started.
 */
export type InsertSession = { seq: number; group: InsertionGroup; offset: number; playing: boolean }

export type PreviewOverlay = { id: string; assetId: string; start: number; end: number; fit: MediaFit }

type Box = { left: number; top: number; width: number; height: number }

type Props = {
  assets: readonly MediaAsset[]
  readyAssets: ReadonlySet<string>
  overlays: readonly PreviewOverlay[]
  session: InsertSession | null
  volume: number
  /** The video frame inside the preview stack; overlays and inserted clips cover exactly this box. */
  box: Box
  /** The App calls the registered function with the original time on every playhead update. */
  registerOverlayUpdate: (update: ((sourceSec: number) => void) | null) => void
  onInsertTime: (groupOffset: number) => void
  onInsertEnd: () => void
}

const boxStyle = (box: Box): CSSProperties => box.width > 0 && box.height > 0
  ? { left: box.left, top: box.top, width: box.width, height: box.height }
  : { left: 0, top: 0, width: '100%', height: '100%' }

export function MediaPreviewLayer(props: Props) {
  const { assets, readyAssets, overlays, session, registerOverlayUpdate } = props
  const assetsById = useMemo(() => new Map(assets.map(a => [a.id, a])), [assets])
  const overlayRootRef = useRef<HTMLDivElement>(null)
  const overlaysRef = useRef(overlays)
  overlaysRef.current = overlays
  const sessionRef = useRef(session)
  sessionRef.current = session
  const lastSourceRef = useRef(0)

  // Overlays are shown and hidden imperatively on every playhead update (no React render per frame).
  useEffect(() => {
    const update = (sourceSec: number) => {
      lastSourceRef.current = sourceSec
      const root = overlayRootRef.current
      if (!root) return
      const hidden = sessionRef.current !== null
      for (const el of Array.from(root.children) as HTMLElement[]) {
        const o = overlaysRef.current.find(item => item.id === el.dataset.overlayId)
        el.style.visibility = !hidden && o && sourceSec >= o.start - 1e-6 && sourceSec < o.end ? 'visible' : 'hidden'
      }
    }
    registerOverlayUpdate(update)
    return () => registerOverlayUpdate(null)
  }, [registerOverlayUpdate])
  useLayoutEffect(() => {
    const root = overlayRootRef.current
    if (!root) return
    const hidden = session !== null
    const t = lastSourceRef.current
    for (const el of Array.from(root.children) as HTMLElement[]) {
      const o = overlays.find(item => item.id === el.dataset.overlayId)
      el.style.visibility = !hidden && o && t >= o.start - 1e-6 && t < o.end ? 'visible' : 'hidden'
    }
  })

  return <>
    <div ref={overlayRootRef} className="media-overlay-layer" style={boxStyle(props.box)} aria-hidden="true">
      {overlays.map(o => <OverlayImage key={o.id} id={o.id} asset={assetsById.get(o.assetId)}
        ready={readyAssets.has(o.assetId)} fit={o.fit} />)}
    </div>
    {session ? <InsertPlayer key={session.seq} session={session} assetsById={assetsById} readyAssets={readyAssets}
      volume={props.volume} box={props.box} onTime={props.onInsertTime} onEnd={props.onInsertEnd} /> : null}
  </>
}

function OverlayImage(props: { id: string; asset: MediaAsset | undefined; ready: boolean; fit: MediaFit }) {
  const url = useAssetUrl(props.asset?.path, props.ready)
  return <div className="media-overlay-item" data-overlay-id={props.id} style={{ visibility: 'hidden' }}>
    {url ? <img src={url} alt="" draggable={false} style={{ objectFit: props.fit }} /> : null}
  </div>
}

type PlayerProps = {
  session: InsertSession
  assetsById: ReadonlyMap<string, MediaAsset>
  readyAssets: ReadonlySet<string>
  volume: number
  box: Box
  onTime: (offset: number) => void
  onEnd: () => void
}

function InsertPlayer({ session, assetsById, readyAssets, volume, box, onTime, onEnd }: PlayerProps) {
  const { group } = session
  const starts = useMemo(() => {
    let acc = 0
    return group.clips.map(c => { const s = acc; acc += c.duration; return s })
  }, [group])
  const indexAt = (offset: number) => {
    for (let i = group.clips.length - 1; i >= 0; i--) if (offset >= starts[i]! - 1e-6) return i
    return 0
  }
  const [index, setIndex] = useState(() => indexAt(session.offset))
  const indexRef = useRef(index)
  const offsetRef = useRef(session.offset)
  const readyRef = useRef(false)
  const doneRef = useRef(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const callbacks = useRef({ onTime, onEnd })
  callbacks.current = { onTime, onEnd }

  const clip = group.clips[index]!
  const asset = assetsById.get(clip.assetId)
  const url = useAssetUrl(asset?.path, readyAssets.has(clip.assetId))
  const isVideo = clip.kind === 'video'
  /** Without a playable file the clip still lasts its length (black, silent) so playback never stalls. */
  const timerClock = !isVideo || !url
  const timerClockRef = useRef(timerClock)
  timerClockRef.current = timerClock

  // Entering a clip: images (and missing files) are ready at once; a video first seeks to its in-point.
  useEffect(() => {
    readyRef.current = timerClock
    const video = videoRef.current
    if (timerClock || !video) return
    const local = Math.max(0, offsetRef.current - starts[index]!)
    const target = (clip.kind === 'video' ? clip.sourceStart : 0) + Math.min(local, clip.duration)
    const markReady = () => {
      readyRef.current = true
      if (session.playing && !doneRef.current) void video.play().catch(() => undefined)
    }
    const onLoaded = () => {
      if (Math.abs(video.currentTime - target) < 0.02) markReady()
      else video.currentTime = target
    }
    video.addEventListener('seeked', markReady)
    video.addEventListener('loadeddata', onLoaded)
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) onLoaded()
    return () => {
      video.removeEventListener('seeked', markReady)
      video.removeEventListener('loadeddata', onLoaded)
      video.pause()
    }
  }, [index, url, timerClock]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.volume = Math.max(0, Math.min(1, volume))
    video.muted = clip.kind === 'video' ? clip.muted : true
  }, [volume, clip, url])

  // The clock: video time for a playing video clip, wall time for images and missing files.
  useEffect(() => {
    callbacks.current.onTime(offsetRef.current)
    if (!session.playing) {
      videoRef.current?.pause()
      return
    }
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.max(0, (now - last) / 1000)
      last = now
      const i = indexRef.current
      const c = group.clips[i]!
      if (readyRef.current && !doneRef.current) {
        const video = videoRef.current
        if (c.kind === 'video' && video && !timerClockRef.current) {
          offsetRef.current = Math.max(offsetRef.current, starts[i]! + (video.currentTime - c.sourceStart))
        } else {
          offsetRef.current += dt
        }
        if (offsetRef.current >= starts[i]! + c.duration - 1e-3) {
          if (i + 1 < group.clips.length) {
            videoRef.current?.pause()
            offsetRef.current = starts[i + 1]!
            indexRef.current = i + 1
            readyRef.current = false
            setIndex(i + 1)
          } else {
            doneRef.current = true
            videoRef.current?.pause()
            offsetRef.current = group.duration
            callbacks.current.onTime(group.duration)
            callbacks.current.onEnd()
            return
          }
        }
        callbacks.current.onTime(offsetRef.current)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [session.playing, group, starts])

  const fit = { objectFit: clip.fit } as const
  return <div className="media-insert-layer" style={boxStyle(box)} aria-label={`삽입 ${clip.kind === 'image' ? '이미지' : '영상'}: ${asset?.name ?? ''}`}>
    {url ? (isVideo
      ? <video key={clip.id} ref={videoRef} src={url} playsInline preload="auto" style={fit} />
      : <img key={clip.id} src={url} alt="" draggable={false} style={fit} />)
      : <span className="media-insert-missing">{asset ? '파일을 불러오는 중이거나 찾을 수 없습니다' : '파일 정보 없음'}</span>}
  </div>
}
