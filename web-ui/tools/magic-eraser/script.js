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
} from "../common/bridge.js?v=lna21";
import { AGENT_PICK_IMAGE } from "../common/agent-pick-endpoints.js";
import { showAdSense } from "../common/adsense.js";
import { agentInstallDialogOptions } from "../common/agent-install-ui.js?v=lna21";
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
};

const els = {
  imagePath: document.getElementById("image-path"),
  pick: document.getElementById("btn-pick-local-file"),
  newJob: document.getElementById("btn-new-job"),
  prepare: document.getElementById("btn-prepare"),
  start: document.getElementById("btn-start-erase"),
  exportLink: document.getElementById("export-link"),
  device: document.getElementById("device-select"),
  shell: document.getElementById("enhancer-content-shell"),
  connection: document.getElementById("connection-status"),
  compute: document.getElementById("compute-capability"),
  readiness: document.getElementById("bin-readiness"),
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

function updateSummary() {
  if (els.summaryDevice) {
    const device = els.device?.value || "auto";
    els.summaryDevice.textContent =
      device === "cuda" ? "CUDA" : device === "cpu" ? "CPU" : "자동";
  }
  if (els.summaryBrush) els.summaryBrush.textContent = `${brushSize}px`;
  if (els.summaryMask) els.summaryMask.textContent = hasMaskPaint ? "칠해짐" : "비어 있음";
}

function updateEraseButtonState() {
  if (!els.start) return;
  els.start.disabled = !currentImagePath || !hasMaskPaint;
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
  if (stepEl) stepEl.textContent = step || "";
  if (msgEl) msgEl.textContent = message || (visible ? "처리 중…" : "");
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
  if (els.previewHeading) els.previewHeading.textContent = "원본 미리보기";
}

function showCanvasEditor() {
  if (els.previewEmpty) els.previewEmpty.hidden = true;
  if (els.canvasStage) els.canvasStage.hidden = false;
  if (els.compare) els.compare.hidden = true;
  if (els.brushToolbar) els.brushToolbar.hidden = false;
  if (els.canvasHint) els.canvasHint.hidden = false;
  if (els.compareHint) els.compareHint.hidden = true;
  if (els.previewHeading) els.previewHeading.textContent = "브러시로 지울 영역을 칠하세요";
}

function showComparePreview() {
  if (els.previewEmpty) els.previewEmpty.hidden = true;
  if (els.canvasStage) els.canvasStage.hidden = true;
  if (els.compare) els.compare.hidden = false;
  if (els.brushToolbar) els.brushToolbar.hidden = true;
  if (els.canvasHint) els.canvasHint.hidden = true;
  if (els.compareHint) els.compareHint.hidden = false;
  if (els.previewHeading) els.previewHeading.textContent = "원본 ↔ 결과 비교";
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

function setComputeCapabilityBadge(data) {
  if (!els.compute) return;
  const gpu = Boolean(data?.pytorch?.gpu_detected);
  const cuda = Boolean(data?.binaries?.cuda_available);
  const installed = data?.pytorch?.installed_bundle;
  els.compute.classList.remove("is-pending", "is-cpu", "is-gpu", "is-warn");
  if (cuda) {
    els.compute.classList.add("is-gpu");
    els.compute.textContent = `GPU · CUDA${installed === "gpu" ? "" : " 준비됨"}`;
    els.compute.title = data?.pytorch?.torch_version
      ? `torch ${data.pytorch.torch_version}`
      : "";
  } else if (gpu) {
    els.compute.classList.add("is-warn");
    els.compute.textContent = "GPU 감지 · CUDA 미사용";
    els.compute.title = "환경 준비를 다시 실행하면 CUDA wheel을 설치합니다.";
  } else {
    els.compute.classList.add("is-cpu");
    els.compute.textContent = "CPU";
    els.compute.title = "NVIDIA GPU가 없으면 CPU로 처리됩니다.";
  }
}

function updateBinReadiness(data) {
  const torch = Boolean(data?.binaries?.torch);
  const pip = Boolean(data?.binaries?.pip_stack);
  const model = Boolean(data?.binaries?.model_ready);
  toolReady = torch && pip && model;
  if (els.readiness) {
    if (toolReady) {
      els.readiness.textContent = "MagicEraser · 준비 완료";
    } else if (!torch) {
      els.readiness.textContent = "MagicEraser · PyTorch 설치 필요";
    } else if (!pip) {
      els.readiness.textContent = "MagicEraser · 패키지 설치 필요";
    } else {
      els.readiness.textContent = "MagicEraser · 모델 다운로드 필요";
    }
  }
  if (els.summaryReady) {
    els.summaryReady.textContent = toolReady ? "준비됨" : "미준비";
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
      throw new Error(status?.message || "환경 준비 실패");
    }
    await new Promise((r) => setTimeout(r, 600));
  }
}

async function prepareModel({ force = false } = {}) {
  setAgentLongOperationActive(true);
  try {
    setBusy("setup", true, 5, "설치 시작", "LaMa 환경을 준비합니다…");
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
  if (phase === "running") return "처리 중";
  if (phase === "ready") return "완료";
  if (phase === "failed") return "실패";
  return "";
}

async function pollEraseStatus() {
  for (;;) {
    const status = await requestAgent({ method: "GET", path: `${API}/erase/status` });
    const pct = Number(status?.progress || 0);
    setBusy("erase", true, pct, erasePhaseLabel(status?.phase), status?.message || "");
    if (status?.phase === "ready") return status;
    if (status?.phase === "failed") {
      throw new Error(status?.message || "지우기 실패");
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

async function pickLocalImage() {
  await primeLocalNetworkAccess();
  const data = await requestAgent({
    method: "POST",
    path: AGENT_PICK_IMAGE,
  });
  const path = String(data?.path || "").trim();
  if (!path) throw new Error("이미지를 선택하지 않았습니다.");
  currentImagePath = path;
  outputPath = "";
  setExportEnabled(false);
  if (els.imagePath) els.imagePath.value = path;
  const url = await resolveImageSrc(path, data?.preview_url || "");
  const img = await loadImageElement(url);
  await setupCanvasesForImage(img);
  showCanvasEditor();
}

async function adoptTypedImagePath() {
  const path = els.imagePath?.value.trim() || "";
  if (path === currentImagePath) return;
  currentImagePath = path;
  outputPath = "";
  setExportEnabled(false);
  if (!path) {
    showEmptyState();
    return;
  }
  try {
    const url = await resolveImageSrc(path);
    const img = await loadImageElement(url);
    await setupCanvasesForImage(img);
    showCanvasEditor();
  } catch {
    /* 입력 중인 불완전한 경로 — 미리보기는 비워 둔다 */
  }
}

function persistDownloadSession() {
  if (!outputPath) return;
  sessionStorage.setItem(SS.output, outputPath);
  sessionStorage.setItem(SS.original, currentImagePath || "");
  sessionStorage.setItem(
    SS.sourceName,
    (currentImagePath.split(/[\\/]/).pop() || "image").replace(/\.[^.]+$/, "") + "-erased",
  );
  sessionStorage.setItem(SS.editorPath, currentImagePath || "");
}

async function runErase() {
  if (!currentImagePath) {
    alert("이미지를 먼저 선택하세요.");
    return;
  }
  if (!hasMaskPaint) {
    alert("지울 영역을 먼저 브러시로 칠하세요.");
    return;
  }
  if (!agentOk) {
    await showInstallAgentDialog(await agentInstallDialogOptions(() => checkAgentConnection()));
    return;
  }
  if (!toolReady) {
    await prepareModel();
    if (!toolReady) {
      alert("환경 준비가 완료되지 않았습니다.");
      return;
    }
  }

  setAgentLongOperationActive(true);
  try {
    setBusy("erase", true, 3, "시작", "지우기를 시작합니다…");
    const body = {
      image_path: currentImagePath,
      mask_base64: exportMaskBase64(),
      device: els.device?.value === "auto" ? null : els.device?.value,
      timeout_sec: 1800,
    };
    await requestAgent({ method: "POST", path: `${API}/erase`, json: body });
    const status = await pollEraseStatus();
    outputPath = String(status?.output_path || "");
    if (!outputPath) throw new Error("결과 경로가 없습니다.");
    persistDownloadSession();
    setExportEnabled(true);
    showComparePreview();
    await loadImageInto(els.compareOriginal, currentImagePath);
    await loadImageInto(els.compareResult, outputPath);
  } finally {
    setBusy("erase", false);
    setAgentLongOperationActive(false);
  }
}

async function resetEditor() {
  revokePreviewUrls();
  await cleanupWorkspace();
  currentImagePath = "";
  outputPath = "";
  baseImage = null;
  naturalWidth = 0;
  naturalHeight = 0;
  workWidth = 0;
  workHeight = 0;
  hasMaskPaint = false;
  if (els.imagePath) els.imagePath.value = "";
  setExportEnabled(false);
  updateEraseButtonState();
  updateSummary();
  showEmptyState();
  sessionStorage.removeItem(SS.output);
  sessionStorage.removeItem(SS.original);
  sessionStorage.removeItem(SS.sourceName);
  sessionStorage.removeItem(SS.editorPath);
}

async function restoreEditorAfterDownload() {
  if (sessionStorage.getItem(SS.returnFromDl) !== "1") return;
  sessionStorage.removeItem(SS.returnFromDl);
  const path = sessionStorage.getItem(SS.editorPath) || "";
  const savedOutput = sessionStorage.getItem(SS.output) || "";
  if (!path || !savedOutput) return;
  currentImagePath = path;
  outputPath = savedOutput;
  if (els.imagePath) els.imagePath.value = path;
  setExportEnabled(true);
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

  let pathDebounce = null;
  els.imagePath?.addEventListener("input", () => {
    clearTimeout(pathDebounce);
    pathDebounce = setTimeout(() => void adoptTypedImagePath(), 400);
  });
  els.pick?.addEventListener("click", () => {
    void pickLocalImage().catch((err) => alert(formatAgentConnectionError(err)));
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
  els.exportLink?.addEventListener("click", (ev) => {
    if (!outputPath) {
      ev.preventDefault();
      return;
    }
    persistDownloadSession();
  });
}

async function boot() {
  initCompareSlider();
  wireCanvasPainting();
  wireControls();
  setTool("brush");
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
        els.readiness.textContent = `준비 상태 확인 실패 · ${formatAgentConnectionError(err)}`;
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

void boot();
