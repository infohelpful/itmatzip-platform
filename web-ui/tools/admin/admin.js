import { TOOLS } from "../assets/tools-registry.js?v=19";
import { DEFAULT_SITE_CONFIG, mergeSiteConfig, SITE_LANGS } from "../common/site-config.js?v=6";

const API_URL = "/admin/api.php";

const LANG_LABELS = { ko: "한국어", en: "English", ja: "日本語", zh: "中文" };

const AD_UNIT_LABELS = {
  dashboardBanner: "메인 대시보드 상단",
  editorAboveWorkspace: "편집 화면 상단",
  editorBelowExport: "편집 화면 하단",
  downloadTop: "다운로드 페이지 상단",
  downloadBottom: "다운로드 페이지 하단",
};

const TOOL_AD_UNITS = ["editorAboveWorkspace", "editorBelowExport", "downloadTop", "downloadBottom"];

const LEGAL_PAGES = [
  { id: "about", label: "소개" },
  { id: "policy", label: "운영정책" },
  { id: "email", label: "이메일" },
  { id: "copyright", label: "저작권" },
  { id: "disclaimer", label: "책임의 한계" },
];

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
const hubMetaEl = document.getElementById("hub-meta");
const hubOgEl = document.getElementById("hub-og");
const legalMetaEl = document.getElementById("legal-meta");
const toolSettingsEl = document.getElementById("tool-settings");
const saveBtn = document.getElementById("save-btn");
const saveStatus = document.getElementById("save-status");

/** @type {string} */
let csrf = "";

/** @type {Record<string, Record<string, string>>} */
let hubPacks = { ko: {}, en: {}, ja: {}, zh: {} };
let hubReady = false;

function loadHubCatalog() {
  if (hubReady) return Promise.resolve();
  return new Promise((resolve) => {
    const prev = window.ITZ_I18N;
    window.ITZ_I18N = {
      register(id, packs) {
        if (id === "hub" && packs && typeof packs === "object") hubPacks = packs;
        if (prev && typeof prev.register === "function") prev.register(id, packs);
      },
    };
    const s = document.createElement("script");
    s.src = "../common/i18n/hub.js?v=14";
    s.onload = () => {
      hubReady = true;
      resolve();
    };
    s.onerror = () => {
      hubReady = true;
      resolve();
    };
    document.head.appendChild(s);
  });
}

function hubText(toolId, field, lang) {
  const pack = hubPacks[lang];
  if (!pack || typeof pack !== "object") return "";
  const v = pack[`tool.${toolId}.${field}`];
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function catalogLangMap(tool, field) {
  const out = emptyLangMap();
  for (const lang of SITE_LANGS) {
    if (field === "badge") {
      out[lang] = tool.badge || "";
      continue;
    }
    const fromHub = hubText(tool.id, field, lang);
    if (fromHub) {
      out[lang] = fromHub;
      continue;
    }
    if (field === "title") out[lang] = tool.title || "";
    else if (field === "subtitle") out[lang] = tool.subtitle || "";
    else if (field === "description") out[lang] = tool.description || "";
  }
  return out;
}

function mergeDisplayMap(saved, catalog) {
  const out = emptyLangMap();
  for (const lang of SITE_LANGS) {
    const v = saved && typeof saved[lang] === "string" ? saved[lang].trim() : "";
    out[lang] = v || catalog[lang] || "";
  }
  return out;
}

function storedLangMap(incoming) {
  const out = emptyLangMap();
  for (const lang of SITE_LANGS) {
    const v = incoming && typeof incoming[lang] === "string" ? incoming[lang].trim() : "";
    out[lang] = v;
  }
  return out;
}

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

function field(label, attrs, hint) {
  const extra = hint ? `<span class="admin-hint">${escapeHtml(hint)}</span>` : "";
  return `<label class="admin-field">${extra}<span>${escapeHtml(label)}</span><input ${attrs}></label>`;
}

function textareaField(label, attrs, value, hint) {
  const extra = hint ? `<span class="admin-hint">${escapeHtml(hint)}</span>` : "";
  return `<label class="admin-field">${extra}<span>${escapeHtml(label)}</span><textarea ${attrs}>${escapeHtml(value)}</textarea></label>`;
}

function langGrid(pathFn, values, kind) {
  const rows = SITE_LANGS.map((lang) => {
    const v = (values && values[lang]) || "";
    const path = typeof pathFn === "function" ? pathFn(lang) : `${pathFn}.${lang}`;
    const pathAttr = `data-itz-path="${escapeHtml(path)}" data-lang="${lang}"`;
    if (kind === "description" || kind === "seo-description") {
      const hint = kind === "seo-description" ? "80~160자" : "";
      return textareaField(`${LANG_LABELS[lang]}`, `${pathAttr} rows="3"`, v, hint);
    }
    const hint = kind === "seo-title" ? "앞에 검색어, 약 40자" : kind === "keywords" ? "5~8개, 쉼표" : "";
    return field(`${LANG_LABELS[lang]}`, `type="text" ${pathAttr} value="${escapeHtml(v)}" autocomplete="off"`, hint);
  });
  return `<div class="admin-lang-grid">${rows.join("")}</div>`;
}

function metaBlock(basePath, meta) {
  const m = meta || {};
  return `
    <h3 class="admin-subh">검색 title</h3>
    ${langGrid((lang) => `${basePath}.${lang}.title`, Object.fromEntries(SITE_LANGS.map((l) => [l, m[l]?.title || ""])), "seo-title")}
    <h3 class="admin-subh">검색 description</h3>
    ${langGrid((lang) => `${basePath}.${lang}.description`, Object.fromEntries(SITE_LANGS.map((l) => [l, m[l]?.description || ""])), "seo-description")}
    <h3 class="admin-subh">keywords</h3>
    ${langGrid((lang) => `${basePath}.${lang}.keywords`, Object.fromEntries(SITE_LANGS.map((l) => [l, m[l]?.keywords || ""])), "keywords")}
  `;
}

function emptyLangMap() {
  return { ko: "", en: "", ja: "", zh: "" };
}

function emptyMetaLangs() {
  return Object.fromEntries(SITE_LANGS.map((lang) => [lang, { title: "", description: "", keywords: "" }]));
}

function setDeep(root, path, value) {
  const parts = String(path || "")
    .split(".")
    .filter(Boolean);
  if (!parts.length) return;
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!cur[key] || typeof cur[key] !== "object") cur[key] = {};
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
}

function collectPathValues() {
  const acc = {};
  for (const el of settingsForm.querySelectorAll("[data-itz-path]")) {
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLSelectElement)) {
      continue;
    }
    setDeep(acc, el.getAttribute("data-itz-path"), el.value.trim());
  }
  return acc;
}

function ogBox(target, url) {
  const src = url ? escapeHtml(url) : "";
  return `
    <div class="admin-og-box" data-og-target="${escapeHtml(target)}">
      <span class="admin-og-label">OG 이미지 (권장 1200×630, PNG/JPG/WebP, 2MB 이하)</span>
      <div class="admin-og-row">
        <img class="admin-og-preview" alt="" ${src ? `src="${src}"` : "hidden"}>
        <input type="hidden" data-og-url value="${src}">
        <input type="file" accept="image/png,image/jpeg,image/webp" data-og-file>
        <button type="button" class="admin-btn admin-btn-ghost" data-og-clear>이미지 비우기</button>
      </div>
    </div>
  `;
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
    row.className = "admin-unit-row admin-unit-row--global";
    const on = unit.enabled !== false ? "checked" : "";
    row.innerHTML = `
      <label class="admin-check admin-check-inline">
        <input type="checkbox" data-ad-enabled="${escapeHtml(key)}" ${on}>
        <span>켜기</span>
      </label>
      <label class="admin-field">
        <span>${escapeHtml(label)} 슬롯 ID</span>
        <input type="text" data-ad-unit="${escapeHtml(key)}" value="${escapeHtml(unit.slot || "")}" spellcheck="false" autocomplete="off">
      </label>
    `;
    adUnitsEl.appendChild(row);
  }
}

function renderHub(config) {
  hubMetaEl.innerHTML = metaBlock("hub.meta", config?.hub?.meta);
  hubOgEl.innerHTML = ogBox("hub", config?.hub?.ogImage || "");
}

function renderLegal(config) {
  legalMetaEl.replaceChildren();
  for (const page of LEGAL_PAGES) {
    const wrap = document.createElement("details");
    wrap.className = "admin-details";
    wrap.dataset.legalId = page.id;
    const meta = config?.legal?.[page.id]?.meta || {};
    wrap.innerHTML = `<summary>${escapeHtml(page.label)}</summary>${metaBlock(`legal.${page.id}.meta`, meta)}`;
    legalMetaEl.appendChild(wrap);
  }
}

function toolAdMode(unit) {
  if (!unit) return "inherit";
  if (unit.enabled === false) return "off";
  return "custom";
}

function renderToolSettings(config) {
  toolSettingsEl.replaceChildren();
  for (const tool of TOOLS) {
    const t = config?.tools?.[tool.id] || {};
    const title = mergeDisplayMap(t.title, catalogLangMap(tool, "title"));
    const subtitle = mergeDisplayMap(t.subtitle, catalogLangMap(tool, "subtitle"));
    const description = mergeDisplayMap(t.description, catalogLangMap(tool, "description"));
    const badge = mergeDisplayMap(t.badge, catalogLangMap(tool, "badge"));
    const details = document.createElement("details");
    details.className = "admin-details";
    details.dataset.toolSettings = tool.id;
    const unitsHtml = TOOL_AD_UNITS.map((key) => {
      const unit = t.adsense?.units?.[key];
      const mode = toolAdMode(unit);
      return `
        <div class="admin-tool-ad-row">
          <span>${escapeHtml(AD_UNIT_LABELS[key])}</span>
          <select data-tool-ad-mode="${escapeHtml(key)}">
            <option value="inherit" ${mode === "inherit" ? "selected" : ""}>전역 사용</option>
            <option value="custom" ${mode === "custom" ? "selected" : ""}>이 도구 슬롯</option>
            <option value="off" ${mode === "off" ? "selected" : ""}>이 도구만 끄기</option>
          </select>
          <input type="text" data-tool-ad-slot="${escapeHtml(key)}" value="${escapeHtml(unit?.slot || "")}" placeholder="슬롯 ID" spellcheck="false" autocomplete="off">
        </div>
      `;
    }).join("");
    details.innerHTML = `
      <summary>${escapeHtml(tool.icon || "")} ${escapeHtml(tool.title)}</summary>
      <h3 class="admin-subh">표시 제목 (카드·H1)</h3>
      ${langGrid((lang) => `tools.${tool.id}.title.${lang}`, title, "title")}
      <h3 class="admin-subh">카드 부제</h3>
      ${langGrid((lang) => `tools.${tool.id}.subtitle.${lang}`, subtitle, "subtitle")}
      <h3 class="admin-subh">카드 설명</h3>
      ${langGrid((lang) => `tools.${tool.id}.description.${lang}`, description, "description")}
      <h3 class="admin-subh">뱃지</h3>
      ${langGrid((lang) => `tools.${tool.id}.badge.${lang}`, badge, "badge")}
      ${metaBlock(`tools.${tool.id}.meta`, t.meta)}
      ${ogBox(tool.id, t.ogImage || "")}
      <label class="admin-field">
        <span>이 도구 게시자 ID (비우면 전역)</span>
        <input type="text" data-tool-client value="${escapeHtml(t.adsense?.client || "")}" spellcheck="false" autocomplete="off">
      </label>
      <h3 class="admin-subh">광고 단위</h3>
      ${unitsHtml}
    `;
    toolSettingsEl.appendChild(details);
  }
}

function applyConfig(raw) {
  const openTools = [...toolSettingsEl.querySelectorAll("details[open]")]
    .map((d) => d.getAttribute("data-tool-settings"))
    .filter(Boolean);
  const openLegal = [...legalMetaEl.querySelectorAll("details[open]")]
    .map((d) => d.getAttribute("data-legal-id"))
    .filter(Boolean);
  const cfg = mergeSiteConfig(raw);
  adsEnabled.checked = cfg.adsense.enabled !== false;
  adsClient.value = cfg.adsense.client || "";
  renderTools(cfg.hiddenToolIds, cfg.mobileEnabledToolIds);
  renderAdUnits(cfg);
  renderHub(cfg);
  renderLegal(cfg);
  renderToolSettings(cfg);
  for (const id of openTools) {
    const el = toolSettingsEl.querySelector(`[data-tool-settings="${id}"]`);
    if (el) el.open = true;
  }
  for (const id of openLegal) {
    const el = legalMetaEl.querySelector(`[data-legal-id="${id}"]`);
    if (el) el.open = true;
  }
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
  for (const key of Object.keys(AD_UNIT_LABELS)) {
    const prev = base[key] || {};
    const slotInput = adUnitsEl.querySelector(`input[data-ad-unit="${key}"]`);
    const enabledInput = adUnitsEl.querySelector(`input[data-ad-enabled="${key}"]`);
    units[key] = {
      enabled: enabledInput ? enabledInput.checked : true,
      slot: slotInput ? slotInput.value.trim() : "",
      adFormat: prev.adFormat || "horizontal",
      fullWidthResponsive: prev.fullWidthResponsive !== false,
    };
  }

  const parsed = collectPathValues();
  const hub = {
    meta: parsed.hub?.meta || emptyMetaLangs(),
    ogImage: hubOgEl.querySelector("[data-og-url]")?.value.trim() || "",
  };

  const legal = {};
  for (const page of LEGAL_PAGES) {
    legal[page.id] = { meta: parsed.legal?.[page.id]?.meta || emptyMetaLangs() };
  }

  const tools = {};
  for (const tool of TOOLS) {
    const block = toolSettingsEl.querySelector(`[data-tool-settings="${tool.id}"]`);
    if (!block) continue;
    const tUnits = {};
    for (const key of TOOL_AD_UNITS) {
      const mode = block.querySelector(`[data-tool-ad-mode="${key}"]`)?.value || "inherit";
      const slot = block.querySelector(`[data-tool-ad-slot="${key}"]`)?.value.trim() || "";
      if (mode === "inherit") continue;
      if (mode === "off") tUnits[key] = { enabled: false, slot: "" };
      else tUnits[key] = { enabled: true, slot };
    }
    const row = parsed.tools?.[tool.id] || {};
    tools[tool.id] = {
      title: storedLangMap(row.title),
      subtitle: storedLangMap(row.subtitle),
      description: storedLangMap(row.description),
      badge: storedLangMap(row.badge),
      meta: row.meta || emptyMetaLangs(),
      ogImage: block.querySelector("[data-og-url]")?.value.trim() || "",
      adsense: {
        client: block.querySelector("[data-tool-client]")?.value.trim() || "",
        units: tUnits,
      },
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
    hub,
    legal,
    tools,
  };
}

async function uploadOg(target, file) {
  const body = new FormData();
  body.append("action", "upload-og");
  body.append("csrf", csrf);
  body.append("target", target);
  body.append("og", file);
  const res = await fetch(API_URL, { method: "POST", credentials: "same-origin", body });
  const data = await res.json().catch(() => null);
  if (data?.csrf) csrf = data.csrf;
  return { res, data };
}

settingsForm.addEventListener("change", async (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || input.getAttribute("data-og-file") == null) return;
  const file = input.files && input.files[0];
  if (!file) return;
  const box = input.closest("[data-og-target]");
  const target = box?.getAttribute("data-og-target") || "";
  setStatus("이미지 올리는 중…");
  try {
    const { res, data } = await uploadOg(target, file);
    if (!res.ok || !data?.ok) {
      setStatus(data?.error || "이미지를 올리지 못했습니다.", "err");
      input.value = "";
      return;
    }
    const url = data.url || "";
    const hidden = box.querySelector("[data-og-url]");
    const img = box.querySelector(".admin-og-preview");
    if (hidden) hidden.value = url;
    if (img) {
      img.src = url;
      img.hidden = !url;
    }
    setStatus("이미지를 올렸습니다. 설정 저장을 눌러 반영하세요.", "ok");
  } catch {
    setStatus("이미지를 올리지 못했습니다.", "err");
  }
  input.value = "";
});

settingsForm.addEventListener("click", (event) => {
  const btn = event.target;
  if (!(btn instanceof HTMLElement) || btn.getAttribute("data-og-clear") == null) return;
  const box = btn.closest("[data-og-target]");
  if (!box) return;
  const hidden = box.querySelector("[data-og-url]");
  const img = box.querySelector(".admin-og-preview");
  if (hidden) hidden.value = "";
  if (img) {
    img.removeAttribute("src");
    img.hidden = true;
  }
});

async function restoreSession() {
  await loadHubCatalog();
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
    await loadHubCatalog();
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
    const payload = collectConfig();
    const { res, data } = await api("save", { config: payload });
    if (!res.ok || !data?.ok) {
      if (res.status === 401 || res.status === 403) {
        showLogin(data?.error || "다시 로그인해 주세요.");
        return;
      }
      setStatus(data?.error || "저장에 실패했습니다.", "err");
      return;
    }
    csrf = data.csrf || csrf;
    applyConfig(payload);
    setStatus("저장했습니다. 대시보드·도구 화면을 새로고침하면 표시 제목·카드가 바뀝니다.", "ok");
  } catch {
    setStatus("서버에 연결하지 못했습니다.", "err");
  } finally {
    saveBtn.disabled = false;
  }
});

void restoreSession();
