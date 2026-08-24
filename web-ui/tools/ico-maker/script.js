import { showAdSense } from "../common/adsense.js?v=2";

const ICON_SIZES = [
  { px: 16, hint: "탐색기 자세히 · 트레이" },
  { px: 24, hint: "125% DPI · 툴바" },
  { px: 32, hint: "바탕화면 · 보통 아이콘" },
  { px: 48, hint: "탐색기 크게" },
  { px: 64, hint: "고해상도 중간" },
  { px: 128, hint: "아주 크게 중간" },
  { px: 256, hint: "탐색기 매우 크게" },
];

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const statusLine = document.getElementById("composer-status");
const sizePills = document.getElementById("size-pills");
const skipUpscale = document.getElementById("opt-no-upscale");
const fitMode = document.getElementById("fit-mode");
const emptyPanel = document.getElementById("stage-empty");
const readyPanel = document.getElementById("stage-ready");
const heroPic = document.getElementById("hero-image");
const heroName = document.getElementById("hero-name");
const heroSize = document.getElementById("hero-size");
const downloadBtn = document.getElementById("btn-download");
const clearBtn = document.getElementById("btn-clear");
const qualitySection = document.getElementById("qualities");
const qualityMeta = document.getElementById("qualities-meta");
const qualityGrid = document.getElementById("quality-grid");
const toastBox = document.getElementById("toast");

/** @type {{ fileName: string, source: HTMLImageElement, objectUrl: string } | null} */
let loaded = null;
let toastTimer = 0;

function showToast(message) {
  toastBox.hidden = false;
  toastBox.textContent = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastBox.hidden = true;
  }, 3200);
}

function setStatus(message, isError = false) {
  statusLine.textContent = message || "";
  statusLine.classList.toggle("is-error", Boolean(isError));
}

function selectedSizes() {
  return [...sizePills.querySelectorAll("input[type='checkbox']:checked:not(:disabled)")]
    .map((el) => Number(el.value))
    .sort((a, b) => a - b);
}

function renderSizePills() {
  sizePills.replaceChildren();
  for (const item of ICON_SIZES) {
    const label = document.createElement("label");
    label.className = "size-pill";
    label.title = item.hint;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = String(item.px);
    box.checked = true;
    const text = document.createElement("span");
    text.textContent = `${item.px}×${item.px}`;
    label.append(box, text);
    box.addEventListener("change", () => {
      if (loaded) refreshPreviews();
    });
    sizePills.appendChild(label);
  }
}

function syncSizePills() {
  const maxEdge = loaded ? Math.max(loaded.source.naturalWidth, loaded.source.naturalHeight) : Infinity;
  for (const box of sizePills.querySelectorAll("input[type='checkbox']")) {
    const tooBig = Boolean(loaded) && skipUpscale.checked && Number(box.value) > maxEdge;
    box.disabled = tooBig;
    if (tooBig) box.checked = false;
    box.closest(".size-pill")?.classList.toggle("is-disabled", tooBig);
  }
}

function drawIcon(source, size, mode) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 없음");
  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const iw = source.naturalWidth;
  const ih = source.naturalHeight;
  let dw;
  let dh;
  let dx;
  let dy;
  if (mode === "stretch") {
    dw = size;
    dh = size;
    dx = 0;
    dy = 0;
  } else if (mode === "cover") {
    const scale = Math.max(size / iw, size / ih);
    dw = iw * scale;
    dh = ih * scale;
    dx = (size - dw) / 2;
    dy = (size - dh) / 2;
  } else {
    const scale = Math.min(size / iw, size / ih);
    dw = iw * scale;
    dh = ih * scale;
    dx = (size - dw) / 2;
    dy = (size - dh) / 2;
  }
  ctx.drawImage(source, dx, dy, dw, dh);
  return canvas;
}

function canvasToBmpIcon(canvas) {
  const width = canvas.width;
  const height = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas 없음");
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const xorSize = width * 4 * height;
  const andStride = ((width + 31) >> 5) << 2;
  const andSize = andStride * height;
  const headerSize = 40;
  const out = new Uint8Array(headerSize + xorSize + andSize);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, 40, true);
  view.setInt32(4, width, true);
  view.setInt32(8, height * 2, true);
  view.setUint16(12, 1, true);
  view.setUint16(14, 32, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, xorSize, true);

  let offset = headerSize;
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      out[offset++] = pixels[i + 2];
      out[offset++] = pixels[i + 1];
      out[offset++] = pixels[i];
      out[offset++] = pixels[i + 3];
    }
  }
  return out;
}

function isBmpIconBytes(bytes, width, height) {
  if (bytes.length < 40) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(0, true) === 40
    && view.getInt32(4, true) === width
    && view.getInt32(8, true) === height * 2
    && view.getUint16(14, true) === 32;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function u16le(value) {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function u32le(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function buildZip(files) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = file.data;
    const crc = crc32(data);
    const local = concatBytes([
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      u16le(20),
      u16le(0x0800),
      u16le(0),
      u16le(0),
      u16le(0),
      u32le(crc),
      u32le(data.length),
      u32le(data.length),
      u16le(name.length),
      u16le(0),
      name,
      data,
    ]);
    const central = concatBytes([
      new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
      u16le(20),
      u16le(20),
      u16le(0x0800),
      u16le(0),
      u16le(0),
      u16le(0),
      u32le(crc),
      u32le(data.length),
      u32le(data.length),
      u16le(name.length),
      u16le(0),
      u16le(0),
      u16le(0),
      u16le(0),
      u32le(0),
      u32le(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = concatBytes(centrals);
  return concatBytes([
    ...locals,
    centralDir,
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    u16le(0),
    u16le(0),
    u16le(files.length),
    u16le(files.length),
    u32le(centralDir.length),
    u32le(offset),
    u16le(0),
  ]);
}

function triggerDownload(blob, filename) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

function readIcoSizes(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) return [];
  const count = view.getUint16(4, true);
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const base = 6 + i * 16;
    const byteLen = view.getUint32(base + 8, true);
    const imageOffset = view.getUint32(base + 12, true);
    if (imageOffset + byteLen > buf.byteLength) continue;
    const width = buf[base] === 0 ? 256 : buf[base];
    const height = buf[base + 1] === 0 ? 256 : buf[base + 1];
    sizes.push(`${width}×${height}`);
  }
  return sizes;
}

function packIco(images) {
  const count = images.length;
  const headerBytes = 6 + 16 * count;
  let cursor = headerBytes;
  const laid = images.map((img) => {
    const item = { width: img.width, height: img.height, bytes: img.bytes, offset: cursor };
    cursor += img.bytes.length;
    return item;
  });
  const out = new Uint8Array(cursor);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, count, true);
  laid.forEach((img, index) => {
    const base = 6 + index * 16;
    out[base] = img.width >= 256 ? 0 : img.width;
    out[base + 1] = img.height >= 256 ? 0 : img.height;
    out[base + 2] = 0;
    out[base + 3] = 0;
    view.setUint16(base + 4, 1, true);
    view.setUint16(base + 6, 32, true);
    view.setUint32(base + 8, img.bytes.length, true);
    view.setUint32(base + 12, img.offset, true);
    out.set(img.bytes, img.offset);
  });
  return out;
}

function makeIconBytes(source, px) {
  const canvas = drawIcon(source, px, fitMode.value);
  const bytes = canvasToBmpIcon(canvas);
  if (!isBmpIconBytes(bytes, px, px)) {
    throw new Error(`${px}×${px} 아이콘 데이터를 만들지 못했습니다.`);
  }
  return { width: px, height: px, bytes };
}

function refreshPreviews() {
  if (!loaded) return;
  syncSizePills();
  const sizes = selectedSizes();
  const count = sizes.length;
  downloadBtn.textContent = count > 0 ? `체크한 ${count}개 ZIP 다운로드` : "체크한 크기 다운로드";
  downloadBtn.disabled = count === 0;
  if (!count) {
    qualitySection.hidden = true;
    qualityGrid.replaceChildren();
    setStatus("포함할 해상도를 하나 이상 선택하세요.", true);
    return;
  }

  qualityGrid.replaceChildren();
  const mode = fitMode.value;
  for (const px of sizes) {
    const canvas = drawIcon(loaded.source, px, mode);
    const card = document.createElement("article");
    card.className = "quality-card";
    const wrap = document.createElement("div");
    wrap.className = "quality-thumb-wrap";
    const img = document.createElement("img");
    img.className = "quality-thumb" + (px <= 32 ? " is-pixel" : "");
    img.alt = `${px}픽셀 아이콘`;
    img.src = canvas.toDataURL("image/png");
    wrap.appendChild(img);
    const title = document.createElement("div");
    title.className = "quality-title";
    title.textContent = `${px}×${px}`;
    const hint = ICON_SIZES.find((item) => item.px === px);
    const meta = document.createElement("div");
    meta.className = "quality-size";
    meta.textContent = hint ? hint.hint : "";
    card.append(wrap, title, meta);
    qualityGrid.appendChild(card);
  }

  qualityMeta.textContent = `${sizes.map((px) => `${px}×${px}`).join(" · ")} · ${count}개`;
  qualitySection.hidden = false;
  setStatus(`체크한 ${count}개를 ZIP으로 받습니다. 압축을 풀면 크기별 ICO와 PNG가 있습니다.`);
}

async function loadFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    setStatus("이미지 파일을 선택하세요. PNG를 권장합니다.", true);
    return;
  }

  if (loaded?.objectUrl) URL.revokeObjectURL(loaded.objectUrl);
  const objectUrl = URL.createObjectURL(file);
  const source = new Image();
  source.decoding = "async";
  try {
    await new Promise((resolve, reject) => {
      source.onload = () => resolve();
      source.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
      source.src = objectUrl;
    });
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    setStatus(error instanceof Error ? error.message : "이미지를 읽지 못했습니다.", true);
    return;
  }

  loaded = { fileName: file.name, source, objectUrl };
  heroPic.src = objectUrl;
  heroName.textContent = file.name;
  heroSize.textContent = `${source.naturalWidth}×${source.naturalHeight}`;
  emptyPanel.hidden = true;
  readyPanel.hidden = false;
  refreshPreviews();
}

function canvasToPngBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("PNG 변환 실패"));
        return;
      }
      blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
    }, "image/png");
  });
}

async function downloadIco() {
  if (!loaded) return;
  const sizes = selectedSizes();
  if (!sizes.length) {
    setStatus("포함할 해상도를 하나 이상 선택하세요.", true);
    return;
  }

  downloadBtn.disabled = true;
  try {
    const images = [];
    const pngFiles = [];
    for (const px of sizes) {
      const canvas = drawIcon(loaded.source, px, fitMode.value);
      const bytes = canvasToBmpIcon(canvas);
      if (!isBmpIconBytes(bytes, px, px)) {
        throw new Error(`${px}×${px} 아이콘 데이터를 만들지 못했습니다.`);
      }
      images.push({ width: px, height: px, bytes });
      pngFiles.push({
        name: `${px}x${px}.png`,
        data: await canvasToPngBytes(canvas),
      });
    }
    const combined = packIco([...images].sort((a, b) => b.width - a.width));
    const contained = readIcoSizes(combined);
    if (contained.length !== images.length) {
      throw new Error("ICO에 해상도가 다 들어가지 않았습니다.");
    }

    const base = loaded.fileName.replace(/\.[^.]+$/, "") || "icon";
    const zipFiles = [
      { name: `${base}.ico`, data: combined },
      ...images.map((img) => ({
        name: `${base}-${img.width}x${img.height}.ico`,
        data: packIco([img]),
      })),
      ...pngFiles.map((file) => ({
        name: `${base}-${file.name}`,
        data: file.data,
      })),
    ];
    triggerDownload(new Blob([buildZip(zipFiles)], { type: "application/zip" }), `${base}-ico.zip`);
    const summary = `${contained.join(" · ")} (${contained.length}개)`;
    setStatus(`ZIP 저장됨 · ${summary}. 압축을 풀면 크기별 ICO와 PNG가 있습니다.`);
    showToast(`체크한 ${contained.length}개 ZIP 저장`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "ICO를 만들지 못했습니다.", true);
  } finally {
    downloadBtn.disabled = false;
  }
}

function resetAll() {
  if (loaded?.objectUrl) URL.revokeObjectURL(loaded.objectUrl);
  loaded = null;
  fileInput.value = "";
  heroPic.removeAttribute("src");
  emptyPanel.hidden = false;
  readyPanel.hidden = true;
  qualitySection.hidden = true;
  qualityGrid.replaceChildren();
  downloadBtn.textContent = "체크한 크기 다운로드";
  downloadBtn.disabled = false;
  syncSizePills();
  setStatus("");
}

function bindUi() {
  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("is-dragover");
  });
  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("is-dragover");
  });
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragover");
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadFile(file);
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void loadFile(file);
  });
  skipUpscale.addEventListener("change", () => {
    if (loaded) refreshPreviews();
  });
  fitMode.addEventListener("change", () => {
    if (loaded) refreshPreviews();
  });
  downloadBtn.addEventListener("click", () => {
    void downloadIco();
  });
  clearBtn.addEventListener("click", resetAll);
}

function boot() {
  renderSizePills();
  bindUi();
  void showAdSense("editorAboveWorkspace", "#editor-ad-above-path");
  void showAdSense("editorBelowExport", "#editor-ad-below-export");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
