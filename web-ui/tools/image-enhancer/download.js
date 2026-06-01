import { checkAgentConnection, configureBridge, getAgentOrigin } from "../common/bridge.js?v=ws3";
import { showAdSense } from "../common/adsense.js";
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
const TOOL_API = "/api/tools/image-enhancer";

const STORAGE_RESULT_PATH = "image-enhancer:dl-result-path";
const STORAGE_FORMAT = "image-enhancer:dl-output-format";
const STORAGE_SOURCE = "image-enhancer:dl-source-name";
const STORAGE_RETURN_FROM_DL = "image-enhancer:return-from-dl";

const elTitle = document.getElementById("dl-title");
const elStatus = document.getElementById("dl-status");
const elMeta = document.getElementById("dl-meta");
const elCountdown = document.getElementById("dl-countdown");
const elSpinner = document.getElementById("dl-spinner");
const elAgentHint = document.getElementById("dl-agent-hint");
const elBtnNow = document.getElementById("dl-btn-now");
const elBtnBack = document.getElementById("dl-btn-back");

let countdownTimer = 0;
let countdownLeft = AUTO_START_SEC;

function normalizeFilePath(filePath) {
  return String(filePath || "").trim().replace(/\\/g, "/");
}

function readSession() {
  return {
    resultPath: sessionStorage.getItem(STORAGE_RESULT_PATH) || "",
    format: (sessionStorage.getItem(STORAGE_FORMAT) || "png").toLowerCase(),
    source: sessionStorage.getItem(STORAGE_SOURCE) || "",
  };
}

function canDownloadFromSession() {
  return Boolean(readSession().resultPath);
}

function formatLabel(fmt) {
  if (fmt === "jpg" || fmt === "jpeg") return "JPEG";
  return "PNG";
}

function getButtonLabel(fmt) {
  return `${formatLabel(fmt)} 결과 다운로드`;
}

function getDownloadUrl(resultPath) {
  const normalized = normalizeFilePath(resultPath);
  return `${getAgentOrigin()}${TOOL_API}/download?file_path=${encodeURIComponent(normalized)}`;
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

function setBusy(busy) {
  if (elSpinner) elSpinner.classList.toggle("is-hidden", !busy);
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
  setAgentHint(MSG_HELPER_NEED_APP, true);
  return false;
}

async function runDownload(resultPath) {
  const ok = await ensureAgentConnected();
  if (!ok) {
    setStatus(MSG_HELPER_NEED_APP, "err");
    if (elBtnNow) elBtnNow.disabled = false;
    return;
  }
  clearCountdown();
  setBusy(false);
  openDownload(getDownloadUrl(resultPath));
  setStatus("다운로드가 시작되었습니다. 다시 받으려면 버튼을 클릭하세요.", "ok");
  if (elBtnNow) elBtnNow.disabled = false;
}

function startCountdown(resultPath) {
  countdownLeft = AUTO_START_SEC;
  setStatus(`${AUTO_START_SEC}초 후 자동으로 다운로드됩니다…`);
  showCountdown(countdownLeft);

  countdownTimer = window.setInterval(() => {
    countdownLeft -= 1;
    if (countdownLeft > 0) {
      showCountdown(countdownLeft);
      return;
    }
    clearCountdown();
    void runDownload(resultPath);
  }, 1000);
}

async function initPage() {
  if (elTitle) elTitle.textContent = "향상 결과 다운로드";
  document.title = "Image Enhancer · 다운로드";

  const session = readSession();
  if (!canDownloadFromSession()) {
    setStatus("다운로드할 결과가 없습니다. 편집 화면에서 먼저 화질 향상을 완료해 주세요.", "err");
    if (elMeta) elMeta.textContent = "결과 파일 경로가 저장되지 않았습니다.";
    if (elBtnBack) elBtnBack.disabled = false;
    return;
  }

  const fmtLabel = formatLabel(session.format);
  if (elMeta) {
    const parts = [];
    if (session.source) parts.push(`원본: ${session.source}`);
    parts.push(`출력: ${fmtLabel}`);
    elMeta.textContent = parts.join(" · ");
  }
  if (elBtnNow) elBtnNow.textContent = getButtonLabel(session.format);

  const agentOk = await ensureAgentConnected();
  if (!agentOk) {
    setStatus(MSG_HELPER_NEED_APP, "err");
    if (elBtnNow) elBtnNow.disabled = false;
    if (elBtnBack) elBtnBack.disabled = false;
    return;
  }

  if (elBtnNow) elBtnNow.disabled = false;
  if (elBtnBack) elBtnBack.disabled = false;
  startCountdown(session.resultPath);
}

elBtnNow?.addEventListener("click", () => {
  const { resultPath } = readSession();
  if (!resultPath) return;
  clearCountdown();
  void runDownload(resultPath);
});

elBtnBack?.addEventListener("click", (ev) => {
  ev.preventDefault();
  sessionStorage.setItem(STORAGE_RETURN_FROM_DL, "1");
  window.location.assign(new URL(EDITOR_PAGE, window.location.href).href);
});

void showAdSense("downloadTop", "#dl-ad-top");
void showAdSense("downloadBottom", "#dl-ad-bottom");

void initPage();
