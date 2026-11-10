/**
 * 워터마크 설정 팝업 — 이미지 업로드, 모서리 위치, 투명도, 크기.
 * 바꾸는 즉시 저장(localStorage)하므로 다음에 열 때·다음 영상에서도 그대로 쓴다.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import {
  WATERMARK_CORNERS,
  WATERMARK_SIZE_MAX,
  WATERMARK_SIZE_MIN,
  WATERMARK_STORAGE_KEY,
  WATERMARK_TRANSPARENCY_MAX,
  normalizeWatermark,
  watermarkRect,
  type WatermarkSettings
} from '../../../shared/watermark'
import './WatermarkDialog.css'

/** 저장 공간(localStorage 약 5MB)을 넘지 않게 긴 변을 줄인다 */
const MAX_IMAGE_SIDE = 1280
const MAX_DATA_URL_CHARS = 3_000_000

export function loadWatermarkSettings(): WatermarkSettings {
  try {
    const raw = window.localStorage.getItem(WATERMARK_STORAGE_KEY)
    return normalizeWatermark(raw ? JSON.parse(raw) : null)
  } catch {
    return normalizeWatermark(null)
  }
}

/** 저장하지 못하면 false (용량 초과 등) */
export function saveWatermarkSettings(settings: WatermarkSettings): boolean {
  try {
    window.localStorage.setItem(WATERMARK_STORAGE_KEY, JSON.stringify(settings))
    return true
  } catch {
    return false
  }
}

async function imageFileToDataUrl(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = objectUrl
    await img.decode()
    const w0 = img.naturalWidth || 512
    const h0 = img.naturalHeight || 512
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(w0, h0))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w0 * scale))
    canvas.height = Math.max(1, Math.round(h0 * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    // 투명 배경을 지키려고 PNG를 먼저 쓰고, 너무 크면 투명을 지원하는 WebP로 줄인다.
    let url = canvas.toDataURL('image/png')
    if (url.length > MAX_DATA_URL_CHARS) url = canvas.toDataURL('image/webp', 0.9)
    if (url.length > MAX_DATA_URL_CHARS || !url.startsWith('data:image/')) throw new Error('too-large')
    return url
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

type Props = {
  settings: WatermarkSettings
  onChange: (next: WatermarkSettings) => void
  onClose: () => void
  /** 미리보기 비율 — 원본 영상 크기 (없으면 16:9) */
  videoWidth: number
  videoHeight: number
}

export function WatermarkDialog({ settings, onChange, onClose, videoWidth, videoHeight }: Props): ReactElement {
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => {
    setImageSize(null)
    if (!settings.imageDataUrl) return
    const img = new Image()
    let alive = true
    img.onload = () => { if (alive) setImageSize({ w: img.naturalWidth, h: img.naturalHeight }) }
    img.src = settings.imageDataUrl
    return () => { alive = false }
  }, [settings.imageDataUrl])

  const update = (patch: Partial<WatermarkSettings>) => onChange({ ...settings, ...patch })

  const pickFile = async (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) { setError('이미지 파일(PNG, JPG, WebP 등)만 쓸 수 있습니다.'); return }
    setBusy(true)
    setError('')
    try {
      const url = await imageFileToDataUrl(file)
      update({ imageDataUrl: url, enabled: true })
    } catch (e) {
      setError(e instanceof Error && e.message === 'too-large'
        ? '이미지가 너무 큽니다. 더 작은 이미지를 골라 주세요.'
        : '이미지를 읽지 못했습니다. 다른 이미지를 골라 주세요.')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const frameW = videoWidth > 0 && videoHeight > 0 ? videoWidth : 1920
  const frameH = videoWidth > 0 && videoHeight > 0 ? videoHeight : 1080
  const rect = imageSize ? watermarkRect(frameW, frameH, imageSize.w, imageSize.h, settings) : null
  const hasImage = Boolean(settings.imageDataUrl)

  return <div className="wm-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
    <div className="wm-card" role="dialog" aria-modal="true" aria-labelledby="wm-title">
      <div className="wm-head">
        <h2 id="wm-title" className="wm-title">워터마크</h2>
        <button type="button" className="wm-close" onClick={onClose} aria-label="닫기">×</button>
      </div>

      <div className="wm-preview" style={{ aspectRatio: `${frameW} / ${frameH}` }} aria-label="워터마크 미리보기">
        {hasImage && rect ? <img src={settings.imageDataUrl ?? undefined} alt="" className="wm-preview-img" style={{
          left: `${(rect.x / frameW) * 100}%`, top: `${(rect.y / frameH) * 100}%`,
          width: `${(rect.width / frameW) * 100}%`, height: `${(rect.height / frameH) * 100}%`,
          opacity: settings.enabled ? 1 - settings.transparency / 100 : 0.25
        }} /> : null}
        {!hasImage && <span className="wm-preview-empty">이미지를 올리면 여기에 위치가 보입니다</span>}
      </div>

      <div className="wm-row">
        <span className="wm-label">이미지</span>
        <div className="wm-image-actions">
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden
            onChange={(e) => void pickFile(e.target.files?.[0])} />
          <button type="button" className="wm-btn wm-btn--primary" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? '불러오는 중…' : hasImage ? '이미지 바꾸기' : '이미지 업로드'}
          </button>
          {hasImage && <button type="button" className="wm-btn" onClick={() => update({ imageDataUrl: null })}>이미지 삭제</button>}
        </div>
      </div>
      {error && <p className="wm-error" role="alert">{error}</p>}

      <div className="wm-row">
        <span className="wm-label">위치</span>
        <div className="wm-corners" role="radiogroup" aria-label="워터마크 위치">
          {WATERMARK_CORNERS.map((c) => <button key={c.value} type="button" role="radio" aria-checked={settings.corner === c.value}
            className={`wm-corner wm-corner--${c.value}${settings.corner === c.value ? ' is-active' : ''}`}
            onClick={() => update({ corner: c.value })}>
            <span className="wm-corner-dot" aria-hidden="true" />{c.label}
          </button>)}
        </div>
      </div>

      <label className="wm-row">
        <span className="wm-label">투명도</span>
        <input type="range" min={0} max={WATERMARK_TRANSPARENCY_MAX} step={1} value={settings.transparency}
          onChange={(e) => update({ transparency: Number(e.target.value) })} />
        <span className="wm-value">{settings.transparency}%</span>
      </label>

      <label className="wm-row">
        <span className="wm-label">크기</span>
        <input type="range" min={WATERMARK_SIZE_MIN} max={WATERMARK_SIZE_MAX} step={1} value={settings.sizePct}
          onChange={(e) => update({ sizePct: Number(e.target.value) })} />
        <span className="wm-value">{settings.sizePct}%</span>
      </label>
      <p className="wm-hint">크기는 영상 너비 기준입니다. 투명도 0%가 가장 선명합니다.</p>

      <div className="wm-foot">
        <label className="wm-toggle">
          <input type="checkbox" checked={settings.enabled} disabled={!hasImage}
            onChange={(e) => update({ enabled: e.target.checked })} />
          「자막 입힌 영상」 내보낼 때 워터마크 넣기
        </label>
        <button type="button" className="wm-btn wm-btn--primary" onClick={onClose}>완료</button>
      </div>
      <p className="wm-hint">설정은 이 브라우저에 저장되어 다음에도 그대로 적용됩니다.</p>
    </div>
  </div>
}
