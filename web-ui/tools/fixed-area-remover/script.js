import {
  applyConnectionStatusDot,
  checkAgentConnection,
  configureBridge,
  fetchAgent,
  formatAgentConnectionError,
  getAgentOrigin,
  primeLocalNetworkAccess,
  requestAgent,
  showInstallAgentDialog,
  setAgentLongOperationActive,
  startConnectionMonitor,
} from "../common/bridge.js?v=lna23";
import { AGENT_PICK_FOLDER, AGENT_PICK_VIDEO } from "../common/agent-pick-endpoints.js";
import { showAdSense } from "../common/adsense.js?v=6";
import { agentInstallDialogOptions } from "../common/agent-install-ui.js?v=lna22";
import { AGENT_PORT } from "../common/agent-endpoints.js";

configureBridge({
  origin:
    typeof window !== "undefined" &&
    (window.location.hostname === "127.0.0.1" ||
      window.location.hostname === "localhost") &&
    Number(window.location.port || "0") === AGENT_PORT
      ? window.location.origin
      : undefined,
  healthPath: "/health",
});

const API = "/api/tools/watermark-remover";
const MAX_EDIT_DIM = 1600;
const BRUSH_OVERLAY_COLOR = "rgba(239, 68, 68, 0.45)";

const SS = {
  output: "watermark-remover:dl-output-path",
  original: "watermark-remover:dl-original-path",
  sourceName: "watermark-remover:dl-source-name",
  editorPath: "watermark-remover:editor-video-path",
  returnFromDl: "watermark-remover:return-from-dl",
  preview: "watermark-remover:result-preview-path",
  originalPreview: "watermark-remover:original-preview-path",
  sourceMode: "watermark-remover:source-mode",
  folderPath: "watermark-remover:folder-path",
  batchOutputDir: "watermark-remover:batch-output-dir",
  batchCount: "watermark-remover:batch-count",
};

const els = {
  videoPath: document.getElementById("video-path"),
  sourceMode: document.getElementById("source-mode"),
  pick: document.getElementById("btn-pick-local-file"),
  newJob: document.getElementById("btn-new-job"),
  prepare: document.getElementById("btn-prepare"),
  start: document.getElementById("btn-start-erase"),
  exportLink: document.getElementById("export-link"),
  openOutputFolder: document.getElementById("btn-open-output-folder"),
  device: document.getElementById("device-select"),
  shell: document.getElementById("enhancer-content-shell"),
  connection: document.getElementById("connection-status"),
  compute: document.getElementById("compute-capability"),
  readiness: document.getElementById("bin-readiness"),
  pathHint: document.getElementById("path-hint"),
  folderMeta: document.getElementById("folder-meta"),
  previewEmpty: document.getElementById("preview-empty"),
  canvasStage: document.getElementById("canvas-stage"),
  editCanvas: document.getElementById("edit-canvas"),
  brushToolbar: document.getElementById("brush-toolbar"),
  toolRect: document.getElementById("tool-rect"),
  toolEllipse: document.getElementById("tool-ellipse"),
  shapeWidthRange: document.getElementById("shape-width-range"),
  shapeWidthValue: document.getElementById("shape-width-value"),
  shapeHeightRange: document.getElementById("shape-height-range"),
  shapeHeightValue: document.getElementById("shape-height-value"),
  clearMask: document.getElementById("btn-clear-mask"),
  canvasHint: document.getElementById("canvas-hint"),
  compareHint: document.getElementById("compare-hint"),
  previewHeading: document.getElementById("preview-panel-heading"),
  previewViewport: document.getElementById("preview-viewport"),
  videoStack: document.getElementById("video-stack"),
  originalVideo: document.getElementById("original-video"),
  resultVideo: document.getElementById("result-video"),
  summaryReady: document.getElementById("summary-model-ready"),
  summaryDevice: document.getElementById("summary-device"),
  summaryBrush: document.getElementById("summary-brush"),
  summaryMask: document.getElementById("summary-mask"),
  summaryFolderRow: document.getElementById("summary-folder-row"),
  summaryFolder: document.getElementById("summary-folder"),
  setupOverlay: document.getElementById("setup-loading"),
  setupStep: document.getElementById("setup-loading-step"),
  setupMessage: document.getElementById("setup-loading-message"),
  setupBar: document.getElementById("setup-loading-bar"),
  setupTrack: document.getElementById("setup-loading-track"),
  eraseOverlay: document.getElementById("erase-loading"),
  eraseStep: document.getElementById("erase-loading-step"),
  eraseMessage: document.getElementById("erase-loading-message"),
  erasePercent: document.getElementById("erase-loading-percent"),
  eraseBar: document.getElementById("erase-loading-bar"),
  eraseTrack: document.getElementById("erase-loading-track"),
};

let toolReady = false;
let agentOk = false;
let currentVideoPath = "";
let currentFolderPath = "";
/** @type {string[]} */
let folderVideoPaths = [];
let batchOutputDir = "";
let outputPath = "";
let resultPreviewPath = "";
let originalPreviewPath = "";
let currentTool = "rect";
let hasMaskPaint = false;
let dragMode = "";
let dragStart = null;
let dragHandle = "";
let dragOrigin = null;
let shiftHeld = false;
/** @type {{ type: "rect" | "ellipse", x: number, y: number, w: number, h: number } | null} */
let region = null;
const MIN_SHAPE = 8;
const HANDLE_IDS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
/** @type {string[]} */
const previewBlobs = [];

let naturalWidth = 0;
let naturalHeight = 0;
let workWidth = 0;
let workHeight = 0;
let baseImage = null;

const editCtx = els.editCanvas ? els.editCanvas.getContext("2d") : null;
const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d");
const overlayCanvas = document.createElement("canvas");
const overlayCtx = overlayCanvas.getContext("2d");

function storePreviewBlob(url) {
  if (url && url.startsWith("blob:")) previewBlobs.push(url);
}

function revokePreviewUrls() {
  while (previewBlobs.length) {
    const url = previewBlobs.pop();
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }
}

function setExportEnabled(enabled) {
  if (!els.exportLink) return;
  els.exportLink.classList.toggle("is-disabled", !enabled);
  els.exportLink.setAttribute("aria-disabled", enabled ? "false" : "true");
}

function isFolderMode() {
  return (els.sourceMode?.value || "file") === "folder";
}

function setOpenOutputFolderEnabled(enabled) {
  if (!els.openOutputFolder) return;
  const show = Boolean(batchOutputDir);
  els.openOutputFolder.hidden = !show;
  els.openOutputFolder.disabled = !enabled || !batchOutputDir;
}

function updateSourceModeUi() {
  const folder = isFolderMode();
  if (els.videoPath) {
    els.videoPath.placeholder = folder ? window.itzT("ui.folderPh", "폴더 경로") : window.itzT("videoPh", "영상 파일 경로");
  }
  if (els.pathHint) {
    els.pathHint.textContent = folder
      ? window.itzT("pathHintFolder", "폴더를 선택하면 첫 영상이 표시됩니다. 고정 영역을 지정한 뒤 「지우기 실행」하면 폴더 전체에 동일하게 적용됩니다.")
      : window.itzT("pathHint", "영상을 선택하면 첫 프레임이 표시됩니다. 사각형 또는 원으로 고정 영역을 지정한 뒤 실행하세요.");
  }
  if (els.canvasHint && !els.canvasHint.hidden) {
    els.canvasHint.textContent = folder
      ? window.itzT("canvasHintFolder", "첫 영상에서 영역을 지정하세요. 같은 위치의 고정 영역이 폴더 안 모든 영상에서 제거됩니다.")
      : window.itzT("canvasHint", "드래그로 영역을 만들고, 모서리를 끌어 크기를 조절하세요. Shift를 누르면 정사각형·정원입니다. 고정 위치 영역은 전 구간에 동일하게 적용됩니다.");
  }
  updateFolderMeta();
}

function updateFolderMeta() {
  const folder = isFolderMode() && currentFolderPath;
  if (els.folderMeta) {
    if (folder && folderVideoPaths.length) {
      els.folderMeta.hidden = false;
      els.folderMeta.textContent = window.ITZ_I18N?.tf?.("folderMeta", { n: folderVideoPaths.length }) || `${folderVideoPaths.length}개 · 첫 영상으로 영역을 지정한 뒤 일괄 적용합니다.`;
    } else if (folder) {
      els.folderMeta.hidden = false;
      els.folderMeta.textContent = window.itzT("noVideos", "폴더에 지원 영상이 없습니다.");
    } else {
      els.folderMeta.hidden = true;
      els.folderMeta.textContent = "";
    }
  }
  if (els.summaryFolderRow) {
    els.summaryFolderRow.hidden = !folder;
  }
  if (els.summaryFolder) {
    els.summaryFolder.textContent = folder ? (window.ITZ_I18N?.tf?.("nItems", { n: folderVideoPaths.length }) || `${folderVideoPaths.length}개`) : "—";
  }
}

function updateSummary() {
  if (els.summaryDevice) {
    const device = els.device?.value || "auto";
    els.summaryDevice.textContent =
      device === "cuda" ? "CUDA" : device === "cpu" ? "CPU" : window.itzT("ui.auto", "자동");
  }
  if (els.summaryBrush) {
    if (!region) els.summaryBrush.textContent = window.itzT("ui.none", "없음");
    else {
      const label = region.type === "ellipse" ? window.itzT("ui.circle", "원형") : window.itzT("ui.rect", "사각형");
      els.summaryBrush.textContent = `${label} ${Math.round(region.w)}×${Math.round(region.h)}`;
    }
  }
  if (els.summaryMask) els.summaryMask.textContent = hasMaskPaint ? window.itzT("ui.maskSet", "지정됨") : window.itzT("maskEmpty", "비어 있음");
  updateFolderMeta();
}

function updateEraseButtonState() {
  if (!els.start) return;
  const hasSource = isFolderMode()
    ? Boolean(currentFolderPath && currentVideoPath && folderVideoPaths.length)
    : Boolean(currentVideoPath);
  els.start.disabled = !hasSource || !hasMaskPaint;
}

function syncShellBusy() {
  const busy =
    Boolean(els.setupOverlay?.classList.contains("is-active")) ||
    Boolean(els.eraseOverlay?.classList.contains("is-active"));
  if (!els.shell) return;
  if (busy) els.shell.setAttribute("aria-busy", "true");
  else els.shell.removeAttribute("aria-busy");
}

function focusBusyOverlay(overlay) {
  const panel = overlay.querySelector(".enhancer-busy-panel");
  requestAnimationFrame(() => {
    overlay.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    if (!panel) return;
    if (!panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
    panel.focus({ preventScroll: true });
  });
}

function setBusy(kind, visible, pct = 0, step = "", message = "") {
  const overlay = kind === "setup" ? els.setupOverlay : els.eraseOverlay;
  const bar = kind === "setup" ? els.setupBar : els.eraseBar;
  const track = kind === "setup" ? els.setupTrack : els.eraseTrack;
  const stepEl = kind === "setup" ? els.setupStep : els.eraseStep;
  const msgEl = kind === "setup" ? els.setupMessage : els.eraseMessage;
  if (!overlay) return;
  const wasActive = overlay.classList.contains("is-active");
  overlay.hidden = !visible;
  overlay.classList.toggle("is-active", visible);
  overlay.setAttribute("aria-hidden", visible ? "false" : "true");
  const agentText = typeof window.itzAgentText === "function" ? window.itzAgentText : (v) => v || "";
  if (stepEl) stepEl.textContent = agentText(step) || "";
  if (msgEl) msgEl.textContent = agentText(message) || (visible ? window.itzT("ui.processing", "처리 중…") : "");
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  if (bar) bar.style.width = `${clamped}%`;
  if (track) track.setAttribute("aria-valuenow", String(Math.round(clamped)));
  if (kind === "erase" && els.erasePercent) {
    els.erasePercent.textContent = `${Math.round(clamped)}%`;
  }
  syncShellBusy();
  if (visible && !wasActive) focusBusyOverlay(overlay);
}

async function fetchImageBlobUrlFromAgentPath(path, directUrl = "") {
  const origin = getAgentOrigin();
  const candidates = [];
  if (directUrl) candidates.push({ method: "GET", url: directUrl });
  candidates.push({
    method: "POST",
    url: `${origin}${API}/preview`,
    body: { video_path: path },
  });
  candidates.push({
    method: "GET",
    url: `${origin}${API}/media/image?image_path=${encodeURIComponent(path)}`,
  });

  let lastErr = null;
  for (const candidate of candidates) {
    try {
      const init = {
        method: candidate.method,
        cache: "no-store",
        headers: candidate.body ? { "Content-Type": "application/json" } : undefined,
        body: candidate.body ? JSON.stringify(candidate.body) : undefined,
      };
      const res = await fetchAgent(candidate.url, init);
      if (!res.ok) {
        if (res.status === 404 || res.status === 405) continue;
        throw new Error(`HTTP ${res.status}`);
      }
      const blob = await res.blob();
      if (!blob.size) throw new Error("empty image");
      const url = URL.createObjectURL(blob);
      storePreviewBlob(url);
      return url;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("미리보기 로드 실패");
}

async function resolveImageSrc(path, directUrl = "") {
  const pageHost = window.location.hostname;
  const loopback =
    pageHost === "127.0.0.1" || pageHost === "localhost" || pageHost === "[::1]";
  if (loopback && directUrl) return directUrl;
  return fetchImageBlobUrlFromAgentPath(path, directUrl);
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("미리보기 프레임을 불러올 수 없습니다."));
    img.src = src;
  });
}

function videoMediaUrl(path) {
  return `${getAgentOrigin()}${API}/media/video?video_path=${encodeURIComponent(path)}`;
}

function clearStackVideo(el) {
  if (!el) return;
  el.pause();
  el.removeAttribute("src");
  el.load();
}

function bindStackVideo(el, path) {
  clearStackVideo(el);
  if (!el || !path) return;
  el.src = videoMediaUrl(path);
}

function syncVideoFrameAspect(videoEl) {
  const w = Number(videoEl?.videoWidth || 0);
  const h = Number(videoEl?.videoHeight || 0);
  if (!w || !h) return;
  const ratio = `${w} / ${h}`;
  document.querySelectorAll(".video-frame").forEach((frame) => {
    frame.style.aspectRatio = ratio;
  });
}

function hideResultVideos() {
  if (els.videoStack) els.videoStack.hidden = true;
  if (els.compareHint) els.compareHint.hidden = true;
  if (els.previewViewport) els.previewViewport.hidden = false;
  clearStackVideo(els.originalVideo);
  clearStackVideo(els.resultVideo);
}

function showEmptyState() {
  hideResultVideos();
  if (els.previewEmpty) els.previewEmpty.hidden = false;
  if (els.canvasStage) els.canvasStage.hidden = true;
  if (els.brushToolbar) els.brushToolbar.hidden = true;
  if (els.canvasHint) els.canvasHint.hidden = true;
  if (els.previewHeading) {
    els.previewHeading.removeAttribute("data-preview-mode");
    els.previewHeading.textContent = window.itzT("ui.previewOriginal", "원본 미리보기");
  }
}

function showCanvasEditor() {
  hideResultVideos();
  if (els.previewEmpty) els.previewEmpty.hidden = true;
  if (els.canvasStage) els.canvasStage.hidden = false;
  if (els.brushToolbar) els.brushToolbar.hidden = false;
  if (els.canvasHint) {
    els.canvasHint.hidden = false;
    els.canvasHint.textContent = isFolderMode()
      ? window.itzT("canvasHintFolder", "첫 영상에서 영역을 지정하세요. 같은 위치의 고정 영역이 폴더 안 모든 영상에서 제거됩니다.")
      : window.itzT("canvasHint", "드래그로 영역을 만들고, 모서리를 끌어 크기를 조절하세요. Shift를 누르면 정사각형·정원입니다. 고정 위치 영역은 전 구간에 동일하게 적용됩니다.");
  }
  if (els.previewHeading) {
    els.previewHeading.textContent = isFolderMode()
      ? window.itzT("headingFolderPaint", "첫 영상에서 고정 영역을 지정하세요")
      : window.itzT("headingPaint", "고정 영역을 지정하세요");
  }
}

function showResultVideos() {
  const originalPath = currentVideoPath;
  const resultPath = outputPath;
  if (els.previewEmpty) els.previewEmpty.hidden = true;
  if (els.canvasStage) els.canvasStage.hidden = true;
  if (els.previewViewport) els.previewViewport.hidden = true;
  if (els.brushToolbar) els.brushToolbar.hidden = true;
  if (els.canvasHint) els.canvasHint.hidden = true;
  if (els.compareHint) {
    els.compareHint.hidden = false;
    els.compareHint.textContent = isFolderMode()
      ? window.itzT("compareFolderHint", "위는 첫 영상의 원본, 아래는 해당 결과입니다. 나머지 결과는 「결과 폴더 열기」로 확인하세요.")
      : window.itzT("compareHint", "위는 원본, 아래는 고정 영역을 제거한 결과입니다. 각각 재생할 수 있습니다.");
  }
  if (els.videoStack) els.videoStack.hidden = false;
  if (els.previewHeading) {
    els.previewHeading.setAttribute("data-preview-mode", "compare");
    els.previewHeading.textContent = window.itzT("ui.previewCompare", "원본 / 결과");
  }
  bindStackVideo(els.originalVideo, originalPath);
  bindStackVideo(els.resultVideo, resultPath && resultPath !== originalPath ? resultPath : "");
  els.originalVideo?.addEventListener(
    "loadedmetadata",
    (ev) => syncVideoFrameAspect(ev.currentTarget),
    { once: true },
  );
}

function renderOverlay() {
  if (!overlayCtx || !workWidth || !workHeight) return;
  overlayCtx.clearRect(0, 0, workWidth, workHeight);
  overlayCtx.globalCompositeOperation = "source-over";
  overlayCtx.fillStyle = BRUSH_OVERLAY_COLOR;
  overlayCtx.fillRect(0, 0, workWidth, workHeight);
  overlayCtx.globalCompositeOperation = "destination-in";
  overlayCtx.drawImage(maskCanvas, 0, 0);
  overlayCtx.globalCompositeOperation = "source-over";
}

function handleSize() {
  return Math.max(8, Math.round(Math.min(workWidth, workHeight) * 0.018));
}

function regionHandles(r) {
  const x1 = r.x;
  const y1 = r.y;
  const x2 = r.x + r.w;
  const y2 = r.y + r.h;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return {
    nw: { x: x1, y: y1 },
    n: { x: cx, y: y1 },
    ne: { x: x2, y: y1 },
    e: { x: x2, y: cy },
    se: { x: x2, y: y2 },
    s: { x: cx, y: y2 },
    sw: { x: x1, y: y2 },
    w: { x: x1, y: cy },
  };
}

function drawHandles() {
  if (!editCtx || !region) return;
  const size = handleSize();
  const handles = regionHandles(region);
  editCtx.save();
  editCtx.strokeStyle = "rgba(250, 250, 250, 0.95)";
  editCtx.fillStyle = "#eab308";
  editCtx.lineWidth = 1.5;
  for (const id of HANDLE_IDS) {
    const pt = handles[id];
    editCtx.fillRect(pt.x - size / 2, pt.y - size / 2, size, size);
    editCtx.strokeRect(pt.x - size / 2, pt.y - size / 2, size, size);
  }
  editCtx.restore();
}

function composeDisplay() {
  if (!editCtx || !workWidth || !workHeight || !baseImage) return;
  editCtx.clearRect(0, 0, workWidth, workHeight);
  editCtx.drawImage(baseImage, 0, 0, workWidth, workHeight);
  editCtx.drawImage(overlayCanvas, 0, 0);
  if (region) {
    editCtx.save();
    editCtx.strokeStyle = "rgba(250, 204, 21, 0.95)";
    editCtx.lineWidth = 1.5;
    editCtx.setLineDash([6, 4]);
    if (region.type === "ellipse") {
      editCtx.beginPath();
      editCtx.ellipse(
        region.x + region.w / 2,
        region.y + region.h / 2,
        region.w / 2,
        region.h / 2,
        0,
        0,
        Math.PI * 2,
      );
      editCtx.stroke();
    } else {
      editCtx.strokeRect(region.x, region.y, region.w, region.h);
    }
    editCtx.restore();
    drawHandles();
  }
}

function rasterizeRegion() {
  if (!maskCtx || !workWidth || !workHeight) return;
  maskCtx.clearRect(0, 0, workWidth, workHeight);
  if (!region || region.w < MIN_SHAPE || region.h < MIN_SHAPE) return;
  maskCtx.fillStyle = "#ffffff";
  if (region.type === "ellipse") {
    maskCtx.beginPath();
    maskCtx.ellipse(
      region.x + region.w / 2,
      region.y + region.h / 2,
      region.w / 2,
      region.h / 2,
      0,
      0,
      Math.PI * 2,
    );
    maskCtx.fill();
  } else {
    maskCtx.fillRect(region.x, region.y, region.w, region.h);
  }
}

function clampRegion(r) {
  const w = Math.max(MIN_SHAPE, Math.min(r.w, workWidth));
  const h = Math.max(MIN_SHAPE, Math.min(r.h, workHeight));
  const x = Math.max(0, Math.min(r.x, workWidth - w));
  const y = Math.max(0, Math.min(r.y, workHeight - h));
  return { type: r.type, x, y, w, h };
}

function commitRegion(next) {
  region = next ? clampRegion(next) : null;
  rasterizeRegion();
  renderOverlay();
  composeDisplay();
  refreshMaskState();
  syncShapeSliders();
}

function maskHasAnyPaint() {
  return Boolean(region && region.w >= MIN_SHAPE && region.h >= MIN_SHAPE);
}

function refreshMaskState() {
  hasMaskPaint = maskHasAnyPaint();
  updateSummary();
  updateEraseButtonState();
}

function clearMask() {
  region = null;
  dragMode = "";
  dragStart = null;
  dragHandle = "";
  dragOrigin = null;
  if (maskCtx && workWidth && workHeight) maskCtx.clearRect(0, 0, workWidth, workHeight);
  renderOverlay();
  composeDisplay();
  refreshMaskState();
  syncShapeSliders();
}

function syncShapeSliderMax() {
  if (els.shapeWidthRange) els.shapeWidthRange.max = String(Math.max(MIN_SHAPE, workWidth || 800));
  if (els.shapeHeightRange) els.shapeHeightRange.max = String(Math.max(MIN_SHAPE, workHeight || 800));
}

function syncShapeSliders() {
  const w = region ? Math.round(region.w) : Number(els.shapeWidthRange?.value || 120);
  const h = region ? Math.round(region.h) : Number(els.shapeHeightRange?.value || 80);
  if (els.shapeWidthRange) els.shapeWidthRange.value = String(w);
  if (els.shapeHeightRange) els.shapeHeightRange.value = String(h);
  if (els.shapeWidthValue) els.shapeWidthValue.textContent = `${w}px`;
  if (els.shapeHeightValue) els.shapeHeightValue.textContent = `${h}px`;
}

function applySliderSize() {
  if (!region || !workWidth) return;
  const w = Number(els.shapeWidthRange?.value || region.w);
  const h = Number(els.shapeHeightRange?.value || region.h);
  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;
  commitRegion({
    type: region.type,
    x: cx - w / 2,
    y: cy - h / 2,
    w,
    h,
  });
}

async function setupCanvasesForImage(img) {
  baseImage = img;
  naturalWidth = img.naturalWidth || img.width;
  naturalHeight = img.naturalHeight || img.height;
  const scale = Math.min(1, MAX_EDIT_DIM / Math.max(naturalWidth, naturalHeight, 1));
  workWidth = Math.max(1, Math.round(naturalWidth * scale));
  workHeight = Math.max(1, Math.round(naturalHeight * scale));

  if (els.editCanvas) {
    els.editCanvas.width = workWidth;
    els.editCanvas.height = workHeight;
  }
  maskCanvas.width = workWidth;
  maskCanvas.height = workHeight;
  overlayCanvas.width = workWidth;
  overlayCanvas.height = workHeight;
  region = null;
  syncShapeSliderMax();
  rasterizeRegion();
  renderOverlay();
  composeDisplay();
  refreshMaskState();
  syncShapeSliders();
}

function canvasPointFromEvent(ev) {
  if (!els.editCanvas) return { x: 0, y: 0, scale: 1 };
  const rect = els.editCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return { x: 0, y: 0, scale: 1 };
  const scaleX = els.editCanvas.width / rect.width;
  const scaleY = els.editCanvas.height / rect.height;
  return {
    x: (ev.clientX - rect.left) * scaleX,
    y: (ev.clientY - rect.top) * scaleY,
    scale: scaleX,
  };
}

function hitHandle(point) {
  if (!region) return "";
  const size = handleSize() + 4;
  const handles = regionHandles(region);
  for (const id of HANDLE_IDS) {
    const pt = handles[id];
    if (Math.abs(point.x - pt.x) <= size / 2 && Math.abs(point.y - pt.y) <= size / 2) {
      return id;
    }
  }
  return "";
}

function hitBody(point) {
  if (!region) return false;
  if (region.type === "ellipse") {
    const rx = region.w / 2;
    const ry = region.h / 2;
    if (rx < 1 || ry < 1) return false;
    const nx = (point.x - (region.x + rx)) / rx;
    const ny = (point.y - (region.y + ry)) / ry;
    return nx * nx + ny * ny <= 1;
  }
  return (
    point.x >= region.x &&
    point.x <= region.x + region.w &&
    point.y >= region.y &&
    point.y <= region.y + region.h
  );
}

function setCanvasCursor(kind) {
  if (!els.editCanvas) return;
  els.editCanvas.classList.remove(
    "is-move",
    "is-nw-resize",
    "is-n-resize",
    "is-ne-resize",
    "is-e-resize",
    "is-se-resize",
    "is-s-resize",
    "is-sw-resize",
    "is-w-resize",
  );
  if (kind && kind !== "crosshair") els.editCanvas.classList.add(`is-${kind}`);
}

function cursorForHandle(id) {
  if (id === "n" || id === "s") return `${id}-resize`;
  if (id === "e" || id === "w") return `${id}-resize`;
  return `${id}-resize`;
}

function normalizeBox(x0, y0, x1, y1, lockRatio) {
  let left = Math.min(x0, x1);
  let top = Math.min(y0, y1);
  let w = Math.abs(x1 - x0);
  let h = Math.abs(y1 - y0);
  if (lockRatio) {
    const side = Math.max(w, h);
    w = side;
    h = side;
    if (x1 < x0) left = x0 - w;
    if (y1 < y0) top = y0 - h;
  }
  return clampRegion({ type: currentTool, x: left, y: top, w, h });
}

function resizeFromHandle(handle, point, origin, lockRatio) {
  const x1 = origin.x;
  const y1 = origin.y;
  const x2 = origin.x + origin.w;
  const y2 = origin.y + origin.h;
  let nx1 = x1;
  let ny1 = y1;
  let nx2 = x2;
  let ny2 = y2;
  if (handle.includes("w")) nx1 = point.x;
  if (handle.includes("e")) nx2 = point.x;
  if (handle.includes("n")) ny1 = point.y;
  if (handle.includes("s")) ny2 = point.y;
  if (lockRatio) {
    const cx = origin.x + origin.w / 2;
    const cy = origin.y + origin.h / 2;
    const side = Math.max(Math.abs(nx2 - nx1), Math.abs(ny2 - ny1));
    if (handle.includes("w")) nx1 = nx2 - side;
    if (handle.includes("e")) nx2 = nx1 + side;
    if (handle.includes("n")) ny1 = ny2 - side;
    if (handle.includes("s")) ny2 = ny1 + side;
    if (handle === "n" || handle === "s") {
      nx1 = cx - side / 2;
      nx2 = cx + side / 2;
    }
    if (handle === "e" || handle === "w") {
      ny1 = cy - side / 2;
      ny2 = cy + side / 2;
    }
  }
  return clampRegion({
    type: origin.type,
    x: Math.min(nx1, nx2),
    y: Math.min(ny1, ny2),
    w: Math.abs(nx2 - nx1),
    h: Math.abs(ny2 - ny1),
  });
}

function onPointerDown(ev) {
  if (!baseImage || !workWidth) return;
  ev.preventDefault();
  shiftHeld = Boolean(ev.shiftKey);
  const point = canvasPointFromEvent(ev);
  try {
    els.editCanvas.setPointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }
  const handle = hitHandle(point);
  if (handle) {
    dragMode = "resize";
    dragHandle = handle;
    dragOrigin = { ...region };
    dragStart = point;
    return;
  }
  if (hitBody(point)) {
    dragMode = "move";
    dragOrigin = { ...region };
    dragStart = point;
    return;
  }
  dragMode = "create";
  dragHandle = "";
  dragStart = point;
  dragOrigin = null;
  commitRegion(
    normalizeBox(point.x, point.y, point.x + MIN_SHAPE, point.y + MIN_SHAPE, shiftHeld),
  );
}

function onPointerMove(ev) {
  shiftHeld = Boolean(ev.shiftKey);
  const point = canvasPointFromEvent(ev);
  if (!dragMode) {
    const handle = hitHandle(point);
    if (handle) setCanvasCursor(cursorForHandle(handle));
    else if (hitBody(point)) setCanvasCursor("move");
    else setCanvasCursor("crosshair");
    return;
  }
  ev.preventDefault();
  if (dragMode === "create" && dragStart) {
    const moved =
      Math.abs(point.x - dragStart.x) > 3 || Math.abs(point.y - dragStart.y) > 3;
    if (moved) {
      commitRegion(normalizeBox(dragStart.x, dragStart.y, point.x, point.y, shiftHeld));
    }
    return;
  }
  if (dragMode === "move" && dragOrigin && dragStart) {
    commitRegion({
      ...dragOrigin,
      x: dragOrigin.x + (point.x - dragStart.x),
      y: dragOrigin.y + (point.y - dragStart.y),
    });
    return;
  }
  if (dragMode === "resize" && dragOrigin && dragHandle) {
    commitRegion(resizeFromHandle(dragHandle, point, dragOrigin, shiftHeld));
  }
}

function onPointerUp(ev) {
  if (!dragMode) return;
  const point = canvasPointFromEvent(ev);
  if (dragMode === "create" && dragStart) {
    const moved =
      Math.abs(point.x - dragStart.x) > 3 || Math.abs(point.y - dragStart.y) > 3;
    if (!moved) {
      const w = Number(els.shapeWidthRange?.value || 120);
      const h = Number(els.shapeHeightRange?.value || 80);
      commitRegion({
        type: currentTool,
        x: point.x - w / 2,
        y: point.y - h / 2,
        w,
        h,
      });
    }
  }
  dragMode = "";
  dragStart = null;
  dragHandle = "";
  dragOrigin = null;
  try {
    els.editCanvas.releasePointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }
}

function wireCanvasPainting() {
  if (!els.editCanvas) return;
  els.editCanvas.addEventListener("pointerdown", onPointerDown);
  els.editCanvas.addEventListener("pointermove", onPointerMove);
  els.editCanvas.addEventListener("pointerup", onPointerUp);
  els.editCanvas.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Shift") shiftHeld = true;
    if ((ev.key === "Delete" || ev.key === "Backspace") && region && !dragMode) {
      const tag = (ev.target && ev.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      ev.preventDefault();
      clearMask();
    }
  });
  window.addEventListener("keyup", (ev) => {
    if (ev.key === "Shift") shiftHeld = false;
  });
}

function setTool(tool) {
  currentTool = tool === "ellipse" ? "ellipse" : "rect";
  els.toolRect?.classList.toggle("is-active", currentTool === "rect");
  els.toolRect?.setAttribute("aria-pressed", currentTool === "rect" ? "true" : "false");
  els.toolEllipse?.classList.toggle("is-active", currentTool === "ellipse");
  els.toolEllipse?.setAttribute("aria-pressed", currentTool === "ellipse" ? "true" : "false");
  if (region && region.type !== currentTool) {
    commitRegion({ ...region, type: currentTool });
  }
}

function exportMaskBase64() {
  const outCanvas = document.createElement("canvas");
  outCanvas.width = naturalWidth;
  outCanvas.height = naturalHeight;
  const outCtx = outCanvas.getContext("2d");
  outCtx.imageSmoothingEnabled = false;
  outCtx.fillStyle = "#000000";
  outCtx.fillRect(0, 0, naturalWidth, naturalHeight);
  outCtx.drawImage(maskCanvas, 0, 0, naturalWidth, naturalHeight);
  const dataUrl = outCanvas.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  return comma !== -1 ? dataUrl.slice(comma + 1) : dataUrl;
}

let lastReadinessData = null;

function setComputeCapabilityBadge(data) {
  lastReadinessData = data;
  if (!els.compute) return;
  const gpu = Boolean(data?.pytorch?.gpu_detected);
  const cuda = Boolean(data?.binaries?.cuda_available);
  const installed = data?.pytorch?.installed_bundle;
  els.compute.classList.remove("is-pending", "is-cpu", "is-gpu", "is-warn");
  if (cuda) {
    els.compute.classList.add("is-gpu");
    els.compute.textContent = installed === "gpu"
      ? window.itzT("ui.gpuCuda", "GPU · CUDA")
      : window.itzT("ui.gpuCudaReady", "GPU · CUDA 준비됨");
    els.compute.title = data?.pytorch?.torch_version
      ? `torch ${data.pytorch.torch_version}`
      : "";
  } else if (gpu) {
    els.compute.classList.add("is-warn");
    els.compute.textContent = window.itzT("ui.gpuDetectNoCuda", "GPU 감지 · CUDA 미사용");
    els.compute.title = window.itzT("gpuCudaInstallHint", "환경 준비를 다시 실행하면 CUDA PyTorch를 설치합니다.");
  } else {
    els.compute.classList.add("is-cpu");
    els.compute.textContent = window.itzT("ui.cpu", "CPU");
    els.compute.title = window.itzT("cpuSlowHint", "NVIDIA GPU가 없으면 CPU로 처리됩니다. 영상은 매우 느릴 수 있습니다.");
  }
}

function updateBinReadiness(data) {
  const torch = Boolean(data?.binaries?.torch);
  const pip = Boolean(data?.binaries?.pip_stack);
  const model = Boolean(data?.binaries?.model_ready);
  toolReady = torch && pip && model;
  if (els.readiness) {
    if (toolReady) {
      els.readiness.textContent = window.itzT("readyOk", "Fixed Area Remover · 준비 완료");
    } else if (!torch) {
      els.readiness.textContent = window.itzT("needTorch", "Fixed Area Remover · PyTorch 설치 필요");
    } else if (!pip) {
      els.readiness.textContent = window.itzT("needPkg", "Fixed Area Remover · 패키지 설치 필요");
    } else {
      els.readiness.textContent = window.itzT("needModel", "Fixed Area Remover · 모델 다운로드 필요");
    }
  }
  if (els.summaryReady) {
    els.summaryReady.textContent = toolReady ? window.itzT("ui.readyOk", "준비됨") : window.itzT("ui.notReady", "미준비");
  }
}

async function checkReadiness() {
  const data = await requestAgent({ method: "GET", path: `${API}/readiness` });
  setComputeCapabilityBadge(data);
  updateBinReadiness(data);
  return data;
}

async function pollPrepareStatus() {
  for (;;) {
    const status = await requestAgent({ method: "GET", path: `${API}/prepare/status` });
    const pct = Number(status?.progress || 0);
    setBusy("setup", true, pct, status?.step || "", status?.message || "");
    if (status?.phase === "ready") return status;
    if (status?.phase === "failed") {
      throw new Error(status?.message || window.itzT("ui.prepFail", "환경 준비 실패"));
    }
    await new Promise((r) => setTimeout(r, 600));
  }
}

async function prepareModel({ force = false } = {}) {
  setAgentLongOperationActive(true);
  try {
    setBusy("setup", true, 5, window.itzT("installStart", "설치 시작"), window.itzT("prepPp", "ProPainter 환경을 준비합니다…"));
    await requestAgent({
      method: "POST",
      path: `${API}/prepare${force ? "?force=true" : ""}`,
    });
    await pollPrepareStatus();
    await checkReadiness();
  } finally {
    setBusy("setup", false);
    setAgentLongOperationActive(false);
  }
}

const PREPARE_IDLE_PHASES = new Set(["not_started", "idle", "ready", "failed"]);

async function resumeRunningPrepare() {
  let status;
  try {
    status = await requestAgent({ method: "GET", path: `${API}/prepare/status` });
  } catch {
    return;
  }
  if (PREPARE_IDLE_PHASES.has(String(status?.phase || "idle"))) return;

  setAgentLongOperationActive(true);
  try {
    setBusy("setup", true, Number(status?.progress || 0), status?.step || "", status?.message || "");
    await pollPrepareStatus();
    await checkReadiness();
  } catch (err) {
    alert(String(err?.message || err));
  } finally {
    setBusy("setup", false);
    setAgentLongOperationActive(false);
  }
}

function shortenAgentError(message, fallback = "고정 영역 제거 실패") {
  const text = String(message || "").replace(/\r/g, "").trim();
  if (!text) return fallback;
  const missing = text.match(/ModuleNotFoundError:\s*([^\n]+)/);
  if (missing) return `필요한 패키지가 없습니다: ${missing[1].replace(/^No module named\s+/i, "").replace(/['"]/g, "")}`;
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^ITZ_(PROGRESS|ERROR|RESULT)\s+\S*\s*/, "").trim())
    .filter((line) => line && !line.startsWith("File ") && !line.startsWith("Traceback"));
  const useful = lines.find((line) => /Error|실패|없음|RuntimeError/i.test(line));
  return (useful || lines[0] || fallback).slice(0, 280);
}

async function pollEraseStatus() {
  for (;;) {
    const status = await requestAgent({ method: "GET", path: `${API}/erase/status` });
    const pct = Number(status?.progress || 0);
    const step = status?.batch
      ? `폴더 일괄 ${status.batch_done || 0}/${status.batch_total || 0}`
      : status?.phase === "running"
        ? "처리 중"
        : "";
    setBusy("erase", true, pct, step, status?.message || "");
    if (status?.phase === "ready") return status;
    if (status?.phase === "failed") {
      throw new Error(shortenAgentError(status?.message, "고정 영역 제거 실패"));
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

async function cleanupWorkspace() {
  try {
    await requestAgent({ method: "POST", path: `${API}/workspace/cleanup` });
  } catch {
    /* ignore */
  }
}

async function loadVideoPathIntoEditor(path) {
  currentVideoPath = path;
  outputPath = "";
  resultPreviewPath = "";
  originalPreviewPath = "";
  batchOutputDir = "";
  setExportEnabled(false);
  setOpenOutputFolderEnabled(false);
  if (els.videoPath && !isFolderMode()) els.videoPath.value = path;
  const url = await resolveImageSrc(path);
  const img = await loadImageElement(url);
  await setupCanvasesForImage(img);
  showCanvasEditor();
  updateEraseButtonState();
}

async function adoptFolder(folderPath) {
  const data = await requestAgent({
    method: "POST",
    path: `${API}/scan-folder`,
    json: { folder_path: folderPath },
  });
  const videos = Array.isArray(data?.videos) ? data.videos.map((p) => String(p)) : [];
  const first = String(data?.first_video || videos[0] || "").trim();
  if (!first) {
    throw new Error("폴더에 지원하는 영상(.mp4/.mov/.mkv/.webm 등)이 없습니다.");
  }
  currentFolderPath = String(data?.folder_path || folderPath);
  folderVideoPaths = videos;
  batchOutputDir = "";
  if (els.videoPath) els.videoPath.value = currentFolderPath;
  await loadVideoPathIntoEditor(first);
  updateFolderMeta();
  updateEraseButtonState();
}

async function pickLocalVideo() {
  await primeLocalNetworkAccess();
  const data = await requestAgent({
    method: "POST",
    path: AGENT_PICK_VIDEO,
  });
  if (data?.cancelled) return;
  const path = String(data?.path || data?.video_path || "").trim();
  if (!path) throw new Error("영상을 선택하지 않았습니다.");
  currentFolderPath = "";
  folderVideoPaths = [];
  batchOutputDir = "";
  updateFolderMeta();
  await loadVideoPathIntoEditor(path);
}

async function pickLocalFolder() {
  await primeLocalNetworkAccess();
  const data = await requestAgent({
    method: "POST",
    path: AGENT_PICK_FOLDER,
  });
  if (data?.cancelled) return;
  const path = String(data?.path || "").trim();
  if (!path) throw new Error("폴더를 선택하지 않았습니다.");
  await adoptFolder(path);
}

async function pickByCurrentMode() {
  if (isFolderMode()) {
    await pickLocalFolder();
  } else {
    await pickLocalVideo();
  }
}

async function adoptTypedPath() {
  const path = els.videoPath?.value.trim() || "";
  if (isFolderMode()) {
    if (path === currentFolderPath) return;
    outputPath = "";
    batchOutputDir = "";
    setExportEnabled(false);
    setOpenOutputFolderEnabled(false);
    if (!path) {
      currentFolderPath = "";
      folderVideoPaths = [];
      currentVideoPath = "";
      updateFolderMeta();
      showEmptyState();
      updateEraseButtonState();
      return;
    }
    try {
      await adoptFolder(path);
    } catch {
      /* 입력 중인 불완전한 경로 */
    }
    return;
  }

  if (path === currentVideoPath) return;
  currentFolderPath = "";
  folderVideoPaths = [];
  currentVideoPath = path;
  outputPath = "";
  batchOutputDir = "";
  setExportEnabled(false);
  setOpenOutputFolderEnabled(false);
  updateFolderMeta();
  if (!path) {
    showEmptyState();
    updateEraseButtonState();
    return;
  }
  try {
    await loadVideoPathIntoEditor(path);
  } catch {
    /* 입력 중인 불완전한 경로 */
  }
}

function persistDownloadSession() {
  if (!outputPath) return;
  sessionStorage.setItem(SS.output, outputPath);
  sessionStorage.setItem(SS.original, currentVideoPath || "");
  const baseName =
    (currentVideoPath.split(/[\\/]/).pop() || "video").replace(/\.[^.]+$/, "") + "-clean";
  sessionStorage.setItem(SS.sourceName, baseName);
  sessionStorage.setItem(SS.editorPath, currentVideoPath || "");
  sessionStorage.setItem(SS.preview, resultPreviewPath || "");
  sessionStorage.setItem(SS.originalPreview, originalPreviewPath || "");
  sessionStorage.setItem(SS.sourceMode, isFolderMode() ? "folder" : "file");
  sessionStorage.setItem(SS.folderPath, currentFolderPath || "");
  sessionStorage.setItem(SS.batchOutputDir, batchOutputDir || "");
  sessionStorage.setItem(SS.batchCount, String(folderVideoPaths.length || 0));
}

async function openOutputFolder() {
  const target = batchOutputDir || outputPath;
  if (!target) return;
  await requestAgent({
    method: "POST",
    path: `${API}/show-in-folder`,
    json: { path: target },
  });
}

async function runErase() {
  if (isFolderMode()) {
    if (!currentFolderPath || !folderVideoPaths.length) {
      alert(window.itzT("needFolder", "폴더를 먼저 선택하세요."));
      return;
    }
  } else if (!currentVideoPath) {
    alert(window.itzT("needVideo", "영상을 먼저 선택하세요."));
    return;
  }
  if (!hasMaskPaint) {
    alert(window.itzT("needRegion", "고정 영역을 먼저 사각형 또는 원으로 지정하세요."));
    return;
  }
  if (!agentOk) {
    await showInstallAgentDialog(await agentInstallDialogOptions(() => checkAgentConnection()));
    return;
  }
  if (!toolReady) {
    await prepareModel();
    if (!toolReady) {
      alert(window.itzT("needPrep", "환경 준비가 완료되지 않았습니다."));
      return;
    }
  }

  const maskBase64 = exportMaskBase64();
  const device = els.device?.value === "auto" ? null : els.device?.value;

  setAgentLongOperationActive(true);
  try {
    if (isFolderMode()) {
      setBusy(
        "erase",
        true,
        2,
        window.itzT("batchLabel", "폴더 일괄"),
        window.ITZ_I18N?.tf?.("batchMsg", { n: folderVideoPaths.length }) || `${folderVideoPaths.length}개에 동일 마스크를 적용합니다…`,
      );
      await requestAgent({
        method: "POST",
        path: `${API}/erase-batch`,
        json: {
          folder_path: currentFolderPath,
          mask_base64: maskBase64,
          device,
          timeout_sec: 7200,
        },
      });
    } else {
      setBusy("erase", true, 3, window.itzT("startStep", "시작"), window.itzT("eraseStart", "고정 영역 제거를 시작합니다…"));
      await requestAgent({
        method: "POST",
        path: `${API}/erase`,
        json: {
          video_path: currentVideoPath,
          mask_base64: maskBase64,
          device,
          timeout_sec: 7200,
        },
      });
    }

    const status = await pollEraseStatus();
    outputPath = String(status?.output_path || "");
    if (!outputPath) throw new Error("결과 경로가 없습니다.");
    const reportedOriginal = String(status?.original_path || "").trim();
    if (reportedOriginal && reportedOriginal !== outputPath) {
      currentVideoPath = reportedOriginal;
    }
    resultPreviewPath = String(status?.preview_path || "");
    originalPreviewPath = String(status?.original_preview_path || "");
    batchOutputDir = String(status?.batch_output_dir || "").trim();
    persistDownloadSession();
    setExportEnabled(true);
    setOpenOutputFolderEnabled(Boolean(batchOutputDir));
    showResultVideos();
    if (isFolderMode() && status?.batch_failed) {
      alert(
        `일괄 지우기 완료: ${status.batch_done}/${status.batch_total}개 성공` +
          (status.batch_failed ? `, 실패 ${status.batch_failed}개` : "") +
          `\n결과 폴더: ${batchOutputDir || "(확인 필요)"}`,
      );
    }
  } finally {
    setBusy("erase", false);
    setAgentLongOperationActive(false);
  }
}

async function resetEditor() {
  revokePreviewUrls();
  await cleanupWorkspace();
  currentVideoPath = "";
  currentFolderPath = "";
  folderVideoPaths = [];
  batchOutputDir = "";
  outputPath = "";
  resultPreviewPath = "";
  originalPreviewPath = "";
  baseImage = null;
  naturalWidth = 0;
  naturalHeight = 0;
  workWidth = 0;
  workHeight = 0;
  hasMaskPaint = false;
  region = null;
  dragMode = "";
  if (els.videoPath) els.videoPath.value = "";
  setExportEnabled(false);
  setOpenOutputFolderEnabled(false);
  updateEraseButtonState();
  updateSummary();
  showEmptyState();
  sessionStorage.removeItem(SS.output);
  sessionStorage.removeItem(SS.original);
  sessionStorage.removeItem(SS.sourceName);
  sessionStorage.removeItem(SS.editorPath);
  sessionStorage.removeItem(SS.preview);
  sessionStorage.removeItem(SS.originalPreview);
  sessionStorage.removeItem(SS.sourceMode);
  sessionStorage.removeItem(SS.folderPath);
  sessionStorage.removeItem(SS.batchOutputDir);
  sessionStorage.removeItem(SS.batchCount);
}

async function restoreEditorAfterDownload() {
  if (sessionStorage.getItem(SS.returnFromDl) !== "1") return;
  sessionStorage.removeItem(SS.returnFromDl);
  const path = sessionStorage.getItem(SS.editorPath) || "";
  const savedOutput = sessionStorage.getItem(SS.output) || "";
  if (!path || !savedOutput) return;
  const mode = sessionStorage.getItem(SS.sourceMode) || "file";
  if (els.sourceMode) els.sourceMode.value = mode === "folder" ? "folder" : "file";
  updateSourceModeUi();
  currentVideoPath = path;
  outputPath = savedOutput;
  resultPreviewPath = sessionStorage.getItem(SS.preview) || "";
  originalPreviewPath = sessionStorage.getItem(SS.originalPreview) || "";
  currentFolderPath = sessionStorage.getItem(SS.folderPath) || "";
  batchOutputDir = sessionStorage.getItem(SS.batchOutputDir) || "";
  const count = Number(sessionStorage.getItem(SS.batchCount) || "0");
  folderVideoPaths = count > 0 ? Array.from({ length: count }, () => "") : [];
  if (els.videoPath) {
    els.videoPath.value = isFolderMode() && currentFolderPath ? currentFolderPath : path;
  }
  setExportEnabled(true);
  setOpenOutputFolderEnabled(Boolean(batchOutputDir));
  updateFolderMeta();
  showResultVideos();
}

function wireControls() {
  const onSlider = () => {
    if (els.shapeWidthValue) els.shapeWidthValue.textContent = `${els.shapeWidthRange.value}px`;
    if (els.shapeHeightValue) els.shapeHeightValue.textContent = `${els.shapeHeightRange.value}px`;
    applySliderSize();
    updateSummary();
  };
  els.shapeWidthRange?.addEventListener("input", onSlider);
  els.shapeHeightRange?.addEventListener("input", onSlider);
  els.device?.addEventListener("change", updateSummary);
  els.toolRect?.addEventListener("click", () => setTool("rect"));
  els.toolEllipse?.addEventListener("click", () => setTool("ellipse"));
  els.clearMask?.addEventListener("click", () => clearMask());
  els.sourceMode?.addEventListener("change", () => {
    updateSourceModeUi();
    void resetEditor().catch(() => {});
  });

  let pathDebounce = null;
  els.videoPath?.addEventListener("input", () => {
    clearTimeout(pathDebounce);
    pathDebounce = setTimeout(() => void adoptTypedPath(), 400);
  });
  els.pick?.addEventListener("click", () => {
    void pickByCurrentMode().catch((err) => alert(formatAgentConnectionError(err)));
  });
  els.prepare?.addEventListener("click", () => {
    void prepareModel({ force: false }).catch((err) => alert(String(err?.message || err)));
  });
  els.start?.addEventListener("click", () => {
    void runErase().catch((err) => alert(String(err?.message || err)));
  });
  els.newJob?.addEventListener("click", () => {
    void resetEditor().catch(() => {});
  });
  els.openOutputFolder?.addEventListener("click", () => {
    void openOutputFolder().catch((err) => alert(String(err?.message || err)));
  });
  els.exportLink?.addEventListener("click", (ev) => {
    if (!outputPath) {
      ev.preventDefault();
      return;
    }
    persistDownloadSession();
  });
}

function applyPendingHeaderI18n() {
  if (els.compute && els.compute.classList.contains("is-pending")) {
    els.compute.textContent = window.itzT("ui.checking", "확인 중…");
  }
  if (els.connection && /확인|Checking|確認|检查/.test(els.connection.textContent || "")) {
    els.connection.textContent = window.itzT("conn.checking", "에이전트 연결 확인 중…");
  }
  if (!lastReadinessData) {
    if (els.readiness) els.readiness.textContent = window.itzT("waitPrep", "Fixed Area Remover · 환경 준비 대기");
    if (els.summaryReady) els.summaryReady.textContent = window.itzT("ui.checkingShort", "확인 중");
  }
}

async function boot() {
  applyPendingHeaderI18n();
  wireCanvasPainting();
  wireControls();
  setTool("rect");
  updateSourceModeUi();
  updateSummary();
  updateEraseButtonState();
  setExportEnabled(false);
  void showAdSense("editorAboveWorkspace", "#editor-ad-above-path");
  void showAdSense("editorBelowExport", "#editor-ad-below-export");

  const detail = await checkAgentConnection();
  agentOk = Boolean(detail?.ok);
  applyConnectionStatusDot(els.connection, agentOk, detail);
  if (agentOk) {
    try {
      await checkReadiness();
      void resumeRunningPrepare();
    } catch (err) {
      if (els.readiness) {
        els.readiness.textContent = window.itzT("ui.readyCheckFail", "준비 상태 확인 실패") + " · " + formatAgentConnectionError(err);
      }
    }
  } else {
    await showInstallAgentDialog(await agentInstallDialogOptions(() => checkAgentConnection()));
  }

  startConnectionMonitor({
    intervalMs: 3000,
    immediate: false,
    autoShowInstallDialog: true,
    installDialogOptions: () => agentInstallDialogOptions(() => checkAgentConnection()),
    onChange: (ok, next) => {
      agentOk = ok;
      applyConnectionStatusDot(els.connection, ok, next);
      if (ok) void checkReadiness().catch(() => {});
    },
  });

  await restoreEditorAfterDownload();
}


document.addEventListener("itz:lang-change", () => {
  updateSourceModeUi();
  updateSummary();
  applyPendingHeaderI18n();
  if (els.videoStack && !els.videoStack.hidden) showResultVideos();
  else if (els.canvasStage && !els.canvasStage.hidden) showCanvasEditor();
  if (lastReadinessData) {
    setComputeCapabilityBadge(lastReadinessData);
    updateBinReadiness(lastReadinessData);
  }
});

void boot();
