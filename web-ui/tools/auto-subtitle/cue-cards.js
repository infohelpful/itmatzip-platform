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
  updatePlaybackHighlights,
  resetPlaybackHighlightCache,
  requestFocusCaret,
} from "./subtitle-list/virtual-scroll-list.js?v=47";
export {
  tryHandleCaretSpaceKey,
  requestFocusCaretDeferred,
} from "./subtitle-list/word-caret-ui.js?v=35";
