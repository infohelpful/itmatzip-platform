import {
  checkAgentConnection,
  configureBridge,
  requestAgent,
} from "../common/bridge.js?v=lna15";
import { showAdSense } from "../common/adsense.js";
import {
  buildFcpXmlViaAgent,
  canExportFromSession,
  getSessionFcpXmlForDownload,
  hasCachedExportForDownload,
  markEditorRestorePending,
  pickFcpSaveFileHandle,
  saveFcpXmlBlobToDisk,
  setDownloadFormatForSession,
  snapshotExportSettingsFromDom,
  validateExportPrerequisitesFromSession,
} from "../common/edl-export.js?v=lna43";
import { MSG_HELPER_NEED_APP } from "../common/local-helper-ui.js";

configureBridge({ healthPath: "/health" });

const EDITOR_PAGE = "index.html";

/** @type {boolean} */
let downloadInFlight = false;

const elTitle = document.getElementById("dl-title");
const elStatus = document.getElementById("dl-status");
const elCountdown = document.getElementById("dl-countdown");
const elSpinner = document.getElementById("dl-spinner");
const elAgentHint = document.getElementById("dl-agent-hint");
const elBtnNow = document.getElementById("dl-btn-now");
const elBtnBack = document.getElementById("dl-btn-back");

function applyLabels() {
  if (elTitle) elTitle.textContent = "XML 파일 다운로드";
  document.title = "XML 다운로드";
  if (elBtnNow) elBtnNow.textContent = "지금 다운로드";
  if (elBtnBack) elBtnBack.textContent = "편집 화면으로 돌아가기";
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
  if (elBtnNow) elBtnNow.disabled = busy;
  if (elCountdown) {
    elCountdown.classList.add("is-hidden");
    elCountdown.textContent = "";
  }
}

function enableBackNavigation() {
  if (elBtnBack) {
    elBtnBack.disabled = false;
    elBtnBack.textContent = "편집 화면으로 돌아가기";
  }
}

function enableBackOnAgentFailure() {
  if (elBtnBack) {
    elBtnBack.disabled = false;
    elBtnBack.textContent = "편집 화면으로 돌아가기 (다운로드 취소)";
  }
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

/**
 * 분석 직후 sessionStorage에 저장된 XML — 에이전트 호출 없이 즉시 저장.
 * @returns {Promise<boolean>}
 */
async function saveCachedExportFromSession(opts = {}) {
  const cachedXml = getSessionFcpXmlForDownload();
  if (!cachedXml) return false;
  const saveResult = await saveFcpXmlBlobToDisk(cachedXml, {
    fileHandle: opts.fileHandle ?? null,
  });
  if (saveResult.cancelled) {
    setStatus(
      "저장 대화상자를 닫았습니다. 저장하려면 지금 다운로드를 다시 눌러 주세요.",
      "err",
    );
    return true;
  }
  setStatus(
    `파일 저장을 시작했습니다. (분석 완료 XML, ${cachedXml.split("\n").length}줄)`,
    "ok",
  );
  return true;
}

/**
 * @param {{ fileHandle?: FileSystemFileHandle | null }} [opts]
 */
async function runDownload(opts = {}) {
  if (downloadInFlight) return;

  const prereq = validateExportPrerequisitesFromSession();
  if (!prereq.ok) {
    setStatus(prereq.message || "분석 데이터가 없습니다.", "err");
    enableBackOnAgentFailure();
    return;
  }

  downloadInFlight = true;
  setBusy(true);

  try {
    if (await saveCachedExportFromSession(opts)) {
      enableBackNavigation();
      if (elBtnNow) elBtnNow.disabled = false;
      return;
    }

    const agentOk = await ensureAgentConnected();
    if (!agentOk) {
      setStatus(MSG_HELPER_NEED_APP, "err");
      enableBackOnAgentFailure();
      return;
    }

    setStatus("XML 생성 중… (캐시 없음, 에이전트에서 생성)");
    const result = await buildFcpXmlViaAgent(requestAgent, { forceFresh: false });
    if (!result.ok || !result.fcp_xml) {
      setStatus(result.error || "XML 생성에 실패했습니다.", "err");
      enableBackOnAgentFailure();
      return;
    }
    const saveResult = await saveFcpXmlBlobToDisk(result.fcp_xml, {
      fileHandle: opts.fileHandle ?? null,
    });
    if (saveResult.cancelled) {
      setStatus(
        "저장 대화상자를 닫았습니다. 저장하려면 지금 다운로드를 다시 눌러 주세요.",
        "err",
      );
      return;
    }
    const lineCount = result.fcp_xml.split("\n").length;
    const cacheNote = result.fromCache ? " (분석 완료 XML)" : "";
    setStatus(`파일 저장을 시작했습니다.${cacheNote} (${lineCount}줄)`, "ok");
    enableBackNavigation();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(`다운로드에 실패했습니다.\n\n${msg}`, "err");
    enableBackOnAgentFailure();
  } finally {
    downloadInFlight = false;
    setBusy(false);
    if (elBtnNow) elBtnNow.disabled = false;
  }
}

async function initPage() {
  applyLabels();
  snapshotExportSettingsFromDom();

  void showAdSense("downloadTop", "#dl-ad-top");
  void showAdSense("downloadBottom", "#dl-ad-bottom");

  if (!canExportFromSession()) {
    setStatus(
      "분석 결과가 없습니다. 편집 화면에서 무음 구간 분석을 실행한 뒤 다시 시도해 주세요.",
      "err",
    );
    enableBackOnAgentFailure();
    return;
  }

  setDownloadFormatForSession("fcp");

  if (hasCachedExportForDownload("fcp")) {
    setStatus("분석 완료 XML 저장 중…");
  } else {
    setStatus("분석 XML이 없습니다. 에이전트 연결 후 생성합니다…");
  }

  if (elBtnBack) {
    elBtnBack.addEventListener("click", () => {
      markEditorRestorePending();
      window.location.href = EDITOR_PAGE;
    });
  }

  if (elBtnNow) {
    elBtnNow.disabled = false;
    elBtnNow.addEventListener("click", async () => {
      let fileHandle = null;
      if (typeof window.showSaveFilePicker === "function") {
        try {
          fileHandle = await pickFcpSaveFileHandle();
        } catch (e) {
          if (e && typeof e === "object" && e.name === "AbortError") {
            setStatus("저장을 취소했습니다.", "err");
            return;
          }
        }
      }
      await runDownload({ fileHandle });
    });
  }

  const autoRun = new URLSearchParams(window.location.search).get("auto") !== "0";
  if (autoRun) {
    await runDownload();
  }
}

initPage();
