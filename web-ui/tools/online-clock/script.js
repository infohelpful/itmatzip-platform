import { showAdSense } from "../common/adsense.js?v=4";
import {
  LOCALE_OPTIONS,
  applyI18n,
  detectLocale,
  getLocale,
  setLocale,
  t,
} from "./i18n.js?v=2";

const STORE_KEY = "itmatzip-online-clock-v1";
const MODES = ["clock", "alarm", "timer", "stopwatch"];
const COLORS = ["cyan", "amber", "rose", "lime", "violet", "snow"];
const COLOR_HEX = {
  cyan: "#22d3ee",
  amber: "#fbbf24",
  rose: "#fb7185",
  lime: "#a3e635",
  violet: "#a78bfa",
  snow: "#f8fafc",
};
const SOUNDS = ["chime", "beep", "bell", "digital", "soft"];
const CITIES = [
  { id: "seoul", tz: "Asia/Seoul" },
  { id: "tokyo", tz: "Asia/Tokyo" },
  { id: "beijing", tz: "Asia/Shanghai" },
  { id: "hongkong", tz: "Asia/Hong_Kong" },
  { id: "taipei", tz: "Asia/Taipei" },
  { id: "singapore", tz: "Asia/Singapore" },
  { id: "bangkok", tz: "Asia/Bangkok" },
  { id: "dubai", tz: "Asia/Dubai" },
  { id: "mumbai", tz: "Asia/Kolkata" },
  { id: "sydney", tz: "Australia/Sydney" },
  { id: "london", tz: "Europe/London" },
  { id: "paris", tz: "Europe/Paris" },
  { id: "berlin", tz: "Europe/Berlin" },
  { id: "moscow", tz: "Europe/Moscow" },
  { id: "newyork", tz: "America/New_York" },
  { id: "chicago", tz: "America/Chicago" },
  { id: "losangeles", tz: "America/Los_Angeles" },
  { id: "toronto", tz: "America/Toronto" },
  { id: "saopaulo", tz: "America/Sao_Paulo" },
  { id: "utc", tz: "UTC" },
];
const TIMER_PRESETS = [
  { sec: 60, label: "1" },
  { sec: 180, label: "3" },
  { sec: 300, label: "5" },
  { sec: 600, label: "10" },
  { sec: 900, label: "15" },
  { sec: 1500, label: "25" },
  { sec: 1800, label: "30" },
  { sec: 3600, label: "60" },
];
const RING_LEN = 2 * Math.PI * 96;

/** @typedef {{
 *  hour12: boolean,
 *  showSeconds: boolean,
 *  showAnalog: boolean,
 *  color: string,
 *  cities: string[],
 *  alarms: Alarm[],
 *  volume: number,
 *  timer: { h: number, m: number, s: number, durationMs: number, remainMs: number, running: boolean, endsAt: number, loop: boolean },
 *  stopwatch: { baseMs: number, running: boolean, startedAt: number, laps: number[] }
 * }} Settings */

/** @typedef {{
 *  id: string,
 *  time: string,
 *  label: string,
 *  enabled: boolean,
 *  repeat: "once" | "daily" | "weekdays" | "weekend" | "custom",
 *  days: number[],
 *  sound: string,
 *  snoozeMin: number,
 *  lastFired: string
 * }} Alarm */

/** @type {Settings} */
let settings;
/** @type {string} */
let mode = "clock";
/** @type {AudioContext | null} */
let audioCtx = null;
/** @type {number} */
let alarmLoopTimer = 0;
/** @type {boolean} */
let alertOpen = false;
/** @type {Alarm | null} */
let ringingAlarm = null;
/** @type {"alarm" | "timer" | null} */
let alertKind = null;
let toastTimer = 0;
let titleBase = "";
let titleFlash = 0;
/** @type {WakeLockSentinel | null} */
let wakeLock = null;
let swRaf = 0;

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pad(n, w = 2) {
  return String(Math.max(0, Math.floor(n))).padStart(w, "0");
}

function defaultSettings() {
  /** @type {Settings} */
  const next = {
    hour12: false,
    showSeconds: true,
    showAnalog: true,
    color: "cyan",
    cities: ["tokyo", "newyork", "london"],
    alarms: [],
    volume: 80,
    timer: {
      h: 0,
      m: 5,
      s: 0,
      durationMs: 5 * 60 * 1000,
      remainMs: 5 * 60 * 1000,
      running: false,
      endsAt: 0,
      loop: false,
    },
    stopwatch: { baseMs: 0, running: false, startedAt: 0, laps: [] },
  };
  return next;
}

function loadSettings() {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    return {
      ...base,
      ...parsed,
      timer: { ...base.timer, ...(parsed.timer || {}) },
      stopwatch: { ...base.stopwatch, ...(parsed.stopwatch || {}) },
      alarms: Array.isArray(parsed.alarms) ? parsed.alarms : [],
      cities: Array.isArray(parsed.cities) ? parsed.cities : base.cities,
    };
  } catch {
    return base;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {
    /* quota */
  }
}

function showToast(message) {
  const box = document.getElementById("toast");
  if (!box) return;
  box.hidden = false;
  box.textContent = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    box.hidden = true;
  }, 2800);
}

function localeTag() {
  return { ko: "ko-KR", en: "en-US", ja: "ja-JP", zh: "zh-CN" }[getLocale()] || "ko-KR";
}

function cityById(id) {
  return CITIES.find((c) => c.id === id);
}

function formatTime(date, timeZone, withSeconds = settings.showSeconds) {
  return new Intl.DateTimeFormat(localeTag(), {
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
    hour12: settings.hour12,
    timeZone,
  }).format(date);
}

function formatDate(date, timeZone) {
  return new Intl.DateTimeFormat(localeTag(), {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone,
  }).format(date);
}

function zoneOffsetLabel(timeZone, date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
  });
  const part = fmt.formatToParts(date).find((p) => p.type === "timeZoneName");
  return part?.value || timeZone;
}

function tzOffsetMinutes(timeZone, date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

function zoneDiffMinutes(tz, date) {
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tzOffsetMinutes(tz, date) - tzOffsetMinutes(localTz, date);
}

function formatOffset(mins) {
  if (!mins) return t("clock.sameZone");
  const sign = mins > 0 ? "+" : "−";
  const abs = Math.abs(mins);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${t("clock.offset")} ${sign}${h}${m ? `:${pad(m)}` : ""}h`;
}

function applyColor() {
  const hex = COLOR_HEX[settings.color] || COLOR_HEX.cyan;
  document.documentElement.style.setProperty("--clock-color", hex);
  document.documentElement.style.setProperty("--accent", hex);
  document.documentElement.style.setProperty("--accent-soft", hex);
  document.documentElement.style.setProperty("--accent-glow", hex + "48");
  document.documentElement.style.setProperty("--accent-dim", hex + "29");
}

function buildAnalogTicks() {
  const g = document.getElementById("analog-ticks");
  if (!g || g.childElementCount) return;
  for (let i = 0; i < 60; i += 1) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    const hour = i % 5 === 0;
    const inner = hour ? 78 : 86;
    const outer = 92;
    const a = (Math.PI * 2 * i) / 60 - Math.PI / 2;
    line.setAttribute("x1", String(100 + Math.cos(a) * inner));
    line.setAttribute("y1", String(100 + Math.sin(a) * inner));
    line.setAttribute("x2", String(100 + Math.cos(a) * outer));
    line.setAttribute("y2", String(100 + Math.sin(a) * outer));
    line.setAttribute("class", hour ? "analog-tick is-hour" : "analog-tick");
    g.appendChild(line);
  }
}

function setHand(id, deg) {
  const el = document.getElementById(id);
  if (el) el.setAttribute("transform", `translate(100 100) rotate(${deg})`);
}

let lastWorldKey = "";

function updateClock() {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeEl = document.getElementById("digital-time");
  const dateEl = document.getElementById("digital-date");
  const zoneEl = document.getElementById("digital-zone");
  if (timeEl) timeEl.textContent = formatTime(now, tz);
  if (dateEl) dateEl.textContent = formatDate(now, tz);
  if (zoneEl) zoneEl.textContent = `${t("clock.local")} · ${tz} · ${zoneOffsetLabel(tz, now)}`;

  const ms = now.getMilliseconds();
  const s = now.getSeconds() + ms / 1000;
  const m = now.getMinutes() + s / 60;
  const h = (now.getHours() % 12) + m / 60;
  setHand("hand-second", s * 6);
  setHand("hand-minute", m * 6);
  setHand("hand-hour", h * 30);

  document.getElementById("analog-wrap")?.toggleAttribute("hidden", !settings.showAnalog);
  const worldKey = `${settings.cities.join(",")}|${formatTime(now, tz)}`;
  if (worldKey !== lastWorldKey) {
    lastWorldKey = worldKey;
    renderWorld(now);
  }
}

function renderWorld(now) {
  const grid = document.getElementById("world-grid");
  if (!grid) return;
  grid.replaceChildren();
  for (const id of settings.cities) {
    const city = cityById(id);
    if (!city) continue;
    const card = document.createElement("article");
    card.className = "world-card";
    const name = document.createElement("span");
    name.className = "world-name";
    name.textContent = t(`city.${city.id}`);
    const time = document.createElement("div");
    time.className = "world-time";
    time.textContent = formatTime(now, city.tz);
    const meta = document.createElement("div");
    meta.className = "world-meta";
    meta.textContent = `${formatOffset(zoneDiffMinutes(city.tz, now))} · ${zoneOffsetLabel(city.tz, now)}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "world-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", t("clock.removeCity"));
    remove.addEventListener("click", () => {
      settings.cities = settings.cities.filter((c) => c !== id);
      lastWorldKey = "";
      saveSettings();
      fillCitySelect();
      renderWorld(new Date());
    });
    card.append(name, time, meta, remove);
    grid.appendChild(card);
  }
}

function fillCitySelect() {
  const sel = document.getElementById("city-select");
  if (!(sel instanceof HTMLSelectElement)) return;
  sel.replaceChildren();
  for (const city of CITIES) {
    if (settings.cities.includes(city.id)) continue;
    const opt = document.createElement("option");
    opt.value = city.id;
    opt.textContent = t(`city.${city.id}`);
    sel.appendChild(opt);
  }
  sel.disabled = sel.options.length === 0;
}

function fillSelect(el, items, selected, labelFn) {
  if (!(el instanceof HTMLSelectElement)) return;
  el.replaceChildren();
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = String(item);
    opt.textContent = labelFn(item);
    if (String(item) === String(selected)) opt.selected = true;
    el.appendChild(opt);
  }
}

function fillStaticSelects() {
  fillSelect(document.getElementById("clock-color"), COLORS, settings.color, (c) => t(`color.${c}`));
  fillSelect(
    document.getElementById("alarm-repeat"),
    ["once", "daily", "weekdays", "weekend", "custom"],
    "once",
    (v) => t(`alarm.${v}`),
  );
  fillSelect(document.getElementById("alarm-sound"), SOUNDS, "chime", (v) => t(`sound.${v}`));
  fillSelect(document.getElementById("alarm-snooze"), [5, 10], 5, (v) => t(`min.${v}`));
  const lang = document.getElementById("lang-select");
  if (lang instanceof HTMLSelectElement) {
    lang.replaceChildren();
    for (const opt of LOCALE_OPTIONS) {
      const node = document.createElement("option");
      node.value = opt.id;
      node.textContent = opt.native;
      if (opt.id === getLocale()) node.selected = true;
      lang.appendChild(node);
    }
  }
}

function fillDayPills() {
  const wrap = document.getElementById("alarm-days");
  if (!wrap) return;
  wrap.replaceChildren();
  for (let d = 0; d < 7; d += 1) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "day-pill";
    btn.dataset.day = String(d);
    btn.textContent = t(`day.${d}`);
    btn.addEventListener("click", () => btn.classList.toggle("is-on"));
    wrap.appendChild(btn);
  }
}

function selectedDays() {
  return [...document.querySelectorAll("#alarm-days .day-pill.is-on")].map((el) => Number(el.dataset.day));
}

function repeatLabel(alarm) {
  if (alarm.repeat === "custom") {
    return (alarm.days || []).map((d) => t(`day.${d}`)).join(" ");
  }
  return t(`alarm.${alarm.repeat}`);
}

function renderAlarms() {
  const list = document.getElementById("alarm-list");
  if (!list) return;
  list.replaceChildren();
  if (!settings.alarms.length) {
    const empty = document.createElement("p");
    empty.className = "empty-card";
    empty.textContent = t("alarm.empty");
    list.appendChild(empty);
    return;
  }
  const sorted = [...settings.alarms].sort((a, b) => a.time.localeCompare(b.time));
  for (const alarm of sorted) {
    const card = document.createElement("article");
    card.className = "alarm-card" + (alarm.enabled ? "" : " is-off");
    const time = document.createElement("div");
    time.className = "alarm-time";
    time.textContent = formatAlarmClock(alarm.time);
    const body = document.createElement("div");
    const name = document.createElement("p");
    name.className = "alarm-name";
    name.textContent = alarm.label || t("nav.alarm");
    const meta = document.createElement("p");
    meta.className = "alarm-meta";
    meta.textContent = `${repeatLabel(alarm)} · ${t(`sound.${alarm.sound}`)}`;
    body.append(name, meta);
    const actions = document.createElement("div");
    actions.className = "alarm-actions";
    const sw = document.createElement("label");
    sw.className = "switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = alarm.enabled;
    input.addEventListener("change", () => {
      alarm.enabled = input.checked;
      saveSettings();
      renderAlarms();
      void syncWakeLock();
    });
    const knob = document.createElement("span");
    sw.append(input, knob);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn";
    del.textContent = "×";
    del.setAttribute("aria-label", t("alarm.delete"));
    del.addEventListener("click", () => {
      settings.alarms = settings.alarms.filter((a) => a.id !== alarm.id);
      saveSettings();
      renderAlarms();
    });
    actions.append(sw, del);
    card.append(time, body, actions);
    list.appendChild(card);
  }
}

function formatAlarmClock(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return new Intl.DateTimeFormat(localeTag(), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: settings.hour12,
  }).format(d);
}

function todayStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function alarmMatchesNow(alarm, date) {
  if (!alarm.enabled) return false;
  const [h, m] = alarm.time.split(":").map(Number);
  if (date.getHours() !== h || date.getMinutes() !== m) return false;
  const day = date.getDay();
  if (alarm.repeat === "once" || alarm.repeat === "daily") return true;
  if (alarm.repeat === "weekdays") return day >= 1 && day <= 5;
  if (alarm.repeat === "weekend") return day === 0 || day === 6;
  return (alarm.days || []).includes(day);
}

function checkAlarms() {
  if (alertOpen) return;
  const now = new Date();
  const stamp = todayStamp(now);
  for (const alarm of settings.alarms) {
    if (!alarmMatchesNow(alarm, now)) continue;
    if (alarm.lastFired === stamp) continue;
    alarm.lastFired = stamp;
    if (alarm.repeat === "once") alarm.enabled = false;
    saveSettings();
    renderAlarms();
    openAlert("alarm", alarm.label || t("nav.alarm"), formatAlarmClock(alarm.time), alarm);
    return;
  }
}

function unlockAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return Promise.resolve(null);
    audioCtx = new Ctx();
  }
  if (audioCtx.state === "suspended") {
    return audioCtx.resume().then(() => (audioCtx && audioCtx.state === "running" ? audioCtx : null));
  }
  return Promise.resolve(audioCtx.state === "running" ? audioCtx : null);
}

/** @type {GainNode | null} */
let masterGain = null;
/** @type {Array<{ osc: OscillatorNode, gain: GainNode }>} */
let previewVoices = [];
let previewStopTimer = 0;
let testBtnTimer = 0;

function getMasterGain(ctx) {
  if (!masterGain || masterGain.context !== ctx) {
    masterGain = ctx.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(ctx.destination);
  }
  return masterGain;
}

function stopPreview() {
  window.clearTimeout(previewStopTimer);
  previewStopTimer = 0;
  const ctx = audioCtx;
  const now = ctx && ctx.state === "running" ? ctx.currentTime : 0;
  for (const voice of previewVoices) {
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(0, now);
      voice.osc.stop(now);
    } catch {
      /* already stopped */
    }
    try {
      voice.osc.disconnect();
      voice.gain.disconnect();
    } catch {
      /* ignore */
    }
  }
  previewVoices = [];
}

function silenceIfIdle() {
  stopPreview();
  if (alertOpen || alarmLoopTimer) return;
  if (audioCtx && audioCtx.state === "running") void audioCtx.suspend();
}

function markTestPlaying() {
  const btn = document.getElementById("btn-test-sound");
  if (!btn) return;
  btn.classList.add("is-playing");
  window.clearTimeout(testBtnTimer);
  testBtnTimer = window.setTimeout(() => btn.classList.remove("is-playing"), 900);
}

function playPattern(name, volume = settings.volume / 100) {
  return unlockAudio().then((ctx) => {
    if (!ctx) return;
    stopPreview();
    const now = ctx.currentTime;
    const seq = {
      chime: [
        [784, 0, 0.22],
        [1046, 0.18, 0.28],
        [1318, 0.38, 0.45],
      ],
      beep: [
        [880, 0, 0.18],
        [880, 0.24, 0.18],
        [880, 0.48, 0.18],
      ],
      bell: [
        [523, 0, 0.55],
        [659, 0.04, 0.5],
        [784, 0.08, 0.45],
      ],
      digital: [
        [1400, 0, 0.1],
        [980, 0.12, 0.1],
        [1400, 0.24, 0.1],
        [980, 0.36, 0.12],
      ],
      soft: [
        [392, 0, 0.45],
        [494, 0.1, 0.5],
      ],
    }[name] || seqFallback();

    const peak = 0.45 + Math.max(0, Math.min(1, volume)) * 0.5;
    const dest = getMasterGain(ctx);
    let longest = 0;
    for (const [freq, start, dur] of seq) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = name === "digital" || name === "beep" ? "square" : "triangle";
      osc.frequency.value = freq;
      const t0 = now + start;
      const t1 = t0 + Math.max(0.08, dur);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(peak, t0 + 0.018);
      gain.gain.linearRampToValueAtTime(0.0001, t1);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(t0);
      osc.stop(t1 + 0.03);
      previewVoices.push({ osc, gain });
      longest = Math.max(longest, start + dur);
    }
    previewStopTimer = window.setTimeout(() => {
      stopPreview();
      if (!alertOpen && !alarmLoopTimer) silenceIfIdle();
    }, Math.ceil((longest + 0.12) * 1000));
  });
}

function seqFallback() {
  return [[880, 0, 0.2]];
}

function startAlarmLoop(sound) {
  stopAlarmLoop();
  void playPattern(sound);
  alarmLoopTimer = window.setInterval(() => {
    void playPattern(sound);
  }, 1400);
}

function stopAlarmLoop() {
  window.clearInterval(alarmLoopTimer);
  alarmLoopTimer = 0;
  stopPreview();
  if (!alertOpen && audioCtx && audioCtx.state === "running") void audioCtx.suspend();
}

function flashTitle(label) {
  window.clearInterval(titleFlash);
  let on = false;
  titleFlash = window.setInterval(() => {
    on = !on;
    document.title = on ? `● ${label}` : titleBase;
  }, 700);
}

function openAlert(kind, title, sub, alarm = null) {
  alertKind = kind;
  ringingAlarm = alarm;
  alertOpen = true;
  const overlay = document.getElementById("alert-overlay");
  const kindEl = document.getElementById("alert-kind");
  const titleEl = document.getElementById("alert-title");
  const subEl = document.getElementById("alert-sub");
  const snoozeBtn = document.getElementById("btn-alert-snooze");
  if (overlay) overlay.hidden = false;
  if (kindEl) kindEl.textContent = kind === "timer" ? t("timer.done") : t("alarm.ringing");
  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = sub;
  if (snoozeBtn) snoozeBtn.hidden = kind !== "alarm";
  startAlarmLoop(alarm?.sound || "chime");
  flashTitle(title);
  notify(title, sub);
}

function closeAlert() {
  alertOpen = false;
  ringingAlarm = null;
  alertKind = null;
  const overlay = document.getElementById("alert-overlay");
  if (overlay) overlay.hidden = true;
  stopAlarmLoop();
  window.clearInterval(titleFlash);
  document.title = titleBase;
}

function snoozeRinging() {
  if (!ringingAlarm) {
    closeAlert();
    return;
  }
  const mins = ringingAlarm.snoozeMin || 5;
  const when = new Date(Date.now() + mins * 60 * 1000);
  settings.alarms.push({
    id: uid(),
    time: `${pad(when.getHours())}:${pad(when.getMinutes())}`,
    label: ringingAlarm.label || t("alarm.snooze"),
    enabled: true,
    repeat: "once",
    days: [],
    sound: ringingAlarm.sound,
    snoozeMin: mins,
    lastFired: "",
  });
  saveSettings();
  renderAlarms();
  closeAlert();
  showToast(`${t("alarm.snooze")} ${mins}m`);
}

function notify(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, silent: true });
  } catch {
    /* ignore */
  }
}

async function requestNotify() {
  if (!("Notification" in window)) return;
  const perm = await Notification.requestPermission();
  showToast(perm === "granted" ? t("alarm.saved") : t("alarm.notify"));
}

function addAlarm() {
  const timeEl = document.getElementById("alarm-time");
  const labelEl = document.getElementById("alarm-label");
  const repeatEl = document.getElementById("alarm-repeat");
  const soundEl = document.getElementById("alarm-sound");
  const snoozeEl = document.getElementById("alarm-snooze");
  const time = timeEl instanceof HTMLInputElement ? timeEl.value : "";
  if (!time) {
    showToast(t("alarm.needTime"));
    return;
  }
  const repeat = repeatEl instanceof HTMLSelectElement ? repeatEl.value : "once";
  settings.alarms.push({
    id: uid(),
    time,
    label: labelEl instanceof HTMLInputElement ? labelEl.value.trim() : "",
    enabled: true,
    repeat: /** @type {Alarm["repeat"]} */ (
      repeat === "custom" && selectedDays().length === 0 ? "once" : repeat
    ),
    days: repeat === "custom" ? selectedDays() : [],
    sound: soundEl instanceof HTMLSelectElement ? soundEl.value : "chime",
    snoozeMin: snoozeEl instanceof HTMLSelectElement ? Number(snoozeEl.value) : 5,
    lastFired: "",
  });
  saveSettings();
  renderAlarms();
  showToast(t("alarm.saved"));
  void requestNotifyQuiet();
  void syncWakeLock();
}

async function requestNotifyQuiet() {
  if (!("Notification" in window) || Notification.permission !== "default") return;
  await Notification.requestPermission();
}

function timerPartsFromMs(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return { h, m, s, text: `${pad(h)}:${pad(m)}:${pad(s)}` };
}

function readTimerInputs() {
  const h = clampNum(document.getElementById("timer-h"), 0, 99);
  const m = clampNum(document.getElementById("timer-m"), 0, 59);
  const s = clampNum(document.getElementById("timer-s"), 0, 59);
  return { h, m, s, ms: ((h * 60 + m) * 60 + s) * 1000 };
}

function clampNum(el, min, max) {
  if (!(el instanceof HTMLInputElement)) return min;
  const n = Math.min(max, Math.max(min, Number(el.value) || 0));
  el.value = String(n);
  return n;
}

function writeTimerInputs(h, m, s) {
  const he = document.getElementById("timer-h");
  const me = document.getElementById("timer-m");
  const se = document.getElementById("timer-s");
  if (he instanceof HTMLInputElement) he.value = String(h);
  if (me instanceof HTMLInputElement) me.value = String(m);
  if (se instanceof HTMLInputElement) se.value = String(s);
}

function setTimerDuration(ms, running = false) {
  const parts = timerPartsFromMs(ms);
  settings.timer.durationMs = ms;
  settings.timer.remainMs = ms;
  settings.timer.h = parts.h;
  settings.timer.m = parts.m;
  settings.timer.s = parts.s;
  settings.timer.running = running;
  settings.timer.endsAt = running ? Date.now() + ms : 0;
  writeTimerInputs(parts.h, parts.m, parts.s);
  updateTimerUi();
  saveSettings();
}

function timerRemain() {
  if (settings.timer.running) {
    return Math.max(0, settings.timer.endsAt - Date.now());
  }
  return settings.timer.remainMs;
}

function updateTimerUi() {
  const remain = timerRemain();
  const parts = timerPartsFromMs(remain);
  const readout = document.getElementById("timer-readout");
  const ring = document.getElementById("timer-ring");
  const startBtn = document.getElementById("btn-timer-start");
  if (readout) readout.textContent = parts.text;
  const total = Math.max(1, settings.timer.durationMs);
  const ratio = remain / total;
  if (ring) ring.style.strokeDashoffset = String(RING_LEN * (1 - ratio));
  if (startBtn) {
    if (settings.timer.running) startBtn.textContent = t("timer.pause");
    else if (remain > 0 && remain < settings.timer.durationMs) startBtn.textContent = t("timer.resume");
    else startBtn.textContent = t("timer.start");
  }
  const digits = document.getElementById("timer-digits");
  if (digits) digits.style.opacity = settings.timer.running ? "0.45" : "1";
}

function toggleTimer() {
  if (settings.timer.running) {
    settings.timer.remainMs = timerRemain();
    settings.timer.running = false;
    settings.timer.endsAt = 0;
    saveSettings();
    updateTimerUi();
    void syncWakeLock();
    return;
  }
  const fromInputs = readTimerInputs();
  let remain = settings.timer.remainMs;
  if (remain <= 0 || remain === settings.timer.durationMs) {
    if (fromInputs.ms <= 0) {
      showToast(t("timer.needTime"));
      return;
    }
    settings.timer.durationMs = fromInputs.ms;
    remain = fromInputs.ms;
  }
  settings.timer.remainMs = remain;
  settings.timer.running = true;
  settings.timer.endsAt = Date.now() + remain;
  saveSettings();
  updateTimerUi();
  void requestNotifyQuiet();
  void syncWakeLock();
}

function resetTimer() {
  const fromInputs = readTimerInputs();
  const ms = fromInputs.ms || settings.timer.durationMs || 300000;
  setTimerDuration(ms, false);
  void syncWakeLock();
}

function tickTimer() {
  if (!settings.timer.running) return;
  const remain = timerRemain();
  if (remain <= 0) {
    settings.timer.running = false;
    settings.timer.remainMs = 0;
    settings.timer.endsAt = 0;
    saveSettings();
    updateTimerUi();
    const loop = settings.timer.loop;
    openAlert("timer", t("timer.done"), timerPartsFromMs(settings.timer.durationMs).text);
    if (loop) {
      window.setTimeout(() => {
        if (!alertOpen) return;
        closeAlert();
        setTimerDuration(settings.timer.durationMs, true);
      }, 900);
    }
    void syncWakeLock();
    return;
  }
  updateTimerUi();
}

function stopwatchElapsed() {
  const sw = settings.stopwatch;
  if (sw.running) return sw.baseMs + (Date.now() - sw.startedAt);
  return sw.baseMs;
}

function formatSw(ms) {
  const total = Math.max(0, ms);
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

function updateStopwatchUi() {
  const readout = document.getElementById("sw-readout");
  const startBtn = document.getElementById("btn-sw-start");
  const lapBtn = document.getElementById("btn-sw-lap");
  const resetBtn = document.getElementById("btn-sw-reset");
  const elapsed = stopwatchElapsed();
  if (readout) readout.textContent = formatSw(elapsed);
  if (startBtn) {
    startBtn.textContent = settings.stopwatch.running
      ? t("stopwatch.pause")
      : elapsed
        ? t("stopwatch.resume")
        : t("stopwatch.start");
  }
  if (lapBtn instanceof HTMLButtonElement) lapBtn.disabled = !settings.stopwatch.running;
  if (resetBtn instanceof HTMLButtonElement) resetBtn.disabled = settings.stopwatch.running || elapsed <= 0;
}

function renderLaps() {
  const body = document.getElementById("lap-body");
  const empty = document.getElementById("lap-empty");
  const table = document.getElementById("lap-table");
  if (!body || !empty || !table) return;
  const laps = settings.stopwatch.laps;
  body.replaceChildren();
  empty.hidden = laps.length > 0;
  table.hidden = laps.length === 0;
  if (!laps.length) return;
  const splits = laps.map((total, i) => total - (i ? laps[i - 1] : 0));
  const min = Math.min(...splits);
  const max = Math.max(...splits);
  for (let i = laps.length - 1; i >= 0; i -= 1) {
    const tr = document.createElement("tr");
    const split = splits[i];
    if (laps.length > 1 && split === min) tr.className = "is-fast";
    if (laps.length > 1 && split === max && max !== min) tr.className = "is-slow";
    const n = document.createElement("td");
    n.textContent = t("stopwatch.lapN", { n: i + 1 });
    if (laps.length > 1 && split === min) n.textContent += ` · ${t("stopwatch.fastest")}`;
    if (laps.length > 1 && split === max && max !== min) n.textContent += ` · ${t("stopwatch.slowest")}`;
    const sp = document.createElement("td");
    sp.textContent = formatSw(split);
    const tot = document.createElement("td");
    tot.textContent = formatSw(laps[i]);
    tr.append(n, sp, tot);
    body.appendChild(tr);
  }
}

function toggleStopwatch() {
  const sw = settings.stopwatch;
  if (sw.running) {
    sw.baseMs = stopwatchElapsed();
    sw.running = false;
    sw.startedAt = 0;
  } else {
    sw.running = true;
    sw.startedAt = Date.now();
    loopStopwatch();
  }
  saveSettings();
  updateStopwatchUi();
  void syncWakeLock();
}

function lapStopwatch() {
  if (!settings.stopwatch.running) return;
  settings.stopwatch.laps.push(stopwatchElapsed());
  saveSettings();
  renderLaps();
}

function resetStopwatch() {
  settings.stopwatch = { baseMs: 0, running: false, startedAt: 0, laps: [] };
  saveSettings();
  updateStopwatchUi();
  renderLaps();
  void syncWakeLock();
}

function loopStopwatch() {
  window.cancelAnimationFrame(swRaf);
  if (!settings.stopwatch.running) {
    updateStopwatchUi();
    return;
  }
  updateStopwatchUi();
  swRaf = window.requestAnimationFrame(loopStopwatch);
}

function setMode(next, pushHash = true) {
  if (!MODES.includes(next)) next = "clock";
  mode = next;
  for (const btn of document.querySelectorAll(".mode-tab")) {
    const on = btn.getAttribute("data-mode") === mode;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
  for (const view of document.querySelectorAll(".view")) {
    view.hidden = view.getAttribute("data-view") !== mode;
  }
  if (pushHash) {
    const url = new URL(location.href);
    url.hash = mode;
    history.replaceState(null, "", url);
  }
  refreshFullscreenLabel();
}

function parseHash() {
  const hash = (location.hash || "#clock").replace("#", "").split("?")[0];
  return MODES.includes(hash) ? hash : "clock";
}

function applyQuery() {
  const params = new URLSearchParams(location.search);
  const timer = params.get("timer");
  const alarm = params.get("alarm");
  if (timer) {
    const parts = timer.split(":").map(Number);
    let ms = 0;
    if (parts.length === 1) ms = (Number(timer) || 0) * 1000;
    else if (parts.length === 2) ms = (parts[0] * 60 + parts[1]) * 1000;
    else ms = ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000;
    if (ms > 0) {
      setTimerDuration(ms, false);
      setMode("timer");
    }
  }
  if (alarm && /^\d{1,2}:\d{2}$/.test(alarm)) {
    const timeEl = document.getElementById("alarm-time");
    if (timeEl instanceof HTMLInputElement) timeEl.value = alarm.length === 4 ? `0${alarm}` : alarm;
    setMode("alarm");
  }
}

function refreshClockChrome() {
  document.getElementById("fmt-24")?.classList.toggle("is-active", !settings.hour12);
  document.getElementById("fmt-12")?.classList.toggle("is-active", settings.hour12);
  const sec = document.getElementById("opt-seconds");
  const analog = document.getElementById("opt-analog");
  if (sec instanceof HTMLInputElement) sec.checked = settings.showSeconds;
  if (analog instanceof HTMLInputElement) analog.checked = settings.showAnalog;
}

function isNativeFullscreen() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

function isFullscreenUi() {
  return document.body.classList.contains("is-fullscreen") || isNativeFullscreen();
}

function refreshFullscreenLabel() {
  const btn = document.getElementById("btn-fullscreen");
  if (btn) btn.textContent = isFullscreenUi() ? t("fullscreen.exit") : t("fullscreen");
}

function setFullscreenUi(on) {
  document.body.classList.toggle("is-fullscreen", on);
  refreshFullscreenLabel();
}

async function enterNativeFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen) return el.requestFullscreen();
  if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  throw new Error("fullscreen-unsupported");
}

async function exitNativeFullscreen() {
  if (document.exitFullscreen && document.fullscreenElement) return document.exitFullscreen();
  if (document.webkitExitFullscreen && document.webkitFullscreenElement) {
    return document.webkitExitFullscreen();
  }
}

async function toggleFullscreen() {
  if (isFullscreenUi()) {
    setFullscreenUi(false);
    try {
      await exitNativeFullscreen();
    } catch {
      /* CSS overlay only */
    }
    return;
  }
  setFullscreenUi(true);
  try {
    await enterNativeFullscreen();
  } catch {
    /* iOS 등: 고정 오버레이로 대체 */
  }
}

async function syncWakeLock() {
  const need =
    settings.timer.running ||
    settings.stopwatch.running ||
    settings.alarms.some((a) => a.enabled);
  try {
    if (!need) {
      await wakeLock?.release();
      wakeLock = null;
      return;
    }
    if ("wakeLock" in navigator && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch {
    wakeLock = null;
  }
}

function fillTimerPresets() {
  const row = document.getElementById("timer-presets");
  if (!row) return;
  row.replaceChildren();
  for (const preset of TIMER_PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
        btn.textContent = preset.sec === 1500 ? t("timer.pomodoro") : `${preset.label} ${t("timer.minutes")}`;
    btn.addEventListener("click", () => {
      if (settings.timer.running) return;
      const parts = timerPartsFromMs(preset.sec * 1000);
      writeTimerInputs(parts.h, parts.m, parts.s);
      setTimerDuration(preset.sec * 1000, false);
    });
    row.appendChild(btn);
  }
}

function refreshLocaleUi() {
  lastWorldKey = "";
  titleBase = t("meta.title");
  applyI18n();
  fillStaticSelects();
  fillCitySelect();
  fillDayPills();
  fillTimerPresets();
  refreshClockChrome();
  renderAlarms();
  renderLaps();
  updateTimerUi();
  updateStopwatchUi();
  updateClock();
  refreshFullscreenLabel();
  const loop = document.getElementById("timer-loop");
  if (loop instanceof HTMLInputElement) loop.checked = settings.timer.loop;
}

function bindUi() {
  document.querySelector(".mode-nav")?.addEventListener("click", (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest("[data-mode]") : null;
    if (btn) setMode(btn.getAttribute("data-mode") || "clock");
  });
  document.getElementById("lang-select")?.addEventListener("change", (ev) => {
    const value = ev.target instanceof HTMLSelectElement ? ev.target.value : "ko";
    setLocale(/** @type {import("./i18n.js").Locale} */ (value), { persist: true });
    refreshLocaleUi();
  });
  document.getElementById("fmt-24")?.addEventListener("click", () => {
    settings.hour12 = false;
    saveSettings();
    refreshClockChrome();
    updateClock();
    renderAlarms();
  });
  document.getElementById("fmt-12")?.addEventListener("click", () => {
    settings.hour12 = true;
    saveSettings();
    refreshClockChrome();
    updateClock();
    renderAlarms();
  });
  document.getElementById("opt-seconds")?.addEventListener("change", (ev) => {
    settings.showSeconds = ev.target instanceof HTMLInputElement && ev.target.checked;
    saveSettings();
    updateClock();
  });
  document.getElementById("opt-analog")?.addEventListener("change", (ev) => {
    settings.showAnalog = ev.target instanceof HTMLInputElement && ev.target.checked;
    saveSettings();
    updateClock();
  });
  document.getElementById("clock-color")?.addEventListener("change", (ev) => {
    if (ev.target instanceof HTMLSelectElement) settings.color = ev.target.value;
    applyColor();
    saveSettings();
  });
  document.getElementById("btn-fullscreen")?.addEventListener("click", () => void toggleFullscreen());
  document.getElementById("btn-add-city")?.addEventListener("click", () => {
    const sel = document.getElementById("city-select");
    if (!(sel instanceof HTMLSelectElement) || !sel.value) return;
    settings.cities.push(sel.value);
    lastWorldKey = "";
    saveSettings();
    fillCitySelect();
    renderWorld(new Date());
  });
  document.getElementById("alarm-repeat")?.addEventListener("change", (ev) => {
    const days = document.getElementById("alarm-days");
    if (days) days.hidden = !(ev.target instanceof HTMLSelectElement && ev.target.value === "custom");
  });
  document.getElementById("alarm-volume")?.addEventListener("input", (ev) => {
    if (ev.target instanceof HTMLInputElement) settings.volume = Number(ev.target.value);
    saveSettings();
  });
  document.getElementById("btn-test-sound")?.addEventListener("click", () => {
    if (alertOpen) return;
    stopAlarmLoop();
    markTestPlaying();
    const sound = document.getElementById("alarm-sound");
    void playPattern(sound instanceof HTMLSelectElement ? sound.value : "chime");
  });
  document.getElementById("btn-add-alarm")?.addEventListener("click", addAlarm);
  document.getElementById("btn-notify")?.addEventListener("click", () => void requestNotify());
  document.getElementById("btn-alert-dismiss")?.addEventListener("click", closeAlert);
  document.getElementById("btn-alert-snooze")?.addEventListener("click", snoozeRinging);
  document.getElementById("btn-timer-start")?.addEventListener("click", toggleTimer);
  document.getElementById("btn-timer-reset")?.addEventListener("click", resetTimer);
  document.getElementById("timer-loop")?.addEventListener("change", (ev) => {
    settings.timer.loop = ev.target instanceof HTMLInputElement && ev.target.checked;
    saveSettings();
  });
  document.getElementById("timer-digits")?.addEventListener("click", (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest("[data-spin]") : null;
    if (!btn || settings.timer.running) return;
    const which = btn.getAttribute("data-spin");
    const dir = Number(btn.getAttribute("data-dir") || 0);
    const map = { h: ["timer-h", 0, 99], m: ["timer-m", 0, 59], s: ["timer-s", 0, 59] };
    const spec = map[which || ""];
    if (!spec) return;
    const el = document.getElementById(spec[0]);
    if (!(el instanceof HTMLInputElement)) return;
    const next = Math.min(spec[2], Math.max(spec[1], (Number(el.value) || 0) + dir));
    el.value = String(next);
    const parts = readTimerInputs();
    setTimerDuration(parts.ms || 0, false);
  });
  for (const id of ["timer-h", "timer-m", "timer-s"]) {
    document.getElementById(id)?.addEventListener("change", () => {
      if (settings.timer.running) return;
      const parts = readTimerInputs();
      setTimerDuration(parts.ms, false);
    });
  }
  document.getElementById("btn-sw-start")?.addEventListener("click", toggleStopwatch);
  document.getElementById("btn-sw-lap")?.addEventListener("click", lapStopwatch);
  document.getElementById("btn-sw-reset")?.addEventListener("click", resetStopwatch);

  window.addEventListener("pointerdown", () => unlockAudio(), { once: true });
  window.addEventListener("keydown", (ev) => {
    const tag = ev.target instanceof HTMLElement ? ev.target.tagName : "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (mode === "stopwatch") {
      if (ev.code === "Space") {
        ev.preventDefault();
        toggleStopwatch();
      } else if (ev.key.toLowerCase() === "l") {
        ev.preventDefault();
        lapStopwatch();
      } else if (ev.key.toLowerCase() === "r") {
        ev.preventDefault();
        resetStopwatch();
      }
    } else if (mode === "timer" && ev.code === "Space") {
      ev.preventDefault();
      toggleTimer();
    } else if (mode === "clock" && ev.key.toLowerCase() === "f") {
      ev.preventDefault();
      void toggleFullscreen();
    } else if (ev.key === "Escape" && isFullscreenUi() && !isNativeFullscreen()) {
      ev.preventDefault();
      setFullscreenUi(false);
    }
  });

  document.addEventListener("fullscreenchange", () => {
    setFullscreenUi(isNativeFullscreen());
  });
  document.addEventListener("webkitfullscreenchange", () => {
    setFullscreenUi(isNativeFullscreen());
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      updateClock();
      updateTimerUi();
      updateStopwatchUi();
      void syncWakeLock();
    } else if (!alertOpen) {
      silenceIfIdle();
    }
  });
  window.addEventListener("hashchange", () => setMode(parseHash(), false));
}

function tickLight() {
  checkAlarms();
  tickTimer();
}

function loopClock() {
  updateClock();
  window.requestAnimationFrame(loopClock);
}

function boot() {
  setLocale(detectLocale());
  settings = loadSettings();
  if (settings.timer.running && settings.timer.endsAt) {
    const remain = settings.timer.endsAt - Date.now();
    if (remain <= 0) {
      settings.timer.running = false;
      settings.timer.remainMs = 0;
    }
  }
  if (settings.stopwatch.running && !settings.stopwatch.startedAt) {
    settings.stopwatch.running = false;
  }
  applyColor();
  buildAnalogTicks();
  const vol = document.getElementById("alarm-volume");
  if (vol instanceof HTMLInputElement) vol.value = String(settings.volume);
  const timeEl = document.getElementById("alarm-time");
  if (timeEl instanceof HTMLInputElement && !timeEl.value) {
    const n = new Date(Date.now() + 5 * 60 * 1000);
    timeEl.value = `${pad(n.getHours())}:${pad(n.getMinutes())}`;
  }
  refreshLocaleUi();
  setMode(parseHash(), false);
  applyQuery();
  bindUi();
  if (settings.stopwatch.running) loopStopwatch();
  loopClock();
  window.setInterval(tickLight, 200);
  tickLight();
  void syncWakeLock();
  void showAdSense("editorAboveWorkspace", "#editor-ad-above-path");
  void showAdSense("editorBelowExport", "#editor-ad-below-export");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
