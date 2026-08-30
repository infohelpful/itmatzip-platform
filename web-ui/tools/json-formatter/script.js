import { showAdSense } from "../common/adsense.js?v=5";
import { ensureSiteModalStyles } from "../common/site-modal.js?v=sm4";
import { toPython, toTypeScript } from "./convert.js";
import { LOCALES, applyI18n, detectLocale, getLocale, t } from "./i18n.js?v=12";

const MB = 1024 * 1024;
const WORKER_MS = 20000;

const els = {
  input: document.getElementById("input"),
  outputText: document.getElementById("output-text"),
  outputTree: document.getElementById("output-tree"),
  outputEmpty: document.getElementById("output-empty"),
  banner: document.getElementById("banner"),
  path: document.getElementById("path-input"),
  extractOut: document.getElementById("extract-out"),
  convertOut: document.getElementById("convert-out"),
  dropzone: document.getElementById("input-pane"),
  file: document.getElementById("file-input"),
  toast: document.getElementById("toast"),
  lang: document.getElementById("lang-select"),
  caret: document.getElementById("input-caret"),
  outputMeta: document.getElementById("output-meta"),
  indent: document.getElementById("indent-select"),
  inputBody: document.getElementById("input-body"),
  squiggles: document.getElementById("input-squiggles"),
  overview: document.getElementById("input-overview"),
  outputError: document.getElementById("output-error"),
  errorList: document.getElementById("output-error-list"),
};

let monacoInputEditor = null;
let monacoOutputEditor = null;
let worker = null;
let jobId = 0;
let pending = null;
let lastPretty = "";
let lastValue = null;
let lastPath = "$";
let outTab = "text";
let toastTimer = 0;
let lastError = false;
let inputDecors = [];
let tickTargets = [];
let lastPaintIssues = [];
let wrapColsCache = { key: "", cols: 0 };
let posMeasureCache = { key: "", text: "", result: null };

function getInputValue() {
  if (monacoInputEditor) return monacoInputEditor.getValue();
  return els.input ? els.input.value : "";
}

function setInputValue(val) {
  const str = String(val || "");
  if (els.input) els.input.value = str;
  if (monacoInputEditor) monacoInputEditor.setValue(str);
}

function runValidationOnly() {
  const text = getInputValue();
  if (!text.trim()) {
    clearInputDecorations();
    return;
  }
  runWorker({ action: "format", text, minify: false, indent: 2, isLint: true }).then((result) => {
    if (result && result.silent) return;
    if (!result.ok) {
      const issues = result.issues || [
        { code: "parse", message: result.error || "", line: result.line, column: result.column, position: result.position || 0, end: (result.position || 0) + 1 }
      ];
      paintInputErrors(issues, { keepScroll: true });
    } else {
      if (lastError) {
        lastError = false;
        clearInputDecorations();
        if (els.outputError) els.outputError.hidden = true;
      }
    }
  }).catch(() => {});
}

function initMonaco() {
  if (typeof window.require !== "function") return;
  try {
    window.require.config({
      paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs" }
    });
    window.require(["vs/editor/editor.main"], function () {
      if (!window.monaco) return;
      window.monaco.languages.json.jsonDefaults.setDiagnosticsOptions({ validate: false });

      const inContainer = document.getElementById("monaco-editor-container");
      const isDark = !document.documentElement.classList.contains("itz-theme-light");
      const themeName = isDark ? "vs-dark" : "vs";

      if (inContainer) {
        monacoInputEditor = window.monaco.editor.create(inContainer, {
          value: els.input ? els.input.value : "",
          language: "json",
          theme: themeName,
          wordWrap: "on",
          automaticLayout: true,
          scrollBeyondLastLine: false,
          minimap: { enabled: true },
          glyphMargin: true,
          renderValidationDecorations: "on",
          fontSize: 14,
          fontFamily: '"JetBrains Mono", "Cascadia Code", ui-monospace, monospace',
        });

        let lintTimer = null;
        monacoInputEditor.onDidChangeModelContent(() => {
          if (els.input) els.input.value = monacoInputEditor.getValue();
          updateCaret();
          window.clearTimeout(lintTimer);
          lintTimer = window.setTimeout(() => {
            runValidationOnly();
          }, 250);
        });

        monacoInputEditor.onDidChangeCursorPosition(updateCaret);
      }

      const outContainer = document.getElementById("monaco-output-container");
      if (outContainer) {
        monacoOutputEditor = window.monaco.editor.create(outContainer, {
          value: lastPretty || "",
          language: "json",
          theme: themeName,
          readOnly: true,
          wordWrap: "on",
          automaticLayout: true,
          scrollBeyondLastLine: false,
          minimap: { enabled: true },
          fontSize: 14,
          fontFamily: '"JetBrains Mono", "Cascadia Code", ui-monospace, monospace',
          folding: true,
        });
      }

      const themeBtn = document.getElementById("itz-theme-toggle");
      if (themeBtn) {
        themeBtn.addEventListener("click", () => {
          setTimeout(() => {
            const dark = !document.documentElement.classList.contains("itz-theme-light");
            if (window.monaco) {
              window.monaco.editor.setTheme(dark ? "vs-dark" : "vs");
            }
          }, 10);
        });
      }

      if (lastPaintIssues && lastPaintIssues.length) {
        paintInputErrors(lastPaintIssues, { keepScroll: true });
      }

      runValidationOnly();
    });
  } catch (e) {
    console.warn("[json-formatter] Monaco init skipped", e);
  }
}

function limits() {
  const mobile = window.matchMedia("(max-width: 720px)").matches;
  const mem = Number(navigator.deviceMemory) || 0;
  let formatMax = 30 * MB;
  let treeMax = 8 * MB;
  if (mobile) {
    formatMax = 10 * MB;
    treeMax = Math.min(treeMax, 8 * MB);
  }
  if (mem && mem <= 2) {
    formatMax = Math.min(formatMax, 12 * MB);
    treeMax = Math.min(treeMax, 5 * MB);
  }
  return { warn: 2 * MB, warnHigh: 5 * MB, formatMax, treeMax };
}

function byteLen(text) {
  return new Blob([text]).size;
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./format-worker.js?v=25", import.meta.url));
  worker.onmessage = (event) => {
    const data = event.data || {};
    if (!pending || data.id !== pending.id) return;
    window.clearTimeout(pending.timer);
    pending.resolve(data);
    pending = null;
  };
  worker.onerror = (event) => {
    console.error("[json-formatter]", event && event.message);
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pending.reject(new Error("worker"));
    pending = null;
  };
  return worker;
}

function runWorker(payload) {
  return new Promise((resolve, reject) => {
    if (pending) {
      if (pending.isLint) {
        window.clearTimeout(pending.timer);
        pending.resolve({ ok: false, silent: true });
        pending = null;
      } else if (payload.isLint) {
        resolve({ ok: false, silent: true });
        return;
      } else {
        window.clearTimeout(pending.timer);
        pending.reject(new Error("busy"));
        pending = null;
      }
    }
    const id = ++jobId;
    ensureWorker();
    const timer = window.setTimeout(() => {
      try {
        worker.terminate();
      } catch {
        /* ignore */
      }
      worker = null;
      if (pending && pending.id === id) {
        pending = null;
        reject(new Error("timeout"));
      }
    }, WORKER_MS);
    pending = { id, resolve, reject, timer, isLint: Boolean(payload.isLint) };
    worker.postMessage({ ...payload, id });
  });
}

function setBanner(kind, text) {
  els.banner.className = "banner" + (kind ? ` is-${kind}` : "");
  els.banner.textContent = text || "";
}

function toast(message) {
  els.toast.hidden = false;
  els.toast.textContent = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 2400);
}

function jsonPathKey(key) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `.${key}`;
  return `[${JSON.stringify(key)}]`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function highlightJson(text) {
  const esc = escapeHtml(text);
  return esc.replace(
    /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(true|false|null)\b/g,
    (all, key, str, num, lit) => {
      if (key) return `<span class="k">${key}</span>:`;
      if (str) return `<span class="s">${str}</span>`;
      if (num) return `<span class="n">${num}</span>`;
      return `<span class="l">${lit}</span>`;
    },
  );
}

function previewValue(value) {
  if (value === null) return "null";
  if (typeof value === "string") {
    const s = JSON.stringify(value);
    return s.length > 80 ? `${s.slice(0, 77)}…"` : s;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `Array(${value.length})`;
  return `{${Object.keys(value).length}}`;
}

function renderTree(value, path, into, depth) {
  if (depth > 12) {
    into.append(document.createTextNode("…"));
    return;
  }
  if (value === null || typeof value !== "object") {
    const span = document.createElement("span");
    span.className = "tree-val" + (typeof value === "string" ? " is-str" : typeof value === "number" ? " is-num" : "");
    span.textContent = previewValue(value);
    into.append(span);
    return;
  }
  const entries = Array.isArray(value) ? value.map((item, i) => [i, item]) : Object.entries(value);
  const shown = entries.slice(0, 2000);
  for (const [key, child] of shown) {
    const childPath = Array.isArray(value) ? `${path}[${key}]` : path + jsonPathKey(String(key));
    const wrap = document.createElement("div");
    wrap.className = "tree-node";
    const row = document.createElement("div");
    row.className = "tree-row";
    const complex = child !== null && typeof child === "object";
    if (complex) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "tree-toggle";
      toggle.textContent = "▸";
      row.append(toggle);
      const body = document.createElement("div");
      body.hidden = true;
      toggle.addEventListener("click", () => {
        const open = body.hidden;
        body.hidden = !open;
        toggle.textContent = open ? "▾" : "▸";
        if (open && !body.childNodes.length) renderTree(child, childPath, body, depth + 1);
      });
      wrap.append(row, body);
    } else {
      row.append(document.createElement("span"));
      wrap.append(row);
    }
    const keyBtn = document.createElement("button");
    keyBtn.type = "button";
    keyBtn.className = "tree-key";
    keyBtn.textContent = Array.isArray(value) ? `[${key}]` : String(key);
    keyBtn.addEventListener("click", () => {
      lastPath = childPath;
      els.path.value = childPath;
      void navigator.clipboard.writeText(childPath).then(() => toast(t("copied")));
    });
    row.append(keyBtn);
    if (!complex) {
      const val = document.createElement("span");
      val.className = "tree-val";
      if (typeof child === "number") val.classList.add("is-num");
      if (typeof child === "string") val.classList.add("is-str");
      val.textContent = previewValue(child);
      row.append(val);
    }
    into.append(wrap);
  }
  if (entries.length > shown.length) {
    const more = document.createElement("div");
    more.className = "tree-node";
    more.textContent = `… +${entries.length - shown.length}`;
    into.append(more);
  }
}

let errorDecorations = [];

function paintMonacoDecorations(issues) {
  if (!monacoInputEditor || !window.monaco) return;
  const model = monacoInputEditor.getModel();
  if (!model) return;

  const newDecorations = (issues || []).slice(0, 2000).map((issue) => {
    const startPos = model.getPositionAt(Math.max(0, Number(issue.position) || 0));
    const endPos = model.getPositionAt(Math.max((issue.position || 0) + 1, Number(issue.end) || (issue.position || 0) + 1));
    const msg = issueMessage(issue, null);

    return {
      range: new window.monaco.Range(
        startPos.lineNumber,
        startPos.column,
        endPos.lineNumber,
        endPos.column
      ),
      options: {
        isWholeLine: false,
        className: "monaco-error-whole-line",
        inlineClassName: "monaco-error-text-highlight",
        lineNumberClassName: "monaco-error-line-number-highlight",
        glyphMarginClassName: "monaco-error-glyph-margin",
        linesDecorationsClassName: "monaco-error-line-decoration",
        overviewRuler: {
          color: "#ef4444",
          position: window.monaco.editor.OverviewRulerLane.Full
        },
        minimap: {
          color: "#ef4444",
          position: window.monaco.editor.MinimapPosition.Inline
        },
        hoverMessage: { value: `**${window.itzT("errHover", "JSON 문법 오류")}**: ${msg}` }
      }
    };
  });

  errorDecorations = monacoInputEditor.deltaDecorations(errorDecorations, newDecorations);
}

function clearInputDecorations() {
  inputDecors = [];
  tickTargets = [];
  if (monacoInputEditor && window.monaco) {
    const model = monacoInputEditor.getModel();
    if (model) {
      window.monaco.editor.setModelMarkers(model, "json", []);
      errorDecorations = monacoInputEditor.deltaDecorations(errorDecorations, []);
    }
  }
  const canvas = els.squiggles;
  if (canvas && canvas.getContext) {
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  if (els.overview) els.overview.replaceChildren();
}

function copyWrapStyle(from, to) {
  const cs = getComputedStyle(from);
  to.style.boxSizing = "border-box";
  to.style.width = `${from.clientWidth}px`;
  to.style.paddingTop = cs.paddingTop;
  to.style.paddingRight = cs.paddingRight;
  to.style.paddingBottom = cs.paddingBottom;
  to.style.paddingLeft = cs.paddingLeft;
  to.style.border = "0";
  to.style.font = cs.font;
  to.style.fontFamily = cs.fontFamily;
  to.style.fontSize = cs.fontSize;
  to.style.fontWeight = cs.fontWeight;
  to.style.letterSpacing = cs.letterSpacing;
  to.style.lineHeight = cs.lineHeight;
  to.style.tabSize = cs.tabSize;
  to.style.whiteSpace = "pre-wrap";
  to.style.wordBreak = "break-all";
  to.style.overflowWrap = "anywhere";
  to.style.overflow = "hidden";
}

function charsPerWrapLine(ta) {
  const key = `${ta.clientWidth}|${getComputedStyle(ta).font}|${getComputedStyle(ta).lineHeight}`;
  if (wrapColsCache.key === key && wrapColsCache.cols) return wrapColsCache.cols;
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.position = "absolute";
  probe.style.left = "-99999px";
  probe.style.top = "0";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  copyWrapStyle(ta, probe);
  document.body.append(probe);
  probe.textContent = "0";
  const h1 = probe.offsetHeight;
  let lo = 1;
  let hi = Math.max(8, Math.ceil(ta.clientWidth));
  probe.textContent = "0".repeat(hi);
  while (probe.offsetHeight <= h1 + 0.5 && hi < 8000) {
    lo = hi;
    hi *= 2;
    probe.textContent = "0".repeat(hi);
  }
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    probe.textContent = "0".repeat(mid);
    if (probe.offsetHeight > h1 + 0.5) hi = mid - 1;
    else lo = mid;
  }
  probe.remove();
  wrapColsCache = { key, cols: Math.max(1, lo) };
  return wrapColsCache.cols;
}

function visualMetrics(ta) {
  const cs = getComputedStyle(ta);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const padT = parseFloat(cs.paddingTop) || 0;
  const padB = parseFloat(cs.paddingBottom) || 0;
  const fs = parseFloat(cs.fontSize) || 14;
  let lh = parseFloat(cs.lineHeight);
  if (!Number.isFinite(lh) || cs.lineHeight === "normal") lh = fs * 1.55;
  const innerW = Math.max(1, ta.clientWidth - padL - padR);
  const cols = charsPerWrapLine(ta);
  const charW = innerW / cols;
  const text = String(ta.value || "");
  if (text && text.indexOf("\n") === -1) {
    const visualLines = Math.max(1, Math.round((ta.scrollHeight - padT - padB) / lh));
    const wrapped = Math.ceil(text.length / cols);
    if (visualLines > 1 && Math.abs(wrapped - visualLines) > 1) {
      const snapped = Math.max(1, Math.round(text.length / visualLines));
      return { padL, padT, innerW, lineHeight: lh, charW: innerW / snapped, cols: snapped, fontSize: fs };
    }
  }
  return { padL, padT, innerW, lineHeight: lh, charW, cols, fontSize: fs };
}

function visualPoint(m, row, col) {
  return {
    top: m.padT + row * m.lineHeight,
    left: m.padL + col * m.charW,
    wrapRow: row + 1,
    wrapCol: col + 1,
    width: m.charW,
    height: m.lineHeight,
    fontSize: m.fontSize,
  };
}

function visualMap(ta, positions) {
  const m = visualMetrics(ta);
  const text = String(ta.value || "");
  const want = new Set();
  let maxPos = 0;
  for (const pos of positions) {
    const p = Math.max(0, Math.min(text.length, Number(pos) || 0));
    want.add(p);
    if (p > maxPos) maxPos = p;
  }
  const out = new Map();
  const mark = (at, row, col) => {
    if (!want.has(at) || out.has(at)) return;
    out.set(at, visualPoint(m, row, col));
  };
  mark(0, 0, 0);
  let row = 0;
  let col = 0;
  const limit = Math.min(text.length, maxPos);
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 10) {
      row += 1;
      col = 0;
    } else {
      col += 1;
      if (col >= m.cols) {
        row += 1;
        col = 0;
      }
    }
    mark(i + 1, row, col);
  }
  return { map: out, metrics: m };
}

function measurePositions(ta, positions) {
  const text = String(ta.value || "");
  const uniq = [];
  const seen = new Set();
  for (const pos of positions) {
    const p = Math.max(0, Math.min(text.length, Number(pos) || 0));
    if (seen.has(p)) continue;
    seen.add(p);
    uniq.push(p);
  }
  uniq.sort((a, b) => a - b);
  const cacheKey = `${ta.clientWidth}|${uniq.join(",")}`;
  if (posMeasureCache.text === text && posMeasureCache.key === cacheKey && posMeasureCache.result) return posMeasureCache.result;
  const fallback = visualMap(ta, uniq);
  if (!uniq.length || uniq[uniq.length - 1] > 1.5e6) {
    posMeasureCache = { key: cacheKey, text, result: fallback };
    return fallback;
  }
  const div = document.createElement("div");
  div.setAttribute("aria-hidden", "true");
  div.style.position = "absolute";
  div.style.left = "-99999px";
  div.style.top = "0";
  div.style.visibility = "hidden";
  div.style.pointerEvents = "none";
  copyWrapStyle(ta, div);
  const frag = document.createDocumentFragment();
  const spans = [];
  let last = 0;
  for (const p of uniq) {
    if (p > last) frag.append(document.createTextNode(text.slice(last, p)));
    const span = document.createElement("span");
    span.style.font = "inherit";
    span.style.display = "inline";
    span.style.margin = "0";
    span.style.padding = "0";
    span.style.border = "0";
    span.textContent = p < text.length ? text.charAt(p) : ".";
    frag.append(span);
    spans.push({ p, span });
    last = p;
  }
  div.append(frag);
  document.body.append(div);
  const m = fallback.metrics;
  const map = new Map();
  for (const { p, span } of spans) {
    const top = span.offsetTop;
    const left = span.offsetLeft;
    const row = Math.max(0, Math.round((top - m.padT) / m.lineHeight));
    const col = Math.max(0, Math.round((left - m.padL) / m.charW));
    map.set(p, {
      top,
      left,
      wrapRow: row + 1,
      wrapCol: col + 1,
      width: Math.max(m.charW, span.offsetWidth || m.charW),
      height: m.lineHeight,
      fontSize: m.fontSize,
    });
  }
  div.remove();
  const result = { map, metrics: m };
  posMeasureCache = { key: cacheKey, text, result };
  return result;
}

function expandToken(text, start, end) {
  const s = Math.max(0, Math.min(text.length, Number(start) || 0));
  return { start: s, end: Math.min(text.length, Math.max(s + 1, Number(end) || s + 1)) };
}

function yForPos(ta, pos) {
  const vis = measurePositions(ta, [pos]);
  const at = vis.map.get(Math.max(0, Math.min(String(ta.value || "").length, Number(pos) || 0)));
  if (at) return at.top;
  const n = Math.max(1, String(ta.value || "").length);
  const cs = getComputedStyle(ta);
  const padT = parseFloat(cs.paddingTop) || 0;
  const padB = parseFloat(cs.paddingBottom) || 0;
  const content = Math.max(1, ta.scrollHeight - padT - padB);
  return padT + (Math.max(0, Math.min(Number(pos) || 0, n)) / n) * content;
}

function measureIssueRects(issues) {
  const ta = els.input;
  const text = ta.value;
  if (!ta || !text) return { rects: [], ticks: [] };

  const probes = [];
  const seen = new Set();
  const maxProbes = 80;
  for (const issue of issues || []) {
    const rawStart = Math.max(0, Math.min(text.length, Number(issue.position) || 0));
    const rawEnd = Math.max(rawStart + 1, Math.min(text.length, Number(issue.end) || rawStart + 1));
    const { start, end } = expandToken(text, rawStart, rawEnd);
    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    probes.push({ start, end, pos: start });
    if (probes.length >= maxProbes) break;
  }
  if (!probes.length) return { rects: [], ticks: [] };

  const positions = [];
  for (const p of probes) {
    positions.push(p.start, p.end);
  }
  const vis = measurePositions(ta, positions);
  const rects = [];
  const ticks = [];
  const seenPos = new Set();
  for (const p of probes) {
    const a = vis.map.get(p.start);
    const b = vis.map.get(p.end);
    if (!a) continue;
    let width = vis.metrics.charW * Math.max(1, p.end - p.start);
    if (b && a.wrapRow === b.wrapRow) width = Math.max(8, b.left - a.left);
    else width = Math.max(8, vis.metrics.innerW - (a.left - vis.metrics.padL));
    rects.push({
      top: a.top,
      left: a.left,
      width,
      height: a.height || vis.metrics.lineHeight,
      fontSize: vis.metrics.fontSize,
      pos: p.pos,
      end: p.end,
    });
    if (!seenPos.has(p.pos)) {
      seenPos.add(p.pos);
      ticks.push({ pos: p.pos, end: p.end, wrapRow: a.wrapRow, wrapCol: a.wrapCol, top: a.top });
    }
  }
  return { rects, ticks };
}

function drawWavyLine(ctx, startX, endX, y) {
  const waveLength = 4;
  const waveHeight = 2;
  const x0 = Math.max(0, startX);
  const x1 = Math.max(x0 + 6, endX);
  ctx.save();
  ctx.strokeStyle = "#dc2626";
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  let currentX = x0;
  let up = true;
  while (currentX < x1) {
    const nextX = Math.min(currentX + waveLength, x1);
    const controlY = up ? y - waveHeight : y + waveHeight;
    ctx.quadraticCurveTo(currentX + waveLength / 2, controlY, nextX, y);
    currentX = nextX;
    up = !up;
  }
  ctx.stroke();
  ctx.restore();
}

function syncInputDecor() {
  const ta = els.input;
  const canvas = els.squiggles;
  if (!ta || !canvas || !els.overview) return;
  const st = ta.scrollTop;
  const sl = ta.scrollLeft;
  const viewH = ta.clientHeight;
  const viewW = ta.clientWidth;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.floor(viewW * dpr));
  canvas.height = Math.max(1, Math.floor(viewH * dpr));
  canvas.style.width = `${viewW}px`;
  canvas.style.height = `${viewH}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewW, viewH);
  for (const d of inputDecors) {
    const y = d.top + (d.fontSize || 14) + 1 - st;
    const x = d.left - sl;
    if (y + 8 < 0 || y > viewH || x + d.width < 0 || x > viewW) continue;
    drawWavyLine(ctx, x, x + Math.max(8, d.width), y);
  }

  els.overview.replaceChildren();
  const n = Math.max(1, String(ta.value || "").length);
  const sh = Math.max(1, ta.scrollHeight);
  const ch = ta.clientHeight;
  const maxScroll = Math.max(1, sh - ch);
  const thumbH = sh > ch ? Math.max(16, (ch / sh) * ch) : ch;
  const usable = Math.max(1, ch - thumbH);
  const placed = [];
  const sameRow = new Map();
  for (const tick of tickTargets) {
    const row = Number(tick.wrapRow) || 0;
    sameRow.set(row, (sameRow.get(row) || 0) + 1);
  }
  const rowSeen = new Map();
  for (const tick of tickTargets) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "input-overview-tick";
    btn.title = t("errTitle");
    const y = Number.isFinite(tick.top) ? tick.top : yForPos(ta, tick.pos);
    const stIfCentered = Math.min(maxScroll, Math.max(0, y - ch / 2.4));
    let top = sh <= ch ? (tick.pos / n) * ch : (stIfCentered / maxScroll) * usable + thumbH / 2;
    const row = Number(tick.wrapRow) || 0;
    const idxInRow = rowSeen.get(row) || 0;
    rowSeen.set(row, idxInRow + 1);
    if ((sameRow.get(row) || 1) > 1) {
      top += idxInRow * 8;
      btn.style.left = `${idxInRow * 4}px`;
    }
    for (const prev of placed) {
      if (Math.abs(top - prev) < 7) top = prev + 8;
    }
    top = Math.min(ch - 4, Math.max(3, top));
    placed.push(top);
    btn.style.top = `${top}px`;
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      scrollToError(tick.pos, tick.end);
    });
    els.overview.append(btn);
  }
}

function scrollToError(pos, end) {
  const text = getInputValue();
  const start = Math.max(0, Math.min(text.length, Number(pos) || 0));
  const stop = Math.max(start + 1, Math.min(text.length, Number(end) || start + 1));

  if (monacoInputEditor && window.monaco) {
    const model = monacoInputEditor.getModel();
    if (model) {
      const startPos = model.getPositionAt(start);
      const endPos = model.getPositionAt(stop);
      monacoInputEditor.revealPositionInCenter(startPos);
      monacoInputEditor.setSelection({
        startLineNumber: startPos.lineNumber,
        startColumn: startPos.column,
        endLineNumber: endPos.lineNumber,
        endColumn: endPos.column,
      });
      monacoInputEditor.focus();
    }
  }

  const ta = els.input;
  if (ta) {
    const y = yForPos(ta, start);
    ta.scrollTop = Math.max(0, y - Math.round(ta.clientHeight / 2.4));
    try {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(start, stop);
    } catch {
      /* ignore */
    }
  }
  updateCaret();
  syncInputDecor();
}

function paintInputErrors(issues, opts = {}) {
  lastPaintIssues = issues || [];
  clearInputDecorations();
  if (monacoInputEditor && window.monaco) {
    const model = monacoInputEditor.getModel();
    if (model) {
      const markers = (issues || []).slice(0, 2000).map((issue) => {
        const startPos = model.getPositionAt(Math.max(0, Number(issue.position) || 0));
        const endPos = model.getPositionAt(Math.max((issue.position || 0) + 1, Number(issue.end) || (issue.position || 0) + 1));
        return {
          severity: window.monaco.MarkerSeverity.Error,
          message: issueMessage(issue, null),
          startLineNumber: startPos.lineNumber,
          startColumn: startPos.column,
          endLineNumber: endPos.lineNumber,
          endColumn: endPos.column,
        };
      });
      window.monaco.editor.setModelMarkers(model, "json", markers);
      paintMonacoDecorations(issues);
    }
  }
  const run = () => {
    const measured = measureIssueRects(issues);
    inputDecors = measured.rects;
    tickTargets = measured.ticks;
    syncInputDecor();
    if (!opts.keepScroll && (tickTargets[0] || (issues && issues[0]))) {
      const firstPos = (issues && issues[0] && issues[0].position) || (tickTargets[0] && tickTargets[0].pos) || 0;
      const firstEnd = (issues && issues[0] && issues[0].end) || (tickTargets[0] && tickTargets[0].end) || firstPos + 1;
      scrollToError(firstPos, firstEnd);
    }
  };
  requestAnimationFrame(run);
}

function locPrefix(issue, vis) {
  if (!issue.line) return "";
  const src = `${issue.line}${t("line")} ${issue.column}${t("col")}`;
  if (vis && vis.wrapRow > 1 && issue.line === 1) {
    return `${t("wrapLoc").replace("{w}", String(vis.wrapRow)).replace("{c}", String(vis.wrapCol))} (${src}): `;
  }
  return `${src}: `;
}

function describeParse(raw, line, col, vis) {
  const loc = locPrefix({ line, column: col }, vis);
  const msg = String(raw || "");
  if (/Unexpected end of JSON input/i.test(msg)) return loc + t("errUnexpectedEnd");
  if (/Unterminated string/i.test(msg)) return loc + t("errUnterminated");
  if (/Expected property name/i.test(msg)) return loc + t("errPropertyName");
  const tok = msg.match(/Unexpected token (\S)/);
  if (tok) return loc + t("errUnexpectedToken").replace("{token}", tok[1]);
  return loc + t("parseFail") + (msg ? ` (${msg})` : "");
}

function issueMessage(issue, vis) {
  const loc = locPrefix(issue, vis);
  switch (issue.code) {
    case "trailingComma":
      return loc + t("issueTrailingComma");
    case "quotes":
      return loc + t("issueQuotes");
    case "comments":
      return loc + t("issueComments");
    case "python":
      return loc + t("issuePython");
    case "unquotedKey":
      return loc + t("issueUnquotedKey");
    case "unquotedValue":
      return loc + t("issueUnquotedValue");
    case "missingBrace":
      return loc + t("issueMissingBrace");
    case "missingComma":
      return loc + t("issueMissingComma");
    case "missingColon":
      return loc + t("issueMissingColon");
    case "missingValue":
      return loc + t("issueMissingValue");
    case "trailingJunk":
      return loc + t("issueTrailingJunk");
    case "leadingZero":
      return loc + t("issueLeadingZero");
    case "badNumber":
      return loc + t("issueBadNumber");
    case "unmatched":
      return loc + t("issueUnmatched");
    case "unclosed":
      return loc + t("issueUnclosed");
    case "extraClose":
      return loc + t("issueExtraClose");
    case "unterminated":
      return loc + t("errUnterminated");
    case "parse":
      return describeParse(issue.message, issue.line, issue.column, vis);
    case "unexpected":
      return loc + t("issueExpecting").replace("{got}", issue.got || "'INVALID'").replace("{want}", issue.want || "'EOF'");
    default:
      return loc + (issue.message || t("parseFail"));
  }
}

function showSyntaxError(result) {
  lastError = true;
  lastPretty = "";
  lastValue = null;
  const issues =
    result.issues && result.issues.length
      ? result.issues
      : [
          {
            code: "parse",
            message: result.error || "",
            line: result.line,
            column: result.column,
            position: result.position || 0,
            end: (result.position || 0) + 1,
          },
        ];
  paintInputErrors(issues);
  const vis = els.input ? measurePositions(els.input, issues.map((item) => item.position || 0)) : { map: new Map() };
  if (els.errorList) {
    els.errorList.replaceChildren();
    const seen = new Set();
    for (const issue of issues) {
      const at = vis.map.get(Math.max(0, Number(issue.position) || 0));
      const text = issueMessage(issue, at);
      const key = `${issue.code}:${issue.position}`;
      if (!text || seen.has(key)) continue;
      seen.add(key);
      const li = document.createElement("li");
      li.textContent = text;
      li.dataset.pos = String(issue.position || 0);
      li.dataset.end = String(issue.end || (issue.position || 0) + 1);
      els.errorList.append(li);
    }
  }
  const kicker = document.querySelector(".output-error-kicker");
  if (kicker) {
    kicker.textContent =
      issues.length > 1 ? t("errTitleCount").replace("{n}", String(issues.length)) : t("errTitle");
  }
  showOutput();
  if (els.outputMeta) els.outputMeta.textContent = t("errTitle");
  setBanner("", "");
}

function showOutput() {
  const monacoOutPane = document.getElementById("monaco-output-container");
  if (lastError) {
    els.outputEmpty.hidden = true;
    els.outputText.hidden = true;
    if (monacoOutPane) monacoOutPane.hidden = true;
    els.outputTree.hidden = true;
    if (els.outputError) els.outputError.hidden = false;
    return;
  }
  if (els.outputError) els.outputError.hidden = true;
  const has = Boolean(lastPretty);
  els.outputEmpty.hidden = has;

  if (outTab === "text" && has) {
    if (monacoOutPane && monacoOutputEditor) {
      monacoOutPane.hidden = false;
      els.outputText.hidden = true;
      monacoOutputEditor.setValue(lastPretty);
      monacoOutputEditor.layout();
    } else {
      if (monacoOutPane) monacoOutPane.hidden = true;
      els.outputText.hidden = false;
      els.outputText.innerHTML = highlightJson(lastPretty);
    }
    els.outputTree.hidden = true;
  } else if (outTab === "tree" && has) {
    if (monacoOutPane) monacoOutPane.hidden = true;
    els.outputText.hidden = true;
    els.outputTree.hidden = false;
  } else {
    if (monacoOutPane) monacoOutPane.hidden = true;
    els.outputText.hidden = true;
    els.outputTree.hidden = true;
  }
}

function setOutput(pretty, value, opts = {}) {
  lastError = false;
  if (!opts.keepDecorations) clearInputDecorations();
  lastPretty = pretty;
  lastValue = value;
  const size = byteLen(pretty);
  const { treeMax } = limits();
  if (outTab === "tree" && size > treeMax) {
    outTab = "text";
    document.getElementById("tab-text").classList.add("is-active");
    document.getElementById("tab-tree").classList.remove("is-active");
    if (!opts.silentTree) setBanner("ok", [opts.message, t("treeOff")].filter(Boolean).join(" "));
  }
  if (outTab === "tree" && size <= treeMax) {
    els.outputTree.replaceChildren();
    try {
      renderTree(value, "$", els.outputTree, 0);
    } catch {
      outTab = "text";
    }
  }
  showOutput();
  if (els.outputMeta) {
    els.outputMeta.textContent = `${String(pretty).split("\n").length} lines`;
  }
}

async function act(action, extra = {}) {
  const useWorking = (action === "query" || action === "mask") && lastPretty;
  const text = useWorking ? lastPretty : getInputValue();
  const size = byteLen(text);
  const cap = limits();
  if (size > cap.formatMax) {
    lastError = true;
    lastPretty = "";
    lastValue = null;
    clearInputDecorations();
    if (els.errorList) {
      els.errorList.replaceChildren();
      const li = document.createElement("li");
      li.textContent = t("tooBig");
      els.errorList.append(li);
    }
    showOutput();
    if (els.outputMeta) els.outputMeta.textContent = t("errTitle");
    setBanner("", "");
    return;
  }
  if (action === "query" && size > cap.treeMax) {
    setBanner("", t("treeOff"));
    return;
  }
  if (size >= cap.warn) setBanner("", t("warnSize"));
  else setBanner("", "");
  try {
    const indent = Number(els.indent && els.indent.value) === 4 ? 4 : 2;
    const result = await runWorker({ action, text, minify: action === "minify", indent, ...extra });
    if (!result.ok) {
      if (action === "query") {
        els.extractOut.hidden = false;
        els.extractOut.textContent = result.error || t("noMatch");
        return;
      }
      showSyntaxError(result);
      return;
    }
    const parsed = JSON.parse(result.text);
    const notes = (result.notes || []).map((key) => t(key)).join(" ");
    if (action === "query") {
      els.extractOut.hidden = false;
      els.extractOut.textContent = result.text;
      if (result.text === "[]") setBanner("", t("noMatch"));
      else setBanner("ok", result.path || "");
      return;
    }
    if (action === "mask") {
      setOutput(result.text, parsed);
      setBanner("ok", t("masked"));
      return;
    }
    const hasIssues = result.issues && result.issues.length > 0;
    if (hasIssues) {
      paintInputErrors(result.issues, { keepScroll: true });
    }
    setOutput(result.text, parsed, { keepDecorations: hasIssues, message: result.repaired ? t("repaired") : "" });
    if (result.repaired) {
      const n = result.issues.length;
      const issueCountMsg = hasIssues
        ? (window.ITZ_I18N?.tf?.("repairIssuesFixed", { n }) ||
            window.itzT("repairIssuesFixed", "({n}개 오류 위치 보정 완료)").replace("{n}", String(n)))
        : "";
      setBanner("ok", [t("repaired"), issueCountMsg, notes].filter(Boolean).join(" "));
    } else if (size >= cap.warn) {
      setBanner("", t("warnSize"));
    } else {
      setBanner("ok", "");
    }
  } catch {
    lastError = true;
    lastPretty = "";
    lastValue = null;
    clearInputDecorations();
    if (els.errorList) {
      els.errorList.replaceChildren();
      const li = document.createElement("li");
      li.textContent = t("workerFail");
      els.errorList.append(li);
    }
    showOutput();
    if (els.outputMeta) els.outputMeta.textContent = t("errTitle");
    setBanner("", "");
  }
}

async function copyText(value) {
  if (!value) return;
  await navigator.clipboard.writeText(value);
  toast(t("copied"));
}

function saveText(value, name) {
  const blob = new Blob([value], { type: "application/json;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(t("saved"));
}

function readFile(file) {
  if (!file) return;
  const type = String(file.type || "");
  if (type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/")) {
    setBanner("", t("badFile"));
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || "");
    setInputValue(text);
    void act("format");
  };
  reader.onerror = () => {
    setBanner("", t("badFile"));
  };
  reader.readAsText(file);
}

function bindLang() {
  els.lang.replaceChildren();
  for (const item of LOCALES) {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = item.label;
    els.lang.append(opt);
  }
  els.lang.value = getLocale();
  els.lang.addEventListener("change", () => {
    applyI18n(els.lang.value);
  });
}

function caretLabel(el) {
  const start = el.selectionStart || 0;
  const before = String(el.value || "").slice(0, start);
  const line = before.split("\n").length;
  const col = before.length - before.lastIndexOf("\n");
  return `Ln ${line}, Col ${col}`;
}

function updateCaret() {
  if (!els.caret) return;
  if (monacoInputEditor) {
    const pos = monacoInputEditor.getPosition();
    if (pos) {
      els.caret.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`;
      return;
    }
  }
  if (els.input) els.caret.textContent = caretLabel(els.input);
}

let currentMaskKeys = [];

function extractJsonKeys(text) {
  const map = new Map();

  try {
    let value = null;
    try {
      value = JSON.parse(text);
    } catch {
      const sanitized = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "").replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '"$1"');
      value = JSON.parse(sanitized);
    }
    if (value) {
      const walk = (v) => {
        if (Array.isArray(v)) {
          for (const item of v) walk(item);
        } else if (v && typeof v === "object") {
          for (const [k, child] of Object.entries(v)) {
            map.set(k, (map.get(k) || 0) + 1);
            walk(child);
          }
        }
      };
      walk(value);
    }
  } catch {
    /* fallback */
  }

  if (map.size === 0) {
    const keyRegex = /"([^"\\]|\\.)*"\s*:/g;
    let match;
    while ((match = keyRegex.exec(text)) !== null) {
      const rawKey = match[0].slice(1, match[0].lastIndexOf('"'));
      if (rawKey && rawKey.length > 0) {
        map.set(rawKey, (map.get(rawKey) || 0) + 1);
      }
    }
  }

  return Array.from(map.entries()).map(([key, count]) => ({ key, count }));
}

let maskScrollYBefore = 0;
let maskScrollLocked = false;

function preventMaskPageScroll(event) {
  const t = event.target;
  if (t instanceof Element && t.closest(".mask-modal-body")) return;
  event.preventDefault();
}

function preventMaskPageKeyScroll(event) {
  if (![" ", "PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(event.key)) return;
  const t = event.target;
  if (t instanceof Element && t.closest(".mask-modal-body, input, textarea, select")) return;
  event.preventDefault();
}

function scrollTopAdsToViewport() {
  const ad = document.querySelector(".editor-ad-row") || document.getElementById("editor-ad-above-path");
  if (!ad) return;
  const y = ad.getBoundingClientRect().top + window.scrollY;
  window.scrollTo(0, Math.max(0, y));
}

function positionMaskCardAtWorkspace() {
  const card = document.querySelector(".mask-modal-card");
  const workspace = document.querySelector(".workspace");
  if (!card) return;
  const top = workspace
    ? Math.max(8, Math.round(workspace.getBoundingClientRect().top))
    : 96;
  card.style.top = `${top}px`;
  card.style.maxHeight = `${Math.max(220, window.innerHeight - top - 16)}px`;
}

function onMaskModalResize() {
  if (!maskScrollLocked) return;
  positionMaskCardAtWorkspace();
}

function lockMaskPageScroll() {
  if (maskScrollLocked) return;
  maskScrollLocked = true;
  const y = window.scrollY;
  document.documentElement.classList.add("is-mask-modal-open");
  document.body.classList.add("itz-modal-visible", "is-mask-modal-open");
  document.body.style.position = "fixed";
  document.body.style.top = `-${y}px`;
  document.body.style.left = "0";
  document.body.style.right = "0";
  document.body.style.width = "100%";
  window.addEventListener("wheel", preventMaskPageScroll, { passive: false, capture: true });
  window.addEventListener("touchmove", preventMaskPageScroll, { passive: false, capture: true });
  window.addEventListener("keydown", preventMaskPageKeyScroll, true);
  window.addEventListener("resize", onMaskModalResize);
}

function unlockMaskPageScroll() {
  if (!maskScrollLocked) return;
  maskScrollLocked = false;
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";
  document.body.style.width = "";
  document.documentElement.classList.remove("is-mask-modal-open");
  document.body.classList.remove("is-mask-modal-open");
  window.removeEventListener("wheel", preventMaskPageScroll, { capture: true });
  window.removeEventListener("touchmove", preventMaskPageScroll, { capture: true });
  window.removeEventListener("keydown", preventMaskPageKeyScroll, true);
  window.removeEventListener("resize", onMaskModalResize);
  const card = document.querySelector(".mask-modal-card");
  if (card) {
    card.style.top = "";
    card.style.maxHeight = "";
  }
  window.scrollTo(0, maskScrollYBefore);
}

async function openMaskModal() {
  const text = getInputValue();
  if (!text.trim()) {
    toast(t("badFile"));
    return;
  }

  const modal = document.getElementById("mask-modal");
  const searchInput = document.getElementById("mask-search-input");
  if (!modal) return;

  const keys = extractJsonKeys(text);
  if (!keys || keys.length === 0) {
    void act("mask");
    return;
  }

  currentMaskKeys = keys;
  if (searchInput) searchInput.value = "";
  renderMaskKeys(currentMaskKeys, "");

  ensureSiteModalStyles();
  maskScrollYBefore = window.scrollY;
  scrollTopAdsToViewport();

  modal.hidden = false;
  modal.removeAttribute("hidden");
  modal.style.display = "flex";
  lockMaskPageScroll();
  positionMaskCardAtWorkspace();
  requestAnimationFrame(positionMaskCardAtWorkspace);
}

function closeMaskModal() {
  const modal = document.getElementById("mask-modal");
  if (modal) {
    modal.hidden = true;
    modal.setAttribute("hidden", "");
    modal.style.display = "none";
  }
  unlockMaskPageScroll();
  const siteBackdrop = document.getElementById("itz-modal-backdrop");
  if (!siteBackdrop || siteBackdrop.hidden) {
    document.body.classList.remove("itz-modal-visible");
  }
}

function renderMaskKeys(keys, filterText = "") {
  const container = document.getElementById("mask-keys-container");
  if (!container) return;

  const DEFAULT_SENSITIVE = /firstname|lastname|name|email|phone|mobile|tel|address|zipcode|city|street|password|passwd|token|secret|card|creditcard|auth|ssn|birth|rrn/i;

  const query = filterText.trim().toLowerCase();
  container.replaceChildren();

  const filtered = keys.filter(({ key }) => !query || String(key).toLowerCase().includes(query));

  if (filtered.length === 0) {
    const emptyMsg = document.createElement("div");
    emptyMsg.className = "mask-keys-empty";
    emptyMsg.style.cssText = "grid-column: 1 / -1; padding: 20px; text-align: center; color: var(--text-muted); font-size: 13px;";
    emptyMsg.textContent = t("maskEmpty");
    container.append(emptyMsg);
    updateMaskSelectedCount();
    return;
  }

  for (const { key, count } of filtered) {
    const isDefaultChecked = DEFAULT_SENSITIVE.test(key);

    const item = document.createElement("label");
    item.className = `mask-key-item${isDefaultChecked ? " is-selected" : ""}`;

    const labelDiv = document.createElement("div");
    labelDiv.className = "mask-key-label";

    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.value = key;
    chk.checked = isDefaultChecked;
    chk.addEventListener("change", (e) => {
      if (e.target.checked) item.classList.add("is-selected");
      else item.classList.remove("is-selected");
      updateMaskSelectedCount();
    });

    const textSpan = document.createElement("span");
    textSpan.textContent = key;

    labelDiv.append(chk, textSpan);

    const badge = document.createElement("span");
    badge.className = "mask-key-badge";
    badge.textContent = window.ITZ_I18N?.tf?.("issueCount", { n: count }) || `${count}`;

    item.append(labelDiv, badge);
    container.append(item);
  }

  updateMaskSelectedCount();
}

function updateMaskSelectedCount() {
  const container = document.getElementById("mask-keys-container");
  const countSpan = document.getElementById("mask-selected-count");
  if (!container || !countSpan) return;

  const checked = container.querySelectorAll('input[type="checkbox"]:checked');
  countSpan.textContent = t("maskSelected").replace("{n}", String(checked.length));
}

function initMaskModal() {
  const closeBtn = document.getElementById("btn-mask-close");
  const cancelBtn = document.getElementById("btn-mask-cancel");
  const backdrop = document.getElementById("mask-modal-backdrop");
  const applyBtn = document.getElementById("btn-mask-apply");
  const selectAllBtn = document.getElementById("btn-mask-select-all");
  const selectNoneBtn = document.getElementById("btn-mask-select-none");
  const searchInput = document.getElementById("mask-search-input");

  const closeHandler = () => closeMaskModal();

  if (closeBtn) closeBtn.addEventListener("click", closeHandler);
  if (cancelBtn) cancelBtn.addEventListener("click", closeHandler);
  if (backdrop) backdrop.addEventListener("click", closeHandler);

  if (selectAllBtn) {
    selectAllBtn.addEventListener("click", () => {
      const container = document.getElementById("mask-keys-container");
      if (!container) return;
      container.querySelectorAll(".mask-key-item").forEach((item) => {
        const chk = item.querySelector('input[type="checkbox"]');
        if (chk) {
          chk.checked = true;
          item.classList.add("is-selected");
        }
      });
      updateMaskSelectedCount();
    });
  }

  if (selectNoneBtn) {
    selectNoneBtn.addEventListener("click", () => {
      const container = document.getElementById("mask-keys-container");
      if (!container) return;
      container.querySelectorAll(".mask-key-item").forEach((item) => {
        const chk = item.querySelector('input[type="checkbox"]');
        if (chk) {
          chk.checked = false;
          item.classList.remove("is-selected");
        }
      });
      updateMaskSelectedCount();
    });
  }

  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      renderMaskKeys(currentMaskKeys, e.target.value || "");
    });
  }

  if (applyBtn) {
    applyBtn.addEventListener("click", () => {
      const container = document.getElementById("mask-keys-container");
      if (!container) return;
      const checkedInputs = Array.from(container.querySelectorAll('input[type="checkbox"]:checked'));
      const selectedKeys = checkedInputs.map((input) => input.value);
      closeMaskModal();
      void act("mask", { selectedKeys });
    });
  }
}

function boot() {
  applyI18n(detectLocale());
  bindLang();
  document.addEventListener("itz:lang-change", (ev) => {
    const lang = ev && ev.detail && ev.detail.lang;
    if (lang) applyI18n(lang);
    updateMaskSelectedCount();
  });
  initMonaco();
  initMaskModal();
  updateCaret();
  document.getElementById("btn-format").addEventListener("click", () => void act("format"));
  document.getElementById("btn-minify").addEventListener("click", () => void act("minify"));
  document.getElementById("btn-repair").addEventListener("click", () => void act("repair"));
  document.getElementById("btn-mask").addEventListener("click", () => void openMaskModal());
  document.getElementById("btn-copy-out").addEventListener("click", () => void copyText(lastPretty));
  document.getElementById("btn-save-out").addEventListener("click", () => saveText(lastPretty || getInputValue(), "formatted.json"));
  document.getElementById("btn-open-file").addEventListener("click", (e) => {
    e.preventDefault();
    if (els.file) {
      els.file.value = "";
      els.file.click();
    }
  });
  document.getElementById("btn-clear").addEventListener("click", () => {
    setInputValue("");
    lastPretty = "";
    lastValue = null;
    lastError = false;
    clearInputDecorations();
    els.extractOut.hidden = true;
    els.convertOut.hidden = true;
    showOutput();
    setBanner("", "");
    updateCaret();
    if (els.outputMeta) els.outputMeta.textContent = t("statusReady");
  });
  document.getElementById("tab-text").addEventListener("click", () => {
    outTab = "text";
    document.getElementById("tab-text").classList.add("is-active");
    document.getElementById("tab-tree").classList.remove("is-active");
    showOutput();
  });
  document.getElementById("tab-tree").addEventListener("click", () => {
    const cap = limits();
    if (byteLen(lastPretty) > cap.treeMax) {
      setBanner("", t("treeOff"));
      return;
    }
    outTab = "tree";
    document.getElementById("tab-tree").classList.add("is-active");
    document.getElementById("tab-text").classList.remove("is-active");
    if (lastValue != null) {
      els.outputTree.replaceChildren();
      renderTree(lastValue, "$", els.outputTree, 0);
    }
    showOutput();
  });
  document.getElementById("btn-extract").addEventListener("click", () => void act("query", { path: els.path.value }));
  document.getElementById("btn-copy-path").addEventListener("click", () => void copyText(els.path.value || lastPath));
  document.getElementById("path-chips").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-path]");
    if (!btn) return;
    els.path.value = btn.getAttribute("data-path") || "$";
    void act("query", { path: els.path.value });
  });
  document.getElementById("btn-ts").addEventListener("click", () => {
    try {
      els.convertOut.hidden = false;
      els.convertOut.textContent = toTypeScript(lastValue);
    } catch {
      toast(t("convertFail"));
    }
  });
  document.getElementById("btn-py").addEventListener("click", () => {
    try {
      if (lastValue === null) throw new Error("empty");
      els.convertOut.hidden = false;
      els.convertOut.textContent = toPython(lastValue);
    } catch {
      toast(t("convertFail"));
    }
  });
  document.getElementById("btn-copy-code").addEventListener("click", () => void copyText(els.convertOut.textContent));
  if (els.errorList) {
    els.errorList.addEventListener("click", (event) => {
      const li = event.target.closest("li");
      if (!li || !els.errorList.contains(li)) return;
      const pos = Number(li.dataset.pos);
      const end = Number(li.dataset.end);
      scrollToError(pos, end);
    });
  }
  if (els.inputBody && typeof ResizeObserver === "function") {
    let resizeTimer = 0;
    const ro = new ResizeObserver(() => {
      wrapColsCache = { key: "", cols: 0 };
      posMeasureCache = { key: "", text: "", result: null };
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (monacoInputEditor) monacoInputEditor.layout();
        if (monacoOutputEditor) monacoOutputEditor.layout();
        if (lastError && lastPaintIssues.length) paintInputErrors(lastPaintIssues, { keepScroll: true });
      }, 80);
    });
    ro.observe(els.inputBody);
  }
  els.input.addEventListener("keyup", updateCaret);
  els.input.addEventListener("click", updateCaret);
  els.input.addEventListener("scroll", syncInputDecor);
  els.input.addEventListener("input", () => {
    updateCaret();
    if (lastError) {
      lastError = false;
      clearInputDecorations();
      if (els.outputError) els.outputError.hidden = true;
      if (!lastPretty) {
        els.outputEmpty.hidden = false;
        if (els.outputMeta) els.outputMeta.textContent = t("statusReady");
      } else {
        showOutput();
      }
    }
  });
  const onDragOver = (event) => {
    event.preventDefault();
    els.dropzone.classList.add("is-dragover");
  };
  const onDragLeave = () => els.dropzone.classList.remove("is-dragover");
  const onDrop = (event) => {
    event.preventDefault();
    els.dropzone.classList.remove("is-dragover");
    const file = event.dataTransfer?.files?.[0];
    if (file) readFile(file);
  };
  els.dropzone.addEventListener("dragover", onDragOver);
  els.dropzone.addEventListener("dragleave", onDragLeave);
  els.dropzone.addEventListener("drop", onDrop);
  els.input.addEventListener("dragover", onDragOver);
  els.input.addEventListener("drop", onDrop);
  els.file.addEventListener("change", () => {
    readFile(els.file.files?.[0]);
    els.file.value = "";
  });
  void showAdSense("editorAboveWorkspace", "#editor-ad-above-path");
  void showAdSense("editorBelowExport", "#editor-ad-below-export");
  const splitAds = window.matchMedia("(min-width: 721px)");
  const loadSplitAds = () => {
    if (!splitAds.matches) return;
    void showAdSense("editorAboveWorkspace", "#editor-ad-above-path-2");
    void showAdSense("editorBelowExport", "#editor-ad-below-export-2");
  };
  loadSplitAds();
  if (typeof splitAds.addEventListener === "function") splitAds.addEventListener("change", loadSplitAds);
  else if (typeof splitAds.addListener === "function") splitAds.addListener(loadSplitAds);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
