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
  requestFocusCaret,
} from "./subtitle-list/virtual-scroll-list.js?v=54";
export {
  requestFocusCaretDeferred,
  syncPlaybackCaretVisibility,
  clearListPlayFromCaretPreferred,
} from "./subtitle-list/word-caret-ui.js?v=40";
