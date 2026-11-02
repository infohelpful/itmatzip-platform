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
import { ExportSubtitleFrame, buildPreviewSubtitleTextStyle } from '../ExportSubtitle'
import exportSubtitleCss from '../exportSubtitle.css?inline'

export class SubtitleFrameRenderer {
  private readonly host: HTMLDivElement
  private readonly root: Root
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D

  constructor(private readonly width: number, private readonly height: number) {
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
      subtitleBgPaddingPct: data.bgPaddingPct ?? 100
    })
    flushSync(() => this.root.render(createElement(ExportSubtitleFrame, { data, textStyle })))
    if (data.text.trim()) await document.fonts.load(`${data.fontWeight} ${data.fontSize}px "${data.fontFamily}"`).catch(() => [])
    await document.fonts.ready

    const markup = new XMLSerializer().serializeToString(this.host.firstElementChild ?? document.createElement('div'))
    // vw/vh in the export stylesheet mean the capture window; pin them to the render size.
    const css = `${exportSubtitleCss}\n.export-subtitle-root{width:${this.width}px;height:${this.height}px;}`
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}">` +
      `<foreignObject x="0" y="0" width="${this.width}" height="${this.height}">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${this.width}px;height:${this.height}px;margin:0;padding:0">` +
      `<style>${escapeXml(css)}</style>${markup}</div></foreignObject></svg>`
    const image = new Image()
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    await image.decode()
    this.ctx.clearRect(0, 0, this.width, this.height)
    this.ctx.drawImage(image, 0, 0, this.width, this.height)
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('자막 이미지를 만들지 못했습니다.'))), 'image/png')
    })
  }

  dispose(): void {
    this.root.unmount()
    this.host.remove()
  }
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
