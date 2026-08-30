import { checkAgentConnection, configureBridge, getAgentOrigin } from "../common/bridge.js?v=ws4";
import { showAdSense } from "../common/adsense.js?v=4";
import { AGENT_PORT } from "../common/agent-endpoints.js";
import { MSG_HELPER_NEED_APP } from "../common/local-helper-ui.js";

if (typeof window !== "undefined") {
  const h = window.location.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "127.0.0.1" || h === "localhost" || h === "::1") {
    configureBridge({
      healthPath: "/health",
      origin: `${window.location.protocol}//${h}:${AGENT_PORT}`,
    });
  } else {
    configureBridge({ healthPath: "/health" });
  }
} else {
  configureBridge({ healthPath: "/health" });
}

const AUTO_START_SEC = 3;
const EDITOR_PAGE = "index.html";
const TOOL_API = "/api/tools/magic-eraser";

const STORAGE_OUTPUT = "magic-eraser:dl-output-path";
const STORAGE_SOURCE = "magic-eraser:dl-source-name";
const STORAGE_RETURN_FROM_DL = "magic-eraser:return-from-dl";

const elStatus = document.getElementById("dl-status");
const elMeta = document.getElementById("dl-meta");
const elCountdown = document.getElementById("dl-countdown");
const elSpinner = document.getElementById("dl-spinner");
const elAgentHint = document.getElementById("dl-agent-hint");
const elBtnOutput = document.getElementById("dl-btn-output");
const elBtnBack = document.getElementById("dl-btn-back");

let countdownTimer = 0;
let countdownLeft = AUTO_START_SEC;

function normalizeFilePath(filePath) {
  return String(filePath || "").trim().replace(/\\/g, "/");
}

function readSession() {
  return {
    outputPath: sessionStorage.getItem(STORAGE_OUTPUT) || "",
    source: sessionStorage.getItem(STORAGE_SOURCE) || "",
  };
}

function getDownloadUrl(filePath) {
  return `${getAgentOrigin()}${TOOL_API}/download?file_path=${encodeURIComponent(normalizeFilePath(filePath))}`;
}

function setStatus(text, kind = "") {
  if (!elStatus) return;
  elStatus.textContent = text;
  elStatus.classList.remove("is-ok", "is-err");
  if (kind === "ok") elStatus.classList.add("is-ok");
  if (kind === "err") elStatus.classList.add("is-err");
}

function setAgentHint(text, visible) {
  if (!elAgentHint) return;
  elAgentHint.textContent = text || "";
  elAgentHint.classList.toggle("is-hidden", !visible);
}

function showCountdown(sec) {
  if (!elCountdown) return;
  if (sec <= 0) {
    elCountdown.classList.add("is-hidden");
    elCountdown.textContent = "";
    return;
  }
  elCountdown.classList.remove("is-hidden");
  elCountdown.textContent = String(sec);
}

function clearCountdown() {
  window.clearInterval(countdownTimer);
  countdownTimer = 0;
  showCountdown(0);
}

function openDownload(url) {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

async function ensureAgentConnected() {
  const detail = await checkAgentConnection();
  if (detail.ok) {
    setAgentHint("", false);
    return true;
  }
  setAgentHint(MSG_HELPER_NEED_APP(), true);
  return false;
}

async function runDownload(filePath, label) {
  const ok = await ensureAgentConnected();
  if (!ok) {
    setStatus(MSG_HELPER_NEED_APP(), "err");
    return;
  }
  clearCountdown();
  if (elSpinner) elSpinner.classList.add("is-hidden");
  openDownload(getDownloadUrl(filePath));
  setStatus(window.ITZ_I18N?.tf?.("dl.startedNamed", { label }) || `${label} ${window.itzT("dl.started", "다운로드가 시작되었습니다.")}`, "ok");
}

function startCountdown(outputPath) {
  countdownLeft = AUTO_START_SEC;
  setStatus(window.ITZ_I18N?.tf?.("dl.autoStart", { n: AUTO_START_SEC }) || `${AUTO_START_SEC}초 후 자동으로 다운로드됩니다…`);
  showCountdown(countdownLeft);
  countdownTimer = window.setInterval(() => {
    countdownLeft -= 1;
    if (countdownLeft > 0) {
      showCountdown(countdownLeft);
      return;
    }
    clearCountdown();
    void runDownload(outputPath, window.itzT("ui.result", "결과 이미지"));
  }, 1000);
}

async function initPage() {
  document.title = window.ITZ_I18N?.tf?.("dl.docTitle", { tool: "MagicEraser" }) || window.itzT("dl.docTitle", "MagicEraser · 다운로드");
  if (document.getElementById("dl-title")) {
    document.getElementById("dl-title").textContent = window.itzT("dlTitle", "지우기 결과 다운로드");
  }
  const session = readSession();
  if (!session.outputPath) {
    setStatus(window.itzT("dl.noResult", "다운로드할 결과가 없습니다. 편집 화면에서 먼저 지우기를 완료해 주세요."), "err");
    if (elMeta) elMeta.textContent = window.itzT("dl.noPath", "결과 파일 경로가 저장되지 않았습니다.");
    return;
  }
  if (elMeta) {
    const out = window.ITZ_I18N?.tf?.("dl.output", { label: window.itzT("dlTitle", "지우기 결과 이미지") }) || "출력: 지우기 결과 이미지";
    elMeta.textContent = session.source
      ? `${window.ITZ_I18N?.tf?.("dl.source", { name: session.source }) || `원본: ${session.source}`} · ${out}`
      : out;
  }

  const agentOk = await ensureAgentConnected();
  if (!agentOk) {
    setStatus(MSG_HELPER_NEED_APP(), "err");
    if (elBtnOutput) elBtnOutput.disabled = false;
    return;
  }

  if (elBtnOutput) elBtnOutput.disabled = false;
  startCountdown(session.outputPath);
}

elBtnOutput?.addEventListener("click", () => {
  const { outputPath } = readSession();
  if (!outputPath) return;
  clearCountdown();
  void runDownload(outputPath, window.itzT("ui.result", "결과 이미지"));
});

elBtnBack?.addEventListener("click", (ev) => {
  ev.preventDefault();
  sessionStorage.setItem(STORAGE_RETURN_FROM_DL, "1");
  window.location.assign(new URL(EDITOR_PAGE, window.location.href).href);
});

void showAdSense("downloadTop", "#dl-ad-top");
void showAdSense("downloadBottom", "#dl-ad-bottom");
void initPage();
