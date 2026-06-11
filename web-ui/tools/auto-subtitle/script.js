import {
  applyConnectionStatusDot,
  buildAgentResourceUrl,
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
} from "../common/bridge.js?v=lna16";
import { agentInstallDialogOptions } from "../common/agent-install-ui.js?v=lna20";
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
  captureTextareaForCue,
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
} from "./cue-cards.js?v=77";
import {
  handleGlobalArrowKey,
  isWordCaretKeyboardFocus,
  resetKeyboardPauseCaret,
  resetSpaceSeekIntent,
  syncCaretOnPlaybackPause,
  syncPlaybackCaretVisibility,
  clearListPlayFromCaretPreferred,
  clearAllRowCaretState,
  prepareCaretAtWord,
  getFocusedSubtitleCardIndex,
  setPreviewOverlaySyncHook,
} from "./subtitle-list/word-caret-ui.js?v=60";
import {
  nearestValidStorageCaret,
  visibleWordStorageIndices,
} from "./shared/subtitle-word-caret-map.js?v=22";
import {
  syncAllCuesFromWords,
  ensureCueWords,
  subtitleLineEditDisplayText,
  rebuildWordsFromLineText,
  markLineTextUserEdited,
  lineTextIsUserLocked,
  MIN_WORD_SPAN_SEC,
  getCueWords,
} from "./subtitle-words.js?v=24";
import { wordVisibleInWordChipRail } from "./shared/subtitles.js?v=28";
import {
  pickActiveCueIndex,
  pickActiveCueIndexWithHint,
  pickActiveCueIndexWithBlockVirtual,
  pickActiveWordIndex,
  pickActiveWordIndexForHighlight,
  pickActiveWordIndexWithHintForHighlight,
  resolveBlockVirtualSecFromMedia,
  sourceSecToProgramSecInClip,
  skipCutRangeAt,
  playableEditSecForWord,
  firstPlayableSecInRange,
} from "./playback.js?v=37";
import { USE_BLOCK_VIRTUAL_HIGHLIGHT } from "./timeline/playback-policy.js";
import { loadWaveformPeaksForMedia } from "./waveform-peaks-client.js?v=25";
import {
  buildExportRequestPayload,
  computeRequiresConcatExport,
  exportFormatLabel,
  EXPORT_TEXT_FORMATS,
  resolveExportTimeAxis,
} from "./export/export-client.js?v=29";
import {
  getWordSourceEnd,
  getWordSourceStart,
  isRelocated,
  sourceSecToVirtualSec,
} from "./shared/dual-axis.js?v=1";
import {
  blocksRequireConcatExport,
  blocksToVirtualAudioMap,
} from "./shared/blocks-to-export.js?v=5";
import { buildVirtualAudioMap } from "./shared/virtual-audio-map.js?v=4";
import {
  burnInConsoleLog,
  isVideoBurnInNotFoundError,
  runVideoBurnInExport,
} from "./export/video-burn-in-client.js?v=19";
import {
  normalizeCuesFromAgent,
  postProcessCuesAfterTranscribe,
} from "./shared/cues-ssot.js?v=39";
import {
  buildBurnInMediaContract,
  buildProgramToBurninMapFromVirtualAudioMap,
  clearSessionMediaTiming,
  getAudioTimelineDurationSec,
  getSessionMediaTiming,
  getVideoTimelineDurationSec,
  getVideoToWordTimelineScale,
  getSessionPreviewMediaPath,
  inferMediaTimingFromBrowserMedia,
  isSourceVideoPtsTimeline,
  isProgramPlaybackTimeline,
  setProgramPlaybackActive,
  mapVideoTimeToWordTimeline,
  mapWordTimelineToVideoTime,
  restoreSessionPreviewMediaPathFromStorage,
  resolveWordTimelineClockSec,
  setSessionMediaTiming,
  setSessionPreviewMediaPath,
} from "./shared/media-timing-ssot.js?v=7";
import {
  createOverlayTimingContext,
  invalidateOverlayTimingCache,
  resolveCueAtTime,
} from "./shared/overlay-timing-ssot.js?v=2";
import { resolvePeaksTimelineMetrics } from "./peaks-metrics.js?v=30";
import {
  applySubtitleOverlayTextLayout,
  buildSubtitleOverlayInnerStyle,
  normalizePreviewSubtitleText,
} from "./shared/subtitle-box-chrome.js?v=25";
import { SubtitleAppHub } from "./hub/app-hub.js?v=32";
import {
  runWordAutoAlign,
  isKoreanLanguageSelected,
  collectWordAlignTargetIndices,
  KIWI_LGPL_URL,
} from "./word-auto-align.js?v=2";
import { clearWaveformCutSecCache } from "./line-waveform-panel.js?v=8";
import {
  applyPlaybackSkipToPreviewMedia,
  applyThrottledVideoSkipCut,
  isHtmlAudioMasterActive,
  readHtmlAudioMasterPlayhead,
  resetPlaybackSkipThrottle,
  startSyncedPlayback,
  stopSyncedPlayback,
  syncVideoFromHtmlAudioMaster,
} from "./hub/synced-playback.js?v=48";
import { assignMasterAudioTimelineSecIfNeeded } from "./hub/html-audio-master-playback.js?v=2";
import { getPlaybackOrchestrator } from "./hub/playback-orchestrator.js?v=26";
import {
  buildProgramClips,
  getProgramDurationSec,
  programClipsFingerprint,
  programToSource,
  sourceToProgram,
  PROGRAM_CLIP_EPS,
} from "./shared/program-clips-ssot.js?v=6";
import {
  clearProgramSegmentTimeline,
  getProgramSegmentDurationSec,
  getProgramSegmentProgramClips,
  getProgramSegmentTimelineBundle,
  getProgramSegmentTimelineClips,
  isProgramSegmentPreviewActive,
  refreshProgramSegmentTimeline,
  isProgramSegmentTimelineRebuilding,
  setProgramSegmentTimelineCallbacks,
} from "./shared/program-segment-timeline.js?v=6";
import {
  buildBlocksPreviewPlaybackSkips,
  effectiveSourceEndForClip,
} from "./shared/clip-boundary-ssot.js?v=3";
import {
  resolveMediaSecFromProgram,
  resolveProgramSecFromMedia,
  resolveSegmentPlaybackAnchor,
  resolveSourceSecFromProgram,
} from "./shared/program-playback-clock.js?v=3";
import {
  bakeProgramMaster,
  clearProgramMasterCache,
  getProgramMasterCache,
} from "./shared/program-master-client.js?v=2";
import {
  splitSubtitleAt,
  mergeEmptySubtitleAt,
  splitSubtitleAtWord,
  backspaceWordAt,
  deleteWordAt,
  deleteWordRangeAt,
  deleteSubtitleLinesAt,
  reorderSubtitleLinesByListInsert,
} from "./shared/subtitle-edit-actions.js?v=30";
import { listableCueIndices } from "./shared/subtitle-list-indices.js?v=5";
import {
  bumpListableCueIndicesCache,
  clipIndexForListPos,
  cueIndexForClipIndex,
  getListableCueIndicesCached,
  listPosForCueIndex,
  resolveListClipIndexFromMedia,
} from "./shared/subtitle-list-playback.js?v=15";
import {
  armListOrderSeamlessPlayback,
  clearListOrderPreviewTimeline,
  getListOrderPreviewClipPos,
  getListOrderPreviewClips,
  getListOrderPreviewProgramSec,
  isListOrderPreviewPlaybackEnded,
  isListOrderPreviewTimelineActive,
  isListOrderSeamlessPlaybackActive,
  isListOrderTransitionLocked,
  isProgramPreviewExecutorActive,
  resetListOrderPreviewClipPos,
  setListOrderPreviewTimeline,
} from "./hub/list-order-preview-sync.js?v=14";
import {
  getPreviewMediaBridge,
  initPreviewMediaBridgeFromDom,
} from "./hub/seamless-preview-stack.js?v=37";
import { initSubtitleFindReplace } from "./subtitle-find-replace.js?v=5";
import { syncFindHighlightLayerToTextarea } from "./subtitle-find-replace-highlight.js?v=2";
import { syncDiagSample, syncDiagReport, syncDiagSetEnabled, syncDiagClear } from "./shared/sync-diagnostics.js?v=1";
import {
  caretPlayDiagLog,
  caretPlayDiagLogTick,
  caretPlayDiagSetEnabled,
  caretPlayDiagIsEnabled,
} from "./shared/caret-play-diagnostics.js?v=1";
import {
  mediaTimingDiagLog,
  mediaTimingDiagWarn,
  mediaTimingDiagSetEnabled,
  mediaTimingDiagIsEnabled,
} from "./shared/media-timing-diagnostics.js?v=1";
import {
  analyzeBurnInPipelineHandoff,
  burnInPipelineDiagAgentPayload,
  burnInPipelineDiagHandoff,
  burnInPipelineDiagGetLastHandoff,
  burnInPipelineDiagIsEnabled,
  burnInPipelineDiagLog,
  burnInPipelineDiagReport,
  burnInPipelineDiagRestoreFromStorage,
  burnInPipelineDiagSetEnabled,
  burnInPipelineDiagSyncAgent,
  virtualMapProgramEndSec,
} from "./shared/burn-in-pipeline-diagnostics.js?v=3";
import {
  diagLogBufferPush,
  diagLogBufferClear,
  diagLogBufferLength,
  downloadDiagLogsJson,
} from "./shared/diag-log-export.js?v=1";

configureBridge({ healthPath: "/health" });

burnInPipelineDiagRestoreFromStorage();

const TOOL_PREFIX = "/api/tools/auto-subtitle";
const STORAGE_CUES = "auto-subtitle:last-cues";
const STORAGE_CUTS = "auto-subtitle:cut-ranges";
const STORAGE_EXPORT_PATH = "auto-subtitle:export-path";
const STORAGE_VIDEO_PATH = "auto-subtitle:last-video-path";
const STORAGE_RETURN_FROM_DL = "auto-subtitle:return-from-download";
const STORAGE_DL_RESTORE = "auto-subtitle:dl-restore-snapshot";
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
const btnFindReplace = document.getElementById("btn-find-replace");
const btnWordAutoAlign = document.getElementById("btn-word-auto-align");
const binReadiness = document.getElementById("bin-readiness");
const subtitleList = document.getElementById("subtitle-list");
const subtitleEmpty = document.getElementById("subtitle-empty");
const resultsMeta = document.getElementById("results-meta");
const previewSection = document.getElementById("preview-section");
const previewMediaFrame = document.getElementById("preview-media-frame");
const previewVideoEl = document.getElementById("preview-video-a");
const previewAudioEl = document.getElementById("preview-audio-a");
initPreviewMediaBridgeFromDom();
const previewBridge = getPreviewMediaBridge();
previewBridge.setOnLayerSwapped(() => {
  const orch = getPlaybackOrchestrator();
  const v = previewBridge.video;
  const a = previewBridge.audio;
  if (v) orch.attachVideo(v, { masterAudio: a ?? undefined });
});

/** Web Audio 그래프·목록 seamless 시 audible 레이어 SSOT */
function usesSeamlessAudioClock() {
  const stack = previewBridge.stack;
  return Boolean(
    stack &&
      (stack.isListOrderMode() || (stack.graphReady && !stack.graphFailed)),
  );
}

/** 재생 중 더블 버퍼 스왑 반영 */
function getPv() {
  return previewBridge.video ?? previewVideoEl;
}
function getPa() {
  if (usesSeamlessAudioClock()) {
    return previewBridge.audio ?? previewAudioEl;
  }
  return previewBridge.primaryAudio ?? previewAudioEl;
}
const previewOverlay = document.getElementById("preview-subtitle-overlay");
const previewWatermarkOverlay = document.getElementById("preview-watermark-overlay");
const previewEmpty = document.getElementById("preview-empty");
const btnPreviewPlay = document.getElementById("btn-preview-play");
const btnHqPreview = document.getElementById("btn-hq-preview");
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

const previewMediaLoading = document.getElementById("preview-media-loading");
const previewMediaLoadingTitle = document.getElementById("preview-media-loading-title");
const previewMediaLoadingStep = document.getElementById("preview-media-loading-step");
const previewMediaLoadingMessage = document.getElementById("preview-media-loading-message");
const previewMediaLoadingBar = document.getElementById("preview-media-loading-bar");
const previewMediaLoadingTrack = document.getElementById("preview-media-loading-track");
const previewMediaLoadingActions = document.getElementById("preview-media-loading-actions");
const btnPreviewMediaLoadingOk = document.getElementById("btn-preview-media-loading-ok");

const wordAlignLoading = document.getElementById("word-align-loading");
const wordAlignLoadingTitle = document.getElementById("word-align-loading-title");
const wordAlignLoadingStep = document.getElementById("word-align-loading-step");
const wordAlignLoadingMessage = document.getElementById("word-align-loading-message");
const wordAlignLoadingBar = document.getElementById("word-align-loading-bar");
const wordAlignLoadingTrack = document.getElementById("word-align-loading-track");
const wordAlignLoadingPercent = document.getElementById("word-align-loading-percent");
const wordAlignKiwiLink = document.getElementById("word-align-kiwi-link");

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
/** @type {Set<number>} */
let checkedCueIndices = new Set();
let subtitleLineDragActive = false;
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
  if (getPa() && isHtmlAudioMasterActive()) {
    return !getPa().paused;
  }
  return Boolean(getPv() && !getPv().paused);
}

function mapEditSecToPreviewMediaSec(editSec) {
  const orch = getPlaybackOrchestrator();
  const skip = getPlaybackSkipRanges();
  if (isBlocksProgramSegmentPreview()) {
    return skipCutRangeAt(
      resolveMediaSecFromProgram(editSec, getProgramSegmentTimelineClips()),
      skip,
    );
  }
  return skipCutRangeAt(orch.mapEditToMediaSec(editSec), skip);
}

function mapPreviewMediaSecToEditSec(mediaSec) {
  const orch = getPlaybackOrchestrator();
  if (isBlocksProgramSegmentPreview()) {
    const clips = getProgramSegmentTimelineClips();
    const clipHint = getActiveSegmentClipPosHint();
    return resolveProgramSecFromMedia(mediaSec, clips, clipHint);
  }
  return orch.mapMediaToEditSec(mediaSec);
}

/**
 * cue/word.start·end — source(media) 축 → playhead(program 또는 edit) 축.
 * @param {number} sourceSec
 */
function mapSourceSecToPlayheadSec(sourceSec) {
  const t = Math.max(0, Number(sourceSec) || 0);
  if (isBlocksProgramSegmentPreview()) {
    return sourceToProgram(getActiveProgramClips(), t);
  }
  return mapPreviewMediaSecToEditSec(t);
}

/**
 * @param {number} cueIndex
 */
function cuePlayheadBounds(cueIndex) {
  const cue = lastCues[cueIndex];
  if (!cue) return { start: 0, end: 0 };
  if (isBlocksProgramSegmentPreview()) {
    const clips = getProgramSegmentTimelineClips();
    if (clips?.length) {
      const listPos = listPosForCueIndex(lastCues, cueIndex);
      const clipPos = clipIndexForListPos(clips, lastCues, listPos);
      const clip = clips[clipPos];
      if (clip) return { start: clip.editStart, end: clip.editEnd };
    }
    const clips2 = getActiveProgramClips();
    return {
      start: sourceToProgram(clips2, Number(cue.start) || 0),
      end: sourceToProgram(clips2, Number(cue.end) || 0),
    };
  }
  return { start: Number(cue.start) || 0, end: Number(cue.end) || 0 };
}

/**
 * cue/word source(media) → playhead(program) — 해당 cue(block) 기준 (재정렬 후 역매핑 오류 방지).
 * @param {number} cueIndex
 * @param {number} sourceSec
 */
function mapSourceSecToPlayheadSecForCue(cueIndex, sourceSec) {
  const t = Math.max(0, Number(sourceSec) || 0);
  if (!isBlocksProgramSegmentPreview()) {
    return mapSourceSecToPlayheadSec(t);
  }
  const programClips = getActiveProgramClips();
  const pc = programClips.find((c) => c.blockIndex === cueIndex);
  if (pc && t >= pc.sourceStart - 0.02 && t <= pc.sourceEnd + 0.02) {
    return pc.programStart + (t - pc.sourceStart);
  }
  const clips = getProgramSegmentTimelineClips();
  if (clips?.length && cueIndex >= 0) {
    const listPos = listPosForCueIndex(lastCues, cueIndex);
    const clipPos = clipIndexForListPos(clips, lastCues, listPos);
    const clip = clips[clipPos];
    if (clip && t >= clip.mediaStart - 0.02 && t < clip.mediaEnd + 0.02) {
      return clip.editStart + (t - clip.mediaStart);
    }
  }
  return sourceToProgram(programClips, t);
}

/** 파형 패널·waveformPlayRangeEndEdit — source(media) 축 playhead */
function getWaveformEditSec(cueIndex = expandedCueIndex) {
  if (!isBlocksProgramSegmentPreview()) {
    return playheadSec;
  }
  const ci = cueIndex >= 0 ? cueIndex : selectedCueIndex;
  const programClips = getActiveProgramClips();
  if (ci >= 0 && programClips.length) {
    const pc = programClips.find((c) => c.blockIndex === ci);
    if (
      pc &&
      playheadSec >= pc.programStart - 0.02 &&
      playheadSec < pc.programEnd + 0.02
    ) {
      return pc.sourceStart + (playheadSec - pc.programStart);
    }
  }
  return programClips.length ? programToSource(programClips, playheadSec) : playheadSec;
}

/** source(edit) → CFR 미디어 seek */
function mapWaveformEditToMediaSec(sourceEditSec) {
  const skip = getPlaybackSkipRanges();
  if (isBlocksProgramSegmentPreview()) {
    return skipCutRangeAt(Math.max(0, Number(sourceEditSec) || 0), skip);
  }
  const orch = getPlaybackOrchestrator();
  return skipCutRangeAt(orch.mapEditToMediaSec(sourceEditSec), skip);
}

/** CFR 미디어 → source(edit) — 파형 UI용 */
function mapWaveformMediaToEditSec(mediaSec) {
  if (isBlocksProgramSegmentPreview()) {
    return Math.max(0, Number(mediaSec) || 0);
  }
  const orch = getPlaybackOrchestrator();
  return orch.mapMediaToEditSec(mediaSec);
}

/**
 * word/cue 클릭 seek — source(media) 축 SSOT.
 * @param {number} sourceSec
 * @param {{ commitUi?: boolean, cueIndex?: number }} [opts]
 */
function seekPreviewToSourceSec(sourceSec, opts = {}) {
  if (!getPv() || !Number.isFinite(sourceSec)) return;
  const skip = getPlaybackSkipRanges();
  let media = skipCutRangeAt(Math.max(0, sourceSec), skip);
  const cueIndex =
    Number.isFinite(Number(opts.cueIndex)) && Number(opts.cueIndex) >= 0
      ? Number(opts.cueIndex)
      : selectedCueIndex;

  if (isBlocksProgramSegmentPreview()) {
    playheadSec =
      cueIndex >= 0
        ? mapSourceSecToPlayheadSecForCue(cueIndex, sourceSec)
        : mapSourceSecToPlayheadSec(sourceSec);
    const clips = getProgramSegmentTimelineClips();
    if (clips?.length) {
      const anchor = resolveSegmentPlaybackAnchorWithSkips(playheadSec, clips);
      playheadSec = anchor.programSec;
      listPlaybackClipPos = anchor.clipPos;
      resetListOrderPreviewClipPos(anchor.clipPos);
      media = skipCutRangeAt(anchor.mediaSec, skip);
    }
  } else {
    playheadSec = mapPreviewMediaSecToEditSec(media);
  }

  if (getPa()?.src) assignMasterAudioTimelineSecIfNeeded(getPa(), media);
  const videoMedia = mapWordTimelineToVideoTime(media);
  if (getPv()) {
    if (Number.isFinite(getPv().duration) && getPv().duration > 0) {
      const vSeek = Math.min(videoMedia, Math.max(0, getPv().duration - 0.001));
      if (Math.abs(getPv().currentTime - vSeek) > 0.002) getPv().currentTime = vSeek;
    } else if (Math.abs(getPv().currentTime - videoMedia) > 0.002) {
      getPv().currentTime = videoMedia;
    }
  }
  getPlaybackOrchestrator().seekMediaSec(media);
  if (opts.commitUi !== false) commitPlayheadUi();
}

/** 재생 클럭 — transport·edit 축 (audible SSOT) */
function readPreviewMediaClockSec() {
  if (isProgramPlaybackTimeline() && getPv() && Number.isFinite(getPv().currentTime)) {
    return Math.max(0, getPv().currentTime);
  }
  const skip = getPlaybackSkipRanges();
  if (getPa() && isHtmlAudioMasterActive()) {
    const { mediaSec, active } = readHtmlAudioMasterPlayhead(getPa(), {
      skipRanges: skip,
    });
    if (mediaSec != null) return mediaSec;
    if (active && getPv() && Number.isFinite(getPv().currentTime)) {
      return resolveWordTimelineClockSec({
        audio: getPa(),
        video: getPv(),
        preferAudio: false,
      });
    }
  }
  return resolveWordTimelineClockSec({
    audio: getPa(),
    video: getPv(),
    fallbackSec: 0,
    preferAudio: true,
  });
}

/** 일시정지 직전 — html-audio 마스터가 살아 있을 때 오디오 시계 우선 */
function capturePlayheadFromPreviewMedia() {
  const orch = getPlaybackOrchestrator();
  const before = playheadSec;
  if (isProgramPlaybackTimeline()) {
    const v = getPv();
    if (v && Number.isFinite(v.currentTime)) {
      playheadSec = Math.max(0, v.currentTime);
      caretPlayDiagLog("capturePlayheadFromPreviewMedia", caretPlayDiagSnapshot({
        playheadBefore: before,
        playheadAfter: playheadSec,
        capturedMediaSec: v.currentTime,
        programPlayback: true,
      }));
      return;
    }
  }
  if (isBlocksProgramSegmentPreview()) {
    const clips = getProgramSegmentTimelineClips();
    let media = null;
    if (getPa() && Number.isFinite(getPa().currentTime)) {
      media = getPa().currentTime;
    } else if (getPv() && Number.isFinite(getPv().currentTime)) {
      media = getPv().currentTime;
    }
    if (media != null) {
      const anchor = resolveSegmentPlaybackAnchorWithSkips(
        resolveProgramSecFromMedia(media, clips),
        clips,
      );
      playheadSec = anchor.programSec;
      listPlaybackClipPos = anchor.clipPos;
      resetListOrderPreviewClipPos(anchor.clipPos);
      caretPlayDiagLog("capturePlayheadFromPreviewMedia", caretPlayDiagSnapshot({
        playheadBefore: before,
        playheadAfter: playheadSec,
        capturedMediaSec: media,
        segmentPreview: true,
        clipPos: anchor.clipPos,
      }));
      return;
    }
  }
  if (isSourceVideoPtsTimeline()) {
    const v = getPv();
    if (v && Number.isFinite(v.currentTime)) {
      playheadSec = orch.mapMediaToEditSec(v.currentTime);
      caretPlayDiagLog("capturePlayheadFromPreviewMedia", caretPlayDiagSnapshot({
        playheadBefore: before,
        playheadAfter: playheadSec,
        capturedMediaSec: v.currentTime,
        videoPtsTimeline: true,
      }));
      return;
    }
  }
  let media = null;
  if (getPa() && Number.isFinite(getPa().currentTime)) {
    media = getPa().currentTime;
  } else if (getPv() && Number.isFinite(getPv().currentTime)) {
    media = mapVideoTimeToWordTimeline(getPv().currentTime);
  }
  if (media == null) return;
  playheadSec = orch.mapMediaToEditSec(media);
  caretPlayDiagLog("capturePlayheadFromPreviewMedia", caretPlayDiagSnapshot({
    playheadBefore: before,
    playheadAfter: playheadSec,
    capturedMediaSec: media,
  }));
}

/** Electron syncPausedMasterToEdit — 정지 시 word(audio) 축 기준으로 A/V seek */
let syncPausedPreviewRaf = 0;

function scheduleSyncPausedPreviewMediaToPlayhead() {
  if (syncPausedPreviewRaf) {
    cancelAnimationFrame(syncPausedPreviewRaf);
  }
  syncPausedPreviewRaf = requestAnimationFrame(() => {
    syncPausedPreviewRaf = 0;
    syncPausedPreviewMediaToPlayhead();
  });
}

function syncPausedPreviewMediaToPlayhead() {
  if (!getPv() || !Number.isFinite(playheadSec)) return;
  if (isProgramSegmentTimelineRebuilding()) return;
  if (isProgramPlaybackTimeline()) {
    const dur = getPv().duration;
    const seek =
      Number.isFinite(dur) && dur > 0
        ? Math.min(Math.max(0, playheadSec), Math.max(0, dur - 0.001))
        : Math.max(0, playheadSec);
    if (getPa()?.src) assignMasterAudioTimelineSecIfNeeded(getPa(), seek);
    if (Math.abs(getPv().currentTime - seek) > 0.002) getPv().currentTime = seek;
    getPa()?.pause();
    getPv().pause();
    playheadSec = seek;
    return;
  }
  const skip = getPlaybackSkipRanges();
  if (isBlocksProgramSegmentPreview()) {
    const clips = getProgramSegmentTimelineClips();
    if (clips?.length) {
      const anchor = resolveSegmentPlaybackAnchorWithSkips(playheadSec, clips);
      playheadSec = anchor.programSec;
      listPlaybackClipPos = anchor.clipPos;
      resetListOrderPreviewClipPos(anchor.clipPos);
      let wordMedia = anchor.mediaSec;
      const audioDur = getAudioTimelineDurationSec();
      if (audioDur && audioDur > 0) {
        wordMedia = Math.min(wordMedia, Math.max(0, audioDur - 0.001));
      }
      const videoMedia = mapWordTimelineToVideoTime(wordMedia);
      if (getPa()?.src) {
        assignMasterAudioTimelineSecIfNeeded(getPa(), wordMedia);
      }
      if (Number.isFinite(getPv().duration) && getPv().duration > 0) {
        const vSeek = Math.min(videoMedia, Math.max(0, getPv().duration - 0.001));
        if (Math.abs(getPv().currentTime - vSeek) > 0.002) {
          getPv().currentTime = vSeek;
        }
      } else if (Math.abs(getPv().currentTime - videoMedia) > 0.002) {
        getPv().currentTime = videoMedia;
      }
      getPa()?.pause();
      getPv().pause();
      previewBridge.stack?.pauseAllMedia?.();
      caretPlayDiagLog("syncPausedPreviewMediaToPlayhead", caretPlayDiagSnapshot({
        wordMedia,
        videoMedia,
        playheadEditSec: playheadSec,
        clipPos: anchor.clipPos,
      }));
      return;
    }
  }
  let wordMedia = mapEditSecToPreviewMediaSec(playheadSec);
  const audioDur = getAudioTimelineDurationSec();
  if (audioDur && audioDur > 0) {
    wordMedia = Math.min(wordMedia, Math.max(0, audioDur - 0.001));
  }
  const videoMedia = mapWordTimelineToVideoTime(wordMedia);
  if (getPa()?.src) {
    assignMasterAudioTimelineSecIfNeeded(getPa(), wordMedia);
  }
  if (Number.isFinite(getPv().duration) && getPv().duration > 0) {
    const vSeek = Math.min(videoMedia, Math.max(0, getPv().duration - 0.001));
    if (Math.abs(getPv().currentTime - vSeek) > 0.002) {
      getPv().currentTime = vSeek;
    }
  } else if (Math.abs(getPv().currentTime - videoMedia) > 0.002) {
    getPv().currentTime = videoMedia;
  }
  getPa()?.pause();
  getPv().pause();
  playheadSec = mapPreviewMediaSecToEditSec(wordMedia);
  caretPlayDiagLog("syncPausedPreviewMediaToPlayhead", caretPlayDiagSnapshot({
    wordMedia,
    videoMedia,
    playheadEditSec: playheadSec,
  }));
}

/**
 * 추론 없이 확정된 mediaSec으로 A/V·stack을 동기 seek (Hot Reorder Phase 1+).
 * resolveSegmentPlaybackAnchor를 호출하지 않으며 clipPos/playheadSec은 기본적으로 변경하지 않습니다.
 *
 * @param {number} mediaSec
 * @param {{ logTag?: string, clipPos?: number, pauseMedia?: boolean, updatePlayhead?: boolean }} [opts]
 */
function directSeekPreviewMedia(mediaSec, opts = {}) {
  if (!getPv()) return;
  if (isProgramSegmentTimelineRebuilding()) return;

  const pauseMedia = opts.pauseMedia !== false;
  const updatePlayhead = opts.updatePlayhead === true;
  const skip = getPlaybackSkipRanges();
  let wordMedia = skipCutRangeAt(Math.max(0, Number(mediaSec) || 0), skip);

  if (isProgramPlaybackTimeline() && !isBlocksProgramSegmentPreview()) {
    const dur = getPv().duration;
    const seek =
      Number.isFinite(dur) && dur > 0
        ? Math.min(wordMedia, Math.max(0, dur - 0.001))
        : wordMedia;
    if (getPa()?.src) assignMasterAudioTimelineSecIfNeeded(getPa(), seek);
    if (Math.abs(getPv().currentTime - seek) > 0.002) getPv().currentTime = seek;
    if (pauseMedia) {
      getPa()?.pause();
      getPv().pause();
    }
    if (updatePlayhead) playheadSec = seek;
    caretPlayDiagLog(opts.logTag || "directSeekPreviewMedia", caretPlayDiagSnapshot({
      wordMedia: seek,
      videoMedia: seek,
      playheadEditSec: playheadSec,
      clipPos: opts.clipPos ?? listPlaybackClipPos,
    }));
    return;
  }

  const audioDur = getAudioTimelineDurationSec();
  if (audioDur && audioDur > 0) {
    wordMedia = Math.min(wordMedia, Math.max(0, audioDur - 0.001));
  }
  const videoMedia = mapWordTimelineToVideoTime(wordMedia);
  if (getPa()?.src) {
    assignMasterAudioTimelineSecIfNeeded(getPa(), wordMedia);
  }
  if (Number.isFinite(getPv().duration) && getPv().duration > 0) {
    const vSeek = Math.min(videoMedia, Math.max(0, getPv().duration - 0.001));
    if (Math.abs(getPv().currentTime - vSeek) > 0.002) {
      getPv().currentTime = vSeek;
    }
  } else if (Math.abs(getPv().currentTime - videoMedia) > 0.002) {
    getPv().currentTime = videoMedia;
  }
  if (pauseMedia) {
    getPa()?.pause();
    getPv().pause();
    previewBridge.stack?.pauseAllMedia?.();
  }
  if (updatePlayhead) {
    playheadSec = mapPreviewMediaSecToEditSec(wordMedia);
  }
  caretPlayDiagLog(opts.logTag || "directSeekPreviewMedia", caretPlayDiagSnapshot({
    wordMedia,
    videoMedia,
    playheadEditSec: playheadSec,
    clipPos: opts.clipPos ?? listPlaybackClipPos,
  }));
}

/** @param {number} startMediaSec @param {{ disableListOrder?: boolean }} [opts] */
async function beginPreviewSyncedPlayback(startMediaSec, opts = {}) {
  const url = getPreviewMediaPlaybackUrl();
  if (!url || !getPv() || !getPa()) return false;
  const disableListOrder =
    opts.disableListOrder === true || waveformPlayRangeEndEdit != null;
  caretPlayDiagLog("beginPreviewSyncedPlayback", caretPlayDiagSnapshot({
    startMediaSec,
    disableListOrder,
    waveformRangeEnd: waveformPlayRangeEndEdit,
  }));
  masterMediaUrl = url;
  if (!disableListOrder) {
    ensureListOrderPreviewTimelineSynced();
  }
  await previewBridge.unlockAudioOutput();
  const clipPos = Math.max(
    0,
    listPlaybackClipPos >= 0
      ? listPlaybackClipPos
      : getListOrderPreviewClipPos(),
  );
  await startSyncedPlayback(url, getPv(), getPa(), {
    startMediaSec,
    skipRanges: getPlaybackSkipRanges(),
    clipPos,
    disableListOrder,
  });
  return true;
}

/** @type {number | null} 파형 ▶ 재생 시 편집축 종료 시각 */
let waveformPlayRangeEndEdit = null;
/** 삭제 직후 seek/play 지연 (AutoSubtitle armDeleteGuard) */
let deleteGuardUntil = 0;
let lastPlaybackCueIndex = -1;
let lastPlaybackWordIndex = -1;
/** 목록(표시 IDX) 기준 재생 — listPos 0..n-1, 파형 구간 재생 시 -1 */
let listPlaybackListPos = -1;
/** 목록 stitched 클립 인덱스 (미디어 시각 역매핑 대신 SSOT) */
let listPlaybackClipPos = -1;
/** Phase 4-12 — program-master 단일 파일 HQ 미리보기 (편집 시 자동 해제) */
let hqPreviewMode = false;
/** @type {import("./shared/program-segment-timeline.js").RefreshProgramSegmentTimelineOpts | null} */
let hubBlocksChangedOpts = null;
/** Hot reorder 진행 중 list-order tick·playhead 갱신 차단 */
let hotReorderInFlight = false;
/** 줄 드래그 시작 시점 재생 상태 — drop 시 isVideoPlaying이 잠깐 false여도 playing 경로 유지 */
let hotReorderDragWasPlaying = false;
/** segment 타임라인 fingerprint — 편집 후 preservePlayhead 억제 */
let lastPlaybackSegmentFingerprint = "";
let lastOverlayCueIndex = -1;
let lastOverlayDisplayText = "";
/** @type {import("./shared/overlay-timing-ssot.js").OverlayTimingContext | null} */
let overlayTimingCtx = null;
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
/** V5 — program-master.mp4 (preview/export SSOT) */
let programMasterPreviewPath = "";
/** @type {string} */
let watermarkMediaDirectUrl = "";
/** @type {string} */
let watermarkMediaResolvedUrl = "";
let watermarkMediaLoadGen = 0;

function releaseWatermarkMediaBlob() {
  if (watermarkMediaDirectUrl) {
    revokeAgentMediaObjectUrl(watermarkMediaDirectUrl);
    watermarkMediaDirectUrl = "";
  }
  watermarkMediaResolvedUrl = "";
}

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
/** download.html 복귀 후 CFR 미리보기·playhead 재적용 대기 */
let downloadReturnRestorePending = false;
/** @type {{
 *   playback?: { programSec?: number, listPlaybackClipPos?: number },
 *   exportPath?: string | null,
 * } | null} */
let downloadReturnRestoreMeta = null;
/** @type {string | null} */
let masterMediaUrl = null;
/** 재생·피크·파형 축 SSOT (timeline_sec / 브라우저 duration) */
let sessionMediaDurationSec = null;
/** Whisper info.duration — pcm 피크 축과 다를 때 자막 시각 스케일용 */
let sessionWhisperDurationSec = null;
/** readiness.binaries.audiowaveform — false면 pcm_columns만 사용 */
let agentAudiowaveformAvailable = false;
let wordAlignRunning = false;

const subtitleHub = new SubtitleAppHub({
  onStateChange: () => {
    syncHubFromState();
  },
  playbackSnapshotProvider: () => ({
    programSec: playheadSec,
    listPlaybackClipPos:
      listPlaybackClipPos >= 0 ? listPlaybackClipPos : getListOrderPreviewClipPos(),
  }),
});

setProgramSegmentTimelineCallbacks({
  onOrchestratorRebuild(bundle) {
    rebuildPlaybackSyncFromSegmentBundle(bundle);
  },
  onOverlayRefresh() {
    refreshOverlayTimingContext();
  },
  onPlayheadClamp(nextProgramSec) {
    playheadSec = nextProgramSec;
  },
});

function isHqPreviewMode() {
  return hqPreviewMode;
}

function isBlocksProgramSegmentPreview() {
  if (hqPreviewMode) return false;
  return Boolean(subtitleHub.blocks?.length && isProgramSegmentPreviewActive());
}

/**
 * @returns {{
 *   mediaNow: number,
 *   isVideoPlaying: boolean,
 *   wasPlayingAtDragStart: boolean,
 *   committedClipPos: number,
 *   blockId: string,
 *   programSec: number,
 * }}
 */
function captureHotReorderPlaybackSnapshot() {
  const bridge = getPreviewMediaBridge();
  const clips = getProgramSegmentTimelineClips();
  const programClips = getProgramSegmentProgramClips();
  let committedClipPos = bridge.getCommittedClipPos();
  if (committedClipPos < 0) {
    committedClipPos =
      listPlaybackClipPos >= 0 ? listPlaybackClipPos : getListOrderPreviewClipPos();
  }
  committedClipPos = Math.max(0, committedClipPos);
  const clip = clips?.[committedClipPos];
  const rawMedia = readPreviewMediaClockSec();
  const blockId = programClips?.[committedClipPos]?.id
    ? String(programClips[committedClipPos].id)
    : clip?.blockId
      ? String(clip.blockId)
      : "";
  return {
    mediaNow: Number.isFinite(rawMedia) ? rawMedia : 0,
    isVideoPlaying: Boolean(isVideoPlaying),
    wasPlayingAtDragStart: Boolean(hotReorderDragWasPlaying),
    committedClipPos,
    blockId,
    programSec: playheadSec,
  };
}

/**
 * @param {string} blockId
 * @param {readonly import("./shared/program-clips-ssot.js").ProgramClip[]} programClips
 * @param {readonly import("./shared/timeline-mapping.js").TimelineClip[]} timelineClips
 */
function findClipPosByBlockId(blockId, programClips, timelineClips) {
  const id = String(blockId || "").trim();
  if (!id) return -1;
  if (programClips?.length) {
    const idx = programClips.findIndex((c) => String(c.id) === id);
    if (idx >= 0) return idx;
  }
  if (timelineClips?.length) {
    const idx = timelineClips.findIndex((c) => String(c.blockId || "") === id);
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * @param {number} clipPos
 * @param {readonly import("./shared/program-clips-ssot.js").ProgramClip[]} programClips
 * @param {readonly import("./shared/timeline-mapping.js").TimelineClip[]} timelineClips
 */
function getBlockIdAtClipPos(clipPos, programClips, timelineClips) {
  if (clipPos >= 0 && programClips?.[clipPos]?.id) {
    return String(programClips[clipPos].id);
  }
  const tc = timelineClips?.[clipPos];
  if (tc?.blockId) return String(tc.blockId);
  return "";
}

/**
 * @param {import("./shared/timeline-mapping.js").TimelineClip} clip
 * @param {number} mediaSec
 */
function linearProgramSecFromClip(clip, mediaSec) {
  const editStart = Number(clip.editStart) || 0;
  const mediaStart = Number(clip.mediaStart) || 0;
  return editStart + (Math.max(0, Number(mediaSec) || 0) - mediaStart);
}

/**
 * @param {{ mediaNow: number, blockId?: string }} snapshot
 * @param {readonly import("./shared/timeline-mapping.js").TimelineClip[]} timelineClips
 * @param {readonly import("./shared/program-clips-ssot.js").ProgramClip[]} programClips
 * @returns {{ clipPos: number, mediaSec: number, programSec: number } | null}
 */
function buildExplicitHotReorderAnchor(snapshot, timelineClips, programClips) {
  const clipPos = findClipPosByBlockId(snapshot.blockId, programClips, timelineClips);
  if (clipPos < 0 || !timelineClips?.[clipPos]) return null;
  const clip = timelineClips[clipPos];
  const mediaNow = Math.max(0, Number(snapshot.mediaNow) || 0);
  const skip = getPlaybackSkipRanges();
  let mediaSec = clampMediaSecToTimelineClip(clip, mediaNow);
  mediaSec = skipCutRangeAt(mediaSec, skip);
  return {
    clipPos,
    mediaSec,
    programSec: linearProgramSecFromClip(clip, mediaSec),
  };
}

/** Hot reorder fallback — resolveSegmentPlaybackAnchor 없이 재생 루프만 중단 */
function hotReorderStopPlaybackWithoutResolve() {
  playbackLoopGeneration += 1;
  isVideoPlaying = false;
  setPreviewPlaybackUiActive(false);
  waveformPlayRangeEndEdit = null;
  if (playbackRafId) {
    cancelAnimationFrame(playbackRafId);
    playbackRafId = 0;
  }
}

/** @param {{ mediaNow: number, blockId?: string }} snapshot */
function performHotReorderLookupFailureFallback(snapshot) {
  hotReorderStopPlaybackWithoutResolve();
  getPa()?.pause();
  getPv()?.pause();
  previewBridge.stack?.pauseAllMedia?.();
  console.error("[HotReorder] block.id lookup failed", snapshot);
  directSeekPreviewMedia(Math.max(0, Number(snapshot.mediaNow) || 0), {
    logTag: "hotReorder:lookupFailure",
    pauseMedia: true,
  });
}

/**
 * @param {{ mediaNow: number, blockId?: string }} snapshot
 * @param {readonly import("./shared/timeline-mapping.js").TimelineClip[]} timelineClips
 * @param {readonly import("./shared/program-clips-ssot.js").ProgramClip[]} programClips
 */
function performHotReorderQuietRollback(snapshot, timelineClips, programClips) {
  hotReorderStopPlaybackWithoutResolve();
  getPa()?.pause();
  getPv()?.pause();
  previewBridge.stack?.pauseAllMedia?.();
  console.error("[HotReorder] Stack ID Mismatch", snapshot);

  const mediaNow = Math.max(0, Number(snapshot.mediaNow) || 0);
  const clipPos = findClipPosByBlockId(snapshot.blockId, programClips, timelineClips);
  if (clipPos >= 0 && timelineClips[clipPos]) {
    const clip = timelineClips[clipPos];
    const skip = getPlaybackSkipRanges();
    const mediaSec = skipCutRangeAt(clampMediaSecToTimelineClip(clip, mediaNow), skip);
    directSeekPreviewMedia(mediaSec, {
      logTag: "hotReorder:rollbackDirectSeek",
      clipPos,
      pauseMedia: true,
    });
    const anchor = {
      clipPos,
      mediaSec,
      programSec: linearProgramSecFromClip(clip, mediaSec),
    };
    applySegmentPlaybackAnchor(anchor);
    ensureListOrderPreviewTimelineSynced();
    getPreviewMediaBridge().sealHotReorderStack(anchor.clipPos);
    syncListPlaybackHighlightFromAnchor(anchor);
    caretPlayDiagLog("hotReorder:rollback", caretPlayDiagSnapshot({ anchor, blockId: snapshot.blockId }));
    return;
  }
  directSeekPreviewMedia(mediaNow, {
    logTag: "hotReorder:rollbackMediaOnly",
    pauseMedia: true,
  });
}

/**
 * @param {{ blockId?: string }} snapshot
 * @param {{ clipPos: number }} anchor
 * @param {readonly import("./shared/timeline-mapping.js").TimelineClip[]} timelineClips
 * @param {readonly import("./shared/program-clips-ssot.js").ProgramClip[]} programClips
 */
function verifyHotReorderStackOnce(snapshot, anchor, timelineClips, programClips) {
  const expected = String(snapshot.blockId || "").trim();
  if (!expected) return true;
  const actual = getBlockIdAtClipPos(anchor.clipPos, programClips, timelineClips);
  if (actual === expected) return true;
  performHotReorderQuietRollback(snapshot, timelineClips, programClips);
  return false;
}

/**
 * @param {import("./shared/timeline-mapping.js").TimelineClip} clip
 * @param {number} mediaSec
 */
function clampMediaSecToTimelineClip(clip, mediaSec) {
  if (!clip) return mediaSec;
  const start = Number(clip.mediaStart) || 0;
  const end = Math.max(start, Number(clip.mediaEnd) - 0.04);
  return Math.min(Math.max(mediaSec, start), end);
}

/**
 * @param {number} programSec
 * @param {readonly import("./shared/timeline-mapping.js").TimelineClip[]} timelineClips
 * @param {number} [clipPosHint]
 */
function resolveSegmentPlaybackAnchorWithSkipsOnClips(
  programSec,
  timelineClips,
  clipPosHint = -1,
) {
  if (!timelineClips?.length) {
    return { programSec: Math.max(0, Number(programSec) || 0), mediaSec: 0, clipPos: 0 };
  }
  const skip = getPlaybackSkipRanges();
  let anchor = resolveSegmentPlaybackAnchor(programSec, timelineClips, clipPosHint);
  let media = skipCutRangeAt(anchor.mediaSec, skip);
  if (Math.abs(media - anchor.mediaSec) > 0.001) {
    anchor = resolveSegmentPlaybackAnchor(
      resolveProgramSecFromMedia(media, timelineClips, anchor.clipPos),
      timelineClips,
      anchor.clipPos,
    );
    anchor = { ...anchor, mediaSec: media };
  }
  return anchor;
}

/**
 * @param {{ clipPos: number }} anchor
 */
function syncListPlaybackHighlightFromAnchor(anchor) {
  const clips = getProgramSegmentTimelineClips();
  if (!clips?.length) return;
  const cueIndex = cueIndexForClipIndex(clips, lastCues, anchor.clipPos);
  if (cueIndex >= 0) {
    listPlaybackListPos = listPosForCueIndex(lastCues, cueIndex);
  }
}

/**
 * @param {{ programSec: number, mediaSec: number, clipPos: number }} anchor
 */
function applyHotReorderStackSeal(anchor) {
  applySegmentPlaybackAnchor(anchor);
  ensureListOrderPreviewTimelineSynced();
  getPreviewMediaBridge().sealHotReorderStack(anchor.clipPos);
  syncListPlaybackHighlightFromAnchor(anchor);
}

/**
 * 재생 중 hot reorder — media 시점 word index 유지 (render 전/후 공용).
 * cueJustChanged clamp·lastPlayback -1 리셋 없이 exact word 매칭.
 *
 * @param {{ clipPos: number, mediaSec: number, programSec?: number }} anchor
 * @param {{ updateDom?: boolean }} [opts]
 * @returns {{ ai: number, wi: number, lookupT: number, lookupAxis: string }}
 */
function resolveHotReorderPlaybackHighlight(anchor, opts = {}) {
  const empty = { ai: -1, wi: -1, lookupT: 0, lookupAxis: "listMediaVirtual" };
  if (!anchor || anchor.clipPos < 0) return empty;
  const clips = getProgramSegmentTimelineClips();
  if (!clips?.length) return empty;
  const ai = cueIndexForClipIndex(clips, lastCues, anchor.clipPos);
  if (ai < 0) return empty;
  const cue = lastCues[ai];
  const mediaSec = Number(anchor.mediaSec);
  const listOrder = useListIndexPlayback();
  const highlightComputed = computeHighlightLookupT(cue, {
    playheadSec: Number(anchor.programSec ?? playheadSec) || 0,
    mediaSec,
    listOrder,
    blockVirtualHighlight: false,
    programPlayback: isBlocksProgramSegmentPreview(),
    segmentPreview: isBlocksProgramSegmentPreview(),
    programClips: getProgramSegmentProgramClips(),
  });
  const { lookupT, lookupAxis, activeProgramClip } = highlightComputed;
  const wi = resolveActiveWordIndexForCue(cue, ai, {
    lookupT,
    lookupAxis,
    activeProgramClip,
    listOrder,
    cueJustChanged: false,
    mediaSec,
    noHighlight: highlightComputed.noHighlight === true,
  });
  lastPlaybackCueIndex = ai;
  lastPlaybackWordIndex = wi;
  if (opts.updateDom && wi >= 0) {
    syncPlaybackWordHighlights(ai, wi, { lookupT, lookupAxis });
  }
  return { ai, wi, lookupT, lookupAxis };
}

/** @param {string} tag @param {Record<string, unknown>} payload */
function logHotReorderPlayback(tag, payload) {
  const driftMs = Number(payload.driftMs);
  caretPlayDiagLog(`hotReorder:${tag}`, caretPlayDiagSnapshot(payload));
  if (typeof console.debug === "function") {
    console.debug(`[hot-reorder] ${tag}`, payload);
  }
  if (Number.isFinite(driftMs) && driftMs > 40) {
    console.warn(`[hot-reorder] ${tag} drift`, payload);
  }
}

function resolveSegmentPlaybackAnchorWithSkips(programSec, timelineClips) {
  return resolveSegmentPlaybackAnchorWithSkipsOnClips(
    programSec,
    timelineClips,
    getActiveSegmentClipPosHint(),
  );
}

function getActiveSegmentClipPosHint() {
  if (listPlaybackClipPos >= 0) return listPlaybackClipPos;
  if (isListOrderSeamlessPlaybackActive()) {
    const cp = getListOrderPreviewClipPos();
    if (cp >= 0) return cp;
  }
  return -1;
}

function applySegmentPlaybackAnchor(anchor) {
  playheadSec = anchor.programSec;
  listPlaybackClipPos = anchor.clipPos;
  resetListOrderPreviewClipPos(anchor.clipPos);
}

function snapPlayheadToCueClipStart(cueIndex) {
  if (cueIndex < 0 || !lastCues[cueIndex]) return;
  setListPlaybackListPosFromCueIndex(cueIndex);
  const clips = getProgramSegmentTimelineClips();
  if (!clips?.length) {
    const cue = lastCues[cueIndex];
    if (Number.isFinite(cue.start)) playheadSec = cue.start;
    return;
  }
  const listPos = listPosForCueIndex(lastCues, cueIndex);
  const clipPos = clipIndexForListPos(clips, lastCues, listPos);
  const clip = clips[clipPos];
  if (clip) {
    playheadSec = clip.editStart;
    listPlaybackClipPos = clipPos;
    resetListOrderPreviewClipPos(clipPos);
  }
}

async function rearmActiveSegmentPlayback(anchor) {
  if (!isBlocksProgramSegmentPreview()) return;
  const bridge = getPreviewMediaBridge();
  if (bridge.isTransitionLocked()) {
    bridge.abortActiveTransition();
    await bridge.waitTransitionIdle();
  }
  ensureListOrderPreviewTimelineSynced();
  const skip = getPlaybackSkipRanges();
  getPa()?.pause();
  getPv()?.pause();
  await armListOrderSeamlessPlayback({
    startMediaSec: anchor.mediaSec,
    skipRanges: skip,
    clipPos: anchor.clipPos,
    useEnvelope: true,
    programClips: getProgramSegmentProgramClips(),
    playing: isVideoPlaying,
  });
  if (!isVideoPlaying) return;
  try {
    await getPa()?.play();
  } catch {
    /* ignore */
  }
  if (getPv()?.paused) {
    void getPv().play().catch(() => undefined);
  }
}

function ensureListOrderPreviewTimelineSynced() {
  if (!isBlocksProgramSegmentPreview()) return false;
  const clips = getProgramSegmentTimelineClips();
  if (!clips?.length) return false;
  const bundle = getProgramSegmentTimelineBundle();
  const clipPos = Math.max(
    0,
    listPlaybackClipPos >= 0
      ? listPlaybackClipPos
      : getListOrderPreviewClipPos(),
  );
  setListOrderPreviewTimeline(
    {
      clips,
      mapping: bundle?.mapping ?? null,
      programClips: bundle?.programClips ?? getProgramSegmentProgramClips(),
    },
    clipPos,
  );
  return true;
}

/**
 * PC-LITERAL WP2 — blocks 변경 후 preview stack을 programClips 큐에 literal 재장착.
 *
 * @param {{ reason?: string, bundle?: import("./shared/program-segment-timeline.js").ProgramSegmentTimelineBundle }} [opts]
 */
async function applyProgramClipsLiteralPlaybackSync(opts = {}) {
  if (!isBlocksProgramSegmentPreview()) return;

  const bridge = getPreviewMediaBridge();
  bridge.abortActiveTransition();
  await bridge.waitTransitionIdle();
  getPa()?.pause();
  getPv()?.pause();

  let bundle = opts.bundle;
  if (!bundle?.timelineClips?.length) {
    bundle = refreshProgramSegmentTimelineFromHub({
      reason: opts.reason || "literal-playback-sync",
      rearmSeamlessPlayback: false,
      anchorPlayhead: false,
      skipPostRefreshAnchor: true,
    });
  }
  if (!bundle?.timelineClips?.length) return;

  ensureListOrderPreviewTimelineSynced();
  const clipPosHint =
    listPlaybackClipPos >= 0
      ? listPlaybackClipPos
      : getListOrderPreviewClipPos();
  const anchor = resolveSegmentPlaybackAnchorWithSkips(
    playheadSec,
    bundle.timelineClips,
    clipPosHint >= 0 ? clipPosHint : -1,
  );
  applySegmentPlaybackAnchor(anchor);

  await rearmActiveSegmentPlayback(anchor);
  applyHotReorderStackSeal(anchor);
  resolveHotReorderPlaybackHighlight(anchor, { updateDom: false });

  if (isVideoPlaying) {
    if (!playbackRafId) playbackTick();
  } else {
    scheduleSyncPausedPreviewMediaToPlayhead();
  }
}

/** 삭제 후 playhead·media·clipPos를 갱신된 programClips에 맞춤 (WP2 unified rearm) */
function applyDeletePlaybackSync() {
  const bundle = getProgramSegmentTimelineBundle();
  void applyProgramClipsLiteralPlaybackSync({
    reason: "line-delete",
    bundle: bundle?.timelineClips?.length ? bundle : undefined,
  });
}

/** 줄 재정렬 후 playhead·media·clipPos를 갱신된 programClips에 맞춤 (Hot Reorder v8 — unified rearm) */
async function applyReorderPlaybackSync(newCueIndex, hotSnap) {
  if (!isBlocksProgramSegmentPreview()) return;

  hotReorderInFlight = true;
  try {
    const mediaStillPlaying = isPreviewMediaPlaying();
    const isPlayingReorder = Boolean(
      hotSnap?.isVideoPlaying ||
      (hotSnap?.wasPlayingAtDragStart && mediaStillPlaying),
    );

    if (isPlayingReorder && !isVideoPlaying && isPreviewMediaPlaying()) {
      isVideoPlaying = true;
      setPreviewPlaybackUiActive(true);
    }

    const bridge = getPreviewMediaBridge();
    bridge.abortActiveTransition();
    await bridge.waitTransitionIdle();
    getPa()?.pause();
    getPv()?.pause();

    const bundle = refreshProgramSegmentTimelineFromHub({
      reason: "line-reorder",
      rearmSeamlessPlayback: false,
      anchorPlayhead: false,
      skipPostRefreshAnchor: true,
    });
    if (!bundle?.timelineClips?.length) return;

    if (newCueIndex >= 0 && !isPlayingReorder) {
      snapPlayheadToCueClipStart(newCueIndex);
      setListPlaybackListPosFromCueIndex(newCueIndex);
    }
    ensureListOrderPreviewTimelineSynced();

    const programClips = bundle.programClips ?? getProgramSegmentProgramClips();
    const anchor = buildExplicitHotReorderAnchor(
      hotSnap,
      bundle.timelineClips,
      programClips,
    );
    if (!anchor) {
      performHotReorderLookupFailureFallback(hotSnap);
      logHotReorderPlayback(isPlayingReorder ? "playingLookupFailed" : "pausedLookupFailed", {
        mediaNow: hotSnap.mediaNow,
        blockId: hotSnap.blockId,
      });
      return;
    }

    await rearmActiveSegmentPlayback(anchor);
    applyHotReorderStackSeal(anchor);

    const stackOk = verifyHotReorderStackOnce(
      hotSnap,
      anchor,
      bundle.timelineClips,
      programClips,
    );
    if (!stackOk) {
      logHotReorderPlayback(isPlayingReorder ? "playingRollback" : "pausedRollback", {
        mediaNow: hotSnap.mediaNow,
        blockId: hotSnap.blockId,
        clipPos: anchor.clipPos,
      });
      return;
    }

    resolveHotReorderPlaybackHighlight(anchor, { updateDom: false });

    if (isPlayingReorder) {
      const mediaAfter = readPreviewMediaClockSec();
      const driftMs = Number.isFinite(mediaAfter)
        ? Math.abs(mediaAfter - anchor.mediaSec) * 1000
        : null;
      logHotReorderPlayback("playing", {
        mediaNow: hotSnap.mediaNow,
        wasPlayingAtDragStart: hotSnap.wasPlayingAtDragStart,
        blockId: hotSnap.blockId,
        anchor,
        driftMs,
        clipPos: anchor.clipPos,
        cueIndex: lastPlaybackCueIndex,
      });
      if (isVideoPlaying && getPa()?.paused) {
        try {
          await getPa()?.play();
        } catch {
          /* ignore */
        }
        if (getPv()?.paused) {
          void getPv().play().catch(() => undefined);
        }
      }
    } else {
      logHotReorderPlayback("paused", {
        newCueIndex,
        playheadSec,
        clipPos: anchor.clipPos,
        mediaStart: bundle.timelineClips[anchor.clipPos]?.mediaStart,
        blockId: hotSnap.blockId,
        anchor,
      });
    }

    if (isVideoPlaying && !playbackRafId) {
      playbackTick();
    }
  } finally {
    hotReorderInFlight = false;
    hotReorderDragWasPlaying = false;
    hubBlocksChangedOpts = null;
  }
}

/**
 * list-order 미활성 시 segment clip 경계 밖 재생 → 점프 (삭제 구간 연속 재생 방지).
 * @param {{ skipRanges: { start: number, end: number }[] }} skipOpts
 */
function syncSegmentPreviewClipBoundaryTick(skipOpts) {
  if (
    !isBlocksProgramSegmentPreview() ||
    isListOrderSeamlessPlaybackActive() ||
    !isVideoPlaying
  ) {
    return;
  }
  const clips = getProgramSegmentTimelineClips();
  const audio = getPa();
  if (!clips?.length || !audio || audio.paused || audio.seeking) return;

  const media = readPreviewMediaClockSec();
  if (!Number.isFinite(media)) return;

  let clipPos =
    listPlaybackClipPos >= 0
      ? listPlaybackClipPos
      : resolveSegmentPlaybackAnchorWithSkips(
          resolveProgramSecFromMedia(media, clips),
          clips,
        ).clipPos;
  const cur = clips[clipPos];
  if (!cur) return;

  const inClip = media >= cur.mediaStart - 0.02 && media < cur.mediaEnd - 0.025;
  if (inClip) {
    listPlaybackClipPos = clipPos;
    resetListOrderPreviewClipPos(clipPos);
    return;
  }

  const anchor = resolveSegmentPlaybackAnchorWithSkips(
    resolveProgramSecFromMedia(media, clips),
    clips,
  );
  const target = skipCutRangeAt(anchor.mediaSec, skipOpts.skipRanges || []);
  if (Math.abs(target - media) <= 0.03) return;

  assignMasterAudioTimelineSecIfNeeded(audio, target);
  if (getPv() && Math.abs(getPv().currentTime - target) > 0.04) {
    getPv().currentTime = target;
  }
  listPlaybackClipPos = anchor.clipPos;
  resetListOrderPreviewClipPos(anchor.clipPos);
  playheadSec = anchor.programSec;
}

/**
 * @param {{
 *   preserveProgramSec?: boolean,
 *   rearmSeamlessPlayback?: boolean,
 *   anchorPlayhead?: boolean,
 *   skipOverlayRefresh?: boolean,
 *   skipPostRefreshAnchor?: boolean,
 *   clipPosHint?: number,
 *   reason?: string,
 * }} [opts]
 */
function refreshProgramSegmentTimelineFromHub(opts = {}) {
  const blocks = subtitleHub.blocks;
  if (!blocks?.length) {
    clearProgramSegmentTimeline();
    lastPlaybackSegmentFingerprint = "";
    return null;
  }

  const wasPlayingListOrder =
    isVideoPlaying && isBlocksProgramSegmentPreview();
  const oldClips = getProgramSegmentTimelineClips();
  let anchorProgramSec = playheadSec;
  if (wasPlayingListOrder && oldClips?.length) {
    const mediaNow = readPreviewMediaClockSec();
    if (Number.isFinite(mediaNow)) {
      anchorProgramSec = resolveProgramSecFromMedia(
        mediaNow,
        oldClips,
        getActiveSegmentClipPosHint(),
      );
    }
  }

  const shouldRearm =
    opts.rearmSeamlessPlayback ??
    (isVideoPlaying && isBlocksProgramSegmentPreview());

  const bundle = refreshProgramSegmentTimeline(
    {
      blocks,
      cutRanges: lastCutRanges || [],
      previewMediaPath: getSessionPreviewMediaPath(),
      mediaDurationSec: getMediaDurationSecHint(),
      hardDeletedMediaSkips: subtitleHub.hardDeletedMediaSkips,
    },
    {
      preserveProgramSec: opts.preserveProgramSec !== false,
      programSec: playheadSec,
      rearmSeamlessPlayback: false,
      clipPos:
        Number(opts.clipPosHint) >= 0
          ? Number(opts.clipPosHint)
          : listPlaybackClipPos >= 0
            ? listPlaybackClipPos
            : getListOrderPreviewClipPos(),
      skipOverlayRefresh: opts.skipOverlayRefresh,
      reason: opts.reason || "hub",
    },
  );
  if (!bundle) {
    lastPlaybackSegmentFingerprint = "";
    return null;
  }

  if (isBlocksProgramSegmentPreview()) {
    if (!opts.skipPostRefreshAnchor) {
      const anchor = resolveSegmentPlaybackAnchorWithSkips(
        anchorProgramSec,
        bundle.timelineClips,
      );
      if (shouldRearm) {
        applySegmentPlaybackAnchor(anchor);
        void rearmActiveSegmentPlayback(anchor);
      } else if (opts.anchorPlayhead) {
        applySegmentPlaybackAnchor(anchor);
        if (!isVideoPlaying) scheduleSyncPausedPreviewMediaToPlayhead();
      }
    }
  }

  lastPlaybackSegmentFingerprint = bundle.fingerprint;
  return bundle;
}

/**
 * Phase 3 — blocks/cut/skips 변경 시 segment timeline 단일 갱신 hook.
 *
 * @param {import("./shared/program-segment-timeline.js").RefreshProgramSegmentTimelineOpts & { anchorPlayhead?: boolean }} [opts]
 */
function onProgramBlocksChanged(opts = {}) {
  if (hqPreviewMode && opts.reason !== "hq-preview-enter") {
    void exitHqPreviewMode({ silent: true });
  }
  if (opts.skipRefresh) {
    return;
  }
  const wasPlaying = isVideoPlaying && isBlocksProgramSegmentPreview();
  const listOrderLive =
    isBlocksProgramSegmentPreview() &&
    (isListOrderSeamlessPlaybackActive() || isListOrderPreviewTimelineActive());
  const bundle = refreshProgramSegmentTimelineFromHub({
    preserveProgramSec: opts.preserveProgramSec !== false,
    rearmSeamlessPlayback: opts.rearmSeamlessPlayback ?? wasPlaying,
    anchorPlayhead: opts.anchorPlayhead,
    skipOverlayRefresh: opts.skipOverlayRefresh,
    skipPostRefreshAnchor: listOrderLive && !wasPlaying ? true : undefined,
    reason: opts.reason || "blocks-changed",
  });
  if (
    listOrderLive &&
    !wasPlaying &&
    opts.reason !== "line-delete" &&
    opts.reason !== "line-reorder" &&
    bundle?.timelineClips?.length
  ) {
    void applyProgramClipsLiteralPlaybackSync({
      reason: opts.reason || "blocks-changed",
      bundle,
    });
  }
}

function syncHubFromState() {
  lastCues = subtitleHub.cues;
  bumpListableCueIndicesCache();
  lastCutRanges = subtitleHub.cutRanges;
  persistCues();
  persistCuts();
  updateUndoRedoButtons();
  updateActionButtons();
  onProgramBlocksChanged(hubBlocksChangedOpts || { reason: "hub-state-change" });
  hubBlocksChangedOpts = null;
  if (subtitleList) refreshExpandedPanelSkipRanges(subtitleList);
}

async function applyRestoredPlaybackSnapshot() {
  const bridge = getPreviewMediaBridge();
  if (bridge.isTransitionLocked()) {
    bridge.abortActiveTransition();
    await bridge.waitTransitionIdle();
  }
  const snap = subtitleHub.consumeRestoredPlaybackSnapshot?.();
  if (!snap) return;
  playheadSec = Number(snap.programSec) || 0;
  if (Number.isInteger(snap.listPlaybackClipPos) && snap.listPlaybackClipPos >= 0) {
    listPlaybackClipPos = snap.listPlaybackClipPos;
    resetListOrderPreviewClipPos(snap.listPlaybackClipPos);
  }
  if (isBlocksProgramSegmentPreview()) {
    const anchor = resolveSegmentPlaybackAnchorWithSkips(
      playheadSec,
      getProgramSegmentTimelineClips(),
    );
    applySegmentPlaybackAnchor(anchor);
    if (!isVideoPlaying) scheduleSyncPausedPreviewMediaToPlayhead();
  } else if (isHqPreviewMode() && getPv()) {
    getPv().currentTime = playheadSec;
    if (getPa() && !getPa().paused) assignMasterAudioTimelineSecIfNeeded(getPa(), playheadSec);
  }
  commitPlayheadUi();
}

function handleHubHistoryRestore() {
  void applyRestoredPlaybackSnapshot().then(() => {
    renderCuesTable(lastCues);
  });
}

function usesProgramMasterPreview() {
  return false;
}

function getActiveProgramClips() {
  const cached = getProgramSegmentProgramClips();
  if (cached.length) return cached;
  const blocks = subtitleHub.blocks;
  if (!blocks?.length) return [];
  return buildProgramClips(blocks, lastCutRanges || []);
}

/** blocks SSOT — CFR + programClips */
function isPreviewPlaybackReady() {
  const hasMediaElement = Boolean(
    getPv()?.src || previewMediaResolvedUrl || masterMediaUrl,
  );
  if (!subtitleHub.blocks?.length) {
    return hasMediaElement;
  }
  return Boolean(
    getSessionPreviewMediaPath() &&
      getProgramSegmentTimelineClips().length > 0 &&
      hasMediaElement,
  );
}

/**
 * @param {number} [timeoutMs]
 */
function waitForPreviewMediaReady(timeoutMs = 20000) {
  return new Promise((resolve) => {
    const done = (ok) => resolve(ok);
    const el = getPv();
    if (el?.src && el.readyState >= HTMLMediaElement.HAVE_METADATA) {
      done(true);
      return;
    }
    if (previewMediaResolvedUrl || masterMediaUrl) {
      const t0 = performance.now();
      const poll = () => {
        const v = getPv();
        if (v?.src && v.readyState >= HTMLMediaElement.HAVE_METADATA) {
          done(true);
          return;
        }
        if (performance.now() - t0 >= timeoutMs) {
          done(Boolean(v?.src || previewMediaResolvedUrl || masterMediaUrl));
          return;
        }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
      return;
    }
    done(false);
  });
}

/**
 * ingest 후 CFR + programClips gate — 실패 시 1회 복구 시도.
 */
async function ensurePreviewPlaybackReadyAfterIngest(transcribeMeta = {}) {
  if (isPreviewPlaybackReady()) return true;

  let previewPath =
    transcribeMeta.preview_media_path ||
    getSessionPreviewMediaPath() ||
    transcribeMeta.media_timing?.preview_media_path ||
    "";
  if (!previewPath) {
    previewPath = (await ensureSessionPreviewMediaPath()) || "";
  }
  if (previewPath) setSessionPreviewMediaPath(previewPath);

  if (subtitleHub.blocks?.length && !getProgramSegmentTimelineClips().length) {
    refreshProgramSegmentTimelineFromHub({
      reason: "ingest-recover-clips",
      preserveProgramSec: true,
    });
  }

  if (previewPath && !getPv()?.src) {
    await updatePreview(previewPath);
    await waitForPreviewMediaReady();
    rebuildPlaybackSync();
  }

  if (isPreviewPlaybackReady()) return true;

  console.warn("[preview-ready] ingest gate failed", {
    previewPath: getSessionPreviewMediaPath(),
    clipCount: getProgramSegmentTimelineClips().length,
    blockCount: subtitleHub.blocks?.length ?? 0,
    videoSrc: getPv()?.src ?? null,
    resolvedUrl: previewMediaResolvedUrl || null,
  });
  return false;
}

/** @deprecated — use isPreviewPlaybackReady */
function requiresProgramMasterForPreview() {
  return Boolean(subtitleHub.blocks?.length);
}

/** @deprecated — use isPreviewPlaybackReady */
function isProgramMasterReady() {
  return isPreviewPlaybackReady();
}

function previewPlaybackGateMessage() {
  return (
    "미리보기를 재생할 수 없습니다.\n\n" +
    "CFR 미디어(media-cfr)와 편집 타임라인(programClips)을 확인해 주세요."
  );
}

/** @returns {boolean} */
function assertPreviewPlaybackReady() {
  if (isPreviewPlaybackReady()) return true;
  alert(previewPlaybackGateMessage());
  return false;
}

/** @returns {boolean} */
function assertProgramMasterForPlayback() {
  return assertPreviewPlaybackReady();
}

/** @param {string} [masterPath] */
function applyProgramPlaybackSession(masterPath) {
  const p = String(masterPath || programMasterPreviewPath || "").trim();
  if (!p) {
    setProgramPlaybackActive(false);
    return;
  }
  programMasterPreviewPath = p;
  setProgramPlaybackActive(true);
}

function clearProgramPlaybackSession() {
  setProgramPlaybackActive(false);
}

/**
 * @deprecated transcribe는 Program master를 더 이상 반환하지 않음 — 항상 false.
 * @param {{ program_master_path?: string | null, program_duration_sec?: number | null, program_master_probe_ok?: boolean | null }} transcribeMeta
 * @param {readonly import("./shared/program-clips-ssot.js").ProgramClip[]} clips
 */
function canReuseTranscribeProgramMaster(transcribeMeta, clips) {
  const backendPath = String(transcribeMeta?.program_master_path || "").trim();
  if (!backendPath) return false;
  if (transcribeMeta.program_master_probe_ok === false) return false;
  const blockDur = getProgramDurationSec(clips);
  const backendDur = Number(transcribeMeta.program_duration_sec) || 0;
  if (!(blockDur > PROGRAM_CLIP_EPS) || !(backendDur > PROGRAM_CLIP_EPS)) return false;
  return Math.abs(blockDur - backendDur) <= Math.max(0.15, blockDur * 0.002);
}

function isTranscribeLoadingUiActive() {
  return Boolean(transcribeLoading?.classList.contains("is-active"));
}

/**
 * @param {{ showLoading?: boolean, force?: boolean }} [opts]
 */
async function refreshProgramMasterPreviewIfNeeded(opts = {}) {
  const blocks = subtitleHub.blocks;
  if (!blocks?.length) {
    programMasterPreviewPath = "";
    return null;
  }
  const previewPath = await ensureSessionPreviewMediaPath();
  if (!previewPath) return null;
  const clips = buildProgramClips(blocks, lastCutRanges || []);
  const programDurationSec = getProgramDurationSec(clips);
  const useTranscribeShell = Boolean(opts.showLoading && isTranscribeLoadingUiActive());
  if (opts.showLoading) {
    if (useTranscribeShell) {
      setTranscribeLoading(true, {
        title: TRANSCRIBE_LOADING_TITLE,
        step: "보내기",
        message: "Program master 생성 중…",
        progress: 97,
      });
    } else {
      hidePreviewMediaLoadingModal();
      setPreviewMediaLoading(true, {
        title: "Program master",
        step: "Export bake",
        message: "보내기용 program-master 생성 중…",
      });
    }
  }
  updatePreviewTransportAvailability();
  try {
    const result = await bakeProgramMaster(TOOL_PREFIX, {
      previewMediaPath: previewPath,
      programClips: clips,
      programDurationSec,
      cutRangesJson: JSON.stringify(lastCutRanges || []),
      force: !!opts.force,
    });
    const nextPath = String(result?.path || "").trim();
    if (!nextPath) return null;
    programMasterPreviewPath = nextPath;
    logMediaTimingAvSnapshot("program-master cache", getSessionMediaTiming(), {
      path: nextPath,
      export_only: true,
    });
    return result;
  } finally {
    updatePreviewTransportAvailability();
    if (opts.showLoading && !useTranscribeShell) setPreviewMediaLoading(false);
  }
}

/**
 * Phase 1-R — ingest: CFR preview + segment timeline (Program master는 export/HQ 시 bake).
 *
 * @param {{ preview_media_path?: string | null, program_master_path?: string | null }} [transcribeMeta]
 */
async function ensureProgramMasterAfterIngest(transcribeMeta = {}) {
  if (!subtitleHub.blocks?.length) return null;
  let cfrPath =
    transcribeMeta.preview_media_path ||
    getSessionPreviewMediaPath() ||
    transcribeMeta.media_timing?.preview_media_path ||
    "";
  if (!cfrPath) {
    cfrPath = (await ensureSessionPreviewMediaPath()) || "";
  }
  if (!cfrPath) {
    throw new Error("CFR 미디어 경로가 없습니다. 자막 추출을 다시 실행해 주세요.");
  }
  setSessionPreviewMediaPath(cfrPath);
  clearProgramPlaybackSession();
  clearProgramMasterCache();
  programMasterPreviewPath = "";
  await refreshSessionMediaTimingFromAgent(cfrPath);
  await updatePreview(cfrPath, { useTranscribeShell: isTranscribeLoadingUiActive() });
  await waitForPreviewMediaReady();
  refreshProgramSegmentTimelineFromHub({ reason: "ingest", preserveProgramSec: true });
  rebuildPlaybackSync();
  logMediaTimingAvSnapshot("preview playback", getSessionMediaTiming(), {
    path: cfrPath,
    timeline_axis: "program-segment",
    deferred_master_bake: true,
  });
  return { path: cfrPath };
}

async function ensureProgramMasterForExport() {
  const blocks = subtitleHub.blocks;
  if (!blocks?.length) return null;
  return refreshProgramMasterPreviewIfNeeded({ showLoading: false, force: true });
}

function formatBakeLevelLabel(level) {
  const key = String(level || "").trim();
  if (!key) return "";
  const labels = {
    l0_copy: "L0 copy",
    l1_copy: "L1 copy",
    l1_reencode: "L1 reencode",
    filter: "L4 filter",
  };
  return labels[key] || key;
}

function updateHqPreviewButtonUi() {
  if (!btnHqPreview) return;
  const hasBlocks = Boolean(subtitleHub.blocks?.length);
  btnHqPreview.hidden = !hasBlocks;
  btnHqPreview.disabled = !hasBlocks || !agentConnected;
  btnHqPreview.classList.toggle("is-active", hqPreviewMode);
  btnHqPreview.title = hqPreviewMode
    ? "CFR segment 미리보기로 돌아가기"
    : "Program master HQ 미리보기 (클릭 시 export와 동일 타임라인으로 bake)";
  btnHqPreview.textContent = hqPreviewMode ? "CFR" : "HQ";
}

/**
 * @param {{ silent?: boolean }} [opts]
 */
async function exitHqPreviewMode(opts = {}) {
  if (!hqPreviewMode) return;
  hqPreviewMode = false;
  const savedProgramSec = playheadSec;
  stopPlaybackLoop();
  deactivateListOrderPreviewPlayback();
  const cfrPath = getSessionPreviewMediaPath();
  if (cfrPath) {
    await updatePreview(cfrPath);
    onProgramBlocksChanged({
      reason: "hq-preview-exit",
      preserveProgramSec: true,
      rearmSeamlessPlayback: false,
    });
    playheadSec = savedProgramSec;
    if (isBlocksProgramSegmentPreview()) {
      const anchor = resolveSegmentPlaybackAnchorWithSkips(
        playheadSec,
        getProgramSegmentTimelineClips(),
      );
      applySegmentPlaybackAnchor(anchor);
    }
    if (!isVideoPlaying) scheduleSyncPausedPreviewMediaToPlayhead();
    rebuildPlaybackSync();
  }
  updateHqPreviewButtonUi();
  commitPlayheadUi();
  if (!opts.silent) {
    console.debug("[hq-preview] exited — CFR segment preview restored");
  }
}

async function enterHqPreviewMode() {
  if (!subtitleHub.blocks?.length || !agentConnected) return;
  if (hqPreviewMode) {
    await exitHqPreviewMode();
    return;
  }
  const savedProgramSec = playheadSec;
  stopPlaybackLoop();
  deactivateListOrderPreviewPlayback();
  setPreviewMediaLoading(true, {
    title: "HQ 미리보기",
    step: "Program master",
    message: "export와 동일한 program-master 준비 중…",
  });
  try {
    const previewPath = await ensureSessionPreviewMediaPath();
    if (!previewPath) {
      alert("CFR 미디어가 없습니다. 자막 추출을 먼저 실행해 주세요.");
      return;
    }
    const result = await refreshProgramMasterPreviewIfNeeded({
      showLoading: false,
      force: !getProgramMasterCache().path,
    });
    const path =
      String(result?.path || "").trim() ||
      programMasterPreviewPath ||
      getProgramMasterCache().path ||
      "";
    if (!path) {
      alert(
        "Program master를 만들 수 없습니다.\nCFR 미디어·에이전트 연결·편집 타임라인(programClips)을 확인해 주세요.",
      );
      return;
    }
    programMasterPreviewPath = path;
    hqPreviewMode = true;
    await updatePreview(path);
    playheadSec = savedProgramSec;
    const dur = getPreviewEditDurationSec();
    if (dur > 0) playheadSec = Math.min(playheadSec, dur);
    if (getPv()) getPv().currentTime = playheadSec;
    if (getPa()) assignMasterAudioTimelineSecIfNeeded(getPa(), playheadSec);
    refreshOverlayTimingContext();
    updateHqPreviewButtonUi();
    commitPlayheadUi();
    console.debug("[hq-preview] active", { path, bakeLevel: result?.bakeLevel ?? null });
  } finally {
    setPreviewMediaLoading(false);
  }
}

async function toggleHqPreviewMode() {
  if (hqPreviewMode) await exitHqPreviewMode();
  else await enterHqPreviewMode();
}

function refreshOverlayTimingContext() {
  const blocks = subtitleHub.blocks;
  const virtualIndex = subtitleHub._virtualIndex;
  const useBlocks =
    Array.isArray(blocks) &&
    blocks.length > 0 &&
    Array.isArray(virtualIndex) &&
    virtualIndex.length > 0;
  const cutRanges = lastCutRanges || [];
  const requiresConcat = false;
  const exportTimeAxis = useBlocks ? "program" : "media";
  const scheduleCutRanges = useBlocks ? [] : cutRanges;

  overlayTimingCtx = createOverlayTimingContext({
    cues: lastCues,
    blocks,
    virtualIndex,
    cutRanges: scheduleCutRanges,
    playbackMode: useListIndexPlayback() ? "list-order" : "time",
    exportTimeAxis,
    clips: getProgramSegmentTimelineClips(),
    requiresConcat,
    isMediaPlaying: isPreviewMediaPlaying(),
    listPlaybackClipPos: listPlaybackClipPos,
    resolveListOrderCueIndex: (t) => {
      if (!useListIndexPlayback()) return -1;
      return resolvePlaybackIndices(t).ai;
    },
  });
}

/**
 * @param {import("./shared/program-segment-timeline.js").ProgramSegmentTimelineBundle} bundle
 */
function rebuildPlaybackSyncFromSegmentBundle(bundle) {
  const orch = getPlaybackOrchestrator();
  const dur =
    getMediaDurationSecHint() ??
    bundle.mediaEndHintSec ??
    (getPv()?.duration && Number.isFinite(getPv().duration) ? getPv().duration : 0);
  orch.rebuild(lastCues, getPlaybackSkipRanges(), dur, {
    programMasterMode: false,
    timelineClips: bundle.timelineClips,
    stitchedProgramMode: true,
  });
}

function rebuildPlaybackSync() {
  const bundle = getProgramSegmentTimelineBundle();
  if (bundle) {
    rebuildPlaybackSyncFromSegmentBundle(bundle);
    return;
  }
  const orch = getPlaybackOrchestrator();
  const dur =
    getPv()?.duration && Number.isFinite(getPv().duration)
      ? getPv().duration
      : 0;
  orch.rebuild(lastCues, getPlaybackSkipRanges(), dur, {
    programMasterMode: false,
  });
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
  checkedCueIndices = new Set();
  subtitleLineDragActive = false;
  listPlaybackListPos = -1;
  deactivateListOrderPreviewPlayback();
  clearProgramSegmentTimeline();
  hqPreviewMode = false;
  downloadReturnRestorePending = false;
  downloadReturnRestoreMeta = null;
  invalidateOverlayTimingCache(overlayTimingCtx);
  overlayTimingCtx = null;
  expandedCueIndex = -1;
  expandedWordIndex = -1;
  peaksPayload = null;
  sessionMediaDurationSec = null;
  sessionWhisperDurationSec = null;
  clearSessionMediaTiming();
  try {
    sessionStorage.removeItem(STORAGE_CUES);
    sessionStorage.removeItem(STORAGE_CUTS);
    sessionStorage.removeItem(STORAGE_EXPORT_PATH);
    sessionStorage.removeItem(STORAGE_DL_RESTORE);
    sessionStorage.removeItem(STORAGE_RETURN_FROM_DL);
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
  const vw = getPv()?.videoWidth || 0;
  const vh = getPv()?.videoHeight || 0;
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
  const nativeH = style.videoHeight || getPv()?.videoHeight || 1080;
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
  const vw = getPv()?.videoWidth;
  const vh = getPv()?.videoHeight;
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
  return buildAgentResourceUrl(
    `${TOOL_PREFIX}/media/image?image_path=${encodeURIComponent(p)}`,
  );
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
    watermarkMediaLoadGen += 1;
    releaseWatermarkMediaBlob();
    previewWatermarkOverlay.hidden = true;
    previewWatermarkOverlay.setAttribute("aria-hidden", "true");
    previewWatermarkOverlay.replaceChildren();
    return;
  }
  const hasMedia = Boolean(getPv()?.src || getPa()?.src);
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
  const directUrl = watermarkImageUrl(path);
  if (!directUrl) return;

  const loadGen = ++watermarkMediaLoadGen;
  if (directUrl !== watermarkMediaDirectUrl) {
    releaseWatermarkMediaBlob();
    watermarkMediaDirectUrl = directUrl;
  }

  void resolveAgentMediaObjectUrl(directUrl)
    .then((url) => {
      if (loadGen !== watermarkMediaLoadGen) return;
      watermarkMediaResolvedUrl = url;
      if (img.dataset.src !== directUrl) {
        img.dataset.src = directUrl;
        img.src = url;
      } else if (img.src !== url) {
        img.src = url;
      } else if (img.complete && img.naturalWidth) {
        layoutWatermarkPreviewImage(img, position);
      } else {
        img.dataset.pos = normalizeWatermarkPosition(position);
      }
    })
    .catch((err) => {
      if (loadGen !== watermarkMediaLoadGen) return;
      console.warn("[preview-watermark] image load failed", err);
      previewWatermarkOverlay.hidden = true;
      previewWatermarkOverlay.setAttribute("aria-hidden", "true");
    });
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
  if (phase === "concat_copy") return `${label} · 미디어 합성`;
  if (phase === "concat_reencode") return `${label} · 미디어 재인코딩`;
  if (phase === "awaiting_frames") return `${label} · 프레임 캡처`;
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
  languageSelect?.addEventListener("change", () => {
    syncWordAlignButtonState();
    save();
  });
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
  if (usesProgramMasterPreview() || isProgramPlaybackTimeline()) return [];
  if (isBlocksProgramSegmentPreview()) {
    return buildBlocksPreviewPlaybackSkips(
      subtitleHub.hardDeletedMediaSkips,
      subtitleHub.blocks,
    );
  }
  return subtitleHub.getPlaybackSkipRanges();
}

function getMediaStreamUrl() {
  const mt = getSessionMediaTiming();
  const sourceFromContract =
    isSourceVideoPtsTimeline() && mt?.source_media_path
      ? String(mt.source_media_path).trim()
      : "";
  const p =
    sourceFromContract ||
    getSessionPreviewMediaPath() ||
    videoPathInput?.value?.trim() ||
    sessionVideoPath;
  if (!p || !agentConnected) return null;
  return buildAgentResourceUrl(
    `${TOOL_PREFIX}/media/stream?video_path=${encodeURIComponent(p)}`,
  );
}

/** @param {string} tag @param {object | null | undefined} mt @param {Record<string, unknown>} [extra] */
function logMediaTimingAvSnapshot(tag, mt, extra = {}) {
  if (!mt || typeof mt !== "object") return;
  const videoSec = Number(mt.video_duration_sec);
  const audioSec = Number(mt.audio_duration_sec);
  let avDelta = Number(mt.av_duration_delta_sec);
  if (!Number.isFinite(avDelta) && Number.isFinite(videoSec) && Number.isFinite(audioSec)) {
    avDelta = videoSec - audioSec;
  }
  mediaTimingDiagLog(tag, {
    video_sec: Number.isFinite(videoSec) && videoSec > 0 ? videoSec : null,
    audio_sec: Number.isFinite(audioSec) && audioSec > 0 ? audioSec : null,
    av_delta_sec: Number.isFinite(avDelta) ? avDelta : null,
    vfr: Boolean(mt.vfr_suspected),
    timeline_axis: mt.timeline_axis ?? null,
    skew_sec: mt.av_start_skew_sec ?? null,
    actions: mt.preprocess_actions ?? mt.normalize_actions ?? null,
    ...extra,
  });
}

/** Go SSOT — video-axis whisper audio preprocess (AutoSubtitle 2.0). */
async function prepareMediaForWhisper(videoPath) {
  const p = String(videoPath || "").trim();
  if (!p || !agentConnected) return null;
  await ensureAgentFfmpegReady();
  try {
    const contract = await requestAgent({
      path: `${TOOL_PREFIX}/media/prepare-for-whisper`,
      method: "POST",
      json: { video_path: p },
    });
    if (contract?.ok) {
      setSessionMediaTiming(contract);
      const vdur = Number(contract.video_duration_sec);
      if (Number.isFinite(vdur) && vdur > 0) sessionMediaDurationSec = vdur;
      logMediaTimingAvSnapshot("preprocess complete", contract, {
        whisper_audio_path: contract.whisper_audio_path ?? null,
        word_timeline_sec: contract.word_timeline_duration_sec ?? vdur,
      });
    } else {
      mediaTimingDiagWarn("prepare-for-whisper failed", contract?.error);
    }
    return contract;
  } catch (err) {
    mediaTimingDiagWarn("prepare-for-whisper request failed", err);
    return null;
  }
}

/** FFmpeg/ffprobe — probe 전에만 준비 (Whisper 패키지 설치 안 함). */
let agentFfmpegEnsurePromise = null;
let ffmpegBinariesReadySession = false;
let whisperPrepareReadySession = false;

async function waitForAgentApiReady(timeoutMs = 90000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const health = await requestAgent({ path: "/health", method: "GET" });
      if (health?.fastapi_ready !== false) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

async function ensureAgentFfmpegReady() {
  if (!agentConnected) return false;
  if (ffmpegBinariesReadySession) return true;
  if (!agentFfmpegEnsurePromise) {
    agentFfmpegEnsurePromise = (async () => {
      if (!(await waitForAgentApiReady())) {
        throw new Error("FastAPI sidecar가 아직 준비되지 않았습니다. 에이전트를 재시작한 뒤 다시 시도해 주세요.");
      }
      const readiness = await requestAgent({
        path: "/api/tools/silence-remover/readiness",
        method: "GET",
      });
      const bins = readiness?.binaries;
      if (bins?.ffmpeg && bins?.ffprobe) {
        ffmpegBinariesReadySession = true;
        return true;
      }

      setPreviewMediaLoading(true, {
        title: "FFmpeg 준비",
        step: "첫 설치",
        message:
          "FFmpeg를 다운로드·설치합니다.\n약 80~150MB · 네트워크에 따라 최대 15분 걸릴 수 있습니다.\n창을 닫지 마세요.",
      });
      try {
        await requestAgent({
          path: "/api/tools/silence-remover/prepare",
          method: "POST",
        });
        const after = await requestAgent({
          path: "/api/tools/silence-remover/readiness",
          method: "GET",
        });
        if (!after?.binaries?.ffmpeg || !after?.binaries?.ffprobe) {
          throw new Error("FFmpeg 설치 후에도 준비 상태가 false입니다.");
        }
        ffmpegBinariesReadySession = true;
        return true;
      } finally {
        setPreviewMediaLoading(false);
      }
    })().catch((err) => {
      setPreviewMediaLoading(false);
      mediaTimingDiagWarn("FFmpeg prepare failed", err);
      agentFfmpegEnsurePromise = null;
      alert(
        "FFmpeg 자동 설치에 실패했습니다.\n\n"
          + "에이전트를 최신으로 업데이트한 뒤 다시 시도하거나, "
          + "네트워크(VPN/방화벽)를 확인해 주세요.\n\n"
          + String(err?.message || err),
      );
      return false;
    });
  }
  return agentFfmpegEnsurePromise;
}

/** CFR preview media — prepare-preview API (VFR→CFR·A/V remux, 캐시 재사용). */
async function ensureSessionPreviewMediaPath(opts = {}) {
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  let preview = getSessionPreviewMediaPath();
  if (preview) return preview;

  const videoPath = videoPathInput?.value?.trim() || sessionVideoPath || "";
  if (!videoPath) return null;

  if (!agentConnected) {
    setSessionPreviewMediaPath(videoPath);
    return videoPath;
  }

  await ensureAgentFfmpegReady();
  onProgress?.({
    step: "CFR 미디어 준비",
    message: "A/V 정규화·CFR 변환… (캐시 있으면 즉시 완료)",
    progress: 5,
  });

    try {
      const data = await requestAgent({
        path: `${TOOL_PREFIX}/media/prepare-preview`,
        method: "POST",
        json: { video_path: videoPath },
      });
      if (data?.ok && data.preview_media_path) {
        setSessionPreviewMediaPath(data.preview_media_path);
        if (data.media_timing) {
          setSessionMediaTiming(data.media_timing);
          const audioDur = getAudioTimelineDurationSec();
          if (audioDur) sessionMediaDurationSec = audioDur;
        }
        logMediaTimingAvSnapshot("prepare-preview", data.media_timing || data, {
          normalized: data.normalized,
          actions: data.actions,
        });
        return String(data.preview_media_path).trim();
      }
      mediaTimingDiagWarn("prepare-preview failed", data?.error || data);
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err || "");
      if (/404|not found/i.test(msg)) {
        mediaTimingDiagWarn(
          "prepare-preview 404 — go-agent 재빌드·재시작 또는 ITMATZIP_AGENT_DIR 확인",
          msg,
        );
      } else {
        mediaTimingDiagWarn("prepare-preview request failed", err);
      }
    }

  const probe = await refreshSessionMediaTimingFromAgent(videoPath);
  preview = getSessionPreviewMediaPath();
  if (preview) return preview;
  if (probe?.ok && !probe.needs_vfr_normalize && !probe.vfr_suspected) {
    preview = String(probe.source_path || videoPath).trim() || videoPath;
    setSessionPreviewMediaPath(preview);
    return preview;
  }
  return null;
}

/** @param {string} filePath */
async function refreshSessionMediaTimingFromAgent(filePath) {
  const p = String(filePath || "").trim();
  if (!p || !agentConnected) return null;
  await ensureAgentFfmpegReady();
  try {
    const data = await requestAgent({
      path: `${TOOL_PREFIX}/media/probe`,
      method: "POST",
      json: { video_path: p },
    });
    if (data?.ok) {
      setSessionMediaTiming(data);
      if (
        programMasterPreviewPath &&
        (p === programMasterPreviewPath || /program-master\.mp4$/i.test(p))
      ) {
        setProgramPlaybackActive(true);
      }
      const audioDur = getAudioTimelineDurationSec();
      if (audioDur) sessionMediaDurationSec = audioDur;
      if (!getSessionPreviewMediaPath()) {
        const fromProbe = String(data.preview_media_path || "").trim();
        if (fromProbe) {
          setSessionPreviewMediaPath(fromProbe);
        } else if (!data.needs_vfr_normalize && !data.vfr_suspected) {
          setSessionPreviewMediaPath(String(data.source_path || p).trim() || p);
        }
      }
      logMediaTimingAvSnapshot("probe", data);
    } else {
      mediaTimingDiagWarn("probe failed", data?.error || data);
    }
    return data;
  } catch (err) {
    mediaTimingDiagWarn("probe request failed", err);
    return null;
  }
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
      if (ta.dataset.lineTextUserEdited === "1" || lineTextIsUserLocked(cue)) {
        return normalizePreviewSubtitleText(ta.value);
      }
      const live = normalizePreviewSubtitleText(ta.value);
      if (live) return live;
    }
  }
  if (lineTextIsUserLocked(cue)) {
    return normalizePreviewSubtitleText(String(cue.text ?? ""));
  }
  ensureCueWords(cue);
  return normalizePreviewSubtitleText(subtitleLineEditDisplayText(cue));
}

/**
 * 재생 시각 기준 오버레이 문구 — Overlay Timing SSOT.
 *
 * @param {number} editSec
 */
function resolveOverlayDisplayTextAt(editSec) {
  if (!overlayTimingCtx) refreshOverlayTimingContext();
  if (!overlayTimingCtx) return "";

  overlayTimingCtx.isMediaPlaying = isPreviewMediaPlaying();
  overlayTimingCtx.listPlaybackClipPos = listPlaybackClipPos;
  overlayTimingCtx.playbackMode = useListIndexPlayback() ? "list-order" : "time";

  const hit = resolveCueAtTime(overlayTimingCtx, editSec);
  return hit?.text ?? "";
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

/** @param {number} editSec — word/cue source(media) 시각 */
function seekEditSecAndPlay(sourceSec) {
  if (!getPv() || !getPa() || !Number.isFinite(sourceSec)) return false;
  const cueIndex = selectedCueIndex >= 0 ? selectedCueIndex : -1;
  if (cueIndex >= 0) setListPlaybackListPosFromCueIndex(cueIndex);

  const skip = getPlaybackSkipRanges();
  let media;
  if (isBlocksProgramSegmentPreview()) {
    playheadSec =
      cueIndex >= 0
        ? mapSourceSecToPlayheadSecForCue(cueIndex, sourceSec)
        : mapSourceSecToPlayheadSec(sourceSec);
    const clips = getProgramSegmentTimelineClips();
    if (clips?.length) {
      const anchor = resolveSegmentPlaybackAnchorWithSkips(playheadSec, clips);
      applySegmentPlaybackAnchor(anchor);
      media = skipCutRangeAt(anchor.mediaSec, skip);
    } else {
      media = skipCutRangeAt(Math.max(0, sourceSec), skip);
    }
  } else {
    const orch = getPlaybackOrchestrator();
    media = skipCutRangeAt(orch.mapEditToMediaSec(sourceSec), skip);
    orch.seekMediaSec(media);
    playheadSec = orch.mapMediaToEditSec(media);
  }

  if (isBlocksProgramSegmentPreview()) {
    if (getPa()?.src) assignMasterAudioTimelineSecIfNeeded(getPa(), media);
    const videoMedia = mapWordTimelineToVideoTime(media);
    if (getPv()) {
      if (Number.isFinite(getPv().duration) && getPv().duration > 0) {
        const vSeek = Math.min(videoMedia, Math.max(0, getPv().duration - 0.001));
        if (Math.abs(getPv().currentTime - vSeek) > 0.002) getPv().currentTime = vSeek;
      } else if (Math.abs(getPv().currentTime - videoMedia) > 0.002) {
        getPv().currentTime = videoMedia;
      }
    }
    getPlaybackOrchestrator().seekMediaSec(media);
  }

  caretPlayDiagLog("seekEditSecAndPlay", caretPlayDiagSnapshot({
    editSec: sourceSec,
    mediaSec: media,
    cueIndex,
  }));
  commitPlayheadUi();
  startPlaybackLoop({ preservePlayhead: true });
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
  if (isHqPreviewMode()) {
    const cacheDur = getProgramMasterCache().durationSec;
    if (cacheDur > 0) return cacheDur;
    const segDur = getProgramSegmentDurationSec();
    if (segDur > 0) return segDur;
    const vdur = getPv()?.duration;
    if (Number.isFinite(vdur) && vdur > 0) return vdur;
  }
  if (isBlocksProgramSegmentPreview()) {
    const dur = getProgramSegmentDurationSec();
    if (dur > 0) return dur;
  }
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
  const hasMedia = Boolean(getPv()?.src);
  const canInteract = hasMedia && (isHqPreviewMode() || isPreviewPlaybackReady());
  if (btnPreviewPlay) btnPreviewPlay.disabled = !canInteract;
  if (previewSeek) previewSeek.disabled = !canInteract;
  updateHqPreviewButtonUi();
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
  if (!getPv() || !Number.isFinite(editSec)) return;
  const dur = getPreviewEditDurationSec();
  const clamped = dur > 0 ? Math.max(0, Math.min(dur, editSec)) : Math.max(0, editSec);
  caretPlayDiagLog(
    "seekPreviewToEditSec",
    caretPlayDiagSnapshot({ editSec, clampedEditSec: clamped, resumePlayback: Boolean(opts.resumePlayback) }),
  );
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
  caretPlayDiagLog(
    "scrubberSeek",
    caretPlayDiagSnapshot({ seekPct: pct, durationSec: dur, dragging: previewSeekDragging }),
  );
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
  if (getPv()) {
    getPv().controls = false;
    getPv().removeAttribute("controls");
  }
  updatePreviewTransportUi();
}

/**
 * @param {number} t
 * @returns {{ ai: number, wi: number }}
 */
function useListIndexPlayback() {
  return (
    isVideoPlaying &&
    waveformPlayRangeEndEdit == null &&
    isBlocksProgramSegmentPreview() &&
    getProgramSegmentTimelineClips()?.length > 0 &&
    (isListOrderSeamlessPlaybackActive() || isListOrderPreviewTimelineActive())
  );
}

/** blocks segment preview — playhead·clipPos·listPos를 programClips 큐에 맞춤 */
function ensureListOrderListPosFromPlayhead() {
  if (!isBlocksProgramSegmentPreview()) return;
  const clips = getProgramSegmentTimelineClips();
  if (!clips?.length) return;
  activateListOrderPreviewPlayback();
  const clipPosHint = Math.max(
    listPlaybackClipPos >= 0 ? listPlaybackClipPos : -1,
    getListOrderPreviewClipPos(),
  );
  const anchor = resolveSegmentPlaybackAnchorWithSkips(
    playheadSec,
    clips,
    clipPosHint >= 0 ? clipPosHint : -1,
  );
  listPlaybackClipPos = anchor.clipPos;
  resetListOrderPreviewClipPos(anchor.clipPos);
  syncListPlaybackHighlightFromAnchor(anchor);
}

function activateListOrderPreviewPlayback() {
  ensureListOrderPreviewTimelineSynced();
}

function deactivateListOrderPreviewPlayback() {
  clearListOrderPreviewTimeline();
  listPlaybackClipPos = -1;
  refreshOverlayTimingContext();
}

function setListPlaybackListPosFromCueIndex(cueIndex) {
  const pos = listPosForCueIndex(lastCues, cueIndex);
  listPlaybackListPos = pos >= 0 ? pos : -1;
}

/** 재생·캐럿 진단 스냅샷 */
function caretPlayDiagSnapshot(extra = {}) {
  let mediaClock = null;
  try {
    if (getPv() || getPa()) mediaClock = readPreviewMediaClockSec();
  } catch {
    mediaClock = null;
  }
  return {
    playheadEditSec: Number.isFinite(playheadSec) ? +playheadSec.toFixed(4) : null,
    audioSec: getPa()?.currentTime ?? null,
    videoSec: getPv()?.currentTime ?? null,
    mediaClock,
    isVideoPlaying,
    selectedCueIndex,
    lastPlaybackCueIndex,
    lastPlaybackWordIndex,
    listPlaybackListPos,
    listPlaybackClipPos,
    listOrder: useListIndexPlayback(),
    ...extra,
  };
}

/** 재생 단어칩 하이라이트 진단 — 콘솔 `[PLAY-HL]` 필터 */
let highlightDiagEnabled = false;

function logPlaybackHighlight(event, payload) {
  if (!highlightDiagEnabled) return;
  console.log("[PLAY-HL]", event, payload);
  diagLogBufferPush("PLAY-HL", "log", event, payload);
}

/** 단어 칩 하이라이트 — 재생 중 audible SSOT(readPreviewMediaClockSec)와 동일 축 */
function getPreviewWordClockSec() {
  if (isPreviewMediaPlaying()) {
    const media = readPreviewMediaClockSec();
    if (Number.isFinite(media)) return media;
  }
  const clock = resolveWordTimelineClockSec({
    audio: getPa(),
    video: getPv(),
    fallbackSec: NaN,
    preferAudio: !isSourceVideoPtsTimeline(),
  });
  if (Number.isFinite(clock)) return clock;
  const orch = getPlaybackOrchestrator();
  const fromEdit = orch?.mapping
    ? orch.mapEditToMediaSec(playheadSec)
    : playheadSec;
  return mapVideoTimeToWordTimeline(fromEdit);
}

/** wordVisibleInWordChipRail 기준 첫 storage 인덱스 */
function firstVisibleWordStorageIndex(cue) {
  if (!cue) return -1;
  const words = getCueWords(cue);
  for (let wi = 0; wi < words.length; wi += 1) {
    if (wordVisibleInWordChipRail(words[wi])) return wi;
  }
  return -1;
}

/**
 * 재생 하이라이트 SSOT — playbackTick에서 한 번 계산해 하위로 전달.
 *
 * @param {object | null} cue
 * @param {{ playheadSec: number, mediaSec: number, listOrder: boolean }} ctx
 */
const LIST_HIGHLIGHT_CLIP_EPS_SEC = 0.02;

/**
 * @param {readonly import("./shared/program-clips-ssot.js").ProgramClip[]} [programClips]
 */
function resolveListOrderActiveProgramClip(programClips) {
  const clipPos =
    listPlaybackClipPos >= 0
      ? listPlaybackClipPos
      : getListOrderPreviewClipPos();
  const clips = programClips?.length ? programClips : getProgramSegmentProgramClips();
  const activeProgramClip =
    clipPos >= 0 && clipPos < clips.length ? clips[clipPos] : null;
  return { clipPos, activeProgramClip, programClips: clips };
}

/**
 * @param {number} mediaNow
 * @param {number} clipPos
 * @param {readonly import("./shared/timeline-mapping.js").TimelineClip[]} timelineClips
 */
function resolveListOrderProgramSec(mediaNow, clipPos, timelineClips) {
  if (isProgramPreviewExecutorActive()) {
    return getListOrderPreviewProgramSec();
  }
  const clip =
    clipPos >= 0 && clipPos < timelineClips.length ? timelineClips[clipPos] : null;
  if (clip && Number.isFinite(mediaNow)) {
    return clip.editStart + (mediaNow - clip.mediaStart);
  }
  return resolveProgramSecFromMedia(
    mediaNow,
    timelineClips,
    clipPos >= 0 ? clipPos : -1,
  );
}

function computeHighlightLookupT(cue, ctx) {
  if (ctx.listOrder && cue) {
    const { clipPos, activeProgramClip, programClips } = resolveListOrderActiveProgramClip(
      ctx.programClips,
    );
    const mediaNow = Number(ctx.mediaSec);
    const programSec = resolveListOrderProgramSec(
      mediaNow,
      clipPos,
      getProgramSegmentTimelineClips(),
    );
    if (!activeProgramClip || !Number.isFinite(programSec)) {
      return {
        lookupT: NaN,
        lookupAxis: "program",
        activeProgramClip: null,
        noHighlight: true,
      };
    }
    const inClip =
      programSec >= activeProgramClip.programStart - LIST_HIGHLIGHT_CLIP_EPS_SEC &&
      programSec < activeProgramClip.programEnd + LIST_HIGHLIGHT_CLIP_EPS_SEC;
    return {
      lookupT: programSec,
      lookupAxis: "program",
      activeProgramClip,
      noHighlight: !inClip,
    };
  }
  if (ctx.programPlayback) {
    const clips = ctx.programClips?.length ? ctx.programClips : getActiveProgramClips();
    let programT;
    if (ctx.segmentPreview) {
      programT = resolveProgramSecFromMedia(
        Number(ctx.mediaSec) || 0,
        getProgramSegmentTimelineClips(),
        getActiveSegmentClipPosHint(),
      );
    } else {
      programT = Number.isFinite(Number(ctx.mediaSec))
        ? Number(ctx.mediaSec)
        : Number(ctx.playheadSec) || 0;
    }
    const sourceT = clips.length ? resolveSourceSecFromProgram(programT, clips) : programT;
    return { lookupT: sourceT, lookupAxis: "sourceFromProgram" };
  }
  if (ctx.blockVirtualHighlight) {
    const mediaT = Number(ctx.mediaSec);
    return {
      lookupT: Number.isFinite(mediaT) ? mediaT : Number(ctx.playheadSec) || 0,
      lookupAxis: "mediaClock",
    };
  }
  return { lookupT: Number(ctx.playheadSec) || 0, lookupAxis: "cueClock" };
}

/**
 * @param {object} cue
 * @param {number} cueIndex
 * @param {{
 *   lookupT: number,
 *   lookupAxis: string,
 *   activeProgramClip?: import("./shared/program-clips-ssot.js").ProgramClip | null,
 *   listOrder?: boolean,
 *   cueJustChanged?: boolean,
 *   mediaSec?: number,
 * }} opts
 */
function resolveActiveWordIndexForCue(cue, cueIndex, opts) {
  if (!cue || !opts || opts.noHighlight || !Number.isFinite(opts.lookupT)) return -1;
  const ci =
    typeof cueIndex === "number" && cueIndex >= 0
      ? cueIndex
      : lastCues.indexOf(cue);
  const lookupT = opts.lookupT;
  const lookupAxis = opts.lookupAxis ?? "cueClock";
  const programClip =
    lookupAxis === "program" ? opts.activeProgramClip ?? null : null;
  const hintWi = ci === lastPlaybackCueIndex ? lastPlaybackWordIndex : -1;
  const exactWi = pickActiveWordIndexForHighlight(
    cue,
    lookupT,
    programClip ?? undefined,
  );
  let wi = pickActiveWordIndexWithHintForHighlight(
    cue,
    lookupT,
    hintWi,
    programClip ?? undefined,
  );

  let clampedToFirstVisible = false;
  const firstVisibleWi = firstVisibleWordStorageIndex(cue);
  if (opts.cueJustChanged && wi < 0) {
    if (exactWi >= 0) {
      wi = exactWi;
    } else if (firstVisibleWi >= 0) {
      const words = getCueWords(cue);
      const fv = words[firstVisibleWi];
      let fvStart;
      let fvEnd;
      if (programClip) {
        fvStart = sourceSecToProgramSecInClip(getWordSourceStart(fv, cue), programClip);
        fvEnd = sourceSecToProgramSecInClip(getWordSourceEnd(fv, cue), programClip);
      } else {
        fvStart = fv ? Number(fv.start) : NaN;
        fvEnd = fv ? Number(fv.end) : NaN;
      }
      const lookupInSpan =
        Number.isFinite(fvStart) &&
        Number.isFinite(fvEnd) &&
        lookupT >= fvStart - 0.12 &&
        lookupT <= fvEnd + 0.15;
      if (lookupInSpan) {
        wi = firstVisibleWi;
        clampedToFirstVisible = true;
      }
    }
  }

  if (highlightDiagEnabled) {
    const words = getCueWords(cue);
    const resolved = wi >= 0 ? words[wi] : null;
    const rs = resolved ? Number(resolved.start) : NaN;
    const re = resolved ? Number(resolved.end) : NaN;
    const spanMismatch =
      resolved &&
      Number.isFinite(rs) &&
      Number.isFinite(re) &&
      (lookupT < rs - 0.12 || lookupT > re + 0.15);
    const hintFallback = hintWi >= 0 && wi === hintWi && exactWi < 0;
    if (spanMismatch || hintFallback || wi !== exactWi || clampedToFirstVisible) {
      logPlaybackHighlight("wordResolve", {
        cueIndex: ci,
        mediaSec: Number.isFinite(opts.mediaSec)
          ? +Number(opts.mediaSec).toFixed(4)
          : null,
        lookupT: +lookupT.toFixed(4),
        lookupAxis,
        cueJustChanged: Boolean(opts.cueJustChanged),
        clampedToFirstVisible,
        relocated: isRelocated(cue),
        hintWi,
        lastCue: lastPlaybackCueIndex,
        lastWi: lastPlaybackWordIndex,
        exactWi,
        resolvedWi: wi,
        word: resolved?.word ?? resolved?.text ?? "",
        span: Number.isFinite(rs) ? [rs, re] : null,
        spanMismatch,
        hintFallback,
      });
    }
  }
  return wi;
}

function syncPlaybackWordHighlights(activeCueIndex, activeWordIndex, highlightCtx = {}) {
  if (!subtitleList || activeCueIndex < 0) return;
  const lookupT = Number(highlightCtx.lookupT);
  updatePlaybackHighlights(subtitleList, lastCues, {
    lookupT: Number.isFinite(lookupT) ? lookupT : playheadSec,
    lookupAxis: highlightCtx.lookupAxis ?? "cueClock",
    playheadSec: Number.isFinite(lookupT) ? lookupT : playheadSec,
    playheadMediaSec: Number.isFinite(lookupT) ? lookupT : playheadSec,
    isPlaying: true,
    selectedCueIndex,
    activeCueIndex,
    activeWordIndex,
  });
}

function syncListPlaybackPosFromStack() {
  const clips = getProgramSegmentTimelineClips();
  if (!clips?.length) return;
  const clipPos = getListOrderPreviewClipPos();
  if (clipPos < 0) return;
  listPlaybackClipPos = clipPos;
  resetListOrderPreviewClipPos(clipPos);
  const ci = cueIndexForClipIndex(clips, lastCues, clipPos);
  if (ci >= 0) {
    listPlaybackListPos = listPosForCueIndex(lastCues, ci);
  } else {
    listPlaybackListPos = clipPos;
  }
}

function syncListPlaybackPosFromMedia(t) {
  const clips = getProgramSegmentTimelineClips();
  if (!clips?.length) return;
  if (useListIndexPlayback()) {
    syncListPlaybackPosFromStack();
    return;
  }
  const prefer = Math.max(
    listPlaybackClipPos >= 0 ? listPlaybackClipPos : -1,
    getListOrderPreviewClipPos(),
  );
  const clipPos = resolveListClipIndexFromMedia(clips, t, prefer, {
    listOrderSequential: true,
  });
  listPlaybackClipPos = clipPos;
  resetListOrderPreviewClipPos(clipPos);
  const ci = cueIndexForClipIndex(clips, lastCues, clipPos);
  if (ci >= 0) {
    listPlaybackListPos = listPosForCueIndex(lastCues, ci);
    return;
  }
  listPlaybackListPos = clipPos;
}

/**
 * @param {number} t playheadSec (편집 축)
 * @param {{ mediaSec?: number }} [ctx]
 */
function resolvePlaybackIndices(t, ctx = {}) {
  const mediaSec =
    ctx.mediaSec ??
    (isPreviewMediaPlaying() ? getPreviewWordClockSec() : t);
  const listOrder = useListIndexPlayback();
  const blockVirtualHighlight =
    USE_BLOCK_VIRTUAL_HIGHLIGHT &&
    !listOrder &&
    subtitleHub._virtualIndex?.length > 0;

  let ai = -1;
  if (listOrder) {
    syncListPlaybackPosFromStack();
    const clips = getProgramSegmentTimelineClips();
    const clipPos =
      listPlaybackClipPos >= 0
        ? listPlaybackClipPos
        : getListOrderPreviewClipPos();
    ai = cueIndexForClipIndex(clips, lastCues, clipPos);
  } else if (blockVirtualHighlight) {
    const programClips = getActiveProgramClips();
    let sourceSec = mediaSec;
    if (isBlocksProgramSegmentPreview()) {
      const programT = resolveProgramSecFromMedia(mediaSec, getProgramSegmentTimelineClips());
      sourceSec = programClips.length ? programToSource(programClips, programT) : programT;
    } else if (isProgramPlaybackTimeline() && programClips.length) {
      sourceSec = programToSource(programClips, mediaSec);
    }
    const skipRanges = getPlaybackSkipRanges();
    const virtualSec = resolveBlockVirtualSecFromMedia(
      sourceSec,
      subtitleHub.blocks,
      subtitleHub._virtualIndex,
      skipRanges,
    );
    ai = pickActiveCueIndexWithBlockVirtual(
      lastCues,
      subtitleHub.blocks,
      subtitleHub._virtualIndex,
      virtualSec,
      lastPlaybackCueIndex,
    );
  } else {
    let cueClock = isPreviewMediaPlaying() ? t : mediaSec;
    if (isBlocksProgramSegmentPreview()) {
      const programT = resolveProgramSecFromMedia(mediaSec, getProgramSegmentTimelineClips());
      cueClock = programToSource(getActiveProgramClips(), programT);
    } else if (isProgramPlaybackTimeline()) {
      const clips = getActiveProgramClips();
      const programT = isPreviewMediaPlaying() ? mediaSec : t;
      cueClock = clips.length ? programToSource(clips, programT) : programT;
    }
    ai = pickActiveCueIndexWithHint(lastCues, cueClock, lastPlaybackCueIndex);
  }

  if (ai < 0) {
    return {
      ai: -1,
      wi: -1,
      lookupT: Number(t) || 0,
      lookupAxis: listOrder
        ? "listMediaVirtual"
        : blockVirtualHighlight
          ? "mediaClock"
          : "cueClock",
    };
  }

  const cue = lastCues[ai];
  const cueJustChanged = ai !== lastPlaybackCueIndex;
  const programClips =
    isProgramPlaybackTimeline() || isBlocksProgramSegmentPreview()
      ? getActiveProgramClips()
      : [];
  const highlightComputed = computeHighlightLookupT(cue, {
    playheadSec: t,
    mediaSec,
    listOrder,
    blockVirtualHighlight,
    programPlayback: isProgramPlaybackTimeline() || isBlocksProgramSegmentPreview(),
    segmentPreview: isBlocksProgramSegmentPreview(),
    programClips,
  });
  const { lookupT, lookupAxis, noHighlight, activeProgramClip } = highlightComputed;
  const wi = resolveActiveWordIndexForCue(cue, ai, {
    lookupT,
    lookupAxis,
    activeProgramClip,
    listOrder,
    cueJustChanged,
    mediaSec,
    noHighlight: noHighlight === true,
  });
  if (cueJustChanged) {
    caretPlayDiagLog("resolvePlaybackIndices", {
      cueIndex: ai,
      wordIndex: wi,
      lookupT: +lookupT.toFixed(4),
      lookupAxis,
      clipPos: activeProgramClip ? listPlaybackClipPos : null,
      cueJustChanged,
      listOrder,
      playheadEditSec: +t.toFixed(4),
      mediaSec: +mediaSec.toFixed(4),
    });
  }
  return { ai, wi, lookupT, lookupAxis, activeProgramClip: activeProgramClip ?? null };
}

function commitPlayheadUi({
  scrollActiveCard = false,
  activeCueIndex,
  activeWordIndex,
  skipWordHighlight = false,
  highlightLookupT,
  highlightLookupAxis,
} = {}) {
  const t = playheadSec;
  const mediaPlaying = isPreviewMediaPlaying();
  const mediaSec = getPreviewWordClockSec();
  const listOrder = useListIndexPlayback();
  let resolved = null;
  let ai;
  if (typeof activeCueIndex === "number") {
    ai = activeCueIndex;
  } else if (mediaPlaying) {
    resolved = resolvePlaybackIndices(t, { mediaSec });
    ai = resolved.ai;
  } else {
    ai = selectedCueIndex;
  }
  const cue = ai >= 0 ? lastCues[ai] : null;
  const cueJustChanged = ai >= 0 && ai !== lastPlaybackCueIndex;
  const wi =
    typeof activeWordIndex === "number"
      ? activeWordIndex
      : cue && mediaPlaying
        ? (() => {
            const hl =
              resolved ??
              resolvePlaybackIndices(t, { mediaSec });
            return resolveActiveWordIndexForCue(cue, ai, {
              lookupT: hl.lookupT,
              lookupAxis: hl.lookupAxis,
              activeProgramClip: hl.activeProgramClip ?? null,
              listOrder,
              cueJustChanged,
              mediaSec,
              noHighlight: hl.noHighlight === true,
            });
          })()
        : -1;

  const cueChanged = cueJustChanged;
  const wordChanged = wi !== lastPlaybackWordIndex;
  const selectionChanged = selectedCueIndex !== lastHighlightSelectedCue;
  const playStateChanged = mediaPlaying !== lastCommitMediaPlaying;

  lastPlaybackCueIndex = ai;
  lastPlaybackWordIndex = wi;

  const previewIdx = getPreviewCueIndex();
  const overlayText = mediaPlaying
    ? resolveOverlayDisplayTextAt(t)
    : previewIdx >= 0
      ? getPreviewCueText(lastCues[previewIdx])
      : "";
  if (overlayText !== lastOverlayDisplayText || previewIdx !== lastOverlayCueIndex) {
    updatePreviewOverlay();
    lastOverlayCueIndex = previewIdx;
  }

  const highlightNeedsUpdate =
    cueChanged || wordChanged || selectionChanged || playStateChanged;

  if (
    cueChanged ||
    wordChanged ||
    selectionChanged ||
    playStateChanged ||
    scrollActiveCard
  ) {
    caretPlayDiagLog("commitPlayheadUi", caretPlayDiagSnapshot({
      activeCueIndex: ai,
      activeWordIndex: wi,
      cueChanged,
      wordChanged,
      selectionChanged,
      playStateChanged,
      mediaPlaying,
      skipWordHighlight,
    }));
  }

  if (mediaPlaying) {
    if (highlightNeedsUpdate && !skipWordHighlight) {
      const hl =
        typeof highlightLookupT === "number"
          ? {
              lookupT: highlightLookupT,
              lookupAxis: highlightLookupAxis ?? "cueClock",
            }
          : computeHighlightLookupT(cue, {
              playheadSec: t,
              mediaSec,
              listOrder,
            });
      updatePlaybackHighlights(subtitleList, lastCues, {
        lookupT: hl.lookupT,
        lookupAxis: hl.lookupAxis,
        playheadSec: hl.lookupT,
        playheadMediaSec: hl.lookupT,
        isPlaying: true,
        selectedCueIndex,
        activeCueIndex: ai,
        activeWordIndex: wi,
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
        playheadEditSec: getWaveformEditSec(expandedCueIndex),
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
  if (!getPv()) {
    stopPlaybackLoop();
    return;
  }

  if (hotReorderInFlight) {
    playbackRafId = requestAnimationFrame(playbackTick);
    return;
  }

  const skip = getPlaybackSkipRanges();
  const skipOpts = { skipRanges: skip };

  if (getPa() && isHtmlAudioMasterActive()) {
    if (getPa().paused) {
      const transitionLocked =
        isListOrderSeamlessPlaybackActive() && isListOrderTransitionLocked();
      if (isVideoPlaying && !transitionLocked) {
        if (getPa().readyState >= 3) {
          getPa().play().then(() => {
            if (getPv() && getPv().paused) {
              getPv().play().catch(() => {});
            }
          }).catch(() => {});
        }
        playbackRafId = requestAnimationFrame(playbackTick);
      } else if (isVideoPlaying) {
        playbackRafId = requestAnimationFrame(playbackTick);
      } else {
        playbackRafId = 0;
      }
      return;
    }
    syncVideoFromHtmlAudioMaster(getPv(), getPa(), skipOpts);
    if (!isHqPreviewMode() && !isListOrderSeamlessPlaybackActive()) {
      syncSegmentPreviewClipBoundaryTick(skipOpts);
    }
    if (isListOrderSeamlessPlaybackActive()) {
      const cp = getListOrderPreviewClipPos();
      if (cp >= 0) listPlaybackClipPos = cp;
    }
  } else if (getPv().paused) {
    playbackRafId = 0;
    return;
  } else {
    applyThrottledVideoSkipCut(getPv(), skip);
  }

  const orch = getPlaybackOrchestrator();
  const media = readPreviewMediaClockSec();
  if (
    isProgramPreviewExecutorActive() &&
    isBlocksProgramSegmentPreview()
  ) {
    const stackClipPos = getListOrderPreviewClipPos();
    if (stackClipPos >= 0) {
      listPlaybackClipPos = stackClipPos;
    }
    playheadSec = getListOrderPreviewProgramSec();
  } else if (isHqPreviewMode()) {
    playheadSec = Number.isFinite(media) ? Math.max(0, media) : playheadSec;
  } else if (isBlocksProgramSegmentPreview()) {
    playheadSec = mapPreviewMediaSecToEditSec(media);
  } else {
    playheadSec = orch.mapMediaToEditSec(media);
  }

  const playbackResolved = resolvePlaybackIndices(playheadSec, { mediaSec: media });
  const { ai, wi, lookupT, lookupAxis } = playbackResolved;
  const cueChanged = ai !== lastPlaybackCueIndex;
  const wordChanged = wi !== lastPlaybackWordIndex;
  const wordClock = media;

  caretPlayDiagLogTick(
    "playbackTick",
    caretPlayDiagSnapshot({
      cueIndex: ai,
      wordIndex: wi,
      lookupT: +lookupT.toFixed(4),
      lookupAxis,
      cueChanged,
      wordChanged,
    }),
    cueChanged || wordChanged,
  );

  if (highlightDiagEnabled && isVideoPlaying && (cueChanged || wordChanged)) {
    const cue = ai >= 0 ? lastCues[ai] : null;
    const words = cue ? getCueWords(cue) : [];
    const w = wi >= 0 ? words[wi] : null;
    logPlaybackHighlight(cueChanged ? "cueChange" : "wordChange", {
      prevCue: lastPlaybackCueIndex,
      prevWi: lastPlaybackWordIndex,
      cueIndex: ai,
      wordIndex: wi,
      word: w?.word ?? w?.text ?? "",
      span: w ? [Number(w.start), Number(w.end)] : null,
      mediaSec: +wordClock.toFixed(4),
      editSec: +playheadSec.toFixed(4),
      lookupT: +lookupT.toFixed(4),
      lookupAxis,
      cueJustChanged: cueChanged,
      listOrder: useListIndexPlayback(),
      clipPos: listPlaybackClipPos,
      audioSec: getPa()?.currentTime,
      videoSec: getPv()?.currentTime,
    });
  }

  if (isVideoPlaying) {
    const cue = ai >= 0 ? lastCues[ai] : null;
    const words = cue?.words;
    const w = wi >= 0 && Array.isArray(words) ? words[wi] : null;
    const audioEl = getPa();
    const videoEl = getPv();
    syncDiagSample({
      audioSec: audioEl?.currentTime,
      videoSec: videoEl?.currentTime,
      wordClockSec: wordClock,
      playheadEditSec: playheadSec,
      cueIndex: ai,
      wordIndex: wi,
      wordText: w?.word ?? w?.text ?? "",
      wordStart: w?.start,
      wordEnd: w?.end,
      stackClock: usesSeamlessAudioClock(),
      htmlAudioMaster: isHtmlAudioMasterActive(),
      avScale: getVideoToWordTimelineScale(),
      previewPath: getSessionPreviewMediaPath(),
    });
  }

  if (isVideoPlaying && subtitleList && ai >= 0) {
    syncPlaybackWordHighlights(ai, wi, { lookupT, lookupAxis });
    lastPlaybackWordIndex = wi;
    lastPlaybackCueIndex = ai;
  }

  if (useListIndexPlayback() && isProgramPreviewExecutorActive()) {
    syncListPlaybackPosFromStack();
    if (isListOrderPreviewPlaybackEnded()) {
      getPa()?.pause();
      getPv()?.pause();
      stopPlaybackLoop();
      commitPlayheadUi({
        activeCueIndex: ai,
        activeWordIndex: wi,
        highlightLookupT: lookupT,
        highlightLookupAxis: lookupAxis,
      });
      return;
    }
  }

  if (waveformPlayRangeEndEdit != null) {
    const waveformEditSec = getWaveformEditSec(expandedCueIndex);
    if (waveformEditSec >= waveformPlayRangeEndEdit - 0.02) {
      getPa()?.pause();
      getPv().pause();
      stopPlaybackLoop({ waveformRangeNaturalEnd: true });
      commitPlayheadUi({
        activeCueIndex: ai,
        activeWordIndex: wi,
        highlightLookupT: lookupT,
        highlightLookupAxis: lookupAxis,
      });
      return;
    }
  }

  if (
    waveformPlayRangeEndEdit != null &&
    expandedCueIndex >= 0 &&
    expandedWordIndex >= 0
  ) {
    syncExpandedPanelPlayhead(subtitleList, {
      expandedCueIndex,
      expandedWordIndex,
      playheadEditSec: getWaveformEditSec(expandedCueIndex),
      mediaPlaying: true,
    });
  }

  const wall = performance.now();
  const uiDue = wall - lastPlayheadUiCommitWallMs >= PLAYHEAD_UI_COMMIT_MS;
  if (cueChanged || wordChanged || uiDue) {
    lastPlayheadUiCommitWallMs = wall;
    commitPlayheadUi({
      activeCueIndex: ai,
      activeWordIndex: wi,
      skipWordHighlight: true,
      highlightLookupT: lookupT,
      highlightLookupAxis: lookupAxis,
    });
  }

  playbackRafId = requestAnimationFrame(playbackTick);
}

function startPlaybackLoop(opts = {}) {
  if (isDeleteGuardActive()) {
    // console.log("[PLAY-DBG] startLoop DELAYED (deleteGuard active)");
    window.setTimeout(() => startPlaybackLoop(opts), 35);
    return;
  }
  if (!getPv() || !getPa()) { /* console.log("[PLAY-DBG] startLoop ABORT: no media"); */ return; }
  if (subtitleHub.blocks?.length && !isPreviewPlaybackReady()) return;
  if (isVideoPlaying && playbackRafId) { /* console.log("[PLAY-DBG] startLoop SKIP: already playing"); */ return; }

  if (playbackRafId) {
    cancelAnimationFrame(playbackRafId);
    playbackRafId = 0;
  }

  if (!opts.fromWaveformRange) {
    waveformPlayRangeEndEdit = null;
  } else {
    listPlaybackListPos = -1;
    deactivateListOrderPreviewPlayback();
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

  stopSyncedPlayback(getPv(), getPa(), {
    keepListOrderTimeline: isBlocksProgramSegmentPreview(),
  });

  const orch = getPlaybackOrchestrator();
  orch.suspendSyncEngineForWebAudio();

  const skip = getPlaybackSkipRanges();
  let media;
  if (opts.fromWaveformRange) {
    media = mapWaveformEditToMediaSec(getWaveformEditSec(expandedCueIndex));
  } else if (isProgramPlaybackTimeline()) {
    media = Math.max(0, Number(playheadSec) || 0);
  } else if (isBlocksProgramSegmentPreview()) {
    media = mapEditSecToPreviewMediaSec(playheadSec);
  } else {
    media = skipCutRangeAt(orch.mapEditToMediaSec(playheadSec), skip);
  }

  if (!opts.fromWaveformRange && isBlocksProgramSegmentPreview()) {
    if (listPlaybackListPos < 0) {
      ensureListOrderListPosFromPlayhead();
    } else {
      activateListOrderPreviewPlayback();
    }
    if (!opts.preservePlayhead && listPlaybackListPos >= 0) {
      const clips = getProgramSegmentTimelineClips() ?? [];
      const clipPos = clipIndexForListPos(clips, lastCues, listPlaybackListPos);
      listPlaybackClipPos = clipPos;
      resetListOrderPreviewClipPos(clipPos);
      const cur = clips[clipPos];
      if (cur) {
        media = skipCutRangeAt(cur.mediaStart, skip);
        playheadSec = cur.editStart;
      }
    } else if (opts.preservePlayhead) {
      media = skipCutRangeAt(mapEditSecToPreviewMediaSec(playheadSec), skip);
    }
  } else if (!opts.fromWaveformRange && !opts.preservePlayhead) {
    deactivateListOrderPreviewPlayback();
  }

  if (getPv()?.duration && Number.isFinite(getPv().duration) && getPv().duration > 0) {
    media = Math.min(media, Math.max(0, getPv().duration - 0.001));
  }
  if (getPa()?.src) {
    assignMasterAudioTimelineSecIfNeeded(getPa(), media);
  }
  if (getPv() && Math.abs(getPv().currentTime - media) > 0.002) {
    getPv().currentTime = media;
  }
  if (!opts.fromWaveformRange) {
    if (isBlocksProgramSegmentPreview()) {
      playheadSec = mapPreviewMediaSecToEditSec(media);
    } else {
      playheadSec = orch.mapMediaToEditSec(media);
    }
  }

  caretPlayDiagLog("startPlaybackLoop", caretPlayDiagSnapshot({
    mediaSec: media,
    fromWaveformRange: Boolean(opts.fromWaveformRange),
    preservePlayhead: Boolean(opts.preservePlayhead),
    loopGeneration: playbackLoopGeneration,
  }));

  void beginPreviewSyncedPlayback(media, {
    disableListOrder: Boolean(opts.fromWaveformRange),
  }).then(() => {
    playbackTick._stallLogged = null;
    const b = getProgramSegmentTimelineBundle();
    if (b) lastPlaybackSegmentFingerprint = b.fingerprint;
    playbackTick();
  });
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
  caretPlayDiagLog("syncPauseCaretAtPlayhead", caretPlayDiagSnapshot({
    pauseAi,
    pauseWi,
    pausedAtCue,
    pausedAtWord,
    resolvedPauseAi: resolvedPause.ai,
    resolvedPauseWi: resolvedPause.wi,
    caretEditSec,
    wasWaveformRange,
  }));
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
  caretPlayDiagLog("stopPlaybackLoop", caretPlayDiagSnapshot({
    pausedAtCue: lastPlaybackCueIndex,
    pausedAtWord: lastPlaybackWordIndex,
    waveformRangeNaturalEnd: opts.waveformRangeNaturalEnd === true,
  }));
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
  if (getPv()) {
    stopSyncedPlayback(getPv(), getPa() ?? undefined, {
      keepListOrderTimeline: isBlocksProgramSegmentPreview(),
    });
  }
  syncPausedPreviewMediaToPlayhead();
  lastPlaybackCueIndex = -1;
  lastPlaybackWordIndex = -1;
  if (isBlocksProgramSegmentPreview()) {
    ensureListOrderPreviewTimelineSynced();
  } else {
    listPlaybackListPos = -1;
    deactivateListOrderPreviewPlayback();
  }
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
  applyPlaybackSkipToPreviewMedia(getPv(), getPa(), {
    skipRanges: getPlaybackSkipRanges(),
  });
}

function isExpandedWordWaveformOpen() {
  return expandedCueIndex >= 0 && expandedWordIndex >= 0;
}

/** 파형 패널 cut~단어 끝 구간 재생/일시정지 */
function toggleExpandedWordWaveformPlayback() {
  if (!subtitleList || !isExpandedWordWaveformOpen()) return false;
  return toggleExpandedPanelPlayFromCut(subtitleList, {
    expandedCueIndex,
    expandedWordIndex,
    playheadSec,
  });
}

async function togglePreviewPlayback(opts = {}) {
  if (!getPv()) return;
  if (!assertProgramMasterForPlayback()) return;
  const playing = isPreviewMediaPlaying() || isVideoPlaying;
  if (playing) {
    caretPlayDiagLog("togglePlayback", caretPlayDiagSnapshot({ action: "pause" }));
    // console.log("[PLAY-DBG] toggle → PAUSE");
    // console.trace("[PLAY-DBG] PAUSE call stack");
    userRequestedPreviewPause = true;
    stopPlaybackLoop();
    userRequestedPreviewPause = false;
    return;
  }
  await previewBridge.unlockAudioOutput();
  if (toggleExpandedWordWaveformPlayback()) {
    caretPlayDiagLog("togglePlayback", caretPlayDiagSnapshot({
      action: "play",
      waveformRange: true,
      expandedCueIndex,
      expandedWordIndex,
    }));
    return;
  }
  caretPlayDiagLog("togglePlayback", caretPlayDiagSnapshot({ action: "play", selectedCueIndex }));
  // console.log("[PLAY-DBG] toggle → PLAY (selectedCue=%d)", selectedCueIndex);
  resetSpaceSeekIntent();
  /** @type {{ preservePlayhead?: boolean }} */
  let loopOpts = {};
  if (selectedCueIndex >= 0 && lastCues[selectedCueIndex]) {
    setListPlaybackListPosFromCueIndex(selectedCueIndex);
    const bounds = cuePlayheadBounds(selectedCueIndex);
    const withinCue =
      playheadSec >= bounds.start - 0.02 &&
      playheadSec < bounds.end + 0.02;
    lastPlaybackCueIndex = selectedCueIndex;
    if (withinCue) {
      loopOpts = { preservePlayhead: true };
    } else if (isBlocksProgramSegmentPreview()) {
      snapPlayheadToCueClipStart(selectedCueIndex);
    } else {
      const cueStart = Number(lastCues[selectedCueIndex].start);
      if (Number.isFinite(cueStart)) {
        const orch = getPlaybackOrchestrator();
        const media = skipCutRangeAt(orch.mapEditToMediaSec(cueStart), getPlaybackSkipRanges());
        orch.seekMediaSec(media);
        playheadSec = orch.mapMediaToEditSec(media);
      }
    }
  } else if (isBlocksProgramSegmentPreview()) {
    ensureListOrderListPosFromPlayhead();
  } else {
    listPlaybackListPos = -1;
    deactivateListOrderPreviewPlayback();
  }
  if (!isVideoPlaying) startPlaybackLoop(loopOpts);
}

/** @param {number} cardIndex @param {number} storageCaret */
function playAtSubtitleCaret(cardIndex, storageCaret) {
  waveformPlayRangeEndEdit = null;
  const cue = lastCues[cardIndex];
  if (!cue) { /* console.log("[PLAY-DBG] playAtCaret: no cue at %d", cardIndex); */ return; }
  const editSec = editSecForStorageWord(cue, storageCaret);
  if (!Number.isFinite(editSec)) { /* console.log("[PLAY-DBG] playAtCaret: bad editSec for card=%d", cardIndex); */ return; }
  caretPlayDiagLog("playAtSubtitleCaret", caretPlayDiagSnapshot({
    cardIndex,
    storageCaret,
    editSec,
    cueText: getPreviewCueText(cue)?.slice(0, 40) ?? "",
  }));
  selectCueLine(cardIndex, { seek: false, scroll: false, rerender: false });
  setListPlaybackListPosFromCueIndex(cardIndex);
  seekEditSecAndPlay(editSec);
}

function applyPreviewOverlayInnerStyles(inner, style, scale) {
  const { fontSize: previewFontSize, strokeWidth: previewStrokeWidth, chrome, position } =
    buildSubtitleOverlayInnerStyle(style, scale);
  const bgAlpha = Math.max(0, Math.min(1, (style.bgOpacity ?? 60) / 100));
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
}

function updatePreviewOverlay() {
  if (!previewOverlay) return;
  layoutPreviewMediaFrame();
  const style = readSubtitleStyleFromDom();
  const scale = getPreviewOverlayScale(style);
  const previewText = normalizePreviewSubtitleText(
    isPreviewMediaPlaying()
      ? resolveOverlayDisplayTextAt(playheadSec)
      : getPreviewCueText(getActiveCueForPreview()),
  );

  if (!previewText) {
    previewOverlay.hidden = true;
    previewOverlay.replaceChildren();
    lastOverlayDisplayText = "";
    updatePreviewWatermark();
    return;
  }

  const existing = previewOverlay.querySelector(".as-preview-overlay-inner");
  if (existing instanceof HTMLElement && existing.textContent === previewText) {
    previewOverlay.hidden = false;
    applyPreviewOverlayInnerStyles(existing, style, scale);
    applySubtitleOverlayTextLayout(existing, previewOverlay);
    lastOverlayDisplayText = previewText;
    updatePreviewWatermark();
    return;
  }

  previewOverlay.hidden = false;
  previewOverlay.replaceChildren();
  const inner = document.createElement("div");
  inner.className = "as-preview-overlay-inner";
  inner.textContent = previewText;
  applyPreviewOverlayInnerStyles(inner, style, scale);
  previewOverlay.appendChild(inner);
  applySubtitleOverlayTextLayout(inner, previewOverlay);
  lastOverlayDisplayText = previewText;
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

function formatFontInstallError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/권한|permission|denied|ProgramData|Font/i.test(msg)) {
    return `${msg}\n\n에이전트를 최신 버전으로 설치·재시작한 뒤 다시 시도하세요. (글꼴은 %ProgramData%\\itmatzip-agent\\Font 에 저장됩니다)`;
  }
  if (/Windows 글꼴 등록/i.test(msg)) {
    return `${msg}\n\n다른 글꼴 파일(.ttf/.otf)로 시도하거나, 에이전트를 한 번 종료 후 트레이에서 다시 실행해 보세요.`;
  }
  return friendlyAgentError(err);
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
    openFontAddModal({
      title: "폰트 추가",
      message: "글꼴 파일 선택 창을 여는 중입니다…\n(창이 가려져 있으면 작업 표시줄을 확인하세요.)",
      loading: true,
    });

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
    if (!sourcePath || pick?.cancelled) {
      closeFontAddModal();
      return;
    }

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
      message: `${family}\n저장 위치: ${installed?.fonts_dir || ""}`,
      showOk: true,
    });
  } catch (err) {
    openFontAddModal({
      title: "폰트 추가 실패",
      message: formatFontInstallError(err),
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

/**
 * @param {readonly number[]} removedSortedDesc
 * @param {number} index
 */
function remapCueIndexAfterRemovals(removedSortedDesc, index) {
  let n = index;
  for (const r of removedSortedDesc) {
    if (n === r) return -1;
    if (n > r) n -= 1;
  }
  return n;
}

function syncCheckedCueIndicesExclusive(cueIndex) {
  checkedCueIndices.clear();
  if (cueIndex >= 0) checkedCueIndices.add(cueIndex);
}

function adjustEditorIndicesAfterCueRemovals(removedSortedDesc) {
  const nextChecked = new Set();
  for (const c of checkedCueIndices) {
    const n = remapCueIndexAfterRemovals(removedSortedDesc, c);
    if (n >= 0) nextChecked.add(n);
  }
  checkedCueIndices = nextChecked;
  selectedCueIndex = remapCueIndexAfterRemovals(removedSortedDesc, selectedCueIndex);
  expandedCueIndex = remapCueIndexAfterRemovals(removedSortedDesc, expandedCueIndex);
  if (expandedCueIndex < 0) expandedWordIndex = -1;
}

function deleteSelectedSubtitleLines() {
  const targets =
    checkedCueIndices.size > 0
      ? [...checkedCueIndices]
      : selectedCueIndex >= 0
        ? [selectedCueIndex]
        : [];
  if (!targets.length) return;
  if (subtitleList) captureTextareaEditsIntoCues(subtitleList, lastCues);
  const sorted = [...new Set(targets)].sort((a, b) => b - a);
  hubBlocksChangedOpts = { reason: "line-delete", anchorPlayhead: true };
  deleteSubtitleLinesAt(subtitleHub, sorted);
  adjustEditorIndicesAfterCueRemovals(sorted);
  if (selectedCueIndex < 0) checkedCueIndices.clear();
  snapPlayheadToCueClipStart(selectedCueIndex);
  armDeleteGuard();
  renderCuesTable(lastCues);
  applyDeletePlaybackSync();
  commitPlayheadUi();
}

function selectCueLine(cueIndex, { scroll = true, seek = true, rerender = true, syncCheck = true } = {}) {
  const prevSelected = selectedCueIndex;
  selectedCueIndex = cueIndex;
  if (syncCheck) syncCheckedCueIndicesExclusive(cueIndex);
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
  if (seek && getPv() && Number.isFinite(cue.start)) {
    seekPreviewToSourceSec(Number(cue.start), { commitUi: false, cueIndex });
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
/** @type {{ phase: string, progress: number, at: number, lastLogAt: number } | null} */
let burnInPollDiag = null;
let exportAwaitingFramesInFlight = false;
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
  const wordAlignActive = Boolean(wordAlignLoading?.classList.contains("is-active"));
  const previewMediaActive = Boolean(previewMediaLoading?.classList.contains("is-active"));
  const busy =
    setupActive ||
    transcribeActive ||
    exportActive ||
    gpuPromptActive ||
    fontAddActive ||
    watermarkModalActive ||
    wordAlignActive ||
    previewMediaActive;
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
  wordAlignLoading?.classList.remove("is-active");
  if (wordAlignLoading) {
    wordAlignLoading.hidden = true;
    wordAlignLoading.setAttribute("aria-hidden", "true");
  }
  exportLoading?.classList.remove("is-active");
  if (exportLoading) {
    exportLoading.hidden = true;
    exportLoading.setAttribute("aria-hidden", "true");
  }
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

function hidePreviewMediaLoadingModal() {
  if (!previewMediaLoading) return;
  previewMediaLoading.hidden = true;
  previewMediaLoading.classList.remove("is-active");
  previewMediaLoading.setAttribute("aria-hidden", "true");
  if (previewMediaLoadingActions) previewMediaLoadingActions.hidden = true;
  if (previewMediaLoadingTrack) previewMediaLoadingTrack.hidden = false;
}

function setPreviewMediaLoading(active, { title, step, message, showOk = false } = {}) {
  if (!previewMediaLoading) return;
  if (active && isTranscribeLoadingUiActive()) {
    setTranscribeLoading(true, {
      title: TRANSCRIBE_LOADING_TITLE,
      step: step || "미리보기",
      message: message || "편집 화면 불러오는 중…",
      progress: 97,
    });
    return;
  }
  if (!active) {
    hidePreviewMediaLoadingModal();
    syncInAppBusyShell();
    return;
  }
  {
    previewMediaLoading.hidden = false;
    previewMediaLoading.classList.add("is-active");
    previewMediaLoading.setAttribute("aria-hidden", "false");
    if (title && previewMediaLoadingTitle) previewMediaLoadingTitle.textContent = title;
    if (previewMediaLoadingStep) previewMediaLoadingStep.textContent = step || "";
    if (previewMediaLoadingMessage && message) previewMediaLoadingMessage.textContent = message;
    if (previewMediaLoadingTrack) previewMediaLoadingTrack.hidden = showOk;
    if (previewMediaLoadingActions) previewMediaLoadingActions.hidden = !showOk;
    if (previewMediaLoadingBar && previewMediaLoadingTrack && !showOk) {
      previewMediaLoadingBar.style.width = "35%";
      previewMediaLoadingTrack.setAttribute("aria-valuenow", "0");
    }
    syncInAppBusyShell();
  }
}

/** 모달 DOM 반영 후 무거운 동기 작업 실행 (프로젝트 불러오기 등). */
function yieldToUiPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

async function beginProjectLoadUi(step, message) {
  setPreviewMediaLoading(true, {
    title: "프로젝트 불러오기",
    step: step || "불러오기",
    message: message || "처리 중…",
  });
  await yieldToUiPaint();
}

function setSetupLoading(active, { title, step, message, progress } = {}) {
  if (!setupLoading) return;
  const wasActive = setupLoading.classList.contains("is-active");
  if (active) {
    if (!wasActive) setAgentLongOperationActive(true);
    hidePreviewMediaLoadingModal();
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
    hidePreviewMediaLoadingModal();
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

function syncWordAlignButtonState() {
  if (!btnWordAutoAlign) return;
  const ko = isKoreanLanguageSelected(languageSelect?.value);
  const hasTargets = collectWordAlignTargetIndices(lastCues).length > 0;
  const enabled = ko && hasTargets && agentConnected && !wordAlignRunning;
  btnWordAutoAlign.disabled = !enabled;
  btnWordAutoAlign.title = ko
    ? hasTargets
      ? "말소리 자막의 단어 칩을 형태소 분석으로 줄 나눕니다"
      : "자동정렬할 말소리 자막(단어 2개 이상)이 없습니다"
    : "한국어를 선택했을 때만 사용할 수 있습니다";
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
  syncWordAlignButtonState();
  if (btnFindReplace) {
    btnFindReplace.disabled = !hasCues;
    btnFindReplace.title = hasCues
      ? "자막 편집 영역에서 찾기·바꾸기 (Ctrl+F)"
      : "자막이 있을 때 사용할 수 있습니다";
  }
}

function setWordAlignLoading(active, { title, step, message, progress } = {}) {
  if (!wordAlignLoading) return;
  const wasActive = wordAlignLoading.classList.contains("is-active");
  if (active) {
    if (!wasActive) setAgentLongOperationActive(true);
    hidePreviewMediaLoadingModal();
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
    exportLoading?.classList.remove("is-active");
    if (exportLoading) {
      exportLoading.hidden = true;
      exportLoading.setAttribute("aria-hidden", "true");
    }
    if (wordAlignKiwiLink) wordAlignKiwiLink.href = KIWI_LGPL_URL;
    wordAlignLoading.hidden = false;
    wordAlignLoading.classList.add("is-active");
    wordAlignLoading.setAttribute("aria-hidden", "false");
    if (title && wordAlignLoadingTitle) wordAlignLoadingTitle.textContent = title;
    if (wordAlignLoadingStep) wordAlignLoadingStep.textContent = step || "";
    if (message && wordAlignLoadingMessage) wordAlignLoadingMessage.textContent = message;
    if (wordAlignLoadingBar && wordAlignLoadingTrack) {
      if (typeof progress === "number") {
        const pct = Math.max(0, Math.min(100, progress));
        wordAlignLoadingBar.style.width = `${pct}%`;
        wordAlignLoadingTrack.setAttribute("aria-valuenow", String(Math.round(pct)));
        if (wordAlignLoadingPercent) wordAlignLoadingPercent.textContent = `${Math.round(pct)}%`;
      } else {
        wordAlignLoadingBar.style.width = "12%";
        wordAlignLoadingTrack.setAttribute("aria-valuenow", "0");
        if (wordAlignLoadingPercent) wordAlignLoadingPercent.textContent = "";
      }
    }
    syncInAppBusyShell();
    syncWordAlignButtonState();
    return;
  }
  if (wasActive) setAgentLongOperationActive(false);
  wordAlignLoading.hidden = true;
  wordAlignLoading.classList.remove("is-active");
  wordAlignLoading.setAttribute("aria-hidden", "true");
  syncInAppBusyShell();
  syncWordAlignButtonState();
}

function wordAlignFriendlyError(err) {
  const msg = formatAgentConnectionError(err);
  if (/kiwipiepy|Kiwi|_kiwipiepy|Prepare|DLL load failed|Permission denied|액세스가 거부/i.test(msg)) {
    return msg;
  }
  if (/409|진행 중|busy/i.test(msg)) return MSG_SUBTITLE_JOB_BUSY;
  if (/Failed to fetch|NetworkError|ERR_FAILED|Load failed/i.test(msg)) return MSG_SUBTITLE_NEED_APP;
  if (/연결.*차단|일시적으로 연결/i.test(msg)) {
    return "에이전트 통신이 일시적으로 제한되었습니다. 잠시 후 다시 시도하거나 에이전트를 재시작해 주세요.";
  }
  return msg || "단어 자동정렬에 실패했습니다.";
}

async function onWordAutoAlignClick() {
  if (!isKoreanLanguageSelected(languageSelect?.value)) return;
  if (!agentConnected) {
    alert(MSG_SUBTITLE_NEED_APP);
    return;
  }
  if (wordAlignRunning) return;
  const targets = collectWordAlignTargetIndices(lastCues);
  if (!targets.length) {
    alert("자동정렬할 말소리 자막(단어 2개 이상)이 없습니다.");
    return;
  }

  if (subtitleList) captureTextareaEditsIntoCues(subtitleList, lastCues);
  syncCuesFromDom();

  wordAlignRunning = true;
  syncWordAlignButtonState();
  setWordAlignLoading(true, {
    title: "단어 자동정렬",
    step: "",
    message: "형태소 분석으로 줄 나눔 위치를 계산합니다…",
    progress: 0,
  });

  try {
    const result = await runWordAutoAlign(subtitleHub, (pct, msg) => {
      setWordAlignLoading(true, {
        title: "단어 자동정렬",
        message: msg,
        progress: pct,
      });
    });
    renderCuesTable(lastCues, { capturePendingEdits: false });
    if (resultsMeta) {
      resultsMeta.textContent = `${lastCues.length} cues · 단어 자동정렬 (${result.splitCount}줄 분할)`;
    }
    await new Promise((r) => setTimeout(r, 500));
  } catch (err) {
    setWordAlignLoading(true, {
      title: "단어 자동정렬 실패",
      message: wordAlignFriendlyError(err),
      progress: 0,
    });
    await new Promise((r) => setTimeout(r, 2800));
  } finally {
    wordAlignRunning = false;
    setWordAlignLoading(false);
    syncWordAlignButtonState();
  }
}

function setExportLoading(active, { title, step, message, progress } = {}) {
  if (!exportLoading) return;
  const wasActive = exportLoading.classList.contains("is-active");
  if (active) {
    if (!wasActive) setAgentLongOperationActive(true);
    hidePreviewMediaLoadingModal();
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
    wordAlignLoading?.classList.remove("is-active");
    if (wordAlignLoading) {
      wordAlignLoading.hidden = true;
      wordAlignLoading.setAttribute("aria-hidden", "true");
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

function showExportError(msg, opts = {}) {
  const text = msg || "오류가 발생했습니다.";
  const sticky = opts.sticky === true;
  setExportLoading(true, {
    title: "보내기 실패",
    step: "",
    message: text,
    progress: 0,
  });
  burnInConsoleLog("export_error", { message: text, sticky });
  if (!sticky) {
    setTimeout(() => setExportLoading(false), 15000);
  }
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
  const audioSsot = getAudioTimelineDurationSec();
  if (audioSsot != null && audioSsot > 0) return audioSsot;
  if (sessionMediaDurationSec != null && sessionMediaDurationSec > 0) return sessionMediaDurationSec;
  if (getPa()?.duration && Number.isFinite(getPa().duration) && getPa().duration > 0) {
    return getPa().duration;
  }
  if (getPv()?.duration && Number.isFinite(getPv().duration) && getPv().duration > 0) {
    return getPv().duration;
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
  const mediaSec = mediaPlaying ? readPreviewMediaClockSec() : playheadSec;
  const playbackResolved = mediaPlaying
    ? resolvePlaybackIndices(playheadSec, { mediaSec })
    : null;
  const activeCue = mediaPlaying ? playbackResolved.ai : selectedCueIndex;
  const activeWordIndex = mediaPlaying ? playbackResolved.wi : -1;
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
    getPlayheadSec: () => getWaveformEditSec(expandedCueIndex >= 0 ? expandedCueIndex : selectedCueIndex),
    getActiveCueIndex: () =>
      isPreviewMediaPlaying() && lastPlaybackCueIndex >= 0
        ? lastPlaybackCueIndex
        : selectedCueIndex,
    getActiveWordIndex: () => (isPreviewMediaPlaying() ? lastPlaybackWordIndex : -1),
    activeCueIndex: activeCue,
    activeWordIndex,
    highlightLookupT: playbackResolved?.lookupT,
    highlightLookupAxis: playbackResolved?.lookupAxis,
    scrollActiveCard: scrollActive,
    peaksData: peaksPayload,
    getPeaksData: () => peaksPayload,
    mediaDurationSec,
    getMediaDurationSec: getMediaDurationSecHint,
    video: getPv(),
    getCues: () => lastCues,
    getPlaybackSkipRanges: () => subtitleHub.getPlaybackSkipRanges(),
    formatTimeFull: formatTime,
    getVirtualIndexForCue: (cueIndex) => subtitleHub.getVirtualIndexForBlock(cueIndex),
    getBlockDurationForCue: (cueIndex) => subtitleHub.blocks[cueIndex]?.duration,
    ensurePeaksLoad: () => loadWaveformPeaks(),
    onCardNavigate: (sec) => {
      if (getPv() && Number.isFinite(sec)) {
        seekPreviewToSourceSec(sec);
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
      if (subtitleList) captureTextareaForCue(subtitleList, lastCues, index);
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
      if (subtitleList) captureTextareaForCue(subtitleList, lastCues, cardIndex);
      armDeleteGuard();
      backspaceWordAt(subtitleHub, cardIndex, wordIndex);
      renderCuesTable(lastCues);
      applyDeletePlaybackSync();
      if (subtitleList) {
        const focusIdx =
          cardIndex < lastCues.length && lastCues[cardIndex]
            ? cardIndex
            : Math.max(0, Math.min(cardIndex, lastCues.length - 1));
        const words = lastCues[focusIdx]?.words ?? [];
        const wi = Math.max(0, wordIndex - 1);
        requestFocusCaretDeferred(
          subtitleList,
          lastCues,
          buildSubtitleCardOpts(lastCues),
          focusIdx,
          nearestValidStorageCaret(words, wi),
          { seek: false },
        );
      }
    },
    onDeleteWordAt: (cardIndex, caretIndex) => {
      if (subtitleList) captureTextareaForCue(subtitleList, lastCues, cardIndex);
      armDeleteGuard();
      deleteWordAt(subtitleHub, cardIndex, caretIndex);
      renderCuesTable(lastCues);
      applyDeletePlaybackSync();
      commitPlayheadUi();
      if (subtitleList && lastCues.length) {
        const focusIdx =
          cardIndex < lastCues.length && lastCues[cardIndex]
            ? cardIndex
            : Math.max(0, Math.min(cardIndex, lastCues.length - 1));
        const words = lastCues[focusIdx]?.words ?? [];
        requestFocusCaretDeferred(
          subtitleList,
          lastCues,
          buildSubtitleCardOpts(lastCues),
          focusIdx,
          nearestValidStorageCaret(words, caretIndex),
          { seek: false },
        );
      }
    },
    onDeleteWordRangeAt: (cardIndex, from, to) => {
      if (subtitleList) captureTextareaForCue(subtitleList, lastCues, cardIndex);
      armDeleteGuard();
      deleteWordRangeAt(subtitleHub, cardIndex, from, to);
      renderCuesTable(lastCues);
      applyDeletePlaybackSync();
      commitPlayheadUi();
      if (subtitleList && lastCues.length) {
        const focusIdx =
          cardIndex < lastCues.length && lastCues[cardIndex]
            ? cardIndex
            : Math.max(0, Math.min(cardIndex, lastCues.length - 1));
        const words = lastCues[focusIdx]?.words ?? [];
        requestFocusCaretDeferred(
          subtitleList,
          lastCues,
          buildSubtitleCardOpts(lastCues),
          focusIdx,
          nearestValidStorageCaret(words, from),
          { seek: false },
        );
      }
    },
    isCueLineChecked: (cueIndex) => checkedCueIndices.has(cueIndex),
    onToggleCueLineCheck: (cueIndex, checked) => {
      if (checked) checkedCueIndices.add(cueIndex);
      else checkedCueIndices.delete(cueIndex);
      selectCueLine(cueIndex, {
        seek: false,
        scroll: false,
        rerender: false,
        syncCheck: false,
      });
      renderCuesTable(lastCues, { capturePendingEdits: true });
    },
    isCueLineDragActive: () => subtitleLineDragActive,
    onSubtitleLineDragStart: () => {
      subtitleLineDragActive = true;
      hotReorderDragWasPlaying = Boolean(isVideoPlaying);
    },
    onDragReorderEnd: () => {
      subtitleLineDragActive = false;
      hotReorderDragWasPlaying = false;
    },
    onReorderCueByListInsert: (fromListPos, insertBeforePos) => {
      if (subtitleList) captureTextareaEditsIntoCues(subtitleList, lastCues);
      const hotSnap = captureHotReorderPlaybackSnapshot();
      const before = listableCueIndices(lastCues);
      const movedCueIndex = before[fromListPos];
      const wasExpanded = expandedCueIndex === movedCueIndex;
      let newListPos = insertBeforePos;
      if (fromListPos < insertBeforePos) newListPos = insertBeforePos - 1;
      hubBlocksChangedOpts = { reason: "line-reorder", skipRefresh: true };
      const reorderResult = reorderSubtitleLinesByListInsert(
        subtitleHub,
        fromListPos,
        insertBeforePos,
      );
      if (reorderResult && reorderResult.ok === false) {
        hubBlocksChangedOpts = null;
        subtitleLineDragActive = false;
        alert("자막 순서를 변경할 수 없습니다.");
        renderCuesTable(lastCues);
        return;
      }
      bumpListableCueIndicesCache();
      const after = listableCueIndices(lastCues);
      const newCueIndex = after[newListPos] ?? movedCueIndex;
      selectedCueIndex = newCueIndex;
      syncCheckedCueIndicesExclusive(newCueIndex);
      if (wasExpanded) expandedCueIndex = newCueIndex;
      subtitleLineDragActive = false;
      void applyReorderPlaybackSync(newCueIndex, hotSnap).then(() => {
        renderCuesTable(lastCues);
        /** render 후 카드 DOM 재생성 — 선택 CSS 비교값만 초기화 */
        lastHighlightSelectedCue = -1;
        if (isVideoPlaying && isPreviewMediaPlaying()) {
          const clipPos =
            listPlaybackClipPos >= 0 ? listPlaybackClipPos : 0;
          const hl = resolveHotReorderPlaybackHighlight(
            {
              clipPos,
              mediaSec: readPreviewMediaClockSec(),
              programSec: playheadSec,
            },
            { updateDom: true },
          );
          commitPlayheadUi({
            activeCueIndex: hl.ai,
            activeWordIndex: hl.wi,
            skipWordHighlight: true,
            highlightLookupT: hl.lookupT,
            highlightLookupAxis: hl.lookupAxis,
          });
          if (!playbackRafId) playbackTick();
        } else {
          commitPlayheadUi();
        }
      });
    },
    onSelectCue: (cueIndex, detail) =>
      selectCueLine(cueIndex, {
        seek: detail?.seek !== false,
        scroll: detail?.scroll !== false,
        rerender: detail?.rerender !== false,
        syncCheck: detail?.syncCheck !== false,
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
    onFindReplaceTextInput: () => {
      if (subtitleFindReplace.isOpen()) subtitleFindReplace.refreshHighlights();
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
      if (getPv() && Number.isFinite(sec)) {
        const media = skipCutRangeAt(sec, getPlaybackSkipRanges());
        caretPlayDiagLog("onSeekMedia", caretPlayDiagSnapshot({ mediaSec: sec, mappedMedia: media }));
        if (getPa()?.src) assignMasterAudioTimelineSecIfNeeded(getPa(), media);
        if (Math.abs(getPv().currentTime - media) > 0.002) getPv().currentTime = media;
        playheadSec = mapPreviewMediaSecToEditSec(media);
        commitPlayheadUi();
      }
    },
    onSeekWord: (cue, storageWordIndex) => {
      if (!getPv()) return;
      const sourceSec = editSecForStorageWord(cue, storageWordIndex);
      if (!Number.isFinite(sourceSec)) return;
      const cueIndex = lastCues.indexOf(cue);
      caretPlayDiagLog("onSeekWord", caretPlayDiagSnapshot({
        storageWordIndex,
        editSec: sourceSec,
        mediaSec: skipCutRangeAt(sourceSec, getPlaybackSkipRanges()),
        cueIndex,
      }));
      seekPreviewToSourceSec(sourceSec, { cueIndex });
    },
    onTogglePlayback: (fromSpace) =>
      togglePreviewPlayback({
        showCaretOnPause: Boolean(fromSpace),
      }),
    onWaveformSeekAndPlay: (editSec) => {
      if (!Number.isFinite(editSec)) return;
      if (expandedCueIndex >= 0) {
        selectedCueIndex = expandedCueIndex;
        setListPlaybackListPosFromCueIndex(expandedCueIndex);
      }
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
    mapEditToMediaSec: (editSec) => mapWaveformEditToMediaSec(editSec),
    mapMediaToEditSec: (mediaSec) => mapWaveformMediaToEditSec(mediaSec),
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
      if (subtitleHub.undo()) handleHubHistoryRestore();
    },
    onPlayEditRange: (startEdit, endEdit) => {
      if (!getPv() || !getPa() || !Number.isFinite(startEdit) || !Number.isFinite(endEdit)) return;
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
      const startMedia = mapWaveformEditToMediaSec(start);
      waveformPlayRangeEndEdit = hi;
      const ci = expandedCueIndex >= 0 ? expandedCueIndex : selectedCueIndex;
      if (isBlocksProgramSegmentPreview()) {
        playheadSec =
          ci >= 0 ? mapSourceSecToPlayheadSecForCue(ci, start) : mapSourceSecToPlayheadSec(start);
        if (ci >= 0) {
          setListPlaybackListPosFromCueIndex(ci);
          const clips = getProgramSegmentTimelineClips() ?? [];
          const clipPos = clipIndexForListPos(clips, lastCues, listPlaybackListPos);
          listPlaybackClipPos = clipPos;
          resetListOrderPreviewClipPos(clipPos);
        }
      } else {
        playheadSec = start;
      }
      if (getPa()?.src) assignMasterAudioTimelineSecIfNeeded(getPa(), startMedia);
      if (getPv() && Math.abs(getPv().currentTime - startMedia) > 0.002) {
        getPv().currentTime = startMedia;
      }
      getPlaybackOrchestrator().seekMediaSec(startMedia);
      commitPlayheadUi();
      startPlaybackLoop({ fromWaveformRange: true });
    },
    onPausePlayback: () => {
      userRequestedPreviewPause = true;
      stopPlaybackLoop();
      getPv()?.pause();
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
  checkedCueIndices = new Set();
  subtitleLineDragActive = false;
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
  bumpListableCueIndicesCache();
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
  const videoPath =
    getSessionPreviewMediaPath() || videoPathInput?.value?.trim();
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
    const metrics = resolvePeaksTimelineMetrics(result.payload, sessionMediaDurationSec);
    if (metrics?.data?.length && lastCues.length) {
      subtitleHub.reapplyExtractPostProcessWithPeaks(metrics);
    }
    renderCuesTable(lastCues);
    await refreshSessionMediaTimingFromAgent(videoPath);
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
  const videoPath = res?.video_path || res?.normalized?.video_path || res?.project?.videoPath || "";
  const hasVideo = !!String(videoPath || "").trim();

  await beginProjectLoadUi(
    hasVideo ? "프로젝트 적용" : "불러오기",
    hasVideo ? "자막·타임라인 복원 중…" : "프로젝트 데이터 적용 중…",
  );

  resetEditorSessionForProjectLoad();

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
  }
  const projectPayload =
    project && typeof project === "object"
      ? {
          ...project,
          version: project.version ?? res?.normalized?.version,
          blocks:
            (Array.isArray(project.blocks) && project.blocks.length
              ? project.blocks
              : null) ??
            (Array.isArray(res?.normalized?.blocks) ? res.normalized.blocks : undefined),
          hardDeletedMediaSkips:
            project.hardDeletedMediaSkips ??
            res?.normalized?.hard_deleted_media_skips ??
            [],
        }
      : null;
  if (
    projectPayload &&
    (Number(projectPayload.version) >= 2 || Array.isArray(projectPayload.blocks))
  ) {
    subtitleHub.ingestFromProject(projectPayload, {
      cutRanges: Array.isArray(cuts) ? cuts : [],
    });
  } else {
    subtitleHub.ingestFromProject(Array.isArray(cues) ? cues : [], {
      cutRanges: Array.isArray(cuts) ? cuts : [],
    });
  }
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

  if (hasVideo) {
    try {
      setPreviewMediaLoading(true, {
        title: "프로젝트 불러오기",
        step: "CFR 미디어",
        message: "A/V 정규화·CFR 변환…\n(캐시 있으면 즉시 완료)",
      });
      await yieldToUiPaint();

      const previewPath = await ensureSessionPreviewMediaPath({
        onProgress: ({ step, message, progress }) => {
          setPreviewMediaLoading(true, {
            title: "프로젝트 불러오기",
            step: step || "CFR 미디어",
            message: message || "처리 중…",
            progress: progress ?? 8,
          });
        },
      });
      if (!previewPath) {
        alert(
          "CFR 미디어 준비에 실패했습니다.\n\n" +
            "• itmatzip-agent를 재시작하세요 (go-agent 재빌드 후)\n" +
            "• VFR 영상이면 자막 추출을 다시 실행하세요",
        );
      }
      if (subtitleHub.blocks?.length) {
        await ensureProgramMasterAfterIngest({ preview_media_path: previewPath });
      } else {
        await updatePreview(previewPath || videoPath);
      }
      await loadWaveformPeaks();
    } finally {
      setPreviewMediaLoading(false);
    }
  } else {
    setPreviewMediaLoading(false);
  }
}

async function loadProjectViaFilePicker() {
  const [handle] = await window.showOpenFilePicker({
    types: [{
      description: "AutoSubtitle 프로젝트",
      accept: {
        "application/json": [".json", ".autosub"],
      },
    }],
    multiple: false,
  });
  const file = await handle.getFile();
  await beginProjectLoadUi("파일 읽기", "프로젝트 JSON 파싱 중…");
  let project;
  try {
    project = JSON.parse(await file.text());
  } catch {
    setPreviewMediaLoading(false);
    alert("프로젝트 JSON을 읽을 수 없습니다.");
    return;
  }
  if (!project || typeof project !== "object" || project.format !== "autosubtitle-project") {
    setPreviewMediaLoading(false);
    alert("AutoSubtitle 프로젝트 파일이 아닙니다.");
    return;
  }
  await applyLoadedProject({
    project,
    video_path: project.videoPath || project.video_path || null,
    cut_ranges: project.cutRanges || project.cut_ranges || [],
  });
}

async function onLoadProjectViaAgent() {
  if (!agentConnected) {
    alert(MSG_SUBTITLE_NEED_APP);
    return;
  }
  await beginProjectLoadUi("파일 선택", "프로젝트 파일 선택 중…");
  let pick;
  try {
    pick = await requestAgent({ path: "/api/agent/pick-local-project-file", method: "POST" });
  } catch (err) {
    if (/취소|cancel/i.test(String(err))) {
      setPreviewMediaLoading(false);
      return;
    }
    setPreviewMediaLoading(false);
    throw err;
  }
  const projectPath = pick?.project_path || pick?.path || "";
  if (!projectPath) {
    setPreviewMediaLoading(false);
    return;
  }

  setPreviewMediaLoading(true, {
    title: "프로젝트 불러오기",
    step: "서버 로드",
    message: "에이전트에서 프로젝트 읽는 중…",
  });
  await yieldToUiPaint();

  const res = await requestAgent({
    path: `${TOOL_PREFIX}/project/load`,
    method: "POST",
    json: { project_path: projectPath },
  });
  await applyLoadedProject(res);
}

async function onLoadProject() {
  if (typeof window.showOpenFilePicker === "function") {
    try {
      await loadProjectViaFilePicker();
      return;
    } catch (err) {
      const name = String(err?.name || err || "");
      if (/aborted|cancel/i.test(name)) return;
      console.warn("project file picker failed, falling back to agent load", err);
    }
  }
  await onLoadProjectViaAgent();
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

function isPrepareIdlePhase(phase) {
  const p = String(phase || "").trim();
  return !p || p === "not_started" || p === "idle";
}

function isPrepareActivePhase(phase) {
  const p = String(phase || "").trim();
  return Boolean(p) && !isPrepareIdlePhase(p) && p !== "ready" && p !== "failed";
}

function resolvePrepareModalTitle(step, detail, phase) {
  const blob = `${step || ""} ${detail || ""}`.toLowerCase();
  if (/모델 로드|float16|float32|int8|cuda|cpu int8|메모리/.test(blob)) {
    return "Whisper 모델 로드";
  }
  if (phase === "downloading_models" || /hugging|model\.bin|ai 모델/.test(blob)) {
    return "AI 모델 다운로드";
  }
  if (/gpu|dll|runtime|cublas/.test(blob)) {
    return "GPU 런타임 설치";
  }
  if (/패키지|pip|python|faster-whisper|whisper/.test(blob)) {
    if (/이미 설치|설치 완료|준비 완료/.test(blob)) return "Whisper 준비";
    return "Python 패키지 설치";
  }
  if (/ffmpeg/.test(blob)) {
    if (/이미|준비 완료|준비됨/.test(blob)) return "Whisper 준비";
    return "FFmpeg 준비";
  }
  return "Whisper 준비";
}

function resolvePrepareModalMessage(step, detail, phase, progress) {
  const base = detail || step || "준비 중…";
  if (
    phase !== "ready" &&
    typeof progress === "number" &&
    progress >= 90 &&
    !/모델 로드|float16|int8|cuda|cpu/.test(`${step} ${base}`.toLowerCase())
  ) {
    return "Whisper 모델을 메모리에 올리는 중입니다…";
  }
  return base;
}

async function pollPrepareStatus() {
  const data = await requestAgent({ path: `${TOOL_PREFIX}/prepare/status` });
  const phase = data?.phase || "";
  const step = data?.step || phase;
  const progress = typeof data?.progress === "number" ? data.progress : undefined;
  _lastPrepareProgress = progress ?? _lastPrepareProgress;
  const detail = data?.detail || data?.message || "";
  if (isPrepareIdlePhase(phase)) {
    setSetupLoading(true, {
      title: "Whisper 준비",
      step: "시작",
      message: "환경 준비를 시작하는 중…",
      progress: typeof progress === "number" ? progress : 2,
    });
    return null;
  }
  const title = resolvePrepareModalTitle(step, detail, phase);
  let message = resolvePrepareModalMessage(step, detail, phase, progress);
  if (
    phase === "downloading_models" &&
    typeof progress === "number" &&
    progress >= 84 &&
    progress < 90 &&
    /100%/.test(String(message)) &&
    !/model\.bin|배치|로드|검증|MB 수신/i.test(String(message))
  ) {
    message =
      `${message}\n\n대용량 model.bin(~1.5GB) 수신·검증 중입니다. 진행률 85% 근처에서 1~3분 걸릴 수 있습니다.`;
  } else if (/모델 로드|GPU\(CUDA\)|CPU int8/i.test(String(step || message))) {
    message = `${message}\n\nWhisper 모델을 메모리에 올리는 중입니다…`;
  }
  setSetupLoading(true, {
    title,
    step,
    message,
    progress,
  });
  if (phase === "ready") {
    stopPreparePoll();
    setSetupLoading(false);
    whisperPrepareReadySession = true;
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

function waitForPrepareCompletion() {
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
    }, 400);
  });
}

async function ensurePrepared() {
  if (whisperPrepareReadySession) {
    const cached = await fetchReadiness();
    if (cached?.binaries?.model_loaded) return true;
    whisperPrepareReadySession = false;
  }

  if (!(await waitForAgentApiReady())) {
    alert("에이전트 Python 엔진이 아직 기동 중입니다.\n잠시 후 다시 시도하거나 트레이에서 서비스를 재시작해 주세요.");
    return false;
  }

  let readiness = await fetchReadiness();
  if (readiness?.binaries?.model_loaded) {
    whisperPrepareReadySession = true;
    return true;
  }

  const bins = readiness?.binaries || {};
  const depsInstalled =
    bins.ffmpeg && bins.ffprobe && bins.faster_whisper && bins.model_present;

  let prepareStatus = null;
  try {
    prepareStatus = await requestAgent({ path: `${TOOL_PREFIX}/prepare/status` });
  } catch {
    /* ignore */
  }

  if (prepareStatus?.phase === "ready") {
    readiness = await fetchReadiness();
    if (readiness?.binaries?.model_loaded) {
      whisperPrepareReadySession = true;
      return true;
    }
  }

  const prepareRunning = isPrepareActivePhase(prepareStatus?.phase);

  if (!prepareRunning) {
    if (depsInstalled) {
      setSetupLoading(true, {
        title: "Whisper 준비",
        step: "모델 로드",
        message: "AI 모델을 메모리에 올리는 중입니다…",
        progress: 90,
      });
    } else {
      setSetupLoading(true, {
        title: "AI 환경 준비",
        step: "시작",
        message: MSG_SUBTITLE_PREPARE,
        progress: 2,
      });
    }
    try {
      await requestAgent({ path: `${TOOL_PREFIX}/prepare`, method: "POST" });
    } catch (e) {
      console.warn("[ensurePrepared] POST /prepare failed, will poll status anyway:", e);
    }
  } else if (depsInstalled) {
    setSetupLoading(true, {
      title: "Whisper 준비",
      step: prepareStatus?.step || "모델 로드",
      message: prepareStatus?.detail || prepareStatus?.message || "AI 모델을 메모리에 올리는 중입니다…",
      progress: typeof prepareStatus?.progress === "number" ? prepareStatus.progress : 90,
    });
  } else {
    setSetupLoading(true, {
      title: resolvePrepareModalTitle(prepareStatus?.step, prepareStatus?.detail, prepareStatus?.phase),
      step: prepareStatus?.step || "진행 중",
      message: prepareStatus?.detail || prepareStatus?.message || MSG_SUBTITLE_PREPARE,
      progress: typeof prepareStatus?.progress === "number" ? prepareStatus.progress : 2,
    });
  }

  return waitForPrepareCompletion();
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
    lastExportPath = data.srt_path || null;
    await finalizeTranscribeResults(data.cues || [], data.duration_sec, {
      waveform_peaks_json: data.waveform_peaks_json,
      waveform_peaks: data.waveform_peaks,
      media_timing: data.media_timing,
      preview_media_path: data.preview_media_path,
      program_master_path: data.program_master_path,
      program_duration_sec: data.program_duration_sec,
      program_master_probe_ok: data.program_master_probe_ok,
      bake_level: data.bake_level,
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
 * @param {{ waveform_peaks_json?: object | null, waveform_peaks?: object | null, media_timing?: object | null, preview_media_path?: string | null, program_master_path?: string | null, program_duration_sec?: number | null, program_master_probe_ok?: boolean | null, bake_level?: string | null }} [transcribeMeta]
 */
async function finalizeTranscribeResults(rawCues, durationSecHint, transcribeMeta = {}) {
  subtitleHub.gapFillWhenBuildingVrew = false;
  clearProgramMasterCache();
  programMasterPreviewPath = "";
  setTranscribeLoading(true, {
    title: TRANSCRIBE_LOADING_TITLE,
    step: "후처리",
    message: "타임라인 정리 중…",
    progress: 95,
  });

  try {
    if (transcribeMeta.media_timing) {
      setSessionMediaTiming(transcribeMeta.media_timing);
      const mt = transcribeMeta.media_timing;
      const previewPath =
        transcribeMeta.preview_media_path || mt.preview_media_path || "";
      if (previewPath) {
        setSessionPreviewMediaPath(previewPath);
      }
      if (isSourceVideoPtsTimeline()) {
        mediaTimingDiagLog("source_video_pts — preview SSOT", {
          video_sec: mt.video_duration_sec,
          skew_sec: mt.av_start_skew_sec,
          preview: previewPath || null,
          actions: mt.preprocess_actions ?? mt.normalize_actions,
        });
      } else {
        const avDelta = Math.abs(Number(mt.av_duration_delta_sec) || 0);
        mediaTimingDiagLog("transcribe", {
          av_delta_sec: mt.av_duration_delta_sec,
          audio_sec: mt.audio_duration_sec,
          video_sec: mt.video_duration_sec,
          vfr: mt.vfr_suspected,
          normalized: mt.normalized ?? Boolean(mt.normalize_actions?.length),
          actions: mt.normalize_actions,
          preview: transcribeMeta.preview_media_path,
        });
        if (avDelta >= 0.05 || mt.vfr_suspected) {
          mediaTimingDiagWarn(
            "A/V 또는 VFR 보정 적용됨 — audio SSOT 재생·word time 기준",
          );
        }
      }
    } else {
      mediaTimingDiagWarn(
        "API 응답에 media_timing 없음 — 에이전트가 구버전(MSI)이거나 소스 미반영. sync-agent-source.ps1 후 재시작하세요.",
      );
    }
    const dur =
      getAudioTimelineDurationSec() ??
      (Number(durationSecHint) > 0
        ? Number(durationSecHint)
        : getMediaDurationSecHint());

    if (dur != null && dur > 0) sessionWhisperDurationSec = dur;

    const inlinePeaks = transcribeMeta?.waveform_peaks_json;
    if (inlinePeaks && resolvePeaksTimelineMetrics(inlinePeaks, dur ?? undefined)) {
      peaksPayload = inlinePeaks;
    } else {
      const videoPath =
        getSessionPreviewMediaPath() ||
        transcribeMeta.preview_media_path ||
        transcribeMeta.media_timing?.preview_media_path ||
        videoPathInput?.value?.trim();
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
    const audioDur = getAudioTimelineDurationSec();
    if (peaksPayload) {
      const nativeDur = Number(peaksPayload.timeline_sec ?? peaksPayload.duration_sec);
      const hasNative = Number.isFinite(nativeDur) && nativeDur > 0;
      if (!hasNative && audioDur) {
        peaksPayload.duration_sec = audioDur;
        peaksPayload.timeline_sec = audioDur;
        if (peaksMetrics) {
          peaksMetrics.durationSec = audioDur;
        }
      }
    }
    if (peaksMetrics?.durationSec > 0) {
      sessionMediaDurationSec = getAudioTimelineDurationSec() ?? peaksMetrics.durationSec;
    } else if (dur != null && dur > 0) {
      sessionMediaDurationSec = dur;
    }
    const pb =
      transcribeMeta.media_timing?.playback_duration_sec ??
      transcribeMeta.media_timing?.word_timeline_duration_sec ??
      transcribeMeta.media_timing?.video_duration_sec;
    const whisperDurForScale =
      Number(pb) > 0
        ? Number(pb)
        : Number(durationSecHint) > 0
          ? Number(durationSecHint)
          : Number(dur);
    const peaksDurForScale = peaksMetrics?.durationSec;
    const scaleRatio =
      peaksDurForScale > 0 && whisperDurForScale > 0
        ? peaksDurForScale / whisperDurForScale
        : null;
    subtitleHub.ingestFromTranscribe(rawCues, {
      gapFill: false,
      peaksMetrics,
      whisperDurationSec: whisperDurForScale > 0 ? whisperDurForScale : null,
      mediaTiming: transcribeMeta.media_timing ?? null,
    });
    logMediaTimingAvSnapshot("post-ingest", transcribeMeta.media_timing, {
      peaks_sec: peaksDurForScale > 0 ? peaksDurForScale : null,
      whisper_sec: whisperDurForScale > 0 ? whisperDurForScale : null,
      peaks_whisper_ratio: scaleRatio,
      scale_applied: scaleRatio != null && Math.abs(scaleRatio - 1) > 0.004,
      cue_count: Array.isArray(rawCues) ? rawCues.length : 0,
    });
    try {
      sessionStorage.setItem(STORAGE_CUES, JSON.stringify(lastCues));
      if (lastExportPath) sessionStorage.setItem(STORAGE_EXPORT_PATH, lastExportPath);
    } catch {
      /* ignore */
    }
    const previewPath =
      transcribeMeta.preview_media_path || getSessionPreviewMediaPath();
    if (previewPath) {
      setSessionPreviewMediaPath(previewPath);
    }
    if (subtitleHub.blocks?.length) {
      await ensureProgramMasterAfterIngest(transcribeMeta);
      logMediaTimingAvSnapshot("preview playback", getSessionMediaTiming(), {
        path: previewPath || programMasterPreviewPath || "",
        normalized: transcribeMeta.media_timing?.normalized ?? null,
      });
    } else if (previewPath) {
      await updatePreview(previewPath);
      await refreshSessionMediaTimingFromAgent(previewPath);
    } else {
      const exportPath = videoPathInput?.value?.trim();
      if (exportPath) await refreshSessionMediaTimingFromAgent(exportPath);
    }
    if (!isPreviewPlaybackReady() && subtitleHub.blocks?.length) {
      const recovered = await ensurePreviewPlaybackReadyAfterIngest(transcribeMeta);
      if (!recovered) {
        throw new Error("미리보기(CFR + programClips)가 준비되지 않았습니다.");
      }
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
    step: "전처리",
    message: "비디오 축 오디오 추출 중…",
    progress: 0,
  });

  const mediaContract = await prepareMediaForWhisper(videoPath);
  if (!mediaContract?.ok) {
    stopTranscribePoll();
    setTranscribeLoading(false);
    alert(
      friendlyAgentError(
        mediaContract?.error ||
          "Go 미디어 전처리 실패 — FFmpeg 준비 후 다시 시도하세요.",
      ),
    );
    return false;
  }

  setTranscribeLoading(true, {
    title: TRANSCRIBE_LOADING_TITLE,
    step: "",
    message: TRANSCRIBE_LOADING_START_MSG,
    progress: 1,
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
        whisper_audio_path: mediaContract.whisper_audio_path,
        media_timing_contract: mediaContract,
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
  const masterCache = getProgramMasterCache();
  const programClips = buildProgramClips(subtitleHub.blocks, lastCutRanges || []);
  const previewPath = getSessionPreviewMediaPath() || "";
  const clipsFingerprint = programClipsFingerprint(
    previewPath,
    programClips,
    JSON.stringify(lastCutRanges || []),
  );
  const masterFresh =
    !!masterCache.path &&
    masterCache.fingerprint === clipsFingerprint &&
    Math.abs((masterCache.durationSec || 0) - getProgramDurationSec(programClips)) < 0.08;
  const programMasterPath = masterFresh
    ? programMasterPreviewPath || masterCache.path
    : null;
  return {
    ...buildExportRequestPayload(
      lastCues,
      lastCutRanges,
      readSubtitleStyleFromDom(),
      fmt,
      {
        previewMediaPath: previewPath || null,
        videoPath: videoPathInput?.value?.trim() || null,
        programMasterPath,
      },
      {
        blocks: subtitleHub.blocks,
        virtualIndex: subtitleHub._virtualIndex,
        mediaDurationSec: getMediaDurationSecHint(),
      },
    ),
    burn_in_media_contract: buildBurnInMediaContract(),
    ...burnInPipelineDiagAgentPayload(),
  };
}

function buildProjectJson() {
  return JSON.stringify({
    format: "autosubtitle-project",
    version: 2,
    videoPath: videoPathInput?.value?.trim() || null,
    cutRanges: lastCutRanges,
    hardDeletedMediaSkips: subtitleHub.hardDeletedMediaSkips || [],
    blocks: subtitleHub.blocks,
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
  whisperPrepareReadySession = false;
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

async function runAwaitingFramesPngBurnIn(statusData) {
  const burnPath = String(statusData?.burnin_media_path || "").trim();
  if (!burnPath) {
    throw new Error("burnin_media_path가 없습니다. export를 다시 시도해 주세요.");
  }
  const label = exportFormatLabel("video");
  const pngPayload = buildExportPayload("video");
  const rawAxis = String(statusData?.export_time_axis || "").trim();
  const exportTimeAxis =
    rawAxis === "program"
      ? "program"
      : rawAxis === "stitched_program"
        ? "stitched_program"
        : rawAxis === "filter_program"
          ? "filter_program"
          : "media";
  const stitched = exportTimeAxis === "stitched_program";
  const useProgram =
    exportTimeAxis === "program" ||
    exportTimeAxis === "stitched_program" ||
    exportTimeAxis === "filter_program";
  const cutRanges = useProgram ? [] : pngPayload.cut_ranges || [];
  const rawActualDuration = statusData?.actual_duration;
  const actualDuration =
    stitched && typeof rawActualDuration === "number" && rawActualDuration > 0
      ? rawActualDuration
      : undefined;
  let programToBurninMap = Array.isArray(statusData?.program_to_burnin_map)
    ? statusData.program_to_burnin_map
    : Array.isArray(statusData?.burn_in_media_contract?.program_to_burnin_map)
      ? statusData.burn_in_media_contract.program_to_burnin_map
      : null;
  const vmapForMap = pngPayload.virtual_audio_map || [];
  if (stitched && (!programToBurninMap || !programToBurninMap.length) && actualDuration) {
    programToBurninMap = buildProgramToBurninMapFromVirtualAudioMap(vmapForMap, actualDuration);
    burnInConsoleLog("program_map_fe_fallback", {
      segments: programToBurninMap.length,
      actualDuration,
      hint: "BE map 없음 — FE 폴백. 에이전트 재시작·재빌드 권장.",
    });
  }
  const burnInMediaContract = {
    ...buildBurnInMediaContract(),
    ...(statusData?.burn_in_media_contract && typeof statusData.burn_in_media_contract === "object"
      ? statusData.burn_in_media_contract
      : {}),
    ...(programToBurninMap?.length ? { program_to_burnin_map: programToBurninMap } : {}),
  };
  if (stitched && exportTimeAxis !== "program" && (!programToBurninMap || !programToBurninMap.length)) {
    const errMsg =
      "program_to_burnin_map이 없습니다. itmatzip-agent를 재빌드·재시작한 뒤 export를 다시 시도하세요.";
    showExportError(errMsg, { sticky: true });
    throw new Error(errMsg);
  }
  const agentMapMissing = !statusData?.program_to_burnin_map?.length;
  if (stitched && agentMapMissing && /concat_master\.mp4/i.test(burnPath)) {
    burnInConsoleLog("agent_cfr_normalize_missing", {
      burnPath,
      hint: "concat_master 직결 — CFR normalize 미적용. 에이전트 재시작 필요.",
    });
  }
  burnInConsoleLog("awaiting_frames_burn_in_start", {
    burnPath,
    stitched,
    actualDuration,
    exportTimeAxis,
    programMapSegments: programToBurninMap?.length || 0,
  });
  const sessionTiming = getSessionMediaTiming();
  const vmapEnd = virtualMapProgramEndSec(pngPayload.virtual_audio_map || []);
  const exportHandoff = {
    burnPath,
    exportTimeAxis,
    stitched,
    actualDuration,
    previewMediaPath: getSessionPreviewMediaPath(),
    previewDurationSec: getVideoTimelineDurationSec(),
    sessionAudioDurationSec: getAudioTimelineDurationSec(),
    sessionVideoDurationSec: sessionTiming?.video_duration_sec,
    sessionTargetFps: sessionTiming?.target_ntsc_fps,
    contractTargetFps: burnInMediaContract?.target_ntsc_fps,
    programMapSegments: programToBurninMap?.length || 0,
    virtualProgramEnd: vmapEnd,
    virtualMapSegments: (pngPayload.virtual_audio_map || []).length,
    requiresConcat: pngPayload.requires_concat,
  };
  burnInPipelineDiagHandoff("awaiting_frames_start", exportHandoff);
  analyzeBurnInPipelineHandoff(exportHandoff);
  burnInPipelineDiagLog("awaiting_frames_start", exportHandoff);
  setExportLoading(true, {
    title: "보내기",
    step: "영상 · 자막 캡처",
    message: "프레임 스케줄 생성·PNG 캡처…",
    progress: 46,
  });
  const programDurationSec =
    exportTimeAxis === "program"
      ? Number(
          statusData?.burn_in_media_contract?.program_duration_sec ??
            pngPayload.program_duration_sec ??
            statusData?.actual_duration ??
            0,
        ) || undefined
      : undefined;
  await runVideoBurnInExport({
    toolPrefix: TOOL_PREFIX,
    videoPath: burnPath,
    lastCues: lastCues,
    cutRanges,
    exportTimeAxis,
    requiresConcat: stitched,
    actualDuration: exportTimeAxis === "program" ? programDurationSec : actualDuration,
    burninDuration:
      exportTimeAxis === "program" ? programDurationSec ?? actualDuration : actualDuration,
    programToBurninMap: programToBurninMap || undefined,
    burnInMediaContract,
    virtualAudioMap: pngPayload.virtual_audio_map || [],
    blocks: subtitleHub.blocks,
    virtualIndex: subtitleHub._virtualIndex,
    programClips: buildProgramClips(subtitleHub.blocks, lastCutRanges || []),
    style: readSubtitleStyleFromDom(),
    watermark: watermarkConfig.path ? { ...watermarkConfig } : null,
    onUiProgress: ({ progress, step, message }) => {
      setExportLoading(true, {
        title: "보내기",
        step: step || `${label} · PNG 번인`,
        message: message || "처리 중…",
        progress,
      });
    },
  });
}

function startExportStatusPolling(fmt, resolve) {
  stopExportPoll();
  if (fmt === "video") {
    burnInPollDiag = { phase: "", progress: -1, at: Date.now(), lastLogAt: 0 };
    burnInConsoleLog("poll_start", { fmt });
  }
  exportPollTimer = setInterval(async () => {
    try {
      const done = await pollExportStatus(fmt, resolve);
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
}

function isExportAwaitingFramesStatus(data) {
  const phase = String(data?.phase || "");
  if (phase === "awaiting_frames") return true;
  const progress = typeof data?.progress === "number" ? data.progress : -1;
  const msg = String(data?.message || "");
  // 구버전/버그: enter_video_export_awaiting_hold 직후 phase=running 으로 덮인 경우
  return (
    phase === "running" &&
    progress >= 44 &&
    progress <= 46 &&
    /프레임 업로드 대기/.test(msg)
  );
}

function logBurnInExportPoll(fmt, data) {
  const exportFmt = data?.format || fmt;
  if (exportFmt !== "video") return;
  const phase = String(data?.phase || "");
  const progress = typeof data?.progress === "number" ? data.progress : null;
  const now = Date.now();
  const diag = burnInPollDiag || { phase: "", progress: -1, at: now, lastLogAt: 0 };
  const phaseChanged = phase !== diag.phase;
  const progressChanged = progress != null && progress !== diag.progress;
  const stalledMs = now - diag.at;
  const heartbeatDue = now - diag.lastLogAt >= 30_000;

  if (phaseChanged || progressChanged) {
    burnInConsoleLog("poll", {
      phase,
      progress,
      message: data?.message || "",
      error: data?.error || undefined,
      actualDuration: data?.actual_duration,
      exportTimeAxis: data?.export_time_axis,
    });
    diag.phase = phase;
    if (progress != null) diag.progress = progress;
    diag.at = now;
    diag.lastLogAt = now;
  } else if (heartbeatDue) {
    burnInConsoleLog("heartbeat", {
      phase,
      progress,
      message: data?.message || "",
      stalledSec: Math.round(stalledMs / 1000),
      uiSmoothedProgress: smoothedProgress,
      hint:
        progress != null && progress >= 98
          ? "FFmpeg 번인 99% 고정 — 백엔드 인코더/mux 대기 중일 수 있음"
          : "상태 변화 없음 — 에이전트 응답 정체 여부 확인",
    });
    diag.lastLogAt = now;
  }
  burnInPollDiag = diag;
}

async function pollExportStatus(fmt, resolvePromise) {
  const data = await requestAgent({ path: `${TOOL_PREFIX}/export/status` });
  const phase = data?.phase || "";
  logBurnInExportPoll(fmt, data);
  if (burnInPipelineDiagIsEnabled() && fmt === "video") {
    burnInPipelineDiagLog("export_poll", {
      phase,
      progress: data?.progress,
      message: data?.message,
      actualDuration: data?.actual_duration,
      exportTimeAxis: data?.export_time_axis,
      videoEncoder: data?.video_encoder,
      overlayMode: data?.overlay_mode,
      uiSmoothedProgress: smoothedProgress,
      uiSmoothTarget: smoothProgressTarget,
    });
  }

  const rawProgress = typeof data?.progress === "number" ? data.progress : undefined;
  if (rawProgress != null) {
    const concatWaitPhases = new Set([
      "concat_copy",
      "concat_reencode",
      "concat_normalize",
      "running",
      "queued",
    ]);
    if (concatWaitPhases.has(phase)) {
      const floor = phase === "awaiting_frames" ? 33 : 0;
      const capped = Math.min(Math.max(rawProgress, floor), 99);
      smoothProgressTarget = Math.max(smoothProgressTarget, capped);
    } else if (rawProgress > smoothProgressTarget) {
      smoothProgressTarget = Math.min(rawProgress, 99);
    }
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

  if (phase === "completed" && burnInPipelineDiagIsEnabled()) {
    burnInPipelineDiagHandoff("export_completed", {
      resultPath: data?.result_path,
      phase,
      progress: 100,
    });
    burnInPipelineDiagReport();
  }

  if (phase === "completed") {
    burnInConsoleLog("completed", { resultPath: data?.result_path });
    burnInPollDiag = null;
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
  if (isExportAwaitingFramesStatus(data)) {
    burnInConsoleLog("awaiting_frames", {
      phase,
      burninMediaPath: data?.burnin_media_path,
      actualDuration: data?.actual_duration,
      exportTimeAxis: data?.export_time_axis,
    });
    if (exportAwaitingFramesInFlight) {
      burnInConsoleLog("awaiting_frames_skipped", { reason: "in_flight" });
      return null;
    }
    exportAwaitingFramesInFlight = true;
    stopExportPoll();
    setExportLoading(true, {
      title: "보내기",
      step: exportPhaseStepLabel(phase, data?.format || fmt),
      message: data?.message || "자막 프레임 캡처…",
      progress: typeof data?.progress === "number" ? data.progress : undefined,
    });
    try {
      await runAwaitingFramesPngBurnIn(data);
    } catch (err) {
      exportAwaitingFramesInFlight = false;
      const msg = friendlyAgentError(err);
      showExportError(msg, { sticky: /program_to_burnin|gate failed|Agent|에이전트/i.test(msg) });
      return false;
    }
    exportAwaitingFramesInFlight = false;
    if (typeof resolvePromise === "function") {
      const resumeProgress = Math.max(smoothedProgress, 45);
      smoothedProgress = resumeProgress;
      smoothProgressTarget = Math.max(smoothProgressTarget, resumeProgress);
      startExportStatusPolling(fmt, resolvePromise);
    }
    return null;
  }
  if (phase === "failed") {
    burnInConsoleLog("failed", { error: data?.error, message: data?.message });
    burnInPollDiag = null;
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
    setExportLoading(true, {
      title: "보내기",
      step: `${label} · 준비`,
      message: "CFR 미디어 확인…",
      progress: 2,
    });
    const previewPath = await ensureSessionPreviewMediaPath();
    if (!previewPath) {
      setExportLoading(false);
      showExportError(
        "CFR 미디어 재생성 필요. VFR 영상은 자막 추출을 다시 실행하거나, 에이전트가 연결된 상태에서 미디어를 준비해 주세요.",
      );
      return;
    }
    if (subtitleHub.blocks?.length) {
      setExportLoading(true, {
        title: "보내기",
        step: `${label} · Program master`,
        message: "편집 타임라인 확인·캐시…",
        progress: 4,
      });
      try {
        const bakeResult = await ensureProgramMasterForExport();
        const bakeTag = formatBakeLevelLabel(bakeResult?.bakeLevel);
        if (bakeTag) {
          setExportLoading(true, {
            title: "보내기",
            step: `${label} · Program master (${bakeTag})`,
            message: bakeResult?.cached
              ? "캐시된 program-master 사용"
              : "program-master bake 완료",
            progress: 8,
          });
        }
      } catch (err) {
        setExportLoading(false);
        showExportError(friendlyAgentError(err));
        return;
      }
    }
    const payload = buildExportPayload(fmt);
    try {
      exportAwaitingFramesInFlight = false;
      await requestAgent({ path: `${TOOL_PREFIX}/export`, method: "POST", json: payload });
      return new Promise((resolve) => {
        resetSmoothProgress();
        smoothedProgress = 5;
        smoothProgressTarget = 5;
        startExportStatusPolling(fmt, resolve);
      });
    } catch (err) {
      const msg = friendlyAgentError(err);
      if (!/404|Not Found|video-burn-in/i.test(msg)) {
        showExportError(msg);
        return;
      }
      console.warn("[export] Python V41 pipeline unavailable; deprecated PNG burn-in fallback");
    }
    try {
      const pngPayload = buildExportPayload("video");
      await runVideoBurnInExport({
        toolPrefix: TOOL_PREFIX,
        videoPath: previewPath,
        lastCues,
        cutRanges: pngPayload.cut_ranges || [],
        requiresConcat: pngPayload.requires_concat,
        exportTimeAxis: pngPayload.export_time_axis,
        virtualAudioMap: pngPayload.virtual_audio_map || [],
        blocks: subtitleHub.blocks,
        virtualIndex: subtitleHub._virtualIndex,
        programClips: buildProgramClips(subtitleHub.blocks, lastCutRanges || []),
        style: readSubtitleStyleFromDom(),
        watermark: watermarkConfig.path ? { ...watermarkConfig } : null,
        onUiProgress: ({ progress, step, message }) => {
          setExportLoading(true, {
            title: "보내기",
            step: step || `${label} · 처리 중 (deprecated)`,
            message: message || "처리 중…",
            progress,
          });
        },
      });
      return new Promise((resolve) => {
        smoothedProgress = 40;
        smoothProgressTarget = 40;
        startExportStatusPolling(fmt, resolve);
      });
    } catch (pngErr) {
      showExportError(friendlyAgentError(pngErr));
      return;
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
    resetSmoothProgress();
    smoothedProgress = 5;
    smoothProgressTarget = 5;
    startExportStatusPolling(fmt, resolve);
  });
}

function buildDownloadReturnSnapshot(filePath, fmt) {
  syncCuesFromDom();
  if (isPreviewMediaPlaying() || isVideoPlaying) {
    capturePlayheadFromPreviewMedia();
  }
  const previewMediaPath = getSessionPreviewMediaPath() || "";
  const vp = videoPathInput?.value?.trim() || sessionVideoPath || "";
  return {
    v: 1,
    format: fmt,
    exportPath: filePath,
    previewMediaPath,
    playback: {
      programSec: Number(playheadSec) || 0,
      listPlaybackClipPos:
        listPlaybackClipPos >= 0
          ? listPlaybackClipPos
          : getListOrderPreviewClipPos(),
    },
    project: {
      format: "autosubtitle-project",
      version: 2,
      videoPath: vp || null,
      cutRanges: lastCutRanges || [],
      hardDeletedMediaSkips: subtitleHub.hardDeletedMediaSkips || [],
      blocks: subtitleHub.blocks?.length ? subtitleHub.blocks : [],
      subtitles: lastCues,
    },
  };
}

function persistDownloadReturnSnapshot(filePath, fmt) {
  const snapshot = buildDownloadReturnSnapshot(filePath, fmt);
  const vp = snapshot.project?.videoPath;
  try {
    sessionStorage.setItem("auto-subtitle:dl-file-path", filePath);
    sessionStorage.setItem("auto-subtitle:dl-format", fmt);
    sessionStorage.setItem(STORAGE_RETURN_FROM_DL, "1");
    sessionStorage.setItem(STORAGE_DL_RESTORE, JSON.stringify(snapshot));
    sessionStorage.setItem(STORAGE_CUES, JSON.stringify(lastCues));
    sessionStorage.setItem(STORAGE_CUTS, JSON.stringify(lastCutRanges));
    if (vp) sessionStorage.setItem(STORAGE_VIDEO_PATH, vp);
    if (snapshot.previewMediaPath) {
      setSessionPreviewMediaPath(snapshot.previewMediaPath);
    }
    if (lastExportPath) {
      sessionStorage.setItem(STORAGE_EXPORT_PATH, lastExportPath);
    }
  } catch {
    /* ignore */
  }
}

/**
 * download.html → index.html 복귀 후 CFR preview·playhead 재적용.
 */
async function completeDownloadReturnRestore() {
  if (!downloadReturnRestorePending) return;
  downloadReturnRestorePending = false;

  const meta = downloadReturnRestoreMeta;
  downloadReturnRestoreMeta = null;

  if (subtitleHub.blocks?.length && !getProgramSegmentTimelineClips().length) {
    refreshProgramSegmentTimelineFromHub({
      reason: "download-return",
      preserveProgramSec: true,
    });
  }

  const playback = meta?.playback;
  if (playback && Number.isFinite(Number(playback.programSec))) {
    playheadSec = Math.max(0, Number(playback.programSec));
  }
  if (
    playback &&
    Number.isInteger(playback.listPlaybackClipPos) &&
    playback.listPlaybackClipPos >= 0
  ) {
    listPlaybackClipPos = playback.listPlaybackClipPos;
    resetListOrderPreviewClipPos(playback.listPlaybackClipPos);
  }

  if (isBlocksProgramSegmentPreview()) {
    const anchor = resolveSegmentPlaybackAnchorWithSkips(
      playheadSec,
      getProgramSegmentTimelineClips(),
    );
    applySegmentPlaybackAnchor(anchor);
    scheduleSyncPausedPreviewMediaToPlayhead();
  } else if (getPv()) {
    const media = mapEditSecToPreviewMediaSec(playheadSec);
    assignMasterAudioTimelineSecIfNeeded(getPa(), media);
    const videoMedia = mapWordTimelineToVideoTime(media);
    if (Number.isFinite(getPv().duration) && getPv().duration > 0) {
      getPv().currentTime = Math.min(
        videoMedia,
        Math.max(0, getPv().duration - 0.001),
      );
    } else {
      getPv().currentTime = videoMedia;
    }
  }

  if (meta?.exportPath) {
    lastExportPath = meta.exportPath;
  } else {
    try {
      const storedExport = sessionStorage.getItem(STORAGE_EXPORT_PATH);
      if (storedExport) lastExportPath = storedExport;
    } catch {
      /* ignore */
    }
  }

  rebuildPlaybackSync();
  refreshOverlayTimingContext();
  commitPlayheadUi();
  updateActionButtons();
}

function openDownload(filePath) {
  if (!filePath || !agentConnected) return;
  const fmt = exportFormatSelect?.value || "srt";
  persistDownloadReturnSnapshot(filePath, fmt);
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
  programMasterPreviewPath = "";
  clearProgramPlaybackSession();
  clearProgramMasterCache();
  updatePreview("");
}

function detachPreviewMasterAudio() {
  previewBridge.clearMedia();
}

function updatePreview(videoPath, opts = {}) {
  if (!getPv() || !previewSection) return Promise.resolve();
  stopPlaybackLoop();
  setPreviewPlaybackUiActive(false);
  detachPreviewMasterAudio();
  const p = String(videoPath || "").trim();
  const loadGen = ++previewMediaLoadGen;
  releasePreviewMediaBlob();
  const useTranscribeShell =
    opts.useTranscribeShell === true ||
    (opts.useTranscribeShell !== false && isTranscribeLoadingUiActive());

  if (!p || !agentConnected) {
    clearProgramPlaybackSession();
    if (!useTranscribeShell) setPreviewMediaLoading(false);
    previewBridge.clearMedia();
    if (previewEmpty) {
      previewEmpty.hidden = false;
      previewEmpty.textContent = "영상·오디오 파일을 선택하세요.";
    }
    layoutPreviewMediaFrame();
    updatePreviewOverlay();
    updatePreviewWatermark();
    updatePreviewTransportUi();
    return Promise.resolve();
  }

  void refreshSessionMediaTimingFromAgent(getSessionPreviewMediaPath() || p);

  const directUrl = buildAgentResourceUrl(
    `${TOOL_PREFIX}/media/stream?video_path=${encodeURIComponent(p)}`,
  );
  previewMediaDirectUrl = directUrl;
  if (previewEmpty) {
    previewEmpty.hidden = false;
    previewEmpty.textContent = "미디어 불러오는 중…";
  }

  if (useTranscribeShell) {
    setTranscribeLoading(true, {
      title: TRANSCRIBE_LOADING_TITLE,
      step: "미리보기",
      message: "편집 화면 불러오는 중…",
      progress: 97,
    });
  } else {
    setPreviewMediaLoading(true, {
      title: "미리보기 불러오기",
      message:
        "잠시만 기다려 주세요.\n용량이 큰 영상은 시간이 더 걸릴 수 있습니다.\n편집 화면은 불러오기가 끝날 때까지 잠시 멈춥니다.",
    });
  }

  previewMediaLoadAbort = new AbortController();
  const { signal } = previewMediaLoadAbort;

  return resolveAgentMediaObjectUrl(directUrl, {
    signal,
    onAttempt(attempt) {
      if (attempt > 1 && !useTranscribeShell) {
        setPreviewMediaLoading(true, {
          title: "미리보기 다시 불러오기",
          message: "연결이 끊겨 다시 시도합니다.\n잠시만 기다려 주세요…",
        });
      }
    },
  })
    .then((url) => {
      if (loadGen !== previewMediaLoadGen) return;
      previewMediaResolvedUrl = url;
      masterMediaUrl = url;
      return previewBridge.setMediaUrl(url).then(async () => {
        await waitForPreviewMediaReady();
        if (previewEmpty) previewEmpty.hidden = true;
        if (!useTranscribeShell) setPreviewMediaLoading(false);
        inferMediaTimingFromBrowserMedia(previewVideoEl, getPa());
        if (/program-master\.mp4$/i.test(p) && !subtitleHub.blocks?.length) {
          applyProgramPlaybackSession(p);
        } else {
          clearProgramPlaybackSession();
        }
        const dur = getAudioTimelineDurationSec() ?? previewVideoEl.duration;
        if (dur > 0) sessionMediaDurationSec = dur;
        layoutPreviewMediaFrame();
        updatePreviewOverlay();
        updatePreviewWatermark();
        updatePreviewTransportUi();
        const orch = getPlaybackOrchestrator();
        if (!orch.video) {
          orch.attachVideo(previewVideoEl, {
            masterAudio: previewAudioEl ?? undefined,
            onPlayheadChange: ({ editSec }) => {
              if (!isVideoPlaying) playheadSec = editSec;
            },
          });
        } else if (previewAudioEl) {
          orch.masterAudio = previewAudioEl;
        }
        rebuildPlaybackSync();
      });
    })
    .then(() => {
      if (loadGen !== previewMediaLoadGen) return;
      previewVideoEl.onloadedmetadata = () => {
        if (loadGen !== previewMediaLoadGen) return;
        if (!useTranscribeShell) setPreviewMediaLoading(false);
        inferMediaTimingFromBrowserMedia(previewVideoEl, getPa());
        const dur = getAudioTimelineDurationSec() ?? previewVideoEl.duration;
        if (dur > 0) sessionMediaDurationSec = dur;
        layoutPreviewMediaFrame();
        updatePreviewOverlay();
        updatePreviewWatermark();
        updatePreviewTransportUi();
      };
      previewVideoEl.onerror = () => {
        if (loadGen !== previewMediaLoadGen) return;
        if (useTranscribeShell) return;
        setPreviewMediaLoading(true, {
          title: "미리보기 불러오기 실패",
          message:
            "영상 파일을 재생할 수 없습니다.\n보내기·인코딩이 끝났는지 확인한 뒤, 영상 경로를 다시 선택해 주세요.",
          showOk: true,
        });
      };
    })
    .catch((err) => {
      if (loadGen !== previewMediaLoadGen) return;
      if (err instanceof DOMException && err.name === "AbortError") {
        if (!useTranscribeShell) setPreviewMediaLoading(false);
        return;
      }
      console.warn("[auto-subtitle] preview media load", err);
      previewBridge.clearMedia();
      const errText = String(err?.message || err || "");
      const lenMismatch = /CONTENT_LENGTH_MISMATCH|length mismatch|미디어 파일이 비어/i.test(
        errText,
      );
      if (previewEmpty) {
        previewEmpty.hidden = false;
        previewEmpty.textContent = lenMismatch
          ? "미디어 파일이 손상되었거나 아직 생성 중입니다."
          : "미디어를 불러올 수 없습니다.";
      }
      if (useTranscribeShell) return;
      setPreviewMediaLoading(true, {
        title: "미리보기 불러오기 실패",
        message: lenMismatch
          ? "미디어 파일이 손상되었거나 아직 생성 중입니다.\nFFmpeg 보내기가 끝난 뒤 다시 열거나, 원본 영상 경로를 다시 선택해 주세요."
          : `${formatAgentConnectionError(err) || "미디어를 불러올 수 없습니다."}\nChrome 사이트 설정에서 「로컬 네트워크」를 허용했는지 확인해 주세요.`,
        showOk: true,
      });
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
  getPv()?.pause();
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

function restoreSession() {
  restoreSessionPreviewMediaPathFromStorage();
  const returningFromDownload = sessionStorage.getItem(STORAGE_RETURN_FROM_DL) === "1";
  if (returningFromDownload) {
    sessionStorage.removeItem(STORAGE_RETURN_FROM_DL);
    try {
      const snapRaw = sessionStorage.getItem(STORAGE_DL_RESTORE);
      sessionStorage.removeItem(STORAGE_DL_RESTORE);
      /** @type {ReturnType<typeof buildDownloadReturnSnapshot> | null} */
      let snapshot = null;
      if (snapRaw) {
        snapshot = JSON.parse(snapRaw);
      }

      const project = snapshot?.project;
      const vp =
        project?.videoPath || sessionStorage.getItem(STORAGE_VIDEO_PATH) || "";
      if (vp) {
        if (videoPathInput) videoPathInput.value = vp;
        sessionVideoPath = vp;
      }

      const previewFromSnap = String(snapshot?.previewMediaPath || "").trim();
      if (previewFromSnap) {
        setSessionPreviewMediaPath(previewFromSnap);
      }

      if (
        project &&
        (Number(project.version) >= 2 || Array.isArray(project.blocks))
      ) {
        subtitleHub.ingestFromProject(project, {
          cutRanges: Array.isArray(project.cutRanges) ? project.cutRanges : [],
          hardDeletedMediaSkips: Array.isArray(project.hardDeletedMediaSkips)
            ? project.hardDeletedMediaSkips
            : [],
        });
      } else {
        const raw = sessionStorage.getItem(STORAGE_CUES);
        const cutsRaw = sessionStorage.getItem(STORAGE_CUTS);
        if (raw) {
          const cues = JSON.parse(raw);
          const cuts = cutsRaw ? JSON.parse(cutsRaw) : [];
          subtitleHub.ingestFromProject(cues, { cutRanges: cuts });
        }
      }

      renderCuesTable(lastCues);
      if (resultsMeta) {
        resultsMeta.textContent = `${lastCues.length} cues`;
        resultsMeta.hidden = false;
      }

      downloadReturnRestoreMeta = {
        playback: snapshot?.playback,
        exportPath: snapshot?.exportPath || null,
      };
      downloadReturnRestorePending = true;
    } catch {
      /* ignore */
    }
    updateActionButtons();
    return;
  }

  downloadReturnRestorePending = false;
  downloadReturnRestoreMeta = null;

  try {
    sessionStorage.removeItem(STORAGE_CUES);
    sessionStorage.removeItem(STORAGE_CUTS);
    sessionStorage.removeItem(STORAGE_VIDEO_PATH);
    sessionStorage.removeItem(STORAGE_DL_RESTORE);
  } catch {
    /* ignore */
  }
  updateActionButtons();
}

/**
 * @returns {Promise<string | null>}
 */
async function resolveEditorPreviewMediaPath() {
  const cached = getSessionPreviewMediaPath();
  if (cached) return cached;
  if (!agentConnected || !sessionVideoPath) return null;
  try {
    return (await ensureSessionPreviewMediaPath()) || null;
  } catch {
    return null;
  }
}

/** 에이전트 연결·세션 복원 후 CFR preview 로드 + download 복귀 playhead 적용 */
async function ensureEditorPreviewMediaIfNeeded() {
  if (!agentConnected) return;
  if (!getPv() || getPv().src) return;
  if (!sessionVideoPath && !getSessionPreviewMediaPath()) return;
  const previewPath = await resolveEditorPreviewMediaPath();
  if (!previewPath) return;
  await updatePreview(previewPath);
  if (downloadReturnRestorePending) {
    await completeDownloadReturnRestore();
  }
}

btnPick?.addEventListener("click", () => void onPickLocalFile());

btnLoadProject?.addEventListener("click", async () => {
  try {
    await onLoadProject();
  } catch (err) {
    if (err?.name === "AbortError") return;
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

btnPreviewMediaLoadingOk?.addEventListener("click", () => {
  setPreviewMediaLoading(false);
});

btnUndo?.addEventListener("click", () => {
  if (subtitleHub.undo()) handleHubHistoryRestore();
});

btnRedo?.addEventListener("click", () => {
  if (subtitleHub.redo()) handleHubHistoryRestore();
});

btnHqPreview?.addEventListener("click", () => {
  void toggleHqPreviewMode();
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
  if (e.key === "Escape" && subtitleFindReplace.handleEscape()) return;
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
  if (!getPv()) return;
  if (toggleExpandedWordWaveformPlayback()) return;
  togglePreviewPlayback();
});

document.addEventListener("keydown", (e) => {
  if (!subtitleList || !lastCues.length) return;
  handleGlobalArrowKey(e, subtitleList, lastCues, buildSubtitleCardOpts(lastCues));
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Delete" || e.repeat) return;
  if (e.isComposing || e.defaultPrevented) return;
  if (!subtitleList || !lastCues.length) return;
  const target = e.target;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
  if (target instanceof HTMLSelectElement) return;
  if (isWordCaretKeyboardFocus()) return;
  if (checkedCueIndices.size === 0 && selectedCueIndex < 0) return;
  e.preventDefault();
  deleteSelectedSubtitleLines();
});

document.addEventListener("keydown", (e) => {
  if (subtitleFindReplace.handleKeydown(e)) return;
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const tag = e.target instanceof Element ? e.target.tagName : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === "z" && !e.shiftKey) {
    e.preventDefault();
    if (subtitleHub.undo()) handleHubHistoryRestore();
  } else if (e.key === "y" || (e.key === "z" && e.shiftKey)) {
    e.preventDefault();
    if (subtitleHub.redo()) handleHubHistoryRestore();
  }
});

btnFindReplace?.addEventListener("click", () => {
  subtitleFindReplace.open();
});

btnWordAutoAlign?.addEventListener("click", () => {
  void onWordAutoAlignClick();
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

function wirePreviewStackVideoEvents(videoEl) {
  if (!videoEl) return;
  videoEl.addEventListener("click", () => togglePreviewPlayback());
  videoEl.addEventListener("play", () => {
    if (!isHtmlAudioMasterActive()) startPlaybackLoop();
  });
  videoEl.addEventListener("timeupdate", () => {
    if (isHtmlAudioMasterActive()) return;
    if (videoEl.paused) return;
    const orch = getPlaybackOrchestrator();
    playheadSec = orch.mapMediaToEditSec(videoEl.currentTime);
    if (!playbackRafId) {
      applyThrottledVideoSkipCut(videoEl, getPlaybackSkipRanges());
      commitPlayheadUi();
    }
  });
  videoEl.addEventListener("pause", () => {
    if (userRequestedPreviewPause) stopPlaybackLoop();
  });
  videoEl.addEventListener("ended", () => stopPlaybackLoop());
  videoEl.addEventListener("seeked", () => {
    if (!isVideoPlaying) {
      const orch = getPlaybackOrchestrator();
      playheadSec = orch.mapMediaToEditSec(videoEl.currentTime);
      applyPlaybackSkipIfNeeded();
      commitPlayheadUi();
    }
  });
}

function wirePreviewStackAudioEvents(audioEl) {
  if (!audioEl) return;
  audioEl.addEventListener("seeked", () => {
    if (!isVideoPlaying) {
      const orch = getPlaybackOrchestrator();
      playheadSec = orch.mapMediaToEditSec(audioEl.currentTime);
      applyPlaybackSkipIfNeeded();
      commitPlayheadUi();
    }
  });
  audioEl.addEventListener("pause", () => {
    if (userRequestedPreviewPause && isHtmlAudioMasterActive()) stopPlaybackLoop();
  });
  audioEl.addEventListener("ended", () => {
    if (isHtmlAudioMasterActive()) stopPlaybackLoop();
  });
}

wirePreviewStackVideoEvents(previewVideoEl);
wirePreviewStackVideoEvents(document.getElementById("preview-video-b"));
wirePreviewStackAudioEvents(previewAudioEl);
wirePreviewStackAudioEvents(document.getElementById("preview-audio-b"));

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
syncWordAlignButtonState();

initWatermarkPositionGrid();

restoreSession();
updatePreviewOverlay();
updatePreviewWatermark();
updatePreviewTransportUi();

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
      await ensureEditorPreviewMediaIfNeeded();
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
  const step = data?.step || "";
  const detail = data?.detail || data?.message || "";
  setSetupLoading(true, {
    title: resolvePrepareModalTitle(step, detail, data?.phase || ""),
    step,
    message: resolvePrepareModalMessage(step, detail, data?.phase || "", data?.progress),
    progress: data?.progress,
  });
}

if (previewSection && typeof ResizeObserver !== "undefined") {
  const previewLayoutObserver = new ResizeObserver(() => {
    layoutPreviewMediaFrame();
    updatePreviewOverlay();
    updatePreviewWatermark();
  });
  previewLayoutObserver.observe(previewSection);
}
previewVideoEl?.addEventListener("loadeddata", () => {
  layoutPreviewMediaFrame();
  updatePreviewOverlay();
  updatePreviewWatermark();
});

void showAdSense("editorBelowExport", "#editor-ad-preview-pane");
void showAdSense("editorAboveWorkspace", "#editor-ad-subtitle-pane");

const subtitleFindReplace = initSubtitleFindReplace({
  getCues: () => lastCues,
  hasCues: () => lastCues.length > 0,
  getListContainer: () => subtitleList,
  captureEdits: () => {
    if (subtitleList) captureTextareaEditsIntoCues(subtitleList, lastCues);
  },
  applyChange: (updater) => {
    if (subtitleList) captureTextareaEditsIntoCues(subtitleList, lastCues);
    subtitleHub.applySubtitleChange(updater);
    renderCuesTable(lastCues);
    updatePreviewOverlay();
  },
  focusMatch: (match) => {
    const cueIndex = match.cueIndex;
    const cue = lastCues[cueIndex];
    selectCueLine(cueIndex, { scroll: false, seek: false, rerender: false });
    if (subtitleList) {
      scrollCueIntoView(subtitleList, lastCues, buildSubtitleCardOpts(lastCues), cueIndex, {
        behavior: "smooth",
      });
      const card = subtitleList.querySelector(`.subtitle-card[data-cue-index="${cueIndex}"]`);
      const ta = card?.querySelector(".subtitle-card-textarea");
      if (ta instanceof HTMLTextAreaElement) {
        ta.focus();
        const end = match.pos + match.len;
        ta.setSelectionRange(match.pos, end);
        const lineH = parseInt(getComputedStyle(ta).lineHeight, 10) || 20;
        const before = ta.value.slice(0, match.pos);
        const lines = before.split("\n").length - 1;
        ta.scrollTop = Math.max(0, lines * lineH - ta.clientHeight * 0.3);
        const layer = card.querySelector(".subtitle-find-text-layer");
        if (layer instanceof HTMLElement) {
          syncFindHighlightLayerToTextarea(layer, ta);
        }
      }
    }
    if (cue && getPv() && Number.isFinite(cue.start)) {
      seekPreviewToSourceSec(Number(cue.start), { commitUi: false });
    }
    commitPlayheadUi();
    if (subtitleList) {
      patchSelectedCueHighlight(subtitleList, selectedCueIndex, cueIndex);
    }
    selectedCueIndex = cueIndex;
  },
});

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

window.autoSubtitleSyncDiag = {
  enable(on = true) {
    syncDiagSetEnabled(on);
    console.log("[sync-diag]", on ? "recording ON — 재생 후 report()" : "recording OFF");
  },
  report() {
    const r = syncDiagReport();
    console.log("[sync-diag] classification", r.classification);
    return r;
  },
  clear: syncDiagClear,
};

window.autoSubtitleListOrderSnap = () => {
  const bridge = getPreviewMediaBridge();
  const stack = bridge.stack;
  const playing = Boolean(isVideoPlaying && isPreviewMediaPlaying());
  const segmentClips = getProgramSegmentTimelineClips();
  const previewClips = getListOrderPreviewClips();
  const clipPosHint = Math.max(
    listPlaybackClipPos >= 0 ? listPlaybackClipPos : -1,
    getListOrderPreviewClipPos(),
  );
  const stackClipPos = stack?.getClipPos?.() ?? -1;
  const clipPos = playing && stackClipPos >= 0 ? stackClipPos : clipPosHint;
  const clip =
    (playing && stack?.clips?.[clipPos]) ||
    segmentClips[clipPos] ||
    previewClips[clipPos] ||
    null;
  const snap = {
    playing,
    segmentPreview: isBlocksProgramSegmentPreview(),
    /** 재생 중에만 true — 일시정지면 false가 정상 */
    listMode: stack?.isListOrderMode?.() ?? false,
    seamlessActive: isListOrderSeamlessPlaybackActive(),
    previewTimelineActive: isListOrderPreviewTimelineActive(),
    stackClips: stack?.clips?.length ?? 0,
    previewClips: previewClips.length,
    segmentClips: segmentClips.length,
    clipPos,
    stackClipPos,
    listPlaybackClipPos,
    listPlaybackListPos,
    audioSec: bridge.audio?.currentTime ?? getPa()?.currentTime ?? null,
    clipMediaStart: clip?.mediaStart ?? null,
    clipMediaEnd: clip?.mediaEnd ?? null,
    clipBlockId: clip?.blockId ?? null,
    switchInFlight: stack?.switchInFlight ?? null,
    hint:
      playing
        ? "재생 중 — listMode true·stackClips>0 이어야 list-order stack 동작"
        : "일시정지 — listMode false·stackClips 0 은 정상. previewClips/segmentClips>0 이면 큐 데이터는 살아있음",
  };
  console.log("[list-order-snap]", snap);
  return snap;
};

window.autoSubtitleHighlightDiag = {
  get enabled() {
    return highlightDiagEnabled;
  },
  enable(on = true) {
    highlightDiagEnabled = Boolean(on);
    console.log(
      "[PLAY-HL]",
      highlightDiagEnabled
        ? "logging ON — 재생 시 cueChange/wordChange/이상 wordResolve 출력"
        : "logging OFF",
    );
  },
};

window.autoSubtitleCaretPlayDiag = {
  get enabled() {
    return caretPlayDiagIsEnabled();
  },
  enable(on = true) {
    caretPlayDiagSetEnabled(on);
    console.log(
      "[CARET-PLAY]",
      on
        ? "logging ON — 재생·캐럿·seek 경로 출력 (필터: CARET-PLAY)"
        : "logging OFF",
    );
  },
};

window.autoSubtitleMediaTimingDiag = {
  get enabled() {
    return mediaTimingDiagIsEnabled();
  },
  enable(on = true) {
    mediaTimingDiagSetEnabled(on);
    console.log(
      "[media-timing]",
      on
        ? "logging ON — probe·transcribe·A/V 스냅샷 출력 (필터: media-timing)"
        : "logging OFF",
    );
  },
};

window.autoSubtitleBurnInPipelineDiag = {
  get enabled() {
    return burnInPipelineDiagIsEnabled();
  },
  async enable(on = true) {
    burnInPipelineDiagSetEnabled(on);
    const sync = on ? await burnInPipelineDiagSyncAgent(TOOL_PREFIX, on) : { mode: "off" };
    console.log(
      "[BURN-IN-PIPE]",
      on
        ? sync.mode === "agent"
          ? "logging ON (FE+BE) — 보내기 1회 후 report() · autoSubtitleDownloadDiagLogs()"
          : "logging ON (FE) — BE는 prepare/finish/export에 pipeline_diag 전달. 에이전트 sync-source 또는 재시작 시 BE 전구간."
        : "logging OFF",
    );
    return sync;
  },
  report() {
    return burnInPipelineDiagReport();
  },
  get lastHandoff() {
    return burnInPipelineDiagGetLastHandoff();
  },
};

/**
 * 진단 로그 JSON 다운로드 — 켜진 채널(PLAY-HL / CARET-PLAY / media-timing / BURN-IN-PIPE)만 버퍼에 쌓임.
 * @param {string} [filename]
 * @param {{ includeSyncDiag?: boolean }} [opts]
 */
function autoSubtitleDownloadDiagLogs(filename, opts = {}) {
  const extra = {};
  if (opts.includeSyncDiag !== false) {
    try {
      extra.syncDiag = syncDiagReport();
    } catch {
      extra.syncDiag = null;
    }
  }
  if (burnInPipelineDiagIsEnabled()) {
    try {
      extra.burnInPipeline = burnInPipelineDiagReport();
    } catch {
      extra.burnInPipeline = null;
    }
  }
  const name =
    filename ||
    `auto-subtitle-diag-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  return downloadDiagLogsJson(name, extra);
}

window.autoSubtitleDownloadDiagLogs = autoSubtitleDownloadDiagLogs;
window.autoSubtitleDiagDownload = autoSubtitleDownloadDiagLogs;
window.autoSubtitleDiagExport = {
  download: autoSubtitleDownloadDiagLogs,
  clear() {
    diagLogBufferClear();
    console.log("[diag-export] buffer cleared");
  },
  get count() {
    return diagLogBufferLength();
  },
};
