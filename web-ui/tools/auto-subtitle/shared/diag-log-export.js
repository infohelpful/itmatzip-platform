/**
 * 진단 채널 로그 버퍼 + JSON 다운로드.
 * 콘솔: autoSubtitleDownloadDiagLogs()
 */

const MAX_ENTRIES = 4000;

/** @type {Array<{ wallMs: number, iso: string, channel: string, level: string, event: string, payload: unknown }>} */
const buffer = [];

/**
 * @param {string} channel
 * @param {"log" | "warn"} level
 * @param {string} event
 * @param {unknown} [payload]
 */
export function diagLogBufferPush(channel, level, event, payload) {
  buffer.push({
    wallMs: performance.now(),
    iso: new Date().toISOString(),
    channel,
    level,
    event,
    payload: payload ?? {},
  });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

export function diagLogBufferClear() {
  buffer.length = 0;
}

export function diagLogBufferLength() {
  return buffer.length;
}

/**
 * @param {Record<string, unknown>} [extra]
 */
export function buildDiagLogExport(extra = {}) {
  return {
    exportedAt: new Date().toISOString(),
    entryCount: buffer.length,
    entries: buffer.slice(),
    ...extra,
  };
}

/**
 * @param {string} [filename]
 * @param {Record<string, unknown>} [extra]
 */
export function downloadDiagLogsJson(
  filename = `auto-subtitle-diag-${Date.now()}.json`,
  extra = {},
) {
  const payload = buildDiagLogExport(extra);
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  console.log("[diag-export] downloaded", filename, `entries=${payload.entryCount}`);
  return payload;
}
