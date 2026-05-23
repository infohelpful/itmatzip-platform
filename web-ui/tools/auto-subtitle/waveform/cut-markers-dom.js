/**
 * AutoSubtitle createCutPreviewSegmentMarker / createCutToolPointMarker — DOM 오버레이.
 */

export const CUT_TOOL_POINT_ID = "autosub-cut-marker";

/**
 * @param {HTMLElement} host
 */
export class WaveformCutMarkersOverlay {
  /**
   * @param {HTMLElement} host position:relative 컨테이너
   */
  constructor(host) {
    this.host = host;
    this.preview = document.createElement("div");
    this.preview.className = "line-wf-cut-preview";
    this.preview.hidden = true;
    this.point = document.createElement("div");
    this.point.className = "line-wf-cut-point";
    this.point.hidden = true;
    this.point.dataset.cutId = CUT_TOOL_POINT_ID;
    const pointLine = document.createElement("div");
    pointLine.className = "line-wf-cut-point-line";
    const pointTip = document.createElement("span");
    pointTip.className = "line-wf-cut-point-tip";
    this.point.append(pointLine, pointTip);
    this._pointTip = pointTip;
    host.append(this.preview, this.point);
  }

  /**
   * @param {number | null} x0 css px
   * @param {number | null} x1
   */
  setCutPreview(x0, x1) {
    if (x0 == null || x1 == null || Math.abs(x1 - x0) < 2) {
      this.preview.hidden = true;
      return;
    }
    const left = Math.min(x0, x1);
    const width = Math.abs(x1 - x0);
    this.preview.style.left = `${left}px`;
    this.preview.style.width = `${width}px`;
    this.preview.hidden = false;
  }

  clearCutPreview() {
    this.preview.hidden = true;
  }

  /**
   * @param {number | null} x css px
   * @param {string} [timeLabel]
   */
  setCutPoint(x, timeLabel = "") {
    if (x == null || !Number.isFinite(x)) {
      this.point.hidden = true;
      return;
    }
    this.point.style.left = `${x}px`;
    this._pointTip.textContent = timeLabel;
    this.point.hidden = false;
  }

  clearCutPoint() {
    this.point.hidden = true;
  }

  destroy() {
    this.preview.remove();
    this.point.remove();
  }
}
