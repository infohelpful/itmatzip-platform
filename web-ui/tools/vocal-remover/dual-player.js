/**

 * MR(음악) + 보컬 스템 파형·동기 재생.

 */



import { WaveformRenderer } from "../silence-remover/waveform-renderer.js";



const MUSIC_COLORS = {

  background: "#1e4d38",

  waveform: "rgba(120, 255, 190, 0.92)",

  baseline: "rgba(200, 255, 230, 0.35)",

};



const VOCAL_COLORS = {

  background: "#2d2858",

  waveform: "rgba(200, 170, 255, 0.92)",

  baseline: "rgba(220, 210, 255, 0.35)",

};



const CANVAS_H = 132;

const WAVEFORM_WIDTH_MAX = 34000;



function itzT(key, fallback) {
  return typeof window.itzT === "function" ? window.itzT(key, fallback) : fallback;
}

function itzTf(key, fallback, vars) {
  try {
    const api = window.ITZ_I18N;
    if (api && typeof api.tf === "function") {
      const v = api.tf(key, vars);
      if (v && v !== key) return v;
    }
  } catch {
    /* ignore */
  }
  let s = fallback;
  if (vars) {
    Object.keys(vars).forEach((k) => {
      s = String(s).split(`{${k}}`).join(String(vars[k] == null ? "" : vars[k]));
    });
  }
  return s;
}

function formatClock(sec) {

  if (!Number.isFinite(sec) || sec < 0) return "0:00.0";

  const m = Math.floor(sec / 60);

  const s = sec % 60;

  return `${m}:${s.toFixed(1).padStart(4, "0")}`;

}



function agentDownloadUrl(getAgentOrigin, filePath) {

  return `${getAgentOrigin()}/api/tools/vocal-remover/download?file_path=${encodeURIComponent(filePath)}`;

}



/**

 * @param {{

 *   requestAgent: (opts: object) => Promise<object>,

 *   getAgentOrigin: () => string,

 *   fetchAgent: (url: string, init?: RequestInit) => Promise<Response>,

 * }} deps

 */

export function createVocalDualPlayer(deps) {

  const section = document.getElementById("dual-waveform-section");

  const canvasMusic = /** @type {HTMLCanvasElement | null} */ (document.getElementById("wave-music"));

  const canvasVocal = /** @type {HTMLCanvasElement | null} */ (document.getElementById("wave-vocal"));

  const volMusic = /** @type {HTMLInputElement | null} */ (document.getElementById("vol-music"));

  const volVocal = /** @type {HTMLInputElement | null} */ (document.getElementById("vol-vocal"));

  const labelMusic = document.getElementById("music-file-label");

  const labelVocal = document.getElementById("vocal-file-label");

  const playhead = document.getElementById("playhead");

  const playheadTime = document.getElementById("playhead-time");

  const stackEl = document.getElementById("dual-waveform-stack");

  const btnPlay = document.getElementById("btn-play-pause");

  const timeCurrent = document.getElementById("time-current");

  const timeTotal = document.getElementById("time-total");



  /** @type {WaveformRenderer | null} */

  let rendererMusic = null;

  /** @type {WaveformRenderer | null} */

  let rendererVocal = null;

  let durationSec = 0;

  let instrumentalPath = "";

  let vocalsPath = "";

  let hasStems = false;
  let lastPickBase = "";
  let labelPhase = "wait";

  function applyStemLabels() {
    const base = lastPickBase;
    if (labelPhase === "done") {
      if (labelMusic) labelMusic.textContent = base ? itzTf("musicDoneNamed", `${base} · MR`, { name: base }) : "MR";
      if (labelVocal) labelVocal.textContent = base ? itzTf("vocalDoneNamed", `${base} · 보컬`, { name: base }) : itzT("stemVocal", "보컬");
      return;
    }
    if (labelPhase === "separating") {
      if (labelMusic) labelMusic.textContent = base ? itzTf("musicSepNamed", `${base} · MR (분리 중)`, { name: base }) : itzT("musicWait", "MR (분리 대기)");
      if (labelVocal) labelVocal.textContent = base ? itzTf("vocalSepNamed", `${base} · 보컬 (분리 중)`, { name: base }) : itzT("vocalWait", "보컬 (분리 대기)");
      return;
    }
    if (labelMusic) labelMusic.textContent = base ? itzTf("musicWaitNamed", `${base} · MR (분리 대기)`, { name: base }) : itzT("musicWait", "MR (분리 대기)");
    if (labelVocal) labelVocal.textContent = base ? itzTf("vocalWaitNamed", `${base} · 보컬 (분리 대기)`, { name: base }) : itzT("vocalWait", "보컬 (분리 대기)");
  }




  let audioContext = null;

  /** @type {AudioBuffer | null} */

  let bufferMusic = null;

  /** @type {AudioBuffer | null} */

  let bufferVocal = null;

  /** @type {AudioBufferSourceNode | null} */

  let sourceMusic = null;

  /** @type {AudioBufferSourceNode | null} */

  let sourceVocal = null;

  let gainMusic = null;

  let gainVocal = null;

  let playing = false;

  let playStartCtxTime = 0;

  let playOffsetSec = 0;

  let rafId = 0;



  function resetVolumes() {

    if (volMusic) volMusic.value = "100";

    if (volVocal) volVocal.value = "0";

    if (gainMusic) gainMusic.gain.value = 1;

    if (gainVocal) gainVocal.gain.value = 0;

  }



  function setPlayEnabled(enabled) {

    if (btnPlay) btnPlay.disabled = !enabled;

  }



  function setSectionVisible(show) {

    if (section) section.hidden = !show;

  }



  function canvasWidth() {

    const w = stackEl?.clientWidth ?? canvasMusic?.parentElement?.clientWidth ?? 800;

    return Math.max(320, w - 120);

  }



  function redrawCanvas(canvas, renderer, colors) {

    if (!canvas) return;

    const w = canvasWidth();

    if (!renderer) {

      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.round(w * dpr);

      canvas.height = Math.round(CANVAS_H * dpr);

      canvas.style.width = `${w}px`;

      canvas.style.height = `${CANVAS_H}px`;

      const ctx = canvas.getContext("2d");

      if (ctx) {

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        ctx.fillStyle = colors.background;

        ctx.fillRect(0, 0, w, CANVAS_H);

      }

      return;

    }

    const pxPerSec = WaveformRenderer.pxPerSecFit(renderer.durationSec, w);

    renderer.render(

      canvas,

      {

        pxPerSec,

        scrollLeftPx: 0,

        canvasWidth: w,

        canvasHeight: CANVAS_H,

        showRuler: false,

        flattenSilence: false,

      },

      colors,

    );

  }



  function redrawAll() {

    redrawCanvas(canvasMusic, rendererMusic, MUSIC_COLORS);

    redrawCanvas(canvasVocal, rendererVocal, VOCAL_COLORS);

    updatePlayhead(playOffsetSec);

  }



  async function fetchPeaks(audioPath) {

    const w = canvasWidth();

    const pps = Math.max(8, Math.min(120, Math.floor(w / 4)));

    const raw = await deps.requestAgent({

      method: "POST",

      path: "/api/tools/vocal-remover/waveform-peaks",

      json: {

        audio_path: audioPath,

        timeout_sec: 900,

        pixels_per_second: pps,

        max_waveform_width: Math.min(WAVEFORM_WIDTH_MAX, Math.max(w * 2, 1600)),

      },

    });

    const peaks = Array.isArray(raw.peaks) ? raw.peaks.map(Number) : [];

    const peaksDb = Array.isArray(raw.peaks_db) ? raw.peaks_db.map(Number) : [];

    const timelineSec =

      typeof raw.timeline_sec === "number" && raw.timeline_sec > 0

        ? raw.timeline_sec

        : typeof raw.duration_sec === "number"

          ? raw.duration_sec

          : 0;

    if (peaks.length < 2 || timelineSec <= 0) {

      throw new Error("파형 데이터가 비어 있습니다.");

    }

    return WaveformRenderer.fromPeaks(peaks, timelineSec, peaksDb);

  }



  async function loadAudioBuffer(filePath) {

    const url = agentDownloadUrl(deps.getAgentOrigin, filePath);

    const res = await deps.fetchAgent(url, { method: "GET" });

    if (!res.ok) throw new Error(`오디오 로드 실패: ${res.status}`);

    const ab = await res.arrayBuffer();

    if (!audioContext) audioContext = new AudioContext();

    return audioContext.decodeAudioData(ab.slice(0));

  }



  function stopSources() {

    try {

      sourceMusic?.stop();

    } catch {

      /* already stopped */

    }

    try {

      sourceVocal?.stop();

    } catch {

      /* already stopped */

    }

    sourceMusic = null;

    sourceVocal = null;

    if (rafId) {

      cancelAnimationFrame(rafId);

      rafId = 0;

    }

    playing = false;

    if (btnPlay) btnPlay.textContent = "▶";

  }



  function getMusicGain() {

    return (Number(volMusic?.value) || 0) / 100;

  }



  function getVocalGain() {

    return (Number(volVocal?.value) || 0) / 100;

  }



  function waveAreaMetrics() {

    const sideW = 108;

    const gap = 12;

    const w = canvasWidth();

    return { sideW, gap, waveLeft: sideW + gap, waveWidth: w };

  }



  function updatePlayhead(sec) {

    if (!playhead || durationSec <= 0) return;

    const pct = Math.max(0, Math.min(1, sec / durationSec));

    const { waveLeft, waveWidth } = waveAreaMetrics();

    playhead.style.left = `${waveLeft + pct * waveWidth}px`;

    if (playheadTime) playheadTime.textContent = formatClock(sec);

    if (timeCurrent) timeCurrent.textContent = formatClock(sec);

  }



  function tickPlayhead() {

    if (!playing || !audioContext) return;

    const t = playOffsetSec + (audioContext.currentTime - playStartCtxTime);

    if (t >= durationSec) {

      playOffsetSec = 0;

      stopSources();

      updatePlayhead(0);

      return;

    }

    updatePlayhead(t);

    rafId = requestAnimationFrame(tickPlayhead);

  }



  async function startPlayback(fromSec = playOffsetSec) {

    if (!hasStems || !bufferMusic || !bufferVocal) return;



    if (!audioContext) audioContext = new AudioContext();

    if (audioContext.state === "suspended") await audioContext.resume();



    stopSources();

    if (!gainMusic) {

      gainMusic = audioContext.createGain();

      gainMusic.connect(audioContext.destination);

    }

    if (!gainVocal) {

      gainVocal = audioContext.createGain();

      gainVocal.connect(audioContext.destination);

    }

    gainMusic.gain.value = getMusicGain();

    gainVocal.gain.value = getVocalGain();



    const t0 = audioContext.currentTime + 0.05;

    playStartCtxTime = t0;

    playOffsetSec = Math.max(0, Math.min(fromSec, durationSec));



    sourceMusic = audioContext.createBufferSource();

    sourceMusic.buffer = bufferMusic;

    sourceMusic.connect(gainMusic);

    sourceMusic.start(t0, playOffsetSec);



    sourceVocal = audioContext.createBufferSource();

    sourceVocal.buffer = bufferVocal;

    sourceVocal.connect(gainVocal);

    sourceVocal.start(t0, playOffsetSec);



    playing = true;

    if (btnPlay) btnPlay.textContent = "⏸";

    rafId = requestAnimationFrame(tickPlayhead);

  }



  function togglePlay() {

    if (!hasStems) return;

    if (playing) {

      if (audioContext) {

        playOffsetSec = Math.min(

          durationSec,

          playOffsetSec + (audioContext.currentTime - playStartCtxTime),

        );

      }

      stopSources();

      updatePlayhead(playOffsetSec);

      return;

    }

    void startPlayback(playOffsetSec);

  }



  function seekFromClientX(clientX) {

    if (!stackEl || durationSec <= 0 || !hasStems) return;

    const rect = stackEl.getBoundingClientRect();

    const { waveLeft, waveWidth } = waveAreaMetrics();

    const trackLeft = rect.left + waveLeft;

    const ratio = Math.max(0, Math.min(1, (clientX - trackLeft) / waveWidth));

    playOffsetSec = ratio * durationSec;

    updatePlayhead(playOffsetSec);

    if (playing) void startPlayback(playOffsetSec);

  }



  /** 파일 선택 직후: 경로만 반영하고 분리는 시작하지 않음 */

  function prepareForFilePick(filePath) {

    stopSources();

    playOffsetSec = 0;

    hasStems = false;

    rendererMusic = null;

    rendererVocal = null;

    bufferMusic = null;

    bufferVocal = null;

    instrumentalPath = "";

    vocalsPath = "";

    durationSec = 0;

    resetVolumes();

    setPlayEnabled(false);



    const base = filePath.split(/[/\\]/).pop() || filePath;
    lastPickBase = base;
    labelPhase = "wait";
    applyStemLabels();

    if (timeTotal) timeTotal.textContent = "0:00.0";

    if (timeCurrent) timeCurrent.textContent = "0:00.0";



    redrawAll();

  }



  /** 분석(분리) 시작 시 표시 */

  function prepareForSeparation(filePath) {

    prepareForFilePick(filePath);

    const base = filePath.split(/[/\\]/).pop() || filePath;
    lastPickBase = base;
    labelPhase = "separating";
    applyStemLabels();

  }



  async function onSeparationComplete(payload) {

    instrumentalPath = payload.instrumental_path || "";

    vocalsPath = payload.vocals_path || "";

    hasStems = !!(instrumentalPath && vocalsPath);

    if (!hasStems) {

      throw new Error("MR·보컬 스템 경로가 없습니다.");

    }



    if (payload.duration_sec > 0) durationSec = payload.duration_sec;



    const base = (payload.original_path || instrumentalPath).split(/[/\\]/).pop() || "";
    lastPickBase = base;
    labelPhase = "done";
    applyStemLabels();



    rendererMusic = await fetchPeaks(instrumentalPath);
    rendererVocal = await fetchPeaks(vocalsPath);

    durationSec = Math.max(rendererMusic.durationSec, rendererVocal.durationSec, durationSec);



    bufferMusic = await loadAudioBuffer(instrumentalPath);

    bufferVocal = await loadAudioBuffer(vocalsPath);



    resetVolumes();

    setPlayEnabled(true);



    if (timeTotal) timeTotal.textContent = formatClock(durationSec);

    redrawAll();

  }



  function onResize() {

    redrawAll();

  }



  volMusic?.addEventListener("input", () => {

    if (gainMusic) gainMusic.gain.value = getMusicGain();

  });

  volVocal?.addEventListener("input", () => {

    if (gainVocal) gainVocal.gain.value = getVocalGain();

  });

  btnPlay?.addEventListener("click", () => togglePlay());

  stackEl?.addEventListener("click", (ev) => {

    if (ev.target.closest(".vol-slider") || ev.target.closest("#btn-play-pause")) return;

    seekFromClientX(ev.clientX);

  });

  window.addEventListener("resize", onResize);



  setSectionVisible(true);
  lastPickBase = "";
  labelPhase = "wait";
  applyStemLabels();
  resetVolumes();
  requestAnimationFrame(() => redrawAll());



  return {

    prepareForFilePick,

    prepareForSeparation,

    onSeparationComplete,

    applyLang: applyStemLabels,

    destroy() {

      stopSources();

      window.removeEventListener("resize", onResize);

      if (audioContext) void audioContext.close();

      audioContext = null;

    },

  };

}


