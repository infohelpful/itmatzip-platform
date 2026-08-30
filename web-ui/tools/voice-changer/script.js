import {
  applyConnectionStatusDot,
  checkAgentConnection,
  configureBridge,
  formatAgentConnectionError,
  getAgentOrigin,
  primeLocalNetworkAccess,
  requestAgent,
  showInstallAgentDialog,
  setAgentLongOperationActive,
  startConnectionMonitor,
} from "../common/bridge.js?v=lna23";
import { AGENT_PICK_AUDIO } from "../common/agent-pick-endpoints.js";
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

const API = "/api/tools/voice-changer";

const SS = {
  output: "voice-changer:dl-output-path",
  sourceName: "voice-changer:dl-source-name",
  format: "voice-changer:output-format",
  returnFromDl: "voice-changer:return-from-dl",
};

const els = {
  sourcePath: document.getElementById("source-path"),
  referencePath: document.getElementById("reference-path"),
  pickSource: document.getElementById("btn-pick-source"),
  pickReference: document.getElementById("btn-pick-reference"),
  newJob: document.getElementById("btn-new-job"),
  prepare: document.getElementById("btn-prepare"),
  start: document.getElementById("btn-start-convert"),
  exportLink: document.getElementById("export-link"),
  format: document.getElementById("output-format"),
  device: document.getElementById("device-select"),
  steps: document.getElementById("diffusion-steps"),
  f0: document.getElementById("f0-condition"),
  shell: document.getElementById("voice-editor-shell"),
  connection: document.getElementById("connection-status"),
  compute: document.getElementById("compute-capability"),
  readiness: document.getElementById("bin-readiness"),
  summaryReady: document.getElementById("summary-model-ready"),
  summaryDevice: document.getElementById("summary-device"),
  summaryFormat: document.getElementById("summary-format"),
  sourceLabel: document.getElementById("source-file-label"),
  referenceLabel: document.getElementById("reference-file-label"),
  resultLabel: document.getElementById("result-file-label"),
  sourceAudio: document.getElementById("source-audio"),
  referenceAudio: document.getElementById("reference-audio"),
  resultAudio: document.getElementById("result-audio"),
  setupOverlay: document.getElementById("setup-loading"),
  setupStep: document.getElementById("setup-loading-step"),
  setupMessage: document.getElementById("setup-loading-message"),
  setupBar: document.getElementById("setup-loading-bar"),
  setupTrack: document.getElementById("setup-loading-track"),
  convertOverlay: document.getElementById("convert-loading"),
  convertStep: document.getElementById("convert-loading-step"),
  convertMessage: document.getElementById("convert-loading-message"),
  convertPercent: document.getElementById("convert-loading-percent"),
  convertBar: document.getElementById("convert-loading-bar"),
  convertTrack: document.getElementById("convert-loading-track"),
};

let toolReady = false;
let agentOk = false;
let sourcePath = "";
let referencePath = "";
let outputPath = "";

function fileName(path) {
  return String(path || "").split(/[\\/]/).pop() || "";
}

function applyPendingHeaderI18n() {
  if (els.compute && els.compute.classList.contains("is-pending")) {
    els.compute.textContent = window.itzT("ui.checking", "확인 중…");
  }
  if (els.connection && /확인|Checking|確認|检查/.test(els.connection.textContent || "")) {
    els.connection.textContent = window.itzT("conn.checking", "에이전트 연결 확인 중…");
  }
  if (!lastReadinessData) {
    if (els.readiness) els.readiness.textContent = window.itzT("waitPrep", "Voice Changer · 환경 준비 대기");
    if (els.summaryReady) els.summaryReady.textContent = window.itzT("ui.checkingShort", "확인 중");
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
      device === "cuda" ? "CUDA" : device === "cpu" ? "CPU" : window.itzT("ui.auto", "자동");
  }
  if (els.summaryFormat) {
    els.summaryFormat.textContent = (els.format?.value || "wav").toUpperCase();
  }
}

function updateConvertButton() {
  if (!els.start) return;
  els.start.disabled = !sourcePath || !referencePath;
}

function syncShellBusy() {
  const busy =
    Boolean(els.setupOverlay && !els.setupOverlay.hidden) ||
    Boolean(els.convertOverlay && !els.convertOverlay.hidden);
  els.shell?.classList.toggle("is-busy", busy);
}

function setBusy(kind, active, pct = 0, step = "", message = "") {
  const overlay = kind === "setup" ? els.setupOverlay : els.convertOverlay;
  const stepEl = kind === "setup" ? els.setupStep : els.convertStep;
  const msgEl = kind === "setup" ? els.setupMessage : els.convertMessage;
  const bar = kind === "setup" ? els.setupBar : els.convertBar;
  const track = kind === "setup" ? els.setupTrack : els.convertTrack;
  const percent = kind === "convert" ? els.convertPercent : null;

  if (!overlay) return;
  if (active) {
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");
  } else {
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
  }
  const agentText = typeof window.itzAgentText === "function" ? window.itzAgentText : (v) => v || "";
  if (stepEl) stepEl.textContent = agentText(step) || "";
  if (msgEl) msgEl.textContent = agentText(message) || (active ? window.itzT("ui.processing", "처리 중…") : "");
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  if (bar) bar.style.width = `${clamped}%`;
  if (track) track.setAttribute("aria-valuenow", String(Math.round(clamped)));
  if (percent) percent.textContent = `${Math.round(clamped)}%`;
  syncShellBusy();
}

function buildMediaUrl(filePath) {
  return `${getAgentOrigin()}${API}/download?file_path=${encodeURIComponent(filePath)}`;
}

function setLocalAudio(audioEl, path, labelEl) {
  if (labelEl) labelEl.textContent = path ? fileName(path) : window.itzT("waiting", "선택 대기");
  if (!audioEl) return;
  if (!path) {
    audioEl.removeAttribute("src");
    audioEl.load();
    return;
  }
  // 브라우저는 file:// 로컬 경로 로드를 차단함 → 에이전트 download로 스트리밍
  audioEl.src = buildMediaUrl(path);
  audioEl.load();
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
  const source = Boolean(data?.binaries?.source_ready);
  const model = Boolean(data?.binaries?.model_ready);
  const ffmpeg = Boolean(data?.binaries?.ffmpeg);
  toolReady = torch && pip && source && model;
  if (els.readiness) {
    els.readiness.classList.remove("is-ok", "is-warn", "is-err");
    if (toolReady) {
      els.readiness.classList.add("is-ok");
      els.readiness.textContent = window.itzT("readyOk", "Voice Changer · 준비 완료");
    } else if (!ffmpeg) {
      els.readiness.classList.add("is-warn");
      els.readiness.textContent = window.itzT("needFfmpeg", "Voice Changer · FFmpeg 필요");
    } else if (!source || !torch || !pip) {
      els.readiness.classList.add("is-warn");
      els.readiness.textContent = window.itzT("needEnv", "Voice Changer · 환경 준비 필요");
    } else {
      els.readiness.classList.add("is-warn");
      els.readiness.textContent = window.itzT("needModel", "Voice Changer · 모델 다운로드 필요");
    }
  }
  if (els.summaryReady) {
    els.summaryReady.textContent = toolReady
      ? window.itzT("ui.readyOk", "준비됨")
      : window.itzT("ui.notReady", "미준비");
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
    setBusy("setup", true, 5, window.itzT("installStart", "설치 시작"), window.itzT("prepSeed", "Seed-VC 환경을 준비합니다…"));
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

async function pollConvertStatus() {
  for (;;) {
    const status = await requestAgent({ method: "GET", path: `${API}/convert/status` });
    const pct = Number(status?.progress || 0);
    const phase = String(status?.phase || "");
    const step =
      phase === "running" ? window.itzT("ui.phaseRun", "처리 중") : phase === "ready" ? window.itzT("ui.phaseDone", "완료") : phase === "failed" ? window.itzT("ui.phaseFail", "실패") : "";
    setBusy("convert", true, pct, step, status?.message || "");
    if (status?.phase === "ready") return status;
    if (status?.phase === "failed") {
      throw new Error(status?.message || "변환 실패");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function cleanupWorkspace() {
  try {
    await requestAgent({ method: "POST", path: `${API}/workspace/cleanup` });
  } catch {
    /* ignore */
  }
}

async function pickAudio(kind) {
  await primeLocalNetworkAccess();
  const data = await requestAgent({
    method: "POST",
    path: AGENT_PICK_AUDIO,
  });
  const path = String(data?.audio_path || data?.path || data?.video_path || "").trim();
  if (!path) throw new Error(window.itzT("noAudio", "오디오를 선택하지 않았습니다."));
  if (kind === "source") {
    sourcePath = path;
    if (els.sourcePath) els.sourcePath.value = path;
    setLocalAudio(els.sourceAudio, path, els.sourceLabel);
  } else {
    referencePath = path;
    if (els.referencePath) els.referencePath.value = path;
    setLocalAudio(els.referenceAudio, path, els.referenceLabel);
  }
  outputPath = "";
  setExportEnabled(false);
  setLocalAudio(els.resultAudio, "", els.resultLabel);
  if (els.resultLabel) els.resultLabel.textContent = window.itzT("resultWait", "변환 대기");
  updateConvertButton();
}

function persistDownloadSession() {
  if (!outputPath) return;
  sessionStorage.setItem(SS.output, outputPath);
  sessionStorage.setItem(
    SS.sourceName,
    (fileName(sourcePath) || "voice").replace(/\.[^.]+$/, "") + "-vc",
  );
  sessionStorage.setItem(SS.format, (els.format?.value || "wav").toUpperCase());
}

async function runConvert() {
  if (!sourcePath || !referencePath) {
    alert(window.itzT("needBoth", "소스와 레퍼런스 오디오를 모두 선택하세요."));
    return;
  }
  if (!agentOk) {
    await showInstallAgentDialog(agentInstallDialogOptions());
    return;
  }
  if (!toolReady) {
    const go = confirm(window.itzT("confirmPrep", "환경이 준비되지 않았습니다. 지금 환경 준비를 실행할까요?"));
    if (!go) return;
    await prepareModel();
    if (!toolReady) {
      alert(window.itzT("needPrep", "환경 준비가 완료되지 않았습니다."));
      return;
    }
  }

  setAgentLongOperationActive(true);
  try {
    setBusy("convert", true, 5, window.itzT("convertStart", "변환 시작"), window.itzT("convertMsg", "Seed-VC로 목소리를 변환합니다…"));
    const body = {
      source_path: sourcePath,
      reference_path: referencePath,
      format: els.format?.value || "wav",
      diffusion_steps: Number(els.steps?.value || 25),
      f0_condition: Boolean(els.f0?.checked),
    };
    const device = els.device?.value || "auto";
    if (device !== "auto") body.device = device;

    await requestAgent({
      method: "POST",
      path: `${API}/convert`,
      json: body,
    });
    const status = await pollConvertStatus();
    outputPath = String(status?.output_path || "").trim();
    if (!outputPath) throw new Error(window.itzT("noOutput", "결과 경로를 받지 못했습니다."));
    setExportEnabled(true);
    persistDownloadSession();
    if (els.resultLabel) els.resultLabel.textContent = fileName(outputPath);
    // 에이전트 download URL 로 미리듣기
    if (els.resultAudio) {
      els.resultAudio.src = buildMediaUrl(outputPath);
      els.resultAudio.load();
    }
  } finally {
    setBusy("convert", false);
    setAgentLongOperationActive(false);
  }
}

async function resetJob() {
  sourcePath = "";
  referencePath = "";
  outputPath = "";
  if (els.sourcePath) els.sourcePath.value = "";
  if (els.referencePath) els.referencePath.value = "";
  setLocalAudio(els.sourceAudio, "", els.sourceLabel);
  setLocalAudio(els.referenceAudio, "", els.referenceLabel);
  setLocalAudio(els.resultAudio, "", els.resultLabel);
  if (els.resultLabel) els.resultLabel.textContent = window.itzT("resultWait", "변환 대기");
  setExportEnabled(false);
  updateConvertButton();
  await cleanupWorkspace();
}

els.pickSource?.addEventListener("click", async () => {
  try {
    await pickAudio("source");
  } catch (err) {
    alert(String(err?.message || err));
  }
});

els.pickReference?.addEventListener("click", async () => {
  try {
    await pickAudio("reference");
  } catch (err) {
    alert(String(err?.message || err));
  }
});

els.newJob?.addEventListener("click", () => {
  void resetJob();
});

els.prepare?.addEventListener("click", async () => {
  if (!agentOk) {
    await showInstallAgentDialog(agentInstallDialogOptions());
    return;
  }
  try {
    await prepareModel({ force: true });
  } catch (err) {
    alert(String(err?.message || err));
  }
});

els.start?.addEventListener("click", async () => {
  try {
    await runConvert();
  } catch (err) {
    alert(String(err?.message || err));
  }
});

els.exportLink?.addEventListener("click", (ev) => {
  if (els.exportLink?.classList.contains("is-disabled")) {
    ev.preventDefault();
    return;
  }
  persistDownloadSession();
});

els.format?.addEventListener("change", updateSummary);
els.device?.addEventListener("change", updateSummary);

els.sourcePath?.addEventListener("change", () => {
  sourcePath = els.sourcePath.value.trim();
  setLocalAudio(els.sourceAudio, sourcePath, els.sourceLabel);
  updateConvertButton();
});

els.referencePath?.addEventListener("change", () => {
  referencePath = els.referencePath.value.trim();
  setLocalAudio(els.referenceAudio, referencePath, els.referenceLabel);
  updateConvertButton();
});

document.addEventListener("itz:lang-change", () => {
  updateSummary();
  applyPendingHeaderI18n();
  if (lastReadinessData) {
    setComputeCapabilityBadge(lastReadinessData);
    updateBinReadiness(lastReadinessData);
  }
  if (!sourcePath && els.sourceLabel) els.sourceLabel.textContent = window.itzT("waiting", "선택 대기");
  if (!referencePath && els.referenceLabel) els.referenceLabel.textContent = window.itzT("waiting", "선택 대기");
  if (!outputPath && els.resultLabel) els.resultLabel.textContent = window.itzT("resultWait", "변환 대기");
});

async function boot() {
  applyPendingHeaderI18n();
  updateSummary();
  updateConvertButton();
  setExportEnabled(false);
  void showAdSense("editorAboveWorkspace", "#editor-ad-above-path");
  void showAdSense("editorBelowExport", "#editor-ad-below-export");

  startConnectionMonitor({
    onStatus: (detail) => {
      agentOk = Boolean(detail?.ok);
      applyConnectionStatusDot(els.connection, detail);
      if (!agentOk && detail?.error) {
        els.connection.title = formatAgentConnectionError(detail.error);
      }
    },
  });

  try {
    await primeLocalNetworkAccess();
    const connected = await checkAgentConnection();
    agentOk = Boolean(connected?.ok);
    applyConnectionStatusDot(els.connection, connected);
    if (agentOk) {
      await checkReadiness();
      await resumeRunningPrepare();
      if (sessionStorage.getItem(SS.returnFromDl) === "1") {
        sessionStorage.removeItem(SS.returnFromDl);
      }
    }
  } catch (err) {
    console.warn(err);
  }
}

void boot();
