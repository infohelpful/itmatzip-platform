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
} from "../common/bridge.js?v=lna11";
import { showAdSense } from "../common/adsense.js";
import { agentInstallDialogOptions } from "../common/agent-install-ui.js";
import { AGENT_PORT } from "../common/agent-endpoints.js";

if (typeof window !== "undefined") {
  const h = window.location.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "127.0.0.1" || h === "localhost" || h === "::1") {
    configureBridge({
      healthPath: "/health",
      origin: `${window.location.protocol}//${h}:${AGENT_PORT}`,
    });
  } else {
    configureBridge({ healthPath: "/health" });
  }
} else {
  configureBridge({ healthPath: "/health" });
}

const TOOL_API = "/api/tools/image-enhancer";
const AGENT_READ_LOCAL_IMAGE = "/api/agent/read-local-image";
const DOWNLOAD_PAGE = "download.html";
const STORAGE_DL_RESULT_PATH = "image-enhancer:dl-result-path";
const STORAGE_DL_ORIGINAL_PATH = "image-enhancer:dl-original-path";
const STORAGE_DL_FORMAT = "image-enhancer:dl-output-format";
const STORAGE_DL_SOURCE = "image-enhancer:dl-source-name";
const STORAGE_EDITOR_IMAGE_PATH = "image-enhancer:editor-image-path";
const STORAGE_RETURN_FROM_DL = "image-enhancer:return-from-dl";
const EXPORT_LINK_DEFAULT_HTML =
  '<span class="icon" aria-hidden="true">📥</span> 결과 다운로드';
const originWarning = document.getElementById("origin-warning");
const imagePathInput = document.getElementById("image-path");
const btnPickLocalFile = document.getElementById("btn-pick-local-file");
const btnNewJob = document.getElementById("btn-new-job");
const btnStartEnhance = document.getElementById("btn-start-enhance");
const exportLink = document.getElementById("export-link");
const fidelityRange = document.getElementById("fidelity-range");
const fidelityValue = document.getElementById("fidelity-value");
const outputFormatSelect = document.getElementById("output-format");
const deviceSelect = document.getElementById("device-select");
const faceUpsample = document.getElementById("face-upsample");
const onlyCenterFace = document.getElementById("only-center-face");
const backgroundEnhance = document.getElementById("background-enhance");
const backgroundQualityMode = document.getElementById("background-quality-mode");
const backgroundQualityCard = document.getElementById("background-quality-card");
const upscaleSelect = document.getElementById("upscale-select");
const upscaleHint = document.getElementById("upscale-hint");
const summaryModelReady = document.getElementById("summary-model-ready");
const summaryFormat = document.getElementById("summary-format");
const summaryUpscale = document.getElementById("summary-upscale");
const summaryFidelity = document.getElementById("summary-fidelity");
const summaryOptions = document.getElementById("summary-options");
const binReadiness = document.getElementById("bin-readiness");
const computeCapability = document.getElementById("compute-capability");
const previewEmpty = document.getElementById("preview-empty");
const previewSingle = document.getElementById("preview-single");
const previewSource = document.getElementById("preview-source");
const compareSlider = document.getElementById("compare-slider");
const compareOriginal = document.getElementById("compare-original");
const compareResult = document.getElementById("compare-result");
const compareDivider = document.getElementById("compare-divider");
const compareHandle = document.getElementById("compare-handle");
const compareHint = document.getElementById("compare-hint");
const previewViewport = document.getElementById("preview-viewport");
const setupLoading = document.getElementById("setup-loading");
const setupLoadingTitle = document.getElementById("setup-loading-title");
const setupLoadingStep = document.getElementById("setup-loading-step");
const setupLoadingMessage = document.getElementById("setup-loading-message");
const setupLoadingTrack = document.getElementById("setup-loading-track");
const setupLoadingBar = document.getElementById("setup-loading-bar");
const enhanceLoading = document.getElementById("enhance-loading");
const enhanceLoadingTitle = document.getElementById("enhance-loading-title");
const enhanceLoadingStep = document.getElementById("enhance-loading-step");
const enhanceLoadingMessage = document.getElementById("enhance-loading-message");
const enhanceLoadingPercent = document.getElementById("enhance-loading-percent");
const enhanceLoadingTrack = document.getElementById("enhance-loading-track");
const enhanceLoadingBar = document.getElementById("enhance-loading-bar");
const pathHint = document.getElementById("path-hint");
const enhancerContentShell = document.getElementById("enhancer-content-shell");

let toolReady = false;
let enhanceBusy = false;
let downloadReady = false;
let lastResultUrl = null;
let lastOriginalBlobUrl = "";
let lastResultBlobUrl = "";
/** loopback 직접 URL 미리보기(blob 아님) */
let lastOriginalDirectUrl = "";
let previewLoadToken = 0;
let lastDisplayedProgress = 0;
let compareSplitPct = 50;
let compareDragActive = false;
let suppressPathPreview = 0;

function installDialogOpts() {
  return agentInstallDialogOptions(() => checkAgentConnection());
}

/** 에이전트 API(POST 본문) — Windows 원본 경로 유지 */
function pathForAgentApi(filePath) {
  return String(filePath || "").trim();
}

/** URL 쿼리용 */
function normalizeFilePath(filePath) {
  return pathForAgentApi(filePath).replace(/\\/g, "/");
}

function isAgentLoopbackPage() {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

function buildLocalPreviewImageUrl(filePath) {
  const native = pathForAgentApi(filePath);
  if (!native) return "";
  return `${getAgentOrigin()}${AGENT_READ_LOCAL_IMAGE}?path=${encodeURIComponent(native)}&_=${Date.now()}`;
}

function warnIfRemoteToolsPage() {
  if (!originWarning || isAgentLoopbackPage()) return;
  originWarning.hidden = false;
  originWarning.textContent =
    "지금 주소는 원격 웹 UI입니다. 미리보기가 안 되면 트레이 아이콘 → Image Enhancer로 열거나 주소가 http://127.0.0.1:19876/tools/image-enhancer/ 인지 확인하세요.";
}

function scrollPreviewIntoView() {
  previewPanel?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

const previewPanel = document.querySelector(".preview-panel");
const previewPanelHeading = document.getElementById("preview-panel-heading");

function setPreviewPanelHeading(compareMode) {
  if (!previewPanelHeading) return;
  previewPanelHeading.textContent = compareMode ? "결과 비교" : "원본 미리보기";
}

function revealPreviewSingle() {
  if (!(previewSource?.naturalWidth > 0)) return;
  if (previewEmpty) previewEmpty.hidden = true;
  if (previewSingle) previewSingle.hidden = false;
  if (compareSlider) compareSlider.hidden = true;
  if (compareHint) compareHint.hidden = true;
  previewEmpty?.classList.remove("is-error");
  previewSource?.classList.remove("is-pending");
  scrollPreviewIntoView();
}

function revealCompareMode() {
  if (previewEmpty) previewEmpty.hidden = true;
  if (previewSingle) previewSingle.hidden = true;
  if (compareSlider) compareSlider.hidden = false;
  if (compareHint) compareHint.hidden = false;
  compareOriginal?.classList.remove("is-pending");
  compareResult?.classList.remove("is-pending");
  setPreviewPanelHeading(true);
  scrollPreviewIntoView();
}

async function assignPreviewFromPathWithFallback(imgEl, filePath, options = {}) {
  try {
    await assignPreviewFromPath(imgEl, filePath, options);
  } catch (firstErr) {
    if (options.useDownload) throw firstErr;
    await assignPreviewFromPath(imgEl, filePath, { ...options, useDownload: true });
  }
}

async function waitPreviewImageReady(imgEl) {
  if (!imgEl) throw new Error("미리보기 영역을 찾을 수 없습니다.");
  if (imgEl.complete && imgEl.naturalWidth > 0) return;
  try {
    if (typeof imgEl.decode === "function") {
      await imgEl.decode();
      if (imgEl.naturalWidth > 0) return;
    }
  } catch {
    /* decode 실패해도 load 이벤트로 재시도 */
  }
  await waitImageReady(imgEl);
  if (!(imgEl.naturalWidth > 0)) {
    throw new Error("이미지를 표시할 수 없습니다.");
  }
}

function buildDownloadUrl(filePath) {
  const normalized = normalizeFilePath(filePath);
  return `${getAgentOrigin()}${TOOL_API}/download?file_path=${encodeURIComponent(normalized)}`;
}

function basenameFromPath(filePath) {
  const s = String(filePath || "").replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function clearDownloadSession() {
  sessionStorage.removeItem(STORAGE_DL_RESULT_PATH);
  sessionStorage.removeItem(STORAGE_DL_ORIGINAL_PATH);
  sessionStorage.removeItem(STORAGE_DL_FORMAT);
  sessionStorage.removeItem(STORAGE_DL_SOURCE);
  sessionStorage.removeItem(STORAGE_EDITOR_IMAGE_PATH);
  sessionStorage.removeItem(STORAGE_RETURN_FROM_DL);
}

function persistDownloadSession({ resultPath, originalPath, imagePath, outputFormat }) {
  if (resultPath) sessionStorage.setItem(STORAGE_DL_RESULT_PATH, resultPath);
  if (originalPath) sessionStorage.setItem(STORAGE_DL_ORIGINAL_PATH, originalPath);
  if (imagePath) sessionStorage.setItem(STORAGE_EDITOR_IMAGE_PATH, imagePath);
  const fmt = String(outputFormat || "png").toLowerCase();
  sessionStorage.setItem(STORAGE_DL_FORMAT, fmt);
  const label = basenameFromPath(imagePath) || basenameFromPath(resultPath);
  if (label) sessionStorage.setItem(STORAGE_DL_SOURCE, label);
}

function canDownloadFromSession() {
  return Boolean(sessionStorage.getItem(STORAGE_DL_RESULT_PATH));
}

function isExportEnabled() {
  return downloadReady && !enhanceBusy && (canDownloadFromSession() || !!lastResultUrl);
}

function resetExportLinkUi() {
  if (!exportLink) return;
  exportLink.classList.remove("is-busy");
  exportLink.removeAttribute("aria-busy");
  exportLink.innerHTML = EXPORT_LINK_DEFAULT_HTML;
  const enabled = isExportEnabled();
  exportLink.classList.toggle("is-disabled", !enabled);
  if (enabled) {
    exportLink.href = DOWNLOAD_PAGE;
    exportLink.removeAttribute("aria-disabled");
  } else {
    exportLink.href = DOWNLOAD_PAGE;
    exportLink.setAttribute("aria-disabled", "true");
  }
}

async function navigateToDownloadPage(exportLinkEl) {
  if (!isExportEnabled() || !canDownloadFromSession()) {
    alert("먼저 화질 향상을 완료해 주세요.");
    return;
  }

  if (exportLinkEl instanceof HTMLElement) {
    exportLinkEl.classList.add("is-busy");
    exportLinkEl.setAttribute("aria-busy", "true");
    exportLinkEl.innerHTML = '<span class="icon" aria-hidden="true">⏳</span> 이동 중…';
  }

  let navigating = false;
  try {
    const agent = await checkAgentConnection();
    if (!agent.ok) {
      await showInstallAgentDialog(await installDialogOpts());
      return;
    }
    navigating = true;
    window.location.assign(new URL(DOWNLOAD_PAGE, window.location.href).href);
  } finally {
    if (!navigating) resetExportLinkUi();
  }
}

function buildPreviewUrl(filePath) {
  const normalized = normalizeFilePath(filePath);
  return `${getAgentOrigin()}${TOOL_API}/media/image?image_path=${encodeURIComponent(normalized)}`;
}

async function parseApiError(res) {
  try {
    const data = await res.json();
    if (data?.detail) {
      return typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
    }
  } catch {
    /* ignore */
  }
  return res.statusText || `HTTP ${res.status}`;
}

function hasImagePath() {
  return !!(imagePathInput?.value.trim());
}

function getFidelity() {
  const v = Number(fidelityRange?.value || 70);
  return Math.max(0, Math.min(1, v / 100));
}

function resolveDeviceParam() {
  const v = deviceSelect?.value || "auto";
  if (v === "cpu" || v === "cuda") return v;
  return null;
}

function resolveUpscale() {
  const raw = Number(upscaleSelect?.value || 2);
  const upscale = Math.max(1, Math.min(4, Number.isFinite(raw) ? raw : 2));
  if (backgroundEnhance?.checked && upscale < 2) return 2;
  return upscale;
}

function resolveBgTile() {
  if (!backgroundEnhance?.checked) return 400;
  return backgroundQualityMode?.checked ? 256 : 400;
}

function syncBackgroundEnhanceUi() {
  const bgOn = !!backgroundEnhance?.checked;
  if (backgroundQualityMode) {
    backgroundQualityMode.disabled = !bgOn;
    if (!bgOn) backgroundQualityMode.checked = false;
  }
  if (backgroundQualityCard) {
    backgroundQualityCard.classList.toggle("is-disabled", !bgOn);
    if (bgOn) backgroundQualityCard.removeAttribute("aria-disabled");
    else backgroundQualityCard.setAttribute("aria-disabled", "true");
  }
  if (upscaleHint) {
    upscaleHint.textContent = bgOn
      ? "배경 RealESRGAN은 2배·4배에서 효과가 큽니다. 4배는 가장 선명하지만 시간이 더 걸립니다."
      : "배경 복원을 켜면 2배 이상을 권장합니다.";
  }
  if (bgOn && upscaleSelect && upscaleSelect.value === "1") {
    upscaleSelect.value = "2";
  }
  syncSummaryFromDom();
}

function getActiveOptionLabels() {
  const labels = [];
  if (faceUpsample?.checked) labels.push("얼굴 업스케일");
  if (onlyCenterFace?.checked) labels.push("가운데 얼굴만");
  if (backgroundEnhance?.checked) {
    labels.push("배경 복원");
    if (backgroundQualityMode?.checked) labels.push("배경 고품질");
  }
  return labels;
}

function setModelReadySummary(ready) {
  if (!summaryModelReady) return;
  summaryModelReady.textContent = ready ? "완료" : "준비 필요";
  summaryModelReady.style.color = ready ? "#34d399" : "#fbbf24";
}

function syncSummaryFromDom() {
  if (summaryFormat && outputFormatSelect) {
    summaryFormat.textContent = outputFormatSelect.selectedOptions[0]?.textContent || "PNG";
  }
  if (summaryUpscale) {
    summaryUpscale.textContent = `${resolveUpscale()}배`;
  }
  if (summaryFidelity) {
    summaryFidelity.textContent = getFidelity().toFixed(2);
  }
  if (summaryOptions) {
    const labels = getActiveOptionLabels();
    summaryOptions.replaceChildren();
    if (!labels.length) {
      summaryOptions.textContent = "없음";
      summaryOptions.classList.add("is-empty");
      return;
    }
    summaryOptions.classList.remove("is-empty");
    for (const label of labels) {
      const chip = document.createElement("span");
      chip.className = "summary-option-chip";
      chip.textContent = label;
      summaryOptions.appendChild(chip);
    }
  }
}

function updateActionButtons() {
  if (btnPickLocalFile) btnPickLocalFile.disabled = enhanceBusy;
  if (btnStartEnhance) btnStartEnhance.disabled = enhanceBusy || !hasImagePath();
  resetExportLinkUi();
}

function syncEnhancerShellBusy() {
  const busy =
    !!setupLoading?.classList.contains("is-active") || !!enhanceLoading?.classList.contains("is-active");
  if (!enhancerContentShell) return;
  if (busy) enhancerContentShell.setAttribute("aria-busy", "true");
  else enhancerContentShell.removeAttribute("aria-busy");
}

/** 준비·처리 팝업 — 다른 도구와 같이 화면 중앙으로 스크롤 후 포커스 */
function focusBusyOverlay(overlayEl) {
  if (!overlayEl?.classList.contains("is-active")) return;
  const panel = overlayEl.querySelector(".enhancer-busy-panel");
  requestAnimationFrame(() => {
    enhancerContentShell?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    overlayEl.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    requestAnimationFrame(() => {
      if (!panel) return;
      if (!panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
      panel.focus({ preventScroll: true });
    });
  });
}

function setSetupLoading(active, { title, message, step, progress } = {}) {
  if (!setupLoading) return;
  if (active) {
    const wasActive = setupLoading.classList.contains("is-active");
    setupLoading.hidden = false;
    setupLoading.classList.add("is-active");
    setupLoading.setAttribute("aria-hidden", "false");
    if (title && setupLoadingTitle) setupLoadingTitle.textContent = title;
    if (setupLoadingStep) setupLoadingStep.textContent = step || "";
    if (message && setupLoadingMessage) setupLoadingMessage.textContent = message;
    if (setupLoadingBar && typeof progress === "number") {
      const pct = Math.max(0, Math.min(100, progress));
      setupLoadingBar.style.width = `${pct}%`;
      setupLoadingBar.classList.add("is-determinate");
      setupLoadingTrack?.setAttribute("aria-valuenow", String(Math.round(pct)));
    }
    syncEnhancerShellBusy();
    if (!wasActive) focusBusyOverlay(setupLoading);
    return;
  }
  setupLoading.hidden = true;
  setupLoading.classList.remove("is-active");
  setupLoading.setAttribute("aria-hidden", "true");
  syncEnhancerShellBusy();
}

function setEnhanceLoading(active, { title, step, message, progress } = {}) {
  if (!enhanceLoading) return;
  if (active) {
    const wasActive = enhanceLoading.classList.contains("is-active");
    enhanceLoading.hidden = false;
    enhanceLoading.classList.add("is-active");
    enhanceLoading.setAttribute("aria-hidden", "false");
    if (title && enhanceLoadingTitle) enhanceLoadingTitle.textContent = title;
    if (enhanceLoadingStep) enhanceLoadingStep.textContent = step || "";
    if (message && enhanceLoadingMessage) enhanceLoadingMessage.textContent = message;
    if (enhanceLoadingBar && typeof progress === "number") {
      const pct = Math.max(0, Math.min(100, progress));
      if (!enhanceBusy || pct >= lastDisplayedProgress) lastDisplayedProgress = pct;
      enhanceLoadingBar.style.width = `${lastDisplayedProgress}%`;
      enhanceLoadingBar.classList.add("is-determinate");
      enhanceLoadingTrack?.setAttribute("aria-valuenow", String(Math.round(lastDisplayedProgress)));
      if (enhanceLoadingPercent) enhanceLoadingPercent.textContent = `${Math.round(lastDisplayedProgress)}%`;
    }
    syncEnhancerShellBusy();
    if (!wasActive) focusBusyOverlay(enhanceLoading);
    return;
  }
  enhanceLoading.hidden = true;
  enhanceLoading.classList.remove("is-active");
  enhanceLoading.setAttribute("aria-hidden", "true");
  syncEnhancerShellBusy();
}

function preparePhaseTitle(phase) {
  if (phase === "installing_dependencies") return "라이브러리 · PyTorch";
  if (phase === "downloading_models") return "AI 모델";
  if (phase === "ready") return "설치 완료";
  if (phase === "failed") return "설치 실패";
  return "AI 환경 준비";
}

function applyPrepareStatusToOverlay(data) {
  setSetupLoading(true, {
    title: preparePhaseTitle(data?.phase || ""),
    step: data?.step || "",
    message: data?.detail || data?.message || "준비 중입니다…",
    progress: typeof data?.progress === "number" ? data.progress : undefined,
  });
}

function applyEnhanceStatusToOverlay(data) {
  setEnhanceLoading(true, {
    title: "화질 향상",
    step: data?.message || "CodeFormer 처리 중…",
    message: "얼굴·디테일을 복원하고 있습니다.",
    progress: typeof data?.progress === "number" ? data.progress : undefined,
  });
}

function revokePreviewUrls() {
  if (lastOriginalBlobUrl) URL.revokeObjectURL(lastOriginalBlobUrl);
  if (lastResultBlobUrl) URL.revokeObjectURL(lastResultBlobUrl);
  lastOriginalBlobUrl = "";
  lastResultBlobUrl = "";
  lastOriginalDirectUrl = "";
  for (const img of [previewSource, compareOriginal, compareResult]) {
    if (img) {
      img.removeAttribute("src");
      img.classList.add("is-pending");
    }
  }
}

async function blobUrlFromImageResponse(res) {
  const contentType = (res.headers.get("content-type") || "image/png").split(";")[0].trim();
  if (!contentType.startsWith("image/")) {
    const detail = await parseApiError(res);
    throw new Error(
      detail.includes("Not Found") || detail.includes("404")
        ? "미리보기 API가 없습니다. ItMatZip 에이전트를 재시작하고 최신 agent 폴더를 반영하세요."
        : `이미지 응답이 아닙니다: ${detail}`,
    );
  }
  const buffer = await res.arrayBuffer();
  if (!buffer.byteLength) {
    throw new Error("이미지 데이터가 비어 있습니다.");
  }
  return URL.createObjectURL(new Blob([buffer], { type: contentType }));
}

async function fetchImageBlobUrlFromAgentPath(filePath, { directUrl = "" } = {}) {
  const nativePath = pathForAgentApi(filePath);
  if (!nativePath && !directUrl) {
    throw new Error("이미지 경로가 비어 있습니다.");
  }
  await primeLocalNetworkAccess();
  const origin = getAgentOrigin();
  const headers = { Accept: "image/*" };

  if (directUrl) {
    const res = await fetchAgent(directUrl, { method: "GET", headers, cache: "no-store" });
    if (res.ok) {
      return blobUrlFromImageResponse(res);
    }
  }

  const pathBody = JSON.stringify({ path: nativePath, image_path: nativePath });
  const normalized = normalizeFilePath(filePath);

  const sources = [
    () =>
      fetchAgent(`${origin}${AGENT_READ_LOCAL_IMAGE}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: pathBody,
        cache: "no-store",
      }),
    () =>
      fetchAgent(`${origin}${TOOL_API}/preview`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: pathBody,
        cache: "no-store",
      }),
    () =>
      fetchAgent(buildPreviewUrl(normalized), {
        method: "GET",
        headers,
        cache: "no-store",
      }),
  ];

  let res = null;
  let lastDetail = "";
  for (const fetchSource of sources) {
    res = await fetchSource();
    if (res.ok) {
      return blobUrlFromImageResponse(res);
    }
    lastDetail = await parseApiError(res);
    if (res.status !== 404 && res.status !== 405) {
      throw new Error(lastDetail);
    }
  }
  throw new Error(
    lastDetail.includes("Not Found") || lastDetail.includes("404")
      ? "미리보기를 불러올 수 없습니다. ItMatZip 에이전트를 최신으로 다시 빌드·실행한 뒤 페이지를 새로고침하세요."
      : lastDetail || "미리보기를 불러올 수 없습니다.",
  );
}

async function fetchImageBlobUrlFromAgentUrl(agentUrl) {
  await primeLocalNetworkAccess();
  const res = await fetchAgent(agentUrl, {
    method: "GET",
    cache: "no-store",
    headers: { Accept: "image/*" },
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res));
  }
  return blobUrlFromImageResponse(res);
}

function storePreviewBlob(trackAs, objectUrl) {
  if (trackAs === "original") {
    if (lastOriginalBlobUrl) URL.revokeObjectURL(lastOriginalBlobUrl);
    lastOriginalBlobUrl = objectUrl;
    lastOriginalDirectUrl = "";
    return;
  }
  if (trackAs === "result") {
    if (lastResultBlobUrl) URL.revokeObjectURL(lastResultBlobUrl);
    lastResultBlobUrl = objectUrl;
  }
}

/** loopback: HTTP URL 직접 표시(엑박·revoke 방지). 그 외: fetch → blob */
async function loadImageInto(imgEl, filePath, { useDownload = false, directUrl = "" } = {}) {
  if (!imgEl) throw new Error("미리보기 영역을 찾을 수 없습니다.");
  const native = pathForAgentApi(filePath);
  if (!native) throw new Error("이미지 경로가 비어 있습니다.");

  imgEl.classList.add("is-pending");
  imgEl.removeAttribute("src");

  if (isAgentLoopbackPage()) {
    const url = directUrl || buildLocalPreviewImageUrl(filePath);
    if (!url) throw new Error("미리보기 URL을 만들 수 없습니다.");
    if (lastOriginalBlobUrl && (imgEl === previewSource || imgEl === compareOriginal)) {
      URL.revokeObjectURL(lastOriginalBlobUrl);
      lastOriginalBlobUrl = "";
    }
    if (lastResultBlobUrl && imgEl === compareResult) {
      URL.revokeObjectURL(lastResultBlobUrl);
      lastResultBlobUrl = "";
    }
    imgEl.src = url;
    if (imgEl === previewSource || imgEl === compareOriginal) {
      lastOriginalDirectUrl = url;
    }
    await waitPreviewImageReady(imgEl);
    imgEl.classList.remove("is-pending");
    return url;
  }

  await primeLocalNetworkAccess();
  const blobUrl = useDownload
    ? await fetchImageBlobUrlFromAgentUrl(buildDownloadUrl(filePath))
    : await fetchImageBlobUrlFromAgentPath(filePath, { directUrl });
  imgEl.src = blobUrl;
  await waitPreviewImageReady(imgEl);
  imgEl.classList.remove("is-pending");
  return blobUrl;
}

function waitImageReady(imgEl) {
  if (!imgEl) return Promise.resolve();
  if (imgEl.complete && imgEl.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("이미지를 표시할 수 없습니다."));
    };
    const cleanup = () => {
      imgEl.removeEventListener("load", onLoad);
      imgEl.removeEventListener("error", onError);
    };
    imgEl.addEventListener("load", onLoad);
    imgEl.addEventListener("error", onError);
  });
}

function setPreviewPlaceholderMessage(message) {
  const p = previewEmpty?.querySelector("p");
  const isError = !!(message && !message.includes("불러오는 중") && !message.includes("선택하면"));
  if (previewEmpty) previewEmpty.classList.toggle("is-error", isError);
  if (p) p.textContent = message;
}

async function assignPreviewFromPath(
  imgEl,
  filePath,
  { trackAs = null, useDownload = false, directUrl = "" } = {},
) {
  const loaded = await loadImageInto(imgEl, filePath, { useDownload, directUrl });
  if (trackAs === "original" && typeof loaded === "string" && loaded.startsWith("blob:")) {
    storePreviewBlob("original", loaded);
  } else if (trackAs === "result" && typeof loaded === "string" && loaded.startsWith("blob:")) {
    storePreviewBlob("result", loaded);
  }
}

function setPreviewMode(mode) {
  const empty = mode === "empty";
  const loading = mode === "loading";
  const single = mode === "single";
  const compare = mode === "compare";
  if (previewEmpty) {
    previewEmpty.hidden = !empty && !loading;
    if (loading || (empty && !previewEmpty.classList.contains("is-error"))) {
      previewEmpty.classList.remove("is-error");
      const msg = previewEmpty.querySelector("p");
      if (msg) {
        msg.textContent = loading
          ? "이미지를 불러오는 중…"
          : "이미지를 선택하면 여기에 원본이 표시됩니다.";
      }
    }
  }
  if (previewSingle) {
    previewSingle.hidden = !single;
    if (!single && !compare && previewSource) previewSource.classList.add("is-pending");
  }
  if (compareSlider) compareSlider.hidden = !compare;
  if (compareHint) compareHint.hidden = !compare;
  if (!compare) setPreviewPanelHeading(false);
}

function applyCompareSplit(pct) {
  compareSplitPct = Math.max(0, Math.min(100, pct));
  const split = `${compareSplitPct}%`;
  if (compareSlider) compareSlider.style.setProperty("--compare-split", split);
  if (compareDivider) compareDivider.style.left = split;
  if (compareHandle) {
    compareHandle.setAttribute("aria-valuenow", String(Math.round(compareSplitPct)));
  }
}

function compareSplitFromPointer(clientX) {
  if (!previewViewport) return compareSplitPct;
  const rect = previewViewport.getBoundingClientRect();
  if (rect.width <= 0) return compareSplitPct;
  const ratio = (clientX - rect.left) / rect.width;
  return ratio * 100;
}

function onComparePointerDown(e) {
  if (compareSlider?.hidden) return;
  compareDragActive = true;
  compareSlider?.classList.add("is-dragging");
  if (compareHandle && e.target !== compareHandle) compareHandle.focus();
  applyCompareSplit(compareSplitFromPointer(e.clientX));
  if (e.pointerId != null) compareSlider?.setPointerCapture?.(e.pointerId);
  e.preventDefault();
}

function onComparePointerMove(e) {
  if (!compareDragActive) return;
  applyCompareSplit(compareSplitFromPointer(e.clientX));
}

function onComparePointerUp(e) {
  if (!compareDragActive) return;
  compareDragActive = false;
  compareSlider?.classList.remove("is-dragging");
  if (e.pointerId != null) compareSlider?.releasePointerCapture?.(e.pointerId);
}

function onCompareKeydown(e) {
  if (!compareHandle || compareSlider?.hidden) return;
  let delta = 0;
  if (e.key === "ArrowLeft" || e.key === "ArrowDown") delta = -4;
  if (e.key === "ArrowRight" || e.key === "ArrowUp") delta = 4;
  if (e.key === "Home") {
    applyCompareSplit(0);
    e.preventDefault();
    return;
  }
  if (e.key === "End") {
    applyCompareSplit(100);
    e.preventDefault();
    return;
  }
  if (!delta) return;
  applyCompareSplit(compareSplitPct + delta);
  e.preventDefault();
}

function initCompareSlider() {
  compareSlider?.addEventListener("pointerdown", onComparePointerDown);
  compareSlider?.addEventListener("pointermove", onComparePointerMove);
  compareSlider?.addEventListener("pointerup", onComparePointerUp);
  compareSlider?.addEventListener("pointercancel", onComparePointerUp);
  compareHandle?.addEventListener("keydown", onCompareKeydown);
  applyCompareSplit(50);
}

async function showOriginalPreview(filePath, { directUrl = "" } = {}) {
  const normalized = normalizeFilePath(filePath);
  if (!normalized) {
    setPreviewMode("empty");
    setPreviewPlaceholderMessage("이미지를 선택하면 여기에 원본이 표시됩니다.");
    return;
  }
  const token = ++previewLoadToken;
  setPreviewMode("loading");
  if (previewSingle) previewSingle.hidden = true;
  if (previewSource) {
    previewSource.removeAttribute("src");
    previewSource.classList.add("is-pending");
  }
  try {
    await assignPreviewFromPath(previewSource, filePath, {
      trackAs: "original",
      directUrl,
    });
  } catch (err) {
    if (token !== previewLoadToken) return;
    if (previewSource) {
      previewSource.removeAttribute("src");
      previewSource.classList.add("is-pending");
    }
    setPreviewMode("empty");
    setPreviewPlaceholderMessage(
      err instanceof Error ? err.message : "미리보기를 불러오지 못했습니다.",
    );
    throw err;
  }
  if (token !== previewLoadToken) return;
  if (!(previewSource?.naturalWidth > 0)) {
    setPreviewMode("empty");
    setPreviewPlaceholderMessage("이미지를 표시할 수 없습니다.");
    return;
  }
  setPreviewMode("single");
  revealPreviewSingle();
}

async function loadCompareOriginal(originalPath) {
  const native = pathForAgentApi(originalPath);
  const current = pathForAgentApi(imagePathInput?.value);
  if (
    compareOriginal &&
    previewSource?.src &&
    previewSource.naturalWidth > 0 &&
    native &&
    native === current
  ) {
    compareOriginal.classList.add("is-pending");
    compareOriginal.src = previewSource.src;
    await waitPreviewImageReady(compareOriginal);
    compareOriginal.classList.remove("is-pending");
    return;
  }
  await assignPreviewFromPath(compareOriginal, originalPath, { trackAs: "original" });
}

async function showComparePreviews(originalPath, resultPath) {
  const token = ++previewLoadToken;
  applyCompareSplit(50);
  setPreviewMode("compare");
  if (previewEmpty) previewEmpty.hidden = true;
  if (previewSingle) previewSingle.hidden = true;
  compareOriginal?.classList.add("is-pending");
  compareResult?.classList.add("is-pending");
  try {
    await assignPreviewFromPathWithFallback(compareResult, resultPath, { trackAs: "result" });
    if (!(compareResult?.naturalWidth > 0)) {
      throw new Error("결과 이미지를 표시할 수 없습니다.");
    }
    await loadCompareOriginal(originalPath);
    if (!(compareOriginal?.naturalWidth > 0)) {
      throw new Error("원본 이미지를 표시할 수 없습니다.");
    }
  } catch (err) {
    if (token !== previewLoadToken) return;
    setPreviewMode("empty");
    setPreviewPlaceholderMessage(
      err instanceof Error ? err.message : "비교 미리보기를 불러오지 못했습니다.",
    );
    throw err;
  }
  if (token !== previewLoadToken) return;
  revealCompareMode();
}

async function showResultPreviewOnly(resultPath) {
  const token = ++previewLoadToken;
  setPreviewMode("single");
  await assignPreviewFromPathWithFallback(previewSource, resultPath, { trackAs: "result" });
  if (token !== previewLoadToken) return;
  if (!(previewSource?.naturalWidth > 0)) {
    throw new Error("결과 이미지를 표시할 수 없습니다.");
  }
  revealPreviewSingle();
}

async function getToolStatus() {
  const res = await fetchAgent(`${getAgentOrigin()}${TOOL_API}/status`, { cache: "no-store" });
  if (!res.ok) throw new Error(`상태 조회 실패: ${res.status}`);
  return res.json();
}

async function fetchPrepareStatus() {
  const res = await fetchAgent(`${getAgentOrigin()}${TOOL_API}/prepare/status`, { cache: "no-store" });
  if (!res.ok) throw new Error(`prepare status 실패: ${await parseApiError(res)}`);
  return res.json();
}

function isPrepareInProgress(phase) {
  return phase === "installing_dependencies" || phase === "downloading_models";
}

async function pollPrepareStatus() {
  for (;;) {
    const data = await fetchPrepareStatus();
    const phase = data?.phase || "";
    if (phase === "ready") {
      applyPrepareStatusToOverlay(data);
      return;
    }
    if (phase === "failed") {
      applyPrepareStatusToOverlay(data);
      throw new Error(data.detail || data.message || "모델 준비 실패");
    }
    if (isPrepareInProgress(phase)) applyPrepareStatusToOverlay(data);
    await new Promise((r) => setTimeout(r, 600));
  }
}

async function prepareModel() {
  setAgentLongOperationActive(true);
  try {
    setSetupLoading(true, {
      title: "AI 환경 준비",
      step: "설치 시작",
      message: "PyTorch · CodeFormer · 모델을 설치합니다.",
      progress: 5,
    });
    const res = await fetchAgent(`${getAgentOrigin()}${TOOL_API}/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`prepare 실패: ${await parseApiError(res)}`);
    const initial = await res.json().catch(() => null);
    if (initial) applyPrepareStatusToOverlay(initial);
    await pollPrepareStatus();
    const data = await getToolStatus();
    toolReady = !!data.model_ready;
    setModelReadySummary(toolReady);
    setSetupLoading(false);
    if (!toolReady) throw new Error("모델 준비가 완료되지 않았습니다.");
    await checkReadiness(true);
  } finally {
    setAgentLongOperationActive(false);
  }
}

async function refreshToolStatus() {
  const data = await getToolStatus();
  toolReady = !!data.model_ready;
  setModelReadySummary(toolReady);
  updateActionButtons();
  if (toolReady) return true;
  await prepareModel();
  return true;
}

/**
 * @param {{ agentOk?: boolean, pytorch?: object, binaries?: object }} ctx
 */
function setComputeCapabilityBadge(ctx) {
  if (!computeCapability) return;

  computeCapability.classList.remove("is-gpu", "is-cpu", "is-pending", "is-warn");

  if (ctx.agentOk === false) {
    computeCapability.classList.add("is-pending");
    computeCapability.textContent = "연산 장치 확인 불가";
    computeCapability.title = "에이전트에 연결되면 GPU/CPU 여부를 표시합니다.";
    return;
  }

  const p = ctx.pytorch && typeof ctx.pytorch === "object" ? ctx.pytorch : null;
  const b = ctx.binaries && typeof ctx.binaries === "object" ? ctx.binaries : null;

  if (!p && !b) {
    computeCapability.classList.add("is-pending");
    computeCapability.textContent = "연산 장치 확인 중…";
    computeCapability.title = "";
    return;
  }

  const gpuDetected = Boolean(p?.gpu_detected);
  const cudaReady = Boolean(b?.cuda_available);
  const installed = p?.installed_bundle ? String(p.installed_bundle) : "";
  const torchVer = p?.torch_version ? String(p.torch_version) : "";

  if (cudaReady) {
    computeCapability.classList.add("is-gpu");
    computeCapability.textContent = "GPU · CUDA 사용 가능";
    computeCapability.title = torchVer
      ? `PyTorch ${torchVer} — CodeFormer가 GPU로 동작합니다.`
      : "CodeFormer가 GPU로 동작합니다.";
    return;
  }

  if (gpuDetected && installed === "cpu") {
    computeCapability.classList.add("is-warn");
    computeCapability.textContent = "GPU · CUDA 미적용";
    computeCapability.title = torchVer
      ? `PyTorch ${torchVer} (CPU 빌드). 환경 준비를 다시 실행하면 GPU wheel로 교체됩니다.`
      : "PyTorch CPU 빌드입니다. 환경 준비를 다시 실행하세요.";
    return;
  }

  if (gpuDetected && installed === "cuda") {
    computeCapability.classList.add("is-warn");
    computeCapability.textContent = "GPU · CUDA 미사용";
    computeCapability.title =
      "NVIDIA GPU는 있으나 CUDA를 쓸 수 없습니다. 드라이버·환경 준비를 확인하세요.";
    return;
  }

  if (gpuDetected) {
    computeCapability.classList.add("is-gpu");
    computeCapability.textContent = "GPU 감지됨";
    computeCapability.title =
      "NVIDIA GPU가 있습니다. CUDA PyTorch 설치 후 GPU 복원이 가능합니다.";
    return;
  }

  computeCapability.classList.add("is-cpu");
  computeCapability.textContent = "CPU만 가능";
  computeCapability.title = torchVer
    ? `PyTorch ${torchVer} — GPU가 없어 CPU로 동작합니다.`
    : "NVIDIA GPU가 감지되지 않았습니다. CPU wheel로 설치·실행됩니다.";
}

/** @param {boolean} agentOk @param {object | null} data */
function updateBinReadiness(agentOk, data) {
  if (!binReadiness) return;

  if (!agentOk) {
    binReadiness.className = "bin-readiness is-warn";
    binReadiness.textContent = "에이전트 미연결 → CodeFormer · 모델 점검 불가";
    return;
  }

  if (!data) {
    binReadiness.className = "bin-readiness is-warn";
    binReadiness.textContent = "Image Enhancer · 환경 확인 중…";
    return;
  }

  const b = data.binaries && typeof data.binaries === "object" ? data.binaries : null;
  if (!b) {
    binReadiness.className = "bin-readiness is-err";
    binReadiness.textContent = "준비 상태 응답이 비정상입니다.";
    return;
  }

  const p = data.pytorch && typeof data.pytorch === "object" ? data.pytorch : null;
  const parts = [];
  parts.push(b.torch ? "PyTorch" : "PyTorch ✗");
  parts.push(b.pip_stack ? "pip" : "pip ✗");
  parts.push(b.vendor_ready ? "CodeFormer" : "CodeFormer ✗");
  parts.push(b.model_ready ? "모델" : "모델 ✗");
  if (b.cuda_available) parts.push("CUDA");
  else if (p?.gpu_detected && p?.installed_bundle === "cpu") parts.push("CUDA 재설치 필요");

  // enhance API와 동일 — model_ready가 실제 사용 가능 여부
  toolReady = !!b.model_ready;
  setModelReadySummary(!!b.model_ready);

  if (b.model_ready) {
    binReadiness.className = "bin-readiness is-ok";
    binReadiness.textContent = `${parts.join(" · ")} 준비됨`;
    return;
  }

  binReadiness.className = "bin-readiness is-warn";
  binReadiness.textContent = `${parts.join(" · ")} · 준비 필요`;
}

/** @param {boolean} [knownOk] */
async function checkReadiness(knownOk) {
  if (knownOk === false) {
    setComputeCapabilityBadge({ agentOk: false });
    updateBinReadiness(false, null);
    return;
  }

  const agent = knownOk === true ? { ok: true } : await checkAgentConnection();
  if (!agent.ok) {
    setComputeCapabilityBadge({ agentOk: false });
    updateBinReadiness(false, null);
    return;
  }

  if (!toolReady) {
    binReadiness.className = "bin-readiness is-warn";
    binReadiness.textContent = "CodeFormer · 모델 확인 중…";
  }

  try {
    const res = await fetchAgent(`${getAgentOrigin()}${TOOL_API}/readiness`, { cache: "no-store" });
    if (!res.ok) {
      setComputeCapabilityBadge({ agentOk: true });
      updateBinReadiness(true, null);
      return;
    }
    const data = await res.json();
    setComputeCapabilityBadge({
      agentOk: true,
      pytorch: data?.pytorch,
      binaries: data?.binaries,
    });
    updateBinReadiness(true, data);
    updateActionButtons();
  } catch (err) {
    setComputeCapabilityBadge({ agentOk: true });
    const msg = err instanceof Error ? err.message : String(err);
    binReadiness.className = "bin-readiness is-err";
    binReadiness.textContent = `환경 준비 실패: ${msg}`;
  }
}

async function pickLocalImage() {
  const res = await fetchAgent(`${getAgentOrigin()}/api/agent/pick-local-image-file`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  const pick = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(pick?.detail || pick?.message || res.statusText);
  const path = String(pick?.path || "").trim();
  const previewUrl = String(pick?.preview_url || "").trim();
  if (!path || pick?.cancelled) return;
  suppressPathPreview += 1;
  if (imagePathInput) imagePathInput.value = path;
  if (pathHint) pathHint.textContent = "화질 향상 버튼을 눌러 처리하세요.";
  downloadReady = false;
  lastResultUrl = null;
  clearDownloadSession();
  revokePreviewUrls();
  try {
    await showOriginalPreview(path, { directUrl: previewUrl });
  } catch (err) {
    if (pathHint) {
      pathHint.textContent =
        err instanceof Error ? err.message : "미리보기를 불러오지 못했습니다.";
    }
    console.warn("[image-enhancer] preview failed:", err);
  } finally {
    suppressPathPreview = Math.max(0, suppressPathPreview - 1);
  }
  updateActionButtons();
}

async function cleanupWorkspace() {
  try {
    await fetchAgent(`${getAgentOrigin()}${TOOL_API}/workspace/cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
  } catch {
    /* ignore */
  }
}

async function pollEnhanceStatus() {
  for (;;) {
    const res = await fetchAgent(`${getAgentOrigin()}${TOOL_API}/enhance/status`, { cache: "no-store" });
    if (!res.ok) throw new Error(await parseApiError(res));
    const data = await res.json();
    if (data.phase === "running") {
      applyEnhanceStatusToOverlay(data);
      await new Promise((r) => setTimeout(r, 450));
      continue;
    }
    if (data.phase === "ready") {
      setEnhanceLoading(false);
      return data;
    }
    if (data.phase === "failed") {
      throw new Error(data.message || "화질 향상 실패");
    }
    await new Promise((r) => setTimeout(r, 450));
  }
}

async function startEnhance() {
  if (!hasImagePath()) {
    alert("이미지 파일을 선택하세요.");
    return;
  }
  const agent = await checkAgentConnection();
  if (!agent.ok) {
    await showInstallAgentDialog(await installDialogOpts());
    return;
  }

  try {
    await refreshToolStatus();
  } catch (err) {
    alert(formatAgentConnectionError(err));
    return;
  }

  enhanceBusy = true;
  setAgentLongOperationActive(true);
  lastDisplayedProgress = 0;
  downloadReady = false;
  lastResultUrl = null;
  clearDownloadSession();
  updateActionButtons();
  setEnhanceLoading(true, {
    title: "화질 향상",
    step: "작업 요청",
    message: "CodeFormer를 시작합니다…",
    progress: 2,
  });

  try {
    const body = {
      image_path: imagePathInput.value.trim(),
      fidelity: getFidelity(),
      upscale: resolveUpscale(),
      background_enhance: !!backgroundEnhance?.checked,
      bg_tile: resolveBgTile(),
      only_center_face: !!onlyCenterFace?.checked,
      face_upsample: faceUpsample?.checked !== false,
      output_format: outputFormatSelect?.value || "png",
      device: resolveDeviceParam(),
      timeout_sec: 1800,
    };
    const res = await fetchAgent(`${getAgentOrigin()}${TOOL_API}/enhance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await parseApiError(res));
    const done = await pollEnhanceStatus();
    if (!done.result_path) throw new Error("결과 경로가 없습니다.");

    lastResultUrl = buildDownloadUrl(done.result_path);
    persistDownloadSession({
      resultPath: done.result_path,
      originalPath: done.original_path || body.image_path,
      imagePath: body.image_path,
      outputFormat: body.output_format || "png",
    });
    downloadReady = true;
    resetExportLinkUi();
    setEnhanceLoading(false);
    try {
      await showComparePreviews(done.original_path || body.image_path, done.result_path);
      if (pathHint) {
        const rw = compareResult?.naturalWidth || 0;
        const rh = compareResult?.naturalHeight || 0;
        const dim = rw > 0 ? ` (${rw}×${rh})` : "";
        pathHint.textContent = `처리가 완료되었습니다${dim}. 슬라이더로 결과·원본을 비교하거나 다운로드하세요.`;
      }
    } catch (compareErr) {
      console.warn("[image-enhancer] compare preview failed, showing result only:", compareErr);
      await showResultPreviewOnly(done.result_path);
      if (pathHint) {
        const msg =
          compareErr instanceof Error ? compareErr.message : "비교 보기를 불러오지 못했습니다.";
        pathHint.textContent = `처리는 완료되었습니다. 비교 보기 실패 — 결과만 표시합니다. (${msg})`;
      }
    }
  } catch (err) {
    setEnhanceLoading(true, {
      title: "처리 실패",
      step: "",
      message: formatAgentConnectionError(err),
      progress: 0,
    });
    await new Promise((r) => setTimeout(r, 2500));
    setEnhanceLoading(false);
    alert(formatAgentConnectionError(err));
  } finally {
    enhanceBusy = false;
    setAgentLongOperationActive(false);
    updateActionButtons();
  }
}

async function resetEditor() {
  await cleanupWorkspace();
  clearDownloadSession();
  revokePreviewUrls();
  if (imagePathInput) imagePathInput.value = "";
  setPreviewMode("empty");
  if (previewSource) previewSource.removeAttribute("src");
  if (compareOriginal) compareOriginal.removeAttribute("src");
  if (compareResult) compareResult.removeAttribute("src");
  downloadReady = false;
  lastResultUrl = null;
  if (pathHint) pathHint.textContent = "이미지를 선택하면 화질 향상 버튼 위 미리보기에 원본이 표시됩니다.";
  updateActionButtons();
}

async function restoreEditorAfterDownload() {
  if (sessionStorage.getItem(STORAGE_RETURN_FROM_DL) !== "1") return;
  sessionStorage.removeItem(STORAGE_RETURN_FROM_DL);

  const imagePath = sessionStorage.getItem(STORAGE_EDITOR_IMAGE_PATH) || "";
  const resultPath = sessionStorage.getItem(STORAGE_DL_RESULT_PATH) || "";
  const originalPath =
    sessionStorage.getItem(STORAGE_DL_ORIGINAL_PATH) || imagePath || "";

  if (imagePath && imagePathInput) {
    imagePathInput.value = imagePath;
    suppressPathPreview += 1;
    try {
      await showOriginalPreview(imagePath);
    } catch (err) {
      console.warn("[image-enhancer] restore preview failed:", err);
    } finally {
      suppressPathPreview = Math.max(0, suppressPathPreview - 1);
    }
  }

  if (!resultPath) return;

  lastResultUrl = buildDownloadUrl(resultPath);
  downloadReady = true;
  resetExportLinkUi();

  try {
    await showComparePreviews(originalPath, resultPath);
    if (pathHint) {
      pathHint.textContent =
        "다운로드 화면에서 돌아왔습니다. 슬라이더로 비교하거나 다시 다운로드할 수 있습니다.";
    }
  } catch (compareErr) {
    console.warn("[image-enhancer] restore compare failed:", compareErr);
    try {
      await showResultPreviewOnly(resultPath);
      if (pathHint) pathHint.textContent = "다운로드 화면에서 돌아왔습니다. 결과 미리보기를 표시합니다.";
    } catch {
      if (pathHint) pathHint.textContent = "다운로드 화면에서 돌아왔습니다.";
    }
  }
}

async function onImagePathChanged() {
  if (suppressPathPreview > 0 || enhanceBusy) return;
  const path = imagePathInput?.value.trim() || "";
  if (!path) {
    revokePreviewUrls();
    setPreviewMode("empty");
    downloadReady = false;
    lastResultUrl = null;
    clearDownloadSession();
    updateActionButtons();
    return;
  }
  downloadReady = false;
  lastResultUrl = null;
  clearDownloadSession();
  try {
    await showOriginalPreview(path);
    if (pathHint) pathHint.textContent = "화질 향상 버튼을 눌러 처리하세요.";
  } catch (err) {
    if (pathHint) {
      pathHint.textContent =
        err instanceof Error ? err.message : "미리보기를 불러오지 못했습니다.";
    }
  }
  updateActionButtons();
}

async function init() {
  warnIfRemoteToolsPage();
  setSetupLoading(false);
  setEnhanceLoading(false);
  setPreviewMode("empty");
  initCompareSlider();
  void showAdSense("editorAboveWorkspace", "#editor-ad-above-path");
  void showAdSense("editorBelowExport", "#editor-ad-below-export");
  syncSummaryFromDom();

  fidelityRange?.addEventListener("input", () => {
    if (fidelityValue) fidelityValue.textContent = getFidelity().toFixed(2);
    syncSummaryFromDom();
  });
  outputFormatSelect?.addEventListener("change", syncSummaryFromDom);
  upscaleSelect?.addEventListener("change", syncSummaryFromDom);
  faceUpsample?.addEventListener("change", syncSummaryFromDom);
  onlyCenterFace?.addEventListener("change", syncSummaryFromDom);
  backgroundEnhance?.addEventListener("change", syncBackgroundEnhanceUi);
  backgroundQualityMode?.addEventListener("change", syncSummaryFromDom);
  syncBackgroundEnhanceUi();
  let pathDebounce = null;
  imagePathInput?.addEventListener("input", () => {
    clearTimeout(pathDebounce);
    pathDebounce = setTimeout(() => void onImagePathChanged(), 400);
  });
  btnPickLocalFile?.addEventListener("click", async () => {
    try {
      btnPickLocalFile.disabled = true;
      btnPickLocalFile.textContent = "대화상자…";
      await pickLocalImage();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      btnPickLocalFile.textContent = "찾아보기";
      updateActionButtons();
    }
  });
  btnNewJob?.addEventListener("click", () => resetEditor());
  btnStartEnhance?.addEventListener("click", () => startEnhance());
  exportLink?.addEventListener("click", (e) => {
    e.preventDefault();
    void navigateToDownloadPage(exportLink);
  });

  const connectionEl = document.getElementById("connection-status");
  const connectionMonitor = startConnectionMonitor({
    intervalMs: 3000,
    immediate: true,
    onChange: (ok, detail) => {
      const busy = detail?.longOp === true;
      applyConnectionStatusDot(connectionEl, ok || busy, detail);
      void checkReadiness(ok || busy);
    },
    autoShowInstallDialog: true,
    installDialogOptions: installDialogOpts,
  });

  window.addEventListener("focus", () => void connectionMonitor.refresh());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void connectionMonitor.refresh();
  });

  const agent = await checkAgentConnection();
  if (!agent.ok) {
    await showInstallAgentDialog(await installDialogOpts());
    return;
  }

  try {
    const status = await getToolStatus();
    toolReady = !!status.model_ready;
    setModelReadySummary(toolReady);
    if (!toolReady) await prepareModel();
    else await checkReadiness();
  } catch (err) {
    if (binReadiness) {
      binReadiness.className = "bin-readiness is-err";
      binReadiness.textContent = formatAgentConnectionError(err);
    }
  }

  await restoreEditorAfterDownload();
  updateActionButtons();
}

init();
