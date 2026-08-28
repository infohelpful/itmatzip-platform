import { showAdSense } from "../common/adsense.js?v=4";
import { loadSiteConfig } from "../common/site-config.js?v=3";
import { TOOLS } from "./tools-registry.js?v=15";

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
function toolMatchesQuery(tool, q) {
  if (!q) return true;
  const hay = [tool.title, tool.subtitle, tool.description, ...(tool.tags || [])]
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
    tag.setAttribute("aria-label", `${tool.title} 열기`);
  } else {
    tag.setAttribute("aria-disabled", "true");
    if (mobileLocked) {
      tag.setAttribute("aria-label", `${tool.title} — PC에서만 이용할 수 있습니다`);
    }
  }

  const badgeText = comingSoon ? "준비 중" : mobileLocked ? "PC 전용" : tool.badge || "";
  const badgeClass =
    "hub-card-badge" + (comingSoon || mobileLocked || !tool.badge ? " is-soon" : "");

  let cta = "도구 열기";
  if (comingSoon) cta = "곧 공개";
  else if (mobileLocked) cta = "PC에서만 이용";

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
      ? "검색 결과가 없습니다. 다른 키워드로 시도해 주세요."
      : isMobileDashboard()
        ? "모바일에서 이용할 수 있는 도구가 없습니다."
        : "현재 공개된 도구가 없습니다.";
    gridEl.appendChild(empty);
  } else {
    for (const tool of list) {
      gridEl.appendChild(renderCard(tool));
    }
  }

  if (countEl) {
    const usable = catalog.filter((t) => t.available !== false && !isMobileLocked(t)).length;
    countEl.textContent = q
      ? `${list.length}개 표시 · 이용 가능 ${usable}개`
      : `이용 가능 ${usable}개 · 전체 ${catalog.length}개`;
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

async function init() {
  try {
    const cfg = await loadSiteConfig();
    hiddenToolIds = new Set(cfg.hiddenToolIds || []);
    mobileEnabledToolIds = new Set(cfg.mobileEnabledToolIds || []);
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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
