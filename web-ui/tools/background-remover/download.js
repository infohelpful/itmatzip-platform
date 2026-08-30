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
const TOOL_API = "/api/tools/background-remover";

const STORAGE_CUTOUT = "background-remover:dl-cutout-path";
const STORAGE_MASK = "background-remover:dl-mask-path";
const STORAGE_SOURCE = "background-remover:dl-source-name";
const STORAGE_RETURN_FROM_DL = "background-remover:return-from-dl";

const elStatus = document.getElementById("dl-status");
const elMeta = document.getElementById("dl-meta");
const elCountdown = document.getElementById("dl-countdown");
const elSpinner = document.getElementById("dl-spinner");
const elAgentHint = document.getElementById("dl-agent-hint");
const elBtnCutout = document.getElementById("dl-btn-cutout");
const elBtnMask = document.getElementById("dl-btn-mask");
const elBtnBack = document.getElementById("dl-btn-back");

let countdownTimer = 0;
let countdownLeft = AUTO_START_SEC;

function normalizeFilePath(filePath) {
  return String(filePath || "").trim().replace(/\\/g, "/");
}

function readSession() {
  return {
    cutoutPath: sessionStorage.getItem(STORAGE_CUTOUT) || "",
    maskPath: sessionStorage.getItem(STORAGE_MASK) || "",
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

function startCountdown(cutoutPath) {
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
    void runDownload(cutoutPath, "PNG");
  }, 1000);
}

async function initPage() {
  document.title = window.ITZ_I18N?.tf?.("dl.docTitle", { tool: "Background Remover" }) || window.itzT("dl.docTitle", "Background Remover · 다운로드");
  const titleEl = document.getElementById("dl-title");
  if (titleEl) titleEl.textContent = window.itzT("dlTitle", "배경 제거 결과 다운로드");
  const session = readSession();
  if (!session.cutoutPath) {
    setStatus(window.itzT("dl.noResult", "다운로드할 결과가 없습니다. 편집 화면에서 먼저 배경 제거를 완료해 주세요."), "err");
    if (elMeta) elMeta.textContent = window.itzT("dl.noPath", "결과 파일 경로가 저장되지 않았습니다.");
    return;
  }
  if (elMeta) {
    const out = window.ITZ_I18N?.tf?.("dl.output", { label: "PNG" }) || "출력: 투명 PNG + 마스크";
    elMeta.textContent = session.source
      ? `${window.ITZ_I18N?.tf?.("dl.source", { name: session.source }) || `원본: ${session.source}`} · ${out}`
      : out;
  }

  const agentOk = await ensureAgentConnected();
  if (!agentOk) {
    setStatus(MSG_HELPER_NEED_APP(), "err");
    if (elBtnCutout) elBtnCutout.disabled = false;
    if (elBtnMask) elBtnMask.disabled = !session.maskPath;
    return;
  }

  if (elBtnCutout) elBtnCutout.disabled = false;
  if (elBtnMask) elBtnMask.disabled = !session.maskPath;
  startCountdown(session.cutoutPath);
}

elBtnCutout?.addEventListener("click", () => {
  const { cutoutPath } = readSession();
  if (!cutoutPath) return;
  clearCountdown();
  void runDownload(cutoutPath, "PNG");
});

elBtnMask?.addEventListener("click", () => {
  const { maskPath } = readSession();
  if (!maskPath) return;
  clearCountdown();
  void runDownload(maskPath, window.itzT("mask", "마스크"));
});

elBtnBack?.addEventListener("click", (ev) => {
  ev.preventDefault();
  sessionStorage.setItem(STORAGE_RETURN_FROM_DL, "1");
  window.location.assign(new URL(EDITOR_PAGE, window.location.href).href);
});

void showAdSense("downloadTop", "#dl-ad-top");
void showAdSense("downloadBottom", "#dl-ad-bottom");
void initPage();
