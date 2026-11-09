/**
 * Site shell for the Auto Subtitle web app (the React bundle in app/ stays the desktop UI).
 * - Shows the shared "install / start the agent" dialog when the local agent is unreachable.
 * - Warns when the installed agent is too old for the v2 subtitle API.
 */
import {
  checkAgentConnection,
  configureBridge,
  fetchAgent,
  getAgentOrigin,
  showInstallAgentDialog,
  startConnectionMonitor,
} from "../common/bridge.js?v=lna27";
import { agentInstallDialogOptions } from "../common/agent-install-ui.js?v=lna22";

const MIN_AGENT_VERSION = "1.7.12";
const NOTICE_ID = "autosub-agent-update";

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
  }
}

startConnectionMonitor({
  intervalMs: 15000,
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
