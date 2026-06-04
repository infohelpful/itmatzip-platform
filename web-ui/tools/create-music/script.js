/**
 * Create-Music — ACE-Step 1.5 AI 음악 생성 UI
 */
import * as Bridge from "../common/bridge.js?v=lna15";
import { showAdSense } from "../common/adsense.js";
import { agentInstallDialogOptions } from "../common/agent-install-ui.js?v=lna19";
import { createMusicWaveformPlayer } from "./waveform-player.js";
import { initMusicComposeEditor } from "./music-compose.js?v=10";

Bridge.configureBridge();

const musicCompose = initMusicComposeEditor(document.getElementById("music-compose-root"));

function installDialogOpts() {
  return agentInstallDialogOptions(async () => {
    const detail = await Bridge.checkAgentConnection();
    if (detail.ok) {
      connected = true;
      Bridge.applyConnectionStatusDot($connectionStatus, true, detail);
      void ensureEnvironmentOnConnect();
    }
    return detail;
  });
}

const DOWNLOAD_PAGE = "download.html";
const STORAGE_JOB_ID = "create-music:job-id";
const STORAGE_FILENAME = "create-music:filename";
const STORAGE_SOURCE = "create-music:source-name";
const STORAGE_MP3_URL = "create-music:mp3-download-url";
const STORAGE_WAV_URL = "create-music:wav-download-url";
const $connectionStatus = document.getElementById("connection-status");
const $computeCap = document.getElementById("compute-capability");
const $binReadiness = document.getElementById("bin-readiness");

const $taskType = document.getElementById("task-type");
const $vocalLang = document.getElementById("vocal-lang");
const $duration = document.getElementById("duration");
const $audioFormat = document.getElementById("audio-format");
const $batchSize = document.getElementById("batch-size");

const $ditModel = document.getElementById("dit-model");
const $lmModel = document.getElementById("lm-model");
const $inferenceSteps = document.getElementById("inference-steps");
const $guidanceScale = document.getElementById("guidance-scale");
const $shift = document.getElementById("shift");
const $seed = document.getElementById("seed");
const $inferMethod = document.getElementById("infer-method");
const $loraSelect = document.getElementById("lora-select");

const $remixSection = document.getElementById("remix-section");
const $btnSrcAudio = document.getElementById("btn-src-audio");
const $srcAudioName = document.getElementById("src-audio-name");
const $btnRefAudio = document.getElementById("btn-ref-audio");
const $refAudioName = document.getElementById("ref-audio-name");
const $btnVocalRef = document.getElementById("btn-vocal-ref");
const $btnVocalRefClear = document.getElementById("btn-vocal-ref-clear");
const $vocalRefName = document.getElementById("vocal-ref-name");
const $vocalRefStrengthRow = document.getElementById("vocal-ref-strength-row");
const $vocalRefStrength = document.getElementById("vocal-ref-strength");
const $vocalRefStrengthVal = document.getElementById("vocal-ref-strength-val");

const $btnGenerate = document.getElementById("btn-generate");
const $btnPrepare = document.getElementById("btn-prepare");
const $downloadSection = document.getElementById("download-section");
const $btnDownloadMp3 = document.getElementById("btn-download-mp3");

const $loraName = document.getElementById("lora-name");
const $loraSteps = document.getElementById("lora-steps");
const $loraLr = document.getElementById("lora-lr");
const $loraRank = document.getElementById("lora-rank");
const $btnTrainLora = document.getElementById("btn-train-lora");
const $loraProgressArea = document.getElementById("lora-progress-area");
const $loraProgressBar = document.getElementById("lora-progress-bar");
const $loraProgressMsg = document.getElementById("lora-progress-msg");

const $historyList = document.getElementById("history-list");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let connected = false;
let allReady = false;
let autoPrepareStarted = false;
let preparePollTimer = null;
let srcAudioPath = null;
let refAudioPath = null;
let generationPollTimer = null;
let loraPollTimer = null;

const musicPlayer = createMusicWaveformPlayer({
  getAgentOrigin: () => Bridge.getAgentOrigin(),
});

function setMp3DownloadLabel(text) {
  const label = $btnDownloadMp3?.querySelector(".btn-label");
  if (label) label.textContent = text;
  else if ($btnDownloadMp3) $btnDownloadMp3.textContent = text;
}

function setDownloadEnabled(on) {
  if (!$btnDownloadMp3) return;
  $btnDownloadMp3.disabled = !on;
  if (!on) setMp3DownloadLabel("MP3 다운로드");
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");

    if (btn.dataset.tab === "history") loadHistory();
  });
});

// ---------------------------------------------------------------------------
// Connection monitor (Silence Detector / Vocal Remover와 동일)
// ---------------------------------------------------------------------------
function setComputeCapabilityBadge(ctx) {
  if (!$computeCap) return;
  $computeCap.classList.remove("is-gpu", "is-cpu", "is-pending", "is-warn");

  if (ctx.agentOk === false) {
    $computeCap.classList.add("is-pending");
    $computeCap.textContent = "연산 장치 확인 불가";
    $computeCap.title = "에이전트에 연결되면 GPU/CPU 여부를 표시합니다.";
    return;
  }

  const gpu = ctx.gpu;
  if (!gpu) {
    $computeCap.classList.add("is-pending");
    $computeCap.textContent = "연산 장치 확인 중…";
    $computeCap.title = "";
    return;
  }

  const rt = ctx.runtime || {};
  if (!rt.acestep_root_ok && rt.acestep_root_error) {
    $computeCap.classList.add("is-warn");
    $computeCap.textContent = "ACE-Step 소스 미설치";
    $computeCap.title = rt.acestep_root_error;
    return;
  }

  if (gpu.available) {
    $computeCap.classList.add("is-gpu");
    const tierLabel = gpu.tier_label || gpu.tier || "";
    const vramGb =
      gpu.vram_gb != null
        ? `${Number(gpu.vram_gb).toFixed(1)} GB`
        : gpu.vram_mb
          ? `${Math.round(gpu.vram_mb / 1024)} GB`
          : "";
    $computeCap.textContent = tierLabel
      ? vramGb
        ? `GPU · ${tierLabel} · ${vramGb}`
        : `GPU · ${tierLabel}`
      : vramGb
        ? `GPU · ${vramGb}`
        : "GPU 사용 가능";
    let title = gpu.docs || "";
    if (rt.nano_vllm_ready) {
      title = [title, `LM: ${rt.lm_backend || "vllm"} (nano-vllm)`].filter(Boolean).join("\n");
    } else if (gpu.lm_note) {
      title = [title, gpu.lm_note].filter(Boolean).join("\n");
    }
    $computeCap.title = title;
    return;
  }

  $computeCap.classList.add("is-cpu");
  $computeCap.textContent = gpu.tier_label || "CPU 전용";
  $computeCap.title = "NVIDIA GPU가 감지되지 않았습니다. CPU 오프로드로 동작할 수 있습니다.";
}

function updateBinReadiness(agentOk, data) {
  if (!$binReadiness) return;

  if (!agentOk) {
    $binReadiness.className = "bin-readiness is-warn";
    $binReadiness.textContent = "에이전트 미연결 → ACE-Step · FFmpeg 점검 불가";
    return;
  }

  if (!data) {
    $binReadiness.className = "bin-readiness is-warn";
    $binReadiness.textContent = "Create Music · 환경 확인 중…";
    return;
  }

  const d = data.dependencies || {};
  const labels = [
    ["acestep_source", "ACE-Step"],
    ["python312", "Py3.12"],
    ["pytorch", "PyTorch"],
    ["acestep_venv", "venv"],
    ["acestep_models", "모델"],
  ];
  const parts = labels.map(([key, label]) => (d[key] ? label : `${label} ✗`));

  if (data.all_ready) {
    $binReadiness.className = "bin-readiness is-ok";
    $binReadiness.textContent = "ACE-Step · venv · 모델 · FFmpeg(MP3) 준비됨";
    return;
  }

  $binReadiness.className = "bin-readiness is-warn";
  $binReadiness.textContent = `${parts.join(" · ")} · 환경 준비 필요`;
}

const connectionMonitor = Bridge.startConnectionMonitor({
  intervalMs: 12_000,
  immediate: true,
  autoShowInstallDialog: true,
  installDialogOptions: installDialogOpts,
  onChange(ok, detail) {
    const busy = Bridge.isAgentLongOperationActive() || detail?.longOp;
    connected = ok || busy;
    Bridge.applyConnectionStatusDot($connectionStatus, ok || busy, detail);
    if (ok || busy) {
      if (ok) void ensureEnvironmentOnConnect();
      return;
    }
    setComputeCapabilityBadge({ agentOk: false });
    updateBinReadiness(false, null);
    allReady = false;
    $btnGenerate.disabled = true;
    $btnTrainLora.disabled = true;
  },
});

window.addEventListener("focus", () => void connectionMonitor.refresh());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void connectionMonitor.refresh();
});

// ---------------------------------------------------------------------------
// Readiness (접속 시 자동 확인 — 환경 준비 버튼 수동 클릭 불필요)
// ---------------------------------------------------------------------------
function applyReadinessData(data) {
  const rt = data.runtime || {};
  window.__createMusicRuntime = rt;
  setComputeCapabilityBadge({ agentOk: true, gpu: data.gpu, runtime: rt });
  updateBinReadiness(true, data);
  applyGpuTierLimits(data.gpu);

  allReady = Boolean(data.all_ready);
  $btnGenerate.disabled = !allReady;
  $btnTrainLora.disabled = true;

  if (!allReady) {
    const parts = [];
    if (!data.dependencies?.acestep_source) parts.push("ACE-Step 소스");
    if (!data.dependencies?.python312) parts.push("Python 3.12");
    if (!data.dependencies?.pytorch) parts.push("PyTorch");
    if (!data.dependencies?.acestep_venv) parts.push("가상환경");
    if (!data.dependencies?.acestep_models) parts.push("모델");
    $btnPrepare.textContent = parts.length
      ? `환경 준비 (${parts.join(", ")})`
      : "환경 준비";
    $btnPrepare.disabled = false;
  } else {
    $btnPrepare.textContent = "환경 재확인";
    $btnPrepare.disabled = false;
  }

  if (data.lora_list && data.lora_list.length > 0) {
    $loraSelect.innerHTML = '<option value="">사용 안 함</option>';
    data.lora_list.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      $loraSelect.appendChild(opt);
    });
  }
}

async function checkReadiness({ full = false } = {}) {
  if (!connected) {
    setComputeCapabilityBadge({ agentOk: false });
    updateBinReadiness(false, null);
    return false;
  }

  try {
    const origin = Bridge.getAgentOrigin();
    const q = full ? "" : "?quick=1";
    const res = await Bridge.fetchAgent(`${origin}/api/tools/create-music/readiness${q}`);
    if (!res.ok) {
      updateBinReadiness(true, null);
      return false;
    }
    const data = await res.json();
    applyReadinessData(data);
    return data.all_ready;
  } catch {
    updateBinReadiness(connected, null);
    return false;
  }
}

async function runAutoPrepare() {
  if (!connected || allReady || autoPrepareStarted) return;
  autoPrepareStarted = true;

  try {
    const origin = Bridge.getAgentOrigin();
    const res = await Bridge.fetchAgent(`${origin}/api/tools/create-music/prepare`, {
      method: "POST",
    });
    if (!res.ok) {
      autoPrepareStarted = false;
      return;
    }
    const data = await res.json();
    if (data.phase === "done") {
      await checkReadiness({ full: false });
      autoPrepareStarted = false;
      return;
    }

    if ($binReadiness) {
      $binReadiness.className = "bin-readiness is-warn";
      $binReadiness.textContent = "환경 준비 중… (처음 설치 시 수 분~수십 분)";
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

// ---------------------------------------------------------------------------
// GPU tier limits (ACE-Step GPU_COMPATIBILITY.md)
// ---------------------------------------------------------------------------
function getActivePresetKey() {
  const active = document.querySelector(".preset-btn.active");
  return active?.dataset.preset || "speed";
}

function applyGpuTierLimits(gpu) {
  if (!gpu) return;

  const presetKey = getActivePresetKey();

  const limits = gpu.limits || {};
  const maxDur = Math.max(
    limits.max_duration_without_lm_sec || 600,
    limits.max_duration_with_lm_sec || 480,
  );
  $duration.max = String(maxDur);
  if (Number($duration.value) > maxDur) $duration.value = String(maxDur);

  const maxBatch = Math.max(
    limits.max_batch_without_lm || 1,
    limits.max_batch_with_lm || 1,
  );
  $batchSize.max = String(maxBatch);
  if (Number($batchSize.value) > maxBatch) $batchSize.value = String(maxBatch);

  const allowedDit = new Set(gpu.available_dit_models || []);
  Array.from($ditModel.options).forEach((opt) => {
    const ok = allowedDit.size === 0 || allowedDit.has(opt.value);
    opt.disabled = !ok;
    opt.hidden = !ok;
  });

  const allowedLm = new Set(["none", "auto", ...(gpu.available_lm_models || [])]);
  Array.from($lmModel.options).forEach((opt) => {
    if (opt.value === "auto") {
      opt.disabled = false;
      return;
    }
    const ok = allowedLm.has(opt.value);
    opt.disabled = !ok;
    if (!ok && opt.value !== "auto") opt.title = "현재 GPU VRAM 티어에서 사용 불가";
  });

  const rt = window.__createMusicRuntime || {};
  if (rt.nano_vllm_ready) {
    $lmModel.title = `LM 백엔드: ${rt.lm_backend || "vllm"} (nano-vllm 설치됨)`;
  } else if (gpu.lm_note) {
    $lmModel.title = gpu.lm_note;
  }

  if (presetKey !== "custom" && PRESETS[presetKey]) {
    applyPresetValues(PRESETS[presetKey], { allowedDit, allowedLm });
    return;
  }

  if (allowedDit.size > 0 && !allowedDit.has($ditModel.value)) {
    const fb = [...allowedDit].find((k) => k === "sft") || [...allowedDit][0] || "turbo";
    $ditModel.value = fb;
  }
  if (!allowedLm.has($lmModel.value)) {
    $lmModel.value = allowedLm.has("1.7B") ? "1.7B" : allowedLm.has("auto") ? "auto" : "none";
  }
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
const PRESETS = {
  speed: {
    dit_model: "turbo",
    lm_model: "1.7B",
    inference_steps: 8,
    guidance_scale: 3.5,
    shift: 3.0,
    seed: -1,
    infer_method: "ode",
    tooltip:
      "🚀 스피드 초안 (속도 최우선, 테스트용) — 터보 모델은 수치를 낮춰야 돌아갑니다. DiT: Turbo · LM: 1.7B · 스텝 8 (10 넘기지 마세요) · CFG 3.5 (4.0 이상 절대 금지) · 시프트 3.0",
  },
  quality: {
    dit_model: "sft",
    lm_model: "1.7B",
    inference_steps: 25,
    guidance_scale: 6.5,
    shift: 4.0,
    seed: -1,
    infer_method: "ode",
    tooltip:
      "✨ 고품질 마스터링 (음질 최상, 정석 세팅) — DiT: SFT (터보에서 이걸로 무조건 바꾸세요) · LM: 1.7B · 스텝 25 · CFG 6.5 · 시프트 4.0",
  },
  creative: {
    dit_model: "sft",
    lm_model: "1.7B",
    inference_steps: 15,
    guidance_scale: 3.0,
    shift: 3.0,
    seed: -1,
    infer_method: "sde",
    tooltip:
      "🎲 크리에이티브 (AI가 맘대로 독특하게 변주) — DiT: SFT · LM: 1.7B · 스텝 15 · CFG 3.0 · 시프트 3.0",
  },
  strict: {
    dit_model: "sft",
    lm_model: "1.7B",
    inference_steps: 30,
    guidance_scale: 8.5,
    shift: 3.0,
    seed: -1,
    infer_method: "ode",
    tooltip:
      "🎯 가사/스타일 집중 (가사 절대 안 씹히게) — 가사 똑바로 부르게 하려면 반드시 SFT. DiT: SFT · LM: 1.7B · 스텝 30 · CFG 8.5 · 시프트 3.0",
  },
  custom: {
    tooltip: "모든 옵션을 직접 설정할 수 있습니다. 자유롭게 조합하세요.",
  },
};

function applyPresetValues(preset, { allowedDit, allowedLm } = {}) {
  if (!preset?.dit_model) return;

  const ditOk = !allowedDit || allowedDit.size === 0 || allowedDit.has(preset.dit_model);
  const lmOk = !allowedLm || allowedLm.has(preset.lm_model);

  if (ditOk) $ditModel.value = preset.dit_model;
  if (lmOk) $lmModel.value = preset.lm_model;
  if (preset.inference_steps != null) $inferenceSteps.value = preset.inference_steps;
  if (preset.guidance_scale != null) $guidanceScale.value = preset.guidance_scale;
  if (preset.shift != null) $shift.value = preset.shift;
  if (preset.seed != null) $seed.value = preset.seed;
  if (preset.infer_method) $inferMethod.value = preset.infer_method;
}

const $presetTooltip = document.getElementById("preset-tooltip");
const advancedInputs = [$ditModel, $lmModel, $inferenceSteps, $guidanceScale, $shift, $seed, $inferMethod, $loraSelect];

function setAdvancedFieldsDisabled(disabled) {
  advancedInputs.forEach((el) => { el.disabled = disabled; });
}

function applyPreset(key) {
  document.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));
  document.querySelector(`.preset-btn[data-preset="${key}"]`)?.classList.add("active");

  const preset = PRESETS[key];
  if (!preset) return;

  $presetTooltip.textContent = preset.tooltip;

  if (key === "custom") {
    setAdvancedFieldsDisabled(false);
    return;
  }

  setAdvancedFieldsDisabled(true);
  applyPresetValues(preset);
}

// 초기 상태: 스피드 초안 프리셋 적용 + 필드 비활성화
applyPreset("speed");

document.querySelectorAll(".preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
});

// ---------------------------------------------------------------------------
// Task type change (show/hide remix section)
// ---------------------------------------------------------------------------
$taskType.addEventListener("change", () => {
  const isRemix = ["remix", "repaint", "cover", "lego"].includes($taskType.value);
  $remixSection.classList.toggle("hidden", !isRemix);
});

// ---------------------------------------------------------------------------
// Audio file picking (via agent file dialog)
// ---------------------------------------------------------------------------
async function pickAudioFile() {
  const agent = await Bridge.checkAgentConnection();
  if (!agent.ok) {
    await Bridge.showInstallAgentDialog(await installDialogOpts());
    return null;
  }
  const origin = Bridge.getAgentOrigin();
  try {
    const res = await Bridge.fetchAgent(`${origin}/api/agent/pick-local-audio-file`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = typeof data?.detail === "string" ? data.detail : res.statusText || "요청 실패";
      if (res.status === 400 && (detail.includes("취소") || /cancel/i.test(detail))) return null;
      alert(`파일 선택 실패: ${detail}`);
      return null;
    }
    const path = String(data.audio_path || data.video_path || data.path || "").trim();
    if (!path) return null;
    return path;
  } catch (e) {
    alert(`파일 선택 실패: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function syncVocalRefUi() {
  const hasRef = Boolean(refAudioPath);
  const fileName = hasRef ? refAudioPath.split(/[\\/]/).pop() : "";
  if ($vocalRefName) {
    $vocalRefName.textContent = fileName;
    $vocalRefName.classList.toggle("is-set", hasRef);
  }
  if ($refAudioName && hasRef) {
    $refAudioName.textContent = fileName;
  }
  $vocalRefStrengthRow?.classList.toggle("is-hidden", !hasRef);
  document.getElementById("vocal-ref-row")?.classList.toggle("has-ref", hasRef);
}

function setReferenceAudioPath(path) {
  refAudioPath = path || null;
  syncVocalRefUi();
}

$btnSrcAudio.addEventListener("click", async () => {
  const path = await pickAudioFile();
  if (path) {
    srcAudioPath = path;
    $srcAudioName.textContent = path.split(/[\\/]/).pop();
  }
});

$btnRefAudio.addEventListener("click", async () => {
  const path = await pickAudioFile();
  if (path) setReferenceAudioPath(path);
});

$btnVocalRef?.addEventListener("click", async () => {
  $btnVocalRef.disabled = true;
  try {
    const path = await pickAudioFile();
    if (path) setReferenceAudioPath(path);
  } finally {
    $btnVocalRef.disabled = false;
  }
});

$btnVocalRefClear?.addEventListener("click", () => {
  setReferenceAudioPath(null);
  if ($refAudioName) $refAudioName.textContent = "";
});

$vocalRefStrength?.addEventListener("input", () => {
  if ($vocalRefStrengthVal) {
    $vocalRefStrengthVal.textContent = Number($vocalRefStrength.value).toFixed(2);
  }
});

// ---------------------------------------------------------------------------
// Prepare overlay
// ---------------------------------------------------------------------------
const $prepareOverlay = document.getElementById("prepare-overlay");
const $prepareStep = document.getElementById("prepare-overlay-step");
const $prepareMsg = document.getElementById("prepare-overlay-msg");
const $prepareBar = document.getElementById("prepare-overlay-bar");
const $preparePercent = document.getElementById("prepare-overlay-percent");

function setPrepareProgress(progress, { indeterminate = false } = {}) {
  const pct = Math.max(0, Math.min(100, Number(progress) || 0));
  if (indeterminate) {
    $prepareBar.classList.add("is-indeterminate");
    $preparePercent.textContent = "…";
    return;
  }
  $prepareBar.classList.remove("is-indeterminate");
  $prepareBar.style.width = `${pct}%`;
  $preparePercent.textContent = `${Math.round(pct)}%`;
}

function showPrepareOverlay() {
  Bridge.setAgentLongOperationActive(true);
  $prepareOverlay.hidden = false;
  setPrepareProgress(0, { indeterminate: true });
  $prepareStep.textContent = "";
  $prepareMsg.textContent = "AI 음악 생성에 필요한 패키지와 모델을 설치합니다…";
  $prepareOverlay.scrollIntoView({ behavior: "smooth", block: "center" });
}

function hidePrepareOverlay() {
  $prepareOverlay.hidden = true;
  Bridge.setAgentLongOperationActive(false);
}

function stopPreparePolling() {
  if (preparePollTimer) {
    clearInterval(preparePollTimer);
    preparePollTimer = null;
  }
}

function startPreparePolling({ showOverlayAfterMs = 0 } = {}) {
  stopPreparePolling();
  const origin = Bridge.getAgentOrigin();
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
      const res = await Bridge.fetchAgent(`${origin}/api/tools/create-music/prepare/status`);
      const data = await res.json();

      if (!overlayShown && data.phase === "downloading_model") {
        overlayShown = true;
        clearTimeout(overlayTimer);
        showPrepareOverlay();
      }

      setPrepareProgress(data.progress ?? 0);
      $prepareMsg.textContent = data.message || "설치 진행 중…";

      const phaseLabels = {
        installing_dependencies: "패키지 설치 중",
        downloading_model: "모델 다운로드 중",
        done: "완료",
        error: "오류 발생",
      };
      $prepareStep.textContent = phaseLabels[data.phase] || data.phase || "";

      if (data.phase === "done") {
        stopPreparePolling();
        clearTimeout(overlayTimer);
        setPrepareProgress(100);
        $prepareMsg.textContent = "환경 준비 완료! 음악을 생성할 수 있습니다.";
        $prepareStep.textContent = "설치 완료 ✓";
        autoPrepareStarted = false;
        await checkReadiness({ full: false });
        setTimeout(() => {
          hidePrepareOverlay();
        }, allReady ? 400 : 1500);
      } else if (data.phase === "error") {
        stopPreparePolling();
        clearTimeout(overlayTimer);
        autoPrepareStarted = false;
        $prepareStep.textContent = "오류 발생";
        $prepareMsg.textContent = data.error || "알 수 없는 오류가 발생했습니다.";
        setTimeout(() => {
          hidePrepareOverlay();
          $btnPrepare.textContent = "환경 준비";
          $btnPrepare.disabled = false;
        }, 3000);
      }
    } catch {
      stopPreparePolling();
      clearTimeout(overlayTimer);
      autoPrepareStarted = false;
      hidePrepareOverlay();
      $btnPrepare.textContent = "환경 준비";
      $btnPrepare.disabled = false;
    }
  }, 2000);
}

$btnPrepare.addEventListener("click", async () => {
  const agent = await Bridge.checkAgentConnection();
  if (!agent.ok) {
    await Bridge.showInstallAgentDialog(await installDialogOpts());
    return;
  }

  $btnPrepare.disabled = true;
  autoPrepareStarted = true;

  try {
    const origin = Bridge.getAgentOrigin();
    const res = await Bridge.fetchAgent(`${origin}/api/tools/create-music/prepare`, {
      method: "POST",
    });
    if (!res.ok) throw new Error("prepare failed");
    const data = await res.json();
    if (data.phase === "done") {
      await checkReadiness({ full: false });
      $btnPrepare.disabled = false;
      return;
    }
    startPreparePolling({ showOverlayAfterMs: 0 });
  } catch {
    autoPrepareStarted = false;
    hidePrepareOverlay();
    $btnPrepare.textContent = "환경 준비 실패";
    $btnPrepare.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------
$btnGenerate.addEventListener("click", async () => {
  if (!allReady) return;

  const validation = musicCompose.validateForGeneration();
  if (!validation.ok) {
    alert(validation.message);
    return;
  }

  const composed = musicCompose.compileForGeneration($vocalLang.value);
  const origin = Bridge.getAgentOrigin();
  const payload = {
    task_type: $taskType.value,
    caption: composed.caption,
    lyrics: composed.lyrics,
    vocal_language: $vocalLang.value,
    vocal_type: composed.vocal_type,
    instrumental: composed.instrumental,
    bpm: composed.bpm,
    duration: parseFloat($duration.value) || -1,
    batch_size: parseInt($batchSize.value) || 1,
    dit_model: $ditModel.value,
    lm_model: $lmModel.value,
    inference_steps: parseInt($inferenceSteps.value) || 10,
    guidance_scale: parseFloat($guidanceScale.value) || 5.0,
    shift: parseFloat($shift.value) || 3.0,
    seed: parseInt($seed.value) || -1,
    infer_method: $inferMethod.value,
    audio_format: $audioFormat.value,
    lora_name: $loraSelect.value || null,
    src_audio_path: srcAudioPath,
    reference_audio_path: refAudioPath,
    cover_strength: refAudioPath
      ? parseFloat($vocalRefStrength?.value) || 0.55
      : 1.0,
  };

  $btnGenerate.disabled = true;
  setDownloadEnabled(false);
  Bridge.setAgentLongOperationActive(true);
  musicPlayer.showGenerating(0, "생성 요청 중…");

  try {
    const res = await fetch(`${origin}/api/tools/create-music/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      Bridge.setAgentLongOperationActive(false);
      musicPlayer.hideGenerating();
      musicPlayer.resetIdle();
      setDownloadEnabled(false);
      alert(`오류: ${err.detail || res.statusText}`);
      $btnGenerate.disabled = false;
      return;
    }

    pollGeneration();
  } catch (e) {
    Bridge.setAgentLongOperationActive(false);
    musicPlayer.hideGenerating();
    musicPlayer.resetIdle();
    setDownloadEnabled(false);
    alert(`요청 실패: ${e.message}`);
    $btnGenerate.disabled = false;
  }
});

function pollGeneration() {
  const origin = Bridge.getAgentOrigin();
  if (generationPollTimer) clearInterval(generationPollTimer);

  generationPollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${origin}/api/tools/create-music/generate/status`);
      const data = await res.json();

      const pct = data.progress || 0;
      if (data.status === "running" || data.status === "pending") {
        musicPlayer.showGenerating(pct, data.message || "음악 생성 중…");
      }

      if (data.status === "completed") {
        clearInterval(generationPollTimer);
        generationPollTimer = null;
        Bridge.setAgentLongOperationActive(false);
        $btnGenerate.disabled = false;
        await onGenerationComplete(data.job_id, data.output_paths);
      } else if (data.status === "failed") {
        clearInterval(generationPollTimer);
        generationPollTimer = null;
        Bridge.setAgentLongOperationActive(false);
        $btnGenerate.disabled = false;
        musicPlayer.hideGenerating();
        musicPlayer.resetIdle();
        setDownloadEnabled(false);
        alert(`생성 실패: ${data.message}`);
      }
    } catch {
      // continue polling
    }
  }, 1500);
}

async function onGenerationComplete(jobId, outputPaths) {
  const paths = (outputPaths || []).filter(Boolean);
  if (!paths.length) {
    Bridge.setAgentLongOperationActive(false);
    musicPlayer.hideGenerating();
    musicPlayer.resetIdle();
    setDownloadEnabled(false);
    alert("생성은 완료됐지만 재생할 파일이 없습니다. 환경 준비(ffmpeg) 후 다시 시도하세요.");
    return;
  }

  const p = paths[0];
  const filename = p.split(/[\\/]/).pop();
  const url = `${Bridge.getAgentOrigin()}/api/tools/create-music/result/${jobId}/${encodeURIComponent(filename)}`;

  try {
    await musicPlayer.loadFromUrl(jobId, filename, url);
    setDownloadEnabled(true);
  } catch (e) {
    musicPlayer.hideGenerating();
    musicPlayer.resetIdle();
    setDownloadEnabled(false);
    alert(`재생 준비 실패: ${e.message}`);
  }
}

function saveDownloadSession(track) {
  const origin = Bridge.getAgentOrigin();
  const { jobId, filename } = track;
  const base = filename.replace(/\.[^.]+$/, "") || jobId;
  sessionStorage.setItem(STORAGE_JOB_ID, jobId);
  sessionStorage.setItem(STORAGE_FILENAME, filename);
  sessionStorage.setItem(STORAGE_SOURCE, base);
  sessionStorage.setItem(
    STORAGE_MP3_URL,
    `${origin}/api/tools/create-music/download-mp3/${jobId}?filename=${encodeURIComponent(filename)}`,
  );
  sessionStorage.setItem(
    STORAGE_WAV_URL,
    `${origin}/api/tools/create-music/result/${jobId}/${encodeURIComponent(filename)}`,
  );
}

function navigateToDownloadPage() {
  window.location.assign(new URL(DOWNLOAD_PAGE, window.location.href).href);
}

$btnDownloadMp3?.addEventListener("click", () => {
  const track = musicPlayer.getCurrentTrack();
  if (!track.jobId || !track.filename) return;

  saveDownloadSession(track);
  $btnDownloadMp3.disabled = true;
  setMp3DownloadLabel("다운로드 페이지로 이동 중…");
  navigateToDownloadPage();
});

// ---------------------------------------------------------------------------
// LoRA Training
// ---------------------------------------------------------------------------
$btnTrainLora.addEventListener("click", async () => {
  if (!allReady) return;

  const origin = Bridge.getAgentOrigin();
  const name = $loraName.value.trim();
  if (!name) {
    alert("스타일 이름을 입력하세요.");
    return;
  }

  const payload = {
    lora_name: name,
    training_steps: parseInt($loraSteps.value) || 1000,
    learning_rate: $loraLr.value || "1e-4",
    rank: parseInt($loraRank.value) || 32,
  };

  $btnTrainLora.disabled = true;
  $loraProgressArea.classList.remove("hidden");
  $loraProgressBar.style.width = "0%";
  $loraProgressMsg.textContent = "학습 요청 중…";

  try {
    const res = await fetch(`${origin}/api/tools/create-music/lora/train`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      $loraProgressMsg.textContent = `오류: ${err.detail || res.statusText}`;
      $btnTrainLora.disabled = false;
      return;
    }
    pollLoraTraining();
  } catch (e) {
    $loraProgressMsg.textContent = `요청 실패: ${e.message}`;
    $btnTrainLora.disabled = false;
  }
});

function pollLoraTraining() {
  const origin = Bridge.getAgentOrigin();
  if (loraPollTimer) clearInterval(loraPollTimer);

  loraPollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${origin}/api/tools/create-music/lora/status`);
      const data = await res.json();

      $loraProgressBar.style.width = `${data.progress || 0}%`;
      $loraProgressMsg.textContent = data.message || "";

      if (data.status === "completed" || data.status === "idle") {
        clearInterval(loraPollTimer);
        loraPollTimer = null;
        $btnTrainLora.disabled = false;
        if (data.status === "completed") {
          $loraProgressMsg.textContent = "학습 완료! 나만의 스타일이 저장되었습니다. 생성 시 적용할 수 있습니다.";
          checkReadiness();
        }
      } else if (data.status === "failed") {
        clearInterval(loraPollTimer);
        loraPollTimer = null;
        $btnTrainLora.disabled = false;
      }
    } catch {
      // continue polling
    }
  }, 3000);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
async function loadHistory() {
  const origin = Bridge.getAgentOrigin();
  try {
    const res = await fetch(`${origin}/api/tools/create-music/history`);
    const data = await res.json();

    if (!data.items || data.items.length === 0) {
      $historyList.innerHTML = '<p class="empty-state">아직 생성된 음악이 없습니다.</p>';
      return;
    }

    $historyList.innerHTML = "";
    data.items.forEach((item) => {
      const card = document.createElement("div");
      card.className = "history-card";

      const date = new Date(item.created_at * 1000).toLocaleString("ko-KR");
      const caption = item.params?.caption || "(설명 없음)";
      const files = item.output_files || [];
      const seed = item.seed ?? "N/A";

      card.innerHTML = `
        <div class="history-card-header">
          <span class="history-card-title">#${item.id}</span>
          <span class="history-card-date">${date}</span>
        </div>
        <p class="history-card-caption">${escapeHtml(caption)}</p>
        <div class="history-card-meta">
          <span class="history-seed" title="클릭하여 시드 복사">시드: ${seed}</span>
          <span class="history-model">모델: ${item.params?.dit_model || ""}</span>
          <span class="history-duration">길이: ${item.params?.duration > 0 ? item.params.duration + "초" : "자동"}</span>
        </div>
      `;

      const seedEl = card.querySelector(".history-seed");
      seedEl.addEventListener("click", () => {
        navigator.clipboard.writeText(String(seed)).then(() => {
          seedEl.textContent = "복사 완료!";
          setTimeout(() => { seedEl.textContent = `시드: ${seed}`; }, 1500);
        });
      });

      files.forEach((filePath) => {
        const filename = filePath.split(/[\\/]/).pop();
        const url = `${origin}/api/tools/create-music/result/${item.id}/${filename}`;

        const row = document.createElement("div");
        row.className = "history-audio-row";

        const audio = document.createElement("audio");
        audio.controls = true;
        audio.src = url;

        const dlBtn = document.createElement("a");
        dlBtn.className = "btn btn-outline btn-download";
        dlBtn.href = url;
        dlBtn.download = filename;
        dlBtn.textContent = "⬇";
        dlBtn.title = "다운로드";

        row.appendChild(audio);
        row.appendChild(dlBtn);
        card.appendChild(row);
      });

      $historyList.appendChild(card);
    });
  } catch {
    $historyList.innerHTML = '<p class="empty-state">생성 기록을 불러올 수 없습니다.</p>';
  }
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ---------------------------------------------------------------------------
// AdSense
// ---------------------------------------------------------------------------
void showAdSense("editorAboveWorkspace", "#editor-ad-above-tabs");
void showAdSense("editorBelowExport", "#editor-ad-below-generate");

void (async () => {
  const agent = await Bridge.checkAgentConnection();
  if (!agent.ok) {
    await Bridge.showInstallAgentDialog(await installDialogOpts());
  }
})();
