/**
 * 자막 카드 UI — virtual-scroll-list 재export.
 */
export {
  renderSubtitleCards,
  readCuesFromCards,
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
} from "./subtitle-list/virtual-scroll-list.js?v=56";
export {
  requestFocusCaretDeferred,
  syncPlaybackCaretVisibility,
  clearListPlayFromCaretPreferred,
  prepareRowCaretAfterCueSplit,
  finalizeRowCaretAfterCueSplit,
} from "./subtitle-list/word-caret-ui.js?v=44";
