import {
  applyConnectionStatusDot,
  checkAgentConnection,
  configureBridge,
  fetchAgent,
  formatAgentConnectionError,
  getAgentOrigin,
  primeLocalNetworkAccess,
  showInstallAgentDialog,
  setAgentLongOperationActive,
  startConnectionMonitor,
} from "../common/bridge.js?v=lna15";
import { AGENT_PICK_IMAGE } from "../common/agent-pick-endpoints.js";
import { showAdSense } from "../common/adsense.js";
import { agentInstallDialogOptions } from "../common/agent-install-ui.js?v=lna20";
import { AGENT_PORT } from "../common/agent-endpoints.js";

if (typeof window !== "undefined") {
  const h = window.location.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "127.0.0.1" || h === "localhost" || h === "::1") {
    configureBridge({ healthPath: "/health", origin: `${window.location.protocol}//${h}:${AGENT_PORT}` });
  } else {
    configureBridge({ healthPath: "/health" });
  }
}

const TOOL_API = "/api/tools/magic-canvas";
const AGENT_READ_LOCAL_IMAGE = "/api/agent/read-local-image";
const STORAGE_DL_RESULT = "magic-canvas:dl-result-path";
const STORAGE_DL_SOURCE = "magic-canvas:dl-source-name";

async function parseApiError(res) {
  try {
    const data = await res.json();
    return errorFromApiBody(data, res);
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
}

const MAX_CANVAS_SIDE = 16384;

function errorFromApiBody(data, res) {
  if (Array.isArray(data?.detail)) {
    const first = data.detail[0];
    if (first?.loc?.includes("target_width") || first?.loc?.includes("target_height")) {
      return `목표 크기는 한 변당 최대 ${MAX_CANVAS_SIDE}px입니다. (입력값이 너무 큽니다)`;
    }
    if (first?.msg) return String(first.msg);
  }
  if (data?.detail) {
    return typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
  }
  if (data?.message) return String(data.message);
  return res.statusText || `HTTP ${res.status}`;
}

const els = {
  connectionStatus: document.getElementById("connection-status"),
  binReadiness: document.getElementById("bin-readiness"),
  computeCapability: document.getElementById("compute-capability"),
  imagePath: document.getElementById("image-path"),
  fgPath: document.getElementById("fg-path"),
  btnPickImage: document.getElementById("btn-pick-image"),
  btnPickFg: document.getElementById("btn-pick-fg"),
  btnSubmit: document.getElementById("btn-submit"),
  btnClearMask: document.getElementById("btn-clear-mask"),
  canvas: document.getElementById("main-canvas"),
  canvasEmpty: document.getElementById("canvas-empty"),
  targetWidth: document.getElementById("target-width"),
  targetHeight: document.getElementById("target-height"),
  promptCompose: document.getElementById("prompt-compose"),
  brushSize: document.getElementById("brush-size"),
  prepareOverlay: document.getElementById("prepare-overlay"),
  prepareStep: document.getElementById("prepare-overlay-step"),
  prepareMsg: document.getElementById("prepare-overlay-msg"),
  prepareBar: document.getElementById("prepare-overlay-bar"),
  preparePercent: document.getElementById("prepare-overlay-percent"),
  btnOutpaintFit: document.getElementById("btn-outpaint-fit"),
  btnOutpaintWide: document.getElementById("btn-outpaint-wide"),
  btnOutpaintSquare: document.getElementById("btn-outpaint-square"),
  btnPrepare: document.getElementById("btn-prepare"),
  jobLoading: document.getElementById("job-loading"),
  jobBar: document.getElementById("job-loading-bar"),
  jobMessage: document.getElementById("job-loading-message"),
  jobPercent: document.getElementById("job-loading-percent"),
  resultCard: document.getElementById("result-card"),
  resultPreview: document.getElementById("result-preview"),
  exportLink: document.getElementById("export-link"),
  editorShell: document.getElementById("editor-shell"),
  modeTabs: document.querySelectorAll(".mode-tab"),
  panelOutpaint: document.getElementById("panel-outpaint"),
  panelRemove: document.getElementById("panel-remove"),
  panelCompose: document.getElementById("panel-compose"),
  panelComposePrompt: document.getElementById("panel-compose-prompt"),
  hfTokenCard: document.getElementById("hf-token-card"),
  hfTokenInput: document.getElementById("hf-token-input"),
  btnSaveHfToken: document.getElementById("btn-save-hf-token"),
};

const ctx = els.canvas.getContext("2d");
const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d");

let mode = "outpaint";
let allReady = false;
let connected = false;
let autoPrepareStarted = false;
let preparePollTimer = null;
let stagedBgPath = "";
let stagedFgPath = "";
let bgSource = null;
let fgImage = null;
function releaseBgSource() {
  if (bgSource?.bitmap?.close) {
    try {
      bgSource.bitmap.close();
    } catch {
      /* ignore */
    }
  }
  if (bgSource?.objectUrl) URL.revokeObjectURL(bgSource.objectUrl);
  bgSource = null;
}

function bgDims() {
  if (!bgSource) return null;
  return { w: bgSource.width, h: bgSource.height };
}

async function decodeImageBlob(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      return { bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      /* fallback */
    }
  }
  const objectUrl = URL.createObjectURL(blob);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = objectUrl;
  });
  return {
    bitmap: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    objectUrl,
  };
}

function drawCheckerboard(cx, x, y, w, h, cell = 14) {
  for (let py = 0; py < h; py += cell) {
    for (let px = 0; px < w; px += cell) {
      const parity = Math.floor(px / cell) + Math.floor(py / cell);
      cx.fillStyle = parity % 2 === 0 ? "#1a2233" : "#111820";
      cx.fillRect(x + px, y + py, Math.min(cell, w - px), Math.min(cell, h - py));
    }
  }
}

function clampOutpaintTarget(w, h) {
  let tw = Math.max(256, Math.round(Number(w) || 0));
  let th = Math.max(256, Math.round(Number(h) || 0));
  if (tw > MAX_CANVAS_SIDE || th > MAX_CANVAS_SIDE) {
    const s = Math.min(MAX_CANVAS_SIDE / tw, MAX_CANVAS_SIDE / th);
    tw = Math.max(256, Math.round(tw * s));
    th = Math.max(256, Math.round(th * s));
  }
  return { w: tw, h: th };
}

function setOutpaintTarget(w, h) {
  const c = clampOutpaintTarget(w, h);
  els.targetWidth.value = String(c.w);
  els.targetHeight.value = String(c.h);
  redrawCanvas();
  return c;
}

function applyOutpaintTargetFit() {
  const d = bgDims();
  if (!d) return;
  setOutpaintTarget(d.w, d.h);
}

function applyOutpaintTargetWide() {
  const d = bgDims();
  if (!d) return;
  const w = Math.max(d.w, Math.round((d.h * 16) / 9));
  setOutpaintTarget(w, d.h);
}

function applyOutpaintTargetSquare() {
  const d = bgDims();
  if (!d) return;
  const side = Math.max(d.w, d.h);
  setOutpaintTarget(side, side);
}
let composeTransform = { x: 80, y: 80, w: 200, h: 200 };
let dragging = false;
let dragKind = null;
let dragOffset = { x: 0, y: 0 };
let painting = false;
let pollTimer = null;

function installDialogOpts() {
  return agentInstallDialogOptions(() => checkAgentConnection());
}

function setHfTokenCardVisible(on) {
  if (!els.hfTokenCard) return;
  els.hfTokenCard.classList.toggle("hidden", !on);
}

function isHfAuthErrorMessage(message) {
  const text = String(message || "");
  return /hugging\s*face|401|unauthorized|hf_auth|gated/i.test(text);
}

function updateHfTokenUi(readiness) {
  // library-hub 모델 번들은 HF 토큰 불필요 — 준비 실패(인증 오류) 때만 카드 표시
  if (readiness?.hf_token_configured === true) {
    setHfTokenCardVisible(false);
  }
}

async function saveHfToken(token) {
  const res = await fetchAgent(`${getAgentOrigin()}${TOOL_API}/hf-token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorFromApiBody(data, res));
}

async function saveHfTokenAndRetry() {
  const token = els.hfTokenInput?.value?.trim() || "";
  if (!token) {
    alert("Hugging Face Access Token(hf_...)을 입력하세요.");
    return;
  }
  try {
    await saveHfToken(token);
    if (els.hfTokenInput) els.hfTokenInput.value = "";
    setHfTokenCardVisible(false);
    await ensureEnvironmentOnConnect();
  } catch (err) {
    alert(formatAgentConnectionError(err));
  }
}

if (els.btnSaveHfToken) {
  els.btnSaveHfToken.addEventListener("click", () => {
    saveHfTokenAndRetry().catch((err) => alert(formatAgentConnectionError(err)));
  });
}

function formatVramGb(vramMb) {
  const mb = Number(vramMb);
  if (!Number.isFinite(mb) || mb <= 0) return "";
  const gb = mb / 1024;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

function vramTierLabel(vramMb) {
  const mb = Number(vramMb);
  if (!Number.isFinite(mb) || mb <= 0) return "";
  if (mb <= 6500) return "Tier 1";
  if (mb <= 8500) return "Tier 2";
  return "Tier 3";
}

function setComputeCapabilityBadge({ agentOk, data } = {}) {
  const el = els.computeCapability;
  if (!el) return;
  el.classList.remove("is-gpu", "is-cpu", "is-pending", "is-warn");

  if (!agentOk) {
    el.classList.add("is-pending");
    el.textContent = "연산 장치 확인 불가";
    el.title = "에이전트에 연결되면 GPU 정보를 표시합니다.";
    return;
  }

  if (!data) {
    el.classList.add("is-pending");
    el.textContent = "연산 장치 확인 중…";
    el.title = "";
    return;
  }

  if (!data.gpu_detected) {
    el.classList.add("is-warn");
    el.textContent = "GPU 필요";
    el.title = "Magic Canvas는 NVIDIA GPU가 필요합니다.";
    return;
  }

  const vramGb = formatVramGb(data.vram_mb);
  const tier = vramTierLabel(data.vram_mb);
  const cuda = data.binaries?.cuda_available;

  el.classList.add("is-gpu");
  const parts = ["GPU"];
  if (tier) parts.push(tier);
  if (vramGb) parts.push(vramGb);
  el.textContent = parts.join(" · ");

  const titleLines = [
    "SDXL ControlNet 인페인트 — 로컬 GPU 전용",
    data.vram_mb ? `VRAM ${formatVramGb(data.vram_mb)} (${Math.round(Number(data.vram_mb))} MB)` : "",
    tier ? `${tier}: ${
      tier === "Tier 1"
        ? "6GB 이하 — 순차 CPU 오프로드"
        : tier === "Tier 2"
          ? "8GB급 — 모델 오프로드 + 슬라이싱"
          : "16GB급 — 모델 오프로드"
    }` : "",
    cuda === true ? "CUDA 사용 가능" : cuda === false ? "CUDA 미확인 (quick 점검)" : "",
  ].filter(Boolean);
  el.title = titleLines.join("\n");
}

function updateBinReadiness(agentOk, data) {
  if (!els.binReadiness) return;
  if (!agentOk) {
    els.binReadiness.className = "bin-readiness is-warn";
    els.binReadiness.textContent = "에이전트 미연결 → Magic Canvas 환경 점검 불가";
    return;
  }
  if (!data) {
    els.binReadiness.className = "bin-readiness is-warn";
    els.binReadiness.textContent = "Magic Canvas · 환경 확인 중…";
    return;
  }
  const d = data.dependencies || data.binaries || {};
  const labels = [
    ["venv", "venv"],
    ["pip_stack", "PyTorch"],
    ["models", "SDXL"],
  ];
  const parts = labels.map(([key, label]) => (d[key] ? label : `${label} ✗`));
  if (data.all_ready || data.ok) {
    els.binReadiness.className = "bin-readiness is-ok";
    els.binReadiness.textContent = "Magic Canvas · venv · PyTorch · SDXL 모델 준비됨";
    return;
  }
  els.binReadiness.className = "bin-readiness is-warn";
  els.binReadiness.textContent = `${parts.join(" · ")} · 환경 준비 필요`;
}

function applyReadinessData(data) {
  setComputeCapabilityBadge({ agentOk: true, data });
  updateHfTokenUi(data);
  updateBinReadiness(true, data);
  allReady = Boolean(data.all_ready ?? data.ok);
  updateSubmitEnabled();
  if (els.btnPrepare) {
    if (!allReady) {
      const parts = [];
      const d = data.dependencies || data.binaries || {};
      if (!d.venv) parts.push("venv");
      if (!d.pip_stack) parts.push("PyTorch");
      if (!d.models) parts.push("SDXL 모델");
      els.btnPrepare.textContent = parts.length ? `환경 준비 (${parts.join(", ")})` : "환경 준비";
      els.btnPrepare.disabled = false;
    } else {
      els.btnPrepare.textContent = "환경 재확인";
      els.btnPrepare.disabled = false;
    }
  }
}

async function checkReadiness({ full = false } = {}) {
  if (!connected) {
    setComputeCapabilityBadge({ agentOk: false });
    updateBinReadiness(false, null);
    return false;
  }
  try {
    const q = full ? "" : "?quick=1";
    const res = await fetchAgent(`${getAgentOrigin()}${TOOL_API}/readiness${q}`, { cache: "no-store" });
    if (!res.ok) {
      updateBinReadiness(true, null);
      return false;
    }
    const data = await res.json().catch(() => ({}));
    if (!data.gpu_detected) {
      setComputeCapabilityBadge({ agentOk: true, data });
      els.binReadiness.className = "bin-readiness is-err";
      els.binReadiness.textContent = "NVIDIA GPU가 필요합니다";
      allReady = false;
      updateSubmitEnabled();
      return false;
    }
    applyReadinessData(data);
    return Boolean(data.all_ready ?? data.ok);
  } catch {
    updateBinReadiness(connected, null);
    return false;
  }
}

function setPrepareProgress(progress, { indeterminate = false } = {}) {
  const pct = Math.max(0, Math.min(100, Number(progress) || 0));
  if (!els.prepareBar || !els.preparePercent) return;
  if (indeterminate) {
    els.prepareBar.classList.add("is-indeterminate");
    els.preparePercent.textContent = "…";
    return;
  }
  els.prepareBar.classList.remove("is-indeterminate");
  els.prepareBar.style.width = `${pct}%`;
  els.preparePercent.textContent = `${Math.round(pct)}%`;
}

function showPrepareOverlay() {
  setAgentLongOperationActive(true);
  if (!els.prepareOverlay) return;
  els.prepareOverlay.hidden = false;
  setPrepareProgress(0, { indeterminate: true });
  if (els.prepareStep) els.prepareStep.textContent = "";
  if (els.prepareMsg) {
    els.prepareMsg.textContent = "SDXL · PyTorch · ControlNet 모델을 설치합니다… (첫 실행 시 수 GB)";
  }
  els.prepareOverlay.scrollIntoView({ behavior: "smooth", block: "center" });
}

function hidePrepareOverlay() {
  if (els.prepareOverlay) els.prepareOverlay.hidden = true;
  setAgentLongOperationActive(false);
}

function stopPreparePolling() {
  if (preparePollTimer) {
    clearInterval(preparePollTimer);
    preparePollTimer = null;
  }
}

const PREPARE_PHASE_LABELS = {
  installing_dependencies: "패키지 설치 중",
  downloading_models: "모델 다운로드 중",
  done: "완료",
  error: "오류 발생",
};

function showPrepareDoneFlash(message) {
  showPrepareOverlay();
  setPrepareProgress(100);
  if (els.prepareStep) els.prepareStep.textContent = "설치 완료 ✓";
  if (els.prepareMsg) {
    els.prepareMsg.textContent = message || "환경 준비 완료! Magic Canvas를 사용할 수 있습니다.";
  }
  autoPrepareStarted = false;
  if (els.btnPrepare) {
    els.btnPrepare.disabled = false;
    els.btnPrepare.textContent = allReady ? "환경 재확인" : "환경 준비";
  }
  setTimeout(() => hidePrepareOverlay(), 1200);
}

function startPreparePolling({ showOverlayAfterMs = 0, pollMs = 2000 } = {}) {
  stopPreparePolling();
  const origin = getAgentOrigin();
  let overlayShown = showOverlayAfterMs <= 0;
  let overlayTimer = 0;

  if (!overlayShown && showOverlayAfterMs > 0) {
    overlayTimer = window.setTimeout(() => {
      if (!overlayShown) {
        overlayShown = true;
        showPrepareOverlay();
      }
    }, showOverlayAfterMs);
  } else {
    showPrepareOverlay();
  }

  preparePollTimer = setInterval(async () => {
    try {
      const res = await fetchAgent(`${origin}${TOOL_API}/prepare/status`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorFromApiBody(data, res));

      if (!overlayShown && data.phase === "downloading_models") {
        overlayShown = true;
        clearTimeout(overlayTimer);
        showPrepareOverlay();
      }

      setPrepareProgress(data.progress ?? 0);
      if (els.prepareMsg) {
        els.prepareMsg.textContent = data.message || "설치 진행 중…";
      }
      if (els.prepareStep) {
        els.prepareStep.textContent = PREPARE_PHASE_LABELS[data.phase] || data.phase || "";
      }

      if (data.phase === "done") {
        stopPreparePolling();
        clearTimeout(overlayTimer);
        setPrepareProgress(100);
        if (els.prepareMsg) {
          els.prepareMsg.textContent = data.message || "환경 준비 완료! Magic Canvas를 사용할 수 있습니다.";
        }
        if (els.prepareStep) els.prepareStep.textContent = "설치 완료 ✓";
        autoPrepareStarted = false;
        if (els.btnPrepare) els.btnPrepare.disabled = false;
        await checkReadiness({ full: false });
        setTimeout(() => hidePrepareOverlay(), allReady ? 400 : 1500);
      } else if (data.phase === "error") {
        stopPreparePolling();
        clearTimeout(overlayTimer);
        autoPrepareStarted = false;
        if (els.prepareStep) els.prepareStep.textContent = "오류 발생";
        if (els.prepareMsg) {
          els.prepareMsg.textContent = data.error || data.message || "알 수 없는 오류가 발생했습니다.";
        }
        if (isHfAuthErrorMessage(data.error || data.message)) setHfTokenCardVisible(true);
        setTimeout(() => {
          hidePrepareOverlay();
          if (els.btnPrepare) {
            els.btnPrepare.textContent = "환경 준비";
            els.btnPrepare.disabled = false;
          }
        }, 3000);
      }
    } catch {
      stopPreparePolling();
      clearTimeout(overlayTimer);
      autoPrepareStarted = false;
      hidePrepareOverlay();
      if (els.btnPrepare) {
        els.btnPrepare.textContent = "환경 준비";
        els.btnPrepare.disabled = false;
      }
    }
  }, pollMs);
}

async function postPrepare(force = false) {
  const url = `${getAgentOrigin()}${TOOL_API}/prepare${force ? "?force=true" : ""}`;
  const res = await fetchAgent(url, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(await parseApiError(res));
  return res.json().catch(() => ({}));
}

async function runManualPrepare() {
  const agent = await checkAgentConnection();
  if (!agent.ok) {
    showInstallAgentDialog(installDialogOpts());
    return;
  }
  if (!els.btnPrepare) return;

  els.btnPrepare.disabled = true;
  els.btnPrepare.textContent = "확인 중…";
  autoPrepareStarted = true;
  showPrepareOverlay();
  if (els.prepareStep) els.prepareStep.textContent = "환경 확인 중";
  if (els.prepareMsg) els.prepareMsg.textContent = "패키지 · SDXL 모델 · GPU 워커를 확인합니다…";
  setPrepareProgress(0, { indeterminate: true });

  try {
    const data = await postPrepare(true);
    if (data.phase === "done") {
      await checkReadiness({ full: true });
      showPrepareDoneFlash(data.message || "환경 재확인 완료");
      return;
    }
    if (data.phase === "error") {
      autoPrepareStarted = false;
      hidePrepareOverlay();
      const errText = data.error || data.message || "환경 준비 실패";
      if (isHfAuthErrorMessage(errText)) setHfTokenCardVisible(true);
      alert(errText);
      els.btnPrepare.textContent = allReady ? "환경 재확인" : "환경 준비";
      els.btnPrepare.disabled = false;
      return;
    }
    setPrepareProgress(data.progress ?? 4);
    if (els.prepareStep) {
      els.prepareStep.textContent = PREPARE_PHASE_LABELS[data.phase] || data.phase || "환경 확인 중";
    }
    if (els.prepareMsg && data.message) els.prepareMsg.textContent = data.message;
    startPreparePolling({ showOverlayAfterMs: 0, pollMs: 500 });
  } catch (err) {
    autoPrepareStarted = false;
    hidePrepareOverlay();
    els.btnPrepare.textContent = "환경 준비 실패";
    els.btnPrepare.disabled = false;
    alert(formatAgentConnectionError(err));
  }
}

async function runAutoPrepare() {
  if (!connected || allReady || autoPrepareStarted) return;
  autoPrepareStarted = true;
  try {
    const data = await postPrepare(false);
    if (data.phase === "done") {
      await checkReadiness({ full: false });
      autoPrepareStarted = false;
      return;
    }
    if (els.binReadiness) {
      els.binReadiness.className = "bin-readiness is-warn";
      els.binReadiness.textContent = "환경 준비 중… (처음 설치 시 수 분~수십 분)";
    }
    startPreparePolling({ showOverlayAfterMs: 2500 });
  } catch {
    autoPrepareStarted = false;
  }
}

async function ensureEnvironmentOnConnect() {
  const quickReady = await checkReadiness({ full: false });
  if (quickReady) return;
  await runAutoPrepare();
}

function setJobVisible(on) {
  els.jobLoading.classList.toggle("hidden", !on);
  els.jobLoading.setAttribute("aria-hidden", on ? "false" : "true");
  setAgentLongOperationActive(on);
  els.editorShell.classList.toggle("is-busy", on);
}

function updateSubmitEnabled() {
  const hasBg = Boolean(stagedBgPath);
  let ok = hasBg && allReady;
  if (mode === "compose") ok = ok && Boolean(stagedFgPath);
  els.btnSubmit.disabled = !ok;
}

function switchMode(next) {
  mode = next;
  els.modeTabs.forEach((t) => t.classList.toggle("is-active", t.dataset.mode === next));
  els.panelOutpaint.classList.toggle("hidden", next !== "outpaint");
  els.panelRemove.classList.toggle("hidden", next !== "remove");
  els.panelCompose.classList.toggle("hidden", next !== "compose");
  els.panelComposePrompt.classList.toggle("hidden", next !== "compose");
  els.canvas.style.cursor = next === "remove" ? "crosshair" : next === "compose" ? "move" : "default";
  redrawCanvas();
  updateSubmitEnabled();
}

els.modeTabs.forEach((tab) => {
  tab.addEventListener("click", () => switchMode(tab.dataset.mode));
});

function canvasSizeForBox(boxW, boxH) {
  const maxW = els.canvas.clientWidth || 800;
  const maxH = 500;
  const ratio = Math.min(maxW / boxW, maxH / boxH, 1);
  return { w: Math.round(boxW * ratio), h: Math.round(boxH * ratio), scale: ratio };
}

function canvasSizeForImage(img) {
  return canvasSizeForBox(img.naturalWidth || img.width, img.naturalHeight || img.height);
}

function syncMaskCanvasSize() {
  maskCanvas.width = els.canvas.width;
  maskCanvas.height = els.canvas.height;
}

function drawOutpaintGuide(canvasW, canvasH) {
  ctx.strokeStyle = "rgba(168, 85, 247, 0.9)";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(1, 1, canvasW - 2, canvasH - 2);
  ctx.setLineDash([]);
}

function drawOutpaintPreview() {
  const d = bgDims();
  if (!d) return;
  const tw = Number(els.targetWidth.value) || d.w;
  const th = Number(els.targetHeight.value) || d.h;
  const { w, h, scale } = canvasSizeForBox(tw, th);
  els.canvas.width = w;
  els.canvas.height = h;
  syncMaskCanvasSize();

  drawCheckerboard(ctx, 0, 0, w, h);

  const iw = d.w * scale;
  const ih = d.h * scale;
  const ix = (w - iw) / 2;
  const iy = (h - ih) / 2;
  ctx.drawImage(bgSource.bitmap, ix, iy, iw, ih);

  if (tw > d.w || th > d.h) {
    ctx.fillStyle = "rgba(168, 85, 247, 0.12)";
    if (ix > 0) ctx.fillRect(0, 0, ix, h);
    if (ix + iw < w) ctx.fillRect(ix + iw, 0, w - ix - iw, h);
    if (iy > 0) ctx.fillRect(ix, 0, iw, iy);
    if (iy + ih < h) ctx.fillRect(ix, iy + ih, iw, h - iy - ih);
  }

  drawOutpaintGuide(w, h);
}

function redrawCanvas() {
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  if (!bgSource) {
    els.canvasEmpty.classList.remove("hidden");
    return;
  }
  els.canvasEmpty.classList.add("hidden");

  if (mode === "outpaint") {
    drawOutpaintPreview();
    return;
  }

  const d = bgDims();
  const { w, h } = canvasSizeForBox(d.w, d.h);
  els.canvas.width = w;
  els.canvas.height = h;
  syncMaskCanvasSize();
  ctx.drawImage(bgSource.bitmap, 0, 0, w, h);

  if (mode === "remove") {
    ctx.globalAlpha = 0.45;
    ctx.drawImage(maskCanvas, 0, 0);
    ctx.globalAlpha = 1;
  }

  if (mode === "compose" && fgImage) {
    const { x, y, w: fw, h: fh } = composeTransform;
    ctx.drawImage(fgImage, x, y, fw, fh);
    ctx.strokeStyle = "#a855f7";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, fw, fh);
    const hs = 8;
    ctx.fillStyle = "#a855f7";
    ctx.fillRect(x + fw - hs, y + fh - hs, hs, hs);
  }
}

async function loadPreviewFromStaged(stagedPath, targetImgRef) {
  const url = `${getAgentOrigin()}${AGENT_READ_LOCAL_IMAGE}?path=${encodeURIComponent(stagedPath)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("미리보기 로드 실패");
  const blob = await res.blob();
  const decoded = await decodeImageBlob(blob);
  if (targetImgRef === "bg") {
    releaseBgSource();
    bgSource = decoded;
    els.targetWidth.value = String(decoded.width);
    els.targetHeight.value = String(decoded.height);
  } else {
    fgImage = decoded.bitmap;
    composeTransform.w = Math.min(200, decoded.width);
    composeTransform.h = Math.min(200, decoded.height);
  }
  redrawCanvas();
}

async function stageImage(localPath) {
  const res = await fetchAgent(`${getAgentOrigin()}${TOOL_API}/workspace/stage-image`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ image_path: localPath }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorFromApiBody(data, res));
  return data.staged_path;
}

async function pickAndStage(isFg = false) {
  const agent = await checkAgentConnection();
  if (!agent.ok) {
    showInstallAgentDialog(installDialogOpts());
    return;
  }
  const pickRes = await fetchAgent(`${getAgentOrigin()}${AGENT_PICK_IMAGE}`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  const pick = await pickRes.json().catch(() => ({}));
  if (!pickRes.ok) throw new Error(await parseApiError(pickRes));
  const localPath = pick.path || pick.file_path;
  if (!localPath) return;
  const staged = await stageImage(localPath);
  if (isFg) {
    stagedFgPath = staged;
    els.fgPath.value = staged;
    await loadPreviewFromStaged(staged, "fg");
  } else {
    stagedBgPath = staged;
    els.imagePath.value = staged;
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    await loadPreviewFromStaged(staged, "bg");
  }
  updateSubmitEnabled();
}

els.btnPickImage.addEventListener("click", () => pickAndStage(false));
els.btnPickFg.addEventListener("click", () => pickAndStage(true));
els.btnClearMask.addEventListener("click", () => {
  maskCtx.fillStyle = "#000";
  maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
  redrawCanvas();
});

function canvasPoint(evt) {
  const rect = els.canvas.getBoundingClientRect();
  const sx = els.canvas.width / rect.width;
  const sy = els.canvas.height / rect.height;
  return {
    x: (evt.clientX - rect.left) * sx,
    y: (evt.clientY - rect.top) * sy,
  };
}

els.canvas.addEventListener("pointerdown", (evt) => {
  if (!bgSource) return;
  const p = canvasPoint(evt);
  if (mode === "remove") {
    painting = true;
    maskCtx.fillStyle = "#fff";
    maskCtx.beginPath();
    maskCtx.arc(p.x, p.y, Number(els.brushSize.value) / 2, 0, Math.PI * 2);
    maskCtx.fill();
    redrawCanvas();
    return;
  }
  if (mode === "compose" && fgImage) {
    const { x, y, w, h } = composeTransform;
    const onHandle = p.x >= x + w - 12 && p.x <= x + w && p.y >= y + h - 12 && p.y <= y + h;
    dragging = true;
    dragKind = onHandle ? "resize" : "move";
    dragOffset = { x: p.x - x, y: p.y - y };
  }
});

els.canvas.addEventListener("pointermove", (evt) => {
  const p = canvasPoint(evt);
  if (mode === "remove" && painting) {
    maskCtx.fillStyle = "#fff";
    maskCtx.beginPath();
    maskCtx.arc(p.x, p.y, Number(els.brushSize.value) / 2, 0, Math.PI * 2);
    maskCtx.fill();
    redrawCanvas();
    return;
  }
  if (!dragging || mode !== "compose") return;
  if (dragKind === "move") {
    composeTransform.x = Math.max(0, Math.min(els.canvas.width - composeTransform.w, p.x - dragOffset.x));
    composeTransform.y = Math.max(0, Math.min(els.canvas.height - composeTransform.h, p.y - dragOffset.y));
  } else {
    composeTransform.w = Math.max(24, p.x - composeTransform.x);
    composeTransform.h = Math.max(24, p.y - composeTransform.y);
  }
  redrawCanvas();
});

window.addEventListener("pointerup", () => {
  painting = false;
  dragging = false;
  dragKind = null;
});

function maskToBase64Png() {
  return maskCanvas.toDataURL("image/png");
}

async function uploadMask() {
  const res = await fetchAgent(`${getAgentOrigin()}${TOOL_API}/workspace/upload-mask`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ mask_base64: maskToBase64Png() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorFromApiBody(data, res));
  return data.mask_path;
}

function buildSubmitPayload() {
  if (mode === "outpaint") {
    const c = clampOutpaintTarget(els.targetWidth.value, els.targetHeight.value);
    els.targetWidth.value = String(c.w);
    els.targetHeight.value = String(c.h);
    return {
      action: "outpaint",
      image_path: stagedBgPath,
      target_width: c.w,
      target_height: c.h,
    };
  }
  if (mode === "compose") {
    const d = bgDims();
    const sx = d ? d.w / els.canvas.width : 1;
    const sy = d ? d.h / els.canvas.height : 1;
    return {
      action: "compose",
      bg_image_path: stagedBgPath,
      fg_image_path: stagedFgPath,
      x: Math.round(composeTransform.x * sx),
      y: Math.round(composeTransform.y * sy),
      fg_width: Math.round(composeTransform.w * sx),
      fg_height: Math.round(composeTransform.h * sy),
      prompt: els.promptCompose.value.trim(),
    };
  }
  return { action: "remove", image_path: stagedBgPath };
}

async function pollJobStatus() {
  const res = await fetchAgent(`${getAgentOrigin()}${TOOL_API}/status`, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(errorFromApiBody(data, res));
  const pct = Number(data.progress) || 0;
  els.jobBar.style.width = `${pct}%`;
  els.jobPercent.textContent = `${Math.round(pct)}%`;
  els.jobMessage.textContent = data.message || data.error || "추론 진행 중…";

  if (data.status === "completed" && data.output_path) {
    clearInterval(pollTimer);
    pollTimer = null;
    setJobVisible(false);
    sessionStorage.setItem(STORAGE_DL_RESULT, data.output_path);
    sessionStorage.setItem(STORAGE_DL_SOURCE, "Magic Canvas");
    const previewUrl = `${getAgentOrigin()}${AGENT_READ_LOCAL_IMAGE}?path=${encodeURIComponent(data.output_path)}`;
    els.resultPreview.src = previewUrl;
    els.resultCard.classList.remove("hidden");
    return;
  }
  if (data.status === "failed") {
    clearInterval(pollTimer);
    pollTimer = null;
    setJobVisible(false);
    alert(data.error || "작업 실패");
  }
}

async function runSubmit() {
  if (!allReady) return;
  let payload = buildSubmitPayload();
  if (mode === "remove") {
    const maskPath = await uploadMask();
    payload = { ...payload, mask_path: maskPath };
  }
  setJobVisible(true);
  els.jobBar.style.width = "0%";
  const submitRes = await fetchAgent(`${getAgentOrigin()}${TOOL_API}/submit`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!submitRes.ok) throw new Error(await parseApiError(submitRes));
  pollTimer = setInterval(() => {
    pollJobStatus().catch((err) => {
      clearInterval(pollTimer);
      setJobVisible(false);
      alert(formatAgentConnectionError(err));
    });
  }, 500);
  await pollJobStatus();
}

els.btnSubmit.addEventListener("click", () => {
  runSubmit().catch((err) => {
    setJobVisible(false);
    alert(formatAgentConnectionError(err));
  });
});

async function boot() {
  void showAdSense("editorAboveWorkspace", "#editor-ad-above");
  await primeLocalNetworkAccess();
  startConnectionMonitor({
    onChange: (ok, detail) => {
      const busy = detail?.longOp;
      connected = ok || busy;
      applyConnectionStatusDot(els.connectionStatus, ok || busy, detail);
      if (!ok && !busy) setComputeCapabilityBadge({ agentOk: false });
      if (ok) void ensureEnvironmentOnConnect();
    },
  });
  const agent = await checkAgentConnection();
  connected = agent.ok;
  applyConnectionStatusDot(els.connectionStatus, agent.ok, agent);
  if (!agent.ok) setComputeCapabilityBadge({ agentOk: false });
  if (agent.ok) await ensureEnvironmentOnConnect();
  else showInstallAgentDialog(installDialogOpts());
}

boot().catch(console.error);

if (els.btnPrepare) {
  els.btnPrepare.addEventListener("click", () => {
    runManualPrepare().catch((err) => alert(formatAgentConnectionError(err)));
  });
}

if (els.btnOutpaintFit) els.btnOutpaintFit.addEventListener("click", applyOutpaintTargetFit);
if (els.btnOutpaintWide) els.btnOutpaintWide.addEventListener("click", applyOutpaintTargetWide);
if (els.btnOutpaintSquare) els.btnOutpaintSquare.addEventListener("click", applyOutpaintTargetSquare);

els.targetWidth.addEventListener("change", redrawCanvas);
els.targetHeight.addEventListener("change", redrawCanvas);
