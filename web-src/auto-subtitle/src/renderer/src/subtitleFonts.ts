/**
 * 사이트에 함께 싣는 자막 글꼴 — Pretendard ExtraBold(800), SIL OFL 1.1 (`assets/fonts/Pretendard-LICENSE.txt`).
 *
 * - 프리뷰: `document.fonts` 에 FontFace 로 등록해 PC에 글꼴이 없어도 같은 모양으로 보이게 한다.
 * - 영상 버닝: 자막 PNG 는 SVG <foreignObject> 이미지로 그리는데, SVG 이미지 안에서는 외부 글꼴을 불러올 수 없다.
 *   그래서 같은 파일을 data: URL 로 바꿔 SVG 스타일에 직접 넣는다(`pretendardFontFaceCss`).
 */
import pretendardExtraBoldUrl from './assets/fonts/Pretendard-ExtraBold.woff2?url'
import { CAPSULE_FONT_FAMILY } from '../../shared/subtitleCapsule'

export const PRETENDARD_FAMILY = CAPSULE_FONT_FAMILY

/** CSS 글꼴 이름이 Pretendard 인지(따옴표·대소문자 무시). */
export function usesPretendard(fontFamily: string | undefined): boolean {
  if (!fontFamily) return false
  return fontFamily.split(',')[0]!.trim().replace(/^['"]|['"]$/g, '').toLowerCase() === PRETENDARD_FAMILY.toLowerCase()
}

let facePromise: Promise<void> | null = null

/** 프리뷰용 등록. 실패해도(오프라인 등) 자막은 대체 글꼴로 계속 보인다. */
export function ensurePretendardLoaded(): Promise<void> {
  if (facePromise) return facePromise
  facePromise = (async () => {
    if (typeof FontFace === 'undefined' || typeof document === 'undefined') return
    const face = new FontFace(PRETENDARD_FAMILY, `url(${JSON.stringify(pretendardExtraBoldUrl)}) format("woff2")`, {
      weight: '800',
      style: 'normal',
      display: 'swap'
    })
    await face.load()
    document.fonts.add(face)
  })().catch((error) => {
    console.warn('Pretendard 글꼴을 불러오지 못했습니다.', error)
    facePromise = null
  })
  return facePromise
}

let cssPromise: Promise<string> | null = null

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('글꼴 파일을 읽지 못했습니다.'))
    reader.readAsDataURL(blob)
  })
}

/** 버닝 SVG 에 넣을 @font-face (data: URL). 한 번만 읽어 둔다. */
export function pretendardFontFaceCss(): Promise<string> {
  if (cssPromise) return cssPromise
  cssPromise = (async () => {
    const res = await fetch(pretendardExtraBoldUrl)
    if (!res.ok) throw new Error(`Pretendard 글꼴을 불러오지 못했습니다. (${res.status})`)
    const dataUrl = await blobToDataUrl(new Blob([await res.arrayBuffer()], { type: 'font/woff2' }))
    return `@font-face{font-family:"${PRETENDARD_FAMILY}";font-style:normal;font-weight:800;src:url(${dataUrl}) format("woff2");}`
  })()
  cssPromise.catch(() => { cssPromise = null })
  return cssPromise
}
