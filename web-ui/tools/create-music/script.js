/**
 * Create Music — ACE-Step 1.5 AI 음악 생성 (간단한 화면)
 * 왼쪽: 보컬·장르·분위기·템포·가사·길이 / 가운데: 만든 곡 목록·플레이어 / 오른쪽: AI 작곡 도우미(MCP 연결 시)
 */
import * as Bridge from "../common/bridge.js?v=lna27";
import { AGENT_PICK_AUDIO } from "../common/agent-pick-endpoints.js";
import { showAdSense } from "../common/adsense.js?v=6";
import { agentInstallDialogOptions } from "../common/agent-install-ui.js?v=lna22";
import {
  GENRE_OPTIONS,
  INSTRUMENT_OPTIONS,
  VOCAL_STYLE_OPTIONS,
  compileCaption,
} from "./music-compose.js?v=12";

Bridge.configureBridge();

const API = "/api/tools/create-music";
const DOWNLOAD_PAGE = "download.html";
const STORAGE = {
  jobId: "create-music:job-id",
  filename: "create-music:filename",
  source: "create-music:source-name",
  mp3Url: "create-music:mp3-download-url",
  wavUrl: "create-music:wav-download-url",
  format: "create-music:format",
};
/** 품질: 빠르게 = turbo(8스텝), 고품질 = sft(25스텝) — 예전 「스피드 초안」·「고품질 마스터링」 프리셋 값 */
const QUALITY = {
  speed: { dit_model: "turbo", inference_steps: 8, guidance_scale: 3.5, shift: 3.0 },
  quality: { dit_model: "sft", inference_steps: 25, guidance_scale: 6.5, shift: 4.0 },
};
const GENRES_VISIBLE = 10;
const COVERS = [
  "linear-gradient(135deg,#6366F1,#EC4899)",
  "linear-gradient(135deg,#0EA5E9,#6366F1)",
  "linear-gradient(135deg,#8B5CF6,#3B82F6)",
  "linear-gradient(135deg,#7C3AED,#10B981)",
  "linear-gradient(135deg,#F59E0B,#EF4444)",
  "linear-gradient(135deg,#14B8A6,#6366F1)",
];

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------
function t(key, fallback) {
  return typeof window.itzT === "function" ? window.itzT(key, fallback) : fallback;
}
function tf(key, fallback, vars) {
  let s = t(key, fallback);
  Object.keys(vars || {}).forEach((k) => {
    s = s.split(`{${k}}`).join(String(vars[k] == null ? "" : vars[k]));
  });
  return s;
}
/** 에이전트가 보내는 한국어 진행 문구 → 현재 언어 (없으면 그대로) */
function locAgent(s) {
  const raw = String(s || "").trim();
  if (!raw) return raw;
  return typeof window.itzAgentText === "function" ? window.itzAgentText(raw) : raw;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

const ui = {
  agentPill: $("cm-agent-pill"),
  agentText: $("cm-agent-text"),
  gpuPill: $("cm-gpu-pill"),
  envPill: $("cm-env-pill"),
  envText: $("cm-env-text"),
  popover: $("cm-popover"),
  checkList: $("cm-check-list"),
  popNote: $("cm-pop-note"),
  prepareBtn: $("cm-prepare-btn"),
  aiBtn: $("cm-ai-btn"),
  vocal: $("cm-vocal"),
  genres: $("cm-genres"),
  mood: $("cm-mood"),
  tempo: $("cm-tempo"),
  lyricsGroup: $("cm-lyrics-group"),
  lyricsWrap: $("cm-lyrics-wrap"),
  lyrics: $("cm-lyrics"),
  vocalLang: $("cm-vocal-lang"),
  instNotice: $("cm-inst-notice"),
  duration: $("cm-duration"),
  durHint: $("cm-dur-hint"),
  adv: $("cm-adv"),
  quality: $("cm-quality"),
  instruments: $("cm-instruments"),
  vstyleGroup: $("cm-vstyle-group"),
  vstyles: $("cm-vocal-styles"),
  refGroup: $("cm-ref-group"),
  refPick: $("cm-ref-pick"),
  refName: $("cm-ref-name"),
  refClear: $("cm-ref-clear"),
  seed: $("cm-seed"),
  generate: $("cm-generate"),
  genHint: $("cm-gen-hint"),
  count: $("cm-count"),
  tracks: $("cm-tracks"),
  pThumb: $("cm-p-thumb"),
  pTitle: $("cm-p-title"),
  pSub: $("cm-p-sub"),
  pPlay: $("cm-p-play"),
  pCur: $("cm-p-cur"),
  pSeek: $("cm-p-seek"),
  pTot: $("cm-p-tot"),
  pVol: $("cm-p-vol"),
  chat: $("cm-chat"),
  chatClose: $("cm-chat-close"),
  chatMsgs: $("cm-chat-msgs"),
  chatIn: $("cm-chat-in"),
  chatSend: $("cm-chat-send"),
  toast: $("cm-toast"),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  connected: false,
  agentVersion: "",
  readiness: null,
  ready: false,
  preparing: null, // { progress, message } while the agent installs
  maxDuration: 600,
  refPath: null,
  history: [],
  generating: null, // { jobId, progress, message, title, vocal, genres }
  aiClients: [],
  aiBusy: false,
  aiHistory: [], // [{ role: "user" | "assistant", text }]
};

function toast(message, { error = false } = {}) {
  ui.toast.textContent = message;
  ui.toast.classList.toggle("is-err", error);
  ui.toast.classList.add("is-show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ui.toast.classList.remove("is-show"), error ? 4200 : 2200);
}

function flash(node) {
  node.classList.remove("cm-ai-filled");
  void node.offsetWidth;
  node.classList.add("cm-ai-filled");
}

// ---------------------------------------------------------------------------
// 입력 칸: 세그먼트 버튼·칩
// ---------------------------------------------------------------------------
function segValue(seg) {
  return seg.querySelector("button.active")?.dataset.value ?? "";
}
function setSeg(seg, value) {
  const target = seg.querySelector(`button[data-value="${CSS.escape(String(value))}"]`);
  if (!target || target.disabled) return false;
  seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === target));
  return true;
}
function bindSeg(seg, onChange) {
  seg.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.disabled || b.classList.contains("active")) return;
      setSeg(seg, b.dataset.value);
      onChange?.(b.dataset.value);
    }),
  );
}

/** 칩 그룹: 옵션의 i18nKey로 선택 상태를 기억 */
function renderChips(box, options, { limit = 0 } = {}) {
  const selected = new Set(chipValues(box));
  box.textContent = "";
  const showAll = box.dataset.expanded === "1" || !limit;
  options.forEach((opt, i) => {
    if (!showAll && i >= limit && !selected.has(opt.i18nKey)) return;
    const chip = el("button", "cm-chip", t(opt.i18nKey, opt.label));
    chip.type = "button";
    chip.dataset.key = opt.i18nKey;
    chip.classList.toggle("active", selected.has(opt.i18nKey));
    chip.addEventListener("click", () => {
      chip.classList.toggle("active");
      updateGenerateState();
    });
    box.appendChild(chip);
  });
  if (!showAll) {
    const more = el("button", "cm-chip is-more", t("cm.more2", "+ 더보기"));
    more.type = "button";
    more.addEventListener("click", () => {
      box.dataset.expanded = "1";
      renderChips(box, options, { limit });
    });
    box.appendChild(more);
  }
}
function chipValues(box) {
  return Array.from(box.querySelectorAll(".cm-chip.active")).map((c) => c.dataset.key).filter(Boolean);
}
function setChips(box, options, keys, opts) {
  const wanted = new Set(keys || []);
  if (opts?.limit && options.findIndex((o) => wanted.has(o.i18nKey)) >= opts.limit) box.dataset.expanded = "1";
  box.querySelectorAll(".cm-chip.active").forEach((c) => c.classList.remove("active"));
  renderChips(box, options, opts);
  box.querySelectorAll(".cm-chip").forEach((c) => c.classList.toggle("active", wanted.has(c.dataset.key)));
}
const optionByKey = (options, key) => options.find((o) => o.i18nKey === key);
const optionLabel = (options, key) => {
  const opt = optionByKey(options, key);
  return opt ? t(opt.i18nKey, opt.label) : key;
};

function renderAllChips() {
  renderChips(ui.genres, GENRE_OPTIONS, { limit: GENRES_VISIBLE });
  renderChips(ui.instruments, INSTRUMENT_OPTIONS);
  renderChips(ui.vstyles, VOCAL_STYLE_OPTIONS);
}

function syncVocalUi() {
  const instrumental = segValue(ui.vocal) === "none";
  ui.lyricsGroup.hidden = instrumental;
  ui.instNotice.hidden = !instrumental;
  ui.vstyleGroup.hidden = instrumental;
  ui.refGroup.hidden = instrumental;
  ui.durHint.textContent = instrumental
    ? t("cm.durAutoInst", "자동 = 약 1분")
    : t("cm.durAutoLyrics", "자동 = 가사 길이에 맞춤");
  updateGenerateState();
}

bindSeg(ui.vocal, syncVocalUi);
bindSeg(ui.tempo);
bindSeg(ui.duration);
bindSeg(ui.quality);
ui.lyrics.addEventListener("input", updateGenerateState);
ui.mood.addEventListener("input", updateGenerateState);

ui.adv.querySelector(".cm-acc-head").addEventListener("click", (e) => {
  const open = ui.adv.classList.toggle("is-open");
  e.currentTarget.setAttribute("aria-expanded", String(open));
});

document.querySelectorAll(".cm-tag-btn").forEach((b) =>
  b.addEventListener("click", () => {
    const ta = ui.lyrics;
    const pos = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, pos);
    const prefix = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
    const insert = `${prefix}${b.dataset.tag}\n`;
    ta.value = before + insert + ta.value.slice(ta.selectionEnd ?? pos);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = pos + insert.length;
    updateGenerateState();
  }),
);

// ---------------------------------------------------------------------------
// 참조 보컬 (에이전트 파일 선택 창)
// ---------------------------------------------------------------------------
async function pickAudioFile() {
  const agent = await Bridge.checkAgentConnection();
  if (!agent.ok) {
    await Bridge.showInstallAgentDialog(await installDialogOpts());
    return null;
  }
  try {
    const res = await Bridge.fetchAgent(`${Bridge.getAgentOrigin()}${AGENT_PICK_AUDIO}`, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = typeof data?.detail === "string" ? data.detail : res.statusText;
      if (res.status === 400 && (detail.includes("취소") || /cancel/i.test(detail))) return null;
      toast(`${t("pickFail", "파일 선택 실패")}: ${detail}`, { error: true });
      return null;
    }
    return String(data.audio_path || data.path || "").trim() || null;
  } catch (e) {
    toast(`${t("pickFail", "파일 선택 실패")}: ${e instanceof Error ? e.message : e}`, { error: true });
    return null;
  }
}
function syncRefUi() {
  const name = state.refPath ? state.refPath.split(/[\\/]/).pop() : "";
  ui.refName.textContent = name ? `🎵 ${name}` : t("cm.refPick", "+ 목소리 샘플 고르기");
  ui.refPick.classList.toggle("is-set", Boolean(name));
  ui.refClear.hidden = !name;
}
ui.refPick.addEventListener("click", async () => {
  ui.refPick.disabled = true;
  try {
    const path = await pickAudioFile();
    if (path) {
      state.refPath = path;
      syncRefUi();
    }
  } finally {
    ui.refPick.disabled = false;
  }
});
ui.refClear.addEventListener("click", () => {
  state.refPath = null;
  syncRefUi();
});

// ---------------------------------------------------------------------------
// 생성 가능 여부
// ---------------------------------------------------------------------------
/** [Verse] 같은 구간 표시를 뺀 실제 가사가 있는지 */
function hasLyricText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .some((line) => line.trim() && !/^\s*\[[^\]]*\]\s*$/.test(line));
}

function formProblem() {
  if (!chipValues(ui.genres).length && !ui.mood.value.trim()) {
    return t("cm.needStyle", "장르를 고르거나 분위기를 적어 주세요");
  }
  if (segValue(ui.vocal) !== "none" && !hasLyricText(ui.lyrics.value)) {
    return t("cm.needLyrics", "가사를 입력해야 만들 수 있어요 (가사 없이 만들려면 「연주곡」)");
  }
  return "";
}

function updateGenerateState() {
  const busy = Boolean(state.generating);
  let hint = "";
  if (!state.connected) hint = t("cm.hintNoAgent", "에이전트를 연결하면 만들 수 있어요");
  else if (!state.ready) {
    hint = state.preparing
      ? tf("cm.hintPreparing", "음악 엔진 준비 중 {p}%", { p: Math.round(state.preparing.progress || 0) })
      : t("cm.hintNeedPrep", "위쪽 상태 표시를 눌러 환경 준비를 마쳐 주세요");
  } else if (busy) hint = t("cm.hintBusy", "곡을 만드는 중이에요");
  else hint = formProblem() || t("cm.hintReady", "60초 곡 기준 약 20초 걸려요");
  ui.generate.disabled = !state.connected || !state.ready || busy || Boolean(formProblem());
  ui.generate.textContent = busy ? t("cm.generating", "만드는 중…") : t("cm.generate", "✦ 음악 만들기");
  ui.genHint.textContent = hint;
}

// ---------------------------------------------------------------------------
// 에이전트 연결 · 환경 상태
// ---------------------------------------------------------------------------
function installDialogOpts() {
  return agentInstallDialogOptions(async () => {
    const detail = await Bridge.checkAgentConnection();
    if (detail.ok) onAgentChange(true, detail);
    return detail;
  });
}

function setPill(node, kind) {
  node.classList.remove("is-ok", "is-warn", "is-info", "is-pending");
  node.classList.add(kind);
}

function renderStatus() {
  // 에이전트
  if (state.connected) {
    setPill(ui.agentPill, "is-ok");
    ui.agentText.textContent = state.agentVersion
      ? tf("cm.agentOkV", "에이전트 연결됨 · v{v}", { v: state.agentVersion })
      : t("cm.agentOk", "에이전트 연결됨");
  } else {
    setPill(ui.agentPill, "is-warn");
    ui.agentText.textContent = t("cm.agentOff", "에이전트 꺼짐");
  }

  // GPU
  const gpu = state.readiness?.gpu;
  if (state.connected && gpu) {
    ui.gpuPill.hidden = false;
    const minutes = Math.floor(state.maxDuration / 60);
    ui.gpuPill.textContent = gpu.available
      ? tf("cm.gpuPill", "GPU {gb}GB · 최대 {m}분", { gb: Math.round(Number(gpu.vram_gb) || (gpu.vram_mb || 0) / 1024), m: minutes })
      : tf("cm.cpuPill", "CPU 모드 · 최대 {m}분", { m: minutes });
  } else {
    ui.gpuPill.hidden = true;
  }

  // 음악 엔진
  if (!state.connected) {
    setPill(ui.envPill, "is-warn");
    ui.envText.textContent = t("cm.envNeedAgent", "⚠ 에이전트 연결 필요");
  } else if (state.ready) {
    setPill(ui.envPill, "is-ok");
    ui.envText.textContent = t("cm.envReady", "✓ 음악 엔진 준비됨");
  } else if (state.preparing) {
    setPill(ui.envPill, "is-warn");
    ui.envText.textContent = tf("cm.envPreparing", "음악 엔진 준비 중 {p}%", { p: Math.round(state.preparing.progress || 0) });
  } else if (state.readiness) {
    setPill(ui.envPill, "is-warn");
    ui.envText.textContent = t("cm.envNeed", "⚠ 처음 한 번 준비가 필요해요");
  } else {
    setPill(ui.envPill, "is-pending");
    ui.envText.textContent = t("cm.envChecking", "음악 엔진 확인 중…");
  }

  // 상태 창
  const dep = state.readiness?.dependencies || {};
  const rows = [
    [t("cm.chkAgent", "에이전트"), state.connected],
    [t("cm.chkRuntime", "음악 엔진"), state.connected && Boolean(dep.pytorch && dep.acestep_venv && dep.acestep_source)],
    [t("cm.chkModels", "AI 모델 (빠르게·고품질)"), state.connected && Boolean(dep.acestep_models)],
  ];
  ui.checkList.textContent = "";
  rows.forEach(([name, ok]) => {
    const row = el("div", "cm-check-row");
    row.append(el("span", null, name), el("span", ok ? "is-ok" : "is-no", ok ? t("cm.chkOk", "✓ 준비됨") : t("cm.chkNo", "필요")));
    ui.checkList.appendChild(row);
  });
  if (!state.connected) {
    ui.popNote.textContent = t("cm.noteAgent", "이 PC에서 음악을 만들려면 잇맛집 에이전트가 필요해요.");
    ui.prepareBtn.textContent = t("cm.btnAgent", "에이전트 연결하기");
    ui.prepareBtn.disabled = false;
  } else if (state.ready) {
    ui.popNote.textContent = t("cm.noteReady", "모든 준비가 끝났습니다. 바로 음악을 만들 수 있어요.");
    ui.prepareBtn.textContent = t("cm.recheck", "↻ 다시 확인");
    ui.prepareBtn.disabled = false;
  } else if (state.preparing) {
    ui.popNote.textContent = locAgent(state.preparing.message) || t("cm.notePreparing", "설치하고 있어요. 잠시만 기다려 주세요.");
    ui.prepareBtn.textContent = tf("cm.btnPreparing", "준비 중 {p}%", { p: Math.round(state.preparing.progress || 0) });
    ui.prepareBtn.disabled = true;
  } else {
    ui.popNote.textContent = t("cm.noteSetup", "처음 한 번만 필요해요. 음악 엔진과 AI 모델(빠르게·고품질)을 받습니다.");
    ui.prepareBtn.textContent = t("cm.btnPrepare", "환경 준비 시작");
    ui.prepareBtn.disabled = false;
  }

  // 곡 길이: GPU 등급의 최대 길이를 넘는 버튼은 끔
  ui.duration.querySelectorAll("button").forEach((b) => {
    const sec = Number(b.dataset.value);
    b.disabled = sec > 0 && sec > state.maxDuration;
  });
  if (ui.duration.querySelector("button.active")?.disabled) setSeg(ui.duration, "-1");

  updateGenerateState();
}

async function checkReadiness({ full = false } = {}) {
  if (!state.connected) return false;
  try {
    const res = await Bridge.fetchAgent(`${Bridge.getAgentOrigin()}${API}/readiness${full ? "" : "?quick=1"}`);
    if (!res.ok) return false;
    const data = await res.json();
    state.readiness = data;
    state.ready = Boolean(data.all_ready);
    const limits = data.gpu?.limits || {};
    state.maxDuration = Number(limits.max_duration_without_lm_sec) || 600;
    if (state.ready) state.preparing = null;
    renderStatus();
    if (!state.ready) void pollPrepare();
    return state.ready;
  } catch {
    return false;
  }
}

let preparePolling = false;
async function pollPrepare() {
  if (preparePolling) return;
  preparePolling = true;
  try {
    while (state.connected && !state.ready) {
      const res = await Bridge.fetchAgent(`${Bridge.getAgentOrigin()}${API}/prepare/status`).catch(() => null);
      const data = res?.ok ? await res.json().catch(() => null) : null;
      const phase = data?.phase || "idle";
      if (phase === "done") {
        state.preparing = null;
        await checkReadiness();
        break;
      }
      if (phase === "error") {
        state.preparing = null;
        renderStatus();
        if (data?.error) toast(locAgent(data.error), { error: true });
        break;
      }
      state.preparing = phase === "idle" ? null : { progress: data.progress || 0, message: data.message || "" };
      renderStatus();
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    preparePolling = false;
  }
}

async function startPrepare() {
  try {
    const res = await Bridge.fetchAgent(`${Bridge.getAgentOrigin()}${API}/prepare`, { method: "POST" });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    if (data.phase === "done") await checkReadiness({ full: true });
    else {
      state.preparing = { progress: data.progress || 0, message: data.message || "" };
      renderStatus();
      void pollPrepare();
    }
  } catch (e) {
    toast(tf("cm.prepFail", "환경 준비를 시작하지 못했어요: {msg}", { msg: e instanceof Error ? e.message : e }), { error: true });
  }
}

ui.prepareBtn.addEventListener("click", async () => {
  if (!state.connected) {
    await Bridge.showInstallAgentDialog(await installDialogOpts());
    return;
  }
  if (state.ready) {
    ui.prepareBtn.disabled = true;
    await checkReadiness({ full: true });
    toast(state.ready ? t("cm.recheckOk", "모든 환경이 정상이에요") : t("cm.envNeed", "⚠ 처음 한 번 준비가 필요해요"));
    return;
  }
  await startPrepare();
});

document.querySelectorAll("[data-pop]").forEach((p) =>
  p.addEventListener("click", (e) => {
    e.stopPropagation();
    ui.popover.hidden = !ui.popover.hidden;
  }),
);
document.addEventListener("click", (e) => {
  if (!ui.popover.hidden && !ui.popover.contains(e.target)) ui.popover.hidden = true;
});

function onAgentChange(ok, detail) {
  const busy = Bridge.isAgentLongOperationActive() || detail?.longOp;
  const wasConnected = state.connected;
  state.connected = Boolean(ok || busy);
  if (detail?.agentVersion) state.agentVersion = String(detail.agentVersion);
  if (!state.connected) {
    state.ready = false;
    state.preparing = null;
    renderStatus();
    setAiAvailable([]);
    return;
  }
  renderStatus();
  if (ok && !wasConnected) {
    void checkReadiness();
    void loadHistory();
    void resumeGeneration();
    void refreshAiStatus();
  }
}

const connectionMonitor = Bridge.startConnectionMonitor({
  intervalMs: 12_000,
  immediate: true,
  autoShowInstallDialog: true,
  installDialogOptions: installDialogOpts,
  onChange: onAgentChange,
});
window.addEventListener("focus", () => void connectionMonitor.refresh());
window.addEventListener("itz:ai-setup-ready", () => void checkReadiness());

// ---------------------------------------------------------------------------
// 생성
// ---------------------------------------------------------------------------
function currentForm() {
  const vocal = segValue(ui.vocal) || "female";
  const instrumental = vocal === "none";
  return {
    vocal,
    instrumental,
    genres: chipValues(ui.genres),
    instruments: chipValues(ui.instruments),
    vocal_styles: instrumental ? [] : chipValues(ui.vstyles),
    mood: ui.mood.value.trim(),
    tempo: segValue(ui.tempo) || "medium",
    lyrics: instrumental ? "" : ui.lyrics.value.trim(),
    vocal_language: ui.vocalLang.value || "ko",
    duration: Number(segValue(ui.duration) || -1),
    quality: segValue(ui.quality) || "speed",
    seed: Number.parseInt(ui.seed.value, 10),
  };
}

function trackTitle(form) {
  const genre = form.genres[0] ? optionLabel(GENRE_OPTIONS, form.genres[0]) : t("cm.newSong", "새 곡");
  return form.mood ? `${genre} · ${form.mood.slice(0, 24)}` : genre;
}

function buildPayload(form) {
  const captionState = {
    genres: form.genres.map((k) => optionByKey(GENRE_OPTIONS, k)?.caption).filter(Boolean),
    tempoPreset: form.tempo,
    bpmCustom: null,
    instruments: form.instruments.map((k) => optionByKey(INSTRUMENT_OPTIONS, k)?.caption).filter(Boolean),
    vocalType: form.vocal,
    vocalStyles: form.vocal_styles.map((k) => optionByKey(VOCAL_STYLE_OPTIONS, k)?.caption).filter(Boolean),
    mood: form.mood,
    instrumentalNotes: [],
  };
  const bpm = { slow: 70, medium: 110, fast: 140 }[form.tempo] || null;
  const quality = QUALITY[form.quality] || QUALITY.speed;
  const useRef = Boolean(state.refPath) && !form.instrumental;
  return {
    task_type: "text2music",
    caption: compileCaption(captionState, form.vocal_language),
    lyrics: form.instrumental ? "[Instrumental]" : form.lyrics,
    vocal_language: form.vocal_language,
    vocal_type: form.vocal,
    instrumental: form.instrumental,
    bpm,
    // 연주곡은 가사가 없어 「자동」이면 길이를 짐작할 수 없음(서버는 30초로 잡음) → 약 1분
    duration: form.duration > 0 ? Math.min(form.duration, state.maxDuration) : form.instrumental ? 60 : -1,
    batch_size: 1,
    ...quality,
    seed: Number.isFinite(form.seed) ? form.seed : -1,
    infer_method: "ode",
    audio_format: "wav",
    reference_audio_path: useRef ? state.refPath : null,
    cover_strength: useRef ? 0.55 : 1.0,
    display: {
      title: trackTitle(form),
      vocal: form.vocal,
      genres: form.genres,
      instruments: form.instruments,
      vocal_styles: form.vocal_styles,
      mood: form.mood,
      tempo: form.tempo,
      lyrics: form.lyrics,
      vocal_language: form.vocal_language,
      quality: form.quality,
      duration_choice: String(form.duration),
    },
  };
}

ui.generate.addEventListener("click", async () => {
  const problem = formProblem();
  if (problem) {
    toast(problem, { error: true });
    if (segValue(ui.vocal) !== "none" && !hasLyricText(ui.lyrics.value)) flash(ui.lyricsWrap);
    return;
  }
  if (!state.ready || state.generating) return;
  const form = currentForm();
  const payload = buildPayload(form);
  state.generating = {
    jobId: "",
    progress: 2,
    message: t("cm.genRequest", "요청하는 중"),
    title: payload.display.title,
    vocal: form.vocal,
    genres: form.genres,
  };
  renderTracks();
  updateGenerateState();
  Bridge.setAgentLongOperationActive(true);
  try {
    const res = await Bridge.fetchAgent(`${Bridge.getAgentOrigin()}${API}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : res.statusText);
    state.generating.jobId = data.job_id || "";
    void pollGeneration();
  } catch (e) {
    finishGeneration();
    toast(tf("cm.genFail", "만들지 못했어요: {msg}", { msg: locAgent(e instanceof Error ? e.message : String(e)) }), { error: true });
  }
});

function finishGeneration() {
  state.generating = null;
  Bridge.setAgentLongOperationActive(false);
  renderTracks();
  updateGenerateState();
}

let generationPolling = false;
async function pollGeneration() {
  if (generationPolling) return;
  generationPolling = true;
  try {
    while (state.generating) {
      await new Promise((r) => setTimeout(r, 1500));
      const res = await Bridge.fetchAgent(`${Bridge.getAgentOrigin()}${API}/generate/status`).catch(() => null);
      const data = res?.ok ? await res.json().catch(() => null) : null;
      if (!data || !state.generating) continue;
      if (data.status === "completed") {
        const jobId = data.job_id;
        finishGeneration();
        await loadHistory();
        const item = state.history.find((h) => h.id === jobId);
        if (item) playItem(item);
        return;
      }
      if (data.status === "failed") {
        finishGeneration();
        toast(tf("cm.genFail", "만들지 못했어요: {msg}", { msg: locAgent(data.message) }), { error: true });
        return;
      }
      if (data.status === "idle") {
        finishGeneration();
        return;
      }
      state.generating.progress = Number(data.progress) || state.generating.progress;
      state.generating.message = locAgent(data.message) || state.generating.message;
      renderTracks();
    }
  } finally {
    generationPolling = false;
  }
}

/** 페이지를 다시 열었을 때 생성 중이던 작업 이어서 표시 */
async function resumeGeneration() {
  try {
    const res = await Bridge.fetchAgent(`${Bridge.getAgentOrigin()}${API}/generate/status`);
    const data = res.ok ? await res.json() : null;
    if (!data || !["running", "pending"].includes(data.status) || state.generating) return;
    state.generating = {
      jobId: data.job_id,
      progress: Number(data.progress) || 0,
      message: locAgent(data.message),
      title: t("cm.newSong", "새 곡"),
      vocal: "",
      genres: [],
    };
    Bridge.setAgentLongOperationActive(true);
    renderTracks();
    updateGenerateState();
    void pollGeneration();
  } catch {
    /* 상태를 못 읽으면 그냥 둠 */
  }
}

// ---------------------------------------------------------------------------
// 만든 곡 목록
// ---------------------------------------------------------------------------
function coverFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COVERS[h % COVERS.length];
}
const fmtTime = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
function vocalLabel(v) {
  return {
    female: t("cm.vFemale", "여자"),
    male: t("cm.vMale", "남자"),
    duet: t("cm.vDuet", "듀엣"),
    none: t("cm.vNone", "연주곡"),
  }[v] || "";
}
function itemFile(item) {
  const path = (item.output_files || []).find(Boolean) || "";
  return path.split(/[\\/]/).pop();
}
function itemUrl(item, file = itemFile(item)) {
  return `${Bridge.getAgentOrigin()}${API}/result/${encodeURIComponent(item.id)}/${encodeURIComponent(file)}`;
}
function itemTitle(item) {
  const d = item.display || {};
  if (d.title) return d.title;
  const caption = String(item.params?.caption || "").trim();
  return caption ? caption.slice(0, 40) : `#${item.id}`;
}
function itemTags(item) {
  const d = item.display || {};
  return (d.genres || []).slice(0, 2).map((k) => optionLabel(GENRE_OPTIONS, k));
}
function itemDuration(item) {
  return Number(item.audio_duration) || Number(item.params?.duration) || 0;
}

async function loadHistory() {
  if (!state.connected) return;
  try {
    const res = await Bridge.fetchAgent(`${Bridge.getAgentOrigin()}${API}/history?limit=50`);
    const data = res.ok ? await res.json() : { items: [] };
    state.history = (data.items || []).filter((item) => itemFile(item));
  } catch {
    state.history = [];
  }
  renderTracks();
}

function renderTracks() {
  const box = ui.tracks;
  box.textContent = "";
  ui.count.textContent = tf("cm.count", "만든 곡 {n}개", { n: state.history.length });

  const g = state.generating;
  if (g) {
    const card = el("div", "cm-track");
    const cover = el("div", "cm-cover", "⏳");
    cover.style.background = COVERS[3];
    cover.style.opacity = "0.75";
    const info = el("div", "cm-info");
    info.appendChild(el("div", "cm-title", g.title || t("cm.newSong", "새 곡")));
    const meta = el("div", "cm-meta");
    if (g.vocal) meta.appendChild(el("span", "cm-tag-v", vocalLabel(g.vocal)));
    meta.appendChild(el("span", "cm-tag-s", tf("cm.making", "만드는 중 {p}%", { p: Math.round(g.progress || 0) })));
    info.appendChild(meta);
    const prog = el("div", "cm-progress");
    const fill = el("div");
    fill.style.width = `${Math.max(2, Math.min(100, g.progress || 0))}%`;
    prog.appendChild(fill);
    const msg = el("div", "cm-dur", "");
    msg.style.width = "auto";
    msg.textContent = g.message || "";
    card.append(cover, info, prog, msg);
    box.appendChild(card);
  }

  if (!state.history.length && !g) {
    box.appendChild(
      el("div", "cm-empty", t("cm.empty", "아직 만든 곡이 없어요. 왼쪽에서 장르를 고르고 「음악 만들기」를 눌러 보세요.")),
    );
    return;
  }

  state.history.forEach((item) => {
    const playing = player.item?.id === item.id;
    const card = el("div", `cm-track${playing ? " is-playing" : ""}`);
    card.dataset.id = item.id;

    const cover = el("div", "cm-cover");
    cover.style.background = coverFor(item.id);
    const play = el("button", "cm-play", playing && !player.audio.paused ? "❚❚" : "▶");
    play.type = "button";
    play.setAttribute("aria-label", t("cm.play", "재생"));
    play.addEventListener("click", () => playItem(item));
    cover.appendChild(play);

    const info = el("div", "cm-info");
    const title = el("div", "cm-title", itemTitle(item));
    title.title = itemTitle(item);
    info.appendChild(title);
    const meta = el("div", "cm-meta");
    const vocal = vocalLabel(item.display?.vocal);
    if (vocal) meta.appendChild(el("span", "cm-tag-v", vocal));
    itemTags(item).forEach((tag) => meta.appendChild(el("span", "cm-tag-s", tag)));
    if (item.display?.quality === "quality") meta.appendChild(el("span", "cm-tag-s", t("cm.qHigh", "고품질")));
    info.appendChild(meta);

    const wave = el("div", "cm-wave");
    const peaks = Array.isArray(item.peaks) && item.peaks.length ? item.peaks : Array(48).fill(0.3);
    peaks.forEach((p) => {
      const bar = el("div", "cm-bar");
      bar.style.height = `${Math.max(8, Math.round(Number(p) * 100))}%`;
      wave.appendChild(bar);
    });
    wave.addEventListener("click", (e) => {
      const rect = wave.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      playItem(item, { at: ratio });
    });

    const actions = el("div", "cm-actions");
    ["MP3", "WAV"].forEach((fmt) => {
      const b = el("button", "cm-small-btn", fmt);
      b.type = "button";
      b.title = tf("cm.dlTitle", "{f}로 받기", { f: fmt });
      b.addEventListener("click", () => goDownload(item, fmt.toLowerCase()));
      actions.appendChild(b);
    });
    const reuse = el("button", "cm-icon-btn", "↺");
    reuse.type = "button";
    reuse.title = t("cm.reuse", "이 곡 설정 다시 쓰기");
    reuse.addEventListener("click", () => applyDisplay(item));
    actions.appendChild(reuse);

    card.append(cover, info, wave, el("div", "cm-dur", fmtTime(itemDuration(item))), actions);
    box.appendChild(card);
  });
  paintProgress();
}

/** MP3·WAV → 다운로드 페이지로 같은 탭 이동 (페이지 이동 때 전면 광고가 뜰 수 있게) */
function goDownload(item, format) {
  const file = itemFile(item);
  const origin = Bridge.getAgentOrigin();
  try {
    sessionStorage.setItem(STORAGE.jobId, item.id);
    sessionStorage.setItem(STORAGE.filename, file);
    sessionStorage.setItem(STORAGE.source, itemTitle(item));
    sessionStorage.setItem(STORAGE.mp3Url, `${origin}${API}/download-mp3/${encodeURIComponent(item.id)}?filename=${encodeURIComponent(file)}`);
    sessionStorage.setItem(STORAGE.wavUrl, itemUrl(item, file));
    sessionStorage.setItem(STORAGE.format, format);
  } catch {
    toast(t("cm.dlStoreFail", "브라우저 저장소를 쓸 수 없어 다운로드 페이지를 열 수 없어요."), { error: true });
    return;
  }
  window.location.assign(new URL(DOWNLOAD_PAGE, window.location.href).href);
}

/** 「이 곡 설정 다시 쓰기」 — 기록에 저장한 화면 설정을 왼쪽에 채움 */
function applyDisplay(item) {
  const d = item.display || {};
  if (!d.vocal && !d.genres) {
    toast(t("cm.reuseNone", "이 곡은 예전 화면에서 만들어 설정을 불러올 수 없어요."), { error: true });
    return;
  }
  applyFormPatch({
    vocal: d.vocal,
    genres: d.genres,
    instruments: d.instruments,
    vocal_styles: d.vocal_styles,
    mood: d.mood,
    tempo: d.tempo,
    lyrics: d.lyrics,
    vocal_language: d.vocal_language,
    quality: d.quality,
    duration: d.duration_choice,
  });
  toast(t("cm.reuseOk", "이 곡의 설정을 왼쪽에 불러왔어요."));
}

/** 왼쪽 입력 칸 일부/전체 바꾸기 (설정 다시 쓰기·AI 작곡 도우미 공용) */
function applyFormPatch(p) {
  const changed = [];
  if (p.vocal && setSeg(ui.vocal, p.vocal)) changed.push(ui.vocal);
  if (Array.isArray(p.genres)) {
    setChips(ui.genres, GENRE_OPTIONS, p.genres, { limit: GENRES_VISIBLE });
    changed.push(ui.genres);
  }
  if (Array.isArray(p.instruments)) setChips(ui.instruments, INSTRUMENT_OPTIONS, p.instruments);
  if (Array.isArray(p.vocal_styles)) setChips(ui.vstyles, VOCAL_STYLE_OPTIONS, p.vocal_styles);
  if (typeof p.mood === "string") {
    ui.mood.value = p.mood;
    changed.push(ui.mood);
  }
  if (p.tempo) setSeg(ui.tempo, p.tempo);
  if (typeof p.lyrics === "string") {
    ui.lyrics.value = p.lyrics;
    changed.push(ui.lyricsWrap);
  }
  if (p.vocal_language && ui.vocalLang.querySelector(`option[value="${CSS.escape(p.vocal_language)}"]`)) {
    ui.vocalLang.value = p.vocal_language;
  }
  if (p.quality) setSeg(ui.quality, p.quality);
  if (p.duration != null && p.duration !== "") setSeg(ui.duration, String(p.duration));
  syncVocalUi();
  changed.forEach(flash);
}

// ---------------------------------------------------------------------------
// 플레이어
// ---------------------------------------------------------------------------
const player = { audio: new Audio(), item: null };
player.audio.preload = "metadata";
player.audio.volume = 0.8;

function playItem(item, { at = null } = {}) {
  if (player.item?.id === item.id && at == null) {
    if (player.audio.paused) void player.audio.play().catch(() => {});
    else player.audio.pause();
    return;
  }
  if (player.item?.id !== item.id) {
    player.item = item;
    player.audio.src = itemUrl(item);
    ui.pThumb.style.background = coverFor(item.id);
    ui.pTitle.textContent = itemTitle(item);
    ui.pSub.textContent = [vocalLabel(item.display?.vocal), ...itemTags(item)].filter(Boolean).join(" · ");
    ui.pTot.textContent = fmtTime(itemDuration(item));
    ui.pPlay.disabled = false;
    ui.pSeek.disabled = false;
  }
  const start = () => {
    if (at != null && Number.isFinite(player.audio.duration)) player.audio.currentTime = at * player.audio.duration;
    void player.audio.play().catch((e) => toast(tf("cm.playFail", "재생하지 못했어요: {msg}", { msg: e.message }), { error: true }));
  };
  if (player.audio.readyState >= 1) start();
  else player.audio.addEventListener("loadedmetadata", start, { once: true });
  renderTracks();
}

function paintProgress() {
  const a = player.audio;
  const dur = Number.isFinite(a.duration) ? a.duration : itemDuration(player.item || {});
  const ratio = dur > 0 ? a.currentTime / dur : 0;
  ui.pCur.textContent = fmtTime(a.currentTime);
  if (dur > 0) ui.pTot.textContent = fmtTime(dur);
  if (document.activeElement !== ui.pSeek) ui.pSeek.value = String(Math.round(ratio * 1000));
  ui.pPlay.textContent = a.paused ? "▶" : "❚❚";
  if (!player.item) return;
  const card = ui.tracks.querySelector(`.cm-track[data-id="${CSS.escape(player.item.id)}"]`);
  if (!card) return;
  const bars = card.querySelectorAll(".cm-bar");
  const on = Math.floor(ratio * bars.length);
  bars.forEach((b, i) => b.classList.toggle("is-on", i < on));
  const btn = card.querySelector(".cm-play");
  if (btn) btn.textContent = a.paused ? "▶" : "❚❚";
}

player.audio.addEventListener("timeupdate", paintProgress);
player.audio.addEventListener("play", paintProgress);
player.audio.addEventListener("pause", paintProgress);
player.audio.addEventListener("ended", () => {
  player.audio.currentTime = 0;
  paintProgress();
});
player.audio.addEventListener("error", () => {
  if (player.item) toast(t("cm.playErr", "곡 파일을 불러오지 못했어요. 에이전트가 켜져 있는지 확인해 주세요."), { error: true });
});
ui.pPlay.addEventListener("click", () => {
  if (!player.item) return;
  if (player.audio.paused) void player.audio.play().catch(() => {});
  else player.audio.pause();
});
ui.pSeek.addEventListener("input", () => {
  const dur = player.audio.duration;
  if (Number.isFinite(dur)) player.audio.currentTime = (Number(ui.pSeek.value) / 1000) * dur;
});
ui.pVol.addEventListener("input", () => {
  player.audio.volume = Number(ui.pVol.value) / 100;
});

// ---------------------------------------------------------------------------
// AI 작곡 도우미 (MCP·AI CLI가 연결된 사람만)
// ---------------------------------------------------------------------------
const AI_CLIENT_ORDER = ["claude", "codex", "antigravity"];

function setAiAvailable(clients) {
  const had = state.aiClients.length > 0;
  state.aiClients = clients;
  const on = clients.length > 0;
  ui.aiBtn.disabled = !on;
  ui.aiBtn.title = on ? "" : t("cm.aiOff", "AI 채팅(Claude·Codex CLI)을 연결하면 쓸 수 있어요");
  if (!on) setChat(false);
  else if (!had) setChat(true); // 연결된 사람은 처음부터 열어 둠
}

function setChat(open) {
  ui.chat.hidden = !open;
  ui.aiBtn.classList.toggle("is-on", open);
  if (open && !ui.chatMsgs.childElementCount) {
    addBubble("ai", t("cm.aiHello", "어떤 곡을 만들고 싶은지 말해 주세요. 장르·분위기·가사를 왼쪽에 채워 드릴게요."));
  }
}

async function refreshAiStatus() {
  try {
    const res = await Bridge.fetchAgent(`${Bridge.getAgentOrigin()}${API}/ai/status`);
    const data = res.ok ? await res.json() : null;
    const clients = Array.isArray(data?.configuredClients) ? data.configuredClients : [];
    setAiAvailable(clients.filter((c) => AI_CLIENT_ORDER.includes(c)));
  } catch {
    setAiAvailable([]);
  }
}

function addBubble(kind, text) {
  const b = el("div", `cm-bubble is-${kind}`, text);
  ui.chatMsgs.appendChild(b);
  ui.chatMsgs.scrollTop = ui.chatMsgs.scrollHeight;
  return b;
}

async function sendChat() {
  const text = ui.chatIn.value.trim();
  if (!text || state.aiBusy || !state.aiClients.length) return;
  const client = AI_CLIENT_ORDER.find((c) => state.aiClients.includes(c));
  ui.chatIn.value = "";
  addBubble("me", text);
  const pending = addBubble("ai", t("cm.aiThinking", "생각하는 중… (10~30초)"));
  state.aiBusy = true;
  ui.chatSend.disabled = true;
  try {
    const form = currentForm();
    const res = await Bridge.fetchAgent(`${Bridge.getAgentOrigin()}${API}/ai/compose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client,
        instruction: text,
        form: { ...form, max_duration: state.maxDuration },
        history: state.aiHistory.slice(-6),
      }),
    });
    const started = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof started.detail === "string" ? started.detail : res.statusText);
    let result = null;
    for (let i = 0; i < 620 && !result; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = await Bridge.fetchAgent(`${Bridge.getAgentOrigin()}${API}/ai/compose?jobId=${encodeURIComponent(started.jobId)}`);
      const data = await s.json().catch(() => ({}));
      if (!s.ok) throw new Error(typeof data.detail === "string" ? data.detail : s.statusText);
      if (data.status === "error") throw new Error(data.message || "error");
      if (data.status === "done") result = data;
    }
    if (!result) throw new Error(t("cm.aiTimeout", "응답이 너무 오래 걸려요. 다시 요청해 주세요."));
    pending.remove();
    const reply = result.message || t("cm.aiApplied", "왼쪽에 채웠어요. 마음에 들면 「음악 만들기」를 눌러 주세요.");
    addBubble("ai", reply);
    if (result.patch && Object.keys(result.patch).length) applyFormPatch(result.patch);
    state.aiHistory.push({ role: "user", text }, { role: "assistant", text: reply });
  } catch (e) {
    pending.remove();
    addBubble("err", tf("cm.aiFail", "도우미가 답하지 못했어요: {msg}", { msg: e instanceof Error ? e.message : String(e) }));
  } finally {
    state.aiBusy = false;
    ui.chatSend.disabled = false;
  }
}

ui.aiBtn.addEventListener("click", () => {
  if (!ui.aiBtn.disabled) setChat(ui.chat.hidden);
});
ui.chatClose.addEventListener("click", () => setChat(false));
ui.chatSend.addEventListener("click", () => void sendChat());
ui.chatIn.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void sendChat();
  }
});
setInterval(() => {
  if (state.connected) void refreshAiStatus();
}, 60_000);

// ---------------------------------------------------------------------------
// 언어 변경 · 시작
// ---------------------------------------------------------------------------
document.addEventListener("itz:lang-change", () => {
  renderAllChips();
  syncVocalUi();
  syncRefUi();
  renderStatus();
  renderTracks();
});

renderAllChips();
syncVocalUi();
syncRefUi();
renderStatus();
renderTracks();
void showAdSense("editorAboveWorkspace", "#editor-ad-above-tabs");
