import {
  checkAgentConnection,
  configureBridge,
  requestAgent,
} from "../common/bridge.js?v=lna3";
import { showAdSense } from "../common/adsense.js";
import {
  buildEdlViaAgent,
  canExportFromSession,
  markEditorRestorePending,
  pickEdlSaveFileHandle,
  saveEdlBlobToDisk,
  validateExportPrerequisitesFromSession,
} from "../common/edl-export.js";
import { MSG_HELPER_NEED_APP } from "../common/local-helper-ui.js";

configureBridge({ healthPath: "/health" });

const AUTO_START_SEC = 3;
const EDITOR_PAGE = "index.html";

/** @type {boolean} */
let downloadInFlight = false;
/** @type {number} */
let countdownTimer = 0;
/** @type {number} */
let countdownLeft = AUTO_START_SEC;

const elTitle = document.getElementById("dl-title");
const elStatus = document.getElementById("dl-status");
const elCountdown = document.getElementById("dl-countdown");
const elSpinner = document.getElementById("dl-spinner");
const elAgentHint = document.getElementById("dl-agent-hint");
const elBtnNow = document.getElementById("dl-btn-now");
const elBtnBack = document.getElementById("dl-btn-back");

function applyLabels() {
  if (elTitle) elTitle.textContent = "EDL \uD30C\uC77C \uB2E4\uC6B4\uB85C\uB4DC";
  if (elBtnNow) elBtnNow.textContent = "\uC9C0\uAE08 \uB2E4\uC6B4\uB85C\uB4DC";
  if (elBtnBack) elBtnBack.textContent = "\uD3B8\uC9D1 \uD654\uBA74\uC73C\uB85C \uB3CC\uC544\uAC00\uAE30";
  document.title = "EDL \uB2E4\uC6B4\uB85C\uB4DC";
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

function enableBackNavigation() {
  if (elBtnBack) {
    elBtnBack.disabled = false;
    elBtnBack.textContent = "\uD3B8\uC9D1 \uD654\uBA74\uC73C\uB85C \uB3CC\uC544\uAC00\uAE30";
  }
}

function enableBackOnAgentFailure() {
  if (elBtnBack) {
    elBtnBack.disabled = false;
    elBtnBack.textContent =
      "\uD3B8\uC9D1 \uD654\uBA74\uC73C\uB85C \uB3CC\uC544\uAC00\uAE30 (\uB2E4\uC6B4\uB85C\uB4DC \uCDE8\uC18C)";
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
 * @param {{ fileHandle?: FileSystemFileHandle | null }} [opts]
 */
async function runDownload(opts = {}) {
  if (downloadInFlight) return;

  const prereq = validateExportPrerequisitesFromSession();
  if (!prereq.ok) {
    setStatus(prereq.message || "\uBD84\uC11D \uB370\uC774\uD130\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.", "err");
    enableBackOnAgentFailure();
    return;
  }

  const agentOk = await ensureAgentConnected();
  if (!agentOk) {
    setStatus(MSG_HELPER_NEED_APP, "err");
    enableBackOnAgentFailure();
    return;
  }

  downloadInFlight = true;
  clearCountdown();
  setBusy(true);
  setStatus("EDL \uC0DD\uC131 \uC911\u2026");

  const result = await buildEdlViaAgent(requestAgent);
  downloadInFlight = false;
  setBusy(false);

  if (!result.ok || !result.edl) {
    setStatus(result.error || "EDL \uC0DD\uC131\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.", "err");
    if (elBtnNow) elBtnNow.disabled = false;
    enableBackOnAgentFailure();
    return;
  }

  let saveResult;
  try {
    saveResult = await saveEdlBlobToDisk(result.edl, {
      fileHandle: opts.fileHandle ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(`\uD30C\uC77C \uC800\uC7A5\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.\n\n${msg}`, "err");
    if (elBtnNow) elBtnNow.disabled = false;
    enableBackOnAgentFailure();
    return;
  }

  enableBackNavigation();
  if (elBtnNow) elBtnNow.disabled = false;

  if (saveResult.cancelled) {
    setStatus(
      "\uC800\uC7A5 \uB300\uD654\uC0C1\uC790\uB97C \uB2EB\uC558\uC2B5\uB2C8\uB2E4. \uC800\uC7A5\uD558\uB824\uBA74 \uC9C0\uAE08 \uB2E4\uC6B4\uB85C\uB4DC\uB97C \uB2E4\uC2DC \uB20C\uB7EC \uC8FC\uC138\uC694.",
      "err",
    );
    return;
  }

  const lineCount = result.edl.split("\n").length;
  setStatus(
    `\uD30C\uC77C \uC800\uC7A5\uC744 \uC2DC\uC791\uD588\uC2B5\uB2C8\uB2E4. (${lineCount}\uC904) \uB2E4\uC2DC \uBC1B\uC73C\uB824\uBA74 \uC9C0\uAE08 \uB2E4\uC6B4\uB85C\uB4DC\uB97C \uB20C\uB7EC \uC8FC\uC138\uC694.`,
    "ok",
  );
}

function startCountdown() {
  countdownLeft = AUTO_START_SEC;
  setStatus(
    `EDL \uD30C\uC77C \uB2E4\uC6B4\uB85C\uB4DC\uB97C \uC900\uBE44 \uC911\uC785\uB2C8\uB2E4\u2026 (${AUTO_START_SEC}\uCD08 \uD6C4 \uC790\uB3D9 \uC2DC\uC791)`,
  );
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
  applyLabels();

  void showAdSense("downloadTop", "#dl-ad-top");
  void showAdSense("downloadBottom", "#dl-ad-bottom");

  if (!canExportFromSession()) {
    setStatus(
      "\uBD84\uC11D \uACB0\uACFC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4. \uD3B8\uC9D1 \uD654\uBA74\uC5D0\uC11C \uBB34\uC74C \uAD6C\uAC04 \uBD84\uC11D\uC744 \uC2E4\uD589\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.",
      "err",
    );
    enableBackOnAgentFailure();
    return;
  }

  const agentOk = await ensureAgentConnected();
  if (!agentOk) {
    setStatus(MSG_HELPER_NEED_APP, "err");
    enableBackOnAgentFailure();
    return;
  }

  if (elBtnNow) elBtnNow.disabled = false;

  startCountdown();
}

/** 클릭 직후 저장 위치 선택 → EDL 생성 (user gesture 유지) */
async function runDownloadFromUserClick() {
  if (downloadInFlight) return;

  /** @type {FileSystemFileHandle | null | undefined} */
  let fileHandle;
  if (typeof window.showSaveFilePicker === "function") {
    try {
      fileHandle = await pickEdlSaveFileHandle();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setStatus(
          "\uC800\uC7A5 \uB300\uD654\uC0C1\uC790\uB97C \uB2EB\uC558\uC2B5\uB2C8\uB2E4. \uC800\uC7A5\uD558\uB824\uBA74 \uC9C0\uAE08 \uB2E4\uC6B4\uB85C\uB4DC\uB97C \uB2E4\uC2DC \uB20C\uB7EC \uC8FC\uC138\uC694.",
          "err",
        );
        enableBackNavigation();
        if (elBtnNow) elBtnNow.disabled = false;
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`\uD30C\uC77C \uC800\uC7A5\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.\n\n${msg}`, "err");
      enableBackNavigation();
      if (elBtnNow) elBtnNow.disabled = false;
      return;
    }
  }

  await runDownload({ fileHandle: fileHandle ?? null });
}

document.addEventListener("DOMContentLoaded", () => {
  if (elBtnNow) {
    elBtnNow.addEventListener("click", () => {
      clearCountdown();
      void runDownloadFromUserClick();
    });
  }

  if (elBtnBack) {
    elBtnBack.addEventListener("click", () => {
      markEditorRestorePending();
      window.location.href = EDITOR_PAGE;
    });
  }

  void initPage();
});
