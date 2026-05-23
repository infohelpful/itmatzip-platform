/**
 * AutoSubtitle WaveformWordConnector.tsx — 칩↔파형 세로 연결선 (SVG).
 */

/**
 * @param {SVGSVGElement} svg
 * @param {Array<{ x1: number, x2: number, y1: number, y2: number, active?: boolean }>} segments
 */
export function paintConnectorSegments(svg, segments) {
  if (!svg) return;
  const w = svg.clientWidth || svg.parentElement?.clientWidth || 0;
  const h = svg.clientHeight || svg.parentElement?.clientHeight || 0;
  if (w < 1 || h < 1) return;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.innerHTML = "";

  const stroke = "rgba(148, 163, 184, 0.55)";
  const strokeActive = "rgba(251, 191, 36, 0.75)";

  for (const seg of segments) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(seg.x1));
    line.setAttribute("x2", String(seg.x2));
    line.setAttribute("y1", String(seg.y1));
    line.setAttribute("y2", String(seg.y2));
    line.setAttribute("stroke", seg.active ? strokeActive : stroke);
    line.setAttribute("stroke-width", seg.active ? "1.5" : "1");
    if (!seg.active) line.setAttribute("stroke-dasharray", "3 3");
    svg.appendChild(line);
  }
}

/**
 * @param {HTMLElement} stage
 * @param {HTMLElement} chipsRow
 * @param {HTMLElement} canvasWrap
 * @param {(t: number) => number} mediaSecToX
 */
export function syncWordConnectorFromDom(stage, chipsRow, canvasWrap, mediaSecToX) {
  const svg = stage.querySelector(".line-wf-connector, .subwave-connector");
  if (!(svg instanceof SVGSVGElement)) return;
  const stageRect = stage.getBoundingClientRect();
  const wrapRect = canvasWrap.getBoundingClientRect();
  const chipsRect = chipsRow.getBoundingClientRect();
  const chipBottomY = chipsRect.bottom - stageRect.top;
  const boxTopY = wrapRect.top - stageRect.top;
  const wrapLeft = wrapRect.left - stageRect.left;

  /** @type {Array<{ x1: number, x2: number, y1: number, y2: number, active?: boolean }>} */
  const segments = [];
  chipsRow.querySelectorAll(".subtitle-wf-ctx-chip:not(.subtitle-wf-ctx-chip--empty)").forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    const start = Number(el.dataset.wordStart);
    const end = Number(el.dataset.wordEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    segments.push({
      x1: wrapLeft + mediaSecToX(start),
      x2: wrapLeft + mediaSecToX(end),
      y1: chipBottomY,
      y2: boxTopY,
      active: el.classList.contains("is-selected"),
    });
  });

  paintConnectorSegments(svg, segments);
}

/**
 * 카드 활성 칩 하단 좌·우 → 파형 박스 상단 트림 위치.
 *
 * @param {HTMLElement} stage
 * @param {HTMLElement} card
 * @param {HTMLElement} canvasWrap
 * @param {(t: number) => number} timeToX canvas 내부 x (0..width)
 * @param {{ chipLeft: number, chipRight: number, trimStartX: number, trimEndX: number, boxTopY: number, chipBottomY: number } | null} [frozen]
 * @param {{ trimStart: number, trimEnd: number }} [opts]
 * @returns {{ chipLeft: number, chipRight: number, trimStartX: number, trimEndX: number, boxTopY: number, chipBottomY: number } | null}
 */
export function syncWaveformConnectorFromCard(
  stage,
  card,
  canvasWrap,
  timeToX,
  frozen = null,
  opts = {},
) {
  const svg = stage.querySelector(".subwave-connector, .line-wf-connector");
  if (!(svg instanceof SVGSVGElement)) return null;

  const stageRect = stage.getBoundingClientRect();
  const wrapRect = canvasWrap.getBoundingClientRect();
  const boxTopY = wrapRect.top - stageRect.top;
  const wrapLeft = wrapRect.left - stageRect.left;

  let chipLeft;
  let chipRight;
  let chipBottomY;
  let trimStartX;
  let trimEndX;

  if (frozen) {
    chipLeft = frozen.chipLeft;
    chipRight = frozen.chipRight;
    chipBottomY = frozen.chipBottomY;
    trimStartX = frozen.trimStartX;
    trimEndX = frozen.trimEndX;
  } else {
    const chip =
      card.querySelector('[data-waveform-active-word-chip="1"]') ||
      card.querySelector(".subtitle-word-chip.is-selected");
    if (!(chip instanceof HTMLElement)) return null;
    const chipRect = chip.getBoundingClientRect();
    chipLeft = chipRect.left - stageRect.left;
    chipRight = chipRect.right - stageRect.left;
    chipBottomY = chipRect.bottom - stageRect.top;
    trimStartX = wrapLeft + timeToX(opts.trimStart ?? 0);
    trimEndX = wrapLeft + timeToX(opts.trimEnd ?? 0);
  }

  paintConnectorSegments(svg, [
    { x1: chipLeft, x2: trimStartX, y1: chipBottomY, y2: boxTopY, active: true },
    { x1: chipRight, x2: trimEndX, y1: chipBottomY, y2: boxTopY, active: true },
  ]);

  if (frozen) return frozen;
  return { chipLeft, chipRight, trimStartX, trimEndX, boxTopY, chipBottomY };
}
