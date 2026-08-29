import { TOOLS } from "../assets/tools-registry.js?v=17";
import { DEFAULT_SITE_CONFIG, mergeSiteConfig } from "../common/site-config.js?v=3";

const API_URL = "/admin/api.php";

const AD_UNIT_LABELS = {
  dashboardBanner: "메인 대시보드 상단",
  editorAboveWorkspace: "편집 화면 상단",
  editorBelowExport: "편집 화면 하단",
  downloadTop: "다운로드 페이지 상단",
  downloadBottom: "다운로드 페이지 하단",
};

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const loginSubmit = document.getElementById("login-submit");
const logoutBtn = document.getElementById("logout-btn");
const settingsForm = document.getElementById("settings-form");
const toolToggles = document.getElementById("tool-toggles");
const adUnitsEl = document.getElementById("ad-units");
const adsEnabled = document.getElementById("ads-enabled");
const adsClient = document.getElementById("ads-client");
const saveBtn = document.getElementById("save-btn");
const saveStatus = document.getElementById("save-status");

/** @type {string} */
let csrf = "";

async function api(action, payload = null) {
  const opts = {
    method: payload ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: {},
  };
  const url = payload ? API_URL : `${API_URL}?action=${encodeURIComponent(action)}`;
  if (payload) {
    opts.headers["Content-Type"] = "application/json";
    if (csrf) opts.headers["X-CSRF-Token"] = csrf;
    opts.body = JSON.stringify({ action, csrf, ...payload });
  }
  const res = await fetch(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { res, data };
}

function showLogin(message) {
  appView.hidden = true;
  loginView.hidden = false;
  if (message) {
    loginError.hidden = false;
    loginError.textContent = message;
  } else {
    loginError.hidden = true;
    loginError.textContent = "";
  }
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
  loginError.hidden = true;
}

function setStatus(text, kind) {
  saveStatus.textContent = text || "";
  saveStatus.classList.toggle("is-ok", kind === "ok");
  saveStatus.classList.toggle("is-err", kind === "err");
}

/** @param {string} s */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTools(hiddenIds, mobileIds) {
  const hidden = new Set(hiddenIds || []);
  const mobile = new Set(mobileIds || []);
  toolToggles.replaceChildren();
  for (const tool of TOOLS) {
    const row = document.createElement("div");
    row.className = "admin-tool-row";
    const visibleChecked = hidden.has(tool.id) ? "" : "checked";
    const mobileChecked = mobile.has(tool.id) ? "checked" : "";
    row.innerHTML = `
      <span class="admin-tool-meta">
        <strong>${escapeHtml(tool.icon || "")} ${escapeHtml(tool.title)}</strong>
        <span>${escapeHtml(tool.subtitle || tool.id)}</span>
      </span>
      <span class="admin-tool-switches">
        <label class="admin-switch-wrap">
          <span class="admin-switch-label">공개</span>
          <span class="admin-switch">
            <input type="checkbox" data-tool-id="${escapeHtml(tool.id)}" data-switch="visible" ${visibleChecked}>
            <span></span>
          </span>
        </label>
        <label class="admin-switch-wrap">
          <span class="admin-switch-label">모바일</span>
          <span class="admin-switch">
            <input type="checkbox" data-tool-id="${escapeHtml(tool.id)}" data-switch="mobile" ${mobileChecked}>
            <span></span>
          </span>
        </label>
      </span>
    `;
    toolToggles.appendChild(row);
  }
}

function renderAdUnits(config) {
  const units = config?.adsense?.units || DEFAULT_SITE_CONFIG.adsense.units;
  adUnitsEl.replaceChildren();
  for (const [key, label] of Object.entries(AD_UNIT_LABELS)) {
    const unit = units[key] || {};
    const row = document.createElement("div");
    row.className = "admin-unit-row";
    row.innerHTML = `
      <label class="admin-field">
        <span>${escapeHtml(label)} 슬롯 ID</span>
        <input type="text" data-ad-unit="${escapeHtml(key)}" value="${escapeHtml(unit.slot || "")}" spellcheck="false" autocomplete="off">
      </label>
    `;
    adUnitsEl.appendChild(row);
  }
}

function applyConfig(raw) {
  const cfg = mergeSiteConfig(raw);
  adsEnabled.checked = cfg.adsense.enabled !== false;
  adsClient.value = cfg.adsense.client || "";
  renderTools(cfg.hiddenToolIds, cfg.mobileEnabledToolIds);
  renderAdUnits(cfg);
}

function collectConfig() {
  const hiddenToolIds = [];
  const mobileEnabledToolIds = [];
  for (const input of toolToggles.querySelectorAll('input[data-tool-id][data-switch="visible"]')) {
    if (!input.checked) hiddenToolIds.push(input.getAttribute("data-tool-id"));
  }
  for (const input of toolToggles.querySelectorAll('input[data-tool-id][data-switch="mobile"]')) {
    if (input.checked) mobileEnabledToolIds.push(input.getAttribute("data-tool-id"));
  }
  const units = {};
  const base = DEFAULT_SITE_CONFIG.adsense.units;
  for (const input of adUnitsEl.querySelectorAll("input[data-ad-unit]")) {
    const key = input.getAttribute("data-ad-unit");
    const prev = base[key] || {};
    units[key] = {
      slot: input.value.trim(),
      adFormat: prev.adFormat || "horizontal",
      fullWidthResponsive: prev.fullWidthResponsive !== false,
    };
  }
  return {
    hiddenToolIds,
    mobileEnabledToolIds,
    adsense: {
      enabled: adsEnabled.checked,
      client: adsClient.value.trim(),
      units,
    },
  };
}

async function restoreSession() {
  const { res, data } = await api("session");
  if (res.ok && data?.ok) {
    csrf = data.csrf || "";
    applyConfig(data.config);
    showApp();
    return true;
  }
  showLogin();
  return false;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginSubmit.disabled = true;
  loginError.hidden = true;
  try {
    const { res, data } = await api("login", {
      username: document.getElementById("login-username").value,
      password: document.getElementById("login-password").value,
    });
    if (!res.ok || !data?.ok) {
      showLogin(data?.error || "로그인에 실패했습니다.");
      return;
    }
    csrf = data.csrf || "";
    document.getElementById("login-password").value = "";
    applyConfig(data.config);
    showApp();
  } catch {
    showLogin("서버에 연결하지 못했습니다.");
  } finally {
    loginSubmit.disabled = false;
  }
});

logoutBtn.addEventListener("click", async () => {
  try {
    await api("logout", {});
  } catch {
    /* ignore */
  }
  csrf = "";
  showLogin();
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  saveBtn.disabled = true;
  setStatus("저장 중…");
  try {
    const { res, data } = await api("save", { config: collectConfig() });
    if (!res.ok || !data?.ok) {
      if (res.status === 401 || res.status === 403) {
        showLogin(data?.error || "다시 로그인해 주세요.");
        return;
      }
      setStatus(data?.error || "저장에 실패했습니다.", "err");
      return;
    }
    csrf = data.csrf || csrf;
    applyConfig(data.config);
    setStatus("저장했습니다. 방문객에게 바로 반영됩니다.", "ok");
  } catch {
    setStatus("서버에 연결하지 못했습니다.", "err");
  } finally {
    saveBtn.disabled = false;
  }
});

void restoreSession();
