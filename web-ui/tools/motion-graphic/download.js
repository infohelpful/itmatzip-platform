import { checkAgentConnection, configureBridge, getAgentOrigin, requestAgent } from "../common/bridge.js?v=lna30";
import { showAdSense } from "../common/adsense.js?v=12";
import { AGENT_PORT } from "../common/agent-endpoints.js";
import { MSG_HELPER_NEED_APP } from "../common/local-helper-ui.js";

const host = window.location.hostname.replace(/^\[|\]$/g, "").toLowerCase();
if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
  configureBridge({ healthPath: "/health", origin: `${window.location.protocol}//${host}:${AGENT_PORT}` });
} else {
  configureBridge({ healthPath: "/health" });
}

const API = "/api/tools/motion-graphic";
const AUTO_START_SEC = 3;
const SS = { pid: "motion-graphic:dl-project", output: "motion-graphic:dl-output", name: "motion-graphic:dl-name", encoder: "motion-graphic:dl-encoder" };
const t = (key, fallback) => (typeof window.itzT === "function" ? window.itzT(key, fallback) : fallback);

const elStatus = document.getElementById("dl-status");
const elMeta = document.getElementById("dl-meta");
const elCountdown = document.getElementById("dl-countdown");
const elAgentHint = document.getElementById("dl-agent-hint");
const elBtnOutput = document.getElementById("dl-btn-output");
const elBtnFolder = document.getElementById("dl-btn-folder");

let countdownTimer = 0;

function session() {
  return {
    pid: sessionStorage.getItem(SS.pid) || "",
    output: sessionStorage.getItem(SS.output) || "",
    name: sessionStorage.getItem(SS.name) || "",
    encoder: sessionStorage.getItem(SS.encoder) || "",
  };
}

function setStatus(text, kind = "") {
  elStatus.textContent = text;
  elStatus.classList.remove("is-ok", "is-err");
  if (kind) elStatus.classList.add(kind === "ok" ? "is-ok" : "is-err");
}

function clearCountdown() {
  window.clearInterval(countdownTimer);
  countdownTimer = 0;
  elCountdown.classList.add("is-hidden");
  elCountdown.textContent = "";
}

async function agentOk() {
  const detail = await checkAgentConnection();
  elAgentHint.textContent = detail.ok ? "" : MSG_HELPER_NEED_APP();
  elAgentHint.classList.toggle("is-hidden", Boolean(detail.ok));
  return Boolean(detail.ok);
}

async function runDownload() {
  const { pid } = session();
  if (!pid) return;
  clearCountdown();
  if (!(await agentOk())) {
    setStatus(MSG_HELPER_NEED_APP(), "err");
    return;
  }
  window.open(`${getAgentOrigin()}${API}/download?project_id=${encodeURIComponent(pid)}`, "_blank", "noopener,noreferrer");
  setStatus(t("dl.started", "다운로드가 시작되었습니다."), "ok");
}

async function init() {
  const s = session();
  if (!s.pid) {
    setStatus(t("dl.noResult", "다운로드할 결과가 없습니다. 편집 화면에서 먼저 MP4 내보내기를 완료해 주세요."), "err");
    return;
  }
  const parts = [];
  if (s.name) parts.push(`${t("dlSource", "원본")}: ${s.name}`);
  if (s.encoder) parts.push(`${t("dlEncoder", "인코더")}: ${s.encoder === "h264_nvenc" ? "NVENC (GPU)" : "x264 (CPU)"}`);
  if (s.output) parts.push(s.output);
  elMeta.textContent = parts.join(" · ");
  if (!(await agentOk())) {
    setStatus(MSG_HELPER_NEED_APP(), "err");
    elBtnOutput.disabled = false;
    return;
  }
  elBtnOutput.disabled = false;
  elBtnFolder.disabled = false;
  let left = AUTO_START_SEC;
  setStatus(t("dlAuto", `${AUTO_START_SEC}초 후 자동으로 다운로드됩니다…`));
  elCountdown.classList.remove("is-hidden");
  elCountdown.textContent = String(left);
  countdownTimer = window.setInterval(() => {
    left -= 1;
    if (left > 0) {
      elCountdown.textContent = String(left);
      return;
    }
    void runDownload();
  }, 1000);
}

elBtnOutput.addEventListener("click", () => void runDownload());
elBtnFolder.addEventListener("click", async () => {
  const { pid } = session();
  if (!pid) return;
  clearCountdown();
  try {
    await requestAgent({ method: "POST", path: `${API}/open-folder`, json: { project_id: pid } });
  } catch (err) {
    setStatus(String(err?.message || err), "err");
  }
});

void showAdSense("downloadTop", "#dl-ad-top");
void showAdSense("downloadBottom", "#dl-ad-bottom");
void init();
