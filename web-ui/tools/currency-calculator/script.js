import { showAdSense } from "../common/adsense.js?v=4";
import {
  CURRENCIES,
  detectCurrency,
  defaultAmount,
  defaultTargets,
  getCurrency,
  flagStackHtml,
  flagInlineHtml,
} from "./currencies.js?v=2";
import { LOCALES, applyI18n, detectLocale, getLocale, numberLocale, t } from "./i18n.js?v=2";

const STORE_KEY = "itz-currency-calculator-v1";
const RATES_KEY = "itz-currency-rates-usd-v2";
const RATES_TTL_MS = 5 * 60 * 1000;

const displayValue = document.getElementById("display-value");
const displayExpr = document.getElementById("display-expr");
const resultList = document.getElementById("result-list");
const rateMeta = document.getElementById("rate-meta");
const baseBtn = document.getElementById("btn-base");
const baseFlag = document.getElementById("base-flag");
const baseCodeEl = document.getElementById("base-code");
const baseNameEl = document.getElementById("base-name");
const picker = document.getElementById("currency-picker");
const pickerList = document.getElementById("picker-list");
const pickerSearch = document.getElementById("picker-search");
const pickerTitle = document.getElementById("picker-title");
const pickerCount = document.getElementById("picker-count");
const toastBox = document.getElementById("toast");

/** @type {{ base: string, amount: number, targets: string[], buffer: string, left: number | null, op: string | null, fresh: boolean }} */
const state = {
  base: "KRW",
  amount: 100000,
  targets: ["USD", "JPY", "EUR"],
  buffer: "100000",
  left: null,
  op: null,
  fresh: true,
};

/** @type {{ rates: Record<string, number>, fetchedAt: number, source: string } | null} */
let ratePack = null;
let pickerMode = "targets";
let toastTimer = 0;
/** @type {Set<string>} */
let draftCodes = new Set();

function showToast(message) {
  toastBox.hidden = false;
  toastBox.textContent = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastBox.hidden = true;
  }, 2800);
}

function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (!raw || typeof raw !== "object") return;
    if (typeof raw.base === "string" && getCurrency(raw.base)) state.base = raw.base;
    if (Array.isArray(raw.targets)) {
      state.targets = raw.targets.filter((c) => getCurrency(c) && c !== state.base);
    }
    if (typeof raw.amount === "number" && Number.isFinite(raw.amount)) {
      state.amount = raw.amount;
      state.buffer = formatBufferFromNumber(raw.amount);
    }
  } catch {
    /* ignore */
  }
}

function saveStore() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ base: state.base, amount: state.amount, targets: state.targets }),
    );
  } catch {
    /* ignore */
  }
}

function formatBufferFromNumber(n) {
  if (!Number.isFinite(n)) return "0";
  const s = String(n);
  if (s.includes("e")) return n.toFixed(8).replace(/\.?0+$/, "");
  return s;
}

/** @param {number} value @param {string} code */
function formatMoney(value, code) {
  const meta = getCurrency(code);
  const digits = meta ? meta.digits : 2;
  try {
    return new Intl.NumberFormat(numberLocale(), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return value.toFixed(digits);
  }
}

function sourceLabel(source) {
  if (source === "coinbase") return t("source.coinbase");
  if (source === "open.er-api.com") return t("source.erapi");
  if (source === "currency-api") return t("source.currencyapi");
  return t("source.public");
}

/** @param {number} value */
function formatRate(value) {
  if (!Number.isFinite(value)) return "—";
  const digits = value >= 100 ? 2 : value >= 1 ? 4 : value >= 0.01 ? 6 : 8;
  try {
    return new Intl.NumberFormat(numberLocale(), {
      minimumFractionDigits: 2,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return value.toFixed(digits);
  }
}

/** @param {string} code @param {"name" | "country"} field */
function currencyText(code, field) {
  return t(`cur.${code}.${field}`);
}

function currentInput() {
  const n = Number(state.buffer);
  return Number.isFinite(n) ? n : 0;
}

function syncAmountFromBuffer() {
  state.amount = currentInput();
}

function applyOp(left, op, right) {
  if (op === "+") return left + right;
  if (op === "-") return left - right;
  if (op === "*") return left * right;
  if (op === "/") return right === 0 ? NaN : left / right;
  return right;
}

function press(key) {
  if (key >= "0" && key <= "9") {
    if (state.fresh) {
      state.buffer = key === "0" ? "0" : key;
      state.fresh = false;
    } else if (state.buffer === "0") {
      state.buffer = key;
    } else if (state.buffer.replace(".", "").length < 14) {
      state.buffer += key;
    }
    syncAmountFromBuffer();
    render();
    return;
  }

  if (key === ".") {
    if (state.fresh) {
      state.buffer = "0.";
      state.fresh = false;
    } else if (!state.buffer.includes(".")) {
      state.buffer += ".";
    }
    render();
    return;
  }

  if (key === "Backspace") {
    if (state.fresh) return;
    state.buffer = state.buffer.slice(0, -1) || "0";
    if (state.buffer === "-" || state.buffer === "-0") state.buffer = "0";
    syncAmountFromBuffer();
    render();
    return;
  }

  if (key === "C") {
    state.buffer = "0";
    state.amount = 0;
    state.left = null;
    state.op = null;
    state.fresh = true;
    render();
    saveStore();
    return;
  }

  if (key === "+" || key === "-" || key === "*" || key === "/") {
    const right = currentInput();
    if (state.left != null && state.op && !state.fresh) {
      const next = applyOp(state.left, state.op, right);
      if (!Number.isFinite(next)) {
        showToast(t("divZero"));
        return;
      }
      state.left = next;
      state.buffer = formatBufferFromNumber(next);
      state.amount = next;
    } else {
      state.left = right;
    }
    state.op = key;
    state.fresh = true;
    render();
    return;
  }

  if (key === "=") {
    if (state.left == null || !state.op) {
      syncAmountFromBuffer();
      state.fresh = true;
      render();
      saveStore();
      return;
    }
    const next = applyOp(state.left, state.op, currentInput());
    if (!Number.isFinite(next)) {
      showToast(t("divZero"));
      return;
    }
    state.amount = next;
    state.buffer = formatBufferFromNumber(next);
    state.left = null;
    state.op = null;
    state.fresh = true;
    render();
    saveStore();
  }
}

function opLabel(op) {
  return { "+": "+", "-": "−", "*": "×", "/": "÷" }[op] || op;
}

function convert(amount, from, to) {
  if (!ratePack) return null;
  const a = ratePack.rates[from];
  const b = ratePack.rates[to];
  if (!a || !b) return null;
  return amount * (b / a);
}

function inverseRate(from, to) {
  const one = convert(1, from, to);
  return one;
}

function setBase(code, keepAmountInNewCurrency) {
  const next = String(code || "").toUpperCase();
  if (!getCurrency(next) || next === state.base) return;
  if (keepAmountInNewCurrency) {
    const converted = convert(state.amount, state.base, next);
    if (converted != null) {
      state.amount = converted;
      state.buffer = formatBufferFromNumber(converted);
    }
  }
  state.targets = state.targets.filter((c) => c !== next);
  if (!state.targets.includes(state.base) && getCurrency(state.base)) {
    state.targets.unshift(state.base);
  }
  state.base = next;
  state.left = null;
  state.op = null;
  state.fresh = true;
  render();
  saveStore();
}

function renderBase() {
  const meta = getCurrency(state.base);
  baseFlag.innerHTML = flagStackHtml(meta);
  baseCodeEl.textContent = state.base;
  baseNameEl.textContent = meta ? currencyText(state.base, "name") : state.base;
}

function renderDisplay() {
  displayValue.textContent = formatMoney(currentInput(), state.base);
  if (state.left != null && state.op) {
    displayExpr.textContent = `${formatMoney(state.left, state.base)} ${opLabel(state.op)}`;
  } else {
    displayExpr.textContent = "";
  }
}

function renderResults() {
  if (!ratePack) {
    resultList.innerHTML = `<p class="fx-empty">${t("loading")}</p>`;
    return;
  }
  const rows = state.targets.filter((c) => c !== state.base && getCurrency(c) && ratePack.rates[c]);
  if (!rows.length) {
    resultList.innerHTML = `<p class="fx-empty">${t("emptyAdd")}</p>`;
    return;
  }
  resultList.innerHTML = rows
    .map((code) => {
      const meta = getCurrency(code);
      const value = convert(state.amount, state.base, code);
      const inv = inverseRate(state.base, code);
      const amount = value == null ? "—" : formatMoney(value, code);
      const invText = inv == null ? "" : `1 ${state.base} = ${formatRate(inv)} ${code}`;
      const name = currencyText(code, "name");
      const country = currencyText(code, "country");
      return `<article class="fx-card" data-code="${code}">
        ${flagStackHtml(meta, "fx-card-flag")}
        <span class="fx-card-name">
          <strong>${name} (${code})</strong>
          <span>${country}</span>
        </span>
        <span class="fx-card-amount">
          <strong>${amount} ${code}</strong>
          <span>${invText}</span>
        </span>
        <button type="button" class="fx-card-remove" data-remove="${code}" aria-label="${t("remove", { code })}">×</button>
      </article>`;
    })
    .join("");
}

function renderMeta() {
  if (!ratePack) {
    rateMeta.textContent = t("loading");
    return;
  }
  const when = new Date(ratePack.fetchedAt);
  const stamp = Number.isNaN(when.getTime())
    ? ""
    : when.toLocaleString(numberLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const usdKrw = ratePack.rates.KRW;
  const krwText =
    typeof usdKrw === "number" && Number.isFinite(usdKrw) ? t("meta.usdKrw", { n: formatRate(usdKrw) }) : "";
  const parts = [t("meta.basis", { source: sourceLabel(ratePack.source) }), t("meta.cross")];
  if (krwText) parts.push(krwText);
  if (stamp) parts.push(stamp);
  rateMeta.textContent = parts.join(" · ");
}

function render() {
  renderBase();
  renderDisplay();
  renderResults();
  renderMeta();
}

function lockShellHeight() {
  const main = document.getElementById("fx-main");
  const calc = document.querySelector(".fx-calc");
  if (!main || !calc) return;
  if (picker) {
    picker.style.top = "";
    picker.style.left = "";
    picker.style.width = "";
    picker.style.height = "";
  }
  main.style.removeProperty("--fx-shell-h");
  calc.style.height = "auto";
  calc.style.alignSelf = "start";
  const calcH = Math.ceil(calc.getBoundingClientRect().height);
  calc.style.height = "";
  calc.style.alignSelf = "";
  const narrow = window.matchMedia("(max-width: 900px)").matches;
  const extra = narrow ? Math.max(200, Math.min(280, Math.round(window.innerHeight * 0.34))) : 0;
  main.style.setProperty("--fx-shell-h", `${Math.max(280, calcH + extra)}px`);
}

function onPickerViewport() {
  lockShellHeight();
}

function openPicker(mode) {
  pickerMode = mode;
  pickerTitle.textContent = mode === "base" ? t("pickerBase") : t("pickerAdd");
  draftCodes = new Set(mode === "base" ? [state.base] : state.targets);
  pickerSearch.value = "";
  fillPicker();
  lockShellHeight();
  picker.hidden = false;
  document.body.classList.add("is-picker-open");
  window.addEventListener("resize", onPickerViewport);
  window.setTimeout(() => pickerSearch.focus(), 40);
}

function closePicker() {
  picker.hidden = true;
  document.body.classList.remove("is-picker-open");
  window.removeEventListener("resize", onPickerViewport);
}

function pickerCountLabel() {
  return pickerMode === "base" ? t("pickOne") : t("picked", { n: draftCodes.size });
}

function fillPicker() {
  const q = pickerSearch.value.trim().toLowerCase();
  const items = CURRENCIES.filter((c) => {
    if (!q) return true;
    const name = currencyText(c.code, "name");
    const country = currencyText(c.code, "country");
    return `${c.code} ${c.name} ${c.country} ${name} ${country}`.toLowerCase().includes(q);
  });
  pickerList.innerHTML = items
    .map((c) => {
      const checked = draftCodes.has(c.code) ? "checked" : "";
      const disabled = pickerMode === "targets" && c.code === state.base ? "disabled" : "";
      const name = currencyText(c.code, "name");
      const country = currencyText(c.code, "country");
      return `<label class="picker-item">
        <input type="${pickerMode === "base" ? "radio" : "checkbox"}" name="fx-pick" value="${c.code}" ${checked} ${disabled}>
        ${flagInlineHtml(c)}
        <span>${name}<small>${country} · ${c.code}</small></span>
      </label>`;
    })
    .join("");
  pickerCount.textContent = pickerCountLabel();
}

function applyPicker() {
  if (pickerMode === "base") {
    const next = [...draftCodes][0];
    if (next) setBase(next, false);
  } else {
    state.targets = CURRENCIES.map((c) => c.code).filter((c) => draftCodes.has(c) && c !== state.base);
    saveStore();
    render();
  }
  closePicker();
}

/** @param {Record<string, unknown>} raw */
function normalizeUsdRates(raw) {
  /** @type {Record<string, number>} */
  const rates = { USD: 1 };
  for (const [key, value] of Object.entries(raw)) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) rates[key.toUpperCase()] = n;
  }
  return rates;
}

async function fetchRates() {
  try {
    const cached = JSON.parse(localStorage.getItem(RATES_KEY) || "null");
    if (cached && cached.rates && Date.now() - cached.fetchedAt < RATES_TTL_MS) {
      ratePack = cached;
      render();
    }
  } catch {
    /* ignore */
  }

  const apply = (rates, source, fetchedAt) => {
    const packed = {
      rates: normalizeUsdRates(rates),
      fetchedAt: fetchedAt || Date.now(),
      source,
    };
    if (!packed.rates.KRW) return false;
    ratePack = packed;
    try {
      localStorage.setItem(RATES_KEY, JSON.stringify(packed));
    } catch {
      /* ignore */
    }
    render();
    return true;
  };

  try {
    const res = await fetch("https://api.coinbase.com/v2/exchange-rates?currency=USD");
    const json = await res.json();
    const raw = json && json.data && json.data.rates;
    if (raw && apply(raw, "coinbase")) return;
  } catch {
    /* fallback */
  }

  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    const json = await res.json();
    if (json && json.result === "success" && json.rates) {
      const at = Number(json.time_last_update_unix) * 1000;
      if (apply(json.rates, "open.er-api.com", Number.isFinite(at) ? at : Date.now())) return;
    }
  } catch {
    /* fallback */
  }

  try {
    const res = await fetch("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json");
    const json = await res.json();
    const usd = json && json.usd;
    if (usd && typeof usd === "object" && apply(usd, "currency-api")) return;
  } catch {
    /* ignore */
  }

  if (!ratePack) {
    rateMeta.textContent = t("rateFail");
    showToast(t("toastFail"));
  }
}

function bootState() {
  const detected = detectCurrency();
  state.base = detected;
  state.targets = defaultTargets(detected);
  state.amount = defaultAmount(detected);
  state.buffer = formatBufferFromNumber(state.amount);
  loadStore();
  if (!getCurrency(state.base)) {
    state.base = detected;
  }
  if (!state.targets.length) state.targets = defaultTargets(state.base);
}

document.getElementById("fx-pad").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-key]");
  if (!btn) return;
  press(btn.getAttribute("data-key") || "");
});

window.addEventListener("keydown", (e) => {
  if (document.body.classList.contains("is-picker-open")) {
    if (e.key === "Escape") closePicker();
    return;
  }
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key >= "0" && e.key <= "9") press(e.key);
  else if (e.key === ".") press(".");
  else if (e.key === "Backspace") {
    e.preventDefault();
    press("Backspace");
  } else if (e.key === "Escape") press("C");
  else if (e.key === "Enter" || e.key === "=") {
    e.preventDefault();
    press("=");
  } else if (e.key === "+" || e.key === "-" || e.key === "*" || e.key === "/") press(e.key);
});

baseBtn.addEventListener("click", () => openPicker("base"));
document.getElementById("btn-add").addEventListener("click", () => openPicker("targets"));
document.getElementById("picker-close").addEventListener("click", closePicker);
document.getElementById("picker-done").addEventListener("click", applyPicker);
pickerSearch.addEventListener("input", fillPicker);

pickerList.addEventListener("change", (e) => {
  const input = e.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (pickerMode === "base") {
    draftCodes = new Set([input.value]);
  } else if (input.checked) {
    draftCodes.add(input.value);
  } else {
    draftCodes.delete(input.value);
  }
  pickerCount.textContent = pickerCountLabel();
});

resultList.addEventListener("click", (e) => {
  const remove = e.target.closest("[data-remove]");
  if (remove) {
    e.stopPropagation();
    const code = remove.getAttribute("data-remove");
    state.targets = state.targets.filter((c) => c !== code);
    saveStore();
    render();
    return;
  }
  const card = e.target.closest(".fx-card");
  if (!card) return;
  const code = card.getAttribute("data-code");
  if (code) setBase(code, true);
});

document.addEventListener("click", (e) => {
  if (!document.body.classList.contains("is-picker-open")) return;
  if (e.target === document.body) closePicker();
});

function bindLang() {
  const lang = document.getElementById("lang-select");
  if (!(lang instanceof HTMLSelectElement)) return;
  lang.replaceChildren();
  for (const item of LOCALES) {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = item.label;
    lang.append(opt);
  }
  lang.value = getLocale();
  lang.addEventListener("change", () => {
    applyI18n(lang.value);
    render();
    lockShellHeight();
    if (!picker.hidden) {
      pickerTitle.textContent = pickerMode === "base" ? t("pickerBase") : t("pickerAdd");
      fillPicker();
    }
  });
}

bootState();
applyI18n(detectLocale());
bindLang();
document.addEventListener("itz:lang-change", (ev) => {
  const lang = ev && ev.detail && ev.detail.lang;
    if (lang) {
    applyI18n(lang);
    render();
    if (!picker.hidden) {
      pickerTitle.textContent = pickerMode === "base" ? t("pickerBase") : t("pickerAdd");
      fillPicker();
    }
  }
});
render();
lockShellHeight();
window.addEventListener("resize", lockShellHeight);
void fetchRates();
void showAdSense("editorAboveWorkspace", "#editor-ad-above-path");
void showAdSense("editorBelowExport", "#editor-ad-below-export");
