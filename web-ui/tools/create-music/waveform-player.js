/**
 * Create Music — 단일 트랙 파형 플레이어 (생성 진행 오버레이 포함)
 */
import { WaveformRenderer, formatWaveformTimeLabel } from "../silence-remover/waveform-renderer.js";

const PLAYER_COLORS = {
  background: "#1a2744",
  waveform: "rgba(124, 156, 255, 0.92)",
  baseline: "rgba(180, 200, 255, 0.35)",
};

function formatClock(sec) {
  return formatWaveformTimeLabel(sec);
}

/**
 * @param {{ getAgentOrigin: () => string, fetchAgent?: typeof fetch }} deps
 */
export function createMusicWaveformPlayer(deps) {
  const root = document.getElementById("music-player");
  const canvas = /** @type {HTMLCanvasElement | null} */ (document.getElementById("music-wave-canvas"));
  const overlay = document.getElementById("music-player-overlay");
  const overlayMsg = document.getElementById("music-player-overlay-msg");
  const overlayBar = document.getElementById("music-player-progress-bar");
  const overlayPct = document.getElementById("music-player-overlay-pct");
  const btnPlay = /** @type {HTMLButtonElement | null} */ (document.getElementById("music-btn-play"));
  const timeCurrent = document.getElementById("music-time-current");
  const timeTotal = document.getElementById("music-time-total");
  const statusEl = document.getElementById("music-player-status");
  const waveWrap = document.querySelector(".music-player__wave-wrap");
  const playhead = document.getElementById("music-playhead");
  const playheadTime = document.getElementById("music-playhead-time");

  /** @type {WaveformRenderer | null} */
  let renderer = null;
  /** @type {AudioContext | null} */
  let audioContext = null;
  /** @type {AudioBuffer | null} */
  let audioBuffer = null;
  /** @type {AudioBufferSourceNode | null} */
  let sourceNode = null;
  let gainNode = null;
  let playing = false;
  let playStartCtx = 0;
  let playOffsetSec = 0;
  let durationSec = 0;
  let rafId = 0;
  let currentJobId = "";
  let currentFilename = "";
  let currentAudioUrl = "";
  let playbackEndedCb = null;
  let isGenerating = false;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function setPlayEnabled(on) {
    if (btnPlay) btnPlay.disabled = !on;
  }

  function canvasWidth() {
    const w = waveWrap?.clientWidth ?? canvas?.parentElement?.clientWidth ?? 640;
    return Math.max(280, w - 8);
  }

  function setEmptyVisual(on) {
    root?.classList.toggle("is-empty", on);
    if (canvas) canvas.hidden = on;
    if (playhead) {
      playhead.hidden = on;
      playhead.setAttribute("aria-hidden", on ? "true" : "false");
    }
  }

  function updatePlayhead(sec) {
    if (!playhead || durationSec <= 0) return;
    const wrapW = waveWrap?.clientWidth ?? canvasWidth();
    const pct = Math.max(0, Math.min(1, sec / durationSec));
    playhead.style.left = `${pct * wrapW}px`;
    if (playheadTime) playheadTime.textContent = formatClock(sec);
    if (timeCurrent) timeCurrent.textContent = formatClock(sec);
  }

  function redraw() {
    if (!canvas || !renderer) return;
    const w = canvasWidth();
    const h = 120;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const pxPerSec = WaveformRenderer.pxPerSecFit(renderer.durationSec, w);
    renderer.render(canvas, {
      pxPerSec,
      scrollLeftPx: 0,
      canvasWidth: w,
      canvasHeight: h,
      showRuler: false,
      flattenSilence: true,
    }, PLAYER_COLORS);
    updatePlayhead(currentTimeSec());
  }

  function stopPlayback() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    try {
      sourceNode?.stop();
    } catch {
      /* already stopped */
    }
    sourceNode = null;
    playing = false;
    if (btnPlay) btnPlay.textContent = "▶";
  }

  function currentTimeSec() {
    if (!playing || !audioContext) return playOffsetSec;
    return Math.min(durationSec, playOffsetSec + (audioContext.currentTime - playStartCtx));
  }

  function updateTransport() {
    const t = currentTimeSec();
    updatePlayhead(t);
    if (playing) rafId = requestAnimationFrame(updateTransport);
  }

  function onPlaybackEnded() {
    stopPlayback();
    playOffsetSec = 0;
    updatePlayhead(0);
    setStatus("재생 완료");
    if (typeof playbackEndedCb === "function") playbackEndedCb();
  }

  function startPlayback(fromSec = 0) {
    if (!audioBuffer || !audioContext) return;
    stopPlayback();
    playOffsetSec = Math.max(0, Math.min(fromSec, durationSec));
    sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = audioBuffer;
    gainNode = audioContext.createGain();
    sourceNode.connect(gainNode);
    gainNode.connect(audioContext.destination);
    sourceNode.onended = () => {
      if (playing && currentTimeSec() >= durationSec - 0.05) onPlaybackEnded();
    };
    sourceNode.start(0, playOffsetSec);
    playStartCtx = audioContext.currentTime;
    playing = true;
    if (btnPlay) btnPlay.textContent = "⏸";
    setStatus("재생 중");
    updateTransport();
  }

  function togglePlay() {
    if (!audioBuffer) return;
    if (playing) {
      playOffsetSec = currentTimeSec();
      stopPlayback();
      setStatus("일시정지");
      return;
    }
    startPlayback(playOffsetSec);
  }

  function seekFromClick(clientX) {
    if (!waveWrap || !audioBuffer || durationSec <= 0) return;
    const rect = waveWrap.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const target = pct * durationSec;
    if (playing) {
      startPlayback(target);
    } else {
      playOffsetSec = target;
      updatePlayhead(target);
    }
  }

  async function loadFromUrl(jobId, filename, audioUrl) {
    currentJobId = jobId;
    currentFilename = filename;
    currentAudioUrl = audioUrl;
    setPlayEnabled(false);
    setStatus("오디오 불러오는 중…");
    stopPlayback();

    const fetchFn = deps.fetchAgent || fetch;
    const res = await fetchFn(audioUrl);
    if (!res.ok) throw new Error("오디오를 불러올 수 없습니다.");
    const data = await res.arrayBuffer();

    if (!audioContext) audioContext = new AudioContext();
    if (audioContext.state === "suspended") await audioContext.resume();
    audioBuffer = await audioContext.decodeAudioData(data.slice(0));
    durationSec = audioBuffer.duration;
    renderer = new WaveformRenderer({ audioBuffer });
    hideGenerating();
    setEmptyVisual(false);
    if (playhead) playhead.hidden = false;
    redraw();
    if (timeTotal) timeTotal.textContent = formatClock(durationSec);
    updatePlayhead(0);
    setPlayEnabled(true);
    setStatus("▶ 버튼을 눌러 재생하세요");
    return { jobId, filename, audioUrl };
  }

  function hidePlayhead() {
    if (!playhead) return;
    playhead.hidden = true;
    playhead.setAttribute("aria-hidden", "true");
  }

  function showGenerating(progress, message) {
    isGenerating = true;
    stopPlayback();
    hidePlayhead();
    root?.classList.add("is-generating");
    if (overlay) {
      overlay.hidden = false;
      overlay.removeAttribute("hidden");
    }
    const pct = Math.max(0, Math.min(100, Number(progress) || 0));
    if (overlayBar) overlayBar.style.width = `${pct}%`;
    if (overlayPct) overlayPct.textContent = `${Math.round(pct)}%`;
    if (overlayMsg) overlayMsg.textContent = message || "음악 생성 중…";
    setPlayEnabled(false);
  }

  function hideGenerating() {
    isGenerating = false;
    root?.classList.remove("is-generating");
    if (overlay) {
      overlay.hidden = true;
      overlay.setAttribute("hidden", "");
    }
  }

  function resetIdle() {
    hideGenerating();
    stopPlayback();
    audioBuffer = null;
    renderer = null;
    durationSec = 0;
    playOffsetSec = 0;
    currentJobId = "";
    currentFilename = "";
    currentAudioUrl = "";
    setEmptyVisual(true);
    if (timeCurrent) timeCurrent.textContent = formatClock(0);
    if (timeTotal) timeTotal.textContent = formatClock(0);
    setPlayEnabled(false);
    setStatus("");
  }

  btnPlay?.addEventListener("click", togglePlay);
  canvas?.addEventListener("click", (ev) => seekFromClick(ev.clientX));
  waveWrap?.addEventListener("click", (ev) => {
    if (ev.target === canvas || ev.target === waveWrap) seekFromClick(ev.clientX);
  });

  window.addEventListener("resize", () => {
    if (renderer && !isGenerating) redraw();
  });

  resetIdle();

  return {
    resetIdle,
    showGenerating,
    hideGenerating,
    loadFromUrl,
    getCurrentTrack() {
      return { jobId: currentJobId, filename: currentFilename, audioUrl: currentAudioUrl };
    },
    getAudioBuffer() {
      return audioBuffer;
    },
    onPlaybackEnded(cb) {
      playbackEndedCb = cb;
    },
  };
}
