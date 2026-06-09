/**
 * 재생 싱크 진단 — Whisper word boundary vs playback clock 분리.
 * 콘솔: autoSubtitleSyncDiag.enable(true) → 재생 → autoSubtitleSyncDiag.report()
 */

/** @typedef {object} SyncDiagSample
 * @property {number} wallMs
 * @property {number} audioSec
 * @property {number | null} videoSec
 * @property {number} wordClockSec
 * @property {number | null} playheadEditSec
 * @property {number} cueIndex
 * @property {number} wordIndex
 * @property {string} wordText
 * @property {number | null} wordStart
 * @property {number | null} wordEnd
 * @property {number | null} audioMinusWordStart
 * @property {number | null} videoLagSec
 * @property {boolean} stackClock
 * @property {boolean} htmlAudioMaster
 * @property {number | null} avScale
 * @property {string | null} previewPath
 */

let enabled = false;
/** @type {SyncDiagSample[]} */
const samples = [];
let lastSampleWallMs = 0;
const SAMPLE_INTERVAL_MS = 400;
const MAX_SAMPLES = 800;

/** @param {boolean} on */
export function syncDiagSetEnabled(on) {
  enabled = Boolean(on);
  if (enabled) samples.length = 0;
}

export function syncDiagIsEnabled() {
  return enabled;
}

/**
 * @param {Partial<SyncDiagSample> & { audioSec?: number, wordClockSec?: number }} row
 */
export function syncDiagSample(row) {
  if (!enabled) return;
  const wall = performance.now();
  if (wall - lastSampleWallMs < SAMPLE_INTERVAL_MS) return;
  lastSampleWallMs = wall;

  const audioSec = Number(row.audioSec);
  const wordStart = row.wordStart != null ? Number(row.wordStart) : null;
  const videoSec = row.videoSec != null ? Number(row.videoSec) : null;

  /** @type {SyncDiagSample} */
  const s = {
    wallMs: wall,
    audioSec: Number.isFinite(audioSec) ? audioSec : 0,
    videoSec: Number.isFinite(videoSec) ? videoSec : null,
    wordClockSec: Number(row.wordClockSec) || 0,
    playheadEditSec: row.playheadEditSec != null ? Number(row.playheadEditSec) : null,
    cueIndex: Number(row.cueIndex) || -1,
    wordIndex: Number(row.wordIndex) || -1,
    wordText: String(row.wordText || ""),
    wordStart: Number.isFinite(wordStart) ? wordStart : null,
    wordEnd: row.wordEnd != null ? Number(row.wordEnd) : null,
    audioMinusWordStart:
      Number.isFinite(wordStart) && Number.isFinite(audioSec)
        ? audioSec - wordStart
        : null,
    videoLagSec:
      Number.isFinite(videoSec) && Number.isFinite(audioSec)
        ? videoSec - audioSec
        : null,
    stackClock: Boolean(row.stackClock),
    htmlAudioMaster: Boolean(row.htmlAudioMaster),
    avScale: row.avScale != null ? Number(row.avScale) : null,
    previewPath: row.previewPath != null ? String(row.previewPath) : null,
  };
  samples.push(s);
  if (samples.length > MAX_SAMPLES) samples.shift();
}

function median(nums) {
  const arr = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function stddev(nums) {
  const arr = nums.filter((n) => Number.isFinite(n));
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((acc, n) => acc + (n - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}

/** @param {SyncDiagSample[]} rows */
function classifySyncIssue(rows) {
  if (!rows.length) {
    return {
      verdict: "no_samples",
      hint: "재생 중 autoSubtitleSyncDiag.enable(true) 후 report() 호출",
    };
  }

  const clockDeltas = rows
    .map((r) => r.wordClockSec - r.audioSec)
    .filter((d) => Math.abs(d) < 5);
  const wordOffsets = rows
    .map((r) => r.audioMinusWordStart)
    .filter((v) => v != null && Math.abs(v) < 8);
  const videoLags = rows.map((r) => r.videoLagSec).filter((v) => v != null);

  const clockMed = median(clockDeltas);
  const clockStd = stddev(clockDeltas);
  const wordMed = median(wordOffsets);
  const wordStd = stddev(wordOffsets);
  const videoLagMed = median(videoLags);

  /** wordClock ≠ audio → 재생 클럭/매핑 문제 */
  if (Math.abs(clockMed ?? 0) > 0.03 || clockStd > 0.05) {
    return {
      verdict: "playback_clock",
      clockMed,
      clockStd,
      wordMed,
      wordStd,
      videoLagMed,
      hint: "wordClock과 audio.currentTime 불일치 — media-timing 매핑·stack clock·preview 경로 확인",
    };
  }

  /** audio는 word.start 근처인데 chip이 늦/�빠 → Whisper/RMS/leading-split 경계 */
  if (Math.abs(wordMed ?? 0) > 0.12 || wordStd > 0.2) {
    return {
      verdict: "word_boundary",
      clockMed,
      clockStd,
      wordMed,
      wordStd,
      videoLagMed,
      hint: "재생 시계는 맞는데 word.start/end가 음성과 어긋남 — rms_vad_align·leading silence split·Whisper 경계",
    };
  }

  return {
    verdict: "ok_or_subtle",
    clockMed,
    clockStd,
    wordMed,
    wordStd,
    videoLagMed,
    hint: "클럭·경계 모두 ±120ms 이내 — 체감 오차면 hint/wi lag 또는 UI 스로틀",
  };
}

export function syncDiagReport() {
  const rows = samples.slice();
  const classification = classifySyncIssue(rows);
  return {
    capturedAt: new Date().toISOString(),
    sampleCount: rows.length,
    classification,
    samples: rows,
  };
}

export function syncDiagClear() {
  samples.length = 0;
  lastSampleWallMs = 0;
}
