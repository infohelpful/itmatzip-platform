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

const API = "/api/tools/background-remover";
const SS = {
  cutout: "background-remover:dl-cutout-path",
  mask: "background-remover:dl-mask-path",
  original: "background-remover:dl-original-path",
  sourceName: "background-remover:dl-source-name",
  editorPath: "background-remover:editor-image-path",
  returnFromDl: "background-remover:return-from-dl",
};

const els = {
  imagePath: document.getElementById("image-path"),
  pick: document.getElementById("btn-pick-local-file"),
  newJob: document.getElementById("btn-new-job"),
  start: document.getElementById("btn-start-remove"),
  exportLink: document.getElementById("export-link"),
  variant: document.getElementById("variant-select"),
  device: document.getElementById("device-select"),
  maxSize: document.getElementById("max-size-select"),
  feather: document.getElementById("feather-range"),
  featherValue: document.getElementById("feather-value"),
  threshold: document.getElementById("threshold-range"),
  thresholdValue: document.getElementById("threshold-value"),
  useHalf: document.getElementById("use-half"),
  shell: document.getElementById("enhancer-content-shell"),
  connection: document.getElementById("connection-status"),
  compute: document.getElementById("compute-capability"),
  readiness: document.getElementById("bin-readiness"),
  previewEmpty: document.getElementById("preview-empty"),
  previewSingle: document.getElementById("preview-single"),
  previewSource: document.getElementById("preview-source"),
  compare: document.getElementById("compare-slider"),
  compareOriginal: document.getElementById("compare-original"),
  compareResult: document.getElementById("compare-result"),
  compareDivider: document.getElementById("compare-divider"),
  compareHandle: document.getElementById("compare-handle"),
  compareHint: document.getElementById("compare-hint"),
  previewHeading: document.getElementById("preview-panel-heading"),
  summaryReady: document.getElementById("summary-model-ready"),
  summaryVariant: document.getElementById("summary-variant"),
  summaryDevice: document.getElementById("summary-device"),
  summaryOptions: document.getElementById("summary-options"),
  setupOverlay: document.getElementById("setup-loading"),
  setupStep: document.getElementById("setup-loading-step"),
  setupMessage: document.getElementById("setup-loading-message"),
  setupBar: document.getElementById("setup-loading-bar"),
  setupTrack: document.getElementById("setup-loading-track"),
  removeOverlay: document.getElementById("remove-loading"),
  removeStep: document.getElementById("remove-loading-step"),
  removeMessage: document.getElementById("remove-loading-message"),
  removePercent: document.getElementById("remove-loading-percent"),
  removeBar: document.getElementById("remove-loading-bar"),
  removeTrack: document.getElementById("remove-loading-track"),
};

let toolReady = false;
let agentOk = false;
let currentImagePath = "";
let cutoutPath = "";
let maskPath = "";
/** @type {string[]} */
const previewBlobs = [];

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

function variantLabel(value) {
  return value === "hr" ? "고해상도 (2048)" : "일반 (1024)";
}

function updateSummary() {
  if (els.summaryVariant) els.summaryVariant.textContent = variantLabel(els.variant?.value || "general");
  if (els.summaryDevice) {
    const device = els.device?.value || "auto";
    els.summaryDevice.textContent =
      device === "cuda" ? "CUDA" : device === "cpu" ? "CPU" : "자동";
  }
  if (els.summaryOptions) {
    const parts = [];
    if (els.useHalf?.checked) parts.push("fp16");
    const feather = Number(els.feather?.value || 0);
    if (feather > 0) parts.push(`블러 ${feather}`);
    const threshold = Number(els.threshold?.value || 0) / 100;
    if (threshold > 0) parts.push(`임계 ${threshold.toFixed(2)}`);
    const maxSize = Number(els.maxSize?.value || 0);
    if (maxSize > 0) parts.push(`${maxSize}px`);
    els.summaryOptions.textContent = parts.join(" · ") || "기본";
  }
}

function syncShellBusy() {
  const busy =
    Boolean(els.setupOverlay?.classList.contains("is-active")) ||
    Boolean(els.removeOverlay?.classList.contains("is-active"));
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
  const overlay = kind === "setup" ? els.setupOverlay : els.removeOverlay;
  const bar = kind === "setup" ? els.setupBar : els.removeBar;
  const track = kind === "setup" ? els.setupTrack : els.removeTrack;
  const stepEl = kind === "setup" ? els.setupStep : els.removeStep;
  const msgEl = kind === "setup" ? els.setupMessage : els.removeMessage;
  if (!overlay) return;
  const wasActive = overlay.classList.contains("is-active");
  overlay.hidden = !visible;
  // CSS 는 .is-active 없이는 display:none 이라 hidden 속성만 바꿔도 보이지 않는다.
  overlay.classList.toggle("is-active", visible);
  overlay.setAttribute("aria-hidden", visible ? "false" : "true");
  if (stepEl) stepEl.textContent = step || "";
  if (msgEl) msgEl.textContent = message || (visible ? "처리 중…" : "");
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  if (bar) bar.style.width = `${clamped}%`;
  if (track) track.setAttribute("aria-valuenow", String(Math.round(clamped)));
  if (kind === "remove" && els.removePercent) {
    els.removePercent.textContent = `${Math.round(clamped)}%`;
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

async function loadImageInto(imgEl, path, directUrl = "") {
  if (!imgEl || !path) return;
  const pageHost = window.location.hostname;
  const loopback =
    pageHost === "127.0.0.1" || pageHost === "localhost" || pageHost === "[::1]";
  if (loopback && directUrl) {
    imgEl.src = directUrl;
    return;
  }
  const url = await fetchImageBlobUrlFromAgentPath(path, directUrl);
  imgEl.src = url;
}

function showSourcePreview() {
  if (!els.previewEmpty || !els.previewSingle || !els.compare) return;
  els.previewEmpty.hidden = true;
  els.previewSingle.hidden = false;
  els.compare.hidden = true;
  if (els.compareHint) els.compareHint.hidden = true;
  if (els.previewHeading) els.previewHeading.textContent = "원본 미리보기";
}

function showComparePreview() {
  if (!els.previewEmpty || !els.previewSingle || !els.compare) return;
  els.previewEmpty.hidden = true;
  els.previewSingle.hidden = true;
  els.compare.hidden = false;
  if (els.compareHint) els.compareHint.hidden = false;
  if (els.previewHeading) els.previewHeading.textContent = "원본 ↔ 결과 비교";
  setCompareSplit(50);
}

function persistDownloadSession() {
  if (!cutoutPath) return;
  sessionStorage.setItem(SS.cutout, cutoutPath);
  sessionStorage.setItem(SS.mask, maskPath || "");
  sessionStorage.setItem(SS.original, currentImagePath || "");
  sessionStorage.setItem(
    SS.sourceName,
    (currentImagePath.split(/[\\/]/).pop() || "image").replace(/\.[^.]+$/, "") + "-nobg",
  );
  sessionStorage.setItem(SS.editorPath, currentImagePath || "");
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
      els.readiness.textContent = "Background Remover · 준비 완료";
    } else if (!torch) {
      els.readiness.textContent = "Background Remover · PyTorch 설치 필요";
    } else if (!pip) {
      els.readiness.textContent = "Background Remover · 패키지 설치 필요";
    } else {
      els.readiness.textContent = "Background Remover · 모델 다운로드 필요";
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
    setBusy("setup", true, 5, "설치 시작", "BiRefNet 환경을 준비합니다…");
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

/** 새로고침·재진입 시 이미 돌고 있는 준비 작업에 다시 붙어 진행률을 보여준다. */
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

function removePhaseLabel(phase) {
  if (phase === "running") return "처리 중";
  if (phase === "ready") return "완료";
  if (phase === "failed") return "실패";
  return "";
}

async function pollRemoveStatus() {
  for (;;) {
    const status = await requestAgent({ method: "GET", path: `${API}/remove/status` });
    const pct = Number(status?.progress || 0);
    setBusy("remove", true, pct, removePhaseLabel(status?.phase), status?.message || "");
    if (status?.phase === "ready") return status;
    if (status?.phase === "failed") {
      throw new Error(status?.message || "배경 제거 실패");
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
  cutoutPath = "";
  maskPath = "";
  setExportEnabled(false);
  if (els.imagePath) els.imagePath.value = path;
  showSourcePreview();
  await loadImageInto(els.previewSource, path, data?.preview_url || "");
}

/** 찾아보기 없이 경로를 직접 입력·붙여넣기 한 경우에도 대상 이미지로 인식한다. */
async function adoptTypedImagePath() {
  const path = els.imagePath?.value.trim() || "";
  if (path === currentImagePath) return;
  currentImagePath = path;
  cutoutPath = "";
  maskPath = "";
  setExportEnabled(false);
  if (!path) {
    if (els.previewEmpty) els.previewEmpty.hidden = false;
    if (els.previewSingle) els.previewSingle.hidden = true;
    if (els.compare) els.compare.hidden = true;
    return;
  }
  showSourcePreview();
  try {
    await loadImageInto(els.previewSource, path);
  } catch {
    /* 입력 중인 불완전한 경로 — 미리보기는 비워 둔다 */
  }
}

async function runRemove() {
  if (!currentImagePath) {
    alert("이미지를 먼저 선택하세요.");
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
    setBusy("remove", true, 3, "시작", "배경 제거를 시작합니다…");
    const body = {
      image_path: currentImagePath,
      variant: els.variant?.value || "general",
      feather: Number(els.feather?.value || 0),
      threshold: Number(els.threshold?.value || 0) / 100,
      max_size: Number(els.maxSize?.value || 0),
      use_half: Boolean(els.useHalf?.checked),
      device: els.device?.value === "auto" ? null : els.device?.value,
      timeout_sec: 1800,
    };
    await requestAgent({ method: "POST", path: `${API}/remove`, json: body });
    const status = await pollRemoveStatus();
    cutoutPath = String(status?.cutout_path || "");
    maskPath = String(status?.mask_path || "");
    if (!cutoutPath) throw new Error("결과 경로가 없습니다.");
    persistDownloadSession();
    setExportEnabled(true);
    showComparePreview();
    await loadImageInto(els.compareOriginal, currentImagePath);
    await loadImageInto(els.compareResult, cutoutPath);
  } finally {
    setBusy("remove", false);
    setAgentLongOperationActive(false);
  }
}

async function resetEditor() {
  revokePreviewUrls();
  await cleanupWorkspace();
  currentImagePath = "";
  cutoutPath = "";
  maskPath = "";
  if (els.imagePath) els.imagePath.value = "";
  setExportEnabled(false);
  if (els.previewEmpty) els.previewEmpty.hidden = false;
  if (els.previewSingle) els.previewSingle.hidden = true;
  if (els.compare) els.compare.hidden = true;
  if (els.compareHint) els.compareHint.hidden = true;
  if (els.previewHeading) els.previewHeading.textContent = "원본 미리보기";
  sessionStorage.removeItem(SS.cutout);
  sessionStorage.removeItem(SS.mask);
  sessionStorage.removeItem(SS.original);
  sessionStorage.removeItem(SS.sourceName);
  sessionStorage.removeItem(SS.editorPath);
}

async function restoreEditorAfterDownload() {
  if (sessionStorage.getItem(SS.returnFromDl) !== "1") return;
  sessionStorage.removeItem(SS.returnFromDl);
  const path = sessionStorage.getItem(SS.editorPath) || "";
  const savedCutout = sessionStorage.getItem(SS.cutout) || "";
  if (!path || !savedCutout) return;
  currentImagePath = path;
  cutoutPath = savedCutout;
  maskPath = sessionStorage.getItem(SS.mask) || "";
  if (els.imagePath) els.imagePath.value = path;
  setExportEnabled(true);
  showComparePreview();
  try {
    await loadImageInto(els.compareOriginal, path);
    await loadImageInto(els.compareResult, savedCutout);
  } catch {
    /* ignore */
  }
}

function wireControls() {
  els.feather?.addEventListener("input", () => {
    if (els.featherValue) els.featherValue.textContent = String(els.feather.value);
    updateSummary();
  });
  els.threshold?.addEventListener("input", () => {
    const value = Number(els.threshold.value || 0) / 100;
    if (els.thresholdValue) els.thresholdValue.textContent = value.toFixed(2);
    updateSummary();
  });
  for (const el of [els.variant, els.device, els.maxSize, els.useHalf]) {
    el?.addEventListener("change", updateSummary);
  }
  let pathDebounce = null;
  els.imagePath?.addEventListener("input", () => {
    clearTimeout(pathDebounce);
    pathDebounce = setTimeout(() => void adoptTypedImagePath(), 400);
  });
  els.pick?.addEventListener("click", () => {
    void pickLocalImage().catch((err) => alert(formatAgentConnectionError(err)));
  });
  els.start?.addEventListener("click", () => {
    void runRemove().catch((err) => alert(String(err?.message || err)));
  });
  els.newJob?.addEventListener("click", () => {
    void resetEditor().catch(() => {});
  });
  els.exportLink?.addEventListener("click", (ev) => {
    if (!cutoutPath) {
      ev.preventDefault();
      return;
    }
    persistDownloadSession();
  });
}

async function boot() {
  initCompareSlider();
  wireControls();
  updateSummary();
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
