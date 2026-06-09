/**
 * V47c — export overlay scale SSOT (UI preview frame height 제외).
 * scale = renderH / videoNativeH
 */

/**
 * @param {number} renderH
 * @param {number} videoNativeH
 */
export function computeExportOverlayScale(renderH, videoNativeH) {
  const rh = Number(renderH);
  const nh = Number(videoNativeH);
  if (Number.isFinite(rh) && rh > 0 && Number.isFinite(nh) && nh > 0) {
    return rh / nh;
  }
  return 1;
}

/**
 * @param {object} style
 * @param {number} fullW
 * @param {number} fullH
 */
export function bindExportStyleVideoNative(style, fullW, fullH) {
  const w = Number(fullW);
  const h = Number(fullH);
  return {
    ...style,
    videoWidth: w > 0 ? w : style.videoWidth,
    videoHeight: h > 0 ? h : style.videoHeight,
  };
}
