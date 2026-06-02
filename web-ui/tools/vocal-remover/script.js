import {
  applyConnectionStatusDot,
  checkAgentConnection,
  configureBridge,
  fetchAgent,
  formatAgentConnectionError,
  getAgentOrigin,
  mapAgentEventToPrepareStatus,
  requestAgent,
  showInstallAgentDialog,
  startAgentEventStream,
  startConnectionMonitor,
} from "../common/bridge.js?v=lna13";
import { showAdSense } from "../common/adsense.js";
import { agentInstallDialogOptions, escHtml } from "../common/agent-install-ui.js";
import { createVocalDualPlayer } from "./dual-player.js?v=dp2";

configureBridge({ healthPath: "/health" });

const dualPlayer = createVocalDualPlayer({
  requestAgent,
  getAgentOrigin,
  fetchAgent,
});

/** @param {string} filePath */
function applyDualPlayerFilePick(filePath) {
  if (typeof dualPlayer.prepareForFilePick === "function") {
    dualPlayer.prepareForFilePick(filePath);
    return;
  }
  console.warn(
    "[vocal-remover] dual-player.js is outdated (missing prepareForFilePick). Hard-refresh the page (Ctrl+F5).",
  );
}

const audioPathInput = document.getElementById("audio-path");
const btnPickLocalFile = document.getElementById("btn-pick-local-file");
const btnNewJob = document.getElementById("btn-new-job");
const btnStartSeparation = document.getElementById("btn-start-separation");
const exportLink = document.getElementById("export-link");
const outputFormatSelect = document.getElementById("output-format");
const deviceSelect = document.getElementById("device-select");
const summaryModelReady = document.getElementById("summary-model-ready");
const summaryFormat = document.getElementById("summary-format");
const vocalEditorShell = document.getElementById("vocal-editor-shell");
const vocalSetupLoading = document.getElementById("vocal-setup-loading");
const setupLoadingTitle = document.getElementById("setup-loading-title");
const setupLoadingStep = document.getElementById("setup-loading-step");
const setupLoadingMessage = document.getElementById("setup-loading-message");
const setupLoadingTrack = document.getElementById("setup-loading-track");
const setupLoadingBar = document.getElementById("setup-loading-bar");
const vocalSeparationLoading = document.getElementById("vocal-separation-loading");
const separationLoadingTitle = document.getElementById("separation-loading-title");
const separationLoadingStep = document.getElementById("separation-loading-step");
const separationLoadingMessage = document.getElementById("separation-loading-message");
const separationLoadingPercent = document.getElementById("separation-loading-percent");
const separationLoadingTrack = document.getElementById("separation-loading-track");
const separationLoadingBar = document.getElementById("separation-loading-bar");
const dualWaveformSection = document.getElementById("dual-waveform-section");
const dropZoneEl = document.querySelector(".drop-zone");

const DOWNLOAD_PAGE = "download.html";
const STORAGE_MR_URL = "vocal-remover:mr-download-url";
const STORAGE_VOCAL_URL = "vocal-remover:vocal-download-url";
const STORAGE_FORMAT = "vocal-remover:output-format";
const STORAGE_SOURCE = "vocal-remover:source-name";
const EXPORT_LINK_DEFAULT_HTML =
  '<span class="icon" aria-hidden="true">📥</span> 결과 다운로드';

let lastMrDownloadUrl = null;
let lastVocalDownloadUrl = null;

function buildDownloadUrl(filePath) {
  return `${getAgentOrigin()}/api/tools/vocal-remover/download?file_path=${encodeURIComponent(filePath)}`;
}
let toolReady = false;
let separationBusy = false;
let downloadReady = false;
let hadWorkspaceArtifacts = false;
let pendingWorkspaceCleanup = false;
let lastDisplayedProgress = 0;

function installDialogOpts() {
  return agentInstallDialogOptions(() => checkAgentConnection());
}

function preparePhaseTitle(phase) {
  if (phase === "installing_dependencies") return "라이브러리 · GPU wheel";
  if (phase === "downloading_models") return "AI 모델";
  if (phase === "ready") return "설치 완료";
  if (phase === "failed") return "설치 실패";
  return "AI 환경 준비";
}

function applyPrepareStatusToOverlay(data) {
  const phase = data?.phase || "";
  const step = data?.step || "";
  const detail = data?.detail || data?.message || "준비 중입니다…";
  const title = preparePhaseTitle(phase);
  setSetupLoading(true, {
    title,
    step,
    message: detail,
    progress: typeof data?.progress === "number" ? data.progress : undefined,
  });
}

function setSetupLoading(active, { title, message, step, progress } = {}) {
  if (!vocalSetupLoading) return;
  if (active) {
    vocalSetupLoading.hidden = false;
    vocalSetupLoading.classList.add("is-active");
    vocalSetupLoading.setAttribute("aria-hidden", "false");
    vocalEditorShell?.setAttribute("aria-busy", "true");
    if (title && setupLoadingTitle) setupLoadingTitle.textContent = title;
    if (setupLoadingStep) {
      setupLoadingStep.textContent = step || "";
    }
    if (message && setupLoadingMessage) setupLoadingMessage.textContent = message;
    if (setupLoadingBar && setupLoadingTrack) {
      if (typeof progress === "number") {
        const pct = Math.max(0, Math.min(100, progress));
        setupLoadingBar.style.width = `${pct}%`;
        setupLoadingBar.classList.add("is-determinate");
        setupLoadingTrack.setAttribute("aria-valuenow", String(Math.round(pct)));
      } else {
        setupLoadingBar.style.width = "";
        setupLoadingBar.classList.remove("is-determinate");
        setupLoadingTrack.setAttribute("aria-valuenow", "0");
      }
    }
    return;
  }
  vocalSetupLoading.hidden = true;
  vocalSetupLoading.classList.remove("is-active");
  vocalSetupLoading.setAttribute("aria-hidden", "true");
  vocalEditorShell?.removeAttribute("aria-busy");
}

function setSeparationLoading(active, { title, step, message, progress } = {}) {
  if (!vocalSeparationLoading) return;
  if (active) {
    vocalSeparationLoading.removeAttribute("hidden");
    vocalSeparationLoading.hidden = false;
    vocalSeparationLoading.classList.add("is-active");
    vocalSeparationLoading.style.display = "flex";
    vocalSeparationLoading.setAttribute("aria-hidden", "false");
    dualWaveformSection?.classList.add("is-separating");
    dualWaveformSection?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (title && separationLoadingTitle) separationLoadingTitle.textContent = title;
    if (step !== undefined && separationLoadingStep) separationLoadingStep.textContent = step || "";
    if (message && separationLoadingMessage) separationLoadingMessage.textContent = message;
    if (separationLoadingBar && separationLoadingTrack) {
      if (typeof progress === "number") {
        const pct = Math.max(0, Math.min(100, progress));
        if (!separationBusy || pct >= lastDisplayedProgress) {
          lastDisplayedProgress = pct;
        }
        separationLoadingBar.style.width = `${lastDisplayedProgress}%`;
        separationLoadingBar.classList.add("is-determinate");
        separationLoadingTrack.setAttribute("aria-valuenow", String(Math.round(lastDisplayedProgress)));
        if (separationLoadingPercent) {
          separationLoadingPercent.textContent = `${Math.round(lastDisplayedProgress)}%`;
        }
      } else {
        separationLoadingBar.style.width = "";
        separationLoadingBar.classList.remove("is-determinate");
        separationLoadingTrack.setAttribute("aria-valuenow", "0");
        if (separationLoadingPercent) separationLoadingPercent.textContent = "…";
      }
    }
    return;
  }
  vocalSeparationLoading.classList.remove("is-active");
  vocalSeparationLoading.style.display = "none";
  vocalSeparationLoading.hidden = true;
  vocalSeparationLoading.setAttribute("aria-hidden", "true");
  dualWaveformSection?.classList.remove("is-separating");
}

function applySeparationStatusToOverlay(data) {
  const msg = data?.message || "";
  const pct = typeof data?.progress === "number" ? data.progress : undefined;
  let step = msg || "Demucs AI 분리 중…";
  if (data?.phase === "running" && !msg) {
    step = "Demucs AI 분리 중…";
  }
  setSeparationLoading(true, {
    title: "보컬·MR 분리",
    step,
    message: pct != null ? "음악(MR)과 보컬 스템을 생성하고 있습니다." : "에이전트에 분리 작업을 요청했습니다.",
    progress: pct,
  });
}

function syncSummaryFromDom() {
  if (summaryFormat && outputFormatSelect) {
    summaryFormat.textContent = outputFormatSelect.selectedOptions[0]?.textContent || "WAV";
  }
}

function setModelReadySummary(ready) {
  if (!summaryModelReady) return;
  summaryModelReady.textContent = ready ? "완료" : "준비 필요";
  summaryModelReady.style.color = ready ? "#34d399" : "#fbbf24";
}

function persistDownloadSession({ mrUrl, vocalUrl, format, source }) {
  if (mrUrl) sessionStorage.setItem(STORAGE_MR_URL, mrUrl);
  if (vocalUrl) sessionStorage.setItem(STORAGE_VOCAL_URL, vocalUrl);
  if (format) sessionStorage.setItem(STORAGE_FORMAT, String(format).toUpperCase());
  if (source != null) sessionStorage.setItem(STORAGE_SOURCE, source);
}

function canDownloadFromSession() {
  return !!(
    sessionStorage.getItem(STORAGE_MR_URL) && sessionStorage.getItem(STORAGE_VOCAL_URL)
  );
}

function restoreDownloadUrlsFromSession() {
  const mr = sessionStorage.getItem(STORAGE_MR_URL);
  const vocal = sessionStorage.getItem(STORAGE_VOCAL_URL);
  if (mr) lastMrDownloadUrl = mr;
  if (vocal) lastVocalDownloadUrl = vocal;
}

function clearDownloadResult() {
  downloadReady = false;
  hadWorkspaceArtifacts = false;
  lastMrDownloadUrl = null;
  lastVocalDownloadUrl = null;
  sessionStorage.removeItem(STORAGE_MR_URL);
  sessionStorage.removeItem(STORAGE_VOCAL_URL);
  sessionStorage.removeItem(STORAGE_FORMAT);
  sessionStorage.removeItem(STORAGE_SOURCE);
}

/** @returns {Promise<{ ok: boolean, busy?: boolean }>} */
async function cleanupAgentWorkspace() {
  try {
    const res = await fetchAgent(`${getAgentOrigin()}/api/tools/vocal-remover/workspace/cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.status === 409) return { ok: false, busy: true };
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

async function resetEditorState({ cleanupWorkspace = true } = {}) {
  if (cleanupWorkspace) await cleanupAgentWorkspace();
  clearDownloadResult();
  if (audioPathInput) audioPathInput.value = "";
  if (pathHint) {
    pathHint.textContent = "오디오를 선택한 뒤 분석하기를 누르면 MR·보컬을 분리합니다.";
  }
  applyDualPlayerFilePick("");
  updateActionButtons();
}

function isExportEnabled() {
  return downloadReady && !separationBusy;
}

function resetExportLinkUi() {
  if (!exportLink) return;
  exportLink.classList.remove("is-busy");
  exportLink.removeAttribute("aria-busy");
  exportLink.innerHTML = EXPORT_LINK_DEFAULT_HTML;
  exportLink.classList.toggle("is-disabled", !isExportEnabled());
}

async function navigateToDownloadPage(exportLinkEl) {
  if (!isExportEnabled() || !canDownloadFromSession()) {
    alert("먼저 분석하기로 MR·보컬 분리를 완료해 주세요.");
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

function hasAudioPath() {
  return !!(audioPathInput?.value.trim());
}

function updateActionButtons() {
  if (btnPickLocalFile && btnPickLocalFile.textContent !== "대화상자…") {
    btnPickLocalFile.disabled = separationBusy;
  }
  if (btnStartSeparation) {
    // 모델 미준비여도 분석하기 클릭 시 refreshToolStatus() → prepareModel() 실행
    btnStartSeparation.disabled = separationBusy || !hasAudioPath();
  }
  if (exportLink) {
    exportLink.classList.toggle("is-disabled", !isExportEnabled());
  }
  syncNewJobButton();
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

async function getToolStatus() {
  const res = await fetchAgent(`${getAgentOrigin()}/api/tools/vocal-remover/status`, {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`상태 조회 실패: ${res.status}`);
  }
  return res.json();
}

async function fetchPrepareStatus() {
  const res = await fetchAgent(`${getAgentOrigin()}/api/tools/vocal-remover/prepare/status`, {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`prepare status 실패: ${await parseApiError(res)}`);
  }
  return res.json();
}

function isPrepareInProgress(phase) {
  return phase === "installing_dependencies" || phase === "downloading_models";
}

async function prepareModel({ force = false } = {}) {
  setSetupLoading(true, {
    title: force ? "GPU(CUDA) PyTorch 설치" : "AI 환경 준비",
    step: "설치 시작",
    message: force
      ? "wheels_gpu.zip 분할 파일을 받아 CUDA PyTorch를 설치합니다. 수십 분 걸릴 수 있습니다."
      : "Demucs·diffq·AI 모델을 설치합니다.",
    progress: 5,
  });

  try {
    let status = await fetchPrepareStatus().catch(() => null);
    if (status && isPrepareInProgress(status.phase)) {
      applyPrepareStatusToOverlay(status);
    } else {
      const prepareUrl = `${getAgentOrigin()}/api/tools/vocal-remover/prepare${force ? "?force=true" : ""}`;
      const res = await fetchAgent(prepareUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        throw new Error(`prepare 실패: ${await parseApiError(res)}`);
      }
      status = await res.json().catch(() => null);
    }

    if (status && typeof status === "object") {
      applyPrepareStatusToOverlay(status);
    }

    await pollPrepareStatus({ force });
    const data = await getToolStatus();
    toolReady = !!data.model_ready;
    setModelReadySummary(toolReady);
    updateActionButtons();
    if (!toolReady) {
      throw new Error("모델 준비가 완료되지 않았습니다.");
    }
    setSetupLoading(false);
    await checkVocalToolReadiness(true);
  } catch (err) {
    setSetupLoading(true, {
      title: "준비 실패",
      message: formatAgentConnectionError(err),
      progress: 0,
    });
    throw err;
  }
}

async function kickPrepare(force = false) {
  const prepareUrl = `${getAgentOrigin()}/api/tools/vocal-remover/prepare${force ? "?force=true" : ""}`;
  const res = await fetchAgent(prepareUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(`prepare 실패: ${await parseApiError(res)}`);
  }
  return res.json().catch(() => null);
}

async function pollPrepareStatus({ force = false } = {}) {
  let notStartedStreak = 0;
  let restartAttempted = false;
  let lastProgress = -1;
  let lastProgressAt = Date.now();
  /** @type {"ready" | "failed" | null} */
  let wsTerminal = null;
  let wsErrorMessage = "";

  const { connected: wsConnected, unsubscribe: wsUnsub } = await startAgentEventStream({
    types: ["download", "install", "install_progress"],
    onEvent: (event) => {
      const mapped = mapAgentEventToPrepareStatus(event);
      if (!mapped) return;
      applyPrepareStatusToOverlay(mapped);
      if (mapped.phase === "ready") wsTerminal = "ready";
      if (mapped.phase === "failed") {
        wsTerminal = "failed";
        wsErrorMessage = mapped.message || mapped.detail || "모델 준비 실패";
      }
      if (typeof mapped.progress === "number") {
        lastProgress = mapped.progress;
        lastProgressAt = Date.now();
      }
    },
  });

  try {
    for (;;) {
      if (wsTerminal === "ready") return;
      if (wsTerminal === "failed") {
        throw new Error(wsErrorMessage || "모델 준비 실패");
      }

      /** @type {Record<string, unknown> | null} */
      let data = null;
      try {
        data = await fetchPrepareStatus();
      } catch (err) {
        if (wsConnected) {
          if (Date.now() - lastProgressAt > 20 * 60 * 1000) {
            throw new Error(
              "진행률이 20분 이상 변하지 않습니다. 네트워크·디스크를 확인한 뒤 페이지를 새로고침하세요.",
            );
          }
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw err;
      }

      const phase = data?.phase || "";

      if (phase === "ready") {
        applyPrepareStatusToOverlay(data);
        return;
      }
      if (phase === "failed") {
        applyPrepareStatusToOverlay(data);
        throw new Error(data.detail || data.message || "모델 준비 실패");
      }

      if (isPrepareInProgress(phase)) {
        notStartedStreak = 0;
        const pct = typeof data.progress === "number" ? data.progress : -1;
        if (pct !== lastProgress) {
          lastProgress = pct;
          lastProgressAt = Date.now();
        } else if (Date.now() - lastProgressAt > 20 * 60 * 1000) {
          throw new Error(
            "진행률이 20분 이상 변하지 않습니다. 네트워크·디스크를 확인한 뒤 페이지를 새로고침하세요.",
          );
        }
        applyPrepareStatusToOverlay(data);
      } else if (phase === "not_started") {
        notStartedStreak += 1;
        if (!restartAttempted && notStartedStreak >= 3) {
          restartAttempted = true;
          notStartedStreak = 0;
          setSetupLoading(true, {
            title: "AI 환경 준비",
            step: "설치 재시작",
            message:
              "이전 설치가 중단된 것 같습니다(에이전트 재시작 등). GPU wheel 설치를 다시 시작합니다…",
            progress: 5,
          });
          const restarted = await kickPrepare(force);
          if (restarted) applyPrepareStatusToOverlay(restarted);
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        if (notStartedStreak >= 8) {
          if (wsConnected) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          throw new Error(
            "AI 환경 준비가 시작되지 않았습니다. 에이전트(uvicorn)가 실행 중인지 확인하고 페이지를 새로고침하세요.",
          );
        }
        setSetupLoading(true, {
          title: "AI 환경 준비",
          step: "연결 확인",
          message: "에이전트에 설치 작업을 요청하는 중…",
          progress: 0,
        });
      } else {
        applyPrepareStatusToOverlay(data);
      }

      await new Promise((r) => setTimeout(r, wsConnected ? 1000 : 500));
    }
  } finally {
    wsUnsub();
  }
}

async function refreshToolStatus() {
  try {
    const data = await getToolStatus();
    toolReady = !!data.model_ready;
    setModelReadySummary(toolReady);
    updateActionButtons();
    if (toolReady) {
      return true;
    }
    await prepareModel();
    return toolReady;
  } catch (err) {
    setSetupLoading(true, {
      title: "준비 실패",
      message: formatAgentConnectionError(err),
    });
    toolReady = false;
    setModelReadySummary(false);
    updateActionButtons();
    return false;
  }
}

async function pollSeparateStatus() {
  for (;;) {
    const res = await fetchAgent(`${getAgentOrigin()}/api/tools/vocal-remover/separate/status`, {
      method: "GET",
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`분리 상태 조회 실패: ${await parseApiError(res)}`);
    }
    const data = await res.json();

    applySeparationStatusToOverlay(data);

    if (data.phase === "ready") {
      return data;
    }
    if (data.phase === "failed") {
      throw new Error(data.message || "분리 작업 실패");
    }
    if (data.phase === "idle") {
      throw new Error("분리 작업이 시작되지 않았습니다.");
    }

    await new Promise((r) => setTimeout(r, 400));
  }
}

async function runSeparationForFile(audioPath) {
  if (!audioPath) return;
  if (!toolReady) {
    const ok = await refreshToolStatus();
    if (!ok) return;
  }

  syncSummaryFromDom();
  const format = outputFormatSelect?.value || "wav";
  const body = { audio_path: audioPath, format };
  const dv = deviceSelect?.value || "auto";
  if (dv && dv !== "auto") body.device = dv;

  separationBusy = true;
  lastDisplayedProgress = 0;
  await cleanupAgentWorkspace();
  clearDownloadResult();
  updateActionButtons();

  dualPlayer.prepareForSeparation(audioPath);
  setSeparationLoading(true, {
    title: "보컬·MR 분리",
    step: "분리 작업 시작",
    message: "Demucs AI가 MR·보컬 스템을 생성합니다.",
    progress: 3,
  });

  try {
    const startData = await requestAgent({
      method: "POST",
      path: "/api/tools/vocal-remover/separate",
      json: body,
      onProgress: (ev) => {
        if (ev.phase === "request") {
          setSeparationLoading(true, {
            title: "보컬·MR 분리",
            step: "에이전트에 요청 중",
            message: "Demucs 분리 작업을 시작합니다.",
            progress: 5,
          });
        }
      },
    });

    let data = startData;
    if (startData?.phase !== "ready" || !startData?.instrumental_path || !startData?.vocals_path) {
      data = await pollSeparateStatus();
    }

    const mrPath = data.result_path || data.instrumental_path;
    const vocalPath = data.vocals_path;
    if (!mrPath || !vocalPath) {
      throw new Error("MR·보컬 결과 경로가 응답에 없습니다.");
    }

    lastMrDownloadUrl = buildDownloadUrl(mrPath);
    lastVocalDownloadUrl = buildDownloadUrl(vocalPath);
    persistDownloadSession({
      mrUrl: lastMrDownloadUrl,
      vocalUrl: lastVocalDownloadUrl,
      format: outputFormatSelect?.value || "wav",
      source: audioPathInput?.value.trim() || "",
    });
    downloadReady = true;
    hadWorkspaceArtifacts = true;
    updateActionButtons();

    await dualPlayer.onSeparationComplete({
      instrumental_path: data.instrumental_path,
      vocals_path: data.vocals_path,
      original_path: data.original_path || audioPath,
      duration_sec: Number(data.duration_sec) || 0,
    });

    setSeparationLoading(false);
  } catch (err) {
    lastDisplayedProgress = 0;
    setSeparationLoading(true, {
      title: "분리 실패",
      step: "오류",
      message: formatAgentConnectionError(err),
      progress: 0,
    });
    setTimeout(() => setSeparationLoading(false), 4000);
  } finally {
    separationBusy = false;
    updateActionButtons();
  }
}

async function startAnalysis() {
  const audioPath = audioPathInput?.value.trim() || "";
  if (!audioPath) {
    setSeparationLoading(true, { message: "오디오 파일 경로를 입력하거나 찾아보기를 이용하세요." });
    setTimeout(() => setSeparationLoading(false), 2500);
    return;
  }
  await runSeparationForFile(audioPath);
}

let savedPickBtnLabel = "";

function setPickBusy(busy) {
  if (btnPickLocalFile) {
    if (busy) {
      savedPickBtnLabel = btnPickLocalFile.textContent || "찾아보기";
      btnPickLocalFile.disabled = true;
      btnPickLocalFile.textContent = "대화상자…";
    } else {
      btnPickLocalFile.disabled = separationBusy;
      btnPickLocalFile.textContent = savedPickBtnLabel || "찾아보기";
    }
  }
  dropZoneEl?.classList.toggle("is-picking", busy);
}

async function pickLocalFile() {
  if (separationBusy) {
    alert("이전 분리 작업이 진행 중입니다. 완료 후 다시 시도해 주세요.");
    return;
  }

  const agent = await checkAgentConnection();
  if (!agent.ok) {
    await showInstallAgentDialog(await installDialogOpts());
    return;
  }

  setPickBusy(true);
  const ctrl = new AbortController();
  const tid = window.setTimeout(() => ctrl.abort(), 10 * 60 * 1000);

  try {
    const req = async (path) =>
      fetchAgent(`${getAgentOrigin()}${path}`, {
        method: "POST",
        headers: { Accept: "application/json" },
        signal: ctrl.signal,
      });

    const res = await req("/api/agent/pick-local-audio-file");
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const d = data && typeof data === "object" ? data.detail : undefined;
      let msg =
        typeof d === "string"
          ? d
          : Array.isArray(d)
            ? d
                .map((x) => (x && typeof x === "object" && "msg" in x ? String(x.msg) : ""))
                .filter(Boolean)
                .join("; ")
            : res.statusText || "요청 실패";
      if (res.status === 503 && !/트레이/i.test(msg)) {
        msg += "\n\n작업 표시줄에서 ItMatZip Agent 트레이를 실행한 뒤 다시 시도하세요.";
      }
      if (res.status === 404) {
        msg += "\n\n에이전트를 최신 MSI로 재설치하거나 test-tray.ps1 로 트레이를 띄운 뒤 다시 시도하세요.";
      }
      if (res.status === 400 && (msg.includes("취소") || /cancel/i.test(msg))) return;
      alert(`파일 찾아보기 실패: ${msg}`);
      return;
    }

    const picked =
      (data && typeof data === "object" && (data.audio_path || data.video_path)) || "";
    if (typeof picked !== "string" || !picked.trim()) {
      alert("에이전트가 경로를 반환하지 않았습니다.");
      return;
    }

    if (hadWorkspaceArtifacts) await cleanupAgentWorkspace();
    clearDownloadResult();
    audioPathInput.value = picked.trim();
    applyDualPlayerFilePick(picked.trim());
    if (pathHint) {
      pathHint.textContent = "분석하기를 누르면 MR·보컬을 분리합니다.";
    }
    updateActionButtons();
  } catch (e) {
    const name = e && typeof e === "object" && "name" in e ? String(e.name) : "";
    if (name === "AbortError") {
      alert("파일 선택이 시간 초과되었습니다. 다시 시도해 주세요.");
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`파일 찾아보기 실패: ${formatAgentConnectionError(e) || msg}`);
    }
  } finally {
    window.clearTimeout(tid);
    setPickBusy(false);
  }
}

/**
 * @param {{ agentOk?: boolean, wheels?: object, binaries?: object }} ctx
 */
function setComputeCapabilityBadge(ctx) {
  const el = document.getElementById("compute-capability");
  if (!el) return;

  el.classList.remove("is-gpu", "is-cpu", "is-pending");

  if (ctx.agentOk === false) {
    el.classList.add("is-pending");
    el.textContent = "연산 장치 확인 불가";
    el.title = "에이전트에 연결되면 GPU/CPU 여부를 표시합니다.";
    return;
  }

  const w = ctx.wheels && typeof ctx.wheels === "object" ? ctx.wheels : null;
  const b = ctx.binaries && typeof ctx.binaries === "object" ? ctx.binaries : null;

  if (!w && !b) {
    el.classList.add("is-pending");
    el.textContent = "연산 장치 확인 중…";
    el.title = "";
    return;
  }

  const gpuDetected = Boolean(w && w.gpu_detected);
  const cudaReady = Boolean(b && b.cuda_available);
  const cudaMismatch = Boolean(w && w.cuda_torch_reinstall_needed);
  const cpuMismatch = Boolean(w && w.cpu_torch_reinstall_needed);
  const torchVer = w && w.torch_version ? String(w.torch_version) : "";

  if (cudaReady) {
    el.classList.add("is-gpu");
    el.textContent = "GPU · CUDA 사용 가능";
    el.title = `PyTorch ${torchVer} — Demucs 분리 시 GPU로 동작합니다.`;
    return;
  }

  if (gpuDetected && cudaMismatch) {
    el.classList.add("is-warn");
    el.textContent = "GPU · CUDA 미적용";
    el.title =
      `PyTorch ${torchVer} (CPU 빌드). Vocal Remover 준비를 다시 실행하면 GPU wheel로 교체됩니다.`;
    return;
  }

  if (!gpuDetected && cpuMismatch) {
    el.classList.add("is-warn");
    el.textContent = "CPU wheel 교체 필요";
    el.title =
      `PyTorch ${torchVer} (CUDA 빌드). GPU가 없어 준비를 실행하면 CPU wheel로 교체됩니다.`;
    return;
  }

  if (gpuDetected) {
    el.classList.add("is-gpu");
    el.textContent = "GPU 감지됨";
    el.title = "NVIDIA GPU가 있습니다. CUDA PyTorch 설치 후 GPU 분리가 가능합니다.";
    return;
  }

  el.classList.add("is-cpu");
  el.textContent = "CPU만 가능";
  el.title = "NVIDIA GPU가 감지되지 않았습니다. Demucs는 CPU wheel로 설치·실행됩니다.";
}

async function runTorchWheelFixupIfNeeded(w, b) {
  const needsCudaFix = Boolean(w?.cuda_torch_reinstall_needed && !b?.cuda_available);
  const needsCpuFix = Boolean(w?.cpu_torch_reinstall_needed);
  if (!needsCudaFix && !needsCpuFix) {
    return false;
  }
  const title = needsCpuFix ? "CPU PyTorch wheel 설치" : "GPU(CUDA) PyTorch 설치";
  try {
    const live = await fetchPrepareStatus().catch(() => null);
    if (live && isPrepareInProgress(live.phase)) {
      setSetupLoading(true, {
        title,
        step: live.step || "진행 중",
        message: live.detail || live.message || "PyTorch wheel 설치가 진행 중입니다.",
        progress: typeof live.progress === "number" ? live.progress : undefined,
      });
      await pollPrepareStatus({ force: true });
    } else {
      await prepareModel({ force: true });
    }
    return true;
  } catch (err) {
    setSetupLoading(true, {
      title: needsCpuFix ? "CPU wheel 설치 실패" : "CUDA 설치 실패",
      message: formatAgentConnectionError(err),
    });
    throw err;
  }
}

let _readinessCheckedOnce = false;

/** @param {boolean} [knownOk] */
async function checkVocalToolReadiness(knownOk) {
  const binEl = document.getElementById("bin-readiness");
  if (!binEl) return;

  if (knownOk === false) {
    setComputeCapabilityBadge({ agentOk: false });
    binEl.className = "bin-readiness is-warn";
    binEl.textContent = "에이전트 미연결 → FFmpeg · Demucs 점검 불가";
    return;
  }

  const agent = knownOk === true ? { ok: true } : await checkAgentConnection();
  if (!agent.ok) {
    setComputeCapabilityBadge({ agentOk: false });
    binEl.className = "bin-readiness is-warn";
    binEl.textContent = "에이전트 미연결 → FFmpeg · Demucs 점검 불가";
    return;
  }

  if (!toolReady) {
    binEl.className = "bin-readiness is-warn";
    binEl.textContent = "FFmpeg · Demucs · diffq 확인 중…";
    if (!_readinessCheckedOnce) {
      setSetupLoading(true, {
        title: "환경 확인",
        message: "FFmpeg·Demucs 설치 여부를 확인하고 있습니다…",
      });
    }
  }

  try {
    const data = await requestAgent({
      method: "GET",
      path: "/api/tools/vocal-remover/readiness",
      onProgress: (ev) => {
        if (ev.phase === "request") {
          binEl.textContent =
            "환경 설치·확인 중… (처음엔 FFmpeg·모델 다운로드로 시간이 걸릴 수 있음)";
        }
      },
    });
    _readinessCheckedOnce = true;
    const b = data && typeof data === "object" ? data.binaries : null;
    const w = data && typeof data === "object" ? data.wheels : null;
    setComputeCapabilityBadge({ agentOk: true, wheels: w, binaries: b });
    if (!b) {
      binEl.className = "bin-readiness is-err";
      binEl.textContent = "준비 상태 응답이 비정상입니다.";
      return;
    }

    const parts = [];
    if (b.ffmpeg && b.ffprobe) parts.push("FFmpeg");
    else parts.push("FFmpeg ✗");
    if (b.demucs) parts.push("Demucs");
    else parts.push("Demucs ✗");
    if (b.diffq) parts.push("diffq");
    else parts.push("diffq ✗");
    if (b.cuda_available) parts.push("CUDA");
    else if (w?.cuda_torch_reinstall_needed) parts.push("CUDA 재설치 필요");
    else if (w?.cpu_torch_reinstall_needed) parts.push("CPU wheel 교체 필요");

    const allCore = b.ffmpeg && b.ffprobe && b.demucs && b.diffq;
    const torchFixup =
      allCore &&
      w &&
      ((w.cuda_torch_reinstall_needed && !b.cuda_available) || w.cpu_torch_reinstall_needed);
    if (torchFixup) {
      try {
        await runTorchWheelFixupIfNeeded(w, b);
        await checkVocalToolReadiness(true);
      } catch {
        /* 오류 메시지는 runTorchWheelFixupIfNeeded에서 표시 */
      }
      return;
    }
    if (allCore && b.model_ready) {
      setSetupLoading(false);
      binEl.className = "bin-readiness is-ok";
      binEl.textContent = `${parts.join(" · ")} 준비됨`;
      toolReady = true;
      setModelReadySummary(true);
      updateActionButtons();
      return;
    }

    setSetupLoading(false);
    toolReady = false;
    setModelReadySummary(false);
    updateActionButtons();
    binEl.className = "bin-readiness is-warn";
    binEl.textContent = `${parts.join(" · ")} · 준비 필요 (분석하기를 누르면 설치 시작)`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setSetupLoading(false);
    setComputeCapabilityBadge({ agentOk: true });
    binEl.className = "bin-readiness is-err";
    binEl.textContent = `환경 준비 실패: ${msg}`;
    await showInstallAgentDialog({
      title: "Vocal Remover 환경을 준비하지 못했습니다",
      bodyHtml: `<p>에이전트 PC에서 FFmpeg 또는 Demucs 설치에 실패했을 수 있습니다.</p><p><code>${escHtml(msg)}</code></p>`,
      onPrimary: async () => {
        await checkVocalToolReadiness();
      },
    });
  }
}

btnPickLocalFile?.addEventListener("click", () => void pickLocalFile());
btnNewJob?.addEventListener("click", () => {
  if (separationBusy) {
    btnNewJob.disabled = true;
    return;
  }
  void resetEditorState({ cleanupWorkspace: true });
});

function syncNewJobButton() {
  if (btnNewJob) btnNewJob.disabled = separationBusy;
}
audioPathInput?.addEventListener("input", updateActionButtons);
audioPathInput?.addEventListener("change", updateActionButtons);
btnStartSeparation?.addEventListener("click", () => void startAnalysis());
exportLink?.addEventListener("click", (e) => {
  if (exportLink.classList.contains("is-disabled")) {
    e.preventDefault();
    return;
  }
  e.preventDefault();
  void navigateToDownloadPage(exportLink);
});
outputFormatSelect?.addEventListener("change", syncSummaryFromDom);
deviceSelect?.addEventListener("change", syncSummaryFromDom);

window.addEventListener("pageshow", (ev) => {
  if (ev.persisted && canDownloadFromSession()) {
    downloadReady = true;
    restoreDownloadUrlsFromSession();
  }
  resetExportLinkUi();
  updateActionButtons();
});

syncSummaryFromDom();
updateActionButtons();

let lastConnectionUiOk = /** @type {boolean | null} */ (null);

const connectionMonitor = startConnectionMonitor({
  intervalMs: 3000,
  immediate: true,
  onChange: (ok, detail) => {
    applyConnectionStatusDot(document.getElementById("connection-status"), ok, detail);
    const changed = lastConnectionUiOk !== ok;
    lastConnectionUiOk = ok;
    if (changed && !ok && hadWorkspaceArtifacts) {
      pendingWorkspaceCleanup = true;
      void resetEditorState({ cleanupWorkspace: false });
    }
    if (changed && ok && pendingWorkspaceCleanup) {
      pendingWorkspaceCleanup = false;
      void cleanupAgentWorkspace();
    }
    if (changed) void checkVocalToolReadiness(ok);
  },
  autoShowInstallDialog: true,
  installDialogOptions: installDialogOpts,
});

window.addEventListener("focus", () => void connectionMonitor.refresh());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void connectionMonitor.refresh();
});

const pathHint = document.getElementById("path-hint");

void showAdSense("editorAboveWorkspace", "#editor-ad-above-path");
void showAdSense("editorBelowExport", "#editor-ad-below-export");

void (async () => {
  const agent = await checkAgentConnection();
  if (!agent.ok) {
    await showInstallAgentDialog(await installDialogOpts());
    return;
  }
  await checkVocalToolReadiness(true);
})();
