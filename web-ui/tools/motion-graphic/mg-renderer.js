/**
 * 브라우저 미리보기 렌더러 — mg-core.js composeFrame 결과를 DOM 으로 그린다.
 * Remotion 쪽(agent/engines/motion_graphic_core/src/Main.tsx)과 같은 규칙:
 *  - zoom 은 원본 영상 + 효과 레이어를 담은 박스에 transform (translate(-ox,-oy) scale(s), origin 0 0)
 *  - full(FULL 장면)은 그 위에 원본 해상도 좌표로 그리고 CSS scale 로 화면에 맞춘다
 */
import { composeFrame, UNITLESS } from "./mg-core.js?v=7";

const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set(["svg", "path", "circle", "rect", "line", "polyline", "polygon", "g", "defs", "linearGradient", "stop"]);

function cssName(key) {
  if (key.startsWith("Webkit")) return `-webkit-${cssName(key.slice(6).replace(/^./, (m) => m.toLowerCase()))}`;
  return key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function applyStyle(el, style) {
  for (const [key, value] of Object.entries(style || {})) {
    if (value === undefined || value === null) continue;
    const v = typeof value === "number" && !UNITLESS.has(key) ? `${value}px` : String(value);
    el.style.setProperty(cssName(key), v);
  }
}

let assetUrl = (name) => name;

function build(node) {
  if (!node) return null;
  if (node.t === "img") {
    const img = document.createElement("img");
    img.decoding = "async";
    const raw = node.a?.src;
    const name = typeof raw === "object" && raw ? raw.asset : String(raw || "");
    img.src = /^https?:\/\//i.test(name) ? name : assetUrl(name);
    applyStyle(img, node.s);
    return img;
  }
  const isSvg = SVG_TAGS.has(node.t);
  const el = isSvg ? document.createElementNS(SVG_NS, node.t) : document.createElement(node.t);
  applyStyle(el, node.s);
  if (node.a) for (const [k, v] of Object.entries(node.a)) el.setAttribute(k, String(v));
  if (typeof node.c === "string") el.textContent = node.c;
  else if (Array.isArray(node.c)) {
    for (const child of node.c) {
      const c = build(child);
      if (c) el.appendChild(c);
    }
  }
  return el;
}

export class DesignRenderer {
  /**
   * @param {{zoomBox: HTMLElement, fxRoot: HTMLElement, fullRoot: HTMLElement}} roots
   *   zoomBox: 원본 video 와 fxRoot 를 담은 박스(무대 크기), fxRoot/fullRoot: 원본 해상도 크기 레이어(CSS scale 로 맞춤)
   */
  constructor(roots, assetUrlFn) {
    Object.assign(this, roots);
    if (assetUrlFn) assetUrl = assetUrlFn;
    this.lastKey = "";
    this.enabled = true;
  }

  render(design, frame, revisionKey = "") {
    if (!design || !this.enabled) {
      if (this.lastKey !== "off") this.clear();
      this.lastKey = "off";
      return null;
    }
    const key = `${revisionKey}|${frame}`;
    if (key === this.lastKey) return this.lastState;
    this.lastKey = key;
    const W = design.width || 1920;
    const H = design.height || 1080;
    const state = composeFrame(design, frame, { w: W, h: H });
    const { s, ox, oy } = state.zoom;
    this.zoomBox.style.transform = s === 1 && !ox && !oy ? "" : `translate(${(-ox / W) * 100}%, ${(-oy / H) * 100}%) scale(${s})`;
    this.fxRoot.replaceChildren(...state.fx.map(build).filter(Boolean));
    this.fullRoot.replaceChildren(...(state.full ? [build(state.full)] : []));
    this.lastState = state;
    return state;
  }

  clear() {
    this.zoomBox.style.transform = "";
    this.fxRoot.replaceChildren();
    this.fullRoot.replaceChildren();
  }

  invalidate() {
    this.lastKey = "";
  }
}
