import {
  checkAgentConnection,
  configureBridge,
  fetchAgent,
} from "../common/bridge.js";
import { showAdSense } from "../common/adsense.js?v=4";
import { MSG_HELPER_NEED_APP } from "../common/local-helper-ui.js";
import { encodeAudioBufferToMp3Blob, triggerBlobDownload } from "./mp3-export.js";

configureBridge({ healthPath: "/health" });

const AUTO_START_SEC = 3;
const EDITOR_PAGE = "index.html";

const STORAGE_JOB_ID = "create-music:job-id";
const STORAGE_FILENAME = "create-music:filename";
const STORAGE_SOURCE = "create-music:source-name";
const STORAGE_MP3_URL = "create-music:mp3-download-url";
const STORAGE_WAV_URL = "create-music:wav-download-url";

const elTitle = document.getElementById("dl-title");
const elStatus = document.getElementById("dl-status");
const elMeta = document.getElementById("dl-meta");
const elCountdown = document.getElementById("dl-countdown");
const elSpinner = document.getElementById("dl-spinner");
const elAgentHint = document.getElementById("dl-agent-hint");
const elBtnMp3 = document.getElementById("dl-btn-mp3");
const elBtnBack = document.getElementById("dl-btn-back");

let countdownTimer = 0;
let countdownLeft = AUTO_START_SEC;
let downloadInFlight = false;

function readSession() {
  return {
    jobId: sessionStorage.getItem(STORAGE_JOB_ID) || "",
    filename: sessionStorage.getItem(STORAGE_FILENAME) || "",
    source: sessionStorage.getItem(STORAGE_SOURCE) || "",
    mp3Url: sessionStorage.getItem(STORAGE_MP3_URL) || "",
    wavUrl: sessionStorage.getItem(STORAGE_WAV_URL) || "",
  };
}

function canDownloadFromSession() {
  const { jobId, filename, mp3Url, wavUrl } = readSession();
  return Boolean(jobId && filename && (mp3Url || wavUrl));
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
  if (elBtnMp3) elBtnMp3.disabled = busy;
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

async function ensureAgentConnected() {
  const detail = await checkAgentConnection();
  if (detail.ok) {
    setAgentHint("", false);
    return true;
  }
  setAgentHint(MSG_HELPER_NEED_APP, true);
  return false;
}

async function downloadMp3Blob(session) {
  const base = session.filename.replace(/\.[^.]+$/, "") || session.jobId;

  if (session.mp3Url) {
    const res = await fetchAgent(session.mp3Url);
    if (res.ok) {
      triggerBlobDownload(await res.blob(), `${base}.mp3`);
      return { ok: true, via: "server" };
    }
    if (res.status !== 404) {
      const err = await res.json().catch(() => ({}));
      throw new Error(typeof err.detail === "string" ? err.detail : res.statusText);
    }
  }

  if (!session.wavUrl) {
    throw new Error("다운로드 URL이 없습니다.");
  }

  setStatus("브라우저에서 MP3로 변환 중… (시간이 걸릴 수 있습니다)");
  const wavRes = await fetchAgent(session.wavUrl);
  if (!wavRes.ok) {
    const err = await wavRes.json().catch(() => ({}));
    throw new Error(typeof err.detail === "string" ? err.detail : "원본 오디오를 불러올 수 없습니다.");
  }
  const data = await wavRes.arrayBuffer();
  const ctx = new AudioContext();
  let buffer;
  try {
    buffer = await ctx.decodeAudioData(data.slice(0));
  } finally {
    await ctx.close().catch(() => {});
  }
  const blob = await encodeAudioBufferToMp3Blob(buffer);
  triggerBlobDownload(blob, `${base}.mp3`);
  return { ok: true, via: "browser" };
}

async function runDownload() {
  if (downloadInFlight) return;

  const session = readSession();
  if (!canDownloadFromSession()) {
    setStatus("다운로드할 음악이 없습니다. 편집 화면에서 먼저 생성해 주세요.", "err");
    if (elBtnBack) elBtnBack.disabled = false;
    return;
  }

  const agentOk = await ensureAgentConnected();
  if (!agentOk) {
    setStatus(MSG_HELPER_NEED_APP, "err");
    if (elBtnMp3) elBtnMp3.disabled = false;
    if (elBtnBack) elBtnBack.disabled = false;
    return;
  }

  downloadInFlight = true;
  clearCountdown();
  setBusy(true);
  setStatus("MP3 변환·다운로드 준비 중…");

  try {
    const result = await downloadMp3Blob(session);
    const viaLabel = result.via === "server" ? "에이전트(FFmpeg)" : "브라우저";
    setStatus(`MP3 다운로드가 시작되었습니다. (${viaLabel}) 다시 받으려면 버튼을 눌러 주세요.`, "ok");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(`MP3 다운로드 실패: ${msg}`, "err");
  } finally {
    downloadInFlight = false;
    setBusy(false);
    if (elBtnMp3) elBtnMp3.disabled = false;
    if (elBtnBack) elBtnBack.disabled = false;
  }
}

function startCountdown() {
  countdownLeft = AUTO_START_SEC;
  setStatus(`${AUTO_START_SEC}초 후 자동으로 MP3 다운로드가 시작됩니다…`);
  showCountdown(countdownLeft);

  countdownTimer = window.setInterval(() => {
    countdownLeft -= 1;
    if (countdownLeft > 0) {
      showCountdown(countdownLeft);
      return;
    }
    clearCountdown();
    void runDownload();
  }, 1000);
}

async function initPage() {
  if (elTitle) elTitle.textContent = "생성 음악 MP3 다운로드";
  document.title = "Create Music · MP3 다운로드";

  const session = readSession();
  if (!canDownloadFromSession()) {
    setStatus("생성 결과가 없습니다. 편집 화면에서 먼저 음악을 생성해 주세요.", "err");
    if (elMeta) elMeta.textContent = "세션에 트랙 정보가 저장되지 않았습니다.";
    if (elBtnBack) elBtnBack.disabled = false;
    return;
  }

  if (elMeta) {
    const label = session.source || session.filename;
    elMeta.textContent = label ? `파일: ${label}` : "";
  }

  const agentOk = await ensureAgentConnected();
  if (!agentOk) {
    setStatus(MSG_HELPER_NEED_APP, "err");
    if (elBtnBack) elBtnBack.disabled = false;
    return;
  }

  if (elBtnMp3) elBtnMp3.disabled = false;
  if (elBtnBack) elBtnBack.disabled = false;

  startCountdown();
}

elBtnMp3?.addEventListener("click", () => {
  clearCountdown();
  void runDownload();
});

void showAdSense("downloadTop", "#dl-ad-top");
void showAdSense("downloadBottom", "#dl-ad-bottom");

void initPage();
