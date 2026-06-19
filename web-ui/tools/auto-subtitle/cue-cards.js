/**
 * 자막 카드 UI — virtual-scroll-list 재export.
 */
export {
  renderSubtitleCards,
  readCuesFromCards,
  captureTextareaEditsIntoCues,
  captureTextareaForCue,
  scrollCueIntoView,
  syncExpandedPanelPlayhead,
  refreshExpandedPanelSkipRanges,
  finishExpandedPanelRangePlay,
  toggleExpandedPanelPlayFromCut,
  getExpandedPanelCutEditSec,
  updatePlaybackHighlights,
  resetPlaybackHighlightCache,
  patchSelectedCueHighlight,
  requestFocusCaret,
  refreshWaveformPanelAfterTrim,
  refreshCueWaveformPanelAfterLineEndTrim,
  syncOpenCueWaveformPanel,
} from "./subtitle-list/virtual-scroll-list.js?v=111";
export {
  requestFocusCaretDeferred,
  syncPlaybackCaretVisibility,
  clearListPlayFromCaretPreferred,
  prepareRowCaretAfterCueSplit,
  finalizeRowCaretAfterCueSplit,
  hintActiveCaretCardIndex,
} from "./subtitle-list/word-caret-ui.js?v=64";
