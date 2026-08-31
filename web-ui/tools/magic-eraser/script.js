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
} from "../common/bridge.js?v=lna24";
import { AGENT_PICK_FOLDER, AGENT_PICK_IMAGE } from "../common/agent-pick-endpoints.js";
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

const API = "/api/tools/magic-eraser";
const MAX_EDIT_DIM = 1600;
const BRUSH_OVERLAY_COLOR = "rgba(239, 68, 68, 0.45)";

const SS = {
  output: "magic-eraser:dl-output-path",
  original: "magic-eraser:dl-original-path",
  sourceName: "magic-eraser:dl-source-name",
  editorPath: "magic-eraser:editor-image-path",
  returnFromDl: "magic-eraser:return-from-dl",
  sourceMode: "magic-eraser:source-mode",
  folderPath: "magic-eraser:folder-path",
  batchOutputDir: "magic-eraser:batch-output-dir",
  batchCount: "magic-eraser:batch-count",
};

const els = {
  imagePath: document.getElementById("image-path"),
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
  toolBrush: document.getElementById("tool-brush"),
  toolEraser: document.getElementById("tool-eraser"),
  brushSizeRange: document.getElementById("brush-size-range"),
  brushSizeValue: document.getElementById("brush-size-value"),
  clearMask: document.getElementById("btn-clear-mask"),
  canvasHint: document.getElementById("canvas-hint"),
  compare: document.getElementById("compare-slider"),
  compareOriginal: document.getElementById("compare-original"),
  compareResult: document.getElementById("compare-result"),
  compareDivider: document.getElementById("compare-divider"),
  compareHandle: document.getElementById("compare-handle"),
  compareHint: document.getElementById("compare-hint"),
  previewHeading: document.getElementById("preview-panel-heading"),
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
let currentImagePath = "";
let currentFolderPath = "";
/** @type {string[]} */
let folderImagePaths = [];
let batchOutputDir = "";
let outputPath = "";
let currentTool = "brush";
let brushSize = 24;
let hasMaskPaint = false;
let isPainting = false;
let lastPoint = null;
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
  if (els.imagePath) {
    els.imagePath.placeholder = folder ? window.itzT("ui.folderPh", "폴더 경로") : window.itzT("ui.pathPh", "파일 경로");
  }
  if (els.pathHint) {
    els.pathHint.textContent = folder
      ? window.itzT("pathHintFolder", "폴더를 선택하면 첫 이미지가 표시됩니다. 지울 영역을 칠한 뒤 「지우기 실행」하면 폴더 전체에 동일 마스크가 적용됩니다.")
      : window.itzT("pathHintFile", "이미지를 선택하면 편집 화면에 원본이 표시됩니다.");
  }
  if (els.canvasHint && !els.canvasHint.hidden) {
    els.canvasHint.textContent = folder
      ? window.itzT("canvasHintFolder", "첫 이미지에서 지울 영역을 칠하세요. 같은 위치의 워터마크가 폴더 안 모든 이미지에서 제거됩니다.")
      : window.itzT("canvasHint", "마우스나 펜으로 지울 영역을 빨갛게 칠한 뒤 「지우기 실행」을 누르세요. 「지우개」로 잘못 칠한 부분을 되돌릴 수 있습니다.");
  }
  updateFolderMeta();
}

function updateFolderMeta() {
  const folder = isFolderMode() && currentFolderPath;
  if (els.folderMeta) {
    if (folder && folderImagePaths.length) {
      els.folderMeta.hidden = false;
      els.folderMeta.textContent = window.ITZ_I18N?.tf?.("folderMeta", { n: folderImagePaths.length }) || `${folderImagePaths.length}장 · 대표 이미지로 마스크를 칠한 뒤 일괄 적용합니다.`;
    } else if (folder) {
      els.folderMeta.hidden = false;
      els.folderMeta.textContent = window.itzT("noImages", "폴더에 지원 이미지가 없습니다.");
    } else {
      els.folderMeta.hidden = true;
      els.folderMeta.textContent = "";
    }
  }
  if (els.summaryFolderRow) {
    els.summaryFolderRow.hidden = !folder;
  }
  if (els.summaryFolder) {
    els.summaryFolder.textContent = folder
      ? (window.ITZ_I18N?.tf?.("nSheets", { n: folderImagePaths.length }) || `${folderImagePaths.length}장`)
      : "—";
  }
}

function updateSummary() {
  if (els.summaryDevice) {
    const device = els.device?.value || "auto";
    els.summaryDevice.textContent =
      device === "cuda" ? "CUDA" : device === "cpu" ? "CPU" : window.itzT("ui.auto", "자동");
  }
  if (els.summaryBrush) els.summaryBrush.textContent = `${brushSize}px`;
  if (els.summaryMask) els.summaryMask.textContent = hasMaskPaint ? window.itzT("ui.maskPainted", "칠해짐") : window.itzT("maskEmpty", "비어 있음");
  updateFolderMeta();
}

function updateEraseButtonState() {
  if (!els.start) return;
  const hasSource = isFolderMode()
    ? Boolean(currentFolderPath && currentImagePath && folderImagePaths.length)
    : Boolean(currentImagePath);
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

function setCompareSplit(pct) {
  const value = Math.max(0, Math.min(100, pct));
  if (els.compare) els.compare.style.setProperty("--compare-split", `${value}%`);
  if (els.compareDivider) els.compareDivider.style.left = `${value}%`;
  if (els.compareHandle) els.compareHandle.setAttribute("aria-valuenow", String(Math.round(value)));
}

function initCompareSlider() {
  if (!els.compare || !els.compareHandle) return;
  let dragging = false;
  const updateFromClientX = (clientX) => {
    const rect = els.compare.getBoundingClientRect();
    if (!rect.width) return;
    setCompareSplit(((clientX - rect.left) / rect.width) * 100);
  };
  els.compareHandle.addEventListener("pointerdown", (ev) => {
    dragging = true;
    els.compareHandle.setPointerCapture(ev.pointerId);
    updateFromClientX(ev.clientX);
  });
  els.compareHandle.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    updateFromClientX(ev.clientX);
  });
  const stop = (ev) => {
    dragging = false;
    try {
      els.compareHandle.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
  };
  els.compareHandle.addEventListener("pointerup", stop);
  els.compareHandle.addEventListener("pointercancel", stop);
  els.compareHandle.addEventListener("keydown", (ev) => {
    const now = Number(els.compareHandle.getAttribute("aria-valuenow") || "50");
    if (ev.key === "ArrowLeft") setCompareSplit(now - 2);
    if (ev.key === "ArrowRight") setCompareSplit(now + 2);
    if (ev.key === "Home") setCompareSplit(0);
    if (ev.key === "End") setCompareSplit(100);
  });
  setCompareSplit(50);
}

async function fetchImageBlobUrlFromAgentPath(path, directUrl = "") {
  const origin = getAgentOrigin();
  const candidates = [];
  if (directUrl) candidates.push({ method: "GET", url: directUrl });
  candidates.push({
    method: "POST",
    url: `${origin}/api/agent/read-local-image`,
    body: { path },
  });
  candidates.push({
    method: "POST",
    url: `${origin}${API}/preview`,
    body: { image_path: path },
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
    img.onerror = () => reject(new Error("이미지를 불러올 수 없습니다."));
    img.src = src;
  });
}

async function loadImageInto(imgEl, path, directUrl = "") {
  if (!imgEl || !path) return;
  const url = await resolveImageSrc(path, directUrl);
  imgEl.src = url;
}

function showEmptyState() {
  if (els.previewEmpty) els.previewEmpty.hidden = false;
  if (els.canvasStage) els.canvasStage.hidden = true;
  if (els.compare) els.compare.hidden = true;
  if (els.brushToolbar) els.brushToolbar.hidden = true;
  if (els.canvasHint) els.canvasHint.hidden = true;
  if (els.compareHint) els.compareHint.hidden = true;
  if (els.previewHeading) {
    els.previewHeading.removeAttribute("data-preview-mode");
    els.previewHeading.textContent = window.itzT("ui.previewOriginal", "원본 미리보기");
  }
}

function showCanvasEditor() {
  if (els.previewEmpty) els.previewEmpty.hidden = true;
  if (els.canvasStage) els.canvasStage.hidden = false;
  if (els.compare) els.compare.hidden = true;
  if (els.brushToolbar) els.brushToolbar.hidden = false;
  if (els.canvasHint) {
    els.canvasHint.hidden = false;
    els.canvasHint.textContent = isFolderMode()
      ? window.itzT("canvasHintFolder", "첫 이미지에서 지울 영역을 칠하세요. 같은 위치의 워터마크가 폴더 안 모든 이미지에서 제거됩니다.")
      : window.itzT("canvasHint", "마우스나 펜으로 지울 영역을 빨갛게 칠한 뒤 「지우기 실행」을 누르세요. 「지우개」로 잘못 칠한 부분을 되돌릴 수 있습니다.");
  }
  if (els.compareHint) els.compareHint.hidden = true;
  if (els.previewHeading) {
    els.previewHeading.textContent = isFolderMode()
      ? window.itzT("headingFolderPaint", "폴더 대표 이미지 — 지울 영역을 칠하세요")
      : window.itzT("headingPaint", "브러시로 지울 영역을 칠하세요");
  }
}

function showComparePreview() {
  if (els.previewEmpty) els.previewEmpty.hidden = true;
  if (els.canvasStage) els.canvasStage.hidden = true;
  if (els.compare) els.compare.hidden = false;
  if (els.brushToolbar) els.brushToolbar.hidden = true;
  if (els.canvasHint) els.canvasHint.hidden = true;
  if (els.compareHint) {
    els.compareHint.hidden = false;
    els.compareHint.textContent = isFolderMode()
      ? window.itzT("compareFolderHint", "첫 이미지 비교입니다. 나머지 결과는 「결과 폴더 열기」로 확인하세요.")
      : window.itzT("ui.compareHint", "슬라이더를 왼쪽으로 당기면 원본, 오른쪽으로 당기면 결과가 보입니다.");
  }
  if (els.previewHeading) {
    els.previewHeading.textContent = isFolderMode()
      ? window.itzT("compareFolderTitle", "원본 ↔ 결과 비교 (대표 1장)")
      : window.itzT("ui.previewCompareSlider", "원본 ↔ 결과 비교");
  }
  setCompareSplit(50);
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

function composeDisplay() {
  if (!editCtx || !workWidth || !workHeight || !baseImage) return;
  editCtx.clearRect(0, 0, workWidth, workHeight);
  editCtx.drawImage(baseImage, 0, 0, workWidth, workHeight);
  editCtx.drawImage(overlayCanvas, 0, 0);
}

function maskHasAnyPaint() {
  if (!maskCtx || !workWidth || !workHeight) return false;
  try {
    const data = maskCtx.getImageData(0, 0, workWidth, workHeight).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) return true;
    }
  } catch {
    return hasMaskPaint;
  }
  return false;
}

function refreshMaskState() {
  hasMaskPaint = maskHasAnyPaint();
  updateSummary();
  updateEraseButtonState();
}

function clearMask() {
  if (!maskCtx || !workWidth || !workHeight) return;
  maskCtx.clearRect(0, 0, workWidth, workHeight);
  renderOverlay();
  composeDisplay();
  refreshMaskState();
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

  renderOverlay();
  composeDisplay();
  refreshMaskState();
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

function paintDot(x, y, radius, isEraser) {
  maskCtx.save();
  maskCtx.globalCompositeOperation = isEraser ? "destination-out" : "source-over";
  maskCtx.fillStyle = "#ffffff";
  maskCtx.beginPath();
  maskCtx.arc(x, y, radius, 0, Math.PI * 2);
  maskCtx.fill();
  maskCtx.restore();
}

function paintLine(from, to, diameter, isEraser) {
  maskCtx.save();
  maskCtx.globalCompositeOperation = isEraser ? "destination-out" : "source-over";
  maskCtx.strokeStyle = "#ffffff";
  maskCtx.lineWidth = diameter;
  maskCtx.lineCap = "round";
  maskCtx.lineJoin = "round";
  maskCtx.beginPath();
  maskCtx.moveTo(from.x, from.y);
  maskCtx.lineTo(to.x, to.y);
  maskCtx.stroke();
  maskCtx.restore();
}

function onPointerDown(ev) {
  if (!baseImage || !workWidth) return;
  ev.preventDefault();
  isPainting = true;
  try {
    els.editCanvas.setPointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }
  const point = canvasPointFromEvent(ev);
  const radius = (brushSize / 2) * point.scale;
  paintDot(point.x, point.y, radius, currentTool === "eraser");
  lastPoint = point;
  renderOverlay();
  composeDisplay();
}

function onPointerMove(ev) {
  if (!isPainting || !lastPoint) return;
  ev.preventDefault();
  const point = canvasPointFromEvent(ev);
  const diameter = brushSize * point.scale;
  paintLine(lastPoint, point, diameter, currentTool === "eraser");
  lastPoint = point;
  renderOverlay();
  composeDisplay();
}

function onPointerUp(ev) {
  if (!isPainting) return;
  isPainting = false;
  lastPoint = null;
  try {
    els.editCanvas.releasePointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }
  refreshMaskState();
}

function wireCanvasPainting() {
  if (!els.editCanvas) return;
  els.editCanvas.addEventListener("pointerdown", onPointerDown);
  els.editCanvas.addEventListener("pointermove", onPointerMove);
  els.editCanvas.addEventListener("pointerup", onPointerUp);
  els.editCanvas.addEventListener("pointercancel", onPointerUp);
  els.editCanvas.addEventListener("pointerleave", (ev) => {
    if (isPainting) onPointerUp(ev);
  });
}

function setTool(tool) {
  currentTool = tool === "eraser" ? "eraser" : "brush";
  els.toolBrush?.classList.toggle("is-active", currentTool === "brush");
  els.toolBrush?.setAttribute("aria-pressed", currentTool === "brush" ? "true" : "false");
  els.toolEraser?.classList.toggle("is-active", currentTool === "eraser");
  els.toolEraser?.setAttribute("aria-pressed", currentTool === "eraser" ? "true" : "false");
  els.editCanvas?.classList.toggle("is-eraser", currentTool === "eraser");
}

function exportMaskBase64() {
  const outCanvas = document.createElement("canvas");
  outCanvas.width = naturalWidth;
  outCanvas.height = naturalHeight;
  const outCtx = outCanvas.getContext("2d");
  outCtx.imageSmoothingEnabled = false;
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
    els.compute.title = window.itzT("ui.gpuCudaInstallHint", "환경 준비를 다시 실행하면 CUDA wheel을 설치합니다.");
  } else {
    els.compute.classList.add("is-cpu");
    els.compute.textContent = window.itzT("ui.cpu", "CPU");
    els.compute.title = window.itzT("ui.cpuNoNvidia", "NVIDIA GPU가 없으면 CPU로 처리됩니다.");
  }
}

function updateBinReadiness(data) {
  const torch = Boolean(data?.binaries?.torch);
  const pip = Boolean(data?.binaries?.pip_stack);
  const model = Boolean(data?.binaries?.model_ready);
  toolReady = torch && pip && model;
  if (els.readiness) {
    if (toolReady) {
      els.readiness.textContent = window.itzT("readyOk", "MagicEraser · 준비 완료");
    } else if (!torch) {
      els.readiness.textContent = window.itzT("needTorch", "MagicEraser · PyTorch 설치 필요");
    } else if (!pip) {
      els.readiness.textContent = window.itzT("needPkg", "MagicEraser · 패키지 설치 필요");
    } else {
      els.readiness.textContent = window.itzT("needModel", "MagicEraser · 모델 다운로드 필요");
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
    setBusy("setup", true, 5, window.itzT("installStart", "설치 시작"), window.itzT("prepLama", "LaMa 환경을 준비합니다…"));
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

function erasePhaseLabel(phase) {
  if (phase === "running") return window.itzT("ui.phaseRun", "처리 중");
  if (phase === "ready") return window.itzT("ui.phaseDone", "완료");
  if (phase === "failed") return window.itzT("ui.phaseFail", "실패");
  return "";
}

async function pollEraseStatus() {
  for (;;) {
    const status = await requestAgent({ method: "GET", path: `${API}/erase/status` });
    const pct = Number(status?.progress || 0);
    setBusy("erase", true, pct, erasePhaseLabel(status?.phase), status?.message || "");
    if (status?.phase === "ready") return status;
    if (status?.phase === "failed") {
      throw new Error(status?.message || window.itzT("eraseFail", "지우기 실패"));
    }
    await new Promise((r) => setTimeout(r, 450));
  }
}

async function cleanupWorkspace() {
  try {
    await requestAgent({ method: "POST", path: `${API}/workspace/cleanup` });
  } catch {
    /* ignore */
  }
}

async function loadImagePathIntoEditor(path, previewUrl = "") {
  currentImagePath = path;
  outputPath = "";
  batchOutputDir = "";
  setExportEnabled(false);
  setOpenOutputFolderEnabled(false);
  if (els.imagePath && !isFolderMode()) els.imagePath.value = path;
  const url = await resolveImageSrc(path, previewUrl);
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
  const images = Array.isArray(data?.images) ? data.images.map((p) => String(p)) : [];
  const first = String(data?.first_image || images[0] || "").trim();
  if (!first) {
    throw new Error("폴더에 지원하는 이미지(.jpg/.png/.webp 등)가 없습니다.");
  }
  currentFolderPath = String(data?.folder_path || folderPath);
  folderImagePaths = images;
  batchOutputDir = "";
  if (els.imagePath) els.imagePath.value = currentFolderPath;
  await loadImagePathIntoEditor(first);
  updateFolderMeta();
  updateEraseButtonState();
}

async function pickLocalImage() {
  await primeLocalNetworkAccess();
  const data = await requestAgent({
    method: "POST",
    path: AGENT_PICK_IMAGE,
  });
  if (data?.cancelled) return;
  const path = String(data?.path || "").trim();
  if (!path) throw new Error("이미지를 선택하지 않았습니다.");
  currentFolderPath = "";
  folderImagePaths = [];
  batchOutputDir = "";
  updateFolderMeta();
  await loadImagePathIntoEditor(path, data?.preview_url || "");
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
    await pickLocalImage();
  }
}

async function adoptTypedPath() {
  const path = els.imagePath?.value.trim() || "";
  if (isFolderMode()) {
    if (path === currentFolderPath) return;
    outputPath = "";
    batchOutputDir = "";
    setExportEnabled(false);
    setOpenOutputFolderEnabled(false);
    if (!path) {
      currentFolderPath = "";
      folderImagePaths = [];
      currentImagePath = "";
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

  if (path === currentImagePath) return;
  currentFolderPath = "";
  folderImagePaths = [];
  currentImagePath = path;
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
    const url = await resolveImageSrc(path);
    const img = await loadImageElement(url);
    await setupCanvasesForImage(img);
    showCanvasEditor();
    updateEraseButtonState();
  } catch {
    /* 입력 중인 불완전한 경로 — 미리보기는 비워 둔다 */
  }
}

function persistDownloadSession() {
  if (!outputPath) return;
  sessionStorage.setItem(SS.output, outputPath);
  sessionStorage.setItem(SS.original, currentImagePath || "");
  const baseName =
    (currentImagePath.split(/[\\/]/).pop() || "image").replace(/\.[^.]+$/, "") + "-erased";
  sessionStorage.setItem(SS.sourceName, baseName);
  sessionStorage.setItem(SS.editorPath, currentImagePath || "");
  sessionStorage.setItem(SS.sourceMode, isFolderMode() ? "folder" : "file");
  sessionStorage.setItem(SS.folderPath, currentFolderPath || "");
  sessionStorage.setItem(SS.batchOutputDir, batchOutputDir || "");
  sessionStorage.setItem(SS.batchCount, String(folderImagePaths.length || 0));
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
    if (!currentFolderPath || !folderImagePaths.length) {
      alert(window.itzT("needFolder", "폴더를 먼저 선택하세요."));
      return;
    }
  } else if (!currentImagePath) {
    alert(window.itzT("needImage", "이미지를 먼저 선택하세요."));
    return;
  }
  if (!hasMaskPaint) {
    alert(window.itzT("needMask", "지울 영역을 먼저 브러시로 칠하세요."));
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
        window.ITZ_I18N?.tf?.("batchMsg", { n: folderImagePaths.length }) || `${folderImagePaths.length}장에 동일 마스크를 적용합니다…`,
      );
      await requestAgent({
        method: "POST",
        path: `${API}/erase-batch`,
        json: {
          folder_path: currentFolderPath,
          mask_base64: maskBase64,
          device,
          timeout_sec: 1800,
        },
      });
    } else {
      setBusy("erase", true, 3, window.itzT("startStep", "시작"), window.itzT("eraseStart", "지우기를 시작합니다…"));
      await requestAgent({
        method: "POST",
        path: `${API}/erase`,
        json: {
          image_path: currentImagePath,
          mask_base64: maskBase64,
          device,
          timeout_sec: 1800,
        },
      });
    }

    const status = await pollEraseStatus();
    outputPath = String(status?.output_path || "");
    if (!outputPath) throw new Error("결과 경로가 없습니다.");
    if (status?.original_path) {
      currentImagePath = String(status.original_path);
    }
    batchOutputDir = String(status?.batch_output_dir || "").trim();
    persistDownloadSession();
    setExportEnabled(true);
    setOpenOutputFolderEnabled(Boolean(batchOutputDir));
    showComparePreview();
    await loadImageInto(els.compareOriginal, currentImagePath);
    await loadImageInto(els.compareResult, outputPath);
    if (isFolderMode() && status?.batch_failed) {
      alert(
        `일괄 지우기 완료: ${status.batch_done}/${status.batch_total}장 성공` +
          (status.batch_failed ? `, 실패 ${status.batch_failed}장` : "") +
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
  currentImagePath = "";
  currentFolderPath = "";
  folderImagePaths = [];
  batchOutputDir = "";
  outputPath = "";
  baseImage = null;
  naturalWidth = 0;
  naturalHeight = 0;
  workWidth = 0;
  workHeight = 0;
  hasMaskPaint = false;
  if (els.imagePath) els.imagePath.value = "";
  setExportEnabled(false);
  setOpenOutputFolderEnabled(false);
  updateEraseButtonState();
  updateSummary();
  showEmptyState();
  sessionStorage.removeItem(SS.output);
  sessionStorage.removeItem(SS.original);
  sessionStorage.removeItem(SS.sourceName);
  sessionStorage.removeItem(SS.editorPath);
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
  currentImagePath = path;
  outputPath = savedOutput;
  currentFolderPath = sessionStorage.getItem(SS.folderPath) || "";
  batchOutputDir = sessionStorage.getItem(SS.batchOutputDir) || "";
  const count = Number(sessionStorage.getItem(SS.batchCount) || "0");
  folderImagePaths = count > 0 ? Array.from({ length: count }, () => "") : [];
  if (els.imagePath) {
    els.imagePath.value = isFolderMode() && currentFolderPath ? currentFolderPath : path;
  }
  setExportEnabled(true);
  setOpenOutputFolderEnabled(Boolean(batchOutputDir));
  updateFolderMeta();
  showComparePreview();
  try {
    await loadImageInto(els.compareOriginal, path);
    await loadImageInto(els.compareResult, savedOutput);
  } catch {
    /* ignore */
  }
}

function wireControls() {
  els.brushSizeRange?.addEventListener("input", () => {
    brushSize = Number(els.brushSizeRange.value || 24);
    if (els.brushSizeValue) els.brushSizeValue.textContent = `${brushSize}px`;
    updateSummary();
  });
  els.device?.addEventListener("change", updateSummary);
  els.toolBrush?.addEventListener("click", () => setTool("brush"));
  els.toolEraser?.addEventListener("click", () => setTool("eraser"));
  els.clearMask?.addEventListener("click", () => clearMask());
  els.sourceMode?.addEventListener("change", () => {
    updateSourceModeUi();
    void resetEditor().catch(() => {});
  });

  let pathDebounce = null;
  els.imagePath?.addEventListener("input", () => {
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
    if (els.readiness) els.readiness.textContent = window.itzT("waitPrep", "MagicEraser · 환경 준비 대기");
    if (els.summaryReady) els.summaryReady.textContent = window.itzT("ui.checkingShort", "확인 중");
  }
}

async function boot() {
  initCompareSlider();
  wireCanvasPainting();
  wireControls();
  setTool("brush");
  applyPendingHeaderI18n();
  updateSourceModeUi();
  updateSummary();
  updateEraseButtonState();
  setExportEnabled(false);
  setOpenOutputFolderEnabled(false);
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
        els.readiness.textContent = (window.ITZ_I18N?.tf?.("ui.readyCheckFail", { msg: formatAgentConnectionError(err) }) || window.itzT("ui.readyCheckFail", "준비 상태 확인 실패")) + " · " + formatAgentConnectionError(err);
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
  if (els.compare && !els.compare.hidden) showComparePreview();
  else if (els.canvasStage && !els.canvasStage.hidden) showCanvasEditor();
  if (lastReadinessData) {
    setComputeCapabilityBadge(lastReadinessData);
    updateBinReadiness(lastReadinessData);
  }
});

void boot();
