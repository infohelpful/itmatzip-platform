/**
 * MP4 내보내기 페이지 — 편집 화면(cut-editor.js)이 sessionStorage 에 남긴 요청으로
 * 에이전트 인코딩을 시작·진행 표시하고, 끝나면 저장 위치를 보여 준다.
 * (docs/silence-remover-cut-editor-spec.md 부록 C)
 */
import {
  checkAgentConnection,
  configureBridge,
  requestAgent,
  setAgentLongOperationActive,
  setAgentOrigin,
} from "../common/bridge.js?v=lna30";
import { showAdSense } from "../common/adsense.js?v=12";
import { markEditorRestorePending } from "../common/edl-export.js?v=lna44";
import { MSG_HELPER_NEED_APP } from "../common/local-helper-ui.js";

configureBridge({ healthPath: "/health" });

// 개발 테스트용: localhost 에서만 편집 화면과 같은 소스 에이전트(?agent=)에 붙는다.
(() => {
  try {
    const host = window.location.hostname;
    if (host !== "localhost" && host !== "127.0.0.1") return;
    const agent = new URLSearchParams(window.location.search).get("agent") || sessionStorage.getItem("itz.devAgent");
    if (!agent || !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(agent)) return;
    sessionStorage.setItem("itz.devAgent", agent);
    setAgentOrigin(agent);
  } catch {
    /* ignore */
  }
})();

/** cut-editor.js 와 같은 키 */
const EXPORT_REQUEST_KEY = "silenceRemover.exportRequest";
/** 새로고침해도 같은 인코딩을 이어서 보도록 { requestId, jobId } 를 남긴다 */
const EXPORT_JOB_KEY = "silenceRemover.exportJob";
const EDITOR_PAGE = "index.html";
const POLL_MS = 600;

const $ = (id) => document.getElementById(id);
const el = {
  file: $("ex-file"),
  summary: $("ex-summary"),
  progress: $("ex-progress"),
  keepOpen: $("ex-keep-open"),
  label: $("ex-label"),
  percent: $("ex-percent"),
  bar: $("ex-bar"),
  status: $("ex-status"),
  result: $("ex-result"),
  path: $("ex-path"),
  reveal: /** @type {HTMLButtonElement} */ ($("ex-reveal")),
  retry: /** @type {HTMLButtonElement} */ ($("ex-retry")),
  cancel: /** @type {HTMLButtonElement} */ ($("ex-cancel")),
  back: /** @type {HTMLButtonElement} */ ($("ex-back")),
};

const t = (key, fallback) => {
  try {
    const v = window.itzT?.(key, fallback);
    if (v && v !== key) return v;
  } catch {
    /* ignore */
  }
  return fallback;
};
const tf = (key, fallback, vars) => {
  let s = t(key, fallback);
  Object.keys(vars).forEach((k) => {
    s = s.split(`{${k}}`).join(String(vars[k]));
  });
  return s;
};

/** @type {"idle" | "running" | "done" | "failed" | "canceled"} */
let phase = "idle";
let jobId = "";
let leaving = false;

function formatClock(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = (s % 60).toFixed(2).padStart(5, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

function show(node, on) {
  node?.classList.toggle("is-hidden", !on);
}

function setStatus(text, kind = "") {
  if (!el.status) return;
  el.status.textContent = text || "";
  el.status.classList.toggle("is-ok", kind === "ok");
  el.status.classList.toggle("is-err", kind === "err");
}

function setProgress(pct, label) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  if (el.bar) el.bar.style.width = `${p}%`;
  if (el.percent) el.percent.textContent = `${Math.round(p)}%`;
  if (el.label) el.label.textContent = label || "";
  el.progress?.setAttribute("aria-valuenow", String(Math.round(p)));
}

/** @param {typeof phase} next */
function setPhase(next) {
  phase = next;
  show(el.progress, next === "running" || next === "done");
  show(el.cancel, next === "running");
  show(el.keepOpen, next === "running");
  show(el.reveal, next === "done");
  show(el.retry, next === "failed" || next === "canceled");
  show(el.result, next === "done");
  setAgentLongOperationActive(next === "running");
}

function loadRequest() {
  try {
    const raw = sessionStorage.getItem(EXPORT_REQUEST_KEY);
    const req = raw ? JSON.parse(raw) : null;
    if (req && typeof req.video_path === "string" && Array.isArray(req.keeps) && req.keeps.length && req.fps_rational) {
      return req;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function savedJobFor(req) {
  try {
    const data = JSON.parse(sessionStorage.getItem(EXPORT_JOB_KEY) || "null");
    return data && data.requestId === req.id && typeof data.jobId === "string" ? data.jobId : "";
  } catch {
    return "";
  }
}

function rememberJob(req, id) {
  try {
    if (id) sessionStorage.setItem(EXPORT_JOB_KEY, JSON.stringify({ requestId: req.id, jobId: id }));
    else sessionStorage.removeItem(EXPORT_JOB_KEY);
  } catch {
    /* ignore */
  }
}

function describe(req) {
  const file = String(req.video_path).split(/[\\/]/).pop() || req.video_path;
  if (el.file) el.file.textContent = file;
  const quality = t(
    { high: "cut.qualityHigh", fast: "cut.qualityFast" }[req.quality] || "cut.qualityStandard",
    { high: "고화질 (느림)", fast: "빠르게 (용량 큼)" }[req.quality] || "표준",
  );
  if (el.summary) {
    el.summary.textContent = tf(
      "ex.summary",
      "컷 {n}개를 빼고 {out} 길이로 저장합니다 · 화질 {q}",
      { n: req.cut_count ?? 0, out: formatClock(req.out_sec), q: quality },
    );
  }
}

/** @returns {Promise<any>} 최종 상태 (running 이 아닐 때) */
async function poll(id) {
  let failures = 0;
  for (;;) {
    try {
      const s = await requestAgent({
        method: "GET",
        path: `/api/tools/silence-remover/render/status?job_id=${encodeURIComponent(id)}`,
      });
      failures = 0;
      const label = s.label || t("ex.encoding", "인코딩 중");
      const enc = s.encoder_name && !label.includes(s.encoder_name) ? ` · ${s.encoder_name}` : "";
      setProgress(s.percent, `${label}${enc}`);
      if (s.state !== "running") return s;
    } catch (err) {
      failures += 1;
      if (failures >= 8) throw err;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function run(req, { resume = false } = {}) {
  setStatus("");
  setPhase("running");
  setProgress(0, t("cut.exportPreparing", "준비 중…"));
  try {
    const agent = await checkAgentConnection();
    if (!agent.ok) throw new Error(MSG_HELPER_NEED_APP());

    jobId = resume ? savedJobFor(req) : "";
    let final = null;
    if (jobId) {
      try {
        final = await poll(jobId);
      } catch {
        jobId = ""; // 에이전트가 재시작돼 작업이 없어졌으면 새로 시작
      }
    }
    if (!jobId) {
      const started = await requestAgent({
        method: "POST",
        path: "/api/tools/silence-remover/render/start",
        json: {
          video_path: req.video_path,
          fps_rational: req.fps_rational,
          keeps: req.keeps,
          quality: req.quality || "standard",
        },
      });
      jobId = String(started.job_id || "");
      if (!jobId) throw new Error(t("cut.exportFailed", "내보내기에 실패했습니다."));
      rememberJob(req, jobId);
      final = await poll(jobId);
    }

    if (final.state === "done") {
      setPhase("done");
      setProgress(100, t("cut.exportDone", "저장했습니다."));
      if (el.path) el.path.textContent = final.output_path || "";
      if (el.reveal) el.reveal.dataset.path = final.output_path || "";
      setStatus(t("ex.done", "인코딩을 마치고 파일을 저장했습니다."), "ok");
    } else if (final.state === "canceled") {
      rememberJob(req, "");
      setPhase("canceled");
      setStatus(t("cut.exportCanceled", "내보내기를 취소했습니다."), "err");
    } else {
      throw new Error(final.error || t("cut.exportFailed", "내보내기에 실패했습니다."));
    }
  } catch (err) {
    rememberJob(req, "");
    setPhase("failed");
    setStatus(err instanceof Error ? err.message : String(err), "err");
  }
}

async function cancelJob() {
  if (!jobId || phase !== "running") return;
  if (el.cancel) el.cancel.disabled = true;
  try {
    await requestAgent({ method: "POST", path: "/api/tools/silence-remover/render/cancel", json: { job_id: jobId } });
  } catch {
    /* 상태 폴링이 결과를 알려 준다 */
  } finally {
    if (el.cancel) el.cancel.disabled = false;
  }
}

async function goBack() {
  if (phase === "running") {
    if (!window.confirm(t("ex.confirmLeave", "인코딩을 취소하고 편집 화면으로 돌아갈까요?"))) return;
    await cancelJob();
  }
  leaving = true;
  markEditorRestorePending();
  window.location.href = EDITOR_PAGE;
}

function init() {
  void showAdSense("downloadTop", "#dl-ad-top");
  void showAdSense("downloadBottom", "#dl-ad-bottom");

  el.back?.addEventListener("click", () => void goBack());
  el.cancel?.addEventListener("click", () => void cancelJob());
  el.reveal?.addEventListener("click", async () => {
    const path = el.reveal?.dataset.path;
    if (!path) return;
    try {
      await requestAgent({ method: "POST", path: "/api/tools/silence-remover/render/reveal", json: { path } });
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), "err");
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (phase === "running" && !leaving) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  const req = loadRequest();
  if (!req) {
    setPhase("idle");
    setStatus(t("ex.noRequest", "내보낼 편집 내용이 없습니다. 편집 화면에서 「MP4로 내보내기」를 눌러 주세요."), "err");
    return;
  }
  describe(req);
  el.retry?.addEventListener("click", () => void run(req));
  void run(req, { resume: true });
}

init();
document.addEventListener("itz:lang-change", () => {
  const req = loadRequest();
  if (req) describe(req);
});
