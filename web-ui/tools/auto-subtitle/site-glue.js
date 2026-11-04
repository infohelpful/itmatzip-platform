/**
 * Site shell for the Auto Subtitle web app (the React bundle in app/ stays the desktop UI).
 * - Shows the shared "install / start the agent" dialog when the local agent is unreachable.
 * - Prompts for an update when the installed agent is older than the published release.
 */
import {
  checkAgentConnection,
  configureBridge,
  fetchAgent,
  getAgentOrigin,
  showInstallAgentDialog,
  startConnectionMonitor,
} from "../common/bridge.js?v=lna25";
import { agentInstallDialogOptions, escHtml, fetchAgentReleaseManifest } from "../common/agent-install-ui.js?v=lna22";

const MIN_AGENT_VERSION = "1.6.0";
const NOTICE_ID = "autosub-agent-update";
const UPDATE_SHOWN_PREFIX = "autosub-agent-update-shown:";

configureBridge({ healthPath: "/health" });

function installDialogOpts() {
  return agentInstallDialogOptions(() => checkAgentConnection());
}

/** Same override the app uses for a separately run development FastAPI (?agentApi=...). */
function devApiOverride() {
  try {
    return localStorage.getItem("autosub.agentApi") || "";
  } catch {
    return "";
  }
}

function toolApiOrigin() {
  return devApiOverride() || getAgentOrigin();
}

function olderThan(version, minimum) {
  const a = String(version || "0").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const b = minimum.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

function showUpdateNotice(version) {
  if (document.getElementById(NOTICE_ID)) return;
  const box = document.createElement("div");
  box.id = NOTICE_ID;
  box.setAttribute("role", "alert");
  box.style.cssText =
    "position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483000;max-width:min(560px,calc(100vw - 32px));" +
    "padding:14px 18px;border-radius:10px;background:#1e2128;color:#e8eaed;border:1px solid #f59e0b;" +
    "box-shadow:0 8px 24px rgba(0,0,0,.4);font:14px/1.55 Pretendard,system-ui,sans-serif";
  const text = document.createElement("p");
  text.style.margin = "0 0 10px";
  text.textContent =
    `자막 도구는 ItMatZip 에이전트 ${MIN_AGENT_VERSION} 이상이 필요합니다` +
    (version ? ` (지금 ${version})` : "") +
    ". 트레이 아이콘에서 업데이트하거나 최신 설치 파일로 다시 설치한 뒤, 아래 버튼을 눌러 주세요.";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "다시 확인";
  retry.style.cssText = "padding:6px 14px;border-radius:6px;border:0;background:#3b82f6;color:#fff;cursor:pointer";
  retry.addEventListener("click", () => window.location.reload());
  box.append(text, retry);
  document.body.appendChild(box);
}

async function showAvailableUpdate(currentVersion) {
  const release = await fetchAgentReleaseManifest();
  if (!release.version || !olderThan(currentVersion, release.version)) return;
  const shownKey = `${UPDATE_SHOWN_PREFIX}${release.version}`;
  try {
    if (sessionStorage.getItem(shownKey)) return;
  } catch {
    /* Private browsing may disable storage. */
  }

  const options = await installDialogOpts();
  void showInstallAgentDialog({
    ...options,
    closeOnConnection: false,
    title: `ItMatZip 에이전트 v${release.version} 업데이트`,
    bodyHtml: `<p class="itz-modal__msg">현재 에이전트는 v${escHtml(currentVersion)}입니다. ` +
      `최신 버전은 v${escHtml(release.version)}입니다. ` +
      `아래에서 최신 설치 파일을 받은 뒤 실행해 주세요.</p>${options.bodyHtml}`,
    primaryLabel: "업데이트 확인",
    onPrimary: async () => {
      const connection = await checkAgentConnection();
      if (!connection.ok) return connection;
      const res = await fetchAgent(`${getAgentOrigin()}/health`, { cache: "no-store" });
      const health = await res.json();
      const version = String(health?.agent_version ?? "");
      return version && !olderThan(version, release.version)
        ? { ok: true }
        : { ok: false, error: `현재 v${version || "알 수 없음"}입니다. 설치 후 에이전트를 다시 실행해 주세요.` };
    },
    onShown: () => {
      try { sessionStorage.setItem(shownKey, "1"); } catch { /* ignore */ }
    },
  });
}

async function checkAgentSupportsApp() {
  const agent = await checkAgentConnection();
  if (!agent.ok) return;
  try {
    const res = await fetchAgent(`${toolApiOrigin().replace(/\/+$/, "")}/api/tools/auto-subtitle/v2/deps`, {
      method: "GET",
      cache: "no-store",
    });
    if (res.status === 404) {
      const health = await fetchAgent(`${getAgentOrigin()}/health`, { cache: "no-store" }).then((r) => r.json()).catch(() => ({}));
      showUpdateNotice(health.agent_version);
      if (health.agent_version && !devApiOverride()) {
        await showAvailableUpdate(health.agent_version).catch(() => {});
      }
      return;
    }
  } catch {
    return; // connection problems are handled by the monitor's install dialog
  }
  const health = await fetchAgent(`${getAgentOrigin()}/health`, { cache: "no-store" }).then((r) => r.json()).catch(() => null);
  if (health?.agent_version && !devApiOverride()) {
    if (olderThan(health.agent_version, MIN_AGENT_VERSION)) {
      showUpdateNotice(health.agent_version);
    }
    await showAvailableUpdate(health.agent_version).catch(() => {});
  }
}

startConnectionMonitor({
  intervalMs: 5000,
  immediate: true,
  onChange: () => {},
  autoShowInstallDialog: true,
  installDialogOptions: installDialogOpts,
});

void (async () => {
  const agent = await checkAgentConnection();
  if (!agent.ok) {
    await showInstallAgentDialog(await installDialogOpts());
    return;
  }
  await checkAgentSupportsApp();
})();
