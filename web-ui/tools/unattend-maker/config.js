import { BLOATWARE, DESKTOP_ICONS, EFFECTS, LEGACY_BLOAT, START_FOLDERS } from "./catalog.js";

export const MODES = [
  { id: "custom", name: "직접 설정", hint: "처음부터 원하는 대로 고릅니다" },
  { id: "home", name: "가정용 클린", hint: "한국어, 로컬 계정, 자주 안 쓰는 앱만 정리" },
  { id: "oldpc", name: "구형 PC", hint: "가정용과 같고, 오래된 PC에도 설치됩니다" },
  { id: "minimal", name: "미니멀", hint: "앱을 더 많이 지웁니다" },
];

export const IDENTITY_KEYS = [
  "accountName",
  "accountPassword",
  "accountDisplay",
  "computerName",
  "wifiSsid",
  "wifiPassword",
  "wifiXml",
  "productKey",
  "activationKey",
];

export const SCRIPT_TYPES = [
  { id: "cmd", name: ".cmd" },
  { id: "ps1", name: ".ps1" },
  { id: "reg", name: ".reg" },
  { id: "vbs", name: ".vbs" },
  { id: "js", name: ".js" },
];

export const SCRIPT_PHASES = [
  { id: "system", name: "계정 만들기 전", types: ["cmd", "ps1", "reg", "vbs", "js"] },
  { id: "defaultUser", name: "새로 만드는 모든 계정", types: ["reg", "cmd", "ps1"] },
  { id: "firstLogon", name: "처음 로그인할 때", types: ["cmd", "ps1", "reg", "vbs", "js"] },
  { id: "userOnce", name: "사용자마다 한 번", types: ["cmd", "ps1", "reg", "vbs", "js"] },
];

function emptyBloat() {
  const out = {};
  for (const item of BLOATWARE) out[item.id] = false;
  return out;
}

function emptyDesktop() {
  const out = {};
  for (const item of DESKTOP_ICONS) out[item.id] = false;
  return out;
}

function emptyStartFolders() {
  const out = {};
  for (const item of START_FOLDERS) out[item.id] = false;
  return out;
}

function emptyEffects(value) {
  const out = {};
  for (const item of EFFECTS) out[item.id] = value;
  return out;
}

function emptyAccounts() {
  return [
    { name: "", display: "", password: "", group: "Administrators" },
    { name: "", display: "", password: "", group: "Users" },
    { name: "", display: "", password: "", group: "Users" },
    { name: "", display: "", password: "", group: "Users" },
    { name: "", display: "", password: "", group: "Users" },
  ];
}

function emptySlots() {
  return [0, 1, 2, 3].map(() => ({ type: "ps1", content: "" }));
}

export function defaultConfig() {
  return {
    mode: "custom",
    languageInteractive: true,
    imageLanguage: "ko-KR",
    locale: "ko-KR",
    keyboard: "00000412",
    locale2: "",
    keyboard2: "",
    locale3: "",
    keyboard3: "",
    geoId: "134",
    timeZoneMode: "implicit",
    timeZone: "Korea Standard Time",

    computerNameMode: "random",
    computerName: "",
    computerNameScript: "",
    accountMode: "interactive-msa",
    accounts: emptyAccounts(),
    accountName: "",
    accountDisplay: "",
    accountPassword: "",
    accountGroup: "Administrators",
    account2Name: "",
    account2Password: "",
    account2Group: "Users",
    autoLogon: "first-admin",
    builtinAdminPassword: "",
    obscurePasswords: false,
    passwordExpire: "never",
    passwordExpireDays: 42,
    lockout: "default",
    lockoutThreshold: 10,
    lockoutWindow: 10,
    lockoutDuration: 10,

    archX86: false,
    archAmd64: true,
    archArm64: false,
    edition: "pro",
    productKeyMode: "generic",
    productKey: "",
    activationKey: "",
    bypassTpm: false,
    narrator: false,
    peStage: "setup",
    diskMode: "interactive",
    targetDisk: 0,
    partitionLayout: "auto",
    systemPartitionMb: 300,
    recoveryMode: "partition",
    recoveryMb: 1000,
    compactOs: false,
    skipIntegrity: false,
    disable8dot3: false,
    disableDefenderPe: false,
    pauseBeforeFormat: false,
    pauseBeforeReboot: false,
    imageSelect: "edition",
    imageName: "",
    imageIndex: 1,
    customDiskpart: "",
    customPeScript: "",
    assertDisk: "none",
    assertMinGiB: 100,
    assertMaxGiB: 4000,
    assertNoPartitions: true,
    assertInterface: false,
    assertMedia: false,
    assertScript: "",

    wifiMode: "interactive",
    wifiSsid: "",
    wifiPassword: "",
    wifiAuth: "WPA2PSK",
    wifiHidden: false,
    wifiConnectAuto: true,
    wifiXml: "",
    bypassNetwork: false,
    expressSettings: "disable",

    hideFiles: "hidden",
    showExtensions: false,
    classicContextMenu: false,
    hideInfoTip: false,
    launchToThisPC: false,
    showEndTask: false,
    taskbarSearch: "box",
    disableWidgets: false,
    leftTaskbar: false,
    hideTaskView: false,
    showAllTray: false,
    disableBing: false,
    startPins: "default",
    startPinsJson: `{
  "pinnedList": [
    { "desktopAppLink": "%ALLUSERSPROFILE%\\\\Microsoft\\\\Windows\\\\Start Menu\\\\Programs\\\\Microsoft Edge.lnk" },
    { "desktopAppLink": "%APPDATA%\\\\Microsoft\\\\Windows\\\\Start Menu\\\\Programs\\\\File Explorer.lnk" }
  ]
}`,
    startTiles: "default",
    startTilesXml: "",
    taskbarIcons: "default",
    taskbarIconsXml: "",
    deleteEdgeShortcut: false,
    colorMode: "default",
    themeSystem: "dark",
    themeApps: "dark",
    accentColor: "#0078D4",
    accentOnStart: false,
    accentOnBorders: false,
    enableTransparency: true,
    effectsMode: "default",
    effects: emptyEffects(true),
    stickyKeys: "default",
    stickyHotKey: true,
    stickyIndicator: false,
    stickyTriState: false,
    stickyTwoKeysOff: true,
    stickyAudible: false,
    stickyHotKeySound: true,
    lockKeys: false,
    capsInitial: "off",
    capsBehavior: "toggle",
    numInitial: "off",
    numBehavior: "toggle",
    scrollInitial: "off",
    scrollBehavior: "toggle",
    wallpaperMode: "default",
    wallpaperColor: "#000000",
    wallpaperScript: "",
    lockScreenMode: "default",
    lockScreenScript: "",
    desktopIcons: emptyDesktop(),
    startFolders: emptyStartFolders(),
    startFoldersCustom: false,

    disableWindowsUpdate: false,
    preventReboot: false,
    disableUac: false,
    disableSmartScreen: false,
    disableSac: false,
    disableFastStartup: false,
    disableSystemRestore: false,
    enableLongPaths: false,
    enableRdp: false,
    hardenAcl: false,
    deleteJunctions: false,
    allowPsScripts: false,
    disableLastAccess: false,
    turnOffSounds: false,
    disableAppSuggestions: false,
    preventBitlocker: false,
    hideEdgeFre: false,
    disableEdgeBoost: false,
    makeEdgeUninstallable: false,
    disablePointerPrecision: false,
    deleteWindowsOld: false,
    disableAutoSignOn: false,
    disableWpbt: false,
    preventDeviceApps: false,
    processAudit: false,
    processAuditCmdline: true,
    disableCoreIsolation: false,

    bloatware: emptyBloat(),

    useOemFolder: false,
    hidePowerShell: false,
    keepSensitiveFiles: false,
    vboxGuest: false,
    vmwareTools: false,
    virtio: false,
    parallels: false,
    scriptSlots: {
      system: emptySlots(),
      defaultUser: emptySlots().map((s) => ({ ...s, type: "reg" })),
      firstLogon: emptySlots(),
      userOnce: emptySlots(),
    },
    scriptsSystem: "",
    scriptsDefaultUser: "",
    scriptsFirstLogon: "",
    scriptsUserOnce: "",
    restartExplorer: false,
    appLocker: "",
    extraXml: "",
    componentXml: {},
    downloadName: "autounattend.xml",
    downloadIso: false,
  };
}

const HOME_BLOAT = [
  "RemoveTeams",
  "RemoveOutlook",
  "RemoveCopilot",
  "RemoveXboxApps",
  "RemoveNews",
  "RemoveWeather",
  "RemoveSolitaire",
  "RemoveGetHelp",
  "RemoveGetStarted",
  "RemoveOffice365",
  "RemoveYourPhone",
  "RemoveClipchamp",
  "RemoveBingSearch",
  "RemoveCortana",
];

const MINIMAL_BLOAT = [
  ...HOME_BLOAT,
  "RemoveMailCalendar",
  "RemoveToDo",
  "RemovePeople",
  "RemoveMaps",
  "RemoveFeedbackHub",
  "RemoveStickyNotes",
  "RemovePaint3D",
  "Remove3DViewer",
  "RemoveMixedReality",
  "RemoveSkype",
  "RemoveFamily",
  "RemovePowerAutomate",
  "RemoveDevHome",
  "RemoveGameAssist",
  "RemoveZuneVideo",
  "RemoveQuickAssist",
  "RemoveClock",
  "RemoveRecall",
];

function withBloat(ids) {
  const bloat = emptyBloat();
  for (const id of ids) {
    if (id in bloat) bloat[id] = true;
  }
  return bloat;
}

function koreanBase() {
  return {
    languageInteractive: false,
    imageLanguage: "ko-KR",
    locale: "ko-KR",
    keyboard: "00000412",
    geoId: "134",
    timeZoneMode: "explicit",
    timeZone: "Korea Standard Time",
    accountMode: "local",
    autoLogon: "first-admin",
    passwordExpire: "never",
    peStage: "setup",
    diskMode: "interactive",
    wifiMode: "skip",
    expressSettings: "disable",
    showExtensions: true,
    classicContextMenu: true,
    launchToThisPC: true,
    deleteEdgeShortcut: true,
    hideEdgeFre: true,
    preventBitlocker: true,
    disableAppSuggestions: true,
    disableWidgets: true,
    hideTaskView: true,
  };
}

export function presetValues(mode) {
  if (mode === "custom") return {};
  const base = koreanBase();
  if (mode === "home") {
    return { ...base, bypassTpm: false, bloatware: withBloat(HOME_BLOAT) };
  }
  if (mode === "oldpc") {
    return { ...base, bypassTpm: true, bloatware: withBloat(HOME_BLOAT) };
  }
  if (mode === "minimal") {
    return {
      ...base,
      bypassTpm: false,
      disableBing: true,
      startPins: "none",
      bloatware: withBloat(MINIMAL_BLOAT),
    };
  }
  return {};
}

export function syncAccounts(config) {
  const accounts = Array.isArray(config.accounts) && config.accounts.length ? config.accounts.map((a) => ({ ...a })) : emptyAccounts();
  while (accounts.length < 5) accounts.push({ name: "", display: "", password: "", group: "Users" });
  if (config.accountName && !accounts[0].name) accounts[0].name = config.accountName;
  if (config.accountDisplay && !accounts[0].display) accounts[0].display = config.accountDisplay;
  if (config.accountPassword && !accounts[0].password) accounts[0].password = config.accountPassword;
  if (config.accountGroup) accounts[0].group = config.accountGroup;
  if (config.account2Name && !accounts[1].name) {
    accounts[1].name = config.account2Name;
    accounts[1].password = config.account2Password || "";
    accounts[1].group = config.account2Group || "Users";
  }
  const first = accounts[0];
  return {
    ...config,
    accounts,
    accountName: first.name,
    accountDisplay: first.display,
    accountPassword: first.password,
    accountGroup: first.group,
    account2Name: accounts[1].name,
    account2Password: accounts[1].password,
    account2Group: accounts[1].group,
  };
}

export function applyPreset(current, mode) {
  const next = syncAccounts({ ...defaultConfig(), ...presetValues(mode), mode });
  for (const key of IDENTITY_KEYS) {
    if (current[key]) next[key] = current[key];
  }
  if (current.accounts?.some((a) => a?.name)) next.accounts = current.accounts;
  return syncAccounts(next);
}

export function migrateConfig(loaded) {
  const base = defaultConfig();
  const next = { ...base, ...loaded };
  const bloat = { ...base.bloatware };
  for (const [key, value] of Object.entries(loaded.bloatware || {})) {
    const id = LEGACY_BLOAT[key] || key;
    if (id in bloat) bloat[id] = !!value;
  }
  next.bloatware = bloat;
  next.desktopIcons = { ...base.desktopIcons, ...(loaded.desktopIcons || {}) };
  next.startFolders = { ...base.startFolders, ...(loaded.startFolders || {}) };
  next.effects = { ...base.effects, ...(loaded.effects || {}) };
  next.scriptSlots = {
    system: base.scriptSlots.system.map((slot, i) => ({ ...slot, ...(loaded.scriptSlots?.system?.[i] || {}) })),
    defaultUser: base.scriptSlots.defaultUser.map((slot, i) => ({ ...slot, ...(loaded.scriptSlots?.defaultUser?.[i] || {}) })),
    firstLogon: base.scriptSlots.firstLogon.map((slot, i) => ({ ...slot, ...(loaded.scriptSlots?.firstLogon?.[i] || {}) })),
    userOnce: base.scriptSlots.userOnce.map((slot, i) => ({ ...slot, ...(loaded.scriptSlots?.userOnce?.[i] || {}) })),
  };
  next.componentXml = { ...loaded.componentXml };
  if (loaded.diskMode === "wipe" && !loaded.peStage) next.peStage = "generate";
  if (loaded.keyboard && loaded.keyboard.includes(":")) {
    next.keyboard = loaded.keyboard.split(":")[1] || next.keyboard;
  }
  return syncAccounts(next);
}

export function cloneConfig(config) {
  return structuredClone(config);
}

export { HOME_BLOAT, MINIMAL_BLOAT };
