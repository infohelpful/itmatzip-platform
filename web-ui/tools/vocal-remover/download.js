import { checkAgentConnection, configureBridge, fetchAgent, getAgentOrigin } from "../common/bridge.js?v=lna16";
import { MSG_HELPER_NEED_APP } from "../common/local-helper-ui.js";

configureBridge({ healthPath: "/health" });

const EDITOR_PAGE = "index.html";
const STORAGE_MR_URL = "vocal-remover:mr-download-url";
const STORAGE_VOCAL_URL = "vocal-remover:vocal-download-url";
const STORAGE_FORMAT = "vocal-remover:output-format";
const STORAGE_SOURCE = "vocal-remover:source-name";

const elTitle = document.getElementById("dl-title");
const elStatus = document.getElementById("dl-status");
const elMeta = document.getElementById("dl-meta");
const elAgentHint = document.getElementById("dl-agent-hint");
const elBtnMr = document.getElementById("dl-btn-mr");
const elBtnVocal = document.getElementById("dl-btn-vocal");
const elBtnBack = document.getElementById("dl-btn-back");

function clearDownloadSession() {
  sessionStorage.removeItem(STORAGE_MR_URL);
  sessionStorage.removeItem(STORAGE_VOCAL_URL);
  sessionStorage.removeItem(STORAGE_FORMAT);
  sessionStorage.removeItem(STORAGE_SOURCE);
}

async function cleanupAgentWorkspace() {
  try {
    const res = await fetchAgent(`${getAgentOrigin()}/api/tools/vocal-remover/workspace/cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    return res.ok || res.status === 409;
  } catch {
    return false;
  }
}

function readSession() {
  return {
    mrUrl: sessionStorage.getItem(STORAGE_MR_URL) || "",
    vocalUrl: sessionStorage.getItem(STORAGE_VOCAL_URL) || "",
    format: sessionStorage.getItem(STORAGE_FORMAT) || "WAV",
    source: sessionStorage.getItem(STORAGE_SOURCE) || "",
  };
}

function canDownloadFromSession() {
  const { mrUrl, vocalUrl } = readSession();
  return Boolean(mrUrl && vocalUrl);
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

function enableDownloads() {
  if (elBtnMr) elBtnMr.disabled = false;
  if (elBtnVocal) elBtnVocal.disabled = false;
  if (elBtnBack) elBtnBack.disabled = false;
}

function openDownload(url) {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

function applyTitles() {
  if (elTitle) elTitle.textContent = window.itzT("dlTitle", "분리 결과 다운로드");
  document.title = window.ITZ_I18N?.tf?.("dl.docTitle", { tool: "Vocal Remover" }) || window.itzT("dl.docTitle", "Vocal Remover · 다운로드");
}

function initPage() {
  applyTitles();

  const session = readSession();
  if (!canDownloadFromSession()) {
    setStatus(window.itzT("dl.noResult", "분리 결과가 없습니다. 편집 화면에서 먼저 분석하기를 실행해 주세요."), "err");
    if (elMeta) {
      elMeta.textContent = window.itzT("dl.noPath", "MR·보컬 URL이 저장되지 않았습니다.");
    }
    if (elBtnBack) elBtnBack.disabled = false;
    return;
  }

  const sourceLabel = session.source ? (window.ITZ_I18N?.tf?.("dl.source", { name: session.source }) || `원본: ${session.source}`) : "";
  if (elMeta) {
    const fmt = window.ITZ_I18N?.tf?.("dl.formatLine", { fmt: session.format }) || `MR 포맷: ${session.format}`;
    elMeta.textContent = [sourceLabel, fmt].filter(Boolean).join(" · ");
  }
  setStatus(window.itzT("dl.started", "아래 버튼으로 MR·보컬 파일을 저장하세요."), "ok");
  enableDownloads();
}

document.addEventListener("itz:lang-change", () => applyTitles());

async function ensureAgentConnected() {
  const detail = await checkAgentConnection();
  if (detail.ok) {
    setAgentHint("", false);
    return true;
  }
  setAgentHint(MSG_HELPER_NEED_APP(), true);
  return false;
}

async function goBackToEditor(ev) {
  ev.preventDefault();
  if (elBtnBack) elBtnBack.disabled = true;
  await cleanupAgentWorkspace();
  clearDownloadSession();
  window.location.assign(new URL(EDITOR_PAGE, window.location.href).href);
}

elBtnMr?.addEventListener("click", async () => {
  const { mrUrl } = readSession();
  if (!mrUrl) return;
  const ok = await ensureAgentConnected();
  if (!ok) return;
  openDownload(mrUrl);
});

elBtnVocal?.addEventListener("click", async () => {
  const { vocalUrl } = readSession();
  if (!vocalUrl) return;
  const ok = await ensureAgentConnected();
  if (!ok) return;
  openDownload(vocalUrl);
});

elBtnBack?.addEventListener("click", (ev) => {
  void goBackToEditor(ev);
});

initPage();
