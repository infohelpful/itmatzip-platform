/**
 * 모션그래픽도구 화면 — 영상+SRT → 스타일 프리셋 → ① AI 설계서 → (수정 요청) → ② 설계대로 적용(미리보기) → ③ MP4 내보내기.
 * 미리보기는 mg-core.js composeFrame 을 그대로 그리므로 최종 MP4 와 같은 화면이다.
 */
import {
  applyConnectionStatusDot,
  checkAgentConnection,
  configureBridge,
  formatAgentConnectionError,
  getAgentOrigin,
  primeLocalNetworkAccess,
  requestAgent,
  setAgentLongOperationActive,
  showInstallAgentDialog,
  startConnectionMonitor,
} from "../common/bridge.js?v=lna30";
import { AGENT_PICK_VIDEO } from "../common/agent-pick-endpoints.js";
import { showAdSense } from "../common/adsense.js?v=12";
import { agentInstallDialogOptions } from "../common/agent-install-ui.js?v=lna22";
import { AGENT_PORT } from "../common/agent-endpoints.js";
import { TEMPLATE_META, findSegment, resolveStyle } from "./mg-core.js?v=8";
import { DesignRenderer } from "./mg-renderer.js?v=5";

configureBridge({
  origin:
    (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") && Number(window.location.port || "0") === AGENT_PORT
      ? window.location.origin
      : undefined,
  healthPath: "/health",
});

const API = "/api/tools/motion-graphic";
const LS = { media: "motion-graphic:media", last: "motion-graphic:last-project", style: "motion-graphic:style", ai: "motion-graphic:ai-client", gap: "motion-graphic:gap", still: "motion-graphic:still" };
const SS = { pid: "motion-graphic:dl-project", output: "motion-graphic:dl-output", name: "motion-graphic:dl-name", encoder: "motion-graphic:dl-encoder" };
const AI_LABEL = { claude: "Claude Code", codex: "Codex", antigravity: "Antigravity" };
const TPL = Object.fromEntries(TEMPLATE_META.map((m) => [m.id, m]));

const t = (key, fallback) => (typeof window.itzT === "function" ? window.itzT(key, fallback) : fallback);
const $ = (id) => document.getElementById(id);
const lsGet = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 저장 불가 */
  }
};

const els = {
  connection: $("connection-status"), readiness: $("bin-readiness"), prepare: $("btn-prepare"),
  styleList: $("style-list"), styleDialog: $("style-dialog"), styleHistory: $("style-history"), styleClose: $("style-dialog-close"), aiClients: $("ai-clients"), aiHint: $("ai-hint"), gap: $("gap"), gapValue: $("gap-value"), optStill: $("opt-still"),
  directives: $("directives"), dirFile: $("dir-file"),
  stDuration: $("st-duration"), stSubs: $("st-subs"), stSegs: $("st-segs"), stRes: $("st-res"), stDesign: $("st-design"), stApply: $("st-apply"),
  btnDesign: $("btn-design"), btnApply: $("btn-apply"), btnRender: $("btn-render"), btnOpenDir: $("btn-open-dir"),
  btnUimg: $("btn-uimg"), uimgFile: $("uimg-file"), uimgList: $("uimg-list"), uimgDialog: $("uimg-dialog"), uimgClose: $("uimg-close"), uimgPreview: $("uimg-preview"), uimgFrom: $("uimg-from"), uimgTo: $("uimg-to"), uimgCaption: $("uimg-caption"), uimgPlace: $("uimg-place"),
  videoPath: $("video-path"), pickVideo: $("btn-pick-video"), srtFile: $("srt-file"), srtName: $("srt-name"), load: $("btn-load"), recent: $("recent"),
  tc: $("tc"), stepMsg: $("step-msg"), jobMsg: $("job-msg"), jobCancel: $("btn-job-cancel"),
  work: $("work"), drop: $("drop"), initProgress: $("init-progress"), initBar: $("init-bar"), initText: $("init-text"),
  doc: $("doc"), docStats: $("doc-stats"), docBar: $("doc-bar"), docList: $("doc-list"),
  preview: $("preview"), stage: $("stage"), zoomBox: $("zoom-box"), video: $("video"), fxRoot: $("fx-root"), fullRoot: $("full-root"), pvOff: $("pv-off"),
  play: $("btn-play"), segPrev: $("seg-prev"), segCur: $("seg-cur"), segNext: $("seg-next"), subNow: $("sub-now"), tl: $("tl"), tlCanvas: $("tl-canvas"),
  jobPanel: $("job-panel"), jobTitle: $("job-title"), jobSub: $("job-sub"), jobSteps: $("job-steps"), jobHint: $("job-hint"), jobStop: $("btn-job-stop"),
  editFetch: $("edit-fetch"), editTarget: $("edit-target"), editInput: $("edit-input"), editBtn: $("btn-edit"),
  renderOverlay: $("render-loading"), renderStep: $("render-step"), renderPct: $("render-percent"), renderBar: $("render-bar"), renderCancel: $("btn-render-cancel"),
};

const st = {
  agentOk: false,
  ready: false,
  media: ["photo", "logo", "emoji", "video"].includes(lsGet(LS.media)) ? lsGet(LS.media) : "photo",
  styleRef: lsGet(LS.style) || null, // 보관함 디자인 id (없으면 새 디자인)
  styles: [],
  aiClients: [],
  uimgs: [], // 내가 올린 이미지
  aiClient: lsGet(LS.ai) || null,
  pid: null,
  project: null,
  analysis: null,
  range: null, // 타임라인에서 고른 시간 범위 {a, b} (프레임)
  subs: [],
  waveform: [],
  design: null,
  view: "design",
  sel: null,
  job: null,
  jobTimer: 0,
  pollTimer: 0,
  srtText: "",
  srtName: "",
  renderJob: null,
};

const renderer = new DesignRenderer({ zoomBox: els.zoomBox, fxRoot: els.fxRoot, fullRoot: els.fullRoot }, (name) =>
  `${getAgentOrigin()}${API}/assets/${encodeURIComponent(st.pid || "")}/${name.split("/").map(encodeURIComponent).join("/")}`);

/* ── 공통 ─────────────────────────────────────────────────────────── */

function fps() {
  return st.design?.fps?.value || st.project?.fps?.value || 30;
}

function fmtSec(sec) {
  const s = Math.max(0, sec || 0);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
}

function timecode(frame) {
  const f = Math.max(0, frame);
  const r = Math.round(fps());
  const total = Math.floor(f / fps());
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}:${pad(Math.floor(f % r))}`;
}

function showError(err) {
  if (st.job?.state !== "running") renderJobPanel(null); // 시작 요청이 실패하면 「작성 중」 패널을 닫는다
  alert(String(err?.message || err));
}

function currentFrame() {
  return Math.max(0, Math.floor(els.video.currentTime * fps() + 1e-4));
}

function seekFrame(frame) {
  els.video.currentTime = (frame + 0.5) / fps();
}

/* ── 준비 상태 ────────────────────────────────────────────────────── */

async function checkReadiness() {
  const data = await requestAgent({ method: "GET", path: `${API}/readiness` });
  const b = data?.binaries || {};
  st.ready = Boolean(b.ready);
  els.readiness.className = `mg-chip ${st.ready ? "is-info" : "is-warn"}`;
  els.readiness.textContent = st.ready ? t("readyOk", "Premotion · FFmpeg 준비됨") : t("needEnv", "Premotion · 환경 준비 필요");
  els.prepare.hidden = st.ready;
  updateSteps();
}

async function runPrepare() {
  setAgentLongOperationActive(true);
  try {
    await requestAgent({ method: "POST", path: `${API}/prepare?force=true` });
    for (;;) {
      const s = await requestAgent({ method: "GET", path: `${API}/prepare/status` });
      els.readiness.textContent = `${Math.round(s.progress || 0)}% · ${s.message || ""}`;
      if (s.phase === "ready" || s.phase === "failed") {
        if (s.phase === "failed") showError(s.message);
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    setAgentLongOperationActive(false);
    await checkReadiness().catch(() => {});
  }
}

/* ── 스타일 프리셋 · AI ────────────────────────────────────────────── */

async function loadStyles() {
  try {
    st.styles = (await requestAgent({ method: "GET", path: `${API}/styles?exclude=${encodeURIComponent(st.pid || "")}` })).styles || [];
  } catch {
    st.styles = [];
  }
  if (st.styleRef && !st.styles.some((x) => x.id === st.styleRef)) st.styleRef = null;
  renderStyles();
}

function swatch(x, cls = "") {
  const wrap = document.createElement("div");
  wrap.className = `mg-hist__colors ${cls}`;
  const tile = document.createElement("div");
  tile.className = "mg-hist__tile";
  tile.style.background = `linear-gradient(135deg, ${x.colors.deep}, ${x.colors.bg})`;
  tile.style.color = x.colors.accent;
  tile.style.boxShadow = `0 0 10px ${x.colors.primary}66`;
  tile.textContent = "Aa";
  const chips = document.createElement("div");
  chips.className = "mg-hist__chips";
  chips.innerHTML = ["bg", "primary", "sky", "accent"].map((k) => `<i style="background:${x.colors[k]}"></i>`).join("");
  wrap.append(tile, chips);
  return wrap;
}

function historyMeta(x) {
  const date = x.created ? x.created.slice(0, 10) : "";
  const dur = x.duration_sec ? ` · ${fmtSec(x.duration_sec).replace(/\.\d+$/, "")}` : "";
  return `${x.style_name}${date ? ` · ${date}` : ""}${dur}`;
}

function renderStyles() {
  const cur = st.styleRef ? st.styles.find((x) => x.id === st.styleRef) : null;
  const newCard = document.createElement("button");
  newCard.type = "button";
  newCard.className = `mg-style mg-style--new${cur ? "" : " is-on"}`;
  newCard.setAttribute("role", "radio");
  newCard.setAttribute("aria-checked", cur ? "false" : "true");
  newCard.innerHTML = '<div class="mg-style__mock"><span class="mg-style__tile">✨</span><span class="mg-style__txt"><b></b><small></small></span></div>';
  newCard.querySelector("b").textContent = t("styleNew", "새 디자인 (AI 가 영상에 맞게 생성)");
  newCard.querySelector("small").textContent = t("styleNewNote", "색·배경·움직임을 이번 영상만의 것으로");
  newCard.addEventListener("click", () => {
    st.styleRef = null;
    lsSet(LS.style, "");
    renderStyles();
  });
  const nodes = [newCard];
  if (cur) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "mg-hist is-on";
    card.append(swatch(cur));
    const txt = document.createElement("div");
    txt.innerHTML = '<div class="mg-hist__name"></div><div class="mg-hist__meta"></div>';
    txt.querySelector(".mg-hist__name").textContent = cur.name;
    txt.querySelector(".mg-hist__meta").textContent = `${t("styleSelected", "선택한 디자인")} · ${historyMeta(cur)}`;
    card.append(txt);
    card.title = t("styleClear", "누르면 새 디자인으로 되돌립니다");
    card.addEventListener("click", () => newCard.click());
    nodes.push(card);
  }
  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "mg-btn mg-btn--ghost mg-btn--sm mg-style-pick";
  pick.textContent = t("stylePick", "이전 작업에서 선택 ▸");
  pick.addEventListener("click", () => void openStyleDialog());
  nodes.push(pick);
  els.styleList.replaceChildren(...nodes);
}

async function openStyleDialog() {
  await loadStyles();
  const list = els.styleHistory;
  if (!st.styles.length) {
    list.innerHTML = `<li class="mg-hist__empty">${t("styleNone", "아직 만든 작업이 없습니다.")}</li>`;
  } else {
    list.replaceChildren(
      ...st.styles.map((x) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.className = `mg-hist${x.id === st.styleRef ? " is-on" : ""}`;
        b.append(swatch(x));
        const txt = document.createElement("div");
        txt.innerHTML = '<div class="mg-hist__name"></div><div class="mg-hist__meta"></div>';
        txt.querySelector(".mg-hist__name").textContent = x.name;
        txt.querySelector(".mg-hist__meta").textContent = historyMeta(x);
        b.append(txt);
        b.addEventListener("click", () => {
          st.styleRef = x.id;
          lsSet(LS.style, x.id);
          renderStyles();
          els.styleDialog.close();
        });
        li.append(b);
        return li;
      }),
    );
  }
  els.styleDialog.showModal();
}

async function loadAiClients() {
  try {
    st.aiClients = (await requestAgent({ method: "GET", path: `${API}/ai/clients` })).clients || [];
  } catch {
    st.aiClients = [];
  }
  const installed = st.aiClients.filter((c) => c.installed).map((c) => c.id);
  if (!installed.includes(st.aiClient)) st.aiClient = installed[0] || null;
  renderAiClients();
}

function renderAiClients() {
  const list = st.aiClients.length ? st.aiClients : Object.keys(AI_LABEL).map((id) => ({ id, installed: false }));
  els.aiClients.replaceChildren(
    ...list.map((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = c.id === st.aiClient ? "is-on" : "";
      b.disabled = !c.installed;
      b.innerHTML = "<span></span><small></small>";
      b.querySelector("span").textContent = AI_LABEL[c.id] || c.id;
      b.querySelector("small").textContent = c.installed ? (c.logged_in === false ? t("aiLogin", "로그인 필요") : t("aiOk", "사용 가능")) : t("aiNo", "설치 안 됨");
      b.addEventListener("click", () => {
        st.aiClient = c.id;
        lsSet(LS.ai, c.id);
        renderAiClients();
        updateSteps();
      });
      return b;
    }),
  );
  els.aiHint.textContent = list.some((c) => c.installed)
    ? t("aiHint", "내 PC에 로그인된 AI CLI를 씁니다. 요금은 각 AI 구독에서 나갑니다.")
    : t("aiNone", "설치된 AI CLI 가 없습니다. 트레이 → AI MCP 설정에서 설치·로그인하세요.");
}

function instructionText() {
  const parts = [`OVERLAY 효과·FULL 비트 사이 간격은 최소 ${els.gap.value}초`];
  if (!els.optStill.checked) parts.push("정지 화면이라도 지시가 없으면 FULL 로 자동 전환하지 말 것");
  return parts.join(". ");
}

/* ── 프로젝트 ─────────────────────────────────────────────────────── */

async function pickVideo() {
  if (!st.agentOk) return showInstallAgentDialog(agentInstallDialogOptions());
  const data = await requestAgent({ method: "POST", path: AGENT_PICK_VIDEO });
  const path = data?.video_path || data?.path || "";
  if (path) els.videoPath.value = path;
}

async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("euc-kr").decode(buf);
  }
}

async function createProject() {
  const video = els.videoPath.value.trim();
  if (!video) {
    await pickVideo();
    if (!els.videoPath.value.trim()) return;
    return createProject();
  }
  const body = { video_path: video };
  if (st.srtText) Object.assign(body, { srt_text: st.srtText, srt_name: st.srtName });
  const res = await requestAgent({ method: "POST", path: `${API}/project/init`, json: body });
  await openProject(res.project_id);
  void loadRecent();
}

async function waitPreprocess(pid) {
  els.drop.hidden = true;
  els.initProgress.hidden = false;
  for (;;) {
    const r = await requestAgent({ method: "GET", path: `${API}/project/${pid}/revision` });
    els.initBar.style.width = `${r.progress || 0}%`;
    els.initText.textContent = r.message || "";
    if (r.phase === "ready") break;
    if (r.phase === "failed") throw new Error(r.message || "전처리 실패");
    await new Promise((res) => setTimeout(res, 800));
  }
  els.initProgress.hidden = true;
}

async function openProject(pid) {
  stopPolling();
  await requestAgent({ method: "POST", path: `${API}/project/${pid}/open` });
  st.pid = pid;
  lsSet(LS.last, pid);
  const first = await requestAgent({ method: "GET", path: `${API}/project/${pid}` });
  if (first.project.phase !== "ready") await waitPreprocess(pid);
  const data = await requestAgent({ method: "GET", path: `${API}/project/${pid}?include=subs,waveform` });
  st.project = data.project;
  st.analysis = data.analysis || null;
  st.subs = Object.entries(data.subs || {}).map(([n, s]) => ({ n: Number(n), ...s })).sort((a, b) => a.n - b.n);
  st.waveform = data.waveform?.levels || [];
  st.design = data.design || null;
  st.sel = null;
  if (st.design?.directives && !els.directives.value) els.directives.value = st.design.directives;
  void loadStyles();
  void loadUserImages();
  els.recent.value = pid;
  els.videoPath.value = st.project.video_path || "";
  els.srtName.value = st.project.srt_name || "";
  els.drop.hidden = true;
  els.video.src = `${getAgentOrigin()}${API}/media/${encodeURIComponent(pid)}`;
  els.video.load();
  els.stage.style.aspectRatio = `${st.project.w} / ${st.project.h}`;
  for (const layer of [els.fxRoot, els.fullRoot]) {
    layer.style.width = `${st.project.w}px`;
    layer.style.height = `${st.project.h}px`;
  }
  fitLayers();
  setView(st.design ? st.view : "design");
  refreshAll();
  if (data.job?.state === "running") {
    applyJob(data.job);
    void pollJob(data.job.job_id);
  }
  startPolling();
}

async function loadRecent() {
  try {
    const data = await requestAgent({ method: "GET", path: `${API}/projects?limit=15` });
    const keep = st.pid || "";
    els.recent.replaceChildren(new Option(t("recent", "최근 프로젝트"), ""));
    for (const p of data.projects || []) {
      if (p.phase !== "ready") continue;
      const dur = p.duration_sec ? ` · ${fmtSec(p.duration_sec).replace(/\.\d+$/, "")}` : "";
      els.recent.appendChild(new Option(`${p.video_name || p.id}${dur} · ${String(p.created || "").slice(5, 16).replace("T", " ")}`, p.id));
    }
    els.recent.value = keep;
    return data;
  } catch {
    return null;
  }
}

/* 다른 곳(MCP·다른 탭)에서 설계서가 바뀌면 다시 읽는다 */
function startPolling() {
  stopPolling();
  st.pollTimer = setInterval(async () => {
    if (!st.pid || document.hidden || st.job?.state === "running") return;
    try {
      const r = await requestAgent({ method: "GET", path: `${API}/project/${st.pid}/revision` });
      if ((st.design?.revision || 0) !== r.revision) await reloadDesign();
    } catch {
      /* 다음 주기 */
    }
  }, 2000);
}

function stopPolling() {
  clearInterval(st.pollTimer);
}

async function reloadDesign() {
  const data = await requestAgent({ method: "GET", path: `${API}/project/${st.pid}` });
  st.design = data.design || null;
  renderer.invalidate();
  refreshAll();
}

/* ── AI 작업 (설계 · 수정) ─────────────────────────────────────────── */

const STEP_LABEL = { analyze: "화면 분석", design: "AI 설계 (구간 · 장면)", assets: "웹 자료 받기", locate: "하이라이트 위치 측정", edit: "구간 재설계" };

function applyJob(job) {
  st.job = job;
  const running = job?.state === "running";
  els.jobCancel.hidden = !running;
  if (job) {
    const now = Date.now() / 1000;
    const stepTxt = (job.steps || [])
      .map((s) => {
        const mark = s.state === "done" ? "✓" : s.state === "running" ? `… ${Math.round(now - (s.started || now))}초` : s.state === "failed" ? "✗" : "";
        return `${STEP_LABEL[s.key] || s.key}${mark ? ` ${mark}` : ""}`;
      })
      .join(" → ");
    els.jobMsg.textContent = running ? `${job.client_name} · ${stepTxt}` : `${job.client_name} · ${job.message || ""}`;
    els.jobMsg.classList.toggle("is-error", job.state === "failed");
  }
  renderJobPanel(job);
  updateSteps();
}

/* 설계·수정이 도는 동안 작업 영역 가운데에 크게 보여 준다 (상태 바 한 줄로는 안 보인다) */
function renderJobPanel(job) {
  const running = job?.state === "running";
  els.jobPanel.hidden = !running || (job.kind === "edit" && job.preview_ready);
  if (!running || (job.kind === "edit" && job.preview_ready)) return;
  const now = Date.now() / 1000;
  const total = Math.max(0, Math.round(now - (job.created || now)));
  els.jobTitle.textContent = job.kind === "edit" ? t("jobEdit", "AI 가 구간을 고치는 중입니다") : t("jobDesign", "AI 가 설계서를 쓰는 중입니다");
  const dur = st.project?.duration_sec ? fmtSec(st.project.duration_sec).replace(/\.\d+$/, "") : "";
  els.jobSub.textContent = `${job.client_name} · ${dur ? `영상 ${dur} · ` : ""}${st.subs.length ? `자막 ${st.subs.length}줄 · ` : ""}${total}초 경과`;
  els.jobSteps.replaceChildren(
    ...(job.steps || []).map((s) => {
      const li = document.createElement("li");
      li.className = `is-${s.state}`;
      const sec = s.state === "running" ? `${Math.round(now - (s.started || now))}초` : s.state === "done" ? `✓ ${s.elapsed ?? ""}초 ${s.message || ""}` : s.state === "failed" ? "✗" : "대기";
      li.innerHTML = "<span></span><span></span>";
      li.firstChild.textContent = STEP_LABEL[s.key] || s.key;
      li.lastChild.textContent = sec;
      return li;
    }),
  );
  els.jobHint.textContent =
    job.kind === "edit"
      ? t("jobHintEdit", "보통 20~60초 걸립니다.")
      : t("jobHint", "AI 설계는 30초 영상 약 30초, 10분 영상 2~5분 걸립니다(AI 마다 다름). 이 창을 닫아도 작업은 계속되고, 다시 열면 이어서 보입니다.");
}

async function pollJob(jobId) {
  clearTimeout(st.jobTimer);
  try {
    const job = await requestAgent({ method: "GET", path: `${API}/design/${jobId}` });
    const previewJustReady = job.kind === "edit" && job.preview_ready && !st.job?.preview_ready;
    applyJob(job);
    if (previewJustReady) {
      await reloadDesign();
      setView("design");
    }
    if (job.state === "running") {
      st.jobTimer = setTimeout(() => void pollJob(jobId), 1000);
      return;
    }
    setAgentLongOperationActive(false);
    await reloadDesign();
    if (job.state === "done") {
      // 품질 검사를 통과해 자동 적용된 설계는 바로 미리보기로 연다.
      setView(st.design?.applied ? "preview" : "design");
      const edited = job.kind === "edit" ? job.steps?.[0]?.segments?.[0] : null;
      if (edited) {
        st.sel = edited;
        renderDoc();
        if (st.design?.applied) {
          const seg = st.design.segments.find((s) => s.id === edited);
          if (seg) seekFrame(seg.from);
        } else {
          $(`seg-${edited}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      } else {
        els.doc.scrollTop = 0;
      }
    }
    if (job.state === "failed") showError(job.message);
  } catch {
    st.jobTimer = setTimeout(() => void pollJob(jobId), 2500);
  }
}

async function runDesign() {
  if (!st.pid || st.job?.state === "running") return;
  if (st.design && !confirm(t("redoConfirm", "지금 설계서를 버리고 새로 만듭니다. 계속할까요?"))) return;
  // 서버 응답 전에도 바로 「설계서 작성 중」을 띄운다
  setView("design");
  renderJobPanel({ state: "running", kind: "design", client_name: AI_LABEL[st.aiClient] || "", created: Date.now() / 1000, steps: [
    { key: "analyze", state: "running", started: Date.now() / 1000 }, { key: "design", state: "queued" }, { key: "locate", state: "queued" }] });
  let job;
  try {
    job = await requestAgent({
      method: "POST",
      path: `${API}/project/${st.pid}/design`,
      json: { client: st.aiClient, style: st.styleRef, media: st.media, directives: els.directives.value, instruction: instructionText() },
    });
  } catch (err) {
    renderJobPanel(null);
    throw err;
  }
  setAgentLongOperationActive(true);
  applyJob(job);
  void pollJob(job.job_id);
}

async function runEdit(over = {}) {
  const request = String(over.request ?? els.editInput.value).trim();
  if (!request || !st.pid) return;
  const atFrame = st.view === "preview" ? currentFrame() : null;
  const range = over.range ?? st.range;
  const rng = range ? { start_frame: range.a, end_frame: range.b } : {};
  const fetchMore = over.fetch_more ?? els.editFetch.checked;
  renderJobPanel({ state: "running", kind: "edit", client_name: AI_LABEL[st.aiClient] || "", created: Date.now() / 1000,
    steps: [{ key: "edit", state: "running", started: Date.now() / 1000 }] });
  const job = await requestAgent({
    method: "POST",
    path: `${API}/project/${st.pid}/design/edit`,
    json: { client: st.aiClient, request, segment_id: range ? null : st.sel, frame: atFrame, fetch_more: fetchMore, detail: Boolean(over.detail), ...rng },
  });
  els.editInput.value = "";
  applyJob(job);
  void pollJob(job.job_id);
}

/** 구간 다시 설계: 그 구간만 더 촘촘하게 (장면·키워드·효과). 수정 입력칸에 글이 있으면 추가 요청으로 함께 보낸다. */
function redesignSeg(seg) {
  const extra = els.editInput.value.trim();
  const base = t("redesignRequest", "이 구간을 처음 설계보다 더 디테일하게 다시 설계해 주세요.");
  void runEdit({ request: extra ? `${base} ${extra}` : base, range: { a: seg.from, b: seg.from + seg.durationInFrames }, detail: true, fetch_more: els.editFetch.checked })
    .catch(showError);
}

/** 웹 이미지 없이 영상 캡처·글자로만 채워진 이미지형 장면 수 (자료 부족 표시용) */
const IMG_TPL = new Set(["PHOTO_POINTS", "IMAGE_CARDS", "SHOWCASE", "LOGO_SLAM"]);
function materialGap(seg) {
  if (seg.type !== "FULL") return 0;
  let gap = 0;
  for (const sc of seg.scenes || []) {
    if (!IMG_TPL.has(sc.template)) continue;
    if (!Object.values(sc.vars || {}).some((v) => /^(web|user)\//.test(String(v)))) gap += 1;
  }
  return gap;
}

function fetchMoreFor(seg) {
  void runEdit({
    request: t("fetchRequest", "이 구간 장면에 맞는 로고·사진을 웹에서 더 찾아 받아 넣어 주세요."),
    range: { a: seg.from, b: seg.from + seg.durationInFrames },
    fetch_more: true,
  }).catch(showError);
}

async function applyDesign() {
  const res = await requestAgent({ method: "POST", path: `${API}/project/${st.pid}/design/apply?value=true` });
  st.design = res.design;
  setView("preview");
  if (st.sel) {
    const seg = st.design.segments.find((s) => s.id === st.sel);
    if (seg) seekFrame(seg.from);
  }
  refreshAll();
}

async function setSegType(sid, type) {
  try {
    const res = await requestAgent({ method: "POST", path: `${API}/project/${st.pid}/design/segment/${encodeURIComponent(sid)}/type`, json: { type } });
    st.design = res.design;
    refreshAll();
  } catch (err) {
    showError(err);
  }
}

/* ── 단계 버튼 · 상태 ─────────────────────────────────────────────── */

function updateSteps() {
  const running = st.job?.state === "running";
  const hasProject = Boolean(st.project && st.project.phase === "ready");
  const hasDesign = Boolean(st.design?.segments?.length);
  const applied = Boolean(st.design?.applied);
  els.btnDesign.disabled = !hasProject || !st.aiClient || running;
  els.btnDesign.querySelector("span").textContent = st.aiClient
    ? `${AI_LABEL[st.aiClient]}로 설계서 생성`
    : t("stepDesign", "AI 모션 설계서 생성");
  els.btnApply.disabled = !hasDesign || running; // 설계서가 없으면 적용 불가
  els.btnRender.disabled = !applied || running || !st.agentOk; // 적용 전에는 렌더 불가
  els.btnUimg.disabled = !st.pid || !st.agentOk;
  els.btnOpenDir.disabled = !st.pid || !st.agentOk; // 프로젝트가 열려 있으면 언제든 폴더를 열 수 있다
  els.btnDesign.classList.toggle("is-next", hasProject && !hasDesign);
  els.btnApply.classList.toggle("is-next", hasDesign && !applied);
  els.btnRender.classList.toggle("is-next", applied);
  els.btnDesign.classList.toggle("is-done", hasDesign);
  els.btnApply.classList.toggle("is-done", applied);
  const canEdit = hasDesign && !running && Boolean(st.aiClient);
  els.editInput.disabled = !canEdit;
  els.editBtn.disabled = !canEdit || !(st.sel || st.view === "preview");
  let msg = t("msg1", "1단계: 영상(MP4)과 자막(SRT)을 불러오세요.");
  if (hasProject && !hasDesign) msg = t("msg2", "2단계: 스타일 프리셋과 AI 를 고르고 「① AI 모션 설계서 생성」을 누르세요.");
  else if (hasDesign && !applied) msg = t("msg3", "3단계: 설계서를 확인하고, 고칠 구간은 아래에 요청하세요. 마음에 들면 「② 설계대로 적용」.");
  else if (applied) msg = t("msg4", "4단계: 미리보기에서 확인하고 고칠 시점에서 요청하세요. 끝나면 「③ MP4 영상 내보내기」.");
  els.stepMsg.textContent = msg;
}

function refreshAll() {
  const p = st.project;
  const d = st.design;
  els.stDuration.textContent = p?.duration_sec ? fmtSec(p.duration_sec).replace(/\.\d+$/, "") : "-";
  els.stSubs.textContent = st.subs.length ? `${st.subs.length}줄` : "-";
  els.stSegs.textContent = d ? `${d.segments.length}개` : "0개";
  els.stRes.textContent = p?.w ? `${p.w}×${p.h} · ${(p.fps?.value || 30).toFixed(2)}` : "-";
  const running = st.job?.state === "running";
  els.stDesign.textContent = running ? "작성 중" : d ? "완료" : "대기";
  els.stDesign.className = running ? "is-run" : d ? "is-ok" : "";
  els.stApply.textContent = d?.applied ? "적용됨" : "미적용";
  els.stApply.className = d?.applied ? "is-ok" : "";
  renderDoc();
  drawTimeline();
  updateEditTarget();
  updateSteps();
}

/* ── 보기 전환 ────────────────────────────────────────────────────── */

function setView(view) {
  st.view = view;
  for (const b of document.querySelectorAll(".mg-view__btn")) b.classList.toggle("is-on", b.dataset.view === view);
  const has = Boolean(st.project);
  els.doc.hidden = !has || view !== "design";
  els.preview.hidden = !has || view !== "preview";
  if (view !== "preview") els.video.pause();
  requestAnimationFrame(() => {
    fitLayers();
    drawTimeline();
  });
  updateEditTarget();
  updateSteps();
}

/* ── 설계서 화면 ─────────────────────────────────────────────────── */

function segMotion(s) {
  const m = st.analysis?.motion || [];
  const sf = st.analysis?.sample_fps || 2;
  const vals = m.slice(Math.floor((s.from / fps()) * sf), Math.ceil(((s.from + s.durationInFrames) / fps()) * sf));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

function renderDoc() {
  const d = st.design;
  if (!d) {
    els.docStats.replaceChildren();
    els.docBar.replaceChildren();
    const empty = document.createElement("li");
    empty.className = "mg-scene";
    empty.style.cursor = "default";
    empty.textContent = st.job?.state === "running" ? t("docWorking", "AI 가 설계서를 쓰는 중입니다…") : t("docEmpty", "아직 설계서가 없습니다. 왼쪽에서 스타일 프리셋과 AI 를 고르고 「① AI 모션 설계서 생성」을 누르세요.");
    els.docList.replaceChildren(empty);
    return;
  }
  const F = fps();
  const segs = d.segments;
  const sum = (type) => segs.filter((s) => s.type === type);
  const secs = (list) => fmtSec(list.reduce((a, s) => a + s.durationInFrames, 0) / F).replace(/\.\d+$/, "");
  const style = resolveStyle(d.style);
  els.docStats.innerHTML = "";
  for (const [cls, label, v, sub] of [
    ["is-style", t("style", "스타일"), "", ""],
    ["is-all", t("segs", "구간"), segs.length, `${t("beats", "비트")} ${segs.reduce((a, s) => a + s.beats.length, 0)}`],
    ["is-FULL", "FULL", sum("FULL").length, secs(sum("FULL"))],
    ["is-OVERLAY", "OVERLAY", sum("OVERLAY").length, secs(sum("OVERLAY"))],
    ["is-NONE", "NONE", sum("NONE").length, secs(sum("NONE"))],
  ]) {
    const div = document.createElement("div");
    div.className = `mg-doc__stat ${cls}`;
    div.innerHTML = "<small></small><b></b><span></span>";
    div.querySelector("small").textContent = label;
    if (cls === "is-style") div.querySelector("b").innerHTML = `${["primary", "sky", "accent"].map((k) => `<i style="background:${style.C[k]}"></i>`).join("")} ${style.name}`;
    else div.querySelector("b").textContent = String(v);
    div.querySelector("span").textContent = sub;
    els.docStats.appendChild(div);
  }
  els.docBar.replaceChildren(
    ...segs.map((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `mg-doc__seg is-${s.type}${s.id === st.sel ? " is-sel" : ""}`;
      b.style.flexGrow = String(s.durationInFrames);
      b.textContent = s.id;
      b.title = `${s.id} · ${s.type} · ${fmtSec(s.from / F)} · ${s.title}`;
      b.addEventListener("click", () => selectSeg(s.id, true));
      return b;
    }),
  );
  els.docList.replaceChildren(
    ...segs.map((s) => {
      const li = document.createElement("li");
      li.className = `mg-scene is-${s.type}${s.id === st.sel ? " is-sel" : ""}`;
      li.id = `seg-${s.id}`;
      li.innerHTML = `
        <div><div class="mg-scene__thumb"><img alt="" loading="lazy"><span></span></div><div class="mg-scene__time"></div></div>
        <div>
          <div class="mg-scene__head"><span class="mg-scene__id"></span>
            <select class="mg-scene__type"><option>FULL</option><option>OVERLAY</option><option>NONE</option></select>
            <span class="mg-scene__tpl"></span><span class="mg-scene__chap"></span>
            <button type="button" class="mg-btn mg-btn--ghost mg-btn--sm mg-scene__redo"></button></div>
          <h3 class="mg-scene__title"></h3>
          <p class="mg-scene__reason"></p>
          <div class="mg-scene__vars"></div>
          <ol class="mg-beats"></ol>
          <p class="mg-scene__edits"></p>
        </div>`;
      const img = li.querySelector("img");
      img.src = `${getAgentOrigin()}${API}/project/${encodeURIComponent(st.pid)}/design/thumb/${encodeURIComponent(s.id)}?r=${d.revision}`;
      img.onerror = () => img.remove();
      li.querySelector(".mg-scene__thumb span").textContent = s.type === "FULL" ? "원본 배경 제거 → MG 교체" : s.type === "OVERLAY" ? "원본 유지 + 확대·하이라이트" : "원본 유지 · MG 없음";
      li.querySelector(".mg-scene__time").textContent = `${fmtSec(s.from / F)} – ${fmtSec((s.from + s.durationInFrames) / F)} · 움직임 ${segMotion(s).toFixed(2)}`;
      li.querySelector(".mg-scene__id").textContent = s.id;
      const sel = li.querySelector(".mg-scene__type");
      sel.value = s.type;
      sel.disabled = st.job?.state === "running";
      sel.addEventListener("click", (ev) => ev.stopPropagation());
      sel.addEventListener("change", () => void setSegType(s.id, sel.value));
      const tpl = li.querySelector(".mg-scene__tpl");
      if (s.type !== "FULL") tpl.remove();
      li.querySelector(".mg-scene__chap").textContent = s.chapter || "";
      const redo = li.querySelector(".mg-scene__redo");
      if (s.type === "NONE") {
        redo.remove();
      } else {
        redo.textContent = t("redesignSeg", "구간 다시 설계");
        redo.title = t("redesignTip", "이 구간만 더 디테일하게 다시 설계합니다 (장면·키워드·효과를 촘촘하게)");
        redo.disabled = st.job?.state === "running" || !st.aiClient;
        redo.addEventListener("click", (ev) => {
          ev.stopPropagation();
          redesignSeg(s);
        });
      }
      li.querySelector(".mg-scene__title").textContent = s.title || "";
      li.querySelector(".mg-scene__reason").textContent = s.reason || "";
      const gap = materialGap(s);
      if (gap > 0) {
        const row = document.createElement("p");
        row.className = "mg-scene__gap";
        row.innerHTML = "<span></span><button type=\"button\" class=\"mg-btn mg-btn--ghost mg-btn--sm\"></button>";
        row.querySelector("span").textContent = t("gapWarn", "⚠ 자료 부족: 웹 이미지 없이 {n}개 장면이 영상 캡처·글자로 채워졌습니다.").replace("{n}", String(gap));
        const btn = row.querySelector("button");
        btn.textContent = t("fetchMore", "자료 더 받기");
        btn.disabled = st.job?.state === "running" || !st.aiClient;
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          fetchMoreFor(s);
        });
        li.querySelector(".mg-scene__reason").after(row);
      }
      const vars = li.querySelector(".mg-scene__vars");
      const beatsEl = li.querySelector(".mg-beats");
      const beatRow = (b, label, cls) => {
        const bl = document.createElement("li");
        bl.innerHTML = '<span class="at"></span>';
        bl.querySelector(".at").textContent = fmtSec(b.frame / F);
        if (label) {
          const tag = document.createElement("span");
          tag.className = cls;
          tag.textContent = label;
          bl.appendChild(tag);
        }
        const sub = st.subs.find((x) => x.n === b.sub);
        const txt = document.createElement("span");
        txt.textContent = sub ? `#${b.sub} ${sub.t}` : "";
        bl.appendChild(txt);
        return bl;
      };
      if (s.type === "FULL") {
        // FULL = 장면 여러 개: 장면마다 템플릿 · 문구 · 받은 이미지 · 비트
        vars.remove();
        const scenes = s.scenes?.length ? s.scenes : [{ template: s.template, vars: s.vars || {}, beats: s.beats }];
        beatsEl.replaceWith(...scenes.map((sc, k) => {
          const box = document.createElement("div");
          box.className = "mg-sc";
          box.innerHTML = '<div class="mg-sc__head"><b></b><span class="mg-scene__tpl"></span></div><div class="mg-sc__imgs"></div><div class="mg-scene__vars"></div><ol class="mg-beats"></ol>';
          box.querySelector("b").textContent = `장면 ${k + 1} · ${fmtSec((sc.beats[0]?.frame ?? s.from) / F)}`;
          box.querySelector(".mg-scene__tpl").textContent = `${sc.template} · ${TPL[sc.template]?.name || ""}`;
          const imgs = box.querySelector(".mg-sc__imgs");
          const vb = box.querySelector(".mg-scene__vars");
          for (const [key, v] of Object.entries(sc.vars || {})) {
            if (/\.(png|jpe?g|webp|gif|svg|avif|mp4)$/i.test(String(v))) {
              const im = document.createElement(/\.mp4$/i.test(String(v)) ? "video" : "img");
              im.src = `${getAgentOrigin()}${API}/assets/${encodeURIComponent(st.pid)}/${String(v).split("/").map(encodeURIComponent).join("/")}`;
              if (im instanceof HTMLVideoElement) { im.controls = true; im.muted = true; im.preload = "metadata"; }
              im.title = `${key}: ${v}`;
              im.alt = "";
              imgs.appendChild(im);
              continue;
            }
            const span = document.createElement("span");
            span.innerHTML = "<em></em>";
            span.querySelector("em").textContent = key;
            span.append(String(v));
            vb.appendChild(span);
          }
          const slots = TPL[sc.template]?.slots || [];
          box.querySelector(".mg-beats").replaceChildren(...sc.beats.map((b, i) => beatRow(b, slots[i] || "", "slot")));
          return box;
        }));
        const tplEl = li.querySelector(".mg-scene__head .mg-scene__tpl");
        if (tplEl) tplEl.textContent = `장면 ${scenes.length}개`;
      } else {
        vars.remove();
        beatsEl.replaceChildren(...s.beats.map((b) => beatRow(b, b.fx ? `${b.fx}${b.zoom ? ` ${b.zoom}x` : ""}` : "", "fx")));
      }
      const edits = s.edits || [];
      li.querySelector(".mg-scene__edits").textContent = edits.length ? `✎ ${edits[edits.length - 1].change || edits[edits.length - 1].request}` : "";
      li.addEventListener("click", () => selectSeg(s.id, false));
      li.addEventListener("dblclick", () => {
        selectSeg(s.id, false);
        if (st.design?.applied) setView("preview");
        seekFrame(s.from);
      });
      return li;
    }),
  );
}

function selectSeg(sid, scroll) {
  st.sel = sid;
  const seg = st.design?.segments.find((s) => s.id === sid);
  if (seg) st.range = { a: seg.from, b: seg.from + seg.durationInFrames };
  if (seg && st.view === "preview") seekFrame(seg.from);
  renderDoc();
  if (scroll && st.view === "design") $(`seg-${sid}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  updateEditTarget();
  drawTimeline();
}

function updateEditTarget() {
  if (st.range) {
    const { a: ra, b: rb } = st.range;
    els.editTarget.textContent = `${t("editRange", "선택 범위")}: ${fmtSec(ra / fps())} ~ ${fmtSec(rb / fps())} (${((rb - ra) / fps()).toFixed(1)}${t("sec", "초")})`;
    els.editTarget.classList.add("is-set");
  } else {
    const seg = st.design?.segments.find((s) => s.id === st.sel);
    if (seg) {
      els.editTarget.textContent = `${t("editSel", "선택 대상")}: ${seg.id} (${seg.type})`;
      els.editTarget.classList.add("is-set");
    } else {
      els.editTarget.textContent = t("editNone", "선택 대상: 없음");
      els.editTarget.classList.remove("is-set");
    }
  }
  updateStepsEditOnly();
}

function updateStepsEditOnly() {
  const running = st.job?.state === "running";
  els.editBtn.disabled = els.editInput.disabled || running || !(st.range || st.sel);
}

/* ── 미리보기 ─────────────────────────────────────────────────────── */

function fitLayers() {
  if (!st.project) return;
  const k = els.stage.clientWidth / st.project.w;
  for (const layer of [els.fxRoot, els.fullRoot]) layer.style.transform = `scale(${k})`;
}

let lastFrame = -1;
function tick() {
  requestAnimationFrame(tick);
  if (!st.project) return;
  const frame = currentFrame();
  els.tc.textContent = timecode(frame);
  if (st.view !== "preview") return;
  const on = Boolean(st.design?.applied);
  els.pvOff.hidden = on || !st.design;
  renderer.enabled = on;
  renderer.render(on ? st.design : null, frame, `${st.design?.revision || 0}`, !els.video.paused);
  if (frame === lastFrame) return;
  lastFrame = frame;
  const segs = st.design?.segments || [];
  const idx = st.design ? findSegment(st.design, frame) : -1;
  const seg = segs[idx];
  if (seg && !els.video.paused && st.sel !== seg.id) {
    st.sel = seg.id;
    updateEditTarget();
  }
  els.segCur.textContent = seg ? `${t("cur", "현재 구간")} ${seg.id} · ${seg.type}${seg.template ? ` · ${seg.template}` : ""}` : "";
  els.segPrev.textContent = segs[idx - 1] ? `◀ ${segs[idx - 1].id}` : "◀";
  els.segNext.textContent = segs[idx + 1] ? `${segs[idx + 1].id} ▶` : "▶";
  els.segPrev.disabled = !segs[idx - 1];
  els.segNext.disabled = !segs[idx + 1];
  const sec = frame / fps();
  const sub = st.subs.find((s) => s.a <= sec && sec < s.b);
  els.subNow.textContent = sub ? `#${sub.n} ${sub.t}` : "";
  drawPlayhead(frame);
}

function jumpSeg(delta) {
  const segs = st.design?.segments || [];
  const idx = findSegment(st.design, currentFrame());
  const target = segs[idx + delta];
  if (target) {
    st.sel = target.id;
    seekFrame(target.from);
    updateEditTarget();
  }
}

/* 타임라인: 구간 줄 + 비트 표시 + 자막 줄 + 파형 + 재생 위치 */
let tlBase = null;
function drawTimeline() {
  const c = els.tlCanvas;
  if (!st.project || els.preview.hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth;
  const H = c.clientHeight;
  if (!W || !H) return;
  c.width = W * dpr;
  c.height = H * dpr;
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = "#0a101a";
  g.fillRect(0, 0, W, H);
  const total = st.project.total_frames || 1;
  const x = (f) => (f / total) * W;
  const colors = { FULL: "#1fae95", OVERLAY: "#5a4ec0", NONE: "#475569" };
  for (const s of st.design?.segments || []) {
    g.fillStyle = colors[s.type];
    g.fillRect(x(s.from), 6, Math.max(1, x(s.durationInFrames) - 1), 22);
    if (s.id === st.sel) {
      g.strokeStyle = "#fff";
      g.lineWidth = 2;
      g.strokeRect(x(s.from) + 1, 7, Math.max(1, x(s.durationInFrames) - 2), 20);
    }
    g.fillStyle = "#fff";
    g.font = "bold 10px Consolas, monospace";
    if (x(s.durationInFrames) > 18) g.fillText(s.id, x(s.from) + 3, 20);
    g.fillStyle = "#ffd166";
    for (const b of s.beats) g.fillRect(x(b.frame), 27, 2, 5);
  }
  g.fillStyle = "#23324a";
  for (const s of st.subs) g.fillRect(x(s.s), 38, Math.max(1, x(s.e - s.s)), 8);
  const lv = st.waveform;
  if (lv.length) {
    g.fillStyle = "#2b6f9a";
    const per = lv.length / W;
    for (let px = 0; px < W; px++) {
      const v = lv[Math.floor(px * per)] || 0;
      const hh = (v / 255) * 30;
      g.fillRect(px, 66 - hh / 2, 1, Math.max(1, hh));
    }
  }
  tlBase = g.getImageData(0, 0, c.width, c.height);
  drawPlayhead(currentFrame());
}

function drawPlayhead(frame) {
  const c = els.tlCanvas;
  if (!tlBase || !st.project) return;
  const g = c.getContext("2d");
  g.putImageData(tlBase, 0, 0);
  const dpr = window.devicePixelRatio || 1;
  const W = c.width / dpr;
  const H = c.height / dpr;
  const total = st.project.total_frames || 1;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (st.range) {
    const xa = (st.range.a / total) * W;
    const xb = (st.range.b / total) * W;
    g.fillStyle = "rgba(34, 184, 255, 0.2)";
    g.fillRect(xa, 0, xb - xa, H);
    g.fillStyle = "#22b8ff";
    g.fillRect(xa - 1.5, 0, 3, H);
    g.fillRect(xb - 1.5, 0, 3, H);
    // 손잡이
    for (const x of [xa, xb]) {
      g.fillRect(x - 5, H / 2 - 14, 10, 28);
      g.fillStyle = "#06101c";
      g.fillRect(x - 1, H / 2 - 8, 2, 16);
      g.fillStyle = "#22b8ff";
    }
    g.font = "bold 11px Consolas, monospace";
    const la = fmtSec(st.range.a / fps());
    const lb = fmtSec(st.range.b / fps());
    g.fillStyle = "#e6edf7";
    g.fillText(la, Math.min(W - 60, xa + 6), H - 6);
    g.fillText(lb, Math.max(4, xb - 62), H - 6);
  }
  g.fillStyle = "#ff4d6d";
  g.fillRect((frame / total) * W, 0, 2, H);
}

/* ── 렌더 ─────────────────────────────────────────────────────────── */

function setRenderBusy(active, pct = 0, message = "") {
  els.renderOverlay.hidden = !active;
  els.renderBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  els.renderPct.textContent = `${Math.round(pct)}%`;
  els.renderStep.textContent = message;
}

function notifyDone(s) {
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification(t("renderDoneTitle", "모션그래픽 MP4 렌더 완료"), { body: st.project?.video_name || "", tag: "motion-graphic-render" });
      n.onclick = () => window.focus();
    }
  } catch {
    /* 알림 실패 무시 */
  }
  void s;
}

async function runRender() {
  if (!st.ready) {
    if (!confirm(t("confirmPrep", "렌더 엔진이 아직 준비되지 않았습니다. 지금 환경 준비(Node.js·Remotion·Chrome 설치)를 실행할까요?"))) return;
    await runPrepare();
    if (!st.ready) return;
  }
  try {
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
  } catch {
    /* 미지원 */
  }
  const baseTitle = document.title;
  els.video.pause();
  setAgentLongOperationActive(true);
  try {
    setRenderBusy(true, 1, t("renderStart", "렌더 준비 중…"));
    const job = await requestAgent({ method: "POST", path: `${API}/render`, json: { project_id: st.pid } });
    st.renderJob = job.job_id;
    for (;;) {
      const s = await requestAgent({ method: "GET", path: `${API}/render/${job.job_id}` });
      setRenderBusy(true, Number(s.progress || 0), s.message || "");
      document.title = `${Math.round(Number(s.progress || 0))}% · ${baseTitle}`;
      if (s.phase === "ready") {
        document.title = `✓ ${t("renderDone", "렌더 완료")} · ${baseTitle}`;
        notifyDone(s);
        sessionStorage.setItem(SS.pid, st.pid);
        sessionStorage.setItem(SS.output, s.output_path || "");
        sessionStorage.setItem(SS.name, st.project?.video_name || "");
        sessionStorage.setItem(SS.encoder, s.encoder || "");
        window.location.assign(new URL("download.html", window.location.href).href);
        return;
      }
      if (s.phase === "failed") throw new Error(s.message || t("renderFail", "렌더 실패"));
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    if (!document.title.startsWith("✓")) document.title = baseTitle;
    st.renderJob = null;
    setRenderBusy(false);
    setAgentLongOperationActive(false);
  }
}

/* ── 이벤트 ───────────────────────────────────────────────────────── */

els.prepare.addEventListener("click", () => void (st.agentOk ? runPrepare() : showInstallAgentDialog(agentInstallDialogOptions())).catch(showError));
els.pickVideo.addEventListener("click", () => void pickVideo().catch(showError));
els.drop.addEventListener("click", () => void createProject().catch(showError));
els.srtFile.addEventListener("change", async () => {
  const file = els.srtFile.files?.[0];
  if (!file) return;
  st.srtText = await readTextFile(file);
  st.srtName = file.name;
  els.srtName.value = file.name;
});
els.load.addEventListener("click", () => void createProject().catch(showError));
els.recent.addEventListener("change", () => {
  if (els.recent.value) void openProject(els.recent.value).catch(showError);
});
els.dirFile.addEventListener("change", async () => {
  const file = els.dirFile.files?.[0];
  if (!file) return;
  els.directives.value = await readTextFile(file);
  els.dirFile.value = "";
  els.directives.closest("details").open = true;
});
els.gap.value = lsGet(LS.gap) || els.gap.value;
els.gapValue.textContent = `${Number(els.gap.value).toFixed(1)}s`;
els.gap.addEventListener("input", () => {
  els.gapValue.textContent = `${Number(els.gap.value).toFixed(1)}s`;
  lsSet(LS.gap, els.gap.value);
});
els.optStill.checked = lsGet(LS.still) !== "0";
els.optStill.addEventListener("change", () => lsSet(LS.still, els.optStill.checked ? "1" : "0"));

els.styleClose.addEventListener("click", () => els.styleDialog.close());
for (const r of document.querySelectorAll('#media-opts input[name="media"]')) {
  r.checked = r.value === st.media;
  r.addEventListener("change", () => {
    st.media = r.value;
    lsSet(LS.media, r.value);
  });
}
els.btnDesign.addEventListener("click", () => void runDesign().catch(showError));
els.btnApply.addEventListener("click", () => void applyDesign().catch(showError));
els.btnRender.addEventListener("click", () => void runRender().catch(showError));
els.btnOpenDir.addEventListener("click", async () => {
  try {
    const r = await requestAgent({ method: "POST", path: `${API}/project/${st.pid}/open-dir` });
    if (!r?.ok) alert(`${t("openDirFail", "폴더를 열지 못했습니다.")}\n${r?.path || ""}`);
  } catch (err) {
    showError(err);
  }
});
els.jobStop.addEventListener("click", () => els.jobCancel.click());
els.jobCancel.addEventListener("click", async () => {
  if (st.job?.job_id) await requestAgent({ method: "POST", path: `${API}/design/${st.job.job_id}/cancel` }).catch(() => {});
});
els.editBtn.addEventListener("click", () => void runEdit().catch(showError));
els.editInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !els.editBtn.disabled) void runEdit().catch(showError);
});
els.editInput.addEventListener("input", updateStepsEditOnly);
for (const b of document.querySelectorAll(".mg-view__btn")) b.addEventListener("click", () => setView(b.dataset.view));

els.play.addEventListener("click", () => (els.video.paused ? void els.video.play() : els.video.pause()));
els.video.addEventListener("play", () => (els.play.textContent = "❚❚"));
els.video.addEventListener("pause", () => {
  els.play.textContent = "▶";
  updateEditTarget();
});
els.stage.addEventListener("click", () => els.play.click());
els.segPrev.addEventListener("click", () => jumpSeg(-1));
els.segNext.addEventListener("click", () => jumpSeg(1));
/* 타임라인 드래그 = 시간 범위 선택. 누른 곳이 시작, 놓은 곳이 끝. 드래그하는 동안 미리보기가 그 시점으로 따라간다.
   놓은 뒤에는 양쪽 손잡이를 끌어 조정한다. 짧게 클릭만 하면 그 시점으로 이동 + 그 구간 선택. */
const MIN_RANGE = 15;
const drag = { mode: null, anchor: 0, startX: 0, moved: false };

function tlFrame(ev) {
  const r = els.tlCanvas.getBoundingClientRect();
  const total = st.project?.total_frames || 1;
  return Math.max(0, Math.min(total - 1, Math.round(((ev.clientX - r.left) / r.width) * total)));
}

function tlHandleAt(ev) {
  if (!st.range || !st.project) return null;
  const r = els.tlCanvas.getBoundingClientRect();
  const total = st.project.total_frames || 1;
  const xa = (st.range.a / total) * r.width;
  const xb = (st.range.b / total) * r.width;
  const x = ev.clientX - r.left;
  if (Math.abs(x - xa) <= 9) return "a";
  if (Math.abs(x - xb) <= 9) return "b";
  return null;
}

els.tl.addEventListener("pointerdown", (ev) => {
  if (!st.project || ev.button !== 0) return;
  els.tl.setPointerCapture(ev.pointerId);
  els.video.pause();
  const f = tlFrame(ev);
  const handle = tlHandleAt(ev);
  drag.startX = ev.clientX;
  drag.moved = false;
  if (handle) {
    drag.mode = handle;
  } else {
    drag.mode = "new";
    drag.anchor = f;
  }
  seekFrame(f);
});

els.tl.addEventListener("pointermove", (ev) => {
  if (!st.project) return;
  if (!drag.mode) {
    els.tl.style.cursor = tlHandleAt(ev) ? "ew-resize" : "crosshair";
    return;
  }
  const f = tlFrame(ev);
  if (Math.abs(ev.clientX - drag.startX) >= 4) drag.moved = true;
  if (!drag.moved) return;
  const total = st.project.total_frames || 1;
  if (drag.mode === "new") {
    st.range = { a: Math.min(drag.anchor, f), b: Math.max(drag.anchor, f) };
  } else if (drag.mode === "a") {
    st.range = { a: Math.min(f, st.range.b - MIN_RANGE), b: st.range.b };
  } else {
    st.range = { a: st.range.a, b: Math.min(total, Math.max(f, st.range.a + MIN_RANGE)) };
  }
  seekFrame(f); // 드래그하는 위치의 장면이 미리보기에 바로 나온다
  updateEditTarget();
  drawPlayhead(f);
});

function endDrag(ev) {
  if (!drag.mode) return;
  const mode = drag.mode;
  drag.mode = null;
  if (mode === "new" && !drag.moved) {
    // 클릭: 그 시점으로 이동 + 그 구간 선택(범위 = 구간 전체)
    const f = tlFrame(ev);
    seekFrame(f);
    const idx = st.design ? findSegment(st.design, f) : -1;
    if (idx >= 0) {
      const seg = st.design.segments[idx];
      st.sel = seg.id;
      st.range = { a: seg.from, b: seg.from + seg.durationInFrames };
    }
  } else if (st.range && st.range.b - st.range.a < MIN_RANGE) {
    st.range = { a: st.range.a, b: Math.min(st.project.total_frames, st.range.a + MIN_RANGE) };
  }
  updateEditTarget();
  drawTimeline();
  els.editInput.focus();
}
els.tl.addEventListener("pointerup", endDrag);
els.tl.addEventListener("pointercancel", () => {
  drag.mode = null;
});
document.addEventListener("keydown", (ev) => {
  if (st.view !== "preview" || ev.target.closest("input, textarea, select")) return;
  if (ev.key === "Escape" && st.range) {
    st.range = null;
    st.sel = null;
    updateEditTarget();
    drawTimeline();
  } else if (ev.code === "Space") {
    ev.preventDefault();
    els.play.click();
  } else if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
    ev.preventDefault();
    seekFrame(Math.max(0, currentFrame() + (ev.key === "ArrowLeft" ? -1 : 1) * (ev.shiftKey ? Math.round(fps()) : 1)));
  }
});
els.renderCancel.addEventListener("click", async () => {
  if (st.renderJob) await requestAgent({ method: "POST", path: `${API}/render/${st.renderJob}/cancel` }).catch(() => {});
});
new ResizeObserver(() => {
  fitLayers();
  drawTimeline();
}).observe(els.stage);
setInterval(() => {
  if (st.job?.state === "running") applyJob(st.job); // 경과 초
}, 1000);
document.addEventListener("itz:lang-change", () => {
  renderStyles();
  refreshAll();
});
window.addEventListener("itz:ai-setup-ready", () => void checkReadiness().catch(() => {}));

async function boot() {
  renderStyles();
  renderAiClients();
  updateSteps();
  void showAdSense("editorAboveWorkspace", "#editor-ad-above-path");
  void showAdSense("editorBelowExport", "#editor-ad-below-export");
  requestAnimationFrame(tick);
  startConnectionMonitor({
    onStatus: (detail) => {
      st.agentOk = Boolean(detail?.ok);
      applyConnectionStatusDot(els.connection, detail);
      els.connection.classList.add("mg-chip");
      if (!st.agentOk && detail?.error) els.connection.title = formatAgentConnectionError(detail.error);
      updateSteps();
    },
  });
  try {
    await primeLocalNetworkAccess();
    const connected = await checkAgentConnection();
    st.agentOk = Boolean(connected?.ok);
    applyConnectionStatusDot(els.connection, connected);
    els.connection.classList.add("mg-chip");
    if (!st.agentOk) return;
    await Promise.all([checkReadiness(), loadAiClients(), loadStyles()]);
    const recent = await loadRecent();
    const last = lsGet(LS.last);
    if (last && (recent?.projects || []).some((p) => p.id === last && p.phase === "ready")) await openProject(last);
  } catch (err) {
    console.warn(err);
  }
}

void boot();


/* ── 내 이미지: 올려 두고 특정 자막에 넣기 ───────────────────────────── */

const assetSrc = (path) => `${getAgentOrigin()}${API}/assets/${encodeURIComponent(st.pid || "")}/${path.split("/").map(encodeURIComponent).join("/")}`;

async function loadUserImages() {
  if (!st.pid) { st.uimgs = []; renderUserImages(); return; }
  try {
    st.uimgs = (await requestAgent({ method: "GET", path: `${API}/project/${st.pid}/user-images` })).items || [];
  } catch { st.uimgs = []; }
  renderUserImages();
}

function renderUserImages() {
  if (!st.uimgs.length) { els.uimgList.replaceChildren(); return; }
  els.uimgList.replaceChildren(...st.uimgs.map((im) => {
    const li = document.createElement("li");
    const img = document.createElement("img");
    img.src = assetSrc(im.path);
    img.alt = "";
    const nm = document.createElement("span");
    nm.className = "mg-uimg__name";
    nm.textContent = im.name;
    nm.title = im.name;
    const put = document.createElement("button");
    put.type = "button";
    put.className = "mg-btn mg-btn--sm";
    put.textContent = t("uimgPut", "자막에 넣기");
    put.disabled = !st.design?.segments?.length;
    put.title = put.disabled ? t("uimgNeedDesign", "먼저 설계서를 만들어 주세요") : "";
    put.addEventListener("click", () => openPlaceDialog(im));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "mg-btn mg-btn--ghost mg-btn--sm";
    del.textContent = "✕";
    del.title = t("uimgDelete", "삭제");
    del.addEventListener("click", async () => {
      try {
        await requestAgent({ method: "DELETE", path: `${API}/project/${st.pid}/user-images/${encodeURIComponent(im.name)}` });
        await loadUserImages();
      } catch (err) { showError(err); }
    });
    li.append(img, nm, put, del);
    return li;
  }));
}

const fileToBase64 = (f) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] || "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(f);
});

async function uploadImages(files) {
  for (const f of files) {
    try {
      if (f.size > 10 * 1024 * 1024) throw new Error(t("uimgTooBig", "이미지는 한 장에 10MB까지 올릴 수 있습니다.") + ` (${f.name})`);
      await requestAgent({ method: "POST", path: `${API}/project/${st.pid}/user-images`, json: { name: f.name, data: await fileToBase64(f) } });
    } catch (err) { showError(err); }
  }
  await loadUserImages();
}

let placing = null;

function openPlaceDialog(im) {
  placing = im;
  els.uimgPreview.src = assetSrc(im.path);
  const opts = st.subs.map((s) => {
    const o = document.createElement("option");
    o.value = String(s.n);
    o.textContent = `#${s.n} · ${fmtSec(s.a).replace(/\.\d+$/, "")} · ${String(s.t || "").slice(0, 32)}`;
    return o;
  });
  els.uimgFrom.replaceChildren(...opts);
  els.uimgTo.replaceChildren(...opts.map((o) => o.cloneNode(true)));
  const sec = currentFrame() / fps();
  const cur = st.subs.find((s) => s.a <= sec && sec < s.b) || st.subs.find((s) => s.a >= sec) || st.subs[0];
  if (cur) { els.uimgFrom.value = String(cur.n); els.uimgTo.value = String(cur.n); }
  els.uimgCaption.value = "";
  els.uimgDialog.showModal();
}

els.btnUimg.addEventListener("click", () => els.uimgFile.click());
els.uimgFile.addEventListener("change", async () => {
  const files = [...els.uimgFile.files];
  els.uimgFile.value = "";
  if (files.length) await uploadImages(files);
});
els.uimgFrom.addEventListener("change", () => { if (Number(els.uimgTo.value) < Number(els.uimgFrom.value)) els.uimgTo.value = els.uimgFrom.value; });
els.uimgClose.addEventListener("click", () => els.uimgDialog.close());
els.uimgPlace.addEventListener("click", async () => {
  if (!placing) return;
  const sub = Number(els.uimgFrom.value);
  const subEnd = Math.max(sub, Number(els.uimgTo.value));
  els.uimgPlace.disabled = true;
  try {
    const res = await requestAgent({ method: "POST", path: `${API}/project/${st.pid}/design/place-image`,
      json: { file: placing.name, sub, sub_end: subEnd, caption: els.uimgCaption.value.trim() } });
    st.design = res.design;
    els.uimgDialog.close();
    refreshAll();
    const first = st.subs.find((s) => s.n === sub);
    if (first) seekFrame(first.s);
  } catch (err) { showError(err); } finally { els.uimgPlace.disabled = false; }
});
