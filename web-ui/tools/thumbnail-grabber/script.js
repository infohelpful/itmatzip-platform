import { showAdSense } from "../common/adsense.js?v=6";

function itzT(key, fallback) {
  return typeof window.itzT === "function" ? window.itzT(key, fallback) : fallback;
}

function itzTf(key, fallback, vars) {
  if (window.ITZ_I18N?.tf) return window.ITZ_I18N.tf(key, vars);
  let s = itzT(key, fallback);
  if (!vars) return s;
  for (const k of Object.keys(vars)) s = String(s).split(`{${k}}`).join(String(vars[k] ?? ""));
  return s;
}

/** @param {string} id */
function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

const urlField = el("video-url");
const pasteButton = el("btn-paste");
const fetchButton = el("btn-fetch");
const statusLine = el("composer-status");
const emptyPanel = el("stage-empty");
const loadingPanel = el("stage-loading");
const readyPanel = el("stage-ready");
const heroPic = el("hero-image");
const heroQualityChip = el("hero-quality");
const heroSizeChip = el("hero-size");
const saveBestButton = el("btn-download-best");
const copyUrlButton = el("btn-copy-url");
const openTabButton = el("btn-open-tab");
const qualitySection = el("qualities");
const qualityMeta = el("qualities-meta");
const qualityGridEl = el("quality-grid");
const toastBox = el("toast");

const QUALITY_FILES = [
  { file: "maxresdefault", title: "Max" },
  { file: "hq720", title: "HD" },
  { file: "sddefault", title: "SD" },
  { file: "hqdefault", title: "High" },
  { file: "mqdefault", title: "Medium" },
  { file: "default", title: "Default" },
];

/** @type {{ videoId: string, items: ThumbItem[], selectedId: string } | null} */
let current = null;
let toastTimer = 0;

/**
 * @typedef {Object} ThumbItem
 * @property {string} id
 * @property {string} title
 * @property {string} url
 * @property {number} width
 * @property {number} height
 */

/** @param {string} input */
function parseVideoId(input) {
  const raw = String(input || "").trim().replace(/^<|>$/g, "");
  if (!raw) return null;
  if (/^[\w-]{11}$/.test(raw)) return raw;

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const path = parsed.pathname.split("/").filter(Boolean);
    const youtubeHost =
      host === "youtu.be" ||
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtube-nocookie.com";

    if (youtubeHost) {
      const fromQuery = parsed.searchParams.get("v") || parsed.searchParams.get("vi");
      if (fromQuery && /^[\w-]{11}$/.test(fromQuery)) return fromQuery;
      if (host === "youtu.be" && path[0] && /^[\w-]{11}$/.test(path[0])) return path[0];

      const markers = new Set(["shorts", "embed", "live", "v", "e"]);
      for (let i = 0; i < path.length; i += 1) {
        if (markers.has(path[i]) && path[i + 1] && /^[\w-]{11}$/.test(path[i + 1])) {
          return path[i + 1];
        }
      }
    }
  } catch {
    /* ignore invalid URL */
  }

  const match = raw.match(
    /(?:v=|vi=|youtu\.be\/|youtube\.com\/(?:shorts|embed|live|v|e)\/)([\w-]{11})/,
  );
  return match ? match[1] : null;
}

/** @param {string} videoId @param {string} file */
function thumbUrl(videoId, file) {
  return `https://i.ytimg.com/vi/${videoId}/${file}.jpg`;
}

/**
 * @param {string} url
 * @param {boolean} allowTiny
 * @returns {Promise<{ ok: boolean, width: number, height: number }>}
 */
function probeImage(url, allowTiny) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth || 0;
      const height = img.naturalHeight || 0;
      const placeholder = width <= 120 && height <= 90;
      resolve({
        ok: width > 0 && height > 0 && (allowTiny || !placeholder),
        width,
        height,
      });
    };
    img.onerror = () => resolve({ ok: false, width: 0, height: 0 });
    img.src = url;
  });
}

/** @param {string} videoId */
async function collectThumbs(videoId) {
  const probes = await Promise.all(
    QUALITY_FILES.map(async (quality) => {
      const url = thumbUrl(videoId, quality.file);
      const probed = await probeImage(url, quality.file === "default");
      if (!probed.ok) return null;
      return {
        id: quality.file,
        title: quality.title,
        url,
        width: probed.width,
        height: probed.height,
      };
    }),
  );
  return /** @type {ThumbItem[]} */ (probes.filter(Boolean));
}

/** @param {"empty" | "loading" | "ready"} next */
function setStage(next) {
  emptyPanel.hidden = next !== "empty";
  loadingPanel.hidden = next !== "loading";
  readyPanel.hidden = next !== "ready";
}

/** @param {string} message @param {boolean} [isError] */
function setStatus(message, isError = false) {
  statusLine.textContent = message || "";
  statusLine.classList.toggle("is-error", Boolean(isError));
}

/** @param {string} message */
function showToast(message) {
  toastBox.hidden = false;
  toastBox.textContent = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastBox.hidden = true;
  }, 2600);
}

/** @param {ThumbItem} item */
function selectThumb(item) {
  if (!current) return;
  current.selectedId = item.id;
  heroPic.src = item.url;
  heroQualityChip.textContent = item.title;
  heroSizeChip.textContent = `${item.width}×${item.height}`;
  for (const card of qualityGridEl.querySelectorAll(".quality-card")) {
    card.classList.toggle("is-active", card.dataset.id === item.id);
  }
}

function selectedThumb() {
  if (!current) return null;
  return current.items.find((item) => item.id === current.selectedId) || current.items[0] || null;
}

/** @param {string} url @param {string} filename */
async function saveImage(url, filename) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("fetch failed");
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
    showToast(itzT("toastSave", "저장을 시작했습니다."));
  } catch {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast(itzT("toastOpenTab", "새 탭에서 이미지를 연 뒤 우클릭해서 저장하세요."));
  }
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    showToast(itzT("toastCopied", "주소를 복사했습니다."));
  } catch {
    showToast(itzT("toastCopyFail", "복사에 실패했습니다."));
  }
}

/** @param {ThumbItem[]} items @param {string} videoId */
function renderQualityCards(items, videoId) {
  qualityGridEl.replaceChildren();
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "quality-card";
    card.dataset.id = item.id;
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", itzTf("ariaPreview", `${item.title} ${item.width}×${item.height} 미리보기`, { title: item.title, w: item.width, h: item.height }));

    const img = document.createElement("img");
    img.className = "quality-thumb";
    img.src = item.url;
    img.alt = "";
    img.decoding = "async";

    const copy = document.createElement("div");
    copy.className = "quality-copy";
    const title = document.createElement("span");
    title.className = "quality-title";
    title.textContent = item.title;
    const size = document.createElement("span");
    size.className = "quality-size";
    size.textContent = `${item.width}×${item.height}`;
    copy.append(title, size);

    const save = document.createElement("button");
    save.type = "button";
    save.className = "quality-download";
    save.textContent = itzT("saveThis", "이 화질 저장");
    save.addEventListener("click", (event) => {
      event.stopPropagation();
      void saveImage(item.url, `youtube-${videoId}-${item.id}.jpg`);
    });

    card.append(img, copy, save);
    card.addEventListener("click", () => selectThumb(item));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectThumb(item);
      }
    });
    qualityGridEl.appendChild(card);
  }
}

/** @param {string} raw */
async function loadFromInput(raw) {
  const videoId = parseVideoId(raw);
  if (!videoId) {
    setStatus(itzT("needUrl", "유튜브 영상 주소를 확인해주세요."), true);
    return;
  }

  fetchButton.disabled = true;
  setStatus(itzTf("checkingId", `영상 ID ${videoId} · 썸네일을 확인하는 중…`, { id: videoId }));
  setStage("loading");
  qualitySection.hidden = true;

  try {
    const items = await collectThumbs(videoId);
    if (!items.length) {
      current = null;
      setStage("empty");
      setStatus(itzT("noneFound", "이 영상에서 공개 썸네일을 찾지 못했습니다."), true);
      return;
    }

    items.sort((a, b) => b.width * b.height - a.width * a.height);
    current = { videoId, items, selectedId: items[0].id };
    selectThumb(items[0]);
    renderQualityCards(items, videoId);
    qualityMeta.textContent = itzTf("qualityMeta", `ID ${videoId} · ${items.length}개 화질`, { id: videoId, n: items.length });
    qualitySection.hidden = false;
    setStage("ready");
    setStatus(itzTf("bestSize", `영상 ID ${videoId} · 가장 큰 화질은 ${items[0].width}×${items[0].height}입니다.`, { id: videoId, w: items[0].width, h: items[0].height }));
  } catch (error) {
    current = null;
    setStage("empty");
    setStatus(error instanceof Error ? error.message : itzT("fetchFail", "썸네일을 불러오지 못했습니다."), true);
  } finally {
    fetchButton.disabled = false;
  }
}

function bindUi() {
  fetchButton.addEventListener("click", () => {
    void loadFromInput(urlField.value);
  });

  urlField.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void loadFromInput(urlField.value);
    }
  });

  urlField.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text") || "";
    window.setTimeout(() => {
      void loadFromInput(text || urlField.value);
    }, 0);
  });

  pasteButton.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      urlField.value = text;
      await loadFromInput(text);
    } catch {
      urlField.focus();
      setStatus(itzT("clipboardFail", "클립보드를 읽을 수 없습니다. Ctrl+V로 붙여넣으세요."), true);
    }
  });

  saveBestButton.addEventListener("click", () => {
    const item = selectedThumb();
    if (!item || !current) return;
    void saveImage(item.url, `youtube-${current.videoId}-${item.id}.jpg`);
  });

  copyUrlButton.addEventListener("click", () => {
    const item = selectedThumb();
    if (!item) return;
    void copyText(item.url);
  });

  openTabButton.addEventListener("click", () => {
    const item = selectedThumb();
    if (!item) return;
    window.open(item.url, "_blank", "noopener,noreferrer");
  });
}

function bootFromQuery() {
  const params = new URLSearchParams(location.search);
  const preset = params.get("url") || params.get("v") || "";
  if (!preset) return;
  urlField.value = preset;
  void loadFromInput(preset);
}

function boot() {
  bindUi();
  bootFromQuery();
  void showAdSense("editorAboveWorkspace", "#editor-ad-above-path");
  void showAdSense("editorBelowExport", "#editor-ad-below-export");
  document.addEventListener("itz:lang-change", () => {
    if (current?.items?.length) {
      renderQualityCards(current.items, current.videoId);
      qualityMeta.textContent = itzTf("qualityMeta", `ID ${current.videoId} · ${current.items.length}개 화질`, { id: current.videoId, n: current.items.length });
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
