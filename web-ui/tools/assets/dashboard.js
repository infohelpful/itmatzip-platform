import { showAdSense } from "../common/adsense.js?v=3";
import { loadSiteConfig } from "../common/site-config.js?v=1";
import { TOOLS } from "./tools-registry.js?v=12";

const gridEl = document.getElementById("hub-tool-grid");
const searchEl = document.getElementById("hub-search");
const countEl = document.getElementById("hub-tool-count");

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

/**
 * @param {import("./tools-registry.js").ToolEntry} tool
 */
function renderCard(tool) {
  const available = tool.available !== false;
  const tag = document.createElement(available ? "a" : "article");
  tag.className = "hub-card" + (available ? "" : " is-disabled");
  tag.style.setProperty("--card-accent", tool.accent || "#3b82f6");
  tag.style.setProperty(
    "--card-accent-glow",
    `color-mix(in srgb, ${tool.accent || "#3b82f6"} 22%, transparent)`,
  );

  if (available) {
    tag.href = tool.href;
    tag.setAttribute("aria-label", `${tool.title} 열기`);
  } else {
    tag.setAttribute("aria-disabled", "true");
  }

  const badgeText = available ? tool.badge || "" : "준비 중";
  const badgeClass =
    "hub-card-badge" + (available && tool.badge ? "" : " is-soon");

  tag.innerHTML = `
    ${badgeText ? `<span class="${badgeClass}">${escapeHtml(badgeText)}</span>` : ""}
    <div class="hub-card-icon" aria-hidden="true">${escapeHtml(tool.icon || "⚙")}</div>
    <h2 class="hub-card-title">${escapeHtml(tool.title)}</h2>
    <p class="hub-card-subtitle">${escapeHtml(tool.subtitle)}</p>
    <p class="hub-card-desc">${escapeHtml(tool.description)}</p>
    <span class="hub-card-cta">${available ? "도구 열기" : "곧 공개"}</span>
  `;

  return tag;
}

/** @type {Set<string>} */
let hiddenToolIds = new Set();

function catalogTools() {
  return TOOLS.filter((t) => !hiddenToolIds.has(t.id));
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
      : "현재 공개된 도구가 없습니다.";
    gridEl.appendChild(empty);
  } else {
    for (const tool of list) {
      gridEl.appendChild(renderCard(tool));
    }
  }

  if (countEl) {
    const total = catalog.filter((t) => t.available !== false).length;
    countEl.textContent = q
      ? `${list.length}개 표시 · 이용 가능 ${total}개`
      : `이용 가능 ${total}개 · 전체 ${catalog.length}개`;
  }
}

async function init() {
  try {
    const cfg = await loadSiteConfig();
    hiddenToolIds = new Set(cfg.hiddenToolIds || []);
  } catch {
    hiddenToolIds = new Set();
  }
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
