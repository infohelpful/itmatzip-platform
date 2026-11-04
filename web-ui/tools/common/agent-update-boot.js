/** Shared update prompt for pages that use the locally installed agent. */
import { checkAgentConnection, fetchAgent, getAgentOrigin } from "./bridge.js?v=lna25";
import { fetchAgentReleaseManifest } from "./agent-install-ui.js?v=lna22";

const words = {
  ko: {
    title: "에이전트 업데이트",
    detail: (current, latest) => `설치된 버전은 ${current}, 최신 버전은 ${latest}입니다.`,
    start: "즉시 업데이트",
    close: "나중에",
    starting: "업데이트를 시작하는 중입니다…",
    running: "최신 버전을 내려받고 설치하는 중입니다. Windows 관리자 권한 창이 뜨면 승인해 주세요.",
    restarting: "설치 중입니다. 에이전트가 다시 시작되기를 기다리는 중입니다…",
    done: "업데이트가 완료되었습니다. 화면을 새로고침합니다…",
    legacy: "이 설치본은 웹에서 즉시 업데이트를 시작하는 기능이 없습니다. 자동 업데이트를 기다리거나 아래 설치 파일을 실행해 주세요.",
    download: "최신 설치 파일 받기",
    failed: "업데이트를 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  },
  en: {
    title: "Agent update",
    detail: (current, latest) => `Installed: ${current}. Latest: ${latest}.`,
    start: "Update now", close: "Later", starting: "Starting update…",
    running: "Downloading and installing the update. Approve the Windows administrator prompt if it appears.",
    restarting: "Installing. Waiting for the agent to restart…",
    done: "Update complete. Refreshing…",
    legacy: "This agent cannot start an update from the website. Wait for its automatic update or run the installer below.",
    download: "Download installer", failed: "Could not start the update. Please try again.",
  },
  ja: {
    title: "エージェントの更新",
    detail: (current, latest) => `インストール済み: ${current}。最新版: ${latest}。`,
    start: "今すぐ更新", close: "後で", starting: "更新を開始しています…",
    running: "最新版をダウンロードしてインストールしています。Windows の管理者権限の確認が出たら承認してください。",
    restarting: "インストール中です。エージェントの再起動を待っています…",
    done: "更新が完了しました。画面を再読み込みします…",
    legacy: "このバージョンは Web からの即時更新に対応していません。自動更新を待つか、以下のインストーラーを実行してください。",
    download: "インストーラーをダウンロード", failed: "更新を開始できませんでした。しばらくしてから再試行してください。",
  },
  zh: {
    title: "更新代理程序",
    detail: (current, latest) => `已安装版本：${current}。最新版本：${latest}。`,
    start: "立即更新", close: "稍后", starting: "正在开始更新…",
    running: "正在下载并安装更新。如出现 Windows 管理员权限提示，请批准。",
    restarting: "正在安装，等待代理程序重新启动…",
    done: "更新完成，正在刷新页面…",
    legacy: "此版本无法从网页启动即时更新。请等待自动更新，或运行下方安装程序。",
    download: "下载安装程序", failed: "无法开始更新，请稍后重试。",
  },
};

function olderThan(installed, latest) {
  const a = String(installed).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = String(latest).split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

function copy() {
  const lang = (document.documentElement.lang || "ko").slice(0, 2);
  return words[lang] || words.ko;
}

function addStyle() {
  if (document.getElementById("itz-agent-update-style")) return;
  const style = document.createElement("style");
  style.id = "itz-agent-update-style";
  style.textContent = `
    #itz-agent-update { max-width:min(460px,calc(100vw - 32px)); border:1px solid #50627e;
      border-radius:14px; padding:24px; color:#f5f7fb; background:#1d2635;
      box-shadow:0 20px 55px #0008; font:15px/1.55 system-ui,sans-serif; }
    #itz-agent-update::backdrop { background:#0009; }
    #itz-agent-update h2 { margin:0 0 12px; font-size:21px; }
    #itz-agent-update p { margin:0 0 16px; }
    #itz-agent-update .itz-update-status { min-height:1.5em; color:#a9d6ff; }
    #itz-agent-update .itz-update-actions { display:flex; flex-wrap:wrap; gap:10px; justify-content:flex-end; }
    #itz-agent-update button,#itz-agent-update a { border:0; border-radius:7px; padding:9px 14px;
      font:inherit; cursor:pointer; text-decoration:none; }
    #itz-agent-update .itz-update-start { background:#397af4; color:#fff; }
    #itz-agent-update .itz-update-close,#itz-agent-update a { background:#344154; color:#f5f7fb; }
    #itz-agent-update button:disabled { opacity:.55; cursor:wait; }
  `;
  document.head.appendChild(style);
}

function showUpdateDialog(installed, release, immediateSupported) {
  if (document.getElementById("itz-agent-update")) return;
  const t = copy();
  addStyle();
  const dialog = document.createElement("dialog");
  dialog.id = "itz-agent-update";
  dialog.setAttribute("aria-labelledby", "itz-agent-update-title");
  const heading = document.createElement("h2");
  heading.id = "itz-agent-update-title";
  heading.textContent = t.title;
  const detail = document.createElement("p");
  detail.textContent = t.detail(installed, release.version);
  const status = document.createElement("p");
  status.className = "itz-update-status";
  status.setAttribute("role", "status");
  const actions = document.createElement("div");
  actions.className = "itz-update-actions";
  const download = document.createElement("a");
  download.textContent = t.download;
  download.target = "_blank";
  download.rel = "noopener noreferrer";
  download.hidden = immediateSupported;
  try {
    const url = new URL(release.download_url);
    if (url.protocol === "https:") download.href = url.href;
  } catch { /* ignore invalid manifest URL */ }
  const later = document.createElement("button");
  later.type = "button";
  later.className = "itz-update-close";
  later.textContent = t.close;
  later.addEventListener("click", () => dialog.close());
  const start = document.createElement("button");
  start.type = "button";
  start.className = "itz-update-start";
  start.textContent = t.start;
  start.hidden = !immediateSupported;
  let updating = false;
  let closed = false;
  dialog.addEventListener("close", () => { closed = true; dialog.remove(); });
  start.addEventListener("click", async () => {
    if (updating) return;
    updating = true;
    start.disabled = true;
    status.textContent = t.starting;
    try {
      const response = await fetchAgent(`${getAgentOrigin()}/api/agent/update`, {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (response.status === 404) {
        status.textContent = t.legacy;
        if (download.href) download.hidden = false;
        start.hidden = true;
        return;
      }
      if (!response.ok && response.status !== 409) throw new Error(`HTTP ${response.status}`);
      status.textContent = t.running;
      for (let attempt = 0; attempt < 240 && !closed; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        let health;
        try {
          const result = await fetchAgent(`${getAgentOrigin()}/health`, { cache: "no-store" });
          health = await result.json();
        } catch {
          status.textContent = t.restarting;
          continue;
        }
        if (!olderThan(health.agent_version || "0", release.version)) {
          status.textContent = t.done;
          window.location.reload();
          return;
        }
        if (health.update_error) throw new Error(health.update_error);
        status.textContent = t.running;
      }
      if (!closed) throw new Error("timeout");
    } catch (error) {
      status.textContent = `${t.failed} (${error instanceof Error ? error.message : String(error)})`;
    } finally {
      updating = false;
      start.disabled = false;
    }
  });
  actions.append(download, later, start);
  if (!immediateSupported) status.textContent = t.legacy;
  dialog.append(heading, detail, status, actions);
  document.body.appendChild(dialog);
  dialog.showModal();
}

void (async () => {
  const agent = await checkAgentConnection();
  if (!agent.ok || !agent.agentVersion) return;
  const release = await fetchAgentReleaseManifest();
  if (!release.version || !olderThan(agent.agentVersion, release.version)) return;
  let immediateSupported = false;
  try {
    const capability = await fetchAgent(`${getAgentOrigin()}/api/agent/update`, { cache: "no-store" });
    immediateSupported = capability.ok;
  } catch { /* older agents do not expose the update endpoint */ }
  const key = `itz-agent-update-shown:${location.pathname}:${release.version}`;
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, "1");
  } catch { /* storage is optional */ }
  showUpdateDialog(agent.agentVersion, release, immediateSupported);
})().catch(() => {});
