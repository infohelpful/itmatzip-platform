import { showAdSense } from "../common/adsense.js?v=7";
import {
  defaultWidthMode,
  inspectImage,
  isConstrainedDevice,
  pixelBudget,
  planLayout,
  fitLayoutToBudget,
  shareOrSave,
  stitchImages,
} from "./stitch.js?v=2";

function itzT(key, fallback) {
  return typeof window.itzT === "function" ? window.itzT(key, fallback) : fallback;
}
function itzTf(key, fallback, vars) {
  if (window.ITZ_I18N?.tf) return window.ITZ_I18N.tf(key, vars);
  let s = itzT(key, fallback);
  if (!vars) return s;
  for (const k of Object.keys(vars)) s = String(s).split(`{${k}}`).join(String(vars[k] ?? ""));
  return s;
}

/** @param {string} id */
function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

const dropzone = el("dropzone");
const fileInput = el("file-input");
const statusLine = el("composer-status");
const listSection = el("image-list");
const listMeta = el("list-meta");
const cardList = el("card-list");
const previewStack = el("preview-stack");
const emptyPanel = el("stage-empty");
const readyPanel = el("stage-ready");
const clearBtn = el("btn-clear");
const downloadBtn = el("btn-download");
const shareBtn = el("btn-share");
const widthModeEl = el("width-mode");
const gapEl = el("gap-range");
const gapVal = el("gap-value");
const bgModeEl = el("bg-mode");
const bgCustomWrap = el("bg-custom-wrap");
const bgCustomEl = el("bg-custom");
const formatEl = el("out-format");
const qualityEl = el("jpg-quality");
const qualityRow = el("quality-row");
const qualityVal = el("quality-value");
const estimateLine = el("estimate-line");
const toastBox = el("toast");
const previewModal = el("preview-modal");
const previewImg = el("preview-modal-img");
const previewClose = el("preview-modal-close");
const previewSave = el("preview-modal-save");
const previewShare = el("preview-modal-share");

/** @typedef {{ id: string, file: File, url: string, name: string, width: number, height: number }} Slot */

/** @type {Slot[]} */
let slots = [];
let toastTimer = 0;
let dragId = "";
let dragStartY = 0;
let dragging = false;
/** @type {Blob | null} */
let lastBlob = null;
let lastName = "";

function uid() {
  return `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function showToast(message, isWarn = false) {
  toastBox.hidden = false;
  toastBox.textContent = message;
  toastBox.classList.toggle("is-warn", Boolean(isWarn));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastBox.hidden = true;
  }, 3200);
}

function setStatus(message, isError = false) {
  statusLine.textContent = message || "";
  statusLine.classList.toggle("is-error", Boolean(isError));
}

function currentOptions() {
  let background = bgModeEl.value;
  if (background === "custom") background = bgCustomEl.value || "#ffffff";
  return {
    widthMode: widthModeEl.value,
    gap: Number(gapEl.value) || 0,
    background,
    format: formatEl.value === "png" ? "png" : "jpg",
    quality: Number(qualityEl.value) / 100,
  };
}

function estimatedLayout() {
  const sizes = slots.map((s) => ({ width: s.width, height: s.height }));
  return fitLayoutToBudget(planLayout(sizes, currentOptions()), pixelBudget());
}

function updateEstimate() {
  if (!slots.length) {
    estimateLine.textContent = "";
    return;
  }
  const layout = estimatedLayout();
  const mp = ((layout.canvasW * layout.contentH) / 1e6).toFixed(1);
  estimateLine.textContent = layout.scaled
    ? itzTf("estimateScaled", `출력 약 {w}×{h}px · {mp}MP (메모리 한도에 맞춰 축소)`, {
        w: layout.canvasW,
        h: layout.contentH,
        mp,
      })
    : itzTf("estimateOk", `출력 약 {w}×{h}px · {mp}MP`, {
        w: layout.canvasW,
        h: layout.contentH,
        mp,
      });
}

function syncOptionUi() {
  bgCustomWrap.hidden = bgModeEl.value !== "custom";
  qualityRow.hidden = formatEl.value !== "jpg";
  gapVal.textContent = `${gapEl.value}px`;
  qualityVal.textContent = `${qualityEl.value}%`;
  const constrained = isConstrainedDevice();
  shareBtn.hidden = !(constrained && typeof navigator.canShare === "function");
  updateEstimate();
  renderPreviewStack();
}

function renderPreviewStack() {
  previewStack.replaceChildren();
  previewStack.style.gap = `${gapEl.value}px`;
  const bg = currentOptions().background;
  previewStack.style.background = bg === "transparent" ? "transparent" : bg;
  previewStack.classList.toggle("is-checker", bg === "transparent");
  for (const slot of slots) {
    const img = document.createElement("img");
    img.src = slot.url;
    img.alt = slot.name;
    img.draggable = false;
    previewStack.append(img);
  }
}

function renderCards() {
  cardList.replaceChildren();
  slots.forEach((slot, index) => {
    const card = document.createElement("article");
    card.className = "thumb-card";
    card.dataset.id = slot.id;
    card.setAttribute("role", "listitem");

    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "thumb-handle";
    handle.setAttribute("aria-label", itzT("dragHandle", "순서 이동"));
    handle.textContent = "↕";

    const img = document.createElement("img");
    img.className = "thumb-img";
    img.src = slot.url;
    img.alt = "";
    img.draggable = false;

    const meta = document.createElement("div");
    meta.className = "thumb-meta";
    const name = document.createElement("span");
    name.className = "thumb-name";
    name.textContent = slot.name;
    const size = document.createElement("span");
    size.className = "thumb-size";
    size.textContent = `${slot.width}×${slot.height}`;
    meta.append(name, size);

    const moves = document.createElement("div");
    moves.className = "thumb-moves";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "thumb-move";
    up.textContent = "▲";
    up.disabled = index === 0;
    up.setAttribute("aria-label", itzT("moveUp", "위로"));
    up.addEventListener("click", (event) => {
      event.stopPropagation();
      moveSlot(slot.id, -1);
    });
    const down = document.createElement("button");
    down.type = "button";
    down.className = "thumb-move";
    down.textContent = "▼";
    down.disabled = index === slots.length - 1;
    down.setAttribute("aria-label", itzT("moveDown", "아래로"));
    down.addEventListener("click", (event) => {
      event.stopPropagation();
      moveSlot(slot.id, 1);
    });
    moves.append(up, down);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "thumb-remove";
    remove.setAttribute("aria-label", itzT("removeOne", "삭제"));
    remove.textContent = "×";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeSlot(slot.id);
    });

    card.append(handle, img, meta, moves, remove);
    bindCardDrag(card, handle);
    cardList.append(card);
  });
}

function refreshList() {
  const empty = slots.length === 0;
  emptyPanel.hidden = !empty;
  readyPanel.hidden = empty;
  listSection.hidden = empty;
  downloadBtn.disabled = empty;
  shareBtn.disabled = empty;
  listMeta.textContent = empty
    ? ""
    : itzTf("listMeta", `{n}장`, { n: slots.length });
  renderCards();
  syncOptionUi();
}

function moveSlot(id, delta) {
  const i = slots.findIndex((s) => s.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= slots.length) return;
  const copy = slots.slice();
  const [item] = copy.splice(i, 1);
  copy.splice(j, 0, item);
  slots = copy;
  refreshList();
}

function removeSlot(id) {
  const found = slots.find((s) => s.id === id);
  if (found) URL.revokeObjectURL(found.url);
  slots = slots.filter((s) => s.id !== id);
  refreshList();
  setStatus(slots.length ? itzTf("countStatus", `{n}장 준비됨`, { n: slots.length }) : "");
}

function clearAll() {
  for (const slot of slots) URL.revokeObjectURL(slot.url);
  slots = [];
  fileInput.value = "";
  lastBlob = null;
  refreshList();
  setStatus("");
}

function isImageFile(file) {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  if (type.startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|gif)$/i.test(name);
}

async function addFiles(fileList) {
  const incoming = [...fileList].filter((file) => isImageFile(file));
  if (!incoming.length) {
    setStatus(itzT("needImage", "JPG, PNG, WebP, GIF 파일을 선택하세요."), true);
    return;
  }
  const heic = [...fileList].filter((file) => /\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type));
  if (heic.length) {
    showToast(itzT("heicWarn", "HEIC는 이 브라우저에서 열리지 않을 수 있습니다. JPG로 저장해 주세요."), true);
  }
  const failed = [];
  for (const file of incoming) {
    try {
      const size = await inspectImage(file);
      const url = URL.createObjectURL(file);
      slots.push({
        id: uid(),
        file,
        url,
        name: file.name || "image",
        width: size.width,
        height: size.height,
      });
    } catch {
      failed.push(file.name || "image");
    }
  }
  if (slots.length >= 30) {
    showToast(itzT("warnMany", "30장 이상이면 브라우저가 느려질 수 있습니다. 10~20장을 권장합니다."), true);
  } else if (slots.length > 20) {
    showToast(itzT("hintMany", "최적의 성능과 품질을 위해 1회 10~20장 내외를 권장합니다."), true);
  }
  refreshList();
  if (failed.length) {
    setStatus(itzTf("failSome", "일부 파일을 읽지 못했습니다: {names}", { names: failed.join(", ") }), true);
  } else {
    setStatus(itzTf("countStatus", `{n}장 준비됨`, { n: slots.length }));
  }
}

function bindCardDrag(card, handle) {
  const start = (event) => {
    if (event.button != null && event.button !== 0) return;
    dragId = card.dataset.id || "";
    dragStartY = event.clientY;
    dragging = false;
    handle.setPointerCapture?.(event.pointerId);
  };
  const move = (event) => {
    if (!dragId) return;
    if (!dragging && Math.abs(event.clientY - dragStartY) < 8) return;
    dragging = true;
    card.classList.add("is-dragging");
    const y = event.clientY;
    const others = [...cardList.querySelectorAll(".thumb-card")].filter((node) => node !== card);
    let insertBefore = null;
    for (const other of others) {
      const rect = other.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        insertBefore = other;
        break;
      }
    }
    if (insertBefore) insertBefore.before(card);
    else cardList.append(card);
    slots = [...cardList.querySelectorAll(".thumb-card")]
      .map((node) => slots.find((s) => s.id === node.dataset.id))
      .filter(Boolean);
  };
  const end = () => {
    const moved = Boolean(dragging);
    dragId = "";
    dragging = false;
    card.classList.remove("is-dragging");
    if (moved) refreshList();
  };
  handle.addEventListener("pointerdown", start);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

function filenameFor() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "");
  const ext = currentOptions().format === "png" ? "png" : "jpg";
  return `image-combiner-${stamp}.${ext}`;
}

function openPreview(blob) {
  if (previewImg.src && previewImg.src.startsWith("blob:")) URL.revokeObjectURL(previewImg.src);
  previewImg.src = URL.createObjectURL(blob);
  previewModal.hidden = false;
}

function closePreview() {
  previewModal.hidden = true;
  if (previewImg.src && previewImg.src.startsWith("blob:")) {
    URL.revokeObjectURL(previewImg.src);
    previewImg.removeAttribute("src");
  }
}

async function runExport(preferShare) {
  if (!slots.length) return;
  downloadBtn.disabled = true;
  shareBtn.disabled = true;
  setStatus(itzT("working", "세로로 이어붙이는 중…"));
  try {
    const opts = currentOptions();
    const result = await stitchImages(
      slots.map((s) => s.file),
      { ...opts, sizes: slots.map((s) => ({ width: s.width, height: s.height })) },
    );
    lastBlob = result.blob;
    lastName = filenameFor();
    if (result.scaled) {
      showToast(itzT("scaledToast", "메모리 한도에 맞춰 가로를 줄여 저장합니다."), true);
    }
    const share = await shareOrSave(result.blob, lastName, { preferShare });
    if (share.aborted) {
      setStatus(itzT("cancelled", "저장을 취소했습니다."));
      return;
    }
    if ((share.needPreview || isConstrainedDevice()) && share.via !== "share") openPreview(result.blob);
    setStatus(itzTf("saved", `저장됨 · {w}×{h}px`, { w: result.width, h: result.height }));
  } catch (error) {
    setStatus(error instanceof Error ? error.message : itzT("failStitch", "이어붙이기에 실패했습니다."), true);
  } finally {
    downloadBtn.disabled = !slots.length;
    shareBtn.disabled = !slots.length;
  }
}

function bindUi() {
  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("is-dragover");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-dragover"));
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragover");
    const files = event.dataTransfer?.files;
    if (files?.length) void addFiles(files);
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.length) void addFiles(fileInput.files);
    fileInput.value = "";
  });
  clearBtn.addEventListener("click", clearAll);
  downloadBtn.addEventListener("click", () => void runExport(false));
  shareBtn.addEventListener("click", () => void runExport(true));
  widthModeEl.addEventListener("change", syncOptionUi);
  gapEl.addEventListener("input", syncOptionUi);
  bgModeEl.addEventListener("change", syncOptionUi);
  bgCustomEl.addEventListener("input", syncOptionUi);
  formatEl.addEventListener("change", syncOptionUi);
  qualityEl.addEventListener("input", syncOptionUi);
  previewClose.addEventListener("click", closePreview);
  previewModal.addEventListener("click", (event) => {
    if (event.target === previewModal) closePreview();
  });
  previewSave.addEventListener("click", () => {
    if (!lastBlob) return;
    void shareOrSave(lastBlob, lastName);
  });
  previewShare.addEventListener("click", () => {
    if (!lastBlob) return;
    void shareOrSave(lastBlob, lastName, { preferShare: true });
  });
}

function bootDefaults() {
  widthModeEl.value = defaultWidthMode();
  syncOptionUi();
}

function boot() {
  bindUi();
  bootDefaults();
  refreshList();
  void showAdSense("editorAboveWorkspace", "#editor-ad-above-path");
  void showAdSense("editorBelowExport", "#editor-ad-below-export");
  document.addEventListener("itz:lang-change", () => {
    refreshList();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
