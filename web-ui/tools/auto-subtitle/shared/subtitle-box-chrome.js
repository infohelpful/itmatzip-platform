/**
 * AutoSubtitle subtitleBoxChrome.ts — 미리보기 박스 스타일.
 */

export function getSubtitleBoxChromeInline(fontSizePx, paddingPct = 100) {
  const scale = Math.max(30, Math.min(150, paddingPct)) / 100;
  const baseY = Math.max(4, Math.round((fontSizePx * 5) / 16));
  const baseX = Math.max(8, Math.round((fontSizePx * 9.5) / 16));
  const scaledY = Math.round(baseY * scale);
  const scaledX = Math.round(baseX * scale);
  const padY = Math.max(scaledY, Math.ceil(fontSizePx * 0.13));
  const padX = Math.max(scaledX, Math.ceil(fontSizePx * 0.2));
  return {
    padding: `${padY}px ${padX}px`,
    lineHeight: 1.38,
    borderRadius: 8,
    border: "1px solid rgba(255, 255, 255, 0.1)",
    boxSizing: "border-box",
  };
}
