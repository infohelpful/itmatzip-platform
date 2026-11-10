/**
 * Renders export subtitle states to PNG in the browser.
 *
 * The desktop app loads `exportSubtitle.html` in an offscreen window per state and captures it.
 * Here the same `ExportSubtitleFrame` markup is rendered into a hidden element, serialized with its
 * stylesheet into an SVG <foreignObject>, and drawn onto a canvas at the render size. Text layout,
 * wrapping and system fonts therefore come from the same browser layout engine as the preview.
 */
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { ExportSubtitleUpdatePayload } from '../../../shared/ipc'
import { watermarkRect, type ExportWatermark } from '../../../shared/watermark'
import { ExportSubtitleFrame, buildPreviewSubtitleTextStyle } from '../ExportSubtitle'
import exportSubtitleCss from '../exportSubtitle.css?inline'
import { ensurePretendardLoaded, pretendardFontFaceCss, usesPretendard } from '../subtitleFonts'

export class SubtitleFrameRenderer {
  private readonly host: HTMLDivElement
  private readonly root: Root
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D

  private watermarkImage: HTMLImageElement | null = null
  /** 자막 없는 상태(워터마크만)는 매번 같은 그림이라 한 번만 만든다 */
  private blankBlob: Blob | null = null

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly watermark?: ExportWatermark
  ) {
    this.host = document.createElement('div')
    // Laid out but never visible, so measurements match an on-screen render.
    Object.assign(this.host.style, {
      position: 'fixed', left: '0', top: '0', width: `${width}px`, height: `${height}px`,
      opacity: '0', pointerEvents: 'none', zIndex: '-1', overflow: 'hidden'
    })
    document.body.appendChild(this.host)
    this.root = createRoot(this.host)
    this.canvas = document.createElement('canvas')
    this.canvas.width = width
    this.canvas.height = height
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('캔버스를 만들 수 없습니다.')
    this.ctx = ctx
  }

  async render(data: ExportSubtitleUpdatePayload): Promise<Blob> {
    if (!data.text.trim()) {
      if (!this.blankBlob) {
        this.ctx.clearRect(0, 0, this.width, this.height)
        await this.drawWatermark()
        this.blankBlob = await this.toPng()
      }
      return this.blankBlob
    }
    const textStyle = buildPreviewSubtitleTextStyle({
      videoNaturalWidth: data.layoutWidth ?? data.width,
      subtitleBgColor: data.bgColor,
      subtitleBgOpacity: data.bgOpacity,
      subtitleFontFamily: data.fontFamily,
      subtitleFontSize: data.fontSize,
      subtitleFontWeight: data.fontWeight,
      subtitleTextColor: data.textColor,
      subtitleStrokeColor: data.strokeColor,
      subtitleStrokeWidth: data.strokeWidth,
      subtitleX: data.x,
      subtitleY: data.y,
      subtitleBgPaddingPct: data.bgPaddingPct ?? 100,
      subtitleBoxStyle: data.boxStyle
    })
    // SVG 이미지 안에서는 외부 글꼴을 못 불러오므로, 함께 싣는 글꼴은 data: URL 로 직접 넣는다.
    const bundledFontCss = usesPretendard(data.fontFamily) ? await pretendardFontFaceCss() : ''
    if (bundledFontCss) await ensurePretendardLoaded()
    flushSync(() => this.root.render(createElement(ExportSubtitleFrame, { data, textStyle })))
    if (data.text.trim()) await document.fonts.load(`${data.fontWeight} ${data.fontSize}px "${data.fontFamily}"`).catch(() => [])
    await document.fonts.ready

    const markup = new XMLSerializer().serializeToString(this.host.firstElementChild ?? document.createElement('div'))
    // vw/vh in the export stylesheet mean the capture window; pin them to the render size.
    const css = `${bundledFontCss}${exportSubtitleCss}\n.export-subtitle-root{width:${this.width}px;height:${this.height}px;}`
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}">` +
      `<foreignObject x="0" y="0" width="${this.width}" height="${this.height}">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${this.width}px;height:${this.height}px;margin:0;padding:0">` +
      `<style>${escapeXml(css)}</style>${markup}</div></foreignObject></svg>`
    const image = new Image()
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    await image.decode()
    this.ctx.clearRect(0, 0, this.width, this.height)
    this.ctx.drawImage(image, 0, 0, this.width, this.height)
    await this.drawWatermark()
    return this.toPng()
  }

  private toPng(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('자막 이미지를 만들지 못했습니다.'))), 'image/png')
    })
  }

  private async drawWatermark(): Promise<void> {
    const wm = this.watermark
    if (!wm) return
    if (!this.watermarkImage) {
      const img = new Image()
      img.src = wm.imageDataUrl
      try {
        await img.decode()
      } catch {
        throw new Error('워터마크 이미지를 읽지 못했습니다. 워터마크 설정에서 이미지를 다시 골라 주세요.')
      }
      this.watermarkImage = img
    }
    const img = this.watermarkImage
    const rect = watermarkRect(this.width, this.height, img.naturalWidth, img.naturalHeight, wm)
    if (rect.width <= 0 || rect.height <= 0) return
    this.ctx.save()
    this.ctx.globalAlpha = 1 - wm.transparency / 100
    this.ctx.imageSmoothingQuality = 'high'
    this.ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height)
    this.ctx.restore()
  }

  dispose(): void {
    this.root.unmount()
    this.host.remove()
  }
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
