import {
  checkAgentConnection,
  configureBridge,
  getAgentOrigin,
  requestAgent,
  showInstallAgentDialog,
  startConnectionMonitor,
} from "../../common/bridge.js";
import { agentInstallDialogOptions, escHtml } from "../../common/agent-install-ui.js";
import {
  STORAGE_CLIP_NAME,
  STORAGE_DURATION,
  STORAGE_EDL,
  STORAGE_EDL_FINGERPRINT,
  STORAGE_FPS,
  STORAGE_FPS_NATIVE_RATIONAL,
  STORAGE_FPS_RATIONAL,
  STORAGE_MIN_SILENCE,
  STORAGE_MIN_SILENCE_SEC,
  STORAGE_NAME,
  STORAGE_PADDING_MS,
  STORAGE_REMOVE_SILENT,
  STORAGE_SILENCES,
  STORAGE_SILENCES_DISPLAY,
  STORAGE_TC_OFFSET_SEC,
  STORAGE_VOCAL_MS,
  STORAGE_VIDEO_PATH,
  DEFAULT_PADDING_MS,
  canExportFromSession,
  clipNameFromVideoPath,
  snapshotExportSettingsFromDom,
  validateExportPrerequisitesFromSession,
} from "../../common/edl-export.js";
import {
  computePreviewSilenceColumnRanges,
  drawSilenceWaveform,
  WaveformRenderer,
} from "./waveform-canvas.js";

const DOWNLOAD_PAGE = "download.html";
const BTN_ANALYZE_LABEL = "무음 구간 분석";
/** 분석 로딩 최소 표시(ms) — API가 빨리 끝나도 눈에 보이게 */
const ANALYZE_LOADING_MIN_MS = 900;

// 브리지 설정 (로컬 에이전트 연결)
configureBridge({ healthPath: "/health" });

function installDialogOpts() {
  return agentInstallDialogOptions(() => checkAgentConnection());
}

function edlExportSettingsFingerprint() {
  const fps = getEditorFpsForExport();
  return JSON.stringify({
    rs: getRemoveSilentForEdlExport() ? 1 : 0,
    pad: getPaddingMsForEdlExport(),
    min: getMinSilenceSecForEdlExport(),
    fps: Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null,
  });
}

function markStoredEdlFingerprint() {
  sessionStorage.setItem(STORAGE_EDL_FINGERPRINT, edlExportSettingsFingerprint());
}

function edlSettingsMatchAnalyzeSession() {
  const rs = sessionStorage.getItem(STORAGE_REMOVE_SILENT);
  if (rs === "true" || rs === "false") {
    if ((rs === "true") !== getRemoveSilentForEdlExport()) return false;
  }
  const pad = sessionStorage.getItem(STORAGE_PADDING_MS);
  if (pad != null && Number(pad) !== getPaddingMsForEdlExport()) return false;
  const min =
    sessionStorage.getItem(STORAGE_MIN_SILENCE_SEC) ||
    sessionStorage.getItem(STORAGE_MIN_SILENCE);
  if (min != null && Number(min) !== getMinSilenceSecForEdlExport()) return false;
  const fps = sessionStorage.getItem(STORAGE_FPS);
  const curFps = getEditorFpsForExport();
  if (fps != null && Number.isFinite(Number(fps)) && Number.isFinite(curFps) && curFps > 0) {
    if (Math.round(Number(fps) * 1000) !== Math.round(curFps * 1000)) return false;
  }
  return true;
}

function storedEdlMatchesCurrentSettings() {
  const fp = sessionStorage.getItem(STORAGE_EDL_FINGERPRINT);
  if (fp != null) return fp === edlExportSettingsFingerprint();
  return edlSettingsMatchAnalyzeSession();
}

/** Windows 등에서 경로 대소문자·슬래시 차이 무시 */
function mediaPathsEqual(a, b) {
  if (!a || !b) return false;
  const norm = (p) =>
    String(p)
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  return norm(a) === norm(b);
}

function getRemoveSilentForEdlExport() {
  const el = document.getElementById("opt-remove-silent");
  return el instanceof HTMLInputElement ? el.checked : false;
}

function getPaddingMsForEdlExport() {
  const el = document.getElementById("opt-padding");
  if (el instanceof HTMLInputElement) {
    const v = Number(el.value);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  const stored = sessionStorage.getItem(STORAGE_PADDING_MS);
  const n = stored != null ? Number(stored) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PADDING_MS;
}

function getEditorFpsForExport() {
  const el = document.getElementById("opt-fps");
  if (el instanceof HTMLInputElement) {
    const v = Number(el.value);
    if (Number.isFinite(v) && v > 0) return v;
  }
  const stored = sessionStorage.getItem(STORAGE_FPS);
  const n = stored != null ? Number(stored) : NaN;
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

function getMinSilenceSecForEdlExport() {
  const el = document.getElementById("opt-min-silence");
  if (el instanceof HTMLInputElement) {
    const v = Number(el.value);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  const stored = sessionStorage.getItem(STORAGE_MIN_SILENCE_SEC);
  const n = stored != null ? Number(stored) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0.3;
}

const EXPORT_LINK_DEFAULT_HTML =
  '<span class="icon">📥</span> EDL 파일 다운로드';

/** 다운로드 페이지 이동 취소·뒤로가기(bfcache) 후 버튼 문구 복구 */
function resetExportLinkUi() {
  const exportA = document.getElementById("export-link");
  if (!exportA) return;
  exportA.classList.remove("is-busy");
  exportA.removeAttribute("aria-busy");
  exportA.innerHTML = EXPORT_LINK_DEFAULT_HTML;
  exportA.classList.toggle("is-disabled", !canExportFromSession());
}

/** EDL 다운로드 전용 페이지로 이동 (비네트는 페이지 전환 시 AdSense가 처리) */
async function navigateToEdlDownloadPage(exportLinkEl) {
  snapshotExportSettingsFromDom();

  const prereq = validateExportPrerequisitesFromSession();
  if (!prereq.ok) {
    alert(prereq.message || "먼저 무음 구간 분석을 실행해 주세요.");
    return;
  }

  if (exportLinkEl instanceof HTMLElement) {
    exportLinkEl.classList.add("is-busy");
    exportLinkEl.setAttribute("aria-busy", "true");
    exportLinkEl.innerHTML = '<span class="icon">⏳</span> 이동 중…';
  }

  let navigating = false;
  try {
    const agent = await checkAgentConnection();
    if (!agent.ok) {
      await showInstallAgentDialog(installDialogOpts());
      return;
    }
    navigating = true;
    window.location.assign(new URL(DOWNLOAD_PAGE, window.location.href).href);
  } finally {
    if (!navigating) resetExportLinkUi();
  }
}

/** index.html 한글 깨짐 시 script.js에서 전체 UI 문구 복구 */
function applyStaticUiLabels() {
  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el != null && text != null) el.textContent = text;
  };
  const setLabel = (forId, text) => {
    const el = document.querySelector(`label[for="${forId}"]`);
    if (el && text) el.textContent = text;
  };

  const pathHint = document.querySelector(".path-hint");
  if (pathHint) {
    pathHint.innerHTML =
      "에이전트가 설치된 PC에서 파일을 선택하면 <strong>로컬 절대 경로(에이전트 기준)</strong>가 입력됩니다. 네트워크 드라이브는 지원하지 않습니다.";
  }

  setLabel("video-path", "영상 파일 경로");
  setText("btn-pick-local-file", "찾아보기");
  setText("bin-readiness", "무음 제거 · FFmpeg 준비 대기");

  setLabel("opt-fps", "프레임");
  setText("opt-fps-hint", "EDL 컷·파형 보라 미리보기 모두 이 FPS 격자를 사용합니다.");
  setLabel("opt-avg-db", "평균 볼륨 (dB)");
  setText("opt-avg-db-hint", "영상의 평균 볼륨 크기이며 수정은 불가능합니다.");
  setLabel("opt-rec-db", "추천 무음 민감도 (dB)");
  setText("opt-rec-db-hint", "자동 계산된 추천 무음 민감도 입니다.");
  setLabel("opt-sensitivity", "무음 민감도 (dB)");
  setText("opt-sensitivity-hint", "추천값과 동일하게 자동 입력되며 직접 수정 가능 합니다.");
  setLabel("opt-padding", "말소리 앞뒤 여백 (ms, 100ms = 0.1초)");
  const minSilLbl = document.querySelector(".option-card-duration > label");
  if (minSilLbl) minSilLbl.textContent = "최소 무음 길이 (초)";

  const summaryPanel = document.getElementById("media-summary-panel");
  if (summaryPanel) summaryPanel.setAttribute("aria-label", "미디어 및 무음 구간 요약");
  const summaryTitle = document.querySelector(".media-summary-title");
  if (summaryTitle) summaryTitle.textContent = "미디어 요약";

  const summaryDtTexts = [
    "길이",
    "최대 볼륨",
    "다이내믹 레인지",
    "원본 FPS",
    "샘플레이트",
    "무음 구간",
    "무음 합계",
    "최장 무음 구간",
    "현재 설정",
  ];
  const dts = document.querySelectorAll(
    "#media-summary-panel .media-summary-item dt",
  );
  let di = 0;
  for (const dt of dts) {
    if (di < summaryDtTexts.length) {
      dt.textContent = summaryDtTexts[di];
      di += 1;
    }
  }

  setText("waveform-preview-title", "오디오 파형");
  const zoomHint = document.querySelector(".waveform-zoom-hint");
  if (zoomHint) zoomHint.textContent = " 휠 축소 시 전체 맞춤 · 드래그=이동";
  const zoomReset = document.getElementById("waveform-zoom-reset");
  if (zoomReset) zoomReset.title = "확대 100% (기본 해상도)";

  setText("waveform-analyze-label", "무음 구간 분석 중…");
  const waveHint = document.querySelector(".waveform-analyze-hint");
  if (waveHint) {
    waveHint.textContent =
      "분석 시 편집 FPS 격자로 파형을 만든 뒤 EDL을 생성합니다. 보라색은 파형 기준 미리보기(민감도·여백·최소무음·FPS)이며 EDL과 다를 수 있습니다. 긴 영상은 파형 생성(첫 1회)에 수 분 걸릴 수 있습니다.";
  }
  const canvas = document.getElementById("waveform-preview-canvas");
  if (canvas) canvas.setAttribute("aria-label", "오디오 파형");

  setText("btn-analyze", BTN_ANALYZE_LABEL);
  resetExportLinkUi();
  const removeCaption = document.getElementById("opt-remove-silent-caption");
  if (removeCaption) {
    removeCaption.textContent =
      "무음 구간 자동 제거";
  }

  setText("probe-loading-title", "영상 정보 불러오는 중");
  setText(
    "probe-loading-desc",
    "프레임(FPS), 평균 볼륨, 추천 무음 민감도를 에이전트에서 분석하고 있습니다. 잠시만 기다려 주세요.",
  );
}

window.addEventListener("pageshow", () => {
  resetExportLinkUi();
});

document.addEventListener("DOMContentLoaded", () => {
  const dropZoneContainer = document.querySelector(".drop-zone");
  const pathInput = document.getElementById("video-path");
  const btnPickLocalFile = document.getElementById("btn-pick-local-file");
  const btnAnalyze = document.getElementById("btn-analyze");
  const exportLink = document.getElementById("export-link");
  const probeLoadingDlg = /** @type {HTMLDialogElement | null} */ (document.getElementById("probe-loading-dialog"));
  const probeTitleEl = document.getElementById("probe-loading-title");
  const probeDescEl = document.getElementById("probe-loading-desc");

  const DEFAULT_PROBE_TITLE = "영상 정보 불러오는 중";
  const DEFAULT_PROBE_DESC =
    "프레임(FPS), 평균 볼륨, 추천 무음 민감도를 에이전트에서 분석하고 있습니다. 잠시만 기다려 주세요.";

  function resetProbeModalCopy() {
    if (probeTitleEl) probeTitleEl.textContent = DEFAULT_PROBE_TITLE;
    if (probeDescEl) probeDescEl.textContent = DEFAULT_PROBE_DESC;
  }

  function hideProbeModal() {
    if (!probeLoadingDlg) return;
    if (probeLoadingDlg.open) probeLoadingDlg.close();
    resetProbeModalCopy();
  }

  function showProbeModalForProbe() {
    if (!probeLoadingDlg) return;
    resetProbeModalCopy();
    if (typeof probeLoadingDlg.showModal === "function" && !probeLoadingDlg.open) {
      probeLoadingDlg.showModal();
    }
  }

  /** 짧은 연속 입력으로 프로브가 겹쳐도 모달이 깜빡이지 않도록 깊이 + 지연 표시 */
  let probeBusyDepth = 0;
  let probeShowTimer = 0;
  const PROBE_MODAL_DELAY_MS = 220;

  function bumpProbeLoading() {
    probeBusyDepth += 1;
    if (probeBusyDepth === 1) {
      window.clearTimeout(probeShowTimer);
      probeShowTimer = window.setTimeout(() => {
        if (probeBusyDepth > 0) showProbeModalForProbe();
      }, PROBE_MODAL_DELAY_MS);
    }
  }

  function releaseProbeLoading() {
    probeBusyDepth = Math.max(0, probeBusyDepth - 1);
    if (probeBusyDepth === 0) {
      window.clearTimeout(probeShowTimer);
      probeShowTimer = 0;
      hideProbeModal();
    }
  }

  let probeTimer = 0;
  /** 경로 입력 시 프로브만 약간 지연(파형은 무음 분석 시작 시 로드) */
  function scheduleProbe() {
    window.clearTimeout(probeTimer);
    probeTimer = window.setTimeout(() => void probeMediaFromPath(), 320);
  }

  function applyVideoPathToInput(trimmed) {
    pathInput.value = trimmed;
    pathInput.removeAttribute("placeholder");
    pathInput.focus();
    pathInput.setSelectionRange(trimmed.length, trimmed.length);
    pathInput.style.borderColor = "#3b82f6";
    pathInput.style.boxShadow = "0 0 0 3px rgba(59, 130, 246, 0.2)";
    const base = trimmed.replace(/[/\\]+$/, "").split(/[/\\]/).pop();
    if (base) sessionStorage.setItem(STORAGE_NAME, base);
    scheduleProbe();
    /* 파일 선택 등으로 경로가 한 번에 확정되면 프로브만 바로 시작(입력 디바운스와 무관) */
    if (looksLikeFullPath(trimmed)) {
      window.clearTimeout(probeTimer);
      probeTimer = window.setTimeout(() => void probeMediaFromPath(), 0);
    }
  }

  function syncExportLinkState() {
    if (!exportLink) return;
    exportLink.classList.toggle("is-disabled", !canExportFromSession());
  }

  if (exportLink) {
    syncExportLinkState();
    exportLink.addEventListener("click", (e) => {
      e.preventDefault();
      if (exportLink.classList.contains("is-disabled")) {
        alert("먼저 무음 구간 분석을 실행해 주세요.");
        return;
      }
      void navigateToEdlDownloadPage(exportLink);
    });
  }

  let savedPickBtnLabel = "";
  function setPickBusy(busy) {
    if (btnPickLocalFile) {
      if (busy) {
        savedPickBtnLabel = btnPickLocalFile.textContent || "찾아보기";
        btnPickLocalFile.disabled = true;
        btnPickLocalFile.textContent = "대화상자…";
      } else {
        btnPickLocalFile.disabled = false;
        btnPickLocalFile.textContent = savedPickBtnLabel || "찾아보기";
      }
    }
    if (dropZoneContainer) dropZoneContainer.classList.toggle("is-picking", busy);
  }

  /** 에이전트 PC에서 파일 대화상자를 열고, 선택한 파일의 절대 경로를 입력란에 넣습니다. */
  async function pickLocalFileViaAgent() {
    const agent = await checkAgentConnection();
    if (!agent.ok) {
      await showInstallAgentDialog(installDialogOpts());
      return;
    }

    setPickBusy(true);
    const ctrl = new AbortController();
    const tid = window.setTimeout(() => ctrl.abort(), 10 * 60 * 1000);

    try {
      const res = await fetch(`${getAgentOrigin()}/api/tools/silence-remover/pick-local-file`, {
        method: "POST",
        headers: { Accept: "application/json" },
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const d = data && typeof data === "object" ? data.detail : undefined;
        const msg =
          typeof d === "string"
            ? d
            : Array.isArray(d)
              ? d.map((x) => (x && typeof x === "object" && "msg" in x ? String(x.msg) : "")).filter(Boolean).join("; ")
              : res.statusText || "요청 실패";
        if (res.status === 400 && (msg.includes("취소") || /cancel/i.test(msg))) return;
        alert(msg);
        return;
      }

      const vp = data && typeof data === "object" ? data.video_path : "";
      if (typeof vp !== "string" || !vp.trim()) {
        alert("에이전트가 경로를 반환하지 않았습니다.");
        return;
      }

      applyVideoPathToInput(vp.trim());
    } catch (e) {
      const name = e && typeof e === "object" && "name" in e ? String(e.name) : "";
      if (name === "AbortError") {
        alert("파일 선택이 시간 초과되었습니다. 다시 시도해 주세요.");
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        alert(`파일 찾아보기 실패: ${msg}`);
      }
    } finally {
      window.clearTimeout(tid);
      setPickBusy(false);
    }
  }

  /* 드래그 앤 드롭은 지원하지 않음 — 영역 위에 파일을 놓아도 브라우저가 페이지를 바꾸지 않도록 막음 */
  if (dropZoneContainer) {
    dropZoneContainer.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
    });
    dropZoneContainer.addEventListener("drop", (e) => {
      e.preventDefault();
    });
  }

  if (btnPickLocalFile) {
    btnPickLocalFile.addEventListener("click", () => void pickLocalFileViaAgent());
  }

  const optFps = /** @type {HTMLInputElement} */ (document.getElementById("opt-fps"));
  const optAvgDb = /** @type {HTMLInputElement} */ (document.getElementById("opt-avg-db"));
  const optRecDb = /** @type {HTMLInputElement} */ (document.getElementById("opt-rec-db"));
  const optSens = /** @type {HTMLInputElement} */ (document.getElementById("opt-sensitivity"));
  const optMinSilence = /** @type {HTMLInputElement} */ (document.getElementById("opt-min-silence"));
  const optMinSilenceVal = document.getElementById("opt-min-silence-val");
  const optRemoveSilent = /** @type {HTMLInputElement | null} */ (
    document.getElementById("opt-remove-silent")
  );
  const optRemoveSilentCaption = document.getElementById("opt-remove-silent-caption");
  if (optRemoveSilentCaption) {
    optRemoveSilentCaption.textContent =
      "무음 구간 자동 제거";
  }
  const optPadding = /** @type {HTMLInputElement} */ (document.getElementById("opt-padding"));
  const optPaddingVal = document.getElementById("opt-padding-val");
  const waveformPreviewSection = document.getElementById("waveform-preview-section");
  /** 파형 영역은 무음 분석 시작 시에만 표시 */
  function setWaveformSectionVisible(visible) {
    if (!waveformPreviewSection) return;
    waveformPreviewSection.hidden = !visible;
    waveformPreviewSection.classList.toggle("is-waveform-hidden", !visible);
  }
  setWaveformSectionVisible(false);

  const waveformPreviewTitle = document.getElementById("waveform-preview-title");
  const waveformPreviewCanvas = /** @type {HTMLCanvasElement | null} */ (
    document.getElementById("waveform-preview-canvas")
  );
  const waveformPreviewStatus = document.getElementById("waveform-preview-status");
  const waveformPreviewScroll = document.getElementById("waveform-preview-scroll");
  const waveformScrollTrack = document.getElementById("waveform-scroll-track");
  const waveformAnalyzeLoading = document.getElementById("waveform-analyze-loading");
  const waveformAnalyzeLabel = document.getElementById("waveform-analyze-label");
  const waveformAnalyzeProgressBar = document.getElementById("waveform-analyze-progress-bar");
  const waveformAnalyzeProgressTrack = document.querySelector(
    ".waveform-analyze-progress-track",
  );
  const waveformZoomLevel = document.getElementById("waveform-zoom-level");
  const waveformZoomReset = document.getElementById("waveform-zoom-reset");
  const summaryDuration = document.getElementById("summary-duration");
  const summaryMaxDb = document.getElementById("summary-max-db");
  const summaryDr = document.getElementById("summary-dr");
  const summaryFpsNative = document.getElementById("summary-fps-native");
  const summarySampleRate = document.getElementById("summary-sample-rate");
  const summarySilenceCount = document.getElementById("summary-silence-count");
  const summarySilenceTotal = document.getElementById("summary-silence-total");
  const summarySilenceLongest = document.getElementById("summary-silence-longest");
  const summarySettings = document.getElementById("summary-settings");

  applyStaticUiLabels();

  /** @type {number | null} */
  let probedMediaDurationSec = null;
  /** @type {number | null} */
  let probedMeanVolumeDb = null;
  /** @type {number | null} */
  let probedMaxVolumeDb = null;
  /** @type {string | null} */
  let probedFpsRational = null;
  /** @type {number | null} */
  let probedRecommendedNoiseDb = null;
  /** @type {number | null} */
  let lastAppliedNoiseDb = null;
  /** 마지막 무음 구간 분석에 실제 사용된 설정 (옵션 변경만으로는 갱신하지 않음) */
  /** @type {{ fps: number, noiseDb: number, paddingMs: number, minSilenceSec: number } | null} */
  let lastAnalyzedSettings = null;

  /** @type {import("./waveform-canvas.js").WaveformPeaksData | null} */
  let waveformPeaksData = null;
  /** 무음 구간 분석 완료 후에만 파형에 보라 밴드 표시 */
  let silenceAnalysisDone = false;
  /** 무음 분석 완료 후 파형 미리보기(보라) 표시 — EDL 컷과 별도 */
  let silencePreviewEnabled = false;
  let analyzeLoadingTimer = 0;
  let analyzeLoadingStartedAt = 0;
  let analyzeProgressTimer = 0;
  /** @type {number} 로딩 오버레이를 이 시각까지 유지 */
  let analyzeLoadingHideAfter = 0;
  /** @type {number} 진행 중인 분석 세션 (중복 finally 방지) */
  let analyzeOverlaySessionId = 0;
  /** @type {number} */
  let waveformHighlightTimer = 0;

  /** 파형 미리보기 기본 해상도(분석 전 레거시). 분석 시에는 편집기 FPS 열/초 사용 */
  const WAVEFORM_PPS = 36;
  /** 100%일 때 화면에 보이는 시간(초) */
  const WAVEFORM_VISIBLE_SEC_AT_100 = 60;
  /** 휠 축소 하한(100% 대비). 4% ≈ 화면 25분. 긴 클립은 전체 길이에 맞춤 */
  const WAVEFORM_ZOOM_MIN_RATIO = 0.04;
  const WAVEFORM_WIDTH_MAX = 34000;

  const NOISE_DB_MIN = -60;
  const NOISE_DB_MAX = -10;
  const NOISE_DB_DEFAULT = -40;

  const WAVEFORM_ZOOM_FACTOR = 1.12;
  const WAVEFORM_PX_PER_SEC_MAX = 8000;
  const WAVEFORM_CANVAS_H = 280;

  /**
   * 초당 픽셀(시간축 줌). 0이면 100%(WAVEFORM_BASE_PX_PER_SEC) — 스크롤로 전체 탐색.
   * @type {number}
   */
  let waveformPxPerSec = 0;
  /** @type {WaveformRenderer | null} */
  let waveformRenderer = null;
  /** @type {string} */
  let waveformRendererCacheKey = "";
  /** @type {number} */
  let waveformRedrawTimer = 0;
  /** 파형 가로 드래그 팬 */
  let waveformPanPointerId = -1;
  let waveformPanStartX = 0;
  let waveformPanStartScroll = 0;
  let waveformPanDidMove = false;
  let waveformPanningActive = false;
  let waveformPanRedrawRaf = 0;

  /** 겹치는 파형 요청이 서로의 Object URL을 revoke 해 빈 화면이 되는 것을 막습니다. */
  let waveformPreviewGen = 0;
  /** @type {AbortController | null} */
  let waveformPreviewFetchAbort = null;
  /** @type {string | null} */
  let waveformLoadedPath = null;
  /** @type {number | null} 마지막 파형 peaks 요청 pixels_per_second (편집 FPS 격자) */
  let lastWaveformPeaksPps = null;

  function abortWaveformPreviewInFlight() {
    if (waveformPreviewFetchAbort) {
      waveformPreviewFetchAbort.abort();
      waveformPreviewFetchAbort = null;
    }
  }

  /** @param {number} n @param {number} lo @param {number} hi */
  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  /** 무음 민감도(dB) — 추천값과 동일하게 소수 둘째 자리까지 절단 */
  function getNoiseDb() {
    const v = Number(optSens.value);
    if (!Number.isFinite(v)) return NOISE_DB_DEFAULT;
    return clamp(truncTo2Decimals(v), NOISE_DB_MIN, NOISE_DB_MAX);
  }

  function syncNoiseDbInput() {
    const v = getNoiseDb();
    optSens.value = String(truncTo2Decimals(v));
  }

  function resetSilenceAnalysisState() {
    silenceAnalysisDone = false;
    silencePreviewEnabled = false;
    lastAppliedNoiseDb = null;
    lastAnalyzedSettings = null;
    sessionStorage.removeItem(STORAGE_EDL);
    sessionStorage.removeItem(STORAGE_EDL_FINGERPRINT);
    sessionStorage.removeItem(STORAGE_SILENCES);
    sessionStorage.removeItem(STORAGE_SILENCES_DISPLAY);
    sessionStorage.removeItem(STORAGE_VOCAL_MS);
    sessionStorage.removeItem(STORAGE_DURATION);
    sessionStorage.removeItem(STORAGE_FPS_RATIONAL);
    sessionStorage.removeItem(STORAGE_FPS);
    syncExportLinkState();
    if (btnAnalyze) {
      btnAnalyze.disabled = false;
      btnAnalyze.textContent = BTN_ANALYZE_LABEL;
    }
    renderAnalyzedSettingsSummary();
  }

  function scheduleWaveformHighlightRefresh() {
    if (!waveformPeaksData || !silencePreviewEnabled) return;
    scheduleWaveformRedraw();
  }

  function enablePreviewSilenceOverlay() {
    silenceAnalysisDone = true;
    silencePreviewEnabled = true;
    waveformRendererCacheKey = "";
    scheduleWaveformRedraw();
  }

  /** 파형 peaks + 현재 UI 설정으로 미리보기 무음 열 범위 */
  function getPreviewSilenceColumnRangesForDraw() {
    if (!waveformPeaksData || !silencePreviewEnabled) return undefined;
    const fps = getEditorFpsForExport();
    return computePreviewSilenceColumnRanges(waveformPeaksData, {
      noiseDb: getNoiseDb(),
      minSilenceSec: getMinSilenceSec(),
      paddingMs: getPaddingMs(),
      meanVolumeDb: waveformPeaksData.mean_volume_db,
      maxVolumeDb: waveformPeaksData.max_volume_db,
      editorFps: Number.isFinite(fps) && fps > 0 ? fps : undefined,
    });
  }

  function getViewportWaveformWidth() {
    return Math.max(320, waveformPreviewScroll?.clientWidth ?? 800);
  }

  /** 100% = 뷰포트에 WAVEFORM_VISIBLE_SEC_AT_100초가 보이는 해상도 */
  function getWaveformBasePxPerSec() {
    const vw = getViewportWaveformWidth();
    return vw / WAVEFORM_VISIBLE_SEC_AT_100;
  }

  /** 휠 축소 하한 px/s — ratio 하한과「전체 타임라인 맞춤」중 더 작은 값 */
  function getWaveformMinPxPerSec() {
    const base = getWaveformBasePxPerSec();
    let minPx = base * WAVEFORM_ZOOM_MIN_RATIO;
    const dur = waveformPeaksData?.timeline_sec ?? 0;
    if (dur > 1) {
      const fitAllPx = (getViewportWaveformWidth() * 0.98) / dur;
      minPx = Math.min(minPx, fitAllPx);
    }
    return Math.max(minPx, base * 0.02);
  }

  /** 0 = 100% (화면에 ~WAVEFORM_VISIBLE_SEC_AT_100초) */
  function getWaveformPxPerSec() {
    if (waveformPxPerSec > 0) return waveformPxPerSec;
    return getWaveformBasePxPerSec();
  }

  function getWaveformZoomPercent(pxPerSec) {
    return Math.round((pxPerSec / getWaveformBasePxPerSec()) * 100);
  }

  function getWaveformVisibleSecOnScreen(pxPerSec) {
    const vw = getViewportWaveformWidth();
    return pxPerSec > 1e-9 ? vw / pxPerSec : WAVEFORM_VISIBLE_SEC_AT_100;
  }

  function getWaveformTotalScrollWidthPx() {
    if (!waveformPeaksData) return getViewportWaveformWidth();
    const px = getWaveformPxPerSec();
    const vw = getViewportWaveformWidth();
    return Math.max(vw, Math.ceil(waveformPeaksData.timeline_sec * px));
  }

  function updateWaveformScrollTrack() {
    if (!waveformScrollTrack || !waveformPeaksData) return;
    const totalW = getWaveformTotalScrollWidthPx();
    waveformScrollTrack.style.width = `${totalW}px`;
    if (waveformPreviewScroll) {
      const maxScroll = Math.max(0, totalW - getViewportWaveformWidth());
      if (waveformPreviewScroll.scrollLeft > maxScroll) {
        waveformPreviewScroll.scrollLeft = maxScroll;
      }
    }
  }

  function scheduleWaveformRedraw() {
    if (waveformPanningActive) return;
    window.clearTimeout(waveformRedrawTimer);
    waveformRedrawTimer = window.setTimeout(() => {
      redrawWaveformCanvas();
    }, 16);
  }

  /** 드래그 팬 중 — 마우스와 함께 파형이 움직이도록 매 프레임 다시 그림 */
  function scheduleWaveformRedrawWhilePanning() {
    if (waveformPanRedrawRaf) return;
    waveformPanRedrawRaf = window.requestAnimationFrame(() => {
      waveformPanRedrawRaf = 0;
      if (!waveformPanningActive || !waveformPreviewScroll) return;
      redrawWaveformCanvas();
    });
  }

  function cancelWaveformPanRedrawRaf() {
    if (waveformPanRedrawRaf) {
      window.cancelAnimationFrame(waveformPanRedrawRaf);
      waveformPanRedrawRaf = 0;
    }
  }

  function ensureWaveformRenderer() {
    if (!waveformPeaksData) return null;
    const key = `${waveformPeaksData.timeline_sec}|${waveformPeaksData.column_count}|${waveformPeaksData.peaks.length}`;
    if (!waveformRenderer || key !== waveformRendererCacheKey) {
      waveformRenderer = WaveformRenderer.fromPeaks(
        waveformPeaksData.peaks,
        waveformPeaksData.timeline_sec,
        waveformPeaksData.peaks_db,
      );
      waveformRendererCacheKey = key;
    }
    return waveformRenderer;
  }

  function redrawWaveformCanvas() {
    if (!waveformPreviewCanvas || !waveformPeaksData) return;
    updateWaveformScrollTrack();
    const renderer = ensureWaveformRenderer();
    const pxPerSec = getWaveformPxPerSec();
    const scrollLeftPx = waveformPreviewScroll?.scrollLeft ?? 0;
    const canvasWidth = getViewportWaveformWidth();

    const silenceColRanges = silencePreviewEnabled
      ? getPreviewSilenceColumnRangesForDraw()
      : undefined;

    drawSilenceWaveform(waveformPreviewCanvas, waveformPeaksData, {
      noiseDb: getNoiseDb(),
      minSilenceSec: getMinSilenceSec(),
      height: WAVEFORM_CANVAS_H,
      showRuler: true,
      showSilenceOverlay: silencePreviewEnabled,
      silenceColumnRanges: silenceColRanges,
      pxPerSec,
      scrollLeftPx,
      canvasWidth,
      flattenSilence: true,
      renderer,
    });

    updateWaveformScrollTrack();
    setWaveformCanvasHidden(false);

    const zoomPct = getWaveformZoomPercent(pxPerSec);
    if (waveformZoomLevel) {
      waveformZoomLevel.textContent = `${zoomPct}%`;
    }

    if (waveformPreviewStatus) {
      const durTxt = formatDurationClock(waveformPeaksData.timeline_sec);
      waveformPreviewStatus.textContent = silencePreviewEnabled
        ? `재생 시간 : ${durTxt} / 미리보기 화면은 실제 EDL 파일의 결과물과 완벽히 일치하지 않을 수 있으므로 참고 바랍니다.`
        : `재생 시간 : ${durTxt}`;
      waveformPreviewStatus.classList.remove("is-err");
    }
    if (waveformPreviewTitle) {
      waveformPreviewTitle.textContent = silencePreviewEnabled
        ? "오디오 파형 (무음 미리보기)"
        : "오디오 파형";
    }
  }

  function getMinSilenceSec() {
    if (!optMinSilence) return 0.3;
    const v = Number(optMinSilence.value);
    return Number.isFinite(v) ? clamp(v, 0.1, 10) : 0.3;
  }

  function syncMinSilenceLabel() {
    const sec = getMinSilenceSec();
    if (optMinSilence) optMinSilence.value = String(sec);
    if (optMinSilenceVal) optMinSilenceVal.textContent = `${truncTo2Decimals(sec)}s`;
  }

  /** 칩 선택 상태를 슬라이더 값과 맞춤 */
  function syncMinSilenceChipActive() {
    const sec = getMinSilenceSec();
    document.querySelectorAll("#duration-chip-list .chip").forEach((chip) => {
      const el = /** @type {HTMLButtonElement} */ (chip);
      const chipSec = Number(el.dataset.val);
      const isMatch = Number.isFinite(chipSec) && Math.abs(chipSec - sec) < 0.001;
      el.classList.toggle("active", isMatch);
    });
  }

  function getPaddingMs() {
    if (!optPadding) return DEFAULT_PADDING_MS;
    const v = Number(optPadding.value);
    return Number.isFinite(v) ? clamp(v, 0, 1000) : DEFAULT_PADDING_MS;
  }

  function syncPaddingLabel() {
    const ms = getPaddingMs();
    if (optPaddingVal) optPaddingVal.textContent = `${ms}ms`;
  }

  function looksLikeFullPath(p) {
    return p.length > 4 && (/[/\\]/.test(p) || /^[a-zA-Z]:\\/.test(p));
  }

  /** 소수 둘째 자리까지만 남기고 나머지는 절단(0 방향, 반올림 아님) */
  function truncTo2Decimals(n) {
    if (typeof n !== "number" || !Number.isFinite(n)) return n;
    return Math.trunc(n * 100) / 100;
  }

  /** @param {number} sec */
  function formatDurationClock(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "—";
    const total = Math.floor(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  /** @param {number | null | undefined} sec @param {boolean} [withSecUnit] */
  function formatDurationShort(sec, withSecUnit = false) {
    if (!Number.isFinite(sec) || sec == null || sec < 0) return "—";
    const v = truncTo2Decimals(sec);
    if (v >= 60) return formatDurationClock(v);
    return withSecUnit ? `${v}s` : `${v}초`;
  }

  /** @param {HTMLElement | null} el @param {string} text */
  function setSummaryCell(el, text) {
    if (el) el.textContent = text;
  }

  /** 프로브·분석 결과 추천 dB를 추천·무음 민감도 입력란에 동일 형식으로 반영 */
  function applyRecommendedNoiseDb(recDb) {
    if (!Number.isFinite(recDb)) return;
    const shown = truncTo2Decimals(recDb);
    probedRecommendedNoiseDb = shown;
    optRecDb.value = String(shown);
    const sens = clamp(shown, NOISE_DB_MIN, NOISE_DB_MAX);
    optSens.value = String(truncTo2Decimals(sens));
  }

  function renderAnalyzedSettingsSummary() {
    if (!lastAnalyzedSettings) {
      setSummaryCell(summarySettings, "—");
      return;
    }
    const { fps, noiseDb, paddingMs, minSilenceSec } = lastAnalyzedSettings;
    const fpsTxt =
      Number.isFinite(fps) && fps > 0 ? `${truncTo2Decimals(fps)} fps` : "—";
    const sensTxt =
      Number.isFinite(noiseDb) ? `${truncTo2Decimals(noiseDb)}dB` : "—";
    const padTxt = Number.isFinite(paddingMs) ? `${Math.round(paddingMs)}ms` : "—";
    const minTxt =
      Number.isFinite(minSilenceSec) ? `${truncTo2Decimals(minSilenceSec)}초` : "—";

    setSummaryCell(
      summarySettings,
      [
        `프레임: ${fpsTxt}`,
        `무음 민감도: ${sensTxt}`,
        `여백: ${padTxt}`,
        `최소 무음: ${minTxt}`,
      ].join("\n"),
    );
  }

  /**
   * @param {{ fps: number, noiseDb: number, paddingMs: number, minSilenceSec: number }} snapshot
   */
  function commitAnalyzedSettingsSnapshot(snapshot) {
    lastAnalyzedSettings = {
      fps: snapshot.fps,
      noiseDb: snapshot.noiseDb,
      paddingMs: snapshot.paddingMs,
      minSilenceSec: snapshot.minSilenceSec,
    };
    renderAnalyzedSettingsSummary();
  }

  function clearMediaSummary() {
    applyStaticUiLabels();
    probedMediaDurationSec = null;
    probedMeanVolumeDb = null;
    probedMaxVolumeDb = null;
    probedRecommendedNoiseDb = null;
    lastAppliedNoiseDb = null;
    lastAnalyzedSettings = null;
    setSummaryCell(summaryDuration, "—");
    setSummaryCell(summaryMaxDb, "—");
    setSummaryCell(summaryDr, "—");
    setSummaryCell(summaryFpsNative, "—");
    setSummaryCell(summarySampleRate, "—");
    setSummaryCell(summarySilenceCount, "분석 전");
    setSummaryCell(summarySilenceTotal, "—");
    setSummaryCell(summarySilenceLongest, "—");
    setSummaryCell(summarySettings, "—");
  }

  /**
   * @param {Record<string, unknown>} m
   */
  function applyMediaSummaryFromProbe(m) {
    if (!m || typeof m !== "object") return;
    if (typeof m.duration_sec === "number" && Number.isFinite(m.duration_sec)) {
      probedMediaDurationSec = m.duration_sec;
      setSummaryCell(summaryDuration, formatDurationClock(m.duration_sec));
      if (waveformPeaksData && applyResolvedTimelineToPeaksData(waveformPeaksData)) {
        waveformRendererCacheKey = "";
        scheduleWaveformRedraw();
      }
    }
    if (typeof m.mean_volume_db === "number" && Number.isFinite(m.mean_volume_db)) {
      probedMeanVolumeDb = m.mean_volume_db;
    } else {
      probedMeanVolumeDb = null;
    }
    if (typeof m.max_volume_db === "number" && Number.isFinite(m.max_volume_db)) {
      probedMaxVolumeDb = m.max_volume_db;
      setSummaryCell(summaryMaxDb, `${truncTo2Decimals(m.max_volume_db)} dB`);
    } else {
      probedMaxVolumeDb = null;
      setSummaryCell(summaryMaxDb, "—");
    }
    if (typeof m.dynamic_range_db === "number" && Number.isFinite(m.dynamic_range_db)) {
      setSummaryCell(summaryDr, `${truncTo2Decimals(m.dynamic_range_db)} dB`);
    } else {
      setSummaryCell(summaryDr, "—");
    }
    if (typeof m.fps_rational === "string" && m.fps_rational.trim()) {
      probedFpsRational = m.fps_rational.trim();
      sessionStorage.setItem(STORAGE_FPS_NATIVE_RATIONAL, probedFpsRational);
      const fps =
        typeof m.fps === "number" && Number.isFinite(m.fps)
          ? ` (${truncTo2Decimals(m.fps)})`
          : "";
      setSummaryCell(summaryFpsNative, `${m.fps_rational}${fps}`);
    }
    if (typeof m.sample_rate_hz === "number" && Number.isFinite(m.sample_rate_hz)) {
      const khz = m.sample_rate_hz / 1000;
      const label = Number.isInteger(khz) ? `${khz} kHz` : `${truncTo2Decimals(khz)} kHz`;
      setSummaryCell(summarySampleRate, label);
    }
    if (m.has_video_stream === false) {
      setSummaryCell(summaryFpsNative, "오디오만 (25 fps 가정)");
    }
    setSummaryCell(summarySilenceCount, "분석 전");
    setSummaryCell(summarySilenceTotal, "—");
    setSummaryCell(summarySilenceLongest, "—");
    renderAnalyzedSettingsSummary();
  }

  /**
   * @param {Array<{ start_sec: number, end_sec: number }>} silences
   * @param {number | undefined} durationSec
   */
  function applySilenceSummaryFromAnalyze(silences, durationSec) {
    const timeline =
      Number.isFinite(durationSec) && durationSec > 0
        ? durationSec
        : probedMediaDurationSec && probedMediaDurationSec > 0
          ? probedMediaDurationSec
          : null;

    let total = 0;
    let longest = 0;
    for (const s of silences) {
      const len = Math.max(0, Number(s.end_sec) - Number(s.start_sec));
      total += len;
      if (len > longest) longest = len;
    }

    const count = silences.length;
    setSummaryCell(summarySilenceCount, count === 0 ? "없음" : `${count}개`);

    if (count === 0) {
      setSummaryCell(summarySilenceTotal, "0초");
      setSummaryCell(summarySilenceLongest, "—");
    } else {
      const totalTxt = formatDurationShort(total, true);
      const pct =
        timeline && timeline > 0 ? ` (${truncTo2Decimals((total / timeline) * 100)}%)` : "";
      setSummaryCell(summarySilenceTotal, `${totalTxt}${pct}`);
      setSummaryCell(summarySilenceLongest, formatDurationShort(longest, true));
    }
  }

  /** @param {boolean} hidden */
  function setWaveformCanvasHidden(hidden) {
    if (waveformPreviewCanvas) {
      waveformPreviewCanvas.classList.toggle("is-canvas-hidden", hidden);
    }
  }

  /** @param {number} pct 0–100 */
  function setAnalyzeProgressBar(pct) {
    const p = clamp(pct, 0, 100);
    if (waveformAnalyzeProgressBar) {
      waveformAnalyzeProgressBar.style.width = `${p}%`;
      waveformAnalyzeProgressBar.classList.add("is-determinate");
    }
    if (waveformAnalyzeProgressTrack) {
      waveformAnalyzeProgressTrack.setAttribute("aria-valuenow", String(Math.round(p)));
    }
  }

  /** @param {boolean} on @param {{ mode?: "full" | "waveform", label?: string }} [opts] */
  function setWaveformAnalyzeLoading(on, opts = {}) {
    const mode = opts.mode === "waveform" ? "waveform" : "full";
    const label =
      opts.label ??
      (mode === "waveform" ? "무음 구간 분석 중…" : "파형 생성·무음 분석 중…");

    if (waveformAnalyzeLoading) {
      if (on) {
        waveformAnalyzeLoading.removeAttribute("hidden");
        waveformAnalyzeLoading.setAttribute("aria-hidden", "false");
        waveformAnalyzeLoading.classList.add("is-active");
        waveformAnalyzeLoading.style.display = "flex";
      } else {
        waveformAnalyzeLoading.classList.remove("is-active");
        waveformAnalyzeLoading.style.display = "none";
        waveformAnalyzeLoading.hidden = true;
        waveformAnalyzeLoading.setAttribute("aria-hidden", "true");
      }
      waveformAnalyzeLoading.classList.toggle("is-waveform-only", on && mode === "waveform");
    }
    if (waveformPreviewScroll) {
      waveformPreviewScroll.classList.toggle("is-analyze-loading", on);
    }
    window.clearInterval(analyzeLoadingTimer);
    window.clearInterval(analyzeProgressTimer);
    analyzeLoadingTimer = 0;
    analyzeProgressTimer = 0;
    if (on) {
      analyzeLoadingStartedAt = Date.now();
      analyzeLoadingHideAfter = Math.max(
        analyzeLoadingHideAfter,
        analyzeLoadingStartedAt + ANALYZE_LOADING_MIN_MS,
      );
      setWaveformSectionVisible(true);
      if (waveformPeaksData) {
        setWaveformCanvasHidden(false);
      }
      const onWaveform = mode === "waveform";
      if (onWaveform && waveformAnalyzeProgressBar) {
        waveformAnalyzeProgressBar.classList.remove("is-determinate");
        waveformAnalyzeProgressBar.style.width = "45%";
        if (waveformAnalyzeProgressTrack) {
          waveformAnalyzeProgressTrack.setAttribute("aria-valuenow", "0");
        }
      } else {
        setAnalyzeProgressBar(12);
      }
      if (waveformAnalyzeLoading) {
        void waveformAnalyzeLoading.offsetHeight;
      }
      const tick = () => {
        if (!waveformAnalyzeLabel) return;
        const sec = Math.max(
          0,
          Math.floor((Date.now() - analyzeLoadingStartedAt) / 1000),
        );
        const txt = onWaveform
          ? sec > 0
            ? `무음 구간 분석 중… (${sec}초)`
            : "무음 구간 분석 중…"
          : sec > 0
            ? `파형 생성·무음 분석 중… (${sec}초)`
            : "파형 생성·무음 분석 중…";
        waveformAnalyzeLabel.textContent = txt;
      };
      tick();
      analyzeLoadingTimer = window.setInterval(tick, 400);
      if (!onWaveform) {
        const cap = 92;
        analyzeProgressTimer = window.setInterval(() => {
          const track = waveformAnalyzeProgressTrack;
          const cur = track
            ? Number(track.getAttribute("aria-valuenow") || "12")
            : 12;
          if (cur < cap) setAnalyzeProgressBar(cur + 1);
        }, 280);
      }
    } else {
      setAnalyzeProgressBar(100);
      window.setTimeout(() => {
        if (waveformAnalyzeProgressBar) {
          waveformAnalyzeProgressBar.classList.remove("is-determinate");
          waveformAnalyzeProgressBar.style.width = "";
        }
      }, 350);
      if (waveformAnalyzeLabel) {
        waveformAnalyzeLabel.textContent = "무음 구간 분석 중…";
      }
    }
  }

  /**
   * @param {"full" | "waveform"} mode
   * @returns {{ id: number, mode: "full" | "waveform" }}
   */
  function beginAnalyzeOverlay(mode) {
    analyzeOverlaySessionId += 1;
    const id = analyzeOverlaySessionId;
    analyzeLoadingHideAfter = Date.now() + ANALYZE_LOADING_MIN_MS;
    setWaveformAnalyzeLoading(true, { mode });
    return { id, mode };
  }

  /**
   * @param {{ id: number, mode: "full" | "waveform" }} session
   * @param {"full" | "waveform"} [mode]
   */
  function refreshAnalyzeOverlay(session, mode) {
    if (session.id !== analyzeOverlaySessionId) return;
    if (mode) session.mode = mode;
    analyzeLoadingHideAfter = Math.max(
      analyzeLoadingHideAfter,
      Date.now() + ANALYZE_LOADING_MIN_MS,
    );
    setWaveformAnalyzeLoading(true, { mode: session.mode });
  }

  /**
   * @param {{ id: number }} session
   */
  async function endAnalyzeOverlay(session) {
    if (session.id !== analyzeOverlaySessionId) return;
    const wait = analyzeLoadingHideAfter - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, wait));
    }
    if (session.id !== analyzeOverlaySessionId) return;
    analyzeLoadingHideAfter = 0;
    setWaveformAnalyzeLoading(false);
  }

  /** 확대 100% (36px/s) + 스크롤 맨 앞 */
  function resetWaveformZoom() {
    waveformPxPerSec = 0;
    if (waveformPreviewScroll) {
      waveformPreviewScroll.scrollLeft = 0;
      waveformPreviewScroll.scrollTop = 0;
    }
    scheduleWaveformRedraw();
  }

  /** @param {WheelEvent} e */
  function onWaveformWheel(e) {
    if (!waveformPreviewScroll || !waveformPreviewCanvas || !waveformPeaksData) return;
    if (waveformPreviewCanvas.classList.contains("is-canvas-hidden")) return;
    if (waveformPreviewScroll.classList.contains("is-analyze-loading")) return;
    e.preventDefault();

    const scroll = waveformPreviewScroll;
    const rect = scroll.getBoundingClientRect();
    const pointerInViewport = e.clientX - rect.left;
    const oldPx = getWaveformPxPerSec();
    const pointerTimeSec = (scroll.scrollLeft + pointerInViewport) / oldPx;

    const factor = e.deltaY < 0 ? WAVEFORM_ZOOM_FACTOR : 1 / WAVEFORM_ZOOM_FACTOR;
    const nextPx = clamp(
      oldPx * factor,
      getWaveformMinPxPerSec(),
      WAVEFORM_PX_PER_SEC_MAX,
    );
    if (Math.abs(nextPx - oldPx) < 1e-6) return;

    waveformPxPerSec = nextPx;
    updateWaveformScrollTrack();
    scroll.scrollLeft = Math.max(
      0,
      pointerTimeSec * nextPx - pointerInViewport,
    );
    scheduleWaveformRedraw();
  }

  function canInteractWithWaveform() {
    return (
      waveformPreviewScroll &&
      waveformPeaksData &&
      waveformPreviewCanvas &&
      !waveformPreviewCanvas.classList.contains("is-canvas-hidden") &&
      !waveformPreviewScroll.classList.contains("is-analyze-loading")
    );
  }

  function clampWaveformScrollLeft(left) {
    if (!waveformPreviewScroll) return 0;
    const max = Math.max(
      0,
      waveformPreviewScroll.scrollWidth - waveformPreviewScroll.clientWidth,
    );
    return clamp(left, 0, max);
  }

  /** @param {PointerEvent} e */
  function onWaveformPanPointerDown(e) {
    if (!canInteractWithWaveform()) return;
    if (e.button !== 0) return;
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.closest(".waveform-zoom-reset")) return;

    waveformPanPointerId = e.pointerId;
    waveformPanStartX = e.clientX;
    waveformPanStartScroll = waveformPreviewScroll.scrollLeft;
    waveformPanDidMove = false;
    waveformPanningActive = true;
    cancelWaveformPanRedrawRaf();
    window.clearTimeout(waveformRedrawTimer);
    waveformPreviewScroll.classList.add("is-waveform-panning");
    waveformPreviewScroll.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  /** @param {PointerEvent} e */
  function onWaveformPanPointerMove(e) {
    if (!waveformPreviewScroll || e.pointerId !== waveformPanPointerId) return;
    const dx = e.clientX - waveformPanStartX;
    if (Math.abs(dx) > 3) waveformPanDidMove = true;
    waveformPreviewScroll.scrollLeft = clampWaveformScrollLeft(waveformPanStartScroll - dx);
    scheduleWaveformRedrawWhilePanning();
    e.preventDefault();
  }

  /** @param {PointerEvent} e */
  function onWaveformPanPointerUp(e) {
    if (!waveformPreviewScroll || e.pointerId !== waveformPanPointerId) return;
    waveformPanPointerId = -1;
    waveformPanningActive = false;
    cancelWaveformPanRedrawRaf();
    redrawWaveformCanvas();
    waveformPreviewScroll.classList.remove("is-waveform-panning");
    try {
      waveformPreviewScroll.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }

  if (waveformPreviewScroll) {
    waveformPreviewScroll.addEventListener("wheel", onWaveformWheel, { passive: false });
    waveformPreviewScroll.addEventListener("scroll", () => scheduleWaveformRedraw(), {
      passive: true,
    });
    waveformPreviewScroll.addEventListener("pointerdown", onWaveformPanPointerDown);
    waveformPreviewScroll.addEventListener("pointermove", onWaveformPanPointerMove);
    waveformPreviewScroll.addEventListener("pointerup", onWaveformPanPointerUp);
    waveformPreviewScroll.addEventListener("pointercancel", onWaveformPanPointerUp);
    waveformPreviewScroll.addEventListener("dblclick", (e) => {
      if (waveformPanDidMove) {
        e.preventDefault();
        waveformPanDidMove = false;
        return;
      }
      resetWaveformZoom();
    });
  }
  if (waveformZoomReset) {
    waveformZoomReset.addEventListener("click", () => resetWaveformZoom());
  }
  window.addEventListener("resize", () => {
    if (waveformPeaksData) scheduleWaveformRedraw();
  });

  /**
   * 새 미디어 로드 전: 이전 peaks·duration·스크롤·요청을 비웁니다.
   * @param {{ hideSection?: boolean }} [opts]
   */
  function resetWaveformStateForNewMedia(opts = {}) {
    waveformPreviewGen += 1;
    waveformPanningActive = false;
    waveformPanPointerId = -1;
    cancelWaveformPanRedrawRaf();
    window.clearTimeout(waveformHighlightTimer);
    waveformPeaksData = null;
    waveformLoadedPath = null;
    lastWaveformPeaksPps = null;
    waveformRenderer = null;
    waveformRendererCacheKey = "";
    abortWaveformPreviewInFlight();
    waveformPxPerSec = 0;
    if (waveformScrollTrack) waveformScrollTrack.style.width = "";
    if (waveformPreviewScroll) {
      waveformPreviewScroll.scrollLeft = 0;
      waveformPreviewScroll.scrollTop = 0;
    }
    if (waveformPreviewCanvas) {
      const ctx = waveformPreviewCanvas.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, waveformPreviewCanvas.width, waveformPreviewCanvas.height);
      }
      setWaveformCanvasHidden(true);
    }
    if (waveformPreviewStatus) {
      waveformPreviewStatus.textContent = "";
      waveformPreviewStatus.classList.remove("is-err");
    }
    if (opts.hideSection) {
      setWaveformSectionVisible(false);
    }
  }

  /**
   * @param {number} timelineSec
   * @param {number} columnCount
   * @param {number | null | undefined} probedSec
   */
  function resolveWaveformTimelineSec(timelineSec, columnCount, probedSec) {
    let t = timelineSec;
    if (!Number.isFinite(t) || t <= 0 || columnCount < 2) return t;
    const secPerCol = t / columnCount;
    if (Number.isFinite(probedSec) && probedSec > 0 && t > probedSec * 1.12) {
      t = probedSec;
    } else if (secPerCol > 0.2) {
      const est = columnCount / WAVEFORM_PPS;
      if (est > 30 && est < t * 0.9) t = est;
    }
    return t;
  }

  /** @param {import("./waveform-canvas.js").WaveformPeaksData} data */
  function applyResolvedTimelineToPeaksData(data) {
    const target = resolveWaveformTimelineSec(
      data.timeline_sec,
      data.column_count,
      probedMediaDurationSec,
    );
    if (
      !Number.isFinite(target) ||
      target <= 0 ||
      Math.abs(target - data.timeline_sec) < 0.5
    ) {
      return false;
    }
    if (target > data.timeline_sec * 1.01) {
      return false;
    }
    data.timeline_sec = target;
    data.duration_sec = target;
    return true;
  }

  function clearWaveformPreview() {
    resetWaveformStateForNewMedia({ hideSection: true });
    resetSilenceAnalysisState();
    resetWaveformZoom();
    clearMediaSummary();
    if (waveformPreviewTitle) waveformPreviewTitle.textContent = "오디오 파형";
  }

  /**
   * FFmpeg PCM 열 피크 JSON 1회 로드 후 Canvas에 그립니다.
   * @param {string} videoPath
   * @param {{
   *   assumeAgentOk?: boolean,
   *   centerLoading?: boolean,
   *   scrollIntoView?: boolean,
   *   showSection?: boolean,
   *   pixelsPerSecond?: number,
   *   useEditorTimeline?: boolean,
   * }} [opts]
   */
  /** 편집기 FPS로 파형 열 밀도(1열≈1프레임). 긴 영상은 max width 안으로 pps 자동 축소 */
  function peaksPixelsPerSecondForEditorFps(editorFps, durationSec) {
    const fps = Math.max(1, Math.min(120, Number(editorFps) || 29.97));
    const dur = Number(durationSec);
    if (!Number.isFinite(dur) || dur <= 0) return fps;
    const cap = WAVEFORM_WIDTH_MAX / dur;
    return Math.min(fps, Math.max(1, cap));
  }

  async function loadWaveformPreview(videoPath, opts = {}) {
    if (!waveformPreviewSection || !waveformPreviewCanvas) return;
    if (!looksLikeFullPath(videoPath)) {
      clearWaveformPreview();
      return;
    }
    resetWaveformStateForNewMedia({ hideSection: opts.showSection !== true });
    waveformPreviewGen += 1;
    const myGen = waveformPreviewGen;
    const loadPath = videoPath;
    const pps =
      typeof opts.pixelsPerSecond === "number" && opts.pixelsPerSecond > 0
        ? opts.pixelsPerSecond
        : WAVEFORM_PPS;
    const useEditorTimeline = opts.useEditorTimeline === true;

    if (!opts.assumeAgentOk) {
      const agent = await checkAgentConnection();
      if (!agent.ok) return;
    }
    if (myGen !== waveformPreviewGen) return;

    if (opts.showSection === true) {
      setWaveformSectionVisible(true);
    }

    if (waveformPreviewStatus) {
      waveformPreviewStatus.textContent = `파형 생성 중 (편집 FPS ${truncTo2Decimals(pps)} 열/초)…`;
      waveformPreviewStatus.classList.remove("is-err");
    }

    const ctrl = new AbortController();
    waveformPreviewFetchAbort = ctrl;
    const tid = window.setTimeout(() => ctrl.abort(), 15 * 60 * 1000);

    try {
      const raw = await requestAgent({
        method: "POST",
        path: "/api/tools/silence-remover/waveform-peaks",
        json: {
          video_path: videoPath,
          timeout_sec: 900,
          pixels_per_second: pps,
          max_waveform_width: WAVEFORM_WIDTH_MAX,
        },
        signal: ctrl.signal,
      });
      if (myGen !== waveformPreviewGen) return;
      if (!raw || typeof raw !== "object") {
        throw new Error("파형 peaks 응답 형식이 올바르지 않습니다.");
      }

      const peaks = Array.isArray(raw.peaks) ? raw.peaks.map(Number) : [];
      const peaksDb = Array.isArray(raw.peaks_db) ? raw.peaks_db.map(Number) : [];
      const columnCount =
        typeof raw.column_count === "number" && raw.column_count > 0
          ? raw.column_count
          : peaks.length;
      let timelineSec =
        typeof raw.timeline_sec === "number" && raw.timeline_sec > 0
          ? raw.timeline_sec
          : typeof raw.duration_sec === "number"
            ? raw.duration_sec
            : 0;

      if (columnCount < 2 || timelineSec <= 0) {
        throw new Error("파형 peaks 데이터가 비어 있습니다.");
      }

      if (!useEditorTimeline) {
        timelineSec = resolveWaveformTimelineSec(
          timelineSec,
          columnCount,
          probedMediaDurationSec,
        );
      }

      const pcmDecodedSec =
        typeof raw.pcm_decoded_sec === "number" && raw.pcm_decoded_sec > 0
          ? raw.pcm_decoded_sec
          : timelineSec;

      if (pcmDecodedSec < timelineSec * 0.92) {
        throw new Error(
          `오디오 파형이 ${formatDurationClock(pcmDecodedSec)}까지만 디코드되었습니다 (재생 ${formatDurationClock(timelineSec)}). ` +
            "에이전트를 재시작하고 %APPDATA%\\ItMatZip\\cache 폴더를 삭제한 뒤 다시 불러오세요.",
        );
      }

      if (myGen !== waveformPreviewGen || loadPath !== pathInput.value.trim()) return;

      const peaksPpsFromServer =
        typeof raw.pixels_per_second === "number" && raw.pixels_per_second > 0
          ? raw.pixels_per_second
          : pps;

      waveformPeaksData = {
        peaks,
        peaks_db: peaksDb.length === columnCount ? peaksDb : peaksDb,
        duration_sec: timelineSec,
        column_count: columnCount,
        timeline_sec: timelineSec,
        pcm_decoded_sec: pcmDecodedSec,
        peaks_pps: peaksPpsFromServer,
        mean_volume_db:
          typeof raw.mean_volume_db === "number"
            ? raw.mean_volume_db
            : probedMeanVolumeDb ?? -24,
        max_volume_db:
          typeof raw.max_volume_db === "number" ? raw.max_volume_db : probedMaxVolumeDb,
      };

      if (
        typeof raw.mean_volume_db === "number" &&
        Number.isFinite(raw.mean_volume_db) &&
        probedMeanVolumeDb == null
      ) {
        probedMeanVolumeDb = raw.mean_volume_db;
      }
      if (
        typeof raw.max_volume_db === "number" &&
        Number.isFinite(raw.max_volume_db) &&
        probedMaxVolumeDb == null
      ) {
        probedMaxVolumeDb = raw.max_volume_db;
      }

      waveformLoadedPath = loadPath.trim();
      lastWaveformPeaksPps = pps;
      waveformRendererCacheKey = "";

      if (
        probedMediaDurationSec == null &&
        timelineSec > 0 &&
        summaryDuration
      ) {
        probedMediaDurationSec = timelineSec;
        setSummaryCell(summaryDuration, formatDurationClock(timelineSec));
      }

      waveformPxPerSec = 0;
      resetWaveformZoom();
      redrawWaveformCanvas();
      if (waveformPreviewCanvas) {
        const effectivePps = columnCount / timelineSec;
        const ppsLabel = truncTo2Decimals(effectivePps);
        const reqLabel = truncTo2Decimals(pps);
        waveformPreviewCanvas.title = `파형 ${columnCount}열 · ${ppsLabel} 열/초 (요청 ${reqLabel}) — 휠 확대`;
      }
      if (opts.scrollIntoView !== false && waveformPreviewSection) {
        waveformPreviewSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      if (aborted && myGen !== waveformPreviewGen) return;
      console.warn("[waveform-peaks]", e);
      waveformPeaksData = null;
      if (waveformPreviewStatus) {
        const msg = aborted
          ? myGen === waveformPreviewGen
            ? "요청이 중단되었거나 시간이 초과되었습니다."
            : ""
          : e instanceof Error
            ? e.message
            : String(e);
        if (msg) {
          waveformPreviewStatus.textContent = `파형을 불러오지 못했습니다: ${msg}`;
          waveformPreviewStatus.classList.add("is-err");
        }
      }
    } finally {
      window.clearTimeout(tid);
      if (waveformPreviewFetchAbort === ctrl) {
        waveformPreviewFetchAbort = null;
      }
    }
  }

  /** @param {Record<string, unknown>} m */
  function applyProbeResultToOptions(m) {
    if (typeof m.fps === "number" && Number.isFinite(m.fps)) {
      optFps.value = String(truncTo2Decimals(m.fps));
    }
    if (typeof m.mean_volume_db === "number" && Number.isFinite(m.mean_volume_db)) {
      optAvgDb.value = String(truncTo2Decimals(m.mean_volume_db));
    }
    if (typeof m.recommended_noise_db === "number" && Number.isFinite(m.recommended_noise_db)) {
      applyRecommendedNoiseDb(m.recommended_noise_db);
    }
    if (typeof m.fps_rational === "string" && m.fps_rational.trim()) {
      probedFpsRational = m.fps_rational.trim();
      sessionStorage.setItem(STORAGE_FPS_NATIVE_RATIONAL, probedFpsRational);
    }
  }

  async function probeMediaFromPath() {
    const p = pathInput.value.trim();
    if (!looksLikeFullPath(p)) {
      clearWaveformPreview();
      return;
    }
    const agent = await checkAgentConnection();
    if (!agent.ok) {
      alert(
        `에이전트에 연결할 수 없습니다. 로컬 에이전트를 실행한 뒤 다시 시도해 주세요.\n\n${agent.error || ""}`,
      );
      return;
    }

    resetSilenceAnalysisState();
    probedMediaDurationSec = null;
    probedMeanVolumeDb = null;
    probedMaxVolumeDb = null;
    probedFpsRational = null;
    setWaveformSectionVisible(false);

    bumpProbeLoading();
    const probeCtrl = new AbortController();
    const probeTimeoutId = window.setTimeout(() => probeCtrl.abort(), 180000);
    try {
      const m = await requestAgent({
        method: "POST",
        path: "/api/tools/silence-remover/probe",
        json: { video_path: p, timeout_sec: 180 },
        signal: probeCtrl.signal,
      });
      if (m && typeof m === "object") {
        applyProbeResultToOptions(/** @type {Record<string, unknown>} */ (m));
        const basis = m.recommendation_basis;
        const recHintEl = document.getElementById("opt-rec-db-hint");
        if (
          recHintEl &&
          basis &&
          typeof basis === "object" &&
          typeof basis.mean_volume_db === "number" &&
          typeof basis.offset_from_mean_db === "number"
        ) {
          const mean = truncTo2Decimals(basis.mean_volume_db);
          const off = truncTo2Decimals(basis.offset_from_mean_db);
          const chosen =
            typeof basis.chosen_db === "number"
              ? truncTo2Decimals(basis.chosen_db)
              : truncTo2Decimals(m.recommended_noise_db);
          recHintEl.textContent = `평균 ${mean}dB + ${off}dB → 후보 min(보수) ≈ ${chosen}dB`;
          if (optRecDb) {
            optRecDb.title = `from_mean: ${truncTo2Decimals(basis.from_mean_db)}dB` +
              (typeof basis.from_peak_db === "number"
                ? `, from_peak: ${truncTo2Decimals(basis.from_peak_db)}dB`
                : "");
          }
        }
        applyMediaSummaryFromProbe(m);
      } else {
        alert("프로브 응답 형식이 올바르지 않습니다. 에이전트를 재시작한 뒤 다시 시도해 주세요.");
      }
    } catch (e) {
      console.warn("[probe]", e);
      const msg = e instanceof Error ? e.message : String(e);
      const aborted = e instanceof DOMException && e.name === "AbortError";
      alert(
        aborted
          ? "미디어 정보 분석이 시간 초과되었습니다. 파일이 크면 더 오래 걸릴 수 있습니다."
          : `미디어 정보를 불러오지 못했습니다.\n\n${msg}`,
      );
    } finally {
      window.clearTimeout(probeTimeoutId);
      releaseProbeLoading();
    }
  }

  pathInput.addEventListener("input", scheduleProbe);
  /* blur로 프로브하면: (1) 옵션으로 포커스를 옮길 때마다 재요청 (2) 로딩 dialog showModal 시 포커스가 빼앗겨 blur가 나와 중복 프로브·로딩 반복 — 하지 않음 */

  optSens.addEventListener("input", () => {
    lastAppliedNoiseDb = null;
    scheduleWaveformHighlightRefresh();
  });
  optSens.addEventListener("change", () => {
    syncNoiseDbInput();
    lastAppliedNoiseDb = null;
    scheduleWaveformHighlightRefresh();
  });

  if (optMinSilence) {
    optMinSilence.addEventListener("input", () => {
      syncMinSilenceLabel();
      syncMinSilenceChipActive();
      sessionStorage.setItem(STORAGE_MIN_SILENCE_SEC, String(getMinSilenceSec()));
      scheduleWaveformHighlightRefresh();
    });
  }
  if (optPadding) {
    optPadding.addEventListener("input", () => {
      syncPaddingLabel();
      sessionStorage.setItem(STORAGE_PADDING_MS, String(getPaddingMs()));
      scheduleWaveformHighlightRefresh();
    });
  }
  if (optFps) {
    optFps.addEventListener("input", () => {
      scheduleWaveformHighlightRefresh();
    });
    optFps.addEventListener("change", scheduleWaveformHighlightRefresh);
  }

  syncNoiseDbInput();
  syncMinSilenceLabel();
  syncMinSilenceChipActive();
  syncPaddingLabel();
  renderAnalyzedSettingsSummary();
  /**
   * 2. 옵션 칩(Chip) 제어
   */
  document.querySelectorAll("#duration-chip-list .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const val = chip.dataset.val;
      if (optMinSilence && val != null) {
        optMinSilence.value = val;
        syncMinSilenceLabel();
        sessionStorage.setItem(STORAGE_MIN_SILENCE_SEC, String(getMinSilenceSec()));
      }
      document.querySelectorAll("#duration-chip-list .chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      scheduleWaveformHighlightRefresh();
    });
  });

  /**
   * 3. 무음 분석 요청 (에이전트 통신)
   */
  btnAnalyze.addEventListener("click", async () => {
    const videoPath = pathInput.value.trim();
    if (!videoPath) {
      alert("영상 파일의 실제 로컬 경로를 입력해주세요.");
      pathInput.focus();
      return;
    }

    const fpsUi = optFps.value.trim();
    const fpsParsed = fpsUi === "" ? NaN : Number(fpsUi);
    if (!Number.isFinite(fpsParsed) || fpsParsed <= 0) {
      alert(
        "편집기 FPS를 입력한 뒤 분석해 주세요.\n(파형·EDL·무음 표시는 모두 이 FPS 프레임 격자에 맞춥니다.)",
      );
      optFps.focus();
      return;
    }

    const estDur =
      probedMediaDurationSec ??
      (waveformPeaksData && waveformLoadedPath && mediaPathsEqual(waveformLoadedPath, videoPath)
        ? waveformPeaksData.timeline_sec
        : 0);
    const peaksPps = peaksPixelsPerSecondForEditorFps(fpsParsed, estDur);

    const hasPeaksForPath =
      waveformPeaksData != null &&
      waveformLoadedPath != null &&
      mediaPathsEqual(waveformLoadedPath, videoPath);
    const needWaveformLoad = !hasPeaksForPath;
    const isReanalyze = silencePreviewEnabled || hasPeaksForPath;

    btnAnalyze.disabled = true;
    btnAnalyze.textContent = "분석 중...";

    setWaveformSectionVisible(true);
    if (waveformPreviewSection) {
      waveformPreviewSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    const overlaySession = beginAnalyzeOverlay(isReanalyze ? "waveform" : "full");
    await new Promise((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
    });

    try {
      if (needWaveformLoad) {
        await loadWaveformPreview(videoPath, {
          assumeAgentOk: true,
          showSection: true,
          scrollIntoView: true,
          pixelsPerSecond: peaksPps,
          useEditorTimeline: true,
        });
        if (!waveformPeaksData || !mediaPathsEqual(waveformLoadedPath, videoPath)) {
          alert("오디오 파형을 불러오지 못했습니다. 도우미 실행과 영상 경로를 확인한 뒤 다시 시도해 주세요.");
          return;
        }
        refreshAnalyzeOverlay(overlaySession, "waveform");
        await new Promise((resolve) => {
          window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
        });
      }

      const minSil = getMinSilenceSec();
      const noiseDb = getNoiseDb();
      const analyzeBody = {
        video_path: videoPath,
        noise_db: noiseDb,
        min_silence_sec: Number.isFinite(minSil) ? minSil : 0.3,
        padding_ms: getPaddingMs(),
        remove_silent: optRemoveSilent ? optRemoveSilent.checked : false,
        use_autocutter_pipeline: false,
        use_recommended_noise: false,
        use_pcm_preview: false,
        require_cached_peaks: true,
        pixels_per_second: peaksPps,
        max_waveform_width: WAVEFORM_WIDTH_MAX,
        timeout_sec: 3600,
      };
      analyzeBody.fps = fpsParsed;
      const clipName = clipNameFromVideoPath(videoPath);
      if (clipName) {
        analyzeBody.clip_name = clipName;
        sessionStorage.setItem(STORAGE_CLIP_NAME, clipName);
      }
      sessionStorage.setItem(STORAGE_VIDEO_PATH, videoPath);

      const data = await requestAgent({
        method: "POST",
        path: "/api/tools/silence-remover/analyze",
        json: analyzeBody,
      });

      const edl = data && typeof data === "object" && typeof data.edl === "string" ? data.edl : "";
      const appliedNoiseDb =
        data && typeof data === "object" && typeof data.applied_noise_db === "number"
          ? data.applied_noise_db
          : noiseDb;
      if (data && typeof data === "object" && typeof data.applied_noise_db === "number") {
        lastAppliedNoiseDb = data.applied_noise_db;
      }
      commitAnalyzedSettingsSnapshot({
        fps: fpsParsed,
        noiseDb: appliedNoiseDb,
        paddingMs: analyzeBody.padding_ms,
        minSilenceSec: Number.isFinite(minSil) ? minSil : 0.3,
      });
      sessionStorage.setItem(STORAGE_EDL, edl);
      markStoredEdlFingerprint();
      const vocalMsForStore =
        data && typeof data === "object" && Array.isArray(data.vocal_intervals_ms)
          ? data.vocal_intervals_ms
          : [];
      sessionStorage.setItem(STORAGE_VOCAL_MS, JSON.stringify(vocalMsForStore));
      const silencesForStore =
        data && typeof data === "object" && Array.isArray(data.silences) ? data.silences : [];
      sessionStorage.setItem(STORAGE_SILENCES, JSON.stringify(silencesForStore));
      const silencesDisplayForStore =
        data && typeof data === "object" && Array.isArray(data.silences_display)
          ? data.silences_display
          : silencesForStore;
      sessionStorage.setItem(STORAGE_SILENCES_DISPLAY, JSON.stringify(silencesDisplayForStore));
      const analysisDur =
        data && typeof data === "object" && Number.isFinite(data.duration_sec)
          ? Number(data.duration_sec)
          : probedMediaDurationSec ?? waveformPeaksData?.timeline_sec ?? 0;
      if (Number.isFinite(analysisDur) && analysisDur > 0) {
        sessionStorage.setItem(STORAGE_DURATION, String(analysisDur));
      }
      if (waveformPeaksData && data && typeof data === "object") {
        const wTimeline =
          typeof data.waveform_timeline_sec === "number" && data.waveform_timeline_sec > 0
            ? Number(data.waveform_timeline_sec)
            : null;
        const wPcm =
          typeof data.waveform_pcm_decoded_sec === "number" && data.waveform_pcm_decoded_sec > 0
            ? Number(data.waveform_pcm_decoded_sec)
            : null;
        if (wTimeline != null && Math.abs(wTimeline - waveformPeaksData.timeline_sec) > 0.02) {
          waveformPeaksData.timeline_sec = wTimeline;
          waveformPeaksData.duration_sec = wTimeline;
          waveformRenderer = null;
          waveformRendererCacheKey = "";
        }
        if (wPcm != null) {
          waveformPeaksData.pcm_decoded_sec = wPcm;
        }
        if (
          typeof data.waveform_pixels_per_second === "number" &&
          data.waveform_pixels_per_second > 0
        ) {
          waveformPeaksData.peaks_pps = Number(data.waveform_pixels_per_second);
        }
        const wWidth =
          typeof data.waveform_width === "number" && data.waveform_width > 0
            ? Math.floor(Number(data.waveform_width))
            : 0;
        if (
          wWidth > 0 &&
          waveformPeaksData.column_count > 0 &&
          wWidth !== waveformPeaksData.column_count
        ) {
          console.warn(
            "[silence-remover] waveform_width(%s) ≠ peaks column_count(%s) — 파형을 다시 불러오세요.",
            wWidth,
            waveformPeaksData.column_count,
          );
        }
      }
      enablePreviewSilenceOverlay();
      const fpsRatEdl =
        data && typeof data === "object" && typeof data.fps_rational === "string"
          ? data.fps_rational.trim()
          : "";
      if (fpsRatEdl) sessionStorage.setItem(STORAGE_FPS_RATIONAL, fpsRatEdl);
      const fpsNat =
        data && typeof data === "object" && typeof data.native_fps_rational === "string"
          ? data.native_fps_rational.trim()
          : probedFpsRational;
      if (fpsNat) {
        sessionStorage.setItem(STORAGE_FPS_NATIVE_RATIONAL, fpsNat);
        probedFpsRational = fpsNat;
        const nativeFpsVal =
          typeof data.native_fps === "number" && Number.isFinite(data.native_fps)
            ? truncTo2Decimals(data.native_fps)
            : null;
        const fpsNatDisp = nativeFpsVal != null ? ` (${nativeFpsVal})` : "";
        setSummaryCell(summaryFpsNative, `${fpsNat}${fpsNatDisp}`);
      }
      if (Number.isFinite(fpsParsed) && fpsParsed > 0) {
        sessionStorage.setItem(STORAGE_FPS, String(fpsParsed));
      }
      if (data && typeof data === "object" && Number.isFinite(data.edl_source_tc_offset_sec)) {
        sessionStorage.setItem(
          STORAGE_TC_OFFSET_SEC,
          String(data.edl_source_tc_offset_sec),
        );
      }
      sessionStorage.setItem(
        STORAGE_REMOVE_SILENT,
        optRemoveSilent && optRemoveSilent.checked ? "true" : "false",
      );
      sessionStorage.setItem(STORAGE_PADDING_MS, String(getPaddingMs()));
      sessionStorage.setItem(STORAGE_MIN_SILENCE_SEC, String(minSil));
      sessionStorage.setItem(STORAGE_MIN_SILENCE, String(minSil));
      syncExportLinkState();
      if (!edl.trim()) {
        alert("분석은 완료됐지만 EDL 내용이 비어 있습니다. 무음 구간이 없거나 설정을 조정해 보세요.");
      }

      const silences =
        data && typeof data === "object" && Array.isArray(data.silences) ? data.silences : [];
      const durationSec =
        data && typeof data === "object" && Number.isFinite(data.duration_sec)
          ? Number(data.duration_sec)
          : undefined;
      applySilenceSummaryFromAnalyze(silences, durationSec);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "분석에 실패했습니다.";
      alert(`분석 실패: ${msg}`);
      console.error(err);
    } finally {
      await endAnalyzeOverlay(overlaySession);
      btnAnalyze.disabled = false;
      btnAnalyze.textContent = BTN_ANALYZE_LABEL;
      if (silenceAnalysisDone && waveformPeaksData) {
        window.requestAnimationFrame(() => redrawWaveformCanvas());
      }
    }
  });

  startConnectionMonitor({
    intervalMs: 8000,
    immediate: true,
    onChange: (ok, detail) => {
      const statusDot = document.getElementById("connection-status");
      if (statusDot) {
        if (ok) {
          statusDot.textContent = "에이전트 연결됨";
          statusDot.style.color = "#10b981";
          statusDot.title = "";
        } else {
          const hint = detail?.error ? ` — ${detail.error}` : "";
          statusDot.textContent = `에이전트 연결 끊김${hint}`;
          statusDot.style.color = "#ef4444";
          statusDot.title = detail?.error || "";
        }
      }
      void checkSilenceToolBinaries();
    },
    autoShowInstallDialog: true,
    installDialogOptions: installDialogOpts(),
  });

  /** 에이전트 연결 시 FFmpeg readiness 점검 */
  async function checkSilenceToolBinaries() {
    const binEl = document.getElementById("bin-readiness");
    if (!binEl) return;

    const agent = await checkAgentConnection();
    if (!agent.ok) {
      binEl.hidden = false;
      binEl.className = "bin-readiness is-warn";
      binEl.textContent = "에이전트 미연결 → FFmpeg 점검 불가";
      return;
    }

    binEl.hidden = false;
    binEl.className = "bin-readiness is-warn";
    binEl.textContent = "FFmpeg · ffprobe 확인 중...";

    try {
      const data = await requestAgent({
        method: "GET",
        path: "/api/tools/silence-remover/readiness",
        onProgress: (ev) => {
          if (ev.phase === "request") {
            binEl.textContent =
              "에이전트에 FFmpeg 설치·확인 요청 중... (처음엔 다운로드로 시간이 걸릴 수 있음)";
          }
        },
      });
      const b = data && typeof data === "object" ? data.binaries : null;
      if (b && b.ffmpeg && b.ffprobe) {
        binEl.className = "bin-readiness is-ok";
        binEl.textContent = "FFmpeg · ffprobe 준비됨";
        return;
      }
      binEl.className = "bin-readiness is-err";
      binEl.textContent = "FFmpeg 또는 ffprobe가 경로에 없습니다.";
      await showInstallAgentDialog({
        title: "FFmpeg 구성 오류",
        bodyHtml: `<p>에이전트는 떠 있지만 <code>ffmpeg.exe</code> / <code>ffprobe.exe</code> 준비 결과가 비정상입니다.</p><p>에이전트를 재시작하거나 <code>%APPDATA%\\ItMatZip\\bin</code> 폴더를 확인해 주세요.</p>`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      binEl.className = "bin-readiness is-err";
      binEl.textContent = `FFmpeg 준비 실패: ${msg}`;
      await showInstallAgentDialog({
        title: "FFmpeg를 내려받거나 설치하지 못했습니다",
        bodyHtml: `<p>에이전트 PC에서 번들 다운로드가 실패했을 수 있습니다. 아래 메시지를 참고하세요.</p><p><code>${escHtml(msg)}</code></p><ul style="text-align:left;margin:0.5rem 0 0 1rem;line-height:1.5"><li><code>ITMATZIP_FFMPEG_URL</code>에 유효한 Windows용 FFmpeg zip 주소가 있는지</li><li>인터넷·방화벽·회사 프록시</li><li>에이전트 터미널의 Python 에러 로그</li></ul>`,
        onPrimary: async () => {
          await checkSilenceToolBinaries();
        },
      });
    }
  }
});