import { checkAgentConnection, configureBridge, getAgentOrigin } from "../common/bridge.js?v=as9";
import { showAdSense } from "../common/adsense.js";
import { exportFormatLabel } from "./export/export-client.js";
import { MSG_HELPER_NEED_APP } from "../common/local-helper-ui.js";

configureBridge({ healthPath: "/health" });

const EDITOR_PAGE = "index.html";
const AUTO_START_SEC = 3;
const TOOL_PREFIX = "/api/tools/auto-subtitle";
const SS_FILE_PATH = "auto-subtitle:dl-file-path";
const SS_FORMAT = "auto-subtitle:dl-format";

const elTitle = document.getElementById("dl-title");
const elStatus = document.getElementById("dl-status");
const elCountdown = document.getElementById("dl-countdown");
const elSpinner = document.getElementById("dl-spinner");
const elAgentHint = document.getElementById("dl-agent-hint");
const elBtnNow = document.getElementById("dl-btn-now");
const elBtnBack = document.getElementById("dl-btn-back");

let countdownTimer = 0;
let countdownLeft = AUTO_START_SEC;

function getDownloadParams() {
  try {
    const filePath = sessionStorage.getItem(SS_FILE_PATH);
    const fmt = sessionStorage.getItem(SS_FORMAT) || "srt";
    return { filePath, fmt };
  } catch {
    return { filePath: null, fmt: "srt" };
  }
}

function getDownloadUrl(filePath) {
  return `${getAgentOrigin()}${TOOL_PREFIX}/download?file_path=${encodeURIComponent(filePath)}`;
}

function getButtonLabel(fmt) {
  if (fmt === "video") return "영상 다운로드";
  const label = exportFormatLabel(fmt);
  return `${label} 다운로드`;
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
  setAgentHint(MSG_HELPER_NEED_APP, true);
  return false;
}

async function runDownload(filePath) {
  const ok = await ensureAgentConnected();
  if (!ok) {
    setStatus(MSG_HELPER_NEED_APP, "err");
    if (elBtnNow) elBtnNow.disabled = false;
    return;
  }
  clearCountdown();
  const url = getDownloadUrl(filePath);
  openDownload(url);
  setStatus("다운로드가 시작되었습니다. 다시 받으려면 버튼을 클릭하세요.", "ok");
  if (elBtnNow) elBtnNow.disabled = false;
}

function startCountdown(filePath) {
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
    void runDownload(filePath);
  }, 1000);
}

async function initPage() {
  const { filePath, fmt } = getDownloadParams();

  if (!filePath) {
    setStatus("다운로드할 파일이 없습니다. 편집화면에서 보내기를 실행해 주세요.", "err");
    if (elBtnNow) elBtnNow.disabled = true;
    if (elBtnBack) elBtnBack.classList.remove("disabled");
    return;
  }

  if (elTitle) elTitle.textContent = `${getButtonLabel(fmt)}`;
  document.title = `${getButtonLabel(fmt)} - Auto Subtitle`;
  if (elBtnNow) elBtnNow.textContent = getButtonLabel(fmt);

  const agentOk = await ensureAgentConnected();
  if (!agentOk) {
    setStatus(MSG_HELPER_NEED_APP, "err");
    if (elBtnNow) elBtnNow.disabled = false;
    return;
  }

  if (elBtnNow) elBtnNow.disabled = false;
  startCountdown(filePath);
}

elBtnNow?.addEventListener("click", () => {
  const { filePath } = getDownloadParams();
  if (!filePath) return;
  clearCountdown();
  void runDownload(filePath);
});

elBtnBack?.addEventListener("click", (ev) => {
  ev.preventDefault();
  window.location.href = EDITOR_PAGE;
});

void showAdSense("downloadTop", "#dl-ad-top");
void showAdSense("downloadBottom", "#dl-ad-bottom");

void initPage();
