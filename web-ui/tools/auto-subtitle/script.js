import {
  applyConnectionStatusDot,
  checkAgentConnection,
  configureBridge,
  fetchAgent,
  formatAgentConnectionError,
  getAgentOrigin,
  mapAgentEventToPrepareStatus,
  requestAgent,
  resolveAgentMediaObjectUrl,
  revokeAgentMediaObjectUrl,
  showInstallAgentDialog,
  startAgentEventStream,
  startConnectionMonitor,
  setAgentLongOperationActive,
  isAgentLongOperationActive,
  getAgentCircuitBreakerState,
} from "../common/bridge.js?v=lna15";
import { agentInstallDialogOptions } from "../common/agent-install-ui.js?v=lna17";
import { showAdSense } from "../common/adsense.js";
import {
  LOCAL_HELPER_NAME,
  MSG_SUBTITLE_JOB_BUSY,
  MSG_SUBTITLE_NEED_APP,
  MSG_SUBTITLE_PREPARE,
} from "../common/local-helper-ui.js?v=1";
import {
  renderSubtitleCards,
  readCuesFromCards,
  captureTextareaEditsIntoCues,
  scrollCueIntoView,
  requestFocusCaret,
  requestFocusCaretDeferred,
  prepareRowCaretAfterCueSplit,
  finalizeRowCaretAfterCueSplit,
  hintActiveCaretCardIndex,
  syncExpandedPanelPlayhead,
  refreshExpandedPanelSkipRanges,
  finishExpandedPanelRangePlay,
  toggleExpandedPanelPlayFromCut,
  getExpandedPanelCutEditSec,
  updatePlaybackHighlights,
  patchSelectedCueHighlight,
} from "./cue-cards.js?v=68";
import {
  handleGlobalArrowKey,
  resetKeyboardPauseCaret,
  resetSpaceSeekIntent,
  syncCaretOnPlaybackPause,
  syncPlaybackCaretVisibility,
  clearListPlayFromCaretPreferred,
  clearAllRowCaretState,
  prepareCaretAtWord,
  getFocusedSubtitleCardIndex,
  setPreviewOverlaySyncHook,
} from "./subtitle-list/word-caret-ui.js?v=53";
import {
  nearestValidStorageCaret,
  visibleWordStorageIndices,
} from "./shared/subtitle-word-caret-map.js?v=21";
import {
  syncAllCuesFromWords,
  ensureCueWords,
  subtitleLineEditDisplayText,
  rebuildWordsFromLineText,
  markLineTextUserEdited,
  MIN_WORD_SPAN_SEC,
} from "./subtitle-words.js?v=24";
import {
  pickActiveCueIndex,
  pickActiveCueIndexWithHint,
  pickActiveWordIndex,
  skipCutRangeAt,
  playableEditSecForWord,
  firstPlayableSecInRange,
} from "./playback.js?v=25";
import { loadWaveformPeaksForMedia } from "./waveform-peaks-client.js?v=25";
import {
  buildExportRequestPayload,
  exportFormatLabel,
  EXPORT_TEXT_FORMATS,
} from "./export/export-client.js?v=25";
import { isVideoBurnInNotFoundError, runVideoBurnInExport } from "./export/video-burn-in-client.js?v=10";
import {
  normalizeCuesFromAgent,
  postProcessCuesAfterTranscribe,
} from "./shared/cues-ssot.js?v=34";
import { resolvePeaksTimelineMetrics } from "./peaks-metrics.js?v=30";
import {
  applySubtitleOverlayTextLayout,
  buildSubtitleOverlayInnerStyle,
  normalizePreviewSubtitleText,
} from "./shared/subtitle-box-chrome.js?v=25";
import { SubtitleAppHub } from "./hub/app-hub.js?v=25";
import { clearWaveformCutSecCache } from "./line-waveform-panel.js?v=6";
import {
  applyPlaybackSkipToPreviewMedia,
  applyThrottledVideoSkipCut,
  isHtmlAudioMasterActive,
  readHtmlAudioMasterPlayhead,
  resetPlaybackSkipThrottle,
  startSyncedPlayback,
  stopSyncedPlayback,
  syncVideoFromHtmlAudioMaster,
} from "./hub/synced-playback.js?v=31";
import { assignMasterAudioTimelineSecIfNeeded } from "./hub/html-audio-master-playback.js?v=2";
import { getPlaybackOrchestrator } from "./hub/playback-orchestrator.js?v=24";
import {
  splitSubtitleAt,
  mergeEmptySubtitleAt,
  splitSubtitleAtWord,
  backspaceWordAt,
  deleteWordAt,
  deleteWordRangeAt,
} from "./shared/subtitle-edit-actions.js?v=22";

configureBridge({ healthPath: "/health" });

const TOOL_PREFIX = "/api/tools/auto-subtitle";
const STORAGE_CUES = "auto-subtitle:last-cues";
const STORAGE_CUTS = "auto-subtitle:cut-ranges";
const STORAGE_EXPORT_PATH = "auto-subtitle:export-path";
const STORAGE_VIDEO_PATH = "auto-subtitle:last-video-path";
const STORAGE_USER_PREFS = "auto-subtitle:user-preferences";
const USER_PREFS_VERSION = 2;

const WATERMARK_POSITIONS = [
  { value: "top-left", label: "왼쪽 상단" },
  { value: "top-center", label: "중앙 상단" },
  { value: "top-right", label: "우측 상단" },
  { value: "bottom-left", label: "왼쪽 하단" },
  { value: "bottom-center", label: "중앙 하단" },
  { value: "bottom-right", label: "우측 하단" },
];

const DEFAULT_WATERMARK_POSITION = "top-right";
const WATERMARK_MAX_WIDTH_RATIO = 0.045;
const WATERMARK_MARGIN_RATIO = 0.005;

const DEFAULT_SUBTITLE_STYLE = {
  fontFamily: "Malgun Gothic",
  fontSize: 47,
  textColor: "#ffffff",
  fontWeight: 700,
  bgColor: "#000000",
  bgOpacity: 63,
  bgSize: 50,
  strokeColor: "#000000",
  strokeWidth: 2,
  x: 50,
  y: 90,
};

const SYSTEM_FONT_CANDIDATES = [
  "Malgun Gothic",
  "맑은 고딕",
  "Apple SD Gothic Neo",
  "Noto Sans KR",
  "Nanum Gothic",
  "Gulim",
  "Dotum",
  "Batang",
  "Arial",
  "Segoe UI",
  "Helvetica Neue",
  "sans-serif",
];

const videoPathInput = document.getElementById("video-path");
const btnPick = document.getElementById("btn-pick-local-file");
const btnNewJob = document.getElementById("btn-new-job");
const styleSection = document.getElementById("style-section");
const exportFormatSelect = document.getElementById("export-format");
const btnExport = document.getElementById("btn-export");
const btnDownloadResult = document.getElementById("btn-download-result");
const btnShowExportFolder = document.getElementById("btn-show-export-folder");
const languageSelect = document.getElementById("language-select");
const binReadiness = document.getElementById("bin-readiness");
const subtitleList = document.getElementById("subtitle-list");
const subtitleEmpty = document.getElementById("subtitle-empty");
const resultsMeta = document.getElementById("results-meta");
const previewSection = document.getElementById("preview-section");
const previewMediaFrame = document.getElementById("preview-media-frame");
const previewVideo = document.getElementById("preview-video");
const previewAudio = document.getElementById("preview-audio");
const previewOverlay = document.getElementById("preview-subtitle-overlay");
const previewWatermarkOverlay = document.getElementById("preview-watermark-overlay");
const previewEmpty = document.getElementById("preview-empty");
const btnPreviewPlay = document.getElementById("btn-preview-play");
const previewSeek = document.getElementById("preview-seek");
const previewTimeCurrent = document.getElementById("preview-time-current");
const previewTimeTotal = document.getElementById("preview-time-total");
const asShell = document.querySelector(".as-shell");
const inappBusyHost = document.getElementById("as-inapp-busy-host");

const setupLoading = document.getElementById("setup-loading");
const setupLoadingTitle = document.getElementById("setup-loading-title");
const setupLoadingStep = document.getElementById("setup-loading-step");
const setupLoadingMessage = document.getElementById("setup-loading-message");
const setupLoadingBar = document.getElementById("setup-loading-bar");
const setupLoadingTrack = document.getElementById("setup-loading-track");
const setupLoadingPercent = document.getElementById("setup-loading-percent");

const transcribeLoading = document.getElementById("transcribe-loading");
const transcribeLoadingTitle = document.getElementById("transcribe-loading-title");
const transcribeLoadingStep = document.getElementById("transcribe-loading-step");
const transcribeLoadingMessage = document.getElementById("transcribe-loading-message");
const transcribeLoadingBar = document.getElementById("transcribe-loading-bar");
const transcribeLoadingTrack = document.getElementById("transcribe-loading-track");
const transcribeLoadingPercent = document.getElementById("transcribe-loading-percent");

const exportLoading = document.getElementById("export-loading");
const exportLoadingTitle = document.getElementById("export-loading-title");
const exportLoadingStep = document.getElementById("export-loading-step");
const exportLoadingMessage = document.getElementById("export-loading-message");
const exportLoadingBar = document.getElementById("export-loading-bar");
const exportLoadingTrack = document.getElementById("export-loading-track");
const exportLoadingPercent = document.getElementById("export-loading-percent");
const styleFontFamily = document.getElementById("style-font-family");
const styleFontSizeRange = document.getElementById("style-font-size-range");
const styleFontSizeOut = document.getElementById("style-font-size-out");
const styleTextColor = document.getElementById("style-text-color");
const styleTextAlpha = document.getElementById("style-text-alpha");
const styleTextAlphaOut = document.getElementById("style-text-alpha-out");
const styleStrokeColor = document.getElementById("style-stroke-color");
const styleStrokeWidth = document.getElementById("style-stroke-width");
const styleStrokeWidthOut = document.getElementById("style-stroke-width-out");
const styleBgColor = document.getElementById("style-bg-color");
const styleBgOpacity = document.getElementById("style-bg-opacity");
const styleBgOpacityOut = document.getElementById("style-bg-opacity-out");
const styleBgSize = document.getElementById("style-bg-size");
const styleBgSizeOut = document.getElementById("style-bg-size-out");
const styleX = document.getElementById("style-x");
const styleXOut = document.getElementById("style-x-out");
const styleYRange = document.getElementById("style-y-range");
const styleYOut = document.getElementById("style-y-out");
const btnSaveProject = document.getElementById("btn-save-project");
const btnSaveProjectAs = document.getElementById("btn-save-project-as");
const btnUnloadModel = document.getElementById("btn-unload-model");
const btnLoadProject = document.getElementById("btn-load-project");
const btnPrepare = document.getElementById("btn-prepare");
const btnAddWatermark = document.getElementById("btn-add-watermark");
const btnAddFont = document.getElementById("btn-add-font");
const btnUndo = document.getElementById("btn-undo");
const btnRedo = document.getElementById("btn-redo");
/** Electron: 단어 구간 기반 재생 스케줄 */
globalThis.__AUTO_SUBTITLE_WORD_PLAYBACK__ = true;
const gpuInstallPrompt = document.getElementById("gpu-install-prompt");
const gpuInstallMessage = document.getElementById("gpu-install-message");
const btnGpuInstallRun = document.getElementById("btn-gpu-install-run");
const btnGpuInstallDismiss = document.getElementById("btn-gpu-install-dismiss");
const fontAddModal = document.getElementById("font-add-modal");
const fontAddTitle = document.getElementById("font-add-title");
const fontAddMessage = document.getElementById("font-add-message");
const fontAddTrack = document.getElementById("font-add-track");
const fontAddActions = document.getElementById("font-add-actions");
const btnFontAddOk = document.getElementById("btn-font-add-ok");
const watermarkPositionModal = document.getElementById("watermark-position-modal");
const watermarkPositionGrid = document.getElementById("watermark-position-grid");
const watermarkPositionDesc = document.getElementById("watermark-position-desc");
const btnWatermarkPositionCancel = document.getElementById("btn-watermark-position-cancel");
const btnWatermarkPositionConfirm = document.getElementById("btn-watermark-position-confirm");

let toolReady = false;
let modelLoaded = false;
let agentConnected = false;
let lastCues = [];
/** @type {{ start: number, end: number }[]} */
let lastCutRanges = [];
let lastExportPath = null;
let waveformLoading = false;
let selectedCueIndex = -1;
let expandedCueIndex = -1;
/** @type {ReturnType<typeof setTimeout> | null} */
let waveformChipCloseTimer = null;
let expandedWordIndex = -1;
/** @type {object | null} */
let peaksPayload = null;
let playheadSec = 0;
let playbackRafId = 0;
let isVideoPlaying = false;

/** RAF 루프와 무관하게 실제 미디어 재생 여부 */
function isPreviewMediaPlaying() {
  if (isVideoPlaying) return true;
  if (previewAudio && isHtmlAudioMasterActive()) {
    return !previewAudio.paused;
  }
  return Boolean(previewVideo && !previewVideo.paused);
}

/** 재생 클럭 — Whisper/RMS·피크·단어 블록과 동일한 오디오 축 (Electron masterAudio) */
function readPreviewMediaClockSec() {
  const skip = getPlaybackSkipRanges();
  if (previewAudio && isHtmlAudioMasterActive()) {
    const { mediaSec } = readHtmlAudioMasterPlayhead(previewAudio, { skipRanges: skip });
    if (mediaSec != null) return mediaSec;
  }
  if (previewVideo && Number.isFinite(previewVideo.currentTime)) {
    return previewVideo.currentTime;
  }
  return 0;
}

/** 일시정지 직전 — html-audio 마스터가 살아 있을 때 오디오 시계 우선 */
function capturePlayheadFromPreviewMedia() {
  const orch = getPlaybackOrchestrator();
  let media = null;
  if (
    isHtmlAudioMasterActive() &&
    previewAudio &&
    Number.isFinite(previewAudio.currentTime)
  ) {
    media = previewAudio.currentTime;
  } else if (previewVideo && Number.isFinite(previewVideo.currentTime)) {
    media = previewVideo.currentTime;
  } else if (previewAudio && Number.isFinite(previewAudio.currentTime)) {
    media = previewAudio.currentTime;
  }
  if (media == null) return;
  playheadSec = orch.mapMediaToEditSec(media);
}

/** Electron syncPausedMasterToEdit — 정지 시 미디어 시계를 playheadSec 에 맞춤 */
function syncPausedPreviewMediaToPlayhead() {
  if (!previewVideo || !Number.isFinite(playheadSec)) return;
  const orch = getPlaybackOrchestrator();
  const skip = getPlaybackSkipRanges();
  let media = skipCutRangeAt(orch.mapEditToMediaSec(playheadSec), skip);
  if (Number.isFinite(previewVideo.duration) && previewVideo.duration > 0) {
    media = Math.min(media, Math.max(0, previewVideo.duration - 0.001));
  }
  if (previewAudio?.src) {
    assignMasterAudioTimelineSecIfNeeded(previewAudio, media);
  }
  if (Math.abs(previewVideo.currentTime - media) > 0.002) {
    previewVideo.currentTime = media;
  }
  previewAudio?.pause();
  previewVideo.pause();
  playheadSec = orch.mapMediaToEditSec(media);
}

/** @param {number} startMediaSec */
function beginPreviewSyncedPlayback(startMediaSec) {
  const url = getPreviewMediaPlaybackUrl();
  if (!url || !previewVideo || !previewAudio) return false;
  masterMediaUrl = url;
  void startSyncedPlayback(url, previewVideo, previewAudio, {
    startMediaSec,
    skipRanges: getPlaybackSkipRanges(),
  });
  return true;
}

/** @type {number | null} 파형 ▶ 재생 시 편집축 종료 시각 */
let waveformPlayRangeEndEdit = null;
/** 삭제 직후 seek/play 지연 (AutoSubtitle armDeleteGuard) */
let deleteGuardUntil = 0;
let lastPlaybackCueIndex = -1;
let lastPlaybackWordIndex = -1;
let lastOverlayCueIndex = -1;
/** @type {{ path: string, position: string }} */
let watermarkConfig = { path: "", position: "" };
let pendingWatermarkPath = "";
let lastHighlightSelectedCue = -1;
let lastCommitMediaPlaying = false;
/** 재생 UI 갱신 스로틀 (~15fps) — 비디오 디코드와 분리 */
const PLAYHEAD_UI_COMMIT_MS = 66;
let lastPlayheadUiCommitWallMs = 0;
let lastExpandedPanelSyncWallMs = 0;
const EXPANDED_PANEL_SYNC_MS = 100;
let playbackLoopGeneration = 0;
let userRequestedPreviewPause = false;
let previewSeekDragging = false;
let previewResumeAfterSeek = false;
/** @type {AbortController | null} */
let previewMediaLoadAbort = null;
/** @type {string} */
let previewMediaDirectUrl = "";
/** @type {string} */
let previewMediaResolvedUrl = "";
let previewMediaLoadGen = 0;

function releasePreviewMediaBlob() {
  if (previewMediaDirectUrl) {
    revokeAgentMediaObjectUrl(previewMediaDirectUrl);
    previewMediaDirectUrl = "";
  }
  previewMediaResolvedUrl = "";
  if (previewMediaLoadAbort) {
    previewMediaLoadAbort.abort();
    previewMediaLoadAbort = null;
  }
}

/** 현재 작업에 묶인 영상 경로 (다른 파일 선택 시 자막 초기화) */
let sessionVideoPath = "";
/** @type {string | null} */
let masterMediaUrl = null;
/** 재생·피크·파형 축 SSOT (timeline_sec / 브라우저 duration) */
let sessionMediaDurationSec = null;
/** Whisper info.duration — pcm 피크 축과 다를 때 자막 시각 스케일용 */
let sessionWhisperDurationSec = null;
/** readiness.binaries.audiowaveform — false면 pcm_columns만 사용 */
let agentAudiowaveformAvailable = false;

const subtitleHub = new SubtitleAppHub({
  onStateChange: () => {
    syncHubFromState();
  },
});

function syncHubFromState() {
  lastCues = subtitleHub.cues;
  lastCutRanges = subtitleHub.cutRanges;
  persistCues();
  persistCuts();
  updateUndoRedoButtons();
  updateActionButtons();
  rebuildPlaybackSync();
  if (subtitleList) refreshExpandedPanelSkipRanges(subtitleList);
}

function rebuildPlaybackSync() {
  const orch = getPlaybackOrchestrator();
  const dur =
    previewVideo?.duration && Number.isFinite(previewVideo.duration)
      ? previewVideo.duration
      : 0;
  orch.rebuild(lastCues, getPlaybackSkipRanges(), dur);
}

function updateUndoRedoButtons() {
  if (btnUndo) btnUndo.disabled = !subtitleHub.canUndo();
  if (btnRedo) btnRedo.disabled = !subtitleHub.canRedo();
}

function persistCues() {
  try {
    sessionStorage.setItem(STORAGE_CUES, JSON.stringify(lastCues));
    const vp = videoPathInput?.value?.trim() || sessionVideoPath;
    if (vp) sessionStorage.setItem(STORAGE_VIDEO_PATH, vp);
  } catch {
    /* ignore */
  }
}

/** 자막·파형·컷만 비움 (영상 경로는 유지). 새 영상 / 경로 변경 시 호출 */
function clearSubtitleWorkspace() {
  subtitleHub.reset();
  lastCues = [];
  lastCutRanges = [];
  lastExportPath = null;
  selectedCueIndex = -1;
  expandedCueIndex = -1;
  expandedWordIndex = -1;
  peaksPayload = null;
  sessionMediaDurationSec = null;
  sessionWhisperDurationSec = null;
  try {
    sessionStorage.removeItem(STORAGE_CUES);
    sessionStorage.removeItem(STORAGE_CUTS);
    sessionStorage.removeItem(STORAGE_EXPORT_PATH);
  } catch {
    /* ignore */
  }
  if (subtitleList) subtitleList.innerHTML = "";
  stopPlaybackLoop();
  commitPlayheadUi();
  updateActionButtons();
}

function clampStylePercent(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

/** object-fit: contain 과 동일한 표시 영역 */
function computePreviewContainRect(containerW, containerH, mediaW, mediaH) {
  if (!(containerW > 0 && containerH > 0 && mediaW > 0 && mediaH > 0)) return null;
  const scale = Math.min(containerW / mediaW, containerH / mediaH);
  const width = mediaW * scale;
  const height = mediaH * scale;
  return {
    width,
    height,
    left: (containerW - width) / 2,
    top: (containerH - height) / 2,
    scale,
  };
}

function getPreviewNativeMediaSize() {
  const vw = previewVideo?.videoWidth || 0;
  const vh = previewVideo?.videoHeight || 0;
  if (vw > 0 && vh > 0) return { width: vw, height: vh };
  return { width: 1920, height: 1080 };
}

function layoutPreviewMediaFrame() {
  if (!previewSection || !previewMediaFrame) return null;
  const cw = previewSection.clientWidth;
  const ch = previewSection.clientHeight;
  const native = getPreviewNativeMediaSize();
  const rect = computePreviewContainRect(cw, ch, native.width, native.height);
  if (!rect) {
    previewMediaFrame.style.width = `${cw}px`;
    previewMediaFrame.style.height = `${ch}px`;
    previewMediaFrame.style.left = "0px";
    previewMediaFrame.style.top = "0px";
    return { scale: ch > 0 ? ch / native.height : 1, ...native };
  }
  previewMediaFrame.style.width = `${rect.width}px`;
  previewMediaFrame.style.height = `${rect.height}px`;
  previewMediaFrame.style.left = `${rect.left}px`;
  previewMediaFrame.style.top = `${rect.top}px`;
  return { scale: rect.scale, width: native.width, height: native.height };
}

function getPreviewOverlayScale(style) {
  const nativeH = style.videoHeight || previewVideo?.videoHeight || 1080;
  const frameH = previewMediaFrame?.clientHeight || 0;
  if (frameH > 0 && nativeH > 0) return frameH / nativeH;
  return 0.55;
}

function hexWithAlpha(hex, alpha255) {
  const h = String(hex || "#ffffff").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padStart(6, "0").slice(0, 6);
  const a = Math.max(0, Math.min(255, Number(alpha255) || 255));
  return `#${full}${a.toString(16).padStart(2, "0")}`;
}

function readSubtitleStyleFromDom() {
  const fontSize = Number(styleFontSizeRange?.value) || DEFAULT_SUBTITLE_STYLE.fontSize;
  const textAlpha = Number(styleTextAlpha?.value);
  const style = {
    ...DEFAULT_SUBTITLE_STYLE,
    fontFamily: styleFontFamily?.value?.trim() || DEFAULT_SUBTITLE_STYLE.fontFamily,
    fontSize,
    textColor: hexWithAlpha(styleTextColor?.value, textAlpha),
    strokeColor: styleStrokeColor?.value || DEFAULT_SUBTITLE_STYLE.strokeColor,
    strokeWidth: Number(styleStrokeWidth?.value) ?? DEFAULT_SUBTITLE_STYLE.strokeWidth,
    bgColor: styleBgColor?.value || DEFAULT_SUBTITLE_STYLE.bgColor,
    bgOpacity: Number(styleBgOpacity?.value) ?? DEFAULT_SUBTITLE_STYLE.bgOpacity,
    bgSize: Number(styleBgSize?.value) ?? DEFAULT_SUBTITLE_STYLE.bgSize,
    x: Number(styleX?.value) ?? DEFAULT_SUBTITLE_STYLE.x,
    y: Number(styleYRange?.value) ?? DEFAULT_SUBTITLE_STYLE.y,
  };
  const vw = previewVideo?.videoWidth;
  const vh = previewVideo?.videoHeight;
  if (vw > 0 && vh > 0) {
    style.videoWidth = vw;
    style.videoHeight = vh;
  }
  return style;
}

function normalizeWatermarkPosition(raw) {
  const pos = String(raw || DEFAULT_WATERMARK_POSITION).trim().toLowerCase();
  return WATERMARK_POSITIONS.some((item) => item.value === pos) ? pos : DEFAULT_WATERMARK_POSITION;
}

function normalizeWatermarkConfig(raw) {
  if (!raw || typeof raw !== "object") return { path: "", position: "" };
  const path = String(raw.path || "").trim();
  if (!path) return { path: "", position: "" };
  return { path, position: normalizeWatermarkPosition(raw.position) };
}

function watermarkImageUrl(path) {
  const p = String(path || "").trim();
  if (!p) return "";
  return `${getAgentOrigin()}${TOOL_PREFIX}/media/image?image_path=${encodeURIComponent(p)}`;
}

function computeWatermarkDisplaySize(videoW, videoH, imgW, imgH) {
  const fw = Math.max(1, Number(videoW) || 1920);
  const fh = Math.max(1, Number(videoH) || 1080);
  const iw = Math.max(1, Number(imgW) || 1);
  const ih = Math.max(1, Number(imgH) || 1);
  const maxW = Math.max(8, Math.round(fw * WATERMARK_MAX_WIDTH_RATIO));
  let scale = Math.min(1, maxW / iw);
  let outW = Math.max(1, Math.round(iw * scale));
  let outH = Math.max(1, Math.round(ih * scale));
  if (outH > fh) {
    scale = fh / outH;
    outW = Math.max(1, Math.round(outW * scale));
    outH = Math.max(1, Math.round(outH * scale));
  }
  return { width: outW, height: outH };
}

function layoutWatermarkPreviewImage(img, position) {
  if (!img?.naturalWidth) return;
  const native = getPreviewNativeMediaSize();
  const frame = layoutPreviewMediaFrame();
  if (!frame) return;
  const { width, height } = computeWatermarkDisplaySize(
    native.width,
    native.height,
    img.naturalWidth,
    img.naturalHeight,
  );
  img.style.maxWidth = "none";
  img.style.width = `${width * frame.scale}px`;
  img.style.height = `${height * frame.scale}px`;
  img.dataset.pos = normalizeWatermarkPosition(position);
}

function applyWatermarkFromProject(raw) {
  if (raw != null) {
    const next = normalizeWatermarkConfig(raw);
    if (next.path) watermarkConfig = next;
  }
  updatePreviewWatermark();
}

function updatePreviewWatermark() {
  if (!previewWatermarkOverlay) return;
  const { path, position } = watermarkConfig;
  if (!path) {
    previewWatermarkOverlay.hidden = true;
    previewWatermarkOverlay.setAttribute("aria-hidden", "true");
    previewWatermarkOverlay.replaceChildren();
    return;
  }
  const hasMedia = Boolean(previewVideo?.src || previewAudio?.src);
  if (!hasMedia) {
    previewWatermarkOverlay.hidden = true;
    previewWatermarkOverlay.setAttribute("aria-hidden", "true");
    return;
  }
  layoutPreviewMediaFrame();
  previewWatermarkOverlay.hidden = false;
  previewWatermarkOverlay.setAttribute("aria-hidden", "false");
  let img = previewWatermarkOverlay.querySelector("img");
  if (!img) {
    img = document.createElement("img");
    img.alt = "워터마크";
    img.decoding = "async";
    img.addEventListener("load", () => {
      layoutWatermarkPreviewImage(img, watermarkConfig.position);
    });
    previewWatermarkOverlay.replaceChildren(img);
  }
  const url = watermarkImageUrl(path);
  if (img.dataset.src !== url) {
    img.dataset.src = url;
    img.src = url;
  } else if (img.complete && img.naturalWidth) {
    layoutWatermarkPreviewImage(img, position);
  } else {
    img.dataset.pos = normalizeWatermarkPosition(position);
  }
}

function initWatermarkPositionGrid() {
  if (!watermarkPositionGrid || watermarkPositionGrid.childElementCount) return;
  for (const item of WATERMARK_POSITIONS) {
    const label = document.createElement("label");
    label.className = "watermark-position-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "watermark-position";
    input.value = item.value;
    if (item.value === DEFAULT_WATERMARK_POSITION) input.checked = true;
    label.appendChild(input);
    label.appendChild(document.createTextNode(item.label));
    watermarkPositionGrid.appendChild(label);
  }
}

function getSelectedWatermarkPosition() {
  const checked = watermarkPositionGrid?.querySelector('input[name="watermark-position"]:checked');
  return normalizeWatermarkPosition(checked?.value || DEFAULT_WATERMARK_POSITION);
}

function setSelectedWatermarkPosition(position) {
  const pos = normalizeWatermarkPosition(position);
  const input = watermarkPositionGrid?.querySelector(`input[name="watermark-position"][value="${pos}"]`);
  if (input instanceof HTMLInputElement) input.checked = true;
}

function closeWatermarkPositionModal() {
  if (!watermarkPositionModal) return;
  watermarkPositionModal.hidden = true;
  watermarkPositionModal.classList.remove("is-active");
  watermarkPositionModal.setAttribute("aria-hidden", "true");
  pendingWatermarkPath = "";
  syncInAppBusyShell();
}

function openWatermarkPositionModal(sourcePath) {
  const path = String(sourcePath || "").trim();
  if (!path || !watermarkPositionModal) return;
  pendingWatermarkPath = path;
  initWatermarkPositionGrid();
  setSelectedWatermarkPosition(watermarkConfig.position || DEFAULT_WATERMARK_POSITION);
  if (watermarkPositionDesc) {
    const name = path.split(/[/\\]/).pop() || path;
    watermarkPositionDesc.textContent = `${name}\n영상에 표시할 위치를 선택하세요.`;
  }
  closeGpuInstallModal();
  closeFontAddModal();
  setupLoading?.classList.remove("is-active");
  if (setupLoading) {
    setupLoading.hidden = true;
    setupLoading.setAttribute("aria-hidden", "true");
  }
  transcribeLoading?.classList.remove("is-active");
  if (transcribeLoading) {
    transcribeLoading.hidden = true;
    transcribeLoading.setAttribute("aria-hidden", "true");
  }
  watermarkPositionModal.hidden = false;
  watermarkPositionModal.classList.add("is-active");
  watermarkPositionModal.setAttribute("aria-hidden", "false");
  syncInAppBusyShell();
  btnWatermarkPositionConfirm?.focus({ preventScroll: true });
}

function confirmWatermarkPositionSelection() {
  const path = String(pendingWatermarkPath || "").trim();
  if (!path) {
    closeWatermarkPositionModal();
    return;
  }
  watermarkConfig = {
    path,
    position: getSelectedWatermarkPosition(),
  };
  pendingWatermarkPath = "";
  closeWatermarkPositionModal();
  updatePreviewWatermark();
  scheduleSaveUserPreferences();
}

async function addWatermarkFromDialog() {
  if (!agentConnected) {
    alert(`${LOCAL_HELPER_NAME}에 연결된 뒤 워터마크를 추가할 수 있습니다.`);
    return;
  }
  if (btnAddWatermark) btnAddWatermark.disabled = true;
  try {
    const res = await fetchAgent(`${getAgentOrigin()}/api/agent/pick-local-image-file`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    const pick = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(formatPickErrorDetail(pick, res.statusText));
      return;
    }
    const sourcePath = String(pick?.path || "").trim();
    if (!sourcePath || pick?.cancelled) return;
    openWatermarkPositionModal(sourcePath);
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  } finally {
    if (btnAddWatermark) btnAddWatermark.disabled = !agentConnected;
  }
}

function exportPhaseStepLabel(phase, fmt) {
  const label = exportFormatLabel(fmt || "srt");
  if (phase === "queued") return `${label} · 대기`;
  if (phase === "running") return `${label} · 처리 중`;
  if (phase === "completed") return `${label} · 완료`;
  if (phase === "failed") return `${label} · 실패`;
  return label;
}

function applySubtitleStyleFromProject(style) {
  if (!style || typeof style !== "object") return;
  if (styleFontFamily && style.fontFamily) {
    ensureFontSelectOption(style.fontFamily);
    styleFontFamily.value = style.fontFamily;
  }
  if (styleFontSizeRange && style.fontSize != null) {
    styleFontSizeRange.value = String(style.fontSize);
    if (styleFontSizeOut) styleFontSizeOut.textContent = `${style.fontSize}px`;
  }
  if (styleTextColor && style.textColor) {
    const tc = String(style.textColor);
    if (tc.length >= 7) styleTextColor.value = tc.slice(0, 7);
    if (tc.length === 9 && styleTextAlpha) {
      styleTextAlpha.value = String(parseInt(tc.slice(7, 9), 16));
      if (styleTextAlphaOut) styleTextAlphaOut.textContent = styleTextAlpha.value;
    }
  }
  if (styleStrokeColor && style.strokeColor) styleStrokeColor.value = style.strokeColor;
  if (styleStrokeWidth && style.strokeWidth != null) {
    styleStrokeWidth.value = String(style.strokeWidth);
    if (styleStrokeWidthOut) styleStrokeWidthOut.textContent = `${style.strokeWidth}px`;
  }
  if (styleBgColor && style.bgColor) styleBgColor.value = style.bgColor;
  if (styleBgOpacity && style.bgOpacity != null) {
    styleBgOpacity.value = String(style.bgOpacity);
    if (styleBgOpacityOut) styleBgOpacityOut.textContent = `${style.bgOpacity}%`;
  }
  if (styleBgSize && style.bgSize != null) {
    styleBgSize.value = String(style.bgSize);
    if (styleBgSizeOut) styleBgSizeOut.textContent = `${style.bgSize}%`;
  }
  if (styleX && style.x != null) {
    styleX.value = String(style.x);
    if (styleXOut) styleXOut.textContent = `${style.x}%`;
  }
  if (styleYRange && style.y != null) {
    styleYRange.value = String(style.y);
    if (styleYOut) styleYOut.textContent = `${style.y}%`;
  }
  updatePreviewOverlay();
}

function stripSubtitleStyleForStorage(style) {
  if (!style || typeof style !== "object") return null;
  const { videoWidth, videoHeight, ...rest } = style;
  return rest;
}

function collectUserPreferences() {
  return {
    version: USER_PREFS_VERSION,
    language: languageSelect?.value ?? "",
    exportFormat: exportFormatSelect?.value ?? "srt",
    subtitleStyle: stripSubtitleStyleForStorage(readSubtitleStyleFromDom()),
    watermark: watermarkConfig.path ? { ...watermarkConfig } : null,
  };
}

let saveUserPrefsTimer = 0;

function scheduleSaveUserPreferences() {
  window.clearTimeout(saveUserPrefsTimer);
  saveUserPrefsTimer = window.setTimeout(() => {
    saveUserPrefsTimer = 0;
    try {
      localStorage.setItem(STORAGE_USER_PREFS, JSON.stringify(collectUserPreferences()));
    } catch (err) {
      console.warn("[auto-subtitle] save user preferences", err);
    }
  }, 400);
}

function loadUserPreferences() {
  try {
    const raw = localStorage.getItem(STORAGE_USER_PREFS);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    if (data.version != null && Number(data.version) > USER_PREFS_VERSION) return null;
    return data;
  } catch {
    return null;
  }
}

function applyUserPreferences(prefs) {
  if (!prefs || typeof prefs !== "object") return;
  if (prefs.subtitleStyle) applySubtitleStyleFromProject(prefs.subtitleStyle);
  if (languageSelect && prefs.language != null) {
    const lang = String(prefs.language);
    const has = Array.from(languageSelect.options).some((o) => o.value === lang);
    if (has) languageSelect.value = lang;
  }
  if (exportFormatSelect && prefs.exportFormat) {
    const fmt = String(prefs.exportFormat);
    const has = Array.from(exportFormatSelect.options).some((o) => o.value === fmt);
    if (has) exportFormatSelect.value = fmt;
  }
  if (prefs.watermark) applyWatermarkFromProject(prefs.watermark);
}

function loadAndApplyUserPreferences() {
  const prefs = loadUserPreferences();
  if (prefs) applyUserPreferences(prefs);
}

function attachUserPreferencesAutosave() {
  const save = () => scheduleSaveUserPreferences();
  styleFontFamily?.addEventListener("change", save);
  languageSelect?.addEventListener("change", save);
  exportFormatSelect?.addEventListener("change", save);
  for (const id of [
    "style-font-size-range",
    "style-text-alpha",
    "style-stroke-width",
    "style-bg-opacity",
    "style-bg-size",
    "style-x",
    "style-y-range",
  ]) {
    const el = document.getElementById(id);
    el?.addEventListener("input", save);
    el?.addEventListener("change", save);
  }
  styleTextColor?.addEventListener("input", save);
  styleStrokeColor?.addEventListener("input", save);
  styleBgColor?.addEventListener("input", save);
}

function syncCuesFromDom() {
  if (subtitleList) {
    const read = readCuesFromCards(subtitleList, lastCues);
    subtitleHub.setCues(syncAllCuesFromWords(read), { recordHistory: false });
  }
}

function getPlaybackSkipRanges() {
  return subtitleHub.getPlaybackSkipRanges();
}

function getMediaStreamUrl() {
  const p = videoPathInput?.value?.trim() || sessionVideoPath;
  if (!p || !agentConnected) return null;
  return `${getAgentOrigin()}${TOOL_PREFIX}/media/stream?video_path=${encodeURIComponent(p)}`;
}

function getPreviewMediaPlaybackUrl() {
  if (previewMediaResolvedUrl) return previewMediaResolvedUrl;
  return getMediaStreamUrl();
}

function getPreviewCueIndex() {
  if (isPreviewMediaPlaying()) {
    const { ai } = resolvePlaybackIndices(playheadSec);
    return ai;
  }
  const caretIdx = getFocusedSubtitleCardIndex();
  if (caretIdx >= 0 && lastCues[caretIdx] && !lastCues[caretIdx].is_silence) {
    if (caretIdx !== selectedCueIndex) {
      // console.log("[PREVIEW-IDX] caret=%d vs selected=%d (caret wins)", caretIdx, selectedCueIndex);
    }
    return caretIdx;
  }
  if (selectedCueIndex >= 0 && lastCues[selectedCueIndex] && !lastCues[selectedCueIndex].is_silence) {
    return selectedCueIndex;
  }
  const { ai } = resolvePlaybackIndices(playheadSec);
  return ai;
}

function getActiveCueForPreview() {
  const ai = getPreviewCueIndex();
  return ai >= 0 ? lastCues[ai] : null;
}

function getPreviewCueText(cue) {
  if (!cue) return "";
  const previewIdx = getPreviewCueIndex();
  if (previewIdx >= 0 && subtitleList) {
    const ta = subtitleList.querySelector(
      `.subtitle-card[data-cue-index="${previewIdx}"] .subtitle-card-textarea`,
    );
    if (ta instanceof HTMLTextAreaElement) {
      const live = normalizePreviewSubtitleText(ta.value);
      if (live) return live;
    }
  }
  ensureCueWords(cue);
  return normalizePreviewSubtitleText(subtitleLineEditDisplayText(cue));
}

function armDeleteGuard(ms = 280) {
  const now = performance.now();
  const requestedUntil = now + ms;
  deleteGuardUntil =
    deleteGuardUntil > now
      ? Math.min(requestedUntil, deleteGuardUntil + 120)
      : requestedUntil;
}

function isDeleteGuardActive() {
  return performance.now() < deleteGuardUntil;
}

/** @param {object} cue @param {number} storageWordIndex */
function editSecForStorageWord(cue, storageWordIndex) {
  ensureCueWords(cue);
  const words = cue.words ?? [];
  let editSec = cue.start ?? 0;
  const vis = visibleWordStorageIndices(words);
  const skips = getPlaybackSkipRanges();
  if (vis.length) {
    const c = Math.max(0, Math.min(storageWordIndex, words.length));
    let pick = vis.find((i) => i >= c);
    if (pick == null) pick = vis[vis.length - 1];
    const word = words[pick];
    editSec = playableEditSecForWord(word, skips) ?? word?.start ?? editSec;
  }
  return editSec;
}

/** @param {number} editSec */
function seekEditSecAndPlay(editSec) {
  if (!previewVideo || !previewAudio || !Number.isFinite(editSec)) return false;
  const orch = getPlaybackOrchestrator();
  const media = skipCutRangeAt(orch.mapEditToMediaSec(editSec), getPlaybackSkipRanges());
  orch.seekMediaSec(media);
  playheadSec = orch.mapMediaToEditSec(media);
  commitPlayheadUi();
  startPlaybackLoop();
  // console.log("[PLAY-DBG] seekEditSecAndPlay done: isVideoPlaying=%s, rafId=%s", isVideoPlaying, playbackRafId);
  return true;
}

function closeWordWaveform({ restoreFocus = true } = {}) {
  const prevCue = expandedCueIndex;
  const prevWord = expandedWordIndex;
  waveformPlayRangeEndEdit = null;
  if (waveformChipCloseTimer != null) {
    clearTimeout(waveformChipCloseTimer);
    waveformChipCloseTimer = null;
  }
  expandedCueIndex = -1;
  expandedWordIndex = -1;
  renderCuesTable(lastCues, { capturePendingEdits: true });
  if (restoreFocus && prevCue >= 0 && subtitleList) {
    const cue = lastCues[prevCue];
    ensureCueWords(cue ?? {});
    const words = cue?.words ?? [];
    const storageCaret =
      prevWord >= 0 ? nearestValidStorageCaret(words, prevWord) : nearestValidStorageCaret(words, 0);
    requestFocusCaretDeferred(
      subtitleList,
      lastCues,
      buildSubtitleCardOpts(lastCues),
      prevCue,
      storageCaret,
      { seek: false, armSpaceSeek: false },
    );
  }
}

function formatPreviewClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

function getPreviewEditDurationSec() {
  const mediaDur = getMediaDurationSecHint();
  if (!(mediaDur > 0)) return 0;
  try {
    const orch = getPlaybackOrchestrator();
    if (orch?.mapMediaToEditSec) {
      return Math.max(0, orch.mapMediaToEditSec(Math.max(0, mediaDur - 0.001)));
    }
  } catch {
    /* ignore */
  }
  return mediaDur;
}

function updatePreviewTransportAvailability() {
  const hasMedia = Boolean(previewVideo?.src);
  if (btnPreviewPlay) btnPreviewPlay.disabled = !hasMedia;
  if (previewSeek) previewSeek.disabled = !hasMedia;
}

function updatePreviewTransportUi() {
  updatePreviewTransportAvailability();
  const dur = getPreviewEditDurationSec();
  const current = Math.max(0, Number(playheadSec) || 0);
  if (previewTimeCurrent) previewTimeCurrent.textContent = formatPreviewClock(current);
  if (previewTimeTotal) previewTimeTotal.textContent = formatPreviewClock(dur);
  if (previewSeek && !previewSeekDragging) {
    const pct = dur > 0 ? Math.round((current / dur) * 1000) : 0;
    previewSeek.value = String(Math.max(0, Math.min(1000, pct)));
  }
}

/** @param {number} editSec @param {{ resumePlayback?: boolean }} [opts] */
function seekPreviewToEditSec(editSec, opts = {}) {
  if (!previewVideo || !Number.isFinite(editSec)) return;
  const dur = getPreviewEditDurationSec();
  const clamped = dur > 0 ? Math.max(0, Math.min(dur, editSec)) : Math.max(0, editSec);
  playheadSec = clamped;
  syncPausedPreviewMediaToPlayhead();
  commitPlayheadUi();
  if (opts.resumePlayback) startPlaybackLoop();
}

function applyPreviewSeekFromControl() {
  const dur = getPreviewEditDurationSec();
  if (!(dur > 0) || !previewSeek) return;
  const pct = Number(previewSeek.value) / 1000;
  playheadSec = pct * dur;
  syncPausedPreviewMediaToPlayhead();
  updatePreviewTransportUi();
  updatePreviewOverlay();
}

function setPreviewPlaybackUiActive(active) {
  previewSection?.classList.toggle("is-media-playing", active);
  if (btnPreviewPlay) {
    btnPreviewPlay.textContent = active ? "⏸" : "▶";
    btnPreviewPlay.setAttribute("aria-label", active ? "일시정지" : "재생");
    btnPreviewPlay.classList.toggle("is-playing", active);
  }
  if (previewVideo) {
    previewVideo.controls = false;
    previewVideo.removeAttribute("controls");
  }
  updatePreviewTransportUi();
}

/**
 * @param {number} t
 * @returns {{ ai: number, wi: number }}
 */
function resolvePlaybackIndices(t) {
  const ai = pickActiveCueIndexWithHint(lastCues, t, lastPlaybackCueIndex);
  const cue = ai >= 0 ? lastCues[ai] : null;
  const wi = cue ? pickActiveWordIndex(cue, t) : -1;
  return { ai, wi };
}

function commitPlayheadUi({
  scrollActiveCard = false,
  activeCueIndex,
  activeWordIndex,
} = {}) {
  const t = playheadSec;
  const mediaPlaying = isPreviewMediaPlaying();
  const ai =
    typeof activeCueIndex === "number"
      ? activeCueIndex
      : mediaPlaying
        ? pickActiveCueIndexWithHint(lastCues, t, lastPlaybackCueIndex)
        : selectedCueIndex;
  const cue = ai >= 0 ? lastCues[ai] : null;
  const wi =
    typeof activeWordIndex === "number"
      ? activeWordIndex
      : cue && mediaPlaying
        ? pickActiveWordIndex(cue, t)
        : -1;

  const cueChanged = ai !== lastPlaybackCueIndex;
  const wordChanged = wi !== lastPlaybackWordIndex;
  const selectionChanged = selectedCueIndex !== lastHighlightSelectedCue;
  const playStateChanged = mediaPlaying !== lastCommitMediaPlaying;

  lastPlaybackCueIndex = ai;
  lastPlaybackWordIndex = wi;

  const previewIdx = getPreviewCueIndex();
  if (previewIdx !== lastOverlayCueIndex) {
    updatePreviewOverlay();
    // console.log("[PREVIEW-DBG] overlay updated: idx=%d→%d, playing=%s, text=%s",
    //   lastOverlayCueIndex, previewIdx, mediaPlaying,
    //   getPreviewCueText(lastCues[previewIdx])?.slice(0, 25));
    lastOverlayCueIndex = previewIdx;
  }

  const highlightNeedsUpdate =
    cueChanged || wordChanged || selectionChanged || playStateChanged;

  if (mediaPlaying) {
    if (highlightNeedsUpdate) {
      updatePlaybackHighlights(subtitleList, lastCues, {
        playheadSec: t,
        isPlaying: true,
        selectedCueIndex,
        activeCueIndex: ai,
      });
    }
    if (scrollActiveCard && cueChanged && subtitleList && ai >= 0) {
      scrollCueIntoView(subtitleList, lastCues, buildSubtitleCardOpts(lastCues), ai, {
        behavior: "auto",
      });
    }
  } else if (selectedCueIndex >= 0) {
    if (selectionChanged || playStateChanged) {
      updatePlaybackHighlights(subtitleList, lastCues, {
        playheadSec: t,
        isPlaying: false,
        selectedCueIndex,
      });
    }
    lastOverlayCueIndex = -1;
  } else if (playStateChanged) {
    updatePlaybackHighlights(subtitleList, lastCues, {
      playheadSec: t,
      isPlaying: false,
      selectedCueIndex: -1,
    });
    lastOverlayCueIndex = -1;
  }

  lastHighlightSelectedCue = selectedCueIndex;
  lastCommitMediaPlaying = mediaPlaying;

  if (playStateChanged && subtitleList) {
    syncPlaybackCaretVisibility(subtitleList, lastCues, mediaPlaying);
  }

  const wall = performance.now();
  const panelOpen = expandedCueIndex >= 0 && expandedWordIndex >= 0;
  if (panelOpen) {
    if (mediaPlaying && waveformPlayRangeEndEdit != null) {
      syncExpandedPanelPlayhead(subtitleList, {
        expandedCueIndex,
        expandedWordIndex,
        playheadEditSec: t,
        mediaPlaying: true,
      });
    } else if (
      highlightNeedsUpdate ||
      wall - lastExpandedPanelSyncWallMs >= EXPANDED_PANEL_SYNC_MS
    ) {
      lastExpandedPanelSyncWallMs = wall;
      syncExpandedPanelPlayhead(subtitleList, {
        expandedCueIndex,
        expandedWordIndex,
      });
    }
  }

  if (!previewSeekDragging) updatePreviewTransportUi();
}

function playbackTick() {
  if (!previewVideo) {
    stopPlaybackLoop();
    return;
  }

  const skip = getPlaybackSkipRanges();
  const skipOpts = { skipRanges: skip };

  if (previewAudio && isHtmlAudioMasterActive()) {
    if (previewAudio.paused) {
      if (isVideoPlaying) {
        if (previewAudio.readyState >= 3) {
          previewAudio.play().then(() => {
            if (previewVideo && previewVideo.paused) {
              previewVideo.play().catch(() => {});
            }
          }).catch(() => {});
        }
        playbackRafId = requestAnimationFrame(playbackTick);
      } else {
        playbackRafId = 0;
      }
      return;
    }
    syncVideoFromHtmlAudioMaster(previewVideo, previewAudio, skipOpts);
  } else if (previewVideo.paused) {
    playbackRafId = 0;
    return;
  } else {
    applyThrottledVideoSkipCut(previewVideo, skip);
  }

  const orch = getPlaybackOrchestrator();
  const media = readPreviewMediaClockSec();
  playheadSec = orch.mapMediaToEditSec(media);

  const { ai, wi } = resolvePlaybackIndices(playheadSec);
  const cueChanged = ai !== lastPlaybackCueIndex;
  const wordChanged = wi !== lastPlaybackWordIndex;

  if (
    waveformPlayRangeEndEdit != null &&
    playheadSec >= waveformPlayRangeEndEdit - 0.02
  ) {
    previewAudio?.pause();
    previewVideo.pause();
    stopPlaybackLoop({ waveformRangeNaturalEnd: true });
    commitPlayheadUi({ activeCueIndex: ai, activeWordIndex: wi });
    return;
  }

  if (
    waveformPlayRangeEndEdit != null &&
    expandedCueIndex >= 0 &&
    expandedWordIndex >= 0
  ) {
    syncExpandedPanelPlayhead(subtitleList, {
      expandedCueIndex,
      expandedWordIndex,
      playheadEditSec: playheadSec,
      mediaPlaying: true,
    });
  }

  const wall = performance.now();
  const uiDue = wall - lastPlayheadUiCommitWallMs >= PLAYHEAD_UI_COMMIT_MS;
  if (cueChanged || wordChanged || uiDue) {
    lastPlayheadUiCommitWallMs = wall;
    commitPlayheadUi({ activeCueIndex: ai, activeWordIndex: wi });
  }

  playbackRafId = requestAnimationFrame(playbackTick);
}

function startPlaybackLoop(opts = {}) {
  if (isDeleteGuardActive()) {
    // console.log("[PLAY-DBG] startLoop DELAYED (deleteGuard active)");
    window.setTimeout(() => startPlaybackLoop(opts), 35);
    return;
  }
  if (!previewVideo || !previewAudio) { /* console.log("[PLAY-DBG] startLoop ABORT: no media"); */ return; }
  if (isVideoPlaying && playbackRafId) { /* console.log("[PLAY-DBG] startLoop SKIP: already playing"); */ return; }

  if (playbackRafId) {
    cancelAnimationFrame(playbackRafId);
    playbackRafId = 0;
  }

  if (!opts.fromWaveformRange) {
    waveformPlayRangeEndEdit = null;
  }

  playbackLoopGeneration += 1;
  isVideoPlaying = true;
  setPreviewPlaybackUiActive(true);
  resetKeyboardPauseCaret();
  resetSpaceSeekIntent();
  resetPlaybackSkipThrottle();
  lastPlayheadUiCommitWallMs = 0;
  lastExpandedPanelSyncWallMs = 0;
  if (subtitleList) syncPlaybackCaretVisibility(subtitleList, lastCues, true);
  if (waveformChipCloseTimer != null) {
    clearTimeout(waveformChipCloseTimer);
    waveformChipCloseTimer = null;
  }

  stopSyncedPlayback(previewVideo, previewAudio);

  const orch = getPlaybackOrchestrator();
  orch.suspendSyncEngineForWebAudio();

  const skip = getPlaybackSkipRanges();
  let media = skipCutRangeAt(orch.mapEditToMediaSec(playheadSec), skip);
  if (previewVideo?.duration && Number.isFinite(previewVideo.duration) && previewVideo.duration > 0) {
    media = Math.min(media, Math.max(0, previewVideo.duration - 0.001));
  }
  if (previewAudio?.src) {
    assignMasterAudioTimelineSecIfNeeded(previewAudio, media);
  }
  if (previewVideo && Math.abs(previewVideo.currentTime - media) > 0.002) {
    previewVideo.currentTime = media;
  }
  playheadSec = orch.mapMediaToEditSec(media);

  // console.log("[PLAY-DBG] startLoop: beginSyncedPlayback media=%.3f, audio.paused=%s, audio.readyState=%d, audio.src=%s",
  //   media, previewAudio?.paused, previewAudio?.readyState, previewAudio?.src ? "set" : "empty");
  beginPreviewSyncedPlayback(media);
  playbackTick._stallLogged = null;
  playbackTick();
}

/**
 * 재생 중 Space/정지 — playhead 가 속한 단어 블록 앞에 캐럿 (Electron SubtitleVirtualList pause effect).
 *
 * @param {number} pausedAtCue
 * @param {number} pausedAtWord
 * @param {{ ai: number, wi: number }} resolvedPause
 * @param {boolean} wasWaveformRange
 */
function syncPauseCaretAtPlayhead(pausedAtCue, pausedAtWord, resolvedPause, wasWaveformRange) {
  if (!subtitleList || !lastCues.length) return;

  let pauseAi = pausedAtCue >= 0 ? pausedAtCue : resolvedPause.ai;
  if (pauseAi < 0) pauseAi = pickActiveCueIndex(lastCues, playheadSec);
  if (pauseAi < 0 && selectedCueIndex >= 0) pauseAi = selectedCueIndex;
  if (pauseAi < 0) return;

  let caretEditSec = playheadSec;
  if (wasWaveformRange && expandedCueIndex >= 0 && pauseAi === expandedCueIndex) {
    const panelCutSec = getExpandedPanelCutEditSec(subtitleList, expandedCueIndex);
    if (Number.isFinite(panelCutSec)) caretEditSec = panelCutSec;
  }

  let pauseWi =
    pausedAtWord >= 0 && pausedAtCue === pauseAi ? pausedAtWord : resolvedPause.wi;
  if (pauseWi < 0 && lastCues[pauseAi]) {
    pauseWi = pickActiveWordIndex(lastCues[pauseAi], caretEditSec);
  }

  const detail = pauseWi >= 0 ? { forceStorageWordIndex: pauseWi } : {};
  syncCaretOnPlaybackPause(
    subtitleList,
    lastCues,
    buildSubtitleCardOpts(lastCues),
    pauseAi,
    caretEditSec,
    detail,
  );
}

function stopPlaybackLoop(opts = {}) {
  const wasMediaPlaying = isVideoPlaying || playbackRafId || isPreviewMediaPlaying();
  if (!wasMediaPlaying) return;
  // console.trace("[PLAY-DBG] stopPlaybackLoop called");
  const wasWaveformRange = waveformPlayRangeEndEdit != null;
  const shouldSyncPauseCaret =
    opts.waveformRangeNaturalEnd !== true && subtitleList && lastCues.length;
  playbackLoopGeneration += 1;
  isVideoPlaying = false;
  setPreviewPlaybackUiActive(false);
  waveformPlayRangeEndEdit = null;
  const pausedAtCue = lastPlaybackCueIndex;
  const pausedAtWord = lastPlaybackWordIndex;
  capturePlayheadFromPreviewMedia();
  const resolvedPause = resolvePlaybackIndices(playheadSec);
  if (playbackRafId) {
    cancelAnimationFrame(playbackRafId);
    playbackRafId = 0;
  }
  if (previewVideo) stopSyncedPlayback(previewVideo, previewAudio ?? undefined);
  syncPausedPreviewMediaToPlayhead();
  lastPlaybackCueIndex = -1;
  lastPlaybackWordIndex = -1;
  lastOverlayCueIndex = -1;
  if (wasWaveformRange && expandedCueIndex >= 0 && expandedWordIndex >= 0) {
    finishExpandedPanelRangePlay(subtitleList, {
      expandedCueIndex,
      expandedWordIndex,
      rewindToTrimStart: opts.waveformRangeNaturalEnd === true,
      playheadEditSec: opts.waveformRangeNaturalEnd === true ? undefined : playheadSec,
    });
  }
  commitPlayheadUi();
  if (shouldSyncPauseCaret) {
    syncPauseCaretAtPlayhead(pausedAtCue, pausedAtWord, resolvedPause, wasWaveformRange);
  }
  if (subtitleList) syncPlaybackCaretVisibility(subtitleList, lastCues, false);
}

/**
 * @param {{ showCaretOnPause?: boolean, playFromCaret?: boolean }} [opts]
 */
function applyPlaybackSkipIfNeeded() {
  applyPlaybackSkipToPreviewMedia(previewVideo, previewAudio, {
    skipRanges: getPlaybackSkipRanges(),
  });
}

function togglePreviewPlayback(opts = {}) {
  if (!previewVideo) return;
  const playing = isPreviewMediaPlaying() || isVideoPlaying;
  if (playing) {
    // console.log("[PLAY-DBG] toggle → PAUSE");
    // console.trace("[PLAY-DBG] PAUSE call stack");
    userRequestedPreviewPause = true;
    stopPlaybackLoop();
    userRequestedPreviewPause = false;
    return;
  }
  // console.log("[PLAY-DBG] toggle → PLAY (selectedCue=%d)", selectedCueIndex);
  resetSpaceSeekIntent();
  if (!isVideoPlaying) startPlaybackLoop();
}

/** @param {number} cardIndex @param {number} storageCaret */
function playAtSubtitleCaret(cardIndex, storageCaret) {
  waveformPlayRangeEndEdit = null;
  const cue = lastCues[cardIndex];
  if (!cue) { /* console.log("[PLAY-DBG] playAtCaret: no cue at %d", cardIndex); */ return; }
  const editSec = editSecForStorageWord(cue, storageCaret);
  if (!Number.isFinite(editSec)) { /* console.log("[PLAY-DBG] playAtCaret: bad editSec for card=%d", cardIndex); */ return; }
  // console.log("[PLAY-DBG] playAtCaret: card=%d, editSec=%.2f, text=%s", cardIndex, editSec, getPreviewCueText(cue)?.slice(0, 20));
  selectCueLine(cardIndex, { seek: false, scroll: false, rerender: false });
  seekEditSecAndPlay(editSec);
}

function updatePreviewOverlay() {
  if (!previewOverlay) return;
  layoutPreviewMediaFrame();
  const cue = getActiveCueForPreview();
  const previewText = normalizePreviewSubtitleText(getPreviewCueText(cue));
  const style = readSubtitleStyleFromDom();
  if (!cue || !previewText) {
    previewOverlay.hidden = true;
    previewOverlay.replaceChildren();
    updatePreviewWatermark();
    return;
  }
  const scale = getPreviewOverlayScale(style);
  const { fontSize: previewFontSize, strokeWidth: previewStrokeWidth, chrome, position } =
    buildSubtitleOverlayInnerStyle(style, scale);
  const bgAlpha = Math.max(0, Math.min(1, (style.bgOpacity ?? 60) / 100));
  previewOverlay.hidden = false;
  previewOverlay.replaceChildren();

  const inner = document.createElement("div");
  inner.className = "as-preview-overlay-inner";
  inner.textContent = previewText;
  inner.style.top = position.top;
  inner.style.left = position.left;
  inner.style.right = position.right;
  inner.style.transform = position.transform;
  inner.style.textAlign = position.textAlign;
  inner.style.display = "inline-block";
  inner.style.fontFamily = `'${(style.fontFamily || "Malgun Gothic").replace(/'/g, "\\'")}', 'Malgun Gothic', sans-serif`;
  inner.style.fontSize = `${previewFontSize}px`;
  inner.style.fontWeight = String(style.fontWeight || 700);
  inner.style.color = style.textColor || "#fff";
  inner.style.webkitTextStroke = `${previewStrokeWidth}px ${style.strokeColor || "#000"}`;
  inner.style.paintOrder = "stroke fill";
  inner.style.background = hexWithAlpha(style.bgColor, Math.round(bgAlpha * 255));
  inner.style.padding = chrome.padding;
  inner.style.lineHeight = String(chrome.lineHeight);
  inner.style.borderRadius = `${chrome.borderRadius}px`;
  inner.style.border = chrome.border;
  inner.style.boxSizing = chrome.boxSizing;
  previewOverlay.appendChild(inner);
  applySubtitleOverlayTextLayout(inner, previewOverlay);
  updatePreviewWatermark();
}

setPreviewOverlaySyncHook((cardIndex) => {
  if (
    cardIndex >= 0 &&
    cardIndex !== selectedCueIndex &&
    lastCues[cardIndex] &&
    !lastCues[cardIndex].is_silence
  ) {
    const prev = selectedCueIndex;
    selectedCueIndex = cardIndex;
    if (subtitleList) patchSelectedCueHighlight(subtitleList, prev, cardIndex);
    lastOverlayCueIndex = -1;
    updatePreviewOverlay();
    // console.log("[SYNC-HOOK] navigate → card=%d, text=%s",
    //   cardIndex, getPreviewCueText(lastCues[cardIndex])?.slice(0, 25));
  } else if (lastOverlayCueIndex !== cardIndex) {
    lastOverlayCueIndex = -1;
    updatePreviewOverlay();
  }
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ensureFontSelectOption(name) {
  if (!styleFontFamily) return;
  const n = String(name || "").trim();
  if (!n) return;
  const exists = Array.from(styleFontFamily.options).some((o) => o.value === n);
  if (exists) return;
  const opt = document.createElement("option");
  opt.value = n;
  opt.textContent = n;
  styleFontFamily.appendChild(opt);
}

function populateFontSelect(fontNames, { preserveValue = true } = {}) {
  if (!styleFontFamily) return;
  const prev = preserveValue ? styleFontFamily.value : "";
  const merged = [];
  const seen = new Set();
  const add = (name) => {
    const n = String(name || "").trim();
    if (!n) return;
    const key = n.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(n);
  };
  add("Malgun Gothic");
  SYSTEM_FONT_CANDIDATES.forEach(add);
  (fontNames || []).forEach(add);
  merged.sort((a, b) => a.localeCompare(b, "ko"));
  styleFontFamily.replaceChildren();
  for (const name of merged) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    styleFontFamily.appendChild(opt);
  }
  if (prev && merged.includes(prev)) {
    styleFontFamily.value = prev;
  } else if (merged.includes("Malgun Gothic")) {
    styleFontFamily.value = "Malgun Gothic";
  } else if (merged.length) {
    styleFontFamily.value = merged[0];
  }
  syncFontSelectTitle();
}

function syncFontSelectTitle() {
  if (!styleFontFamily) return;
  const label =
    styleFontFamily.options[styleFontFamily.selectedIndex]?.textContent?.trim() ||
    styleFontFamily.value?.trim() ||
    "";
  styleFontFamily.title = label;
}

let customFontCatalog = [];

/** @type {HTMLStyleElement | null} */
let customFontFacesEl = null;

function injectCustomFontFaces(customFonts) {
  if (!customFontFacesEl) {
    customFontFacesEl = document.createElement("style");
    customFontFacesEl.id = "as-custom-font-faces";
    document.head.appendChild(customFontFacesEl);
  }
  const origin = getAgentOrigin();
  const rules = (customFonts || [])
    .map((f) => {
      const family = String(f?.family || "").trim();
      const url = String(f?.url || "").trim();
      if (!family || !url) return "";
      const abs = /^https?:\/\//i.test(url) ? url : `${origin}${url.startsWith("/") ? url : `/${url}`}`;
      return `@font-face{font-family:${JSON.stringify(family)};src:url(${JSON.stringify(abs)});font-display:swap;}`;
    })
    .filter(Boolean);
  customFontFacesEl.textContent = rules.join("\n");
}

async function ensureCustomFontsLoaded(customFonts, preferredFamily = "") {
  injectCustomFontFaces(customFonts);
  const loads = [];
  for (const f of customFonts || []) {
    const family = String(f?.family || "").trim();
    if (!family) continue;
    loads.push(document.fonts.load(`700 16px ${JSON.stringify(family)}`).catch(() => {}));
  }
  const pref = String(preferredFamily || "").trim();
  if (pref && !(customFonts || []).some((f) => f?.family === pref)) {
    loads.push(document.fonts.load(`700 16px ${JSON.stringify(pref)}`).catch(() => {}));
  }
  if (loads.length) await Promise.all(loads);
  await document.fonts.ready;
}

async function loadSystemFontsFromAgent({ selectFamily = "" } = {}) {
  if (!agentConnected) return;
  try {
    const data = await requestAgent({ path: `${TOOL_PREFIX}/system-fonts` });
    const fonts = Array.isArray(data?.fonts) ? data.fonts : [];
    customFontCatalog = Array.isArray(data?.custom_fonts) ? data.custom_fonts : [];
    await ensureCustomFontsLoaded(customFontCatalog, selectFamily || styleFontFamily?.value || "");
    if (fonts.length) populateFontSelect(fonts);
    if (selectFamily) {
      ensureFontSelectOption(selectFamily);
      if (styleFontFamily) styleFontFamily.value = selectFamily;
      syncFontSelectTitle();
    }
  } catch (err) {
    console.warn("[auto-subtitle] system-fonts", err);
    populateFontSelect(SYSTEM_FONT_CANDIDATES);
  }
}

async function addCustomFontFromDialog() {
  if (!agentConnected) {
    openFontAddModal({
      title: "폰트 추가",
      message: `${LOCAL_HELPER_NAME}에 연결된 뒤 폰트를 추가할 수 있습니다.`,
      showOk: true,
    });
    return;
  }
  if (btnAddFont) btnAddFont.disabled = true;
  try {
    const res = await fetchAgent(`${getAgentOrigin()}/api/agent/pick-local-font-file`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    const pick = await res.json().catch(() => ({}));
    if (!res.ok) {
      openFontAddModal({
        title: "폰트 추가 실패",
        message: formatPickErrorDetail(pick, res.statusText),
        showOk: true,
      });
      return;
    }
    const sourcePath = String(pick?.path || "").trim();
    if (!sourcePath || pick?.cancelled) return;

    openFontAddModal({
      title: "폰트 추가",
      message: "글꼴 파일을 복사하고 등록하는 중…",
      loading: true,
    });

    const installed = await requestAgent({
      path: `${TOOL_PREFIX}/custom-fonts/install`,
      method: "POST",
      json: { source_path: sourcePath },
    });
    const family = String(installed?.family || "").trim();
    if (!family) {
      await loadSystemFontsFromAgent();
      openFontAddModal({
        title: "폰트 추가",
        message: "글꼴을 추가했지만 패밀리 이름을 확인하지 못했습니다.",
        showOk: true,
      });
      return;
    }
    await loadSystemFontsFromAgent({ selectFamily: family });
    updatePreviewOverlay();
    scheduleSaveUserPreferences();
    openFontAddModal({
      title: "폰트 추가 완료",
      message: `${family}\n저장 위치: ${installed?.fonts_dir || "C:\\ProgramData\\Itmatzip\\Font"}`,
      showOk: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    openFontAddModal({
      title: "폰트 추가 실패",
      message: msg,
      showOk: true,
    });
  } finally {
    if (btnAddFont) btnAddFont.disabled = !agentConnected;
  }
}

function bindStyleControl(id, outEl, fmt) {
  const el = document.getElementById(id);
  if (!el) return;
  const sync = () => {
    if (outEl) outEl.textContent = fmt(el);
    updatePreviewOverlay();
  };
  el.addEventListener("input", sync);
  sync();
}

function selectCueLine(cueIndex, { scroll = true, seek = true, rerender = true } = {}) {
  const prevSelected = selectedCueIndex;
  selectedCueIndex = cueIndex;
  const cue = lastCues[cueIndex];
  if (!cue || cue.is_silence) {
    if (rerender) {
      renderCuesTable(lastCues, { capturePendingEdits: true });
    } else if (prevSelected !== cueIndex && subtitleList) {
      patchSelectedCueHighlight(subtitleList, prevSelected, cueIndex);
    }
    commitPlayheadUi();
    return;
  }
  ensureCueWords(cue);
  if (seek && previewVideo && Number.isFinite(cue.start)) {
    const orch = getPlaybackOrchestrator();
    const media = skipCutRangeAt(cue.start, getPlaybackSkipRanges());
    orch.seekMediaSec(media);
    playheadSec = orch.mapMediaToEditSec(media);
  }
  if (rerender) {
    renderCuesTable(lastCues, { capturePendingEdits: true });
  } else if (prevSelected !== cueIndex && subtitleList) {
    patchSelectedCueHighlight(subtitleList, prevSelected, cueIndex);
  }
  commitPlayheadUi();
  if (scroll && subtitleList) {
    scrollCueIntoView(subtitleList, lastCues, buildSubtitleCardOpts(lastCues), cueIndex, {
      behavior: "auto",
    });
  }
}
let preparePollTimer = null;
let _lastPrepareProgress = -1;
let transcribePollTimer = null;
let exportPollTimer = null;
let gpuInstallPollTimer = null;

function installDialogOpts() {
  return agentInstallDialogOptions(() => checkAgentConnection());
}

function friendlyAgentError(err) {
  const msg = formatAgentConnectionError(err);
  if (/409|진행 중|busy/i.test(msg)) return MSG_SUBTITLE_JOB_BUSY;
  if (/Failed to fetch|연결|fetch/i.test(msg)) return MSG_SUBTITLE_NEED_APP;
  return msg || "요청에 실패했습니다. 잠시 후 다시 시도해 주세요.";
}

function formatTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(2).padStart(5, "0")}`;
}

function syncInAppBusyShell() {
  const setupActive = Boolean(setupLoading?.classList.contains("is-active"));
  const transcribeActive = Boolean(transcribeLoading?.classList.contains("is-active"));
  const exportActive = Boolean(exportLoading?.classList.contains("is-active"));
  const gpuPromptActive = Boolean(gpuInstallPrompt?.classList.contains("is-active"));
  const fontAddActive = Boolean(fontAddModal?.classList.contains("is-active"));
  const watermarkModalActive = Boolean(watermarkPositionModal?.classList.contains("is-active"));
  const busy = setupActive || transcribeActive || exportActive || gpuPromptActive || fontAddActive || watermarkModalActive;
  asShell?.classList.toggle("is-inapp-busy", busy);
  if (inappBusyHost) {
    inappBusyHost.hidden = !busy;
    inappBusyHost.setAttribute("aria-hidden", busy ? "false" : "true");
  }
}

function closeFontAddModal() {
  if (!fontAddModal) return;
  fontAddModal.hidden = true;
  fontAddModal.classList.remove("is-active");
  fontAddModal.setAttribute("aria-hidden", "true");
  if (fontAddTrack) fontAddTrack.hidden = true;
  if (fontAddActions) fontAddActions.hidden = true;
  syncInAppBusyShell();
}

/** @param {{ title?: string, message?: string, loading?: boolean, showOk?: boolean }} opts */
function openFontAddModal({ title = "폰트 추가", message = "", loading = false, showOk = false } = {}) {
  if (!fontAddModal) return;
  closeGpuInstallModal();
  closeWatermarkPositionModal();
  setupLoading?.classList.remove("is-active");
  if (setupLoading) {
    setupLoading.hidden = true;
    setupLoading.setAttribute("aria-hidden", "true");
  }
  transcribeLoading?.classList.remove("is-active");
  if (transcribeLoading) {
    transcribeLoading.hidden = true;
    transcribeLoading.setAttribute("aria-hidden", "true");
  }
  if (fontAddTitle) fontAddTitle.textContent = title;
  if (fontAddMessage) fontAddMessage.textContent = message;
  if (fontAddTrack) fontAddTrack.hidden = !loading;
  if (fontAddActions) fontAddActions.hidden = !showOk;
  fontAddModal.hidden = false;
  fontAddModal.classList.add("is-active");
  fontAddModal.setAttribute("aria-hidden", "false");
  syncInAppBusyShell();
  if (showOk) btnFontAddOk?.focus({ preventScroll: true });
}

function setSetupLoading(active, { title, step, message, progress } = {}) {
  if (!setupLoading) return;
  const wasActive = setupLoading.classList.contains("is-active");
  if (active) {
    if (!wasActive) setAgentLongOperationActive(true);
    closeGpuInstallModal();
    closeFontAddModal();
    closeWatermarkPositionModal();
    transcribeLoading?.classList.remove("is-active");
    if (transcribeLoading) {
      transcribeLoading.hidden = true;
      transcribeLoading.setAttribute("aria-hidden", "true");
    }
    setupLoading.hidden = false;
    setupLoading.classList.add("is-active");
    setupLoading.setAttribute("aria-hidden", "false");
    if (title && setupLoadingTitle) setupLoadingTitle.textContent = title;
    if (setupLoadingStep) setupLoadingStep.textContent = step || "";
    if (message && setupLoadingMessage) setupLoadingMessage.textContent = message;
    if (setupLoadingBar && setupLoadingTrack) {
      if (typeof progress === "number") {
        const pct = Math.max(0, Math.min(100, progress));
        setupLoadingBar.style.width = `${pct}%`;
        setupLoadingTrack.setAttribute("aria-valuenow", String(Math.round(pct)));
        if (setupLoadingPercent) setupLoadingPercent.textContent = `${Math.round(pct)}%`;
      } else {
        setupLoadingBar.style.width = "30%";
        setupLoadingTrack.setAttribute("aria-valuenow", "0");
        if (setupLoadingPercent) setupLoadingPercent.textContent = "";
      }
    }
    syncInAppBusyShell();
    return;
  }
  if (wasActive) setAgentLongOperationActive(false);
  setupLoading.hidden = true;
  setupLoading.classList.remove("is-active");
  setupLoading.setAttribute("aria-hidden", "true");
  syncInAppBusyShell();
}

function setTranscribeLoading(active, { title, step, message, progress } = {}) {
  if (!transcribeLoading) return;
  const wasActive = transcribeLoading.classList.contains("is-active");
  if (active) {
    if (!wasActive) setAgentLongOperationActive(true);
    closeGpuInstallModal();
    closeFontAddModal();
    closeWatermarkPositionModal();
    setupLoading?.classList.remove("is-active");
    if (setupLoading) {
      setupLoading.hidden = true;
      setupLoading.setAttribute("aria-hidden", "true");
    }
    transcribeLoading.hidden = false;
    transcribeLoading.classList.add("is-active");
    transcribeLoading.setAttribute("aria-hidden", "false");
    if (title && transcribeLoadingTitle) transcribeLoadingTitle.textContent = title;
    if (transcribeLoadingStep) transcribeLoadingStep.textContent = step || "";
    if (message && transcribeLoadingMessage) transcribeLoadingMessage.textContent = message;
    if (transcribeLoadingBar && transcribeLoadingTrack) {
      if (typeof progress === "number") {
        const pct = Math.max(0, Math.min(100, progress));
        transcribeLoadingBar.style.width = `${pct}%`;
        transcribeLoadingTrack.setAttribute("aria-valuenow", String(Math.round(pct)));
        if (transcribeLoadingPercent) transcribeLoadingPercent.textContent = `${Math.round(pct)}%`;
      }
    }
    syncInAppBusyShell();
    return;
  }
  if (wasActive) setAgentLongOperationActive(false);
  transcribeLoading.hidden = true;
  transcribeLoading.classList.remove("is-active");
  transcribeLoading.setAttribute("aria-hidden", "true");
  syncInAppBusyShell();
}

function updateActionButtons() {
  const hasCues = lastCues.some((c) => !c.is_silence && String(c.text || "").trim());
  if (btnPrepare) btnPrepare.disabled = !agentConnected;
  if (btnAddWatermark) btnAddWatermark.disabled = !agentConnected;
  if (btnAddFont) btnAddFont.disabled = !agentConnected;
  if (btnExport) btnExport.disabled = !agentConnected || !hasCues;
  if (btnUnloadModel) btnUnloadModel.disabled = !agentConnected || !modelLoaded;
  if (btnDownloadResult) {
    btnDownloadResult.disabled = !agentConnected || !lastExportPath;
    btnDownloadResult.hidden = !lastExportPath;
  }
  if (btnShowExportFolder) {
    btnShowExportFolder.disabled = !agentConnected || !lastExportPath;
    btnShowExportFolder.hidden = !lastExportPath;
  }
  if (btnSaveProject) btnSaveProject.disabled = !hasCues;
  if (btnSaveProjectAs) btnSaveProjectAs.disabled = !hasCues;
  if (subtitleEmpty) subtitleEmpty.hidden = hasCues;
  if (resultsMeta) resultsMeta.hidden = !hasCues;
}

function setExportLoading(active, { title, step, message, progress } = {}) {
  if (!exportLoading) return;
  const wasActive = exportLoading.classList.contains("is-active");
  if (active) {
    if (!wasActive) setAgentLongOperationActive(true);
    closeGpuInstallModal();
    closeFontAddModal();
    closeWatermarkPositionModal();
    setupLoading?.classList.remove("is-active");
    if (setupLoading) {
      setupLoading.hidden = true;
      setupLoading.setAttribute("aria-hidden", "true");
    }
    transcribeLoading?.classList.remove("is-active");
    if (transcribeLoading) {
      transcribeLoading.hidden = true;
      transcribeLoading.setAttribute("aria-hidden", "true");
    }
    exportLoading.hidden = false;
    exportLoading.classList.add("is-active");
    exportLoading.setAttribute("aria-hidden", "false");
    if (title && exportLoadingTitle) exportLoadingTitle.textContent = title;
    if (exportLoadingStep) exportLoadingStep.textContent = step || "";
    if (message && exportLoadingMessage) exportLoadingMessage.textContent = message;
    if (exportLoadingBar && exportLoadingTrack && typeof progress === "number") {
      const pct = Math.max(0, Math.min(100, progress));
      exportLoadingBar.style.width = `${pct}%`;
      exportLoadingTrack.setAttribute("aria-valuenow", String(Math.round(pct)));
      if (exportLoadingPercent) exportLoadingPercent.textContent = `${Math.round(pct)}%`;
    }
    syncInAppBusyShell();
    return;
  }
  if (wasActive) setAgentLongOperationActive(false);
  exportLoading.hidden = true;
  exportLoading.classList.remove("is-active");
  exportLoading.setAttribute("aria-hidden", "true");
  syncInAppBusyShell();
}

function showExportError(msg) {
  setExportLoading(true, {
    title: "보내기 실패",
    step: "",
    message: msg || "오류가 발생했습니다.",
    progress: 0,
  });
  setTimeout(() => setExportLoading(false), 5000);
}

function stopExportPoll() {
  if (exportPollTimer) {
    clearInterval(exportPollTimer);
    exportPollTimer = null;
  }
}

function persistCuts() {
  try {
    sessionStorage.setItem(STORAGE_CUTS, JSON.stringify(lastCutRanges));
  } catch {
    /* ignore */
  }
}

function getMediaDurationSecHint() {
  if (sessionMediaDurationSec != null && sessionMediaDurationSec > 0) return sessionMediaDurationSec;
  if (previewVideo?.duration && Number.isFinite(previewVideo.duration) && previewVideo.duration > 0) {
    return previewVideo.duration;
  }
  return null;
}

function peaksLoadOpts(extra = {}) {
  return {
    timeoutSec: 900,
    durationHintSec: getMediaDurationSecHint() ?? undefined,
    audiowaveformAvailable: agentAudiowaveformAvailable,
    ...extra,
  };
}

function buildSubtitleCardOpts(cues, { scrollActive = false } = {}) {
  const mediaPlaying = isPreviewMediaPlaying();
  const activeCue = mediaPlaying
    ? resolvePlaybackIndices(playheadSec).ai
    : selectedCueIndex;
  const mediaDurationSec = getMediaDurationSecHint();
  return {
    formatTime,
    selectedCueIndex,
    expandedCueIndex,
    expandedWordIndex,
    getExpandedCueIndex: () => expandedCueIndex,
    getExpandedWordIndex: () => expandedWordIndex,
    playheadSec,
    isPlaying: mediaPlaying,
    getIsPlaying: () => isPreviewMediaPlaying(),
    getPlayheadSec: () => playheadSec,
    activeCueIndex: activeCue,
    scrollActiveCard: scrollActive,
    peaksData: peaksPayload,
    getPeaksData: () => peaksPayload,
    mediaDurationSec,
    getMediaDurationSec: getMediaDurationSecHint,
    video: previewVideo,
    getCues: () => lastCues,
    getPlaybackSkipRanges: () => subtitleHub.getPlaybackSkipRanges(),
    formatTimeFull: formatTime,
    ensurePeaksLoad: () => loadWaveformPeaks(),
    onCardNavigate: (sec) => {
      if (previewVideo && Number.isFinite(sec)) {
        const orch = getPlaybackOrchestrator();
        const media = skipCutRangeAt(sec, getPlaybackSkipRanges());
        orch.seekMediaSec(media);
        playheadSec = orch.mapMediaToEditSec(media);
        commitPlayheadUi();
      }
    },
    onSplitSubtitleAt: (index, pos) => {
      splitSubtitleAt(subtitleHub, index, pos);
      renderCuesTable(lastCues);
    },
    onMergeEmptySubtitleAt: (index) => {
      mergeEmptySubtitleAt(subtitleHub, index);
      renderCuesTable(lastCues);
    },
    onSplitSubtitleAtWord: (index, wordIndex) => {
      prepareRowCaretAfterCueSplit(index);
      splitSubtitleAtWord(subtitleHub, index, wordIndex);
      finalizeRowCaretAfterCueSplit(index, lastCues);
      renderCuesTable(lastCues);
      const nextIndex = index + 1;
      if (lastCues[nextIndex] && !lastCues[nextIndex].is_silence) {
        const prev = selectedCueIndex;
        selectedCueIndex = nextIndex;
        hintActiveCaretCardIndex(nextIndex);
        if (subtitleList) patchSelectedCueHighlight(subtitleList, prev, nextIndex);
        lastOverlayCueIndex = -1;
        updatePreviewOverlay();
        // console.log("[SPLIT-DBG] split done → selectedCueIndex=%d, previewCueIdx=%d, text=%s",
        //   nextIndex, getPreviewCueIndex(), getPreviewCueText(lastCues[nextIndex])?.slice(0, 30));
      }
      if (subtitleList) {
        requestFocusCaretDeferred(
          subtitleList,
          lastCues,
          buildSubtitleCardOpts(lastCues),
          nextIndex,
          0,
        );
      }
    },
    onBackspaceWordAt: (cardIndex, wordIndex) => {
      armDeleteGuard();
      backspaceWordAt(subtitleHub, cardIndex, wordIndex);
      renderCuesTable(lastCues);
      if (subtitleList) {
        const wi = Math.max(0, wordIndex - 1);
        requestFocusCaretDeferred(
          subtitleList,
          lastCues,
          buildSubtitleCardOpts(lastCues),
          cardIndex,
          wi,
          { seek: false },
        );
      }
    },
    onDeleteWordAt: (cardIndex, caretIndex) => {
      armDeleteGuard();
      deleteWordAt(subtitleHub, cardIndex, caretIndex);
      renderCuesTable(lastCues);
      commitPlayheadUi();
      if (subtitleList) {
        const words = lastCues[cardIndex]?.words ?? [];
        requestFocusCaretDeferred(
          subtitleList,
          lastCues,
          buildSubtitleCardOpts(lastCues),
          cardIndex,
          nearestValidStorageCaret(words, caretIndex),
          { seek: false },
        );
      }
    },
    onDeleteWordRangeAt: (cardIndex, from, to) => {
      armDeleteGuard();
      deleteWordRangeAt(subtitleHub, cardIndex, from, to);
      renderCuesTable(lastCues);
      commitPlayheadUi();
      if (subtitleList) {
        const words = lastCues[cardIndex]?.words ?? [];
        requestFocusCaretDeferred(
          subtitleList,
          lastCues,
          buildSubtitleCardOpts(lastCues),
          cardIndex,
          nearestValidStorageCaret(words, from),
          { seek: false },
        );
      }
    },
    onSelectCue: (cueIndex, detail) =>
      selectCueLine(cueIndex, {
        seek: detail?.seek !== false,
        scroll: detail?.scroll !== false,
        rerender: detail?.rerender !== false,
      }),
    onWordExpand: (ci, wi) => {
      if (expandedCueIndex === ci && expandedWordIndex === wi) {
        closeWordWaveform();
        return;
      }
      expandedCueIndex = ci;
      expandedWordIndex = wi;
      renderCuesTable(lastCues);
    },
    onCloseWaveform: (opts) => closeWordWaveform(opts ?? {}),
    onPreviewLineTextInput: (cueIndex, text) => {
      if (lastCues[cueIndex]) {
        markLineTextUserEdited(lastCues[cueIndex]);
        lastCues[cueIndex].text = text;
        updatePreviewOverlay();
      }
    },
    onSubtitleTextCommit: (cueIndex, text) => {
      subtitleHub.applySubtitleChange((cues) => {
        const next = [...cues];
        const cue = { ...next[cueIndex], text };
        markLineTextUserEdited(cue);
        rebuildWordsFromLineText(cue);
        next[cueIndex] = cue;
        return next;
      });
      renderCuesTable(lastCues);
    },
    onSeek: (sec) => {
      if (previewVideo && Number.isFinite(sec)) {
        const orch = getPlaybackOrchestrator();
        const media = skipCutRangeAt(sec, getPlaybackSkipRanges());
        orch.seekMediaSec(media);
        playheadSec = orch.mapMediaToEditSec(media);
        commitPlayheadUi();
      }
    },
    onSeekWord: (cue, storageWordIndex) => {
      if (!previewVideo) return;
      const editSec = editSecForStorageWord(cue, storageWordIndex);
      if (!Number.isFinite(editSec)) return;
      const orch = getPlaybackOrchestrator();
      const media = skipCutRangeAt(orch.mapEditToMediaSec(editSec), getPlaybackSkipRanges());
      orch.seekMediaSec(media);
      playheadSec = orch.mapMediaToEditSec(media);
      commitPlayheadUi();
    },
    onTogglePlayback: (fromSpace) =>
      togglePreviewPlayback({
        showCaretOnPause: Boolean(fromSpace),
      }),
    onWaveformSeekAndPlay: (editSec) => {
      if (!Number.isFinite(editSec)) return;
      seekEditSecAndPlay(editSec);
    },
    onWaveformChipClick: (ci, _visIdx, storageWi, isActiveChip, detail) => {
      if (expandedCueIndex !== ci) return;
      if (waveformChipCloseTimer != null) {
        clearTimeout(waveformChipCloseTimer);
        waveformChipCloseTimer = null;
      }
      if (isActiveChip && detail === 1) {
        waveformChipCloseTimer = setTimeout(() => closeWordWaveform(), 280);
        return;
      }
      if (!isActiveChip) {
        expandedWordIndex = storageWi;
        renderCuesTable(lastCues);
      }
    },
    onPlayAtCaret: (cardIndex, storageCaret) => playAtSubtitleCaret(cardIndex, storageCaret),
    mapEditToMediaSec: (editSec) => {
      const orch = getPlaybackOrchestrator();
      return skipCutRangeAt(orch.mapEditToMediaSec(editSec), getPlaybackSkipRanges());
    },
    mapMediaToEditSec: (mediaSec) => {
      const orch = getPlaybackOrchestrator();
      return orch.mapMediaToEditSec(mediaSec);
    },
    onWaveformSpacePlay: () => {
      if (!subtitleList || expandedCueIndex < 0 || expandedWordIndex < 0) return false;
      return toggleExpandedPanelPlayFromCut(subtitleList, {
        expandedCueIndex,
        expandedWordIndex,
        playheadSec,
      });
    },
    onApplySubtitleChange: (updater, meta) => {
      if (subtitleList) captureTextareaEditsIntoCues(subtitleList, lastCues);
      subtitleHub.applySubtitleChange(updater);
      let focusAfterRender = null;
      if (meta && meta.cueIndex >= 0 && meta.focusWordIndex >= 0) {
        const ci = meta.cueIndex;
        const wi = meta.focusWordIndex;
        const cue = lastCues[ci];
        if (cue) {
          ensureCueWords(cue);
          const waveformOpen = expandedCueIndex === ci && expandedWordIndex === wi;
          prepareCaretAtWord(ci, cue.words ?? [], wi, !waveformOpen);
          const word = cue.words?.[wi];
          playheadSec = editSecForStorageWord(cue, wi);
          if (waveformOpen && word) {
            waveformPlayRangeEndEdit = Math.max(Number(word.start) || 0, Number(word.end) || 0);
          } else {
            waveformPlayRangeEndEdit = null;
          }
          focusAfterRender = { ci, wi, armSpaceSeek: !waveformOpen };
        }
      } else {
        clearListPlayFromCaretPreferred();
        resetSpaceSeekIntent();
      }
      renderCuesTable(lastCues);
      commitPlayheadUi();
      if (focusAfterRender && subtitleList) {
        requestFocusCaretDeferred(
          subtitleList,
          lastCues,
          buildSubtitleCardOpts(lastCues),
          focusAfterRender.ci,
          focusAfterRender.wi,
          { seek: false, armSpaceSeek: focusAfterRender.armSpaceSeek !== false },
        );
      }
    },
    onBeforeWordSplit: () => {
      subtitleHub.gapFillWhenBuildingVrew = false;
    },
    onWaveformUndo: () => {
      if (subtitleHub.undo()) renderCuesTable(lastCues);
    },
    onPlayEditRange: (startEdit, endEdit) => {
      if (!previewVideo || !previewAudio || !Number.isFinite(startEdit) || !Number.isFinite(endEdit)) return;
      const lo = Math.min(startEdit, endEdit);
      const hi = Math.max(startEdit, endEdit);
      const skips = getPlaybackSkipRanges();
      let start = firstPlayableSecInRange(lo, hi, skips);
      if (start == null) start = skipCutRangeAt(startEdit, skips);
      if (!Number.isFinite(start)) return;
      const minSpan = Math.max(1e-4, MIN_WORD_SPAN_SEC * 0.5);
      if (hi - start < minSpan) {
        start = Math.max(lo, hi - minSpan);
        start = firstPlayableSecInRange(start, hi, skips) ?? skipCutRangeAt(start, skips);
      }
      if (!Number.isFinite(start) || hi - start <= 1e-4) return;
      const orch = getPlaybackOrchestrator();
      const startMedia = skipCutRangeAt(orch.mapEditToMediaSec(start), skips);
      waveformPlayRangeEndEdit = hi;
      playheadSec = start;
      orch.seekMediaSec(startMedia);
      commitPlayheadUi();
      startPlaybackLoop({ fromWaveformRange: true });
    },
    onPausePlayback: () => {
      userRequestedPreviewPause = true;
      stopPlaybackLoop();
      previewVideo?.pause();
      userRequestedPreviewPause = false;
    },
    onWaveformFocusWord: (ci, wi) => {
      expandedCueIndex = ci;
      expandedWordIndex = wi;
      renderCuesTable(lastCues);
    },
  };
}

function resetEditorSessionForProjectLoad() {
  stopPlaybackLoop();
  closeWordWaveform({ restoreFocus: false });
  clearAllRowCaretState();
  resetSpaceSeekIntent();
  resetKeyboardPauseCaret();
  clearListPlayFromCaretPreferred();
  clearWaveformCutSecCache();
  selectedCueIndex = -1;
  expandedCueIndex = -1;
  expandedWordIndex = -1;
  peaksPayload = null;
  playheadSec = 0;
  lastPlaybackCueIndex = -1;
  lastPlaybackWordIndex = -1;
  lastOverlayCueIndex = -1;
}

function renderCuesTable(cues, { scrollActive = false, capturePendingEdits = false } = {}) {
  if (!subtitleList) return;
  if (capturePendingEdits) {
    captureTextareaEditsIntoCues(subtitleList, lastCues);
  }
  const opts = buildSubtitleCardOpts(cues, { scrollActive });
  renderSubtitleCards(subtitleList, cues, opts);
  updateActionButtons();
  if (scrollActive && opts.activeCueIndex >= 0) {
    scrollCueIntoView(subtitleList, cues, opts, opts.activeCueIndex, { behavior: "auto" });
  }
}

async function loadWaveformPeaks() {
  const videoPath = videoPathInput?.value?.trim();
  if (!videoPath || !agentConnected || waveformLoading) return false;
  waveformLoading = true;
  try {
    const result = await loadWaveformPeaksForMedia(videoPath, peaksLoadOpts());
    if (!result.metrics) {
      peaksPayload = null;
      console.warn("waveform-peaks", result.error || "invalid_peaks");
      return false;
    }
    peaksPayload = result.payload;
    if (expandedCueIndex >= 0 && expandedWordIndex >= 0) {
      renderCuesTable(lastCues);
    }
    return true;
  } catch (err) {
    peaksPayload = null;
    console.warn("waveform-peaks", err);
    return false;
  } finally {
    waveformLoading = false;
  }
}

async function applyLoadedProject(res) {
  resetEditorSessionForProjectLoad();

  const videoPath = res?.video_path || res?.normalized?.video_path || res?.project?.videoPath || "";
  const project = res?.project;
  const cues =
    (Array.isArray(project?.subtitles) && project.subtitles) ||
    res?.cues ||
    res?.normalized?.cues ||
    [];
  const cuts =
    res?.cut_ranges ||
    res?.normalized?.cut_ranges ||
    project?.cutRanges ||
    [];
  const style =
    res?.subtitle_style ||
    res?.normalized?.subtitle_style ||
    project?.subtitleStyle;

  if (videoPath && videoPathInput) {
    sessionVideoPath = videoPath;
    videoPathInput.value = videoPath;
    try {
      sessionStorage.setItem(STORAGE_VIDEO_PATH, videoPath);
    } catch {
      /* ignore */
    }
    updatePreview(videoPath);
  }
  subtitleHub.ingestFromProject(Array.isArray(cues) ? cues : [], {
    cutRanges: Array.isArray(cuts) ? cuts : [],
  });
  applySubtitleStyleFromProject(style);
  applyWatermarkFromProject(project?.watermark ?? res?.watermark ?? res?.normalized?.watermark);
  scheduleSaveUserPreferences();

  try {
    sessionStorage.setItem(STORAGE_CUES, JSON.stringify(lastCues));
    sessionStorage.setItem(STORAGE_CUTS, JSON.stringify(lastCutRanges));
  } catch {
    /* ignore */
  }

  renderCuesTable(lastCues);
  updateActionButtons();
  const firstSpeech = lastCues.findIndex((c) => !c.is_silence && String(c.text || "").trim());
  if (firstSpeech >= 0) {
    selectCueLine(firstSpeech, { scroll: false });
    if (subtitleList) {
      requestFocusCaretDeferred(
        subtitleList,
        lastCues,
        buildSubtitleCardOpts(lastCues),
        firstSpeech,
        0,
      );
    }
  }

  if (resultsMeta) {
    resultsMeta.textContent = `${lastCues.length} cues · 프로젝트 불러옴`;
  }

  if (videoPath) {
    await loadWaveformPeaks();
  }
}

async function onLoadProject() {
  if (!agentConnected) {
    alert(MSG_SUBTITLE_NEED_APP);
    return;
  }
  let pick;
  try {
    pick = await requestAgent({ path: "/api/agent/pick-local-project-file", method: "POST" });
  } catch (err) {
    if (/취소|cancel/i.test(String(err))) return;
    throw err;
  }
  const projectPath = pick?.project_path || pick?.path || "";
  if (!projectPath) return;

  const res = await requestAgent({
    path: `${TOOL_PREFIX}/project/load`,
    method: "POST",
    json: { project_path: projectPath },
  });
  await applyLoadedProject(res);
}

function applyReadiness(data) {
  const b = data?.binaries || {};
  const model = data?.model || {};
  const parts = [];
  if (b.ffmpeg) parts.push("FFmpeg");
  if (b.faster_whisper) parts.push("Whisper lib");
  if (b.model_present) parts.push("모델 파일");
  if (b.model_loaded) parts.push(`로드(${model.device || "?"})`);
  if (binReadiness) {
    binReadiness.textContent = parts.length
      ? `Auto Subtitle · ${parts.join(" · ")}`
      : "Auto Subtitle · 준비 필요";
  }
  modelLoaded = Boolean(b.model_loaded);
  agentAudiowaveformAvailable = Boolean(b.audiowaveform);
  toolReady = Boolean(b.ffmpeg && modelLoaded);
  if (btnPrepare) btnPrepare.disabled = !agentConnected;
  if (btnAddWatermark) btnAddWatermark.disabled = !agentConnected;
  if (btnAddFont) btnAddFont.disabled = !agentConnected;
  setComputeCapabilityBadge(data);
  maybeShowGpuInstallDialog(data);
}

function setComputeCapabilityBadge(data) {
  const el = document.getElementById("compute-capability");
  if (!el) return;
  el.classList.remove("is-gpu", "is-cpu", "is-pending", "is-warn");

  if (!agentConnected) {
    el.classList.add("is-pending");
    el.textContent = "연산 장치 확인 불가";
    el.title = "에이전트에 연결되면 GPU/CPU 여부를 표시합니다.";
    return;
  }

  const b = data?.binaries || {};
  const model = data?.model || {};

  if (!b.gpu_detected && !b.gpu_runtime_installed && !model.device) {
    el.classList.add("is-pending");
    el.textContent = "연산 장치 확인 중…";
    el.title = "";
    return;
  }

  const device = (model.device || "").toLowerCase();

  if (device === "cuda" || b.gpu_runtime_installed) {
    el.classList.add("is-gpu");
    el.textContent = "GPU · CUDA 사용 중";
    el.title = "CUDA GPU로 자막 추출이 동작합니다.";
    return;
  }

  if (b.gpu_detected && !b.gpu_runtime_installed) {
    el.classList.add("is-warn");
    el.textContent = "GPU 감지됨 · CUDA 미설치";
    el.title = "NVIDIA GPU가 있습니다. 환경 준비에서 CUDA DLL을 설치하면 GPU를 사용할 수 있습니다.";
    return;
  }

  el.classList.add("is-cpu");
  el.textContent = "CPU만 가능";
  el.title = "NVIDIA GPU가 감지되지 않았습니다. CPU로 자막 추출이 동작합니다.";
}

let gpuDialogShown = false;

function closeGpuInstallModal() {
  if (!gpuInstallPrompt) return;
  gpuInstallPrompt.hidden = true;
  gpuInstallPrompt.classList.remove("is-active");
  syncInAppBusyShell();
}

function openGpuInstallModal(message) {
  if (!gpuInstallPrompt) return;
  if (gpuInstallMessage && message) gpuInstallMessage.textContent = message;
  closeFontAddModal();
  closeWatermarkPositionModal();
  setupLoading?.classList.remove("is-active");
  if (setupLoading) {
    setupLoading.hidden = true;
    setupLoading.setAttribute("aria-hidden", "true");
  }
  transcribeLoading?.classList.remove("is-active");
  if (transcribeLoading) {
    transcribeLoading.hidden = true;
    transcribeLoading.setAttribute("aria-hidden", "true");
  }
  gpuInstallPrompt.hidden = false;
  gpuInstallPrompt.classList.add("is-active");
  syncInAppBusyShell();
}

function maybeShowGpuInstallDialog(readiness) {
  const b = readiness?.binaries || {};
  if (!b.gpu_detected || b.gpu_runtime_installed || gpuDialogShown) return;
  if (!gpuInstallPrompt) return;
  gpuDialogShown = true;
  openGpuInstallModal(
    "NVIDIA GPU가 감지되었습니다. CUDA DLL(runtime_dlls.zip)을 설치하면 GPU로 자막 추출을 사용할 수 있습니다.",
  );
}

function stopGpuInstallPoll() {
  if (gpuInstallPollTimer) {
    clearInterval(gpuInstallPollTimer);
    gpuInstallPollTimer = null;
  }
}

async function pollGpuInstallStatus() {
  const data = await requestAgent({ path: `${TOOL_PREFIX}/gpu-runtime/install/status` });
  const phase = data?.phase || "";
  setSetupLoading(true, {
    title: "GPU 가속 런타임",
    step: data?.step || phase,
    message: data?.detail || data?.message || "설치 중…",
    progress: typeof data?.progress === "number" ? data.progress : undefined,
  });
  if (phase === "ready") {
    stopGpuInstallPoll();
    setSetupLoading(false);
    await fetchReadiness();
    return true;
  }
  if (phase === "failed") {
    stopGpuInstallPoll();
    setSetupLoading(false);
    alert(friendlyAgentError(data?.error || data?.message || data?.detail || "GPU 런타임 설치에 실패했습니다."));
    return false;
  }
  return null;
}

async function runGpuRuntimeInstall() {
  closeGpuInstallModal();
  stopGpuInstallPoll();
  setSetupLoading(true, {
    title: "GPU 가속 런타임",
    step: "시작",
    message: "runtime_dlls.zip 설치를 시작합니다…",
    progress: 2,
  });
  try {
    await requestAgent({
      path: `${TOOL_PREFIX}/gpu-runtime/install`,
      method: "POST",
    });
    await new Promise((resolve) => {
      gpuInstallPollTimer = setInterval(async () => {
        try {
          const done = await pollGpuInstallStatus();
          if (done === true) resolve(true);
          if (done === false) resolve(false);
        } catch (err) {
          if (/503|502|timeout|fetch|준비/i.test(String(err))) return;
          stopGpuInstallPoll();
          setSetupLoading(false);
          alert(friendlyAgentError(err));
          resolve(false);
        }
      }, 800);
    });
  } catch (err) {
    stopGpuInstallPoll();
    setSetupLoading(false);
    alert(friendlyAgentError(err));
  }
}

async function fetchReadiness() {
  try {
    const data = await requestAgent({ path: `${TOOL_PREFIX}/readiness` });
    applyReadiness(data);
    return data;
  } catch {
    if (binReadiness) binReadiness.textContent = "Auto Subtitle · readiness 실패";
    toolReady = false;
    return null;
  }
}

function stopPreparePoll() {
  if (preparePollTimer) {
    clearInterval(preparePollTimer);
    preparePollTimer = null;
  }
}

function stopTranscribePoll() {
  if (transcribePollTimer) {
    clearInterval(transcribePollTimer);
    transcribePollTimer = null;
  }
}

async function pollPrepareStatus() {
  const data = await requestAgent({ path: `${TOOL_PREFIX}/prepare/status` });
  const phase = data?.phase || "";
  const step = data?.step || phase;
  const progress = typeof data?.progress === "number" ? data.progress : undefined;
  _lastPrepareProgress = progress ?? _lastPrepareProgress;
  let title = "환경 준비";
  if (phase === "downloading_models") title = "AI 모델 다운로드";
  else if (/FFmpeg/i.test(step)) title = "FFmpeg 다운로드";
  else if (/Python|pip|패키지/i.test(step)) title = "Python 패키지 설치";
  else if (/GPU|DLL|runtime/i.test(step)) title = "GPU 런타임 설치";
  setSetupLoading(true, {
    title,
    step,
    message: data?.detail || data?.message || "준비 중…",
    progress,
  });
  if (phase === "ready") {
    stopPreparePoll();
    setSetupLoading(false);
    await fetchReadiness();
    updateActionButtons();
    return true;
  }
  if (phase === "failed") {
    stopPreparePoll();
    setSetupLoading(false);
    alert(friendlyAgentError(data?.error || data?.message || data?.detail || "준비에 실패했습니다."));
    return false;
  }
  return null;
}

async function ensurePrepared() {
  const readiness = await fetchReadiness();
  if (readiness?.binaries?.model_loaded) {
    return true;
  }

  setSetupLoading(true, {
    title: "AI 환경 준비",
    step: "시작",
    message: MSG_SUBTITLE_PREPARE,
    progress: 2,
  });

  try {
    await requestAgent({ path: `${TOOL_PREFIX}/prepare`, method: "POST" });
  } catch (e) {
    console.warn("[ensurePrepared] POST /prepare failed, will poll status anyway:", e);
  }

  return new Promise((resolve) => {
    stopPreparePoll();
    let stallCount = 0;
    let lastProgress = -1;
    let transientFailStreak = 0;
    preparePollTimer = setInterval(async () => {
      try {
        const done = await pollPrepareStatus();
        transientFailStreak = 0;
        if (done === true) resolve(true);
        if (done === false) resolve(false);
        const curProg = _lastPrepareProgress;
        if (typeof curProg === "number" && curProg === lastProgress) {
          stallCount++;
        } else {
          stallCount = 0;
          lastProgress = curProg;
        }
        if (stallCount > 450) {
          stopPreparePoll();
          setSetupLoading(false);
          alert("환경 준비가 6분 이상 진행되지 않고 있습니다. 에이전트를 재시작하고 다시 시도해 주세요.");
          resolve(false);
        }
      } catch (err) {
        if (/503|502|504|timeout|fetch|unavailable|준비/i.test(String(err))) {
          transientFailStreak++;
          if (transientFailStreak > 15) {
            setSetupLoading(true, {
              title: "에이전트 API 대기",
              step: "연결 재시도 중",
              message: "에이전트가 아직 준비 중입니다. 잠시만 기다려 주세요…",
              progress: 2,
            });
          }
          if (transientFailStreak > 90) {
            stopPreparePoll();
            setSetupLoading(false);
            alert("에이전트 API에 1분 이상 연결할 수 없습니다. 에이전트가 실행 중인지 확인해 주세요.");
            resolve(false);
          }
          return;
        }
        stopPreparePoll();
        setSetupLoading(false);
        alert(friendlyAgentError(err));
        resolve(false);
      }
    }, 800);
  });
}

const TRANSCRIBE_LOADING_TITLE = "자막 추출 중…";
const TRANSCRIBE_LOADING_START_MSG = "자막 추출을 시작합니다.";

async function pollTranscribeStatus() {
  const data = await requestAgent({ path: `${TOOL_PREFIX}/transcribe/status` });
  const phase = data?.phase || "";
  setTranscribeLoading(true, {
    title: TRANSCRIBE_LOADING_TITLE,
    step: "",
    message: data?.message || TRANSCRIBE_LOADING_START_MSG,
    progress: typeof data?.progress === "number" ? data.progress : undefined,
  });

  if (phase === "completed") {
    stopTranscribePoll();
    setTranscribeLoading(false);
    lastExportPath = data.srt_path || null;
    await finalizeTranscribeResults(data.cues || [], data.duration_sec, {
      waveform_peaks_json: data.waveform_peaks_json,
      waveform_peaks: data.waveform_peaks,
    });
    return true;
  }

  if (phase === "failed") {
    stopTranscribePoll();
    setTranscribeLoading(false);
    const errText = data?.error || data?.message || "자막 추출에 실패했습니다.";
    alert(friendlyAgentError(errText));
    return false;
  }

  return null;
}

/**
 * 추출 완료 — Electron onTranscribeComplete: audiowaveform 피크 → leading split → temporal gap → SSOT.
 *
 * @param {unknown[]} rawCues
 * @param {number} [durationSecHint]
 * @param {{ waveform_peaks_json?: object | null, waveform_peaks?: object | null }} [transcribeMeta]
 */
async function finalizeTranscribeResults(rawCues, durationSecHint, transcribeMeta = {}) {
  subtitleHub.gapFillWhenBuildingVrew = false;
  setTranscribeLoading(true, {
    title: TRANSCRIBE_LOADING_TITLE,
    step: "후처리",
    message: "파형·무음 블록 정리 중…",
    progress: 95,
  });

  try {
    const dur =
      Number(durationSecHint) > 0
        ? Number(durationSecHint)
        : getMediaDurationSecHint();

    if (dur != null && dur > 0) sessionWhisperDurationSec = dur;

    const inlinePeaks = transcribeMeta?.waveform_peaks_json;
    if (inlinePeaks && resolvePeaksTimelineMetrics(inlinePeaks, dur ?? undefined)) {
      peaksPayload = inlinePeaks;
    } else {
      const videoPath = videoPathInput?.value?.trim();
      if (videoPath && agentConnected) {
        try {
          const result = await loadWaveformPeaksForMedia(
            videoPath,
            peaksLoadOpts({ force: true, engine: "auto" }),
          );
          if (result.metrics) {
            peaksPayload = result.payload;
          } else {
            console.warn("waveform-peaks post-transcribe", result.error || "invalid_peaks");
          }
        } catch (err) {
          console.warn("waveform-peaks post-transcribe", err);
        }
      }
    }

    const peaksMetrics = peaksPayload
      ? resolvePeaksTimelineMetrics(peaksPayload, dur ?? undefined)
      : null;
    if (peaksMetrics?.durationSec > 0) {
      sessionMediaDurationSec = peaksMetrics.durationSec;
    } else if (dur != null && dur > 0) {
      sessionMediaDurationSec = dur;
    }
    subtitleHub.ingestFromTranscribe(rawCues, {
      gapFill: false,
      peaksMetrics,
      whisperDurationSec: dur ?? null,
    });
    try {
      sessionStorage.setItem(STORAGE_CUES, JSON.stringify(lastCues));
      if (lastExportPath) sessionStorage.setItem(STORAGE_EXPORT_PATH, lastExportPath);
    } catch {
      /* ignore */
    }
    renderCuesTable(lastCues);
    if (resultsMeta) {
      resultsMeta.textContent = `${lastCues.length} cues · 추출 완료`;
      resultsMeta.hidden = false;
    }
    updateActionButtons();
    const firstSpeech = lastCues.findIndex((c) => !c.is_silence && String(c.text || "").trim());
    if (firstSpeech >= 0) {
      selectCueLine(firstSpeech, { scroll: false });
      if (subtitleList) {
        requestFocusCaretDeferred(
          subtitleList,
          lastCues,
          buildSubtitleCardOpts(lastCues),
          firstSpeech,
          0,
        );
      }
    }
  } catch (err) {
    console.error("finalizeTranscribeResults", err);
    alert(`자막 후처리 중 오류가 발생했습니다.\n${friendlyAgentError(err)}`);
  } finally {
    setTranscribeLoading(false);
  }
}

async function runTranscribe() {
  const videoPath = videoPathInput?.value?.trim();
  if (!videoPath) {
    alert("영상·오디오 파일을 선택하세요.");
    return;
  }

  const prepared = await ensurePrepared();
  if (!prepared) return;

  setTranscribeLoading(true, {
    title: TRANSCRIBE_LOADING_TITLE,
    step: "",
    message: TRANSCRIBE_LOADING_START_MSG,
    progress: 0,
  });

  const lang = languageSelect?.value?.trim() || null;
  try {
    await requestAgent({
      path: `${TOOL_PREFIX}/transcribe`,
      method: "POST",
      json: {
        video_path: videoPath,
        language: lang,
        beam_size: 5,
        vad_filter: true,
        rms_vad_align: true,
      },
    });
  } catch (err) {
    stopTranscribePoll();
    setTranscribeLoading(false);
    alert(friendlyAgentError(err));
    return false;
  }

  return new Promise((resolve) => {
    stopTranscribePoll();
    const tick = async () => {
      try {
        const done = await pollTranscribeStatus();
        if (done === true) resolve(true);
        if (done === false) resolve(false);
      } catch (err) {
        stopTranscribePoll();
        setTranscribeLoading(false);
        alert(friendlyAgentError(err));
        resolve(false);
      }
    };
    void tick();
    transcribePollTimer = setInterval(tick, 400);
  });
}

function buildExportPayload(fmt) {
  syncCuesFromDom();
  return buildExportRequestPayload(
    lastCues,
    lastCutRanges,
    readSubtitleStyleFromDom(),
    fmt,
    videoPathInput?.value?.trim() || null,
  );
}

function buildProjectJson() {
  return JSON.stringify({
    format: "autosubtitle-project",
    version: 1,
    videoPath: videoPathInput?.value?.trim() || null,
    cutRanges: lastCutRanges,
    subtitleStyle: readSubtitleStyleFromDom(),
    watermark: watermarkConfig.path ? { ...watermarkConfig } : null,
    subtitles: lastCues,
  }, null, 2);
}

async function saveProject() {
  if (!lastCues.length) {
    alert("저장할 전사 결과가 없습니다.");
    return;
  }
  syncCuesFromDom();
  await saveProjectAs();
}

async function saveProjectAs() {
  if (!lastCues.length) {
    alert("저장할 전사 결과가 없습니다.");
    return;
  }
  syncCuesFromDom();
  const handle = await window.showSaveFilePicker({
    suggestedName: "AutoSubtitle",
    types: [{
      description: "AutoSubtitle 프로젝트",
      accept: { "application/json": [".json"] },
    }],
  });
  const writable = await handle.createWritable();
  await writable.write(buildProjectJson());
  await writable.close();
}

async function unloadModel() {
  await requestAgent({ path: `${TOOL_PREFIX}/model/unload`, method: "POST" });
  await fetchReadiness();
  alert("AI 모델을 메모리에서 해제했습니다. 다음 자막 추출 시 다시 불러옵니다.");
}

let smoothedProgress = 0;
let smoothProgressRafId = 0;
let smoothProgressTarget = 0;

function resetSmoothProgress() {
  smoothedProgress = 0;
  smoothProgressTarget = 0;
  cancelAnimationFrame(smoothProgressRafId);
  smoothProgressRafId = 0;
}

function animateSmoothProgress(setFn) {
  if (smoothProgressRafId) return;
  const step = () => {
    if (smoothedProgress >= smoothProgressTarget) {
      smoothProgressRafId = 0;
      return;
    }
    const diff = smoothProgressTarget - smoothedProgress;
    const increment = Math.max(0.3, diff * 0.08);
    smoothedProgress = Math.min(smoothProgressTarget, smoothedProgress + increment);
    setFn(Math.round(smoothedProgress));
    if (smoothedProgress < smoothProgressTarget) {
      smoothProgressRafId = requestAnimationFrame(step);
    } else {
      smoothProgressRafId = 0;
    }
  };
  smoothProgressRafId = requestAnimationFrame(step);
}

async function pollExportStatus(fmt) {
  const data = await requestAgent({ path: `${TOOL_PREFIX}/export/status` });
  const phase = data?.phase || "";

  const rawProgress = typeof data?.progress === "number" ? data.progress : undefined;
  if (rawProgress != null && rawProgress > smoothProgressTarget) {
    smoothProgressTarget = Math.min(rawProgress, 99);
  }

  const applyProgress = (val) => {
    setExportLoading(true, {
      title: "보내기",
      step: exportPhaseStepLabel(phase, data?.format || fmt),
      message: data?.message || "처리 중…",
      progress: val,
    });
  };

  if (rawProgress != null) {
    animateSmoothProgress(applyProgress);
  } else {
    setExportLoading(true, {
      title: "보내기",
      step: exportPhaseStepLabel(phase, data?.format || fmt),
      message: data?.message || "처리 중…",
      progress: undefined,
    });
  }

  if (phase === "completed") {
    stopExportPoll();
    smoothProgressTarget = 100;
    smoothedProgress = 100;
    setExportLoading(true, {
      title: "보내기",
      step: exportPhaseStepLabel(phase, data?.format || fmt),
      message: "완료!",
      progress: 100,
    });
    setTimeout(() => {
      setExportLoading(false);
      resetSmoothProgress();
    }, 400);
    lastExportPath = data.result_path || null;
    if (lastExportPath) {
      try {
        sessionStorage.setItem(STORAGE_EXPORT_PATH, lastExportPath);
      } catch {
        /* ignore */
      }
    }
    updateActionButtons();
    return true;
  }
  if (phase === "failed") {
    stopExportPoll();
    resetSmoothProgress();
    const raw = data?.error || data?.message || "보내기에 실패했습니다.";
    const friendly = /Broken pipe|Errno 32|비정상 종료/i.test(raw)
      ? "영상 인코딩 중 오류가 발생했습니다. GPU 인코더 문제일 수 있습니다. 다시 시도해 주세요."
      : raw;
    setExportLoading(true, {
      title: "보내기 실패",
      step: "",
      message: friendly,
      progress: 0,
    });
    setTimeout(() => setExportLoading(false), 5000);
    return false;
  }
  return null;
}

async function showExportResultInFolder(filePath) {
  if (!filePath || !agentConnected) return;
  try {
    await requestAgent({
      path: `${TOOL_PREFIX}/export/show-in-folder`,
      method: "POST",
      json: { file_path: filePath },
    });
  } catch (err) {
    alert(friendlyAgentError(err));
  }
}

async function runExport() {
  const fmt = exportFormatSelect?.value || "srt";
  if (!lastCues.length && !["mp3", "wav"].includes(fmt)) {
    alert("전사 결과가 없습니다.");
    return;
  }
  const videoPath = videoPathInput?.value?.trim() || null;
  if (fmt === "video" && !videoPath) {
    alert("영상 파일을 선택하세요.");
    return;
  }

  syncCuesFromDom();
  const label = exportFormatLabel(fmt);

  setExportLoading(true, {
    title: "보내기",
    step: `${label} · 시작`,
    message: EXPORT_TEXT_FORMATS.includes(fmt)
      ? `${label} 파일 생성 중…`
      : `${label} FFmpeg 인코딩 중… (시간이 걸릴 수 있습니다)`,
    progress: 5,
  });

  if (EXPORT_TEXT_FORMATS.includes(fmt)) {
    const payload = buildExportPayload(fmt);
    try {
      const res = await requestAgent({
        path: `${TOOL_PREFIX}/export/sync`,
        method: "POST",
        json: payload,
      });
      setExportLoading(false);
      lastExportPath = res.file_path || null;
      if (lastExportPath) sessionStorage.setItem(STORAGE_EXPORT_PATH, lastExportPath);
      updateActionButtons();
      openDownload(lastExportPath);
      return;
    } catch (err) {
      showExportError(friendlyAgentError(err));
      return;
    }
  }

  if (fmt === "video") {
    try {
      await runVideoBurnInExport({
        toolPrefix: TOOL_PREFIX,
        videoPath,
        lastCues,
        cutRanges: lastCutRanges,
        style: readSubtitleStyleFromDom(),
        watermark: watermarkConfig.path ? { ...watermarkConfig } : null,
        onUiProgress: ({ progress, step, message }) => {
          setExportLoading(true, {
            title: "보내기",
            step: step || `${label} · 처리 중`,
            message: message || "처리 중…",
            progress,
          });
        },
      });

      return new Promise((resolve) => {
        stopExportPoll();
        smoothedProgress = 40;
        smoothProgressTarget = 40;
        exportPollTimer = setInterval(async () => {
          try {
            const done = await pollExportStatus(fmt);
            if (done === true) {
              openDownload(lastExportPath);
              resolve(true);
            }
            if (done === false) resolve(false);
          } catch (err) {
            if (/503|502|504|timeout|fetch|unavailable|준비/i.test(String(err))) return;
            stopExportPoll();
            showExportError(friendlyAgentError(err));
            resolve(false);
          }
        }, 1000);
      });
    } catch (err) {
      if (!isVideoBurnInNotFoundError(err)) {
        showExportError(friendlyAgentError(err));
        return;
      }
      setExportLoading(true, {
        title: "보내기",
        step: `${label} · ASS 번인`,
        message: "에이전트 업데이트 필요 — ASS 방식으로 보냅니다…",
        progress: 10,
      });
    }
  }

  const payload = buildExportPayload(fmt);
  try {
    await requestAgent({ path: `${TOOL_PREFIX}/export`, method: "POST", json: payload });
  } catch (err) {
    showExportError(friendlyAgentError(err));
    return;
  }

  return new Promise((resolve) => {
    stopExportPoll();
    resetSmoothProgress();
    smoothedProgress = 5;
    smoothProgressTarget = 5;
    exportPollTimer = setInterval(async () => {
      try {
        const done = await pollExportStatus(fmt);
        if (done === true) {
          openDownload(lastExportPath);
          resolve(true);
        }
        if (done === false) resolve(false);
      } catch (err) {
        if (/503|502|504|timeout|fetch|unavailable|준비/i.test(String(err))) return;
        stopExportPoll();
        showExportError(friendlyAgentError(err));
        resolve(false);
      }
    }, 1000);
  });
}

function openDownload(filePath) {
  if (!filePath || !agentConnected) return;
  const fmt = exportFormatSelect?.value || "srt";
  try {
    sessionStorage.setItem("auto-subtitle:dl-file-path", filePath);
    sessionStorage.setItem("auto-subtitle:dl-format", fmt);
    sessionStorage.setItem(STORAGE_CUES, JSON.stringify(lastCues));
    sessionStorage.setItem(STORAGE_CUTS, JSON.stringify(lastCutRanges));
    const vp = videoPathInput?.value?.trim() || sessionVideoPath;
    if (vp) sessionStorage.setItem(STORAGE_VIDEO_PATH, vp);
    sessionStorage.setItem(STORAGE_RETURN_FROM_DL, "1");
  } catch { /* ignore */ }
  window.location.href = "download.html";
}

function resetJob() {
  stopPreparePoll();
  stopTranscribePoll();
  stopExportPoll();
  stopGpuInstallPoll();
  setSetupLoading(false);
  setTranscribeLoading(false);
  setExportLoading(false);
  sessionVideoPath = "";
  if (videoPathInput) videoPathInput.value = "";
  try {
    sessionStorage.removeItem(STORAGE_VIDEO_PATH);
  } catch {
    /* ignore */
  }
  clearSubtitleWorkspace();
  updatePreview("");
}

function detachPreviewMasterAudio() {
  if (!previewAudio) return;
  previewAudio.pause();
  previewAudio.removeAttribute("src");
  try {
    previewAudio.load();
  } catch {
    /* ignore */
  }
}

function updatePreview(videoPath) {
  if (!previewVideo || !previewSection) return;
  stopPlaybackLoop();
  setPreviewPlaybackUiActive(false);
  detachPreviewMasterAudio();
  const p = String(videoPath || "").trim();
  const loadGen = ++previewMediaLoadGen;
  releasePreviewMediaBlob();

  if (!p || !agentConnected) {
    previewVideo.removeAttribute("src");
    if (previewAudio) {
      previewAudio.removeAttribute("src");
      try {
        previewAudio.load();
      } catch {
        /* ignore */
      }
    }
    if (previewEmpty) {
      previewEmpty.hidden = false;
      previewEmpty.textContent = "영상·오디오 파일을 선택하세요.";
    }
    layoutPreviewMediaFrame();
    updatePreviewOverlay();
    updatePreviewWatermark();
    updatePreviewTransportUi();
    return;
  }

  const directUrl = `${getAgentOrigin()}${TOOL_PREFIX}/media/stream?video_path=${encodeURIComponent(p)}`;
  previewMediaDirectUrl = directUrl;
  if (previewEmpty) {
    previewEmpty.hidden = false;
    previewEmpty.textContent = "미디어 불러오는 중…";
  }

  previewMediaLoadAbort = new AbortController();
  const { signal } = previewMediaLoadAbort;

  void resolveAgentMediaObjectUrl(directUrl, { signal })
    .then((url) => {
      if (loadGen !== previewMediaLoadGen) return;
      previewMediaResolvedUrl = url;
      masterMediaUrl = url;
      previewVideo.src = url;
      if (previewAudio) {
        previewAudio.src = url;
        previewAudio.preload = "auto";
      }
      if (previewEmpty) previewEmpty.hidden = true;
      previewVideo.onloadedmetadata = () => {
        if (loadGen !== previewMediaLoadGen) return;
        if (previewVideo.duration > 0) sessionMediaDurationSec = previewVideo.duration;
        layoutPreviewMediaFrame();
        updatePreviewOverlay();
        updatePreviewWatermark();
        updatePreviewTransportUi();
        const orch = getPlaybackOrchestrator();
        if (!orch.video) {
          orch.attachVideo(previewVideo, {
            masterAudio: previewAudio ?? undefined,
            onPlayheadChange: ({ editSec }) => {
              if (!isVideoPlaying) playheadSec = editSec;
            },
          });
        } else if (previewAudio) {
          orch.masterAudio = previewAudio;
        }
        rebuildPlaybackSync();
      };
    })
    .catch((err) => {
      if (loadGen !== previewMediaLoadGen) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.warn("[auto-subtitle] preview media load", err);
      previewVideo.removeAttribute("src");
      if (previewAudio) {
        previewAudio.removeAttribute("src");
        try {
          previewAudio.load();
        } catch {
          /* ignore */
        }
      }
      if (previewEmpty) {
        previewEmpty.hidden = false;
        previewEmpty.textContent =
          formatAgentConnectionError(err) ||
          "미디어를 불러올 수 없습니다. Chrome 사이트 설정에서 「로컬 네트워크」를 허용해 주세요.";
      }
      layoutPreviewMediaFrame();
      updatePreviewOverlay();
      updatePreviewTransportUi();
    });
}

let pickBusy = false;
let savedPickBtnLabel = "";

function setPickBusy(busy) {
  pickBusy = busy;
  if (btnPick) {
    btnPick.disabled = busy;
    if (busy) {
      savedPickBtnLabel = btnPick.textContent || "찾아보기";
      btnPick.textContent = "파일 선택 중…";
    } else {
      btnPick.textContent = savedPickBtnLabel || "찾아보기";
    }
  }
}

function formatPickErrorDetail(data, statusText) {
  const d = data && typeof data === "object" ? data.detail : undefined;
  let msg =
    typeof d === "string"
      ? d
      : Array.isArray(d)
        ? d
            .map((x) => (x && typeof x === "object" && "msg" in x ? String(x.msg) : ""))
            .filter(Boolean)
            .join("; ")
        : statusText || "요청 실패";
  if (!/트레이|브로커|19879/i.test(msg)) {
    msg += "\n\n작업 표시줄에서 ItMatZip Agent 트레이를 실행한 뒤 다시 시도하세요.";
  }
  return msg;
}

async function onPickLocalFile() {
  if (pickBusy) return;

  const agent = await checkAgentConnection();
  if (!agent.ok) {
    await showInstallAgentDialog(await installDialogOpts());
    return;
  }

  userRequestedPreviewPause = true;
  stopPlaybackLoop();
  previewVideo?.pause();
  detachPreviewMasterAudio();

  setPickBusy(true);
  const ctrl = new AbortController();
  const tid = window.setTimeout(() => ctrl.abort(), 10 * 60 * 1000);
  let shouldTranscribe = false;

  try {
    const res = await fetchAgent(`${getAgentOrigin()}/api/agent/pick-local-file`, {
      method: "POST",
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      let msg = formatPickErrorDetail(data, res.statusText);
      if (res.status === 400 && (msg.includes("취소") || /cancel/i.test(msg))) return;
      alert(`파일 찾아보기 실패: ${msg}`);
      return;
    }

    const path =
      data && typeof data === "object"
        ? String(data.video_path || data.path || "").trim()
        : "";
    if (!path) return;
    if (!videoPathInput) return;

    const prev = sessionVideoPath || videoPathInput.value.trim();
    if (path !== prev) {
      clearSubtitleWorkspace();
    }
    sessionVideoPath = path;
    videoPathInput.value = path;
    try {
      sessionStorage.setItem(STORAGE_VIDEO_PATH, path);
    } catch {
      /* ignore */
    }
    updatePreview(path);
    updatePreviewWatermark();
    updateActionButtons();
    loadWaveformPeaks();
    shouldTranscribe = true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/취소|cancel/i.test(msg)) {
      // 사용자 취소 — 팝업 없이 조용히 무시
    } else {
      const name = e && typeof e === "object" && "name" in e ? String(e.name) : "";
      if (name === "AbortError") {
        alert("파일 선택이 시간 초과되었습니다. 다시 시도해 주세요.");
      } else {
        alert(`파일 찾아보기 실패: ${formatAgentConnectionError(e) || msg}`);
      }
    }
  } finally {
    userRequestedPreviewPause = false;
    window.clearTimeout(tid);
    setPickBusy(false);
  }

  if (shouldTranscribe) {
    await runTranscribe();
    updateActionButtons();
  }
}

const STORAGE_RETURN_FROM_DL = "auto-subtitle:return-from-download";

function restoreSession() {
  const returningFromDownload = sessionStorage.getItem(STORAGE_RETURN_FROM_DL) === "1";
  if (returningFromDownload) {
    sessionStorage.removeItem(STORAGE_RETURN_FROM_DL);
    try {
      const raw = sessionStorage.getItem(STORAGE_CUES);
      const cutsRaw = sessionStorage.getItem(STORAGE_CUTS);
      const vp = sessionStorage.getItem(STORAGE_VIDEO_PATH);
      if (raw) {
        const cues = JSON.parse(raw);
        const cuts = cutsRaw ? JSON.parse(cutsRaw) : [];
        if (vp) {
          if (videoPathInput) videoPathInput.value = vp;
          sessionVideoPath = vp;
        }
        subtitleHub.ingestFromProject(cues, { cutRanges: cuts });
        renderCuesTable(lastCues);
        if (resultsMeta) {
          resultsMeta.textContent = `${lastCues.length} cues`;
          resultsMeta.hidden = false;
        }
      }
    } catch { /* ignore */ }
    updateActionButtons();
    return;
  }

  try {
    sessionStorage.removeItem(STORAGE_CUES);
    sessionStorage.removeItem(STORAGE_CUTS);
    sessionStorage.removeItem(STORAGE_VIDEO_PATH);
  } catch {
    /* ignore */
  }
  updateActionButtons();
}

btnPick?.addEventListener("click", () => void onPickLocalFile());

btnLoadProject?.addEventListener("click", async () => {
  try {
    await onLoadProject();
  } catch (err) {
    alert(friendlyAgentError(err));
  }
});

btnSaveProjectAs?.addEventListener("click", async () => {
  try {
    await saveProjectAs();
  } catch (err) {
    if (err.name === "AbortError") return;
    alert(friendlyAgentError(err));
  }
});

btnSaveProject?.addEventListener("click", async () => {
  try {
    await saveProject();
  } catch (err) {
    if (err.name === "AbortError") return;
    alert(friendlyAgentError(err));
  }
});

btnUnloadModel?.addEventListener("click", async () => {
  try {
    await unloadModel();
  } catch (err) {
    alert(friendlyAgentError(err));
  }
});

btnNewJob?.addEventListener("click", resetJob);

btnPrepare?.addEventListener("click", async () => {
  btnPrepare.disabled = true;
  try {
    await ensurePrepared();
  } finally {
    updateActionButtons();
  }
});

btnAddFont?.addEventListener("click", () => {
  void addCustomFontFromDialog();
});

btnAddWatermark?.addEventListener("click", () => {
  void addWatermarkFromDialog();
});

btnWatermarkPositionCancel?.addEventListener("click", () => {
  closeWatermarkPositionModal();
});

btnWatermarkPositionConfirm?.addEventListener("click", () => {
  confirmWatermarkPositionSelection();
});

btnFontAddOk?.addEventListener("click", () => {
  closeFontAddModal();
});

btnUndo?.addEventListener("click", () => {
  if (subtitleHub.undo()) renderCuesTable(lastCues);
});

btnRedo?.addEventListener("click", () => {
  if (subtitleHub.redo()) renderCuesTable(lastCues);
});

btnGpuInstallDismiss?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  closeGpuInstallModal();
});

btnGpuInstallRun?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  void runGpuRuntimeInstall();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (fontAddModal && !fontAddModal.hidden) {
    if (fontAddTrack && !fontAddTrack.hidden) return;
    closeFontAddModal();
    return;
  }
  if (gpuInstallPrompt && !gpuInstallPrompt.hidden) {
    closeGpuInstallModal();
  }
});

document.addEventListener("keydown", (e) => {
  if ((e.key !== " " && e.code !== "Space") || e.repeat) return;
  if (e.isComposing || e.defaultPrevented) return;
  const target = e.target;
  if (target instanceof HTMLTextAreaElement) return;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) return;
  /** AutoSubtitle App.tsx — 카드 밖에서만 연속 재생 토글 */
  if (target instanceof Element && target.closest(".subtitle-card")) return;
  // console.log("[DOC-SPACE] toggle, target=%s, ts=%.1f, now=%.1f",
  //   target?.tagName ?? "null", e.timeStamp, performance.now());
  e.preventDefault();
  if (!previewVideo) return;
  togglePreviewPlayback();
});

document.addEventListener("keydown", (e) => {
  if (!subtitleList || !lastCues.length) return;
  handleGlobalArrowKey(e, subtitleList, lastCues, buildSubtitleCardOpts(lastCues));
});

document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const tag = e.target instanceof Element ? e.target.tagName : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === "z" && !e.shiftKey) {
    e.preventDefault();
    if (subtitleHub.undo()) renderCuesTable(lastCues);
  } else if (e.key === "y" || (e.key === "z" && e.shiftKey)) {
    e.preventDefault();
    if (subtitleHub.redo()) renderCuesTable(lastCues);
  }
});

btnExport?.addEventListener("click", async () => {
  btnExport.disabled = true;
  try {
    await runExport();
  } finally {
    updateActionButtons();
  }
});

btnDownloadResult?.addEventListener("click", () => openDownload(lastExportPath));
btnShowExportFolder?.addEventListener("click", () => showExportResultInFolder(lastExportPath));

videoPathInput?.addEventListener("input", () => {
  const p = videoPathInput?.value?.trim() || "";
  if (p !== sessionVideoPath) {
    if (sessionVideoPath || lastCues.length) clearSubtitleWorkspace();
    sessionVideoPath = p;
    try {
      if (p) sessionStorage.setItem(STORAGE_VIDEO_PATH, p);
      else sessionStorage.removeItem(STORAGE_VIDEO_PATH);
    } catch {
      /* ignore */
    }
  }
  updatePreview(p);
  updatePreviewWatermark();
  updateActionButtons();
});

btnPreviewPlay?.addEventListener("click", () => togglePreviewPlayback());

previewSeek?.addEventListener("pointerdown", () => {
  previewResumeAfterSeek = isPreviewMediaPlaying() || isVideoPlaying;
  if (previewResumeAfterSeek) {
    userRequestedPreviewPause = true;
    stopPlaybackLoop();
    userRequestedPreviewPause = false;
  }
  previewSeekDragging = true;
});

previewSeek?.addEventListener("input", () => {
  applyPreviewSeekFromControl();
});

previewSeek?.addEventListener("pointerup", () => {
  previewSeekDragging = false;
  applyPreviewSeekFromControl();
  commitPlayheadUi();
  if (previewResumeAfterSeek) startPlaybackLoop();
  previewResumeAfterSeek = false;
});

previewSeek?.addEventListener("change", () => {
  previewSeekDragging = false;
  commitPlayheadUi();
});

previewVideo?.addEventListener("click", () => togglePreviewPlayback());
previewVideo?.addEventListener("play", () => {
  if (!isHtmlAudioMasterActive()) startPlaybackLoop();
});
previewVideo?.addEventListener("timeupdate", () => {
  if (isHtmlAudioMasterActive()) return;
  if (!previewVideo || previewVideo.paused) return;
  const orch = getPlaybackOrchestrator();
  playheadSec = orch.mapMediaToEditSec(previewVideo.currentTime);
  if (!playbackRafId) {
    applyThrottledVideoSkipCut(previewVideo, getPlaybackSkipRanges());
    commitPlayheadUi();
  }
});
previewVideo?.addEventListener("pause", () => {
  if (userRequestedPreviewPause) stopPlaybackLoop();
});
previewVideo?.addEventListener("ended", () => stopPlaybackLoop());
previewVideo?.addEventListener("seeked", () => {
  if (!isVideoPlaying && previewVideo) {
    const orch = getPlaybackOrchestrator();
    playheadSec = orch.mapMediaToEditSec(previewVideo.currentTime);
    applyPlaybackSkipIfNeeded();
    commitPlayheadUi();
  }
});
previewAudio?.addEventListener("seeked", () => {
  if (!isVideoPlaying && previewAudio) {
    const orch = getPlaybackOrchestrator();
    playheadSec = orch.mapMediaToEditSec(previewAudio.currentTime);
    applyPlaybackSkipIfNeeded();
    commitPlayheadUi();
  }
});
previewAudio?.addEventListener("pause", () => {
  if (userRequestedPreviewPause && isHtmlAudioMasterActive()) stopPlaybackLoop();
});
previewAudio?.addEventListener("ended", () => {
  if (isHtmlAudioMasterActive()) stopPlaybackLoop();
});

styleFontFamily?.addEventListener("change", () => {
  syncFontSelectTitle();
  void ensureCustomFontsLoaded(customFontCatalog, styleFontFamily?.value || "");
  updatePreviewOverlay();
});

bindStyleControl("style-font-size-range", styleFontSizeOut, (el) => `${el.value}px`);
bindStyleControl("style-text-alpha", styleTextAlphaOut, (el) => el.value);
bindStyleControl("style-stroke-width", styleStrokeWidthOut, (el) => `${el.value}px`);
bindStyleControl("style-bg-opacity", styleBgOpacityOut, (el) => `${el.value}%`);
bindStyleControl("style-bg-size", styleBgSizeOut, (el) => `${el.value}%`);
bindStyleControl("style-x", styleXOut, (el) => `${el.value}%`);
bindStyleControl("style-y-range", styleYOut, (el) => `${el.value}%`);
styleTextColor?.addEventListener("input", () => updatePreviewOverlay());
styleStrokeColor?.addEventListener("input", () => updatePreviewOverlay());
styleBgColor?.addEventListener("input", () => updatePreviewOverlay());

attachUserPreferencesAutosave();

populateFontSelect(SYSTEM_FONT_CANDIDATES);
loadAndApplyUserPreferences();

startConnectionMonitor({
  onChange: async (connected, detail) => {
    const longOp = isAgentLongOperationActive();
    const apiReady = detail?.apiReady !== false;
    agentConnected = connected && (apiReady || longOp);
    const connEl = document.getElementById("connection-status");
    applyConnectionStatusDot(connEl, connected, { ...detail, longOp });
    connEl?.classList.toggle("is-connected", agentConnected);
    if (agentConnected) {
      await fetchReadiness();
      await loadSystemFontsFromAgent();
      if (sessionVideoPath && previewVideo && !previewVideo.src) {
        updatePreview(sessionVideoPath);
      }
    } else {
      toolReady = false;
      if (binReadiness) {
        binReadiness.textContent = connected && !apiReady
          ? (longOp ? "Auto Subtitle · 작업 중…" : "Auto Subtitle · API 준비 중…")
          : `${LOCAL_HELPER_NAME} 연결 필요`;
      }
    }
    updateActionButtons();
  },
  autoShowInstallDialog: true,
  installDialogOptions: installDialogOpts(),
});

startAgentEventStream({
  onEvent: (evt) => {
    const mapped = mapAgentEventToPrepareStatus?.(evt);
    if (mapped && setupLoading?.classList.contains("is-active")) {
      applyPrepareStatusFromWs(mapped);
    }
  },
});

function applyPrepareStatusFromWs(data) {
  setSetupLoading(true, {
    title: data?.phase === "downloading_models" ? "AI 모델" : "환경 준비",
    step: data?.step || "",
    message: data?.detail || data?.message || "",
    progress: data?.progress,
  });
}

initWatermarkPositionGrid();

restoreSession();
updatePreviewOverlay();
updatePreviewWatermark();
updatePreviewTransportUi();

if (previewSection && typeof ResizeObserver !== "undefined") {
  const previewLayoutObserver = new ResizeObserver(() => {
    layoutPreviewMediaFrame();
    updatePreviewOverlay();
    updatePreviewWatermark();
  });
  previewLayoutObserver.observe(previewSection);
}
previewVideo?.addEventListener("loadeddata", () => {
  layoutPreviewMediaFrame();
  updatePreviewOverlay();
  updatePreviewWatermark();
});

void showAdSense("editorBelowExport", "#editor-ad-preview-pane");
void showAdSense("editorAboveWorkspace", "#editor-ad-subtitle-pane");

document.addEventListener(
  "pointerdown",
  (e) => {
    if (expandedCueIndex < 0) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest(".subwave-flow-root")) return;
    if (t.closest('[data-waveform-expanded-row-chip="1"]')) return;
    if (t.closest('[data-waveform-mount-for-open-line="1"]')) return;
    if (t.closest('[data-waveform-no-dismiss="1"]')) return;
    closeWordWaveform();
  },
  true,
);

requestAgent({ path: "/health" }).catch(() => {});
