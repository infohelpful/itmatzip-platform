/**
 * AutoSubtitle src/shared/waveformJson.ts — Peaks JSON 타입·배열 추출.
 */

/**
 * @typedef {object} JsonWaveformData
 * @property {number} [sample_rate]
 * @property {number} [samples_per_pixel]
 * @property {number} [bits]
 * @property {number} [length]
 * @property {number[]} [data]
 * @property {Array<{ data?: number[] }>} [channels]
 */

/**
 * @typedef {object} AgentPeaksPayload
 * @property {number} duration_sec
 * @property {number} timeline_sec
 * @property {number} column_count
 * @property {number[]} peaks
 * @property {number[]} [peaks_db]
 * @property {number} [mean_volume_db]
 * @property {boolean} [from_cache]
 */

/**
 * @param {JsonWaveformData | AgentPeaksPayload | null | undefined} json
 * @returns {'agent-columns' | 'audiowaveform-minmax' | null}
 */
export function detectPeaksFormat(json) {
  if (json == null || typeof json !== "object") return null;
  const raw = /** @type {JsonWaveformData & { peaks_engine?: string }} */ (json);

  if (raw.peaks_engine === "audiowaveform") {
    if (Array.isArray(raw.data) && raw.data.length >= 4) return "audiowaveform-minmax";
    const ch0 = raw.channels?.[0]?.data;
    if (Array.isArray(ch0) && ch0.length >= 4) return "audiowaveform-minmax";
  }

  if (Array.isArray(raw.data) && raw.data.length >= 4) return "audiowaveform-minmax";
  const ch0 = raw.channels?.[0]?.data;
  if (Array.isArray(ch0) && ch0.length >= 4) return "audiowaveform-minmax";

  if (Array.isArray(json.peaks) && json.peaks.length >= 2) return "agent-columns";
  return null;
}

/**
 * @param {JsonWaveformData} json
 * @returns {number[] | null}
 */
export function getAudiowaveformDataArray(json) {
  const raw = json;
  if (Array.isArray(raw.data) && raw.data.length > 0) return raw.data;
  const ch0 = raw.channels?.[0]?.data;
  if (Array.isArray(ch0) && ch0.length > 0) return ch0;
  return null;
}
