import data from "./catalog-data.js";

const IMAGE_KO = {
  "ko-KR": "한국어",
  "en-US": "영어",
  "en-GB": "영어 (영국)",
  "ja-JP": "일본어",
  "zh-CN": "중국어 간체",
  "zh-TW": "중국어 번체",
  "de-DE": "독일어",
  "fr-FR": "프랑스어",
  "fr-CA": "프랑스어 (캐나다)",
  "es-ES": "스페인어",
  "es-MX": "스페인어 (멕시코)",
  "pt-BR": "포르투갈어 (브라질)",
  "pt-PT": "포르투갈어",
  "it-IT": "이탈리아어",
  "ru-RU": "러시아어",
  "ar-SA": "아랍어",
  "th-TH": "태국어",
  "nl-NL": "네덜란드어",
  "pl-PL": "폴란드어",
  "tr-TR": "터키어",
  "cs-CZ": "체코어",
  "da-DK": "덴마크어",
  "fi-FI": "핀란드어",
  "sv-SE": "스웨덴어",
  "nb-NO": "노르웨이어",
  "hu-HU": "헝가리어",
  "el-GR": "그리스어",
  "he-IL": "히브리어",
  "ro-RO": "루마니아어",
  "uk-UA": "우크라이나어",
  "bg-BG": "불가리아어",
  "hr-HR": "크로아티아어",
  "sk-SK": "슬로바키아어",
  "sl-SI": "슬로베니아어",
  "sr-Latn-RS": "세르비아어 (라틴)",
  "et-EE": "에스토니아어",
  "lv-LV": "라트비아어",
  "lt-LT": "리투아니아어",
};

function prefer(list, ids) {
  const rank = new Map(ids.map((id, i) => [id, i]));
  return [...list].sort((a, b) => {
    const ia = rank.has(a.id) ? rank.get(a.id) : 1000;
    const ib = rank.has(b.id) ? rank.get(b.id) : 1000;
    if (ia !== ib) return ia - ib;
    return String(a.name).localeCompare(String(b.name), "en");
  });
}

export const IMAGE_LANGUAGES = prefer(
  data.imageLanguages.map((x) => ({ id: x.id, name: IMAGE_KO[x.id] || x.name })),
  ["ko-KR", "en-US", "en-GB", "ja-JP"],
);

export const LOCALES = prefer(data.locales, ["ko-KR", "en-US", "en-GB", "ja-JP"]);
export const KEYBOARDS = prefer(data.keyboards, ["00000412", "00000409", "00000809", "00000411"]);
export const GEO_IDS = prefer(data.geoIds, ["134", "244", "122"]);
export const TIME_ZONES = prefer(data.timeZones, ["Korea Standard Time", "Tokyo Standard Time"]);
export const EDITIONS = data.editions;
export const COMPONENTS = data.components;
export const DESKTOP_ICONS = data.desktopIcons.map((x) => ({
  id: x.id,
  name: x.name,
  guid: x.guid,
}));
export const START_FOLDERS = data.startFolders;

const FEATURE_IDS = new Set(
  data.bloatware.filter((item) => item.steps.some((s) => s.kind === "capability" || s.kind === "feature")).map((item) => item.id),
);
const STORE_IDS = new Set(
  data.bloatware.filter((item) => item.steps.some((s) => s.kind === "package") && !FEATURE_IDS.has(item.id)).map((item) => item.id),
);

const RECOMMENDED = new Set([
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
]);

export const BLOATWARE = data.bloatware.map((item) => ({
  ...item,
  group: RECOMMENDED.has(item.id) ? "recommended" : FEATURE_IDS.has(item.id) ? "windows" : STORE_IDS.has(item.id) ? "store" : "other",
}));

export const BLOATWARE_GROUPS = [
  { id: "recommended", name: "자주 지우는 항목" },
  { id: "store", name: "스토어 앱" },
  { id: "windows", name: "Windows에 들어 있는 기능" },
  { id: "other", name: "기타" },
];

export const LEGACY_BLOAT = {
  Teams: "RemoveTeams",
  Outlook: "RemoveOutlook",
  Office365: "RemoveOffice365",
  OneNote: "RemoveOneNote",
  OneDrive: "RemoveOneDrive",
  Copilot: "RemoveCopilot",
  BingSearch: "RemoveBingSearch",
  News: "RemoveNews",
  Weather: "RemoveWeather",
  Widgets: "RemoveWidgets",
  Xbox: "RemoveXboxApps",
  Solitaire: "RemoveSolitaire",
  GameAssist: "RemoveGameAssist",
  Clipchamp: "RemoveClipchamp",
  ZuneVideo: "RemoveZuneVideo",
  ZuneMusic: "RemoveZuneMusic",
  Camera: "RemoveCamera",
  Photos: "RemovePhotos",
  SoundRecorder: "RemoveVoiceRecorder",
  YourPhone: "RemoveYourPhone",
  GetHelp: "RemoveGetHelp",
  GetStarted: "RemoveGetStarted",
  FeedbackHub: "RemoveFeedbackHub",
  Cortana: "RemoveCortana",
  People: "RemovePeople",
  ToDo: "RemoveToDo",
  Maps: "RemoveMaps",
  MailCalendar: "RemoveMailCalendar",
  StickyNotes: "RemoveStickyNotes",
  Paint3D: "RemovePaint3D",
  Viewer3D: "Remove3DViewer",
  MixedReality: "RemoveMixedReality",
  Skype: "RemoveSkype",
  Family: "RemoveFamily",
  PowerAutomate: "RemovePowerAutomate",
  DevHome: "RemoveDevHome",
  QuickAssist: "RemoveQuickAssist",
  Clock: "RemoveClock",
  Calculator: "RemoveCalculator",
  Notepad: "RemoveNotepad",
  Paint: "RemovePaint",
  SnippingTool: "RemoveSnippingTool",
  Terminal: "RemoveWindowsTerminal",
  Store: "RemoveStore",
  Recall: "RemoveRecall",
};

export const EFFECTS = [
  { id: "ControlAnimations", name: "창 안 컨트롤 애니메이션" },
  { id: "AnimateMinMax", name: "최소화·최대화 애니메이션" },
  { id: "TaskbarAnimations", name: "작업 표시줄 애니메이션" },
  { id: "DWMAeroPeekEnabled", name: "Aero Peek" },
  { id: "MenuAnimation", name: "메뉴 페이드/슬라이드" },
  { id: "TooltipAnimation", name: "툴팁 페이드/슬라이드" },
  { id: "SelectionFade", name: "메뉴 항목 페이드 아웃" },
  { id: "DWMSaveThumbnailEnabled", name: "작업 표시줄 미리보기 저장" },
  { id: "CursorShadow", name: "마우스 포인터 그림자" },
  { id: "ListviewShadow", name: "아이콘 레이블 그림자" },
  { id: "ThumbnailsOrIcon", name: "아이콘 대신 미리보기" },
  { id: "ListviewAlphaSelect", name: "반투명 선택 사각형" },
  { id: "DragFullWindows", name: "끌 때 창 내용 표시" },
  { id: "ComboBoxAnimation", name: "콤보 상자 슬라이드" },
  { id: "FontSmoothing", name: "화면 글꼴 다듬기" },
  { id: "ListBoxSmoothScrolling", name: "목록 부드러운 스크롤" },
  { id: "DropShadow", name: "창 그림자" },
];

export function localeById(id) {
  return LOCALES.find((x) => x.id === id) || LOCALES.find((x) => x.id === "ko-KR");
}

export function inputLocale(localeId, keyboardId) {
  const loc = localeById(localeId);
  const lcid = (loc?.lcid || "0412").padStart(4, "0");
  const kb = keyboardId || loc?.keyboard || "00000412";
  return `${lcid}:${kb}`;
}
