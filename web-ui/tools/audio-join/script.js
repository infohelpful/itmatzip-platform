import { showAdSense } from "../common/adsense.js?v=7";
import {
  applyConnectionStatusDot,
  checkAgentConnection,
  configureBridge,
  fetchAgent,
  getAgentOrigin,
  showInstallAgentDialog,
  startConnectionMonitor,
} from "../common/bridge.js?v=lna24";
import { AGENT_PICK_AUDIO } from "../common/agent-pick-endpoints.js";
import { agentInstallDialogOptions } from "../common/agent-install-ui.js?v=lna22";

configureBridge({ healthPath: "/health" });

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
    for (const k of Object.keys(vars)) {
      s = String(s).split(`{${k}}`).join(String(vars[k] ?? ""));
    }
  }
  return s;
}

function installDialogOpts() {
  return agentInstallDialogOptions(() => checkAgentConnection());
}

/** @type {{ path: string, name: string, durationSec: number, volume: number, startSec: number, endSec: number | null }[]} */
let tracks = [];
let busy = false;

const listEl = document.getElementById("card-list");
const listMeta = document.getElementById("list-meta");
const statusEl = document.getElementById("composer-status");
const addBtn = document.getElementById("btn-add-track");
const clearBtn = document.getElementById("btn-clear");
const joinBtn = document.getElementById("btn-join");
const joinMode = document.getElementById("join-mode");
const gapRange = document.getElementById("gap-sec");
const gapValue = document.getElementById("gap-value");
const gapCard = document.getElementById("gap-card");
const crossRange = document.getElementById("crossfade-sec");
const crossValue = document.getElementById("cross-value");
const crossCard = document.getElementById("cross-card");
const fadeOutRange = document.getElementById("fade-out-sec");
const fadeOutValue = document.getElementById("fade-out-value");
const fadeInRange = document.getElementById("fade-in-sec");
const fadeInValue = document.getElementById("fade-in-value");
const fadeFirst = document.getElementById("fade-first-in");
const fadeLast = document.getElementById("fade-last-out");
const normalizeEl = document.getElementById("opt-normalize");
const formatEl = document.getElementById("out-format");
const rateEl = document.getElementById("sample-rate");
const progressBox = document.getElementById("join-progress");
const progressBar = document.getElementById("join-bar");
const progressMsg = document.getElementById("join-message");
const resultNote = document.getElementById("result-note");
const resultLink = document.getElementById("result-link");
const binEl = document.getElementById("bin-readiness");
const trimSilenceEl = document.getElementById("opt-trim-silence");

function fileName(path) {
  const parts = String(path).split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function setStatus(message, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = message || "";
  statusEl.classList.toggle("is-error", Boolean(isError));
}

function secLabel(value) {
  const n = Number(value);
  return itzTf("secN", "{n}초", { n: String(n) });
}

function syncModeUi() {
  const clip = tracks.length === 1;
  const cross = joinMode?.value === "crossfade";
  const modeCard = joinMode?.closest(".opt-card");
  if (modeCard) modeCard.hidden = clip;
  if (gapCard) gapCard.hidden = clip || cross;
  if (crossCard) crossCard.hidden = clip || !cross;
  if (joinBtn) {
    joinBtn.textContent =
      tracks.length === 1
        ? itzT("joinClip", "구간 추출하고 저장")
        : itzT("join", "만들고 저장");
  }
}

function formatDur(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const s = Math.round(sec * 10) / 10;
  return String(s);
}

function renderList() {
  if (!listEl) return;
  listEl.replaceChildren();
  tracks.forEach((track, index) => {
    const row = document.createElement("div");
    row.className = "track-card";
    row.setAttribute("role", "listitem");
    const volPct = Math.round(track.volume * 100);
    const endVal = track.endSec != null && track.endSec > 0 ? String(track.endSec) : "";
    row.innerHTML = `
      <span class="track-idx">${index + 1}</span>
      <span class="track-name"></span>
      <span class="track-ops">
        <button type="button" data-act="up" aria-label="up">▲</button>
        <button type="button" data-act="down" aria-label="down">▼</button>
        <button type="button" data-act="remove" aria-label="remove">✕</button>
      </span>
      <div class="track-extras">
        <label class="track-extra-label">${itzT("volLabel", "볼륨")}
          <span class="vol-row">
            <input type="range" data-field="volume" min="0" max="200" step="5" value="${volPct}">
            <span class="vol-val">${volPct}%</span>
          </span>
        </label>
        <label class="track-extra-label">${itzT("rangeLabel", "구간 (초)")}
          <span class="vol-row">
            <input type="number" data-field="start" min="0" step="0.1" value="${track.startSec || 0}">
            <span>~</span>
            <input type="number" data-field="end" min="0" step="0.1" value="${endVal}" placeholder="${formatDur(track.durationSec) || itzT("endPh", "끝")}">
          </span>
        </label>
      </div>`;
    row.querySelector(".track-name").textContent = track.durationSec
      ? `${track.name} · ${formatDur(track.durationSec)}${itzT("secUnit", "초")}`
      : track.name;
    row.querySelector('[data-act="up"]').disabled = index === 0;
    row.querySelector('[data-act="down"]').disabled = index === tracks.length - 1;
    row.querySelector('[data-act="up"]').addEventListener("click", () => moveTrack(index, -1));
    row.querySelector('[data-act="down"]').addEventListener("click", () => moveTrack(index, 1));
    row.querySelector('[data-act="remove"]').addEventListener("click", () => {
      tracks.splice(index, 1);
      renderList();
    });
    const volInput = row.querySelector('[data-field="volume"]');
    const volVal = row.querySelector(".vol-val");
    volInput.addEventListener("input", () => {
      tracks[index].volume = Number(volInput.value) / 100;
      volVal.textContent = `${volInput.value}%`;
    });
    row.querySelector('[data-field="start"]').addEventListener("change", (ev) => {
      tracks[index].startSec = Math.max(0, Number(ev.target.value) || 0);
    });
    row.querySelector('[data-field="end"]').addEventListener("change", (ev) => {
      const v = Number(ev.target.value);
      tracks[index].endSec = Number.isFinite(v) && v > 0 ? v : null;
    });
    listEl.appendChild(row);
  });
  if (listMeta) {
    listMeta.textContent = tracks.length
      ? itzTf("listCount", "{n}개", { n: String(tracks.length) })
      : "";
  }
  syncModeUi();
}

function moveTrack(index, delta) {
  const next = index + delta;
  if (next < 0 || next >= tracks.length) return;
  const [item] = tracks.splice(index, 1);
  tracks.splice(next, 0, item);
  renderList();
}

async function ensureAgent() {
  const agent = await checkAgentConnection();
  if (!agent.ok) {
    await showInstallAgentDialog(await installDialogOpts());
    return false;
  }
  return true;
}

async function addTrack() {
  if (busy) return;
  if (!(await ensureAgent())) return;
  addBtn.disabled = true;
  try {
    const res = await fetchAgent(`${getAgentOrigin()}${AGENT_PICK_AUDIO}`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data?.detail;
      const msg = typeof detail === "string" ? detail : res.statusText;
      if (res.status === 400 && /취소|cancel/i.test(String(msg))) return;
      setStatus(itzTf("pickFail", "파일을 고르지 못했습니다: {msg}", { msg }), true);
      return;
    }
    const picked = String(data?.audio_path || data?.video_path || "").trim();
    if (!picked) {
      setStatus(itzT("pickNoPath", "에이전트가 경로를 반환하지 않았습니다."), true);
      return;
    }
    if (tracks.some((t) => t.path === picked)) {
      setStatus(itzT("dup", "이미 목록에 있는 파일입니다."), true);
      return;
    }
    tracks.push({ path: picked, name: fileName(picked), durationSec: 0, volume: 1, startSec: 0, endSec: null });
    renderList();
    setStatus("");
    try {
      await prepareFfmpeg();
      const probe = await fetchAgent(`${getAgentOrigin()}/api/tools/audio-join/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ path: picked }),
      });
      const info = await probe.json().catch(() => ({}));
      if (probe.ok && typeof info.duration_sec === "number") {
        const t = tracks.find((x) => x.path === picked);
        if (t) t.durationSec = info.duration_sec;
        renderList();
      }
    } catch {
      /* duration optional */
    }
  } catch (err) {
    setStatus(String(err?.message || err), true);
  } finally {
    addBtn.disabled = busy;
  }
}

function setProgress(active, pct, message) {
  if (!progressBox) return;
  progressBox.hidden = !active;
  if (progressBar) progressBar.style.width = `${Math.max(0, Math.min(100, pct || 0))}%`;
  if (progressMsg) progressMsg.textContent = message || "";
}

async function prepareFfmpeg() {
  const ready = await fetchAgent(`${getAgentOrigin()}/api/tools/audio-join/readiness`);
  const readyJson = await ready.json().catch(() => ({}));
  const bins = readyJson?.binaries || {};
  if (bins.ffmpeg && bins.ffprobe) {
    if (binEl) binEl.textContent = itzT("ffmpegReady", "FFmpeg 준비됨");
    return;
  }
  if (binEl) binEl.textContent = itzT("ffmpegPrep", "FFmpeg 준비 중…");
  const prep = await fetchAgent(`${getAgentOrigin()}/api/tools/audio-join/prepare`, { method: "POST" });
  if (!prep.ok) {
    const data = await prep.json().catch(() => ({}));
    throw new Error(typeof data?.detail === "string" ? data.detail : itzT("ffmpegFail", "FFmpeg를 준비하지 못했습니다."));
  }
  if (binEl) binEl.textContent = itzT("ffmpegReady", "FFmpeg 준비됨");
}

async function pollJoin() {
  for (;;) {
    const res = await fetchAgent(`${getAgentOrigin()}/api/tools/audio-join/join/status`);
    const data = await res.json().catch(() => ({}));
    const phase = data?.phase || "";
    setProgress(true, Number(data?.progress) || 0, data?.message || "");
    if (phase === "ready") return data;
    if (phase === "failed") throw new Error(data?.message || itzT("joinFail", "이어붙이기에 실패했습니다."));
    if (phase === "idle") throw new Error(itzT("joinIdle", "작업이 시작되지 않았습니다."));
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function startJoin() {
  if (busy) return;
  if (tracks.length < 1) {
    setStatus(itzT("needOne", "음원을 추가하세요."), true);
    return;
  }
  for (const t of tracks) {
    const start = t.startSec || 0;
    if (t.endSec != null && t.endSec > 0 && t.endSec <= start) {
      setStatus(itzTf("rangeBad", "{name}: 끝 시각이 시작보다 커야 합니다.", { name: t.name }), true);
      return;
    }
    if (t.durationSec > 0 && start >= t.durationSec) {
      setStatus(itzTf("startPast", "{name}: 시작 시각이 파일 길이보다 깁니다.", { name: t.name }), true);
      return;
    }
  }
  if (!(await ensureAgent())) return;
  busy = true;
  joinBtn.disabled = true;
  addBtn.disabled = true;
  resultLink.hidden = true;
  resultNote.textContent = "";
  setStatus("");
  setProgress(true, 2, itzT("starting", "작업을 시작합니다…"));
  try {
    await prepareFfmpeg();
    const body = {
      tracks: tracks.map((t) => ({
        path: t.path,
        volume: t.volume,
        start_sec: t.startSec || 0,
        end_sec: t.endSec,
      })),
      fade_in_sec: Number(fadeInRange.value),
      fade_out_sec: Number(fadeOutRange.value),
      fade_first_in: Boolean(fadeFirst?.checked),
      fade_last_out: Boolean(fadeLast?.checked),
      gap_sec: Number(gapRange.value),
      join_mode: joinMode.value,
      crossfade_sec: Number(crossRange.value),
      format: formatEl.value,
      sample_rate: Number(rateEl.value),
      normalize: Boolean(normalizeEl?.checked),
      trim_silence: Boolean(trimSilenceEl?.checked),
    };
    const res = await fetchAgent(`${getAgentOrigin()}/api/tools/audio-join/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data?.detail;
      throw new Error(typeof detail === "string" ? detail : itzT("joinFail", "이어붙이기에 실패했습니다."));
    }
    const done = await pollJoin();
    const url = `${getAgentOrigin()}/api/tools/audio-join/download?file_path=${encodeURIComponent(done.result_path)}`;
    resultLink.hidden = false;
    resultLink.href = url;
    resultNote.textContent = itzT("joinDone", "작업이 끝났습니다. 아래에서 받으세요.");
    setProgress(true, 100, done.message || itzT("joinDone", "작업이 끝났습니다."));
  } catch (err) {
    setStatus(String(err?.message || err), true);
    setProgress(false, 0, "");
  } finally {
    busy = false;
    joinBtn.disabled = false;
    addBtn.disabled = false;
  }
}

function bindRanges() {
  const pairs = [
    [gapRange, gapValue],
    [crossRange, crossValue],
    [fadeOutRange, fadeOutValue],
    [fadeInRange, fadeInValue],
  ];
  for (const [input, label] of pairs) {
    if (!input || !label) continue;
    const paint = () => {
      label.textContent = secLabel(input.value);
    };
    input.addEventListener("input", paint);
    paint();
  }
}

addBtn?.addEventListener("click", () => void addTrack());
clearBtn?.addEventListener("click", () => {
  tracks = [];
  renderList();
  setStatus("");
});
joinBtn?.addEventListener("click", () => void startJoin());
joinMode?.addEventListener("change", syncModeUi);
bindRanges();
syncModeUi();
renderList();

startConnectionMonitor({
  intervalMs: 3000,
  immediate: true,
  onChange: (ok, detail) => {
    applyConnectionStatusDot(document.getElementById("connection-status"), ok, detail);
  },
  autoShowInstallDialog: true,
  installDialogOptions: installDialogOpts,
});

void (async () => {
  const agent = await checkAgentConnection();
  if (!agent.ok) {
    await showInstallAgentDialog(await installDialogOpts());
    return;
  }
  try {
    await prepareFfmpeg();
  } catch (err) {
    if (binEl) binEl.textContent = String(err?.message || err);
  }
})();

void showAdSense("editorAboveWorkspace", "#editor-ad-above-path");
void showAdSense("editorBelowExport", "#editor-ad-below-export");
