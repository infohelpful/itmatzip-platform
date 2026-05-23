/** @type {Set<{ hide?: () => void }>} */
const activePanels = new Set();

export function registerWaveformPanel(panel) {
  if (panel) activePanels.add(panel);
}

export function unregisterWaveformPanel(panel) {
  activePanels.delete(panel);
}

/** renderSubtitleCards 직전 — document keydown 좀비 리스너 제거 */
export function disposeAllWaveformPanels() {
  for (const panel of activePanels) {
    panel.hide?.();
  }
  activePanels.clear();
}
