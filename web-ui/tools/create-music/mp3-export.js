/**
 * 브라우저에서 AudioBuffer → MP3 (lamejs).
 * 설치된 에이전트에 download-mp3 API가 없을 때 폴백.
 */

/** @returns {Promise<typeof lamejs>} */
export async function loadLameJs() {
  if (globalThis.lamejs?.Mp3Encoder) return globalThis.lamejs;
  await new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-lamejs="1"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(undefined), { once: true });
      existing.addEventListener("error", () => reject(new Error("lamejs 로드 실패")), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js";
    s.async = true;
    s.dataset.lamejs = "1";
    s.onload = () => resolve(undefined);
    s.onerror = () => reject(new Error("lamejs 로드 실패"));
    document.head.appendChild(s);
  });
  if (!globalThis.lamejs?.Mp3Encoder) {
    throw new Error("lamejs 인코더를 사용할 수 없습니다.");
  }
  return globalThis.lamejs;
}

/** @param {Float32Array} float32 */
function floatTo16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * @param {AudioBuffer} audioBuffer
 * @param {number} [kbps]
 * @returns {Promise<Blob>}
 */
export async function encodeAudioBufferToMp3Blob(audioBuffer, kbps = 192) {
  const lamejs = await loadLameJs();
  const channels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const left = floatTo16(audioBuffer.getChannelData(0));
  const right = channels > 1 ? floatTo16(audioBuffer.getChannelData(1)) : left;
  const encoder = new lamejs.Mp3Encoder(channels, sampleRate, kbps);
  const block = 1152;
  const mp3Parts = [];

  for (let i = 0; i < left.length; i += block) {
    const lChunk = left.subarray(i, i + block);
    const rChunk = right.subarray(i, i + block);
    const buf = channels > 1 ? encoder.encodeBuffer(lChunk, rChunk) : encoder.encodeBuffer(lChunk);
    if (buf?.length) mp3Parts.push(new Uint8Array(buf));
  }

  const tail = encoder.flush();
  if (tail?.length) mp3Parts.push(new Uint8Array(tail));

  return new Blob(mp3Parts, { type: "audio/mpeg" });
}

/** @param {Blob} blob @param {string} filename */
export function triggerBlobDownload(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
