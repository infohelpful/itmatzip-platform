import {
  checkAgentConnection,
  configureBridge,
  fetchAgent,
} from "../common/bridge.js";
import { showAdSense } from "../common/adsense.js?v=6";
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
const STORAGE_FORMAT = "create-music:format";

const elTitle = document.getElementById("dl-title");
const elStatus = document.getElementById("dl-status");
const elMeta = document.getElementById("dl-meta");
const elCountdown = document.getElementById("dl-countdown");
const elSpinner = document.getElementById("dl-spinner");
const elAgentHint = document.getElementById("dl-agent-hint");
const elBtnMp3 = document.getElementById("dl-btn-mp3");
const elBtnBack = document.getElementById("dl-btn-back");
const elFormat = document.getElementById("dl-format");

/** 만들기 화면에서 누른 형식 (mp3 | wav). 페이지에서 바꿀 수 있음 */
let format = "mp3";
try {
  format = sessionStorage.getItem(STORAGE_FORMAT) === "wav" ? "wav" : "mp3";
} catch {
  format = "mp3";
}
const FORMAT_LABEL = { mp3: "MP3", wav: "WAV" };

function t(key, fallback) {
  return typeof window.itzT === "function" ? window.itzT(key, fallback) : fallback;
}

function tf(key, fallback, vars) {
  let s = t(key, fallback);
  if (vars) {
    Object.keys(vars).forEach((k) => {
      s = s.split(`{${k}}`).join(String(vars[k] == null ? "" : vars[k]));
    });
  }
  return s;
}

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
  setAgentHint(MSG_HELPER_NEED_APP(), true);
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
    throw new Error(t("dlNoUrl", "다운로드 URL이 없습니다."));
  }

  setStatus(t("dlBrowserConvert", "브라우저에서 MP3로 변환 중… (시간이 걸릴 수 있습니다)"));
  const wavRes = await fetchAgent(session.wavUrl);
  if (!wavRes.ok) {
    const err = await wavRes.json().catch(() => ({}));
    throw new Error(typeof err.detail === "string" ? err.detail : t("dlLoadWavFail", "원본 오디오를 불러올 수 없습니다."));
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

function downloadLabel() {
  return tf("dlBtnFmt", "{f} 다운로드", { f: FORMAT_LABEL[format] });
}

function setFormat(next) {
  format = next === "wav" ? "wav" : "mp3";
  try {
    sessionStorage.setItem(STORAGE_FORMAT, format);
  } catch {
    /* 저장 못 해도 이 페이지에서는 동작 */
  }
  elFormat?.querySelectorAll("[data-format]").forEach((b) => {
    const on = b.getAttribute("data-format") === format;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-checked", String(on));
  });
  if (elBtnMp3) elBtnMp3.textContent = downloadLabel();
}

async function downloadWavBlob(session) {
  if (!session.wavUrl) throw new Error(t("dlNoUrl", "다운로드 URL이 없습니다."));
  const res = await fetchAgent(session.wavUrl);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(typeof err.detail === "string" ? err.detail : t("dlLoadWavFail", "원본 오디오를 불러올 수 없습니다."));
  }
  const base = session.filename.replace(/\.[^.]+$/, "") || session.jobId;
  triggerBlobDownload(await res.blob(), `${base}.wav`);
  return { ok: true, via: "server" };
}

async function runDownload() {
  if (downloadInFlight) return;

  const session = readSession();
  if (!canDownloadFromSession()) {
    setStatus(t("dlNoMusic", "다운로드할 음악이 없습니다. 편집 화면에서 먼저 생성해 주세요."), "err");
    if (elBtnBack) elBtnBack.disabled = false;
    return;
  }

  const agentOk = await ensureAgentConnected();
  if (!agentOk) {
    setStatus(MSG_HELPER_NEED_APP(), "err");
    if (elBtnMp3) elBtnMp3.disabled = false;
    if (elBtnBack) elBtnBack.disabled = false;
    return;
  }

  downloadInFlight = true;
  clearCountdown();
  setBusy(true);
  const isWav = format === "wav";
  setStatus(isWav ? t("dlPrepWav", "WAV 다운로드 준비 중…") : t("dlPrepDownload", "MP3 변환·다운로드 준비 중…"));

  try {
    if (isWav) {
      await downloadWavBlob(session);
      setStatus(t("dlStartedWav", "WAV 다운로드가 시작되었습니다. 다시 받으려면 버튼을 눌러 주세요."), "ok");
    } else {
      const result = await downloadMp3Blob(session);
      const viaLabel = result.via === "server" ? t("dlViaAgent", "에이전트(FFmpeg)") : t("dlViaBrowser", "브라우저");
      setStatus(tf("dlStarted", "MP3 다운로드가 시작되었습니다. ({via}) 다시 받으려면 버튼을 눌러 주세요.", { via: viaLabel }), "ok");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(tf("dlFailFmt", "{f} 다운로드 실패: {msg}", { f: FORMAT_LABEL[format], msg }), "err");
  } finally {
    downloadInFlight = false;
    setBusy(false);
    if (elBtnMp3) elBtnMp3.disabled = false;
    if (elBtnBack) elBtnBack.disabled = false;
  }
}

function startCountdown() {
  countdownLeft = AUTO_START_SEC;
  setStatus(tf("dlCountdownFmt", "{n}초 후 자동으로 {f} 다운로드가 시작됩니다…", { n: AUTO_START_SEC, f: FORMAT_LABEL[format] }));
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
  document.title = t("dlTitle2", "Create Music · 음악 다운로드");
  setFormat(format);

  const session = readSession();
  if (!canDownloadFromSession()) {
    setStatus(t("dlNoResult", "생성 결과가 없습니다. 편집 화면에서 먼저 음악을 생성해 주세요."), "err");
    if (elMeta) elMeta.textContent = t("dlNoSession", "세션에 트랙 정보가 저장되지 않았습니다.");
    if (elBtnBack) elBtnBack.disabled = false;
    return;
  }

  if (elMeta) {
    const label = session.source || session.filename;
    elMeta.textContent = label ? tf("dlFileMeta", "파일: {name}", { name: label }) : "";
  }

  const agentOk = await ensureAgentConnected();
  if (!agentOk) {
    setStatus(MSG_HELPER_NEED_APP(), "err");
    if (elBtnBack) elBtnBack.disabled = false;
    return;
  }

  if (elBtnMp3) elBtnMp3.disabled = false;
  if (elBtnBack) elBtnBack.disabled = false;

  startCountdown();
}

elFormat?.querySelectorAll("[data-format]").forEach((b) =>
  b.addEventListener("click", () => {
    if (downloadInFlight) return;
    setFormat(b.getAttribute("data-format"));
    // 자동 시작 전이면 바뀐 형식으로 카운트다운 다시
    if (countdownTimer) {
      clearCountdown();
      startCountdown();
    }
  }),
);

elBtnMp3?.addEventListener("click", () => {
  clearCountdown();
  void runDownload();
});

void showAdSense("downloadTop", "#dl-ad-top");
void showAdSense("downloadBottom", "#dl-ad-bottom");

document.addEventListener("itz:lang-change", () => {
  document.title = t("dlTitle2", "Create Music · 음악 다운로드");
  if (elTitle) elTitle.textContent = t("dlH1b", "만든 음악 다운로드");
  if (elBtnMp3) elBtnMp3.textContent = downloadLabel();
  const session = readSession();
  if (elMeta && canDownloadFromSession()) {
    const label = session.source || session.filename;
    elMeta.textContent = label ? tf("dlFileMeta", "파일: {name}", { name: label }) : "";
  }
  if (!downloadInFlight && countdownTimer && countdownLeft > 0) {
    setStatus(tf("dlCountdownFmt", "{n}초 후 자동으로 {f} 다운로드가 시작됩니다…", { n: countdownLeft, f: FORMAT_LABEL[format] }));
  }
});

void initPage();
