import { showAdSense } from "../common/adsense.js?v=6";
import { loadSiteConfig, mergeSiteConfig, pickLang, uiLang } from "../common/site-config.js?v=6";
import { TOOLS } from "./tools-registry.js?v=18";

const MOBILE_MENU_ONLY_KEY = "itz-mobile-menu-only";

const gridEl = document.getElementById("hub-tool-grid");
const searchEl = document.getElementById("hub-search");
const countEl = document.getElementById("hub-tool-count");
const mobileMenuToggleEl = document.getElementById("hub-mobile-menu-toggle");
const mobileMenuOnlyEl = document.getElementById("hub-mobile-menu-only");

/**
 * @param {import("./tools-registry.js").ToolEntry} tool
 * @param {string} q
 */
function tx(key, fallback, vars) {
  let text = fallback;
  try {
    if (window.ITZ_I18N && typeof window.ITZ_I18N.t === "function") {
      const got = window.ITZ_I18N.t(key);
      if (got && got !== key) text = got;
    }
  } catch {
    /* ignore */
  }
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = String(text).split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/** @type {import("../common/site-config.js").SiteConfig | null} */
let siteCfg = null;

function localizedTool(tool) {
  const admin = siteCfg?.tools?.[tool.id];
  const lang = uiLang();
  const subtitle = pickLang(admin?.subtitle, lang) || tx(`tool.${tool.id}.subtitle`, tool.subtitle);
  const description = pickLang(admin?.description, lang) || tx(`tool.${tool.id}.description`, tool.description);
  const title = pickLang(admin?.title, lang) || tx(`tool.${tool.id}.title`, tool.title);
  const extraTags = tx(`tool.${tool.id}.tags`, "");
  return {
    ...tool,
    title,
    subtitle,
    description,
    tags: [...(tool.tags || []), ...String(extraTags).split(/\s+/).filter(Boolean)],
    badge: pickLang(admin?.badge, lang) || tool.badge,
  };
}

/**
 * @param {import("./tools-registry.js").ToolEntry} tool
 * @param {string} q
 */
function toolMatchesQuery(tool, q) {
  if (!q) return true;
  const loc = localizedTool(tool);
  const hay = [loc.title, loc.subtitle, loc.description, ...(loc.tags || [])]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

/** @param {string} s */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @type {Set<string>} */
let hiddenToolIds = new Set();
/** @type {Set<string> | null} */
let mobileEnabledToolIds = null;
let mobileMenuOnly = true;

function isMobileDashboard() {
  const ua = navigator.userAgent || "";
  if (/Android|webOS|iPhone|iPod|iPad|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
    return true;
  }
  try {
    if (navigator.userAgentData && navigator.userAgentData.mobile) return true;
  } catch {
    /* ignore */
  }
  if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) {
    return true;
  }
  if (/Windows NT|Win64|WOW64|Macintosh|Mac OS X|Linux|X11|CrOS/i.test(ua) && !/iPhone|iPod|iPad|Android/i.test(ua)) {
    return false;
  }
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const narrow = window.matchMedia("(max-width: 900px)").matches;
  return coarse && narrow;
}

function readMobileMenuOnly() {
  try {
    return localStorage.getItem(MOBILE_MENU_ONLY_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeMobileMenuOnly(value) {
  try {
    localStorage.setItem(MOBILE_MENU_ONLY_KEY, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function isMobileLocked(tool) {
  if (!isMobileDashboard() || !mobileEnabledToolIds) return false;
  return !mobileEnabledToolIds.has(tool.id);
}

/**
 * @param {import("./tools-registry.js").ToolEntry} tool
 */
function renderCard(tool) {
  tool = localizedTool(tool);
  const comingSoon = tool.available === false;
  const mobileLocked = !comingSoon && isMobileLocked(tool);
  const clickable = !comingSoon && !mobileLocked;
  const tag = document.createElement(clickable ? "a" : "article");
  tag.className =
    "hub-card" +
    (comingSoon ? " is-disabled" : "") +
    (mobileLocked ? " is-disabled is-pc-only" : "");
  tag.style.setProperty("--card-accent", tool.accent || "#3b82f6");
  tag.style.setProperty(
    "--card-accent-glow",
    `color-mix(in srgb, ${tool.accent || "#3b82f6"} 22%, transparent)`,
  );

  if (clickable) {
    tag.href = tool.href;
    tag.setAttribute("aria-label", tx("openAria", `${tool.title} 열기`, { title: tool.title }));
  } else {
    tag.setAttribute("aria-disabled", "true");
    if (mobileLocked) {
      tag.setAttribute("aria-label", tx("pcAria", `${tool.title} — PC에서만 이용할 수 있습니다`, { title: tool.title }));
    }
  }

  const badgeText = comingSoon
    ? tx("badgeSoon", "준비 중")
    : mobileLocked
      ? tx("badgePc", "PC 전용")
      : tool.badge || "";
  const badgeClass =
    "hub-card-badge" + (comingSoon || mobileLocked || !tool.badge ? " is-soon" : "");

  let cta = tx("ctaOpen", "도구 열기");
  if (comingSoon) cta = tx("ctaSoon", "곧 공개");
  else if (mobileLocked) cta = tx("ctaPc", "PC에서만 이용");

  tag.innerHTML = `
    ${badgeText ? `<span class="${badgeClass}">${escapeHtml(badgeText)}</span>` : ""}
    <div class="hub-card-icon" aria-hidden="true">${escapeHtml(tool.icon || "⚙")}</div>
    <h2 class="hub-card-title">${escapeHtml(tool.title)}</h2>
    <p class="hub-card-subtitle">${escapeHtml(tool.subtitle)}</p>
    <p class="hub-card-desc">${escapeHtml(tool.description)}</p>
    <span class="hub-card-cta">${cta}</span>
  `;

  return tag;
}

function catalogTools() {
  return TOOLS.filter((t) => {
    if (hiddenToolIds.has(t.id)) return false;
    if (
      isMobileDashboard() &&
      mobileMenuOnly &&
      mobileEnabledToolIds &&
      !mobileEnabledToolIds.has(t.id)
    ) {
      return false;
    }
    return true;
  });
}

function renderGrid() {
  if (!gridEl) return;

  const q = (searchEl?.value || "").trim().toLowerCase();
  const catalog = catalogTools();
  const list = catalog.filter((t) => toolMatchesQuery(t, q));

  gridEl.replaceChildren();

  if (list.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hub-empty";
    empty.textContent = q
      ? tx("emptySearch", "검색 결과가 없습니다. 다른 키워드로 시도해 주세요.")
      : isMobileDashboard()
        ? tx("emptyMobile", "모바일에서 이용할 수 있는 도구가 없습니다.")
        : tx("emptyNone", "현재 공개된 도구가 없습니다.");
    gridEl.appendChild(empty);
  } else {
    for (const tool of list) {
      gridEl.appendChild(renderCard(tool));
    }
  }

  if (countEl) {
    const usable = catalog.filter((t) => t.available !== false && !isMobileLocked(t)).length;
    countEl.textContent = q
      ? tx("countFiltered", `${list.length}개 표시 · 이용 가능 ${usable}개`, {
          n: list.length,
          usable,
        })
      : tx("countAll", `이용 가능 ${usable}개 · 전체 ${catalog.length}개`, {
          usable,
          total: catalog.length,
        });
  }
}

function setupMobileMenuToggle() {
  if (!mobileMenuToggleEl || !mobileMenuOnlyEl) return;
  if (!isMobileDashboard()) {
    mobileMenuToggleEl.hidden = true;
    return;
  }
  mobileMenuOnly = readMobileMenuOnly();
  mobileMenuOnlyEl.checked = mobileMenuOnly;
  mobileMenuToggleEl.hidden = false;
  mobileMenuOnlyEl.addEventListener("change", () => {
    mobileMenuOnly = mobileMenuOnlyEl.checked;
    writeMobileMenuOnly(mobileMenuOnly);
    renderGrid();
  });
}

function applyLiveConfig(cfg) {
  if (!cfg) return;
  siteCfg = cfg;
  hiddenToolIds = new Set(cfg.hiddenToolIds || []);
  mobileEnabledToolIds = new Set(cfg.mobileEnabledToolIds || []);
}

function liveSiteConfig() {
  if (typeof window !== "undefined" && window.__itzSiteConfig) {
    return mergeSiteConfig(window.__itzSiteConfig);
  }
  return null;
}

async function init() {
  try {
    applyLiveConfig(liveSiteConfig() || (await loadSiteConfig()));
  } catch {
    hiddenToolIds = new Set();
    mobileEnabledToolIds = null;
  }
  setupMobileMenuToggle();
  renderGrid();

  if (searchEl) {
    searchEl.addEventListener("input", () => renderGrid());
  }

  void showAdSense("dashboardBanner", "#hub-ad-banner");
}

document.addEventListener("itz:lang-change", () => {
  const live = liveSiteConfig();
  if (live) applyLiveConfig(live);
  renderGrid();
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
