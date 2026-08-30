/**
 * 테마 부트 + 숨긴 도구 직접 URL 차단.
 * HEAD에서 동기적으로 테마를 넣고, 숨김 도구는 화면을 가린 뒤 설정을 확인합니다.
 */
(function () {
  "use strict";

  var THEME_KEY = "itz-theme";
  var URL_PREFIX_TO_LANG = { kr: "ko", ko: "ko", en: "en", ja: "ja", zh: "zh" };
  var LANG_TO_URL_PREFIX = { ko: "kr", en: "en", ja: "ja", zh: "zh" };

  function isAdminPath(pathname) {
    return /\/admin(?:\/|$)/i.test(String(pathname || location.pathname || ""));
  }

  function pathSegments(pathname) {
    return String(pathname || "").split("/").filter(Boolean);
  }

  function readPathLangFrom(pathname) {
    var first = (pathSegments(pathname)[0] || "").toLowerCase();
    return URL_PREFIX_TO_LANG[first] || "";
  }

  function contentPathname(pathname) {
    var raw = String(pathname || "/");
    var hadTrailing = /\/$/.test(raw);
    var parts = pathSegments(raw);
    if (parts.length && URL_PREFIX_TO_LANG[parts[0].toLowerCase()]) parts.shift();
    if (!parts.length) return "/";
    var out = "/" + parts.join("/");
    var last = parts[parts.length - 1];
    if (hadTrailing && last.indexOf(".") === -1) out += "/";
    return out;
  }

  function langUrlPrefix(lang) {
    var n = typeof normalizeLang === "function" ? normalizeLang(lang) : "";
    if (!n) n = "ko";
    return LANG_TO_URL_PREFIX[n] || "kr";
  }

  function pathWithLang(lang, pathname) {
    var prefix = langUrlPrefix(lang);
    var rest = contentPathname(pathname);
    if (!rest || rest === "/") return "/" + prefix + "/";
    return "/" + prefix + rest;
  }

  function readTheme() {
    try {
      return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
    } catch (e) {
      return "light";
    }
  }

  function applyTheme(theme) {
    var html = document.documentElement;
    html.setAttribute("data-theme", theme);
    html.style.colorScheme = theme;
  }

  function writeTheme(theme) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
      /* ignore */
    }
    applyTheme(theme);
    syncThemeToggles();
  }

  applyTheme(readTheme());

  (function injectThemeCss() {
    var href = "common/theme.css?v=17";
    var src = "";
    if (document.currentScript && document.currentScript.src) {
      src = document.currentScript.src;
    } else {
      var scripts = document.getElementsByTagName("script");
      for (var i = 0; i < scripts.length; i++) {
        var s = scripts[i].getAttribute("src") || "";
        if (s.indexOf("site-runtime.js") !== -1) {
          src = scripts[i].src || s;
          break;
        }
      }
    }
    if (src) {
      href = src.replace(/site-runtime\.js[^/]*$/, "theme.css?v=17");
    }
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    (document.head || document.documentElement).appendChild(link);
  })();

  if (readTheme() === "light") {
    var boot = document.createElement("style");
    boot.id = "itz-theme-boot";
    boot.textContent =
      'html[data-theme="light"]{background:#f4f6fa;color:#0f172a;' +
      "--bg-dark:#f4f6fa;--bg-elevated:#ffffff;--panel-bg:#ffffff;" +
      "--text-main:#0f172a;--text-dim:#334155;--text-muted:#475569;--border:#d8dee8;" +
      "--bg-card:#ffffff;--bg-input:#f8fafc;--text-primary:#0f172a;--text-secondary:#475569;" +
      "--as-bg:#f4f6fa;--as-panel:#ffffff;--as-panel-2:#eef2f7;--as-border:#d8dee8;" +
      "--as-text:#0f172a;--as-text-dim:#475569;" +
      "--bg-control:#f8fafc;--bg-control-muted:#e8eef4;--text-subtle:#475569}" +
      'html[data-theme="light"] body{background-color:#f4f6fa;color:#0f172a}';
    (document.head || document.documentElement).appendChild(boot);
  }

  function syncThemeToggles() {
    var light = readTheme() === "light";
    var pack = typeof COMMON_I18N !== "undefined" && COMMON_I18N[currentLang] ? COMMON_I18N[currentLang] : {};
    var title = light ? pack["chrome.themeLight"] || "다크 모드" : pack["chrome.themeDark"] || "화이트 모드";
    var label = light ? pack["chrome.themeToDark"] || "다크 모드로 전환" : pack["chrome.themeToLight"] || "화이트 모드로 전환";
    var buttons = document.querySelectorAll(".itz-theme-toggle");
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      btn.setAttribute("aria-pressed", light ? "true" : "false");
      btn.setAttribute("title", title);
      btn.setAttribute("aria-label", label);
    }
  }

  function bindThemeToggle(btn) {
    if (!btn || btn.getAttribute("data-itz-theme-bound") === "1") return;
    btn.setAttribute("data-itz-theme-bound", "1");
    btn.addEventListener("click", function () {
      writeTheme(readTheme() === "light" ? "dark" : "light");
    });
  }

  function createThemeToggle() {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "itz-theme-toggle";
    btn.id = "itz-theme-toggle";
    btn.innerHTML = '<span class="itz-theme-toggle-icon" aria-hidden="true"></span>';
    return btn;
  }

  function mountThemeToggle() {
    if (!document.querySelector(".itz-theme-toggle")) {
      var btn = createThemeToggle();
      var hubTitle = document.querySelector(".hub-title-cluster .hub-title, .hub-title-row .hub-title");
      if (hubTitle && hubTitle.parentNode) {
        hubTitle.parentNode.insertBefore(btn, hubTitle.nextSibling);
      } else {
        var toolTitle = document.querySelector(".logo-title-row > h1, .as-topbar-left > .as-logo");
        if (toolTitle && toolTitle.parentNode) {
          toolTitle.parentNode.insertBefore(btn, toolTitle.nextSibling);
        }
      }
    }
    var all = document.querySelectorAll(".itz-theme-toggle");
    for (var i = 0; i < all.length; i++) bindThemeToggle(all[i]);
    syncThemeToggles();
  }

  function footerLinkDefs() {
    var prefix = "/" + (LANG_TO_URL_PREFIX[currentLang] || "kr");
    return [
      { href: prefix + "/", key: "footer.home" },
      { href: prefix + "/legal/policy.html", key: "footer.policy" },
      { href: prefix + "/legal/email.html", key: "footer.email" },
      { href: prefix + "/legal/copyright.html", key: "footer.copyright" },
      { href: prefix + "/legal/disclaimer.html", key: "footer.disclaimer" },
      { href: prefix + "/legal/about.html", key: "footer.about" }
    ];
  }

  function refreshFooter() {
    var footer = document.querySelector(".itz-site-footer");
    if (!footer || typeof t !== "function") return;
    var nav = footer.querySelector(".itz-site-footer-nav");
    if (!nav) return;
    nav.setAttribute("aria-label", t("footer.nav"));
    var defs = footerLinkDefs();
    var links = nav.querySelectorAll("a");
    for (var i = 0; i < links.length && i < defs.length; i++) {
      links[i].textContent = t(defs[i].key);
      links[i].setAttribute("href", defs[i].href);
    }
  }

  function mountSiteFooter() {
    if (/\/admin(?:\/|$)/i.test(location.pathname || "")) return;
    if (document.querySelector(".itz-site-footer")) {
      refreshFooter();
      return;
    }

    var rest = contentPathname(location.pathname || "");
    var defs = footerLinkDefs();
    var nav = "";
    for (var i = 0; i < defs.length; i++) {
      var item = defs[i];
      var current = false;
      if (item.key === "footer.home") {
        current = rest === "/" || rest === "/index.html";
      } else {
        var file = item.href.split("/").pop();
        current = rest.indexOf("/legal/" + file) !== -1;
      }
      nav +=
        '<a href="' +
        item.href +
        '"' +
        (current ? ' aria-current="page"' : "") +
        ">" +
        (typeof t === "function" ? t(item.key) : item.key) +
        "</a>";
    }

    var footer = document.createElement("footer");
    footer.className = "itz-site-footer";
    footer.innerHTML =
      '<div class="itz-site-footer-inner">' +
      '<p class="itz-site-footer-copy">© 2026 itmatzipTools</p>' +
      '<nav class="itz-site-footer-nav" aria-label="' +
      (typeof t === "function" ? t("footer.nav") : "사이트 안내") +
      '">' +
      nav +
      "</nav></div>";
    document.body.appendChild(footer);
  }

  var SITE_LANG_KEY = "itz-site-lang";
  var SITE_LANGS = [
    { id: "ko", label: "한국어" },
    { id: "en", label: "English" },
    { id: "ja", label: "日本語" },
    { id: "zh", label: "中文" }
  ];
  var HTML_LANG = { ko: "ko", en: "en", ja: "ja", zh: "zh-CN" };
  var OG_LOCALE = { ko: "ko_KR", en: "en_US", ja: "ja_JP", zh: "zh_CN" };
  var PUBLIC_ORIGIN = "https://tools.itmatzip.com";
  var i18nPacks = {};
  var i18nBind = {};
  var currentLang = "ko";
  var catalogReady = false;

  var COMMON_I18N = {
    ko: {
      "chrome.dashboard": "대시보드로 이동",
      "chrome.themeLight": "다크 모드",
      "chrome.themeDark": "화이트 모드",
      "chrome.themeToDark": "다크 모드로 전환",
      "chrome.themeToLight": "화이트 모드로 전환",
      "footer.home": "홈",
      "footer.policy": "운영정책",
      "footer.email": "이메일 무단수집 거부",
      "footer.copyright": "저작권 및 권리",
      "footer.disclaimer": "책임의 한계와 법적 고지",
      "footer.about": "ItMatzipTools 소개",
      "footer.nav": "사이트 안내",
      "ad.label": "광고",
      "modal.title": "안내",
      "modal.ok": "확인",
      "modal.reload": "새로고침",
      "modal.retry": "다시 연결 확인",
      "modal.checking": "연결 확인 중…",
      "modal.connected": "연결되었습니다.",
      "modal.notConnected": "아직 연결되지 않았습니다. ({err})",
      "modal.checkFailed": "확인 실패: {msg}",
      "modal.cannotConnect": "연결할 수 없습니다",
      "adblock.title": "광고가 차단되었습니다",
      "adblock.titleBrave": "광고가 차단되었습니다 (Brave Shields 등)",
      "adblock.lead": "이 사이트는 <strong>광고 수익</strong>으로 무료 운영됩니다. 지금 <strong>광고가 표시되지 않고</strong> 있습니다.",
      "adblock.sub": "PC 프로그램(에이전트) 연결 문제와는 <strong>별개</strong>입니다. 아래는 <strong>광고 표시</strong>만 위한 안내입니다.",
      "adblock.how": "광고 허용 방법",
      "adblock.stepBrave1": "주소창 <strong>사자(Brave) 아이콘</strong> → <strong>Shields(보호) 끔</strong>",
      "adblock.stepBrave2": "또는 Shields 켠 채 <strong>고급</strong> → 이 사이트 <strong>광고·추적 허용</strong>",
      "adblock.stepBrave3": "<strong>F5</strong> 새로고침",
      "adblock.stepChrome1": "광고 차단 <strong>확장</strong> → 이 사이트 <strong>허용</strong> 또는 <strong>일시 중지</strong>",
      "adblock.stepChrome2": "<strong>F5</strong> 새로고침",
      "agent.installTitle": "로컬 에이전트에 연결할 수 없습니다",
      "agent.installFallback": "PC에서 ItMatZip 로컬 에이전트를 실행한 뒤 다시 연결해 주세요.",
      "agent.download": "에이전트 다운로드",
      "agent.downloadVer": "에이전트 다운로드 v{v}",
      "agent.intro1": "본 웹사이트는 기능을 편리하게 이용할 수 있는 <strong>화면(인터페이스)</strong>만 제공할 뿐, 회원님의 소중한 데이터는 <strong>외부 서버로 절대 업로드되거나 저장되지 않습니다</strong>.",
      "agent.intro2": "모든 기능은 오직 회원님의 컴퓨터 내부에서만 독립적으로 실행되므로 자료 유출 우려가 전혀 없습니다. 이 안전하고 강력한 로컬 기능을 정상적으로 이용하기 위해 <strong>최초 1회 전용 프로그램(에이전트) 설치</strong>가 필요합니다.",
      "agent.firstTitle": "처음 이용하시나요?",
      "agent.firstText": "아래에서 <strong>{pkg}</strong>{ver} 을 받아 설치하세요. {hint}",
      "agent.msiHint": "MSI를 실행해 설치한 뒤, 작업 표시줄 트레이에 ItMatZip 아이콘이 뜨는지 확인하세요.",
      "agent.exeHint": "실행 파일을 받아 실행하면 설치됩니다.",
      "agent.firstNote": "설치 후 웹에서 <strong>다시 연결 확인</strong>을 눌러 주세요. 에이전트를 <strong>삭제·제거</strong>했거나 버전을 올릴 때도 여기서 최신 MSI 를 받으면 됩니다. (탭을 오래 켜 둔 경우 <strong>F5 새로고침</strong> 후 다운로드하세요.)",
      "agent.installedTitle": "이미 설치하셨나요?",
      "agent.installedText": "프로그램이 켜져 있는지 확인하신 후, 하단 <strong>다시 연결 확인</strong>을 눌러 주세요. 업데이트 직후에는 트레이 아이콘을 우클릭 → <strong>종료</strong> 후 다시 실행하거나 PC 를 재부팅하세요.",
      "agent.installedNote": "Chrome 사용 시 주소창 왼쪽 <strong>사이트 설정</strong> → <strong>로컬 네트워크</strong>를 <strong>허용</strong>해야 합니다. 콘솔에 <code>ERR_BLOCKED_BY_CLIENT</code> 가 보이면 <strong>광고 차단 확장</strong>이 <code>127.0.0.1</code> 을 막는 경우가 많습니다.",
      "agent.blockTitle": "에이전트 통신이 차단되었습니다",
      "agent.blockBrave1": "광고 허용·Shields 조정을 했어도, <strong>PC 프로그램(에이전트)과의 연결</strong>은 여전히 막히고 있습니다.",
      "agent.blockBrave2": "광고만 허용하는 설정으로는 <strong>에이전트 통신</strong>이 풀리지 않을 때가 많습니다. <strong>Shields 끔</strong> + 광고 차단 <strong>확장 사용 끔</strong>이 필요합니다.",
      "agent.blockBraveStep1": "주소창 <strong>사자(Brave) 아이콘</strong> → <strong>Shields 끔</strong>",
      "agent.blockBraveStep2": "광고 차단 <strong>확장 아이콘</strong> 우클릭 → <strong>확장 프로그램 관리</strong> → <strong>사용 끔</strong>",
      "agent.blockBraveStep3": "<strong>F5</strong> 새로고침 → 아래 <strong>다시 연결 확인</strong>",
      "agent.blockBraveHint": "그래도 안 되면: 자물쇠 → 사이트 설정 → <strong>로컬 네트워크 허용</strong>",
      "agent.blockChrome1": "광고 차단을 이 사이트에서만 해제했어도, <strong>광고 차단 확장</strong>이 PC 프로그램(에이전트)과의 <strong>통신은 계속 막고</strong> 있습니다.",
      "agent.blockChrome2": "「이 사이트 허용」「일시 중지」로는 부족한 경우가 많습니다. <strong>확장 프로그램 사용을 꺼 주세요.</strong>",
      "agent.blockChromeStep1": "Chrome 위 <strong>광고 차단 확장 아이콘</strong> 우클릭",
      "agent.blockChromeStep2": "<strong>확장 프로그램 관리</strong> → 해당 확장 <strong>사용 끔</strong>",
      "agent.blockChromeStep3": "<strong>F5</strong> 새로고침 → 아래 <strong>다시 연결 확인</strong>",
      "agent.blockChromeHint": "그래도 안 되면: 주소창 <strong>자물쇠</strong> → <strong>로컬 네트워크 허용</strong>",
      "ui.newJob": "새 작업 시작",
      "ui.prepare": "환경 준비",
      "ui.checking": "확인 중…",
      "ui.checkingShort": "확인 중",
      "ui.device": "실행 장치",
      "ui.deviceAuto": "자동 (권장)",
      "ui.outputFormat": "출력 포맷",
      "ui.jobStatus": "작업 상태",
      "ui.previewOriginal": "원본 미리보기",
      "ui.compareHint": "슬라이더를 왼쪽으로 당기면 원본, 오른쪽으로 당기면 결과가 보입니다.",
      "ui.pickImageEmpty": "이미지를 선택하면 여기에 원본이 표시됩니다.",
      "ui.processing": "처리 중…",
      "ui.preparing": "준비 중…",
      "ui.cpu": "CPU",
      "ui.gpu": "GPU (CUDA)",
      "ui.previewCompare": "원본 / 결과",
      "ui.previewCompareSlider": "원본 ↔ 결과 비교",
      "ui.original": "원본",
      "ui.result": "결과",
      "ui.pickBusy": "대화상자…",
      "ui.pathPh": "파일 경로",
      "ui.model": "모델",
      "ui.ready": "준비",
      "ui.readyOk": "준비됨",
      "ui.notReady": "미준비",
      "ui.deviceShort": "장치",
      "ui.options": "옵션",
      "ui.auto": "자동",
      "ui.fp16Fast": "GPU에서 더 빠르게",
      "ui.default": "기본",
      "ui.envCheck": "환경 확인",
      "ui.downloadResult": "결과 다운로드",
      "ui.gpuCuda": "GPU · CUDA",
    "ui.gpuCudaReady": "GPU · CUDA 준비됨",
    "ui.gpuDetectNoCuda": "GPU 감지 · CUDA 미사용",
    "ui.gpuCudaInstallHint": "환경 준비를 다시 실행하면 CUDA wheel을 설치합니다.",
    "ui.cpuNoNvidia": "NVIDIA GPU가 없으면 CPU로 처리됩니다.",
    "ui.phaseRun": "처리 중",
    "ui.phaseDone": "완료",
    "ui.phaseFail": "실패",
    "ui.prepFail": "환경 준비 실패",
    "ui.readyCheckFail": "준비 상태 확인 실패",
      "ui.moving": "이동 중…",
      "ui.installStart": "설치 시작",
      "ui.agentPyEnv": "{name} 전용 Python 환경 설치 중…",
      "ui.waitPrepSuffix": "환경 준비 대기",
      "ui.env": "환경",
      "ui.aiModel": "AI 모델",
      "ui.startStep": "시작",
      "ui.gpuChecking": "연산 장치 확인 중…",
      "ui.envChecking": "환경 확인 중…",
      "ui.prepError": "준비 중 오류가 발생했습니다: {msg}",
      "ui.libTorch": "라이브러리 · PyTorch",
      "ui.libGpu": "라이브러리 · GPU wheel",
      "ui.sepTitle": "보컬·MR 분리",
      "ui.demucsRun": "Demucs AI 분리 중…",
      "ui.demucsStems": "음악(MR)과 보컬 스템을 생성하고 있습니다.",
      "ui.sepQueued": "에이전트에 분리 작업을 요청했습니다.",
      "ui.enhanceTitle": "화질 향상",
      "ui.cfProcess": "CodeFormer 처리 중…",
      "ui.restoreFaces": "얼굴·디테일을 복원하고 있습니다.",
      "ui.jobRequest": "작업 요청",
      "ui.sepStart": "분리 작업 시작",
      "ui.reqAgent": "에이전트에 요청 중",
      "ui.prepFailTitle": "준비 실패",
      "ui.askInstall": "에이전트에 설치 작업을 요청하는 중…",
      "ui.needAudioPath": "오디오 파일 경로를 입력하거나 찾아보기를 이용하세요.",
      "ui.ditLoad": "DiT 모델 로딩 중…",
      "ui.lmLoad": "LM 로딩 중…",
      "ui.tidyResult": "결과 정리 중…",
      "ui.xmlBuilding": "XML 생성 중…",
      "ui.detectSilence": "무음 구간 탐지 중…",
      "ui.checkWaveform": "오디오 파형 확인 중…",
      "ui.waveformReady": "파형 준비 완료",
      "ui.waveformMeta": "파형 메타 계산 중…",
      "ui.musicGen": "음악 생성 중…",
      "ui.genDone": "생성 완료",
      "ui.pctElapsed": "{pct}% · {n}초",
      "ui.elapsedPassed": "{n}초 경과",
      "ui.secUnit": "{n}초",
      "ui.doneCompare": "처리가 완료되었습니다{dim}. 슬라이더로 결과·원본을 비교하거나 다운로드하세요.",
      "ui.previewFailOnly": "처리는 완료되었습니다. 비교 보기 실패 — 결과만 표시합니다. ({msg})",
      "ui.sepFail": "분리 실패",
      "helper.name": "IT맛집 도우미",
      "helper.needApp": "PC에서 IT맛집 도우미를 실행해 주세요",
      "helper.checking": "준비 확인 중…",
      "helper.setup": "영상 처리 도구를 준비하는 중입니다… (처음엔 시간이 걸릴 수 있습니다)",
      "helper.error": "영상 분석을 준비하지 못했습니다. 도우미를 다시 실행해 보세요.",
      "helper.analyzeNeedApp": "IT맛집 도우미를 실행한 뒤 다시 시도해 주세요.",
      "helper.pickNeedApp": "IT맛집 도우미를 실행한 뒤 파일을 선택해 주세요.",
      "helper.subtitleNeedApp": "IT맛집 도우미를 실행한 뒤 다시 시도해 주세요.",
      "helper.subtitlePrepare": "처음 자막 추출 시 AI 음성 인식 모델(약 1.6GB)과 FFmpeg를 PC에 받습니다. 잠시만 기다려 주세요.",
      "helper.subtitleBusy": "다른 작업이 끝난 뒤 다시 시도해 주세요. (전사·보내기는 한 번에 하나만 실행됩니다)",
      "helper.subtitlePick": "IT맛집 도우미를 실행한 뒤 영상·오디오 파일을 선택해 주세요.",
      "conn.circuitOpen": "에이전트 통신이 불안정하여 일시적으로 연결이 차단되었습니다. 잠시 후 다시 시도하세요.",
      "dl.noResult": "다운로드할 결과가 없습니다. 편집 화면에서 먼저 작업을 완료해 주세요.",
      "dl.noPath": "결과 파일 경로가 저장되지 않았습니다.",
      "dl.source": "원본: {name}",
      "dl.output": "출력: {label}",
      "dl.formatLine": "포맷: {fmt}",
      "dl.autoStart": "{n}초 후 자동으로 다운로드됩니다…",
      "dl.started": "다운로드가 시작되었습니다. 다시 받으려면 버튼을 클릭하세요.",
      "dl.startedNamed": "{label} 다운로드가 시작되었습니다.",
      "dl.back": "편집 화면으로 돌아가기",
      "dl.docTitle": "{tool} · 다운로드",
      "ui.file": "파일",
      "ui.folder": "폴더",
      "ui.folderPh": "폴더 경로",
      "ui.sourceMode": "선택 방식",
      "ui.openFolder": "결과 폴더 열기",
      "ui.brushTool": "브러시",
      "ui.eraserTool": "지우개",
      "ui.dtFolder": "폴더",
      "ui.maskPainted": "칠해짐",
      "ui.none": "없음",
      "ui.rect": "사각형",
      "ui.circle": "원형",
      "ui.width": "가로",
      "ui.height": "세로",
      "ui.maskSet": "지정됨",
      "ui.region": "영역",
      "conn.checking": "에이전트 연결 확인 중…",
      "conn.ok": "에이전트 연결됨",
      "conn.down": "에이전트 미연결",
      "conn.blocked": "에이전트 연결 차단됨",
      "conn.apiFailed": "에이전트 API 시작 실패",
      "conn.busy": "에이전트 작업 중",
      "conn.apiLoading": "에이전트 API 로딩 중",
      "conn.apiPrep": "에이전트 API 준비 중"
    },
    en: {
      "chrome.dashboard": "Dashboard",
      "chrome.themeLight": "Dark mode",
      "chrome.themeDark": "Light mode",
      "chrome.themeToDark": "Switch to dark mode",
      "chrome.themeToLight": "Switch to light mode",
      "footer.home": "Home",
      "footer.policy": "Terms of use",
      "footer.email": "No email harvesting",
      "footer.copyright": "Copyright",
      "footer.disclaimer": "Disclaimer",
      "footer.about": "About ItMatzipTools",
      "footer.nav": "Site",
      "ad.label": "Advertisement",
      "modal.title": "Notice",
      "modal.ok": "OK",
      "modal.reload": "Refresh",
      "modal.retry": "Check connection again",
      "modal.checking": "Checking connection…",
      "modal.connected": "Connected.",
      "modal.notConnected": "Still not connected. ({err})",
      "modal.checkFailed": "Check failed: {msg}",
      "modal.cannotConnect": "Cannot connect",
      "adblock.title": "Ads are blocked",
      "adblock.titleBrave": "Ads are blocked (Brave Shields, etc.)",
      "adblock.lead": "This site stays free through <strong>ad revenue</strong>. Ads are <strong>not showing</strong> right now.",
      "adblock.sub": "This is <strong>separate</strong> from the local agent connection. The steps below are only for <strong>showing ads</strong>.",
      "adblock.how": "How to allow ads",
      "adblock.stepBrave1": "Address bar <strong>lion (Brave) icon</strong> → turn <strong>Shields off</strong>",
      "adblock.stepBrave2": "Or keep Shields on → <strong>Advanced</strong> → allow <strong>ads and tracking</strong> for this site",
      "adblock.stepBrave3": "Press <strong>F5</strong> to refresh",
      "adblock.stepChrome1": "Ad-block <strong>extension</strong> → <strong>Allow</strong> or <strong>Pause</strong> this site",
      "adblock.stepChrome2": "Press <strong>F5</strong> to refresh",
      "agent.installTitle": "Cannot connect to the local agent",
      "agent.installFallback": "Run the ItMatZip local agent on this PC, then try connecting again.",
      "agent.download": "Download agent",
      "agent.downloadVer": "Download agent v{v}",
      "agent.intro1": "This website only provides a convenient <strong>interface</strong>. Your files are <strong>never uploaded or stored on an external server</strong>.",
      "agent.intro2": "Everything runs only on your computer, so there is no data-leak risk from our servers. To use these local features, you need to <strong>install the agent once</strong>.",
      "agent.firstTitle": "First time here?",
      "agent.firstText": "Download <strong>{pkg}</strong>{ver} below and install it. {hint}",
      "agent.msiHint": "Run the MSI, then check that the ItMatZip icon appears in the taskbar tray.",
      "agent.exeHint": "Download and run the executable to install.",
      "agent.firstNote": "After installing, click <strong>Check connection again</strong> on this page. If you <strong>uninstalled</strong> the agent or need a newer version, download the latest MSI here. (If this tab has been open a long time, press <strong>F5</strong> first.)",
      "agent.installedTitle": "Already installed?",
      "agent.installedText": "Make sure the program is running, then click <strong>Check connection again</strong> below. Right after an update, right-click the tray icon → <strong>Quit</strong>, start it again, or reboot the PC.",
      "agent.installedNote": "In Chrome, open <strong>Site settings</strong> (left of the address bar) → <strong>Local network</strong> → <strong>Allow</strong>. If the console shows <code>ERR_BLOCKED_BY_CLIENT</code>, an <strong>ad blocker</strong> is often blocking <code>127.0.0.1</code>.",
      "agent.blockTitle": "Agent communication is blocked",
      "agent.blockBrave1": "Even after allowing ads or adjusting Shields, the connection to the <strong>PC agent</strong> is still blocked.",
      "agent.blockBrave2": "Allowing ads alone often does not unblock <strong>agent traffic</strong>. You need <strong>Shields off</strong> and the ad-block <strong>extension disabled</strong>.",
      "agent.blockBraveStep1": "Address bar <strong>lion (Brave) icon</strong> → turn <strong>Shields off</strong>",
      "agent.blockBraveStep2": "Right-click the ad-block <strong>extension icon</strong> → <strong>Manage extension</strong> → <strong>Turn off</strong>",
      "agent.blockBraveStep3": "Press <strong>F5</strong>, then <strong>Check connection again</strong> below",
      "agent.blockBraveHint": "If it still fails: lock icon → Site settings → <strong>Allow local network</strong>",
      "agent.blockChrome1": "Even if ads are allowed on this site, the <strong>ad-block extension</strong> can still <strong>block the agent</strong>.",
      "agent.blockChrome2": "“Allow this site” or “Pause” is often not enough. <strong>Turn the extension off.</strong>",
      "agent.blockChromeStep1": "Right-click the <strong>ad-block extension icon</strong> in Chrome",
      "agent.blockChromeStep2": "<strong>Manage extension</strong> → <strong>Turn off</strong>",
      "agent.blockChromeStep3": "Press <strong>F5</strong>, then <strong>Check connection again</strong> below",
      "agent.blockChromeHint": "If it still fails: address-bar <strong>lock</strong> → <strong>Allow local network</strong>",
      "ui.newJob": "New job",
      "ui.prepare": "Prepare",
      "ui.checking": "Checking…",
      "ui.checkingShort": "Checking",
      "ui.device": "Device",
      "ui.deviceAuto": "Auto (recommended)",
      "ui.outputFormat": "Output format",
      "ui.jobStatus": "Job status",
      "ui.previewOriginal": "Original preview",
      "ui.compareHint": "Drag left for the original, right for the result.",
      "ui.pickImageEmpty": "Choose an image to show the original here.",
      "ui.processing": "Processing…",
      "ui.preparing": "Preparing…",
      "ui.cpu": "CPU",
      "ui.gpu": "GPU (CUDA)",
      "ui.previewCompare": "Original / result",
      "ui.previewCompareSlider": "Original ↔ result",
      "ui.original": "Original",
      "ui.result": "Result",
      "ui.pickBusy": "Dialog…",
      "ui.pathPh": "File path",
      "ui.model": "Model",
      "ui.ready": "Ready",
      "ui.readyOk": "Ready",
      "ui.notReady": "Not ready",
      "ui.deviceShort": "Device",
      "ui.options": "Options",
      "ui.auto": "Auto",
      "ui.fp16Fast": "Faster on GPU",
      "ui.default": "Default",
      "ui.envCheck": "Checking setup",
      "ui.downloadResult": "Download result",
    "ui.gpuCuda": "GPU · CUDA",
    "ui.gpuCudaReady": "GPU · CUDA ready",
    "ui.gpuDetectNoCuda": "GPU found · CUDA unused",
    "ui.gpuCudaInstallHint": "Run Prepare again to install CUDA wheels.",
    "ui.cpuNoNvidia": "Without an NVIDIA GPU, processing runs on CPU.",
    "ui.phaseRun": "Running",
    "ui.phaseDone": "Done",
    "ui.phaseFail": "Failed",
    "ui.prepFail": "Prepare failed",
    "ui.readyCheckFail": "Could not check readiness",
      "ui.moving": "Moving…",
      "ui.installStart": "Starting install",
      "ui.agentPyEnv": "{name} Python environment is being installed…",
      "ui.waitPrepSuffix": "waiting to prepare",
      "ui.env": "Setup",
      "ui.aiModel": "AI model",
      "ui.startStep": "Start",
      "ui.gpuChecking": "Checking compute device…",
      "ui.envChecking": "Checking setup…",
      "ui.prepError": "An error occurred during setup: {msg}",
      "ui.libTorch": "Libraries · PyTorch",
      "ui.libGpu": "Libraries · GPU wheel",
      "ui.sepTitle": "Vocal / MR split",
      "ui.demucsRun": "Demucs AI separating…",
      "ui.demucsStems": "Building the instrumental and vocal stems.",
      "ui.sepQueued": "Separation was sent to the agent.",
      "ui.enhanceTitle": "Enhance",
      "ui.cfProcess": "CodeFormer is processing…",
      "ui.restoreFaces": "Restoring faces and detail.",
      "ui.jobRequest": "Job request",
      "ui.sepStart": "Starting separation",
      "ui.reqAgent": "Requesting the agent",
      "ui.prepFailTitle": "Prepare failed",
      "ui.askInstall": "Asking the agent to install…",
      "ui.needAudioPath": "Enter an audio path or use Browse.",
      "ui.ditLoad": "Loading the DiT model…",
      "ui.lmLoad": "Loading the LM…",
      "ui.tidyResult": "Finishing the result…",
      "ui.xmlBuilding": "Generating XML…",
      "ui.detectSilence": "Detecting silent regions…",
      "ui.checkWaveform": "Checking the audio waveform…",
      "ui.waveformReady": "Waveform ready",
      "ui.waveformMeta": "Computing waveform metadata…",
      "ui.musicGen": "Generating music…",
      "ui.genDone": "Generation complete",
      "ui.pctElapsed": "{pct}% · {n}s",
      "ui.elapsedPassed": "{n}s elapsed",
      "ui.secUnit": "{n}s",
      "ui.doneCompare": "Done{dim}. Use the slider to compare, or download.",
      "ui.previewFailOnly": "Done, but compare failed — showing the result only. ({msg})",
      "ui.sepFail": "Separation failed",
      "helper.name": "ItMatZip Helper",
      "helper.needApp": "Run ItMatZip Helper on this PC",
      "helper.checking": "Checking setup…",
      "helper.setup": "Preparing the media tools… (first run can take a while)",
      "helper.error": "Could not prepare analysis. Start the helper and try again.",
      "helper.analyzeNeedApp": "Start ItMatZip Helper, then try again.",
      "helper.pickNeedApp": "Start ItMatZip Helper, then pick a file.",
      "helper.subtitleNeedApp": "Start ItMatZip Helper, then try again.",
      "helper.subtitlePrepare": "The first subtitle run downloads the speech model (~1.6GB) and FFmpeg. Please wait.",
      "helper.subtitleBusy": "Wait for the other job to finish. Only one transcribe or send job runs at a time.",
      "helper.subtitlePick": "Start ItMatZip Helper, then pick a video or audio file.",
      "conn.circuitOpen": "Agent communication is unstable, so the connection was paused. Try again in a moment.",
      "dl.noResult": "No result to download. Finish the job on the editor first.",
      "dl.noPath": "Result file path was not saved.",
      "dl.source": "Source: {name}",
      "dl.output": "Output: {label}",
      "dl.formatLine": "Format: {fmt}",
      "dl.autoStart": "Download starts automatically in {n}s…",
      "dl.started": "Download started. Click the button to save again.",
      "dl.startedNamed": "{label} download started.",
      "dl.back": "Back to editor",
      "dl.docTitle": "{tool} · Download",
      "ui.file": "File",
      "ui.folder": "Folder",
      "ui.folderPh": "Folder path",
      "ui.sourceMode": "Source type",
      "ui.openFolder": "Open result folder",
      "ui.brushTool": "Brush",
      "ui.eraserTool": "Eraser",
      "ui.dtFolder": "Folder",
      "ui.maskPainted": "Painted",
      "ui.none": "None",
      "ui.rect": "Rectangle",
      "ui.circle": "Circle",
      "ui.width": "Width",
      "ui.height": "Height",
      "ui.maskSet": "Set",
      "ui.region": "Region",
      "conn.checking": "Checking agent…",
      "conn.ok": "Agent connected",
      "conn.down": "Agent offline",
      "conn.blocked": "Agent blocked",
      "conn.apiFailed": "Agent API failed to start",
      "conn.busy": "Agent busy",
      "conn.apiLoading": "Agent API loading",
      "conn.apiPrep": "Agent API preparing"
    },
    ja: {
      "chrome.dashboard": "ダッシュボード",
      "chrome.themeLight": "ダークモード",
      "chrome.themeDark": "ライトモード",
      "chrome.themeToDark": "ダークモードに切り替え",
      "chrome.themeToLight": "ライトモードに切り替え",
      "footer.home": "ホーム",
      "footer.policy": "利用規約",
      "footer.email": "メールアドレス無断収集の拒否",
      "footer.copyright": "著作権",
      "footer.disclaimer": "免責事項",
      "footer.about": "ItMatzipToolsについて",
      "footer.nav": "サイト案内",
      "ad.label": "広告",
      "modal.title": "お知らせ",
      "modal.ok": "OK",
      "modal.reload": "再読み込み",
      "modal.retry": "再接続を確認",
      "modal.checking": "接続を確認しています…",
      "modal.connected": "接続しました。",
      "modal.notConnected": "まだ接続されていません。({err})",
      "modal.checkFailed": "確認に失敗しました: {msg}",
      "modal.cannotConnect": "接続できません",
      "adblock.title": "広告がブロックされています",
      "adblock.titleBrave": "広告がブロックされています（Brave Shields など）",
      "adblock.lead": "このサイトは<strong>広告収益</strong>で無料運営しています。いま<strong>広告が表示されていません</strong>。",
      "adblock.sub": "PCプログラム（エージェント）接続の問題とは<strong>別</strong>です。以下は<strong>広告表示</strong>のための案内です。",
      "adblock.how": "広告を許可する方法",
      "adblock.stepBrave1": "アドレスバーの<strong>ライオン（Brave）アイコン</strong> → <strong>Shields をオフ</strong>",
      "adblock.stepBrave2": "または Shields をオンのまま<strong>詳細</strong> → このサイトで<strong>広告・トラッキングを許可</strong>",
      "adblock.stepBrave3": "<strong>F5</strong>で再読み込み",
      "adblock.stepChrome1": "広告ブロック<strong>拡張</strong> → このサイトを<strong>許可</strong>または<strong>一時停止</strong>",
      "adblock.stepChrome2": "<strong>F5</strong>で再読み込み",
      "agent.installTitle": "ローカルエージェントに接続できません",
      "agent.installFallback": "PCで ItMatZip ローカルエージェントを実行してから、もう一度接続してください。",
      "agent.download": "エージェントをダウンロード",
      "agent.downloadVer": "エージェントをダウンロード v{v}",
      "agent.intro1": "本サイトは便利に使うための<strong>画面（インターフェース）</strong>だけを提供し、大切なデータは<strong>外部サーバーにアップロード・保存しません</strong>。",
      "agent.intro2": "すべての処理はお使いのPCの中だけで実行されるため、サーバーからの情報漏えいの心配はありません。このローカル機能を使うには<strong>専用プログラム（エージェント）の初回インストール</strong>が必要です。",
      "agent.firstTitle": "初めて利用しますか？",
      "agent.firstText": "下の <strong>{pkg}</strong>{ver} を入手してインストールしてください。 {hint}",
      "agent.msiHint": "MSIを実行してインストールし、タスクバーのトレイに ItMatZip アイコンが出るか確認してください。",
      "agent.exeHint": "実行ファイルを入手して実行するとインストールされます。",
      "agent.firstNote": "インストール後、このページで<strong>再接続を確認</strong>を押してください。エージェントを<strong>削除</strong>したあとやバージョン更新時も、ここで最新の MSI を入手できます。（タブを長く開いていた場合は<strong>F5</strong>してからダウンロードしてください。）",
      "agent.installedTitle": "すでにインストール済みですか？",
      "agent.installedText": "プログラムが起動しているか確認してから、下の<strong>再接続を確認</strong>を押してください。更新直後はトレイアイコンを右クリック → <strong>終了</strong>して再起動するか、PCを再起動してください。",
      "agent.installedNote": "Chrome ではアドレスバー左の<strong>サイトの設定</strong> → <strong>ローカルネットワーク</strong>を<strong>許可</strong>してください。コンソールに <code>ERR_BLOCKED_BY_CLIENT</code> が出る場合、<strong>広告ブロック拡張</strong>が <code>127.0.0.1</code> を止めていることが多いです。",
      "agent.blockTitle": "エージェント通信がブロックされています",
      "agent.blockBrave1": "広告の許可や Shields の調整をしても、<strong>PCプログラム（エージェント）との接続</strong>はまだブロックされています。",
      "agent.blockBrave2": "広告だけ許可しても<strong>エージェント通信</strong>は解除されないことが多いです。<strong>Shields オフ</strong>と広告ブロック<strong>拡張の無効化</strong>が必要です。",
      "agent.blockBraveStep1": "アドレスバーの<strong>ライオン（Brave）アイコン</strong> → <strong>Shields をオフ</strong>",
      "agent.blockBraveStep2": "広告ブロック<strong>拡張アイコン</strong>を右クリック → <strong>拡張機能を管理</strong> → <strong>オフ</strong>",
      "agent.blockBraveStep3": "<strong>F5</strong>で再読み込み → 下の<strong>再接続を確認</strong>",
      "agent.blockBraveHint": "まだダメなら: 鍵アイコン → サイトの設定 → <strong>ローカルネットワークを許可</strong>",
      "agent.blockChrome1": "このサイトだけ広告を許可しても、<strong>広告ブロック拡張</strong>がエージェントとの<strong>通信を止め続けている</strong>ことがあります。",
      "agent.blockChrome2": "「このサイトを許可」「一時停止」では足りないことが多いです。<strong>拡張機能をオフにしてください。</strong>",
      "agent.blockChromeStep1": "Chrome 上部の<strong>広告ブロック拡張アイコン</strong>を右クリック",
      "agent.blockChromeStep2": "<strong>拡張機能を管理</strong> → 該当拡張を<strong>オフ</strong>",
      "agent.blockChromeStep3": "<strong>F5</strong>で再読み込み → 下の<strong>再接続を確認</strong>",
      "agent.blockChromeHint": "まだダメなら: アドレスバーの<strong>鍵</strong> → <strong>ローカルネットワークを許可</strong>",
      "ui.newJob": "新しい作業",
      "ui.prepare": "環境準備",
      "ui.checking": "確認中…",
      "ui.checkingShort": "確認中",
      "ui.device": "実行装置",
      "ui.deviceAuto": "自動（推奨）",
      "ui.outputFormat": "出力形式",
      "ui.jobStatus": "作業状態",
      "ui.previewOriginal": "元プレビュー",
      "ui.compareHint": "スライダーを左で元画像、右で結果です。",
      "ui.pickImageEmpty": "画像を選ぶとここに元画像が出ます。",
      "ui.processing": "処理中…",
      "ui.preparing": "準備中…",
      "ui.cpu": "CPU",
      "ui.gpu": "GPU (CUDA)",
      "ui.previewCompare": "元 / 結果",
      "ui.previewCompareSlider": "元 ↔ 結果",
      "ui.original": "元",
      "ui.result": "結果",
      "ui.pickBusy": "ダイアログ…",
      "ui.pathPh": "ファイルパス",
      "ui.model": "モデル",
      "ui.ready": "準備",
      "ui.readyOk": "準備完了",
      "ui.notReady": "未準備",
      "ui.deviceShort": "装置",
      "ui.options": "オプション",
      "ui.auto": "自動",
      "ui.fp16Fast": "GPUで高速",
      "ui.default": "標準",
      "ui.envCheck": "環境確認",
      "ui.downloadResult": "結果を保存",
    "ui.gpuCuda": "GPU · CUDA",
    "ui.gpuCudaReady": "GPU · CUDA 準備済み",
    "ui.gpuDetectNoCuda": "GPU検出 · CUDA未使用",
    "ui.gpuCudaInstallHint": "環境準備を再実行するとCUDA wheelを入れます。",
    "ui.cpuNoNvidia": "NVIDIA GPUがなければCPUで処理します。",
    "ui.phaseRun": "処理中",
    "ui.phaseDone": "完了",
    "ui.phaseFail": "失敗",
    "ui.prepFail": "環境準備に失敗",
    "ui.readyCheckFail": "準備状態の確認に失敗",
      "ui.moving": "移動中…",
      "ui.installStart": "インストール開始",
      "ui.agentPyEnv": "{name} 専用 Python 環境をインストールしています…",
      "ui.waitPrepSuffix": "環境準備待ち",
      "ui.env": "環境",
      "ui.aiModel": "AIモデル",
      "ui.startStep": "開始",
      "ui.gpuChecking": "演算装置を確認中…",
      "ui.envChecking": "環境を確認中…",
      "ui.prepError": "準備中にエラーが発生しました: {msg}",
      "ui.libTorch": "ライブラリ · PyTorch",
      "ui.libGpu": "ライブラリ · GPU wheel",
      "ui.sepTitle": "ボーカル / MR 分離",
      "ui.demucsRun": "Demucs AI で分離中…",
      "ui.demucsStems": "インストゥルメンタルとボーカルを作成しています。",
      "ui.sepQueued": "エージェントに分離を依頼しました。",
      "ui.enhanceTitle": "画質向上",
      "ui.cfProcess": "CodeFormer 処理中…",
      "ui.restoreFaces": "顔とディテールを復元しています。",
      "ui.jobRequest": "ジョブ要求",
      "ui.sepStart": "分離を開始",
      "ui.reqAgent": "エージェントに要求中",
      "ui.prepFailTitle": "準備失敗",
      "ui.askInstall": "エージェントにインストールを依頼しています…",
      "ui.needAudioPath": "音声パスを入力するか、参照を使ってください。",
      "ui.ditLoad": "DiT モデルを読み込み中…",
      "ui.lmLoad": "LM を読み込み中…",
      "ui.tidyResult": "結果を整理中…",
      "ui.xmlBuilding": "XML を生成中…",
      "ui.detectSilence": "無音区間を検出中…",
      "ui.checkWaveform": "オーディオ波形を確認中…",
      "ui.waveformReady": "波形の準備完了",
      "ui.waveformMeta": "波形メタを計算中…",
      "ui.musicGen": "音楽を生成中…",
      "ui.genDone": "生成完了",
      "ui.pctElapsed": "{pct}% · {n}秒",
      "ui.elapsedPassed": "{n}秒経過",
      "ui.secUnit": "{n}秒",
      "ui.doneCompare": "完了しました{dim}。スライダーで比較するか、保存してください。",
      "ui.previewFailOnly": "完了しましたが比較に失敗したため、結果のみ表示します。({msg})",
      "ui.sepFail": "分離失敗",
      "helper.name": "IT맛집 ヘルパー",
      "helper.needApp": "PCでIT맛집ヘルパーを実行してください",
      "helper.checking": "準備を確認中…",
      "helper.setup": "映像ツールを準備しています…（初回は時間がかかることがあります）",
      "helper.error": "解析の準備に失敗しました。ヘルパーを再実行してください。",
      "helper.analyzeNeedApp": "IT맛집ヘルパーを実行してから再試行してください。",
      "helper.pickNeedApp": "IT맛집ヘルパーを実行してからファイルを選んでください。",
      "helper.subtitleNeedApp": "IT맛집ヘルパーを実行してから再試行してください。",
      "helper.subtitlePrepare": "初回の字幕抽出では音声認識モデル（約1.6GB）とFFmpegをPCに入れます。しばらくお待ちください。",
      "helper.subtitleBusy": "他の作業が終わってから再試行してください。（転写・送信は同時に1件だけ）",
      "helper.subtitlePick": "IT맛집ヘルパーを実行してから映像・音声ファイルを選んでください。",
      "conn.circuitOpen": "エージェント通信が不安定なため、接続を一時停止しました。しばらくして再試行してください。",
      "dl.noResult": "ダウンロードする結果がありません。編集画面で先に作業を完了してください。",
      "dl.noPath": "結果ファイルのパスが保存されていません。",
      "dl.source": "原版: {name}",
      "dl.output": "出力: {label}",
      "dl.formatLine": "形式: {fmt}",
      "dl.autoStart": "{n}秒後に自動ダウンロードします…",
      "dl.started": "ダウンロードを開始しました。もう一度保存するにはボタンを押してください。",
      "dl.startedNamed": "{label} のダウンロードを開始しました。",
      "dl.back": "編集画面に戻る",
      "dl.docTitle": "{tool} · ダウンロード",
      "ui.file": "ファイル",
      "ui.folder": "フォルダ",
      "ui.folderPh": "フォルダパス",
      "ui.sourceMode": "選択方法",
      "ui.openFolder": "結果フォルダを開く",
      "ui.brushTool": "ブラシ",
      "ui.eraserTool": "消しゴム",
      "ui.dtFolder": "フォルダ",
      "ui.maskPainted": "塗済み",
      "ui.none": "なし",
      "ui.rect": "四角形",
      "ui.circle": "円",
      "ui.width": "横",
      "ui.height": "縦",
      "ui.maskSet": "指定済み",
      "ui.region": "範囲",
      "conn.checking": "エージェント確認中…",
      "conn.ok": "エージェント接続済み",
      "conn.down": "エージェント未接続",
      "conn.blocked": "エージェント接続が遮断",
      "conn.apiFailed": "エージェントAPI起動失敗",
      "conn.busy": "エージェント作業中",
      "conn.apiLoading": "エージェントAPI読込中",
      "conn.apiPrep": "エージェントAPI準備中"
    },
    zh: {
      "chrome.dashboard": "返回首页",
      "chrome.themeLight": "深色模式",
      "chrome.themeDark": "浅色模式",
      "chrome.themeToDark": "切换到深色模式",
      "chrome.themeToLight": "切换到浅色模式",
      "footer.home": "首页",
      "footer.policy": "使用条款",
      "footer.email": "禁止擅自收集邮箱",
      "footer.copyright": "版权",
      "footer.disclaimer": "免责声明",
      "footer.about": "关于 ItMatzipTools",
      "footer.nav": "网站信息",
      "ad.label": "广告",
      "modal.title": "提示",
      "modal.ok": "确定",
      "modal.reload": "刷新",
      "modal.retry": "重新检查连接",
      "modal.checking": "正在检查连接…",
      "modal.connected": "已连接。",
      "modal.notConnected": "仍未连接。({err})",
      "modal.checkFailed": "检查失败：{msg}",
      "modal.cannotConnect": "无法连接",
      "adblock.title": "广告已被拦截",
      "adblock.titleBrave": "广告已被拦截（Brave Shields 等）",
      "adblock.lead": "本站靠<strong>广告收入</strong>免费运营。当前<strong>没有显示广告</strong>。",
      "adblock.sub": "这与电脑程序（代理）连接<strong>无关</strong>。以下步骤只用于<strong>显示广告</strong>。",
      "adblock.how": "如何允许广告",
      "adblock.stepBrave1": "地址栏<strong>狮子（Brave）图标</strong> → <strong>关闭 Shields</strong>",
      "adblock.stepBrave2": "或保持 Shields 开启 → <strong>高级</strong> → 允许本站<strong>广告和跟踪</strong>",
      "adblock.stepBrave3": "按 <strong>F5</strong> 刷新",
      "adblock.stepChrome1": "广告拦截<strong>扩展</strong> → 对本站<strong>允许</strong>或<strong>暂停</strong>",
      "adblock.stepChrome2": "按 <strong>F5</strong> 刷新",
      "agent.installTitle": "无法连接到本地代理",
      "agent.installFallback": "请先在电脑上运行 ItMatZip 本地代理，然后再试一次。",
      "agent.download": "下载代理",
      "agent.downloadVer": "下载代理 v{v}",
      "agent.intro1": "本网站只提供方便使用的<strong>界面</strong>，您的文件<strong>绝不会上传或存储到外部服务器</strong>。",
      "agent.intro2": "所有功能都只在您的电脑内运行，不存在从我们服务器泄露资料的风险。要使用这些本地功能，需要<strong>首次安装专用程序（代理）</strong>。",
      "agent.firstTitle": "第一次使用？",
      "agent.firstText": "请下载并安装下方的 <strong>{pkg}</strong>{ver}。{hint}",
      "agent.msiHint": "运行 MSI 安装后，请确认任务栏托盘出现 ItMatZip 图标。",
      "agent.exeHint": "下载并运行安装程序即可。",
      "agent.firstNote": "安装后请在本页点击<strong>重新检查连接</strong>。如果<strong>卸载</strong>了代理或需要更新版本，也请在这里下载最新 MSI。（标签页开太久时，请先按 <strong>F5</strong> 再下载。）",
      "agent.installedTitle": "已经安装过？",
      "agent.installedText": "请确认程序正在运行，然后点击下方的<strong>重新检查连接</strong>。更新后请右键托盘图标 → <strong>退出</strong>再启动，或重启电脑。",
      "agent.installedNote": "Chrome 请打开地址栏左侧<strong>网站设置</strong> → <strong>本地网络</strong> → <strong>允许</strong>。如果控制台出现 <code>ERR_BLOCKED_BY_CLIENT</code>，多半是<strong>广告拦截扩展</strong>拦截了 <code>127.0.0.1</code>。",
      "agent.blockTitle": "代理通信被拦截",
      "agent.blockBrave1": "即使已允许广告或调整了 Shields，与<strong>电脑程序（代理）的连接</strong>仍被拦截。",
      "agent.blockBrave2": "只允许广告往往无法打通<strong>代理通信</strong>。需要<strong>关闭 Shields</strong>，并<strong>关闭广告拦截扩展</strong>。",
      "agent.blockBraveStep1": "地址栏<strong>狮子（Brave）图标</strong> → <strong>关闭 Shields</strong>",
      "agent.blockBraveStep2": "右键广告拦截<strong>扩展图标</strong> → <strong>管理扩展</strong> → <strong>关闭</strong>",
      "agent.blockBraveStep3": "按 <strong>F5</strong> 刷新 → 再点下方<strong>重新检查连接</strong>",
      "agent.blockBraveHint": "仍不行：锁图标 → 网站设置 → <strong>允许本地网络</strong>",
      "agent.blockChrome1": "即使只对本站解除广告拦截，<strong>广告拦截扩展</strong>仍可能<strong>继续拦截代理通信</strong>。",
      "agent.blockChrome2": "“允许此网站”“暂停”往往不够。<strong>请关闭该扩展。</strong>",
      "agent.blockChromeStep1": "右键 Chrome 上的<strong>广告拦截扩展图标</strong>",
      "agent.blockChromeStep2": "<strong>管理扩展</strong> → <strong>关闭</strong>该扩展",
      "agent.blockChromeStep3": "按 <strong>F5</strong> 刷新 → 再点下方<strong>重新检查连接</strong>",
      "agent.blockChromeHint": "仍不行：地址栏<strong>锁</strong> → <strong>允许本地网络</strong>",
      "ui.newJob": "开始新任务",
      "ui.prepare": "准备环境",
      "ui.checking": "检查中…",
      "ui.checkingShort": "检查中",
      "ui.device": "运行设备",
      "ui.deviceAuto": "自动（推荐）",
      "ui.outputFormat": "输出格式",
      "ui.jobStatus": "作业状态",
      "ui.previewOriginal": "原图预览",
      "ui.compareHint": "滑块向左看原图，向右看结果。",
      "ui.pickImageEmpty": "选择图片后会在这里显示原图。",
      "ui.processing": "处理中…",
      "ui.preparing": "准备中…",
      "ui.cpu": "CPU",
      "ui.gpu": "GPU (CUDA)",
      "ui.previewCompare": "原图 / 结果",
      "ui.previewCompareSlider": "原图 ↔ 结果",
      "ui.original": "原图",
      "ui.result": "结果",
      "ui.pickBusy": "对话框…",
      "ui.pathPh": "文件路径",
      "ui.model": "模型",
      "ui.ready": "准备",
      "ui.readyOk": "已就绪",
      "ui.notReady": "未就绪",
      "ui.deviceShort": "设备",
      "ui.options": "选项",
      "ui.auto": "自动",
      "ui.fp16Fast": "GPU 上更快",
      "ui.default": "默认",
      "ui.envCheck": "检查环境",
      "ui.downloadResult": "下载结果",
    "ui.gpuCuda": "GPU · CUDA",
    "ui.gpuCudaReady": "GPU · CUDA 已就绪",
    "ui.gpuDetectNoCuda": "检测到 GPU · 未用 CUDA",
    "ui.gpuCudaInstallHint": "再次运行环境准备即可安装 CUDA wheel。",
    "ui.cpuNoNvidia": "没有 NVIDIA GPU 时会用 CPU 处理。",
    "ui.phaseRun": "处理中",
    "ui.phaseDone": "完成",
    "ui.phaseFail": "失败",
    "ui.prepFail": "环境准备失败",
    "ui.readyCheckFail": "无法检查准备状态",
      "ui.moving": "正在跳转…",
      "ui.installStart": "开始安装",
      "ui.agentPyEnv": "正在安装 {name} 专用 Python 环境…",
      "ui.waitPrepSuffix": "等待准备环境",
      "ui.env": "环境",
      "ui.aiModel": "AI 模型",
      "ui.startStep": "开始",
      "ui.gpuChecking": "正在检查运算设备…",
      "ui.envChecking": "正在检查环境…",
      "ui.prepError": "准备时出错：{msg}",
      "ui.libTorch": "库 · PyTorch",
      "ui.libGpu": "库 · GPU wheel",
      "ui.sepTitle": "人声 / 伴奏分离",
      "ui.demucsRun": "Demucs AI 分离中…",
      "ui.demucsStems": "正在生成伴奏与人声分轨。",
      "ui.sepQueued": "已向代理提交分离任务。",
      "ui.enhanceTitle": "提升画质",
      "ui.cfProcess": "CodeFormer 处理中…",
      "ui.restoreFaces": "正在恢复面部与细节。",
      "ui.jobRequest": "任务请求",
      "ui.sepStart": "开始分离",
      "ui.reqAgent": "正在请求代理",
      "ui.prepFailTitle": "准备失败",
      "ui.askInstall": "正在请代理安装…",
      "ui.needAudioPath": "请输入音频路径，或使用浏览。",
      "ui.ditLoad": "正在加载 DiT 模型…",
      "ui.lmLoad": "正在加载 LM…",
      "ui.tidyResult": "正在整理结果…",
      "ui.xmlBuilding": "正在生成 XML…",
      "ui.detectSilence": "正在检测静音段…",
      "ui.checkWaveform": "正在检查音频波形…",
      "ui.waveformReady": "波形已就绪",
      "ui.waveformMeta": "正在计算波形元数据…",
      "ui.musicGen": "正在生成音乐…",
      "ui.genDone": "生成完成",
      "ui.pctElapsed": "{pct}% · {n}秒",
      "ui.elapsedPassed": "已过 {n} 秒",
      "ui.secUnit": "{n}秒",
      "ui.doneCompare": "已完成{dim}。可用滑块对比，或下载。",
      "ui.previewFailOnly": "已完成，但对比失败，仅显示结果。({msg})",
      "ui.sepFail": "分离失败",
      "helper.name": "IT맛집 助手",
      "helper.needApp": "请在本机运行 IT맛집 助手",
      "helper.checking": "正在检查准备状态…",
      "helper.setup": "正在准备影像处理工具…（首次可能较久）",
      "helper.error": "未能准备分析。请重新运行助手后再试。",
      "helper.analyzeNeedApp": "请先运行 IT맛집 助手，然后再试。",
      "helper.pickNeedApp": "请先运行 IT맛집 助手，再选择文件。",
      "helper.subtitleNeedApp": "请先运行 IT맛집 助手，然后再试。",
      "helper.subtitlePrepare": "首次提取字幕会下载语音识别模型（约 1.6GB）和 FFmpeg。请稍候。",
      "helper.subtitleBusy": "请等其他任务结束后再试。（转写/发送同时只能跑一个）",
      "helper.subtitlePick": "请先运行 IT맛집 助手，再选择视频或音频文件。",
      "conn.circuitOpen": "代理通信不稳定，已暂时断开。请稍后再试。",
      "dl.noResult": "没有可下载的结果。请先在编辑页完成处理。",
      "dl.noPath": "未保存结果文件路径。",
      "dl.source": "原文件：{name}",
      "dl.output": "输出：{label}",
      "dl.formatLine": "格式：{fmt}",
      "dl.autoStart": "{n} 秒后自动开始下载…",
      "dl.started": "已开始下载。若要再保存一次请点按钮。",
      "dl.startedNamed": "{label} 已开始下载。",
      "dl.back": "返回编辑页",
      "dl.docTitle": "{tool} · 下载",
      "ui.file": "文件",
      "ui.folder": "文件夹",
      "ui.folderPh": "文件夹路径",
      "ui.sourceMode": "选择方式",
      "ui.openFolder": "打开结果文件夹",
      "ui.brushTool": "画笔",
      "ui.eraserTool": "橡皮擦",
      "ui.dtFolder": "文件夹",
      "ui.maskPainted": "已涂",
      "ui.none": "无",
      "ui.rect": "矩形",
      "ui.circle": "圆形",
      "ui.width": "宽",
      "ui.height": "高",
      "ui.maskSet": "已指定",
      "ui.region": "区域",
      "conn.checking": "正在检查代理…",
      "conn.ok": "代理已连接",
      "conn.down": "代理未连接",
      "conn.blocked": "代理连接被拦截",
      "conn.apiFailed": "代理 API 启动失败",
      "conn.busy": "代理作业中",
      "conn.apiLoading": "代理 API 加载中",
      "conn.apiPrep": "代理 API 准备中"
    }
  };

  function isCrawlerUa() {
    var ua = String(navigator.userAgent || "");
    return /Googlebot|bingbot|Yeti|NaverBot|DuckDuckBot|Slurp|YandexBot|Baiduspider|facebookexternalhit|Twitterbot|kakaotalk|Discordbot|LinkedInBot/i.test(
      ua
    );
  }

  function normalizeLang(raw) {
    var s = String(raw || "").toLowerCase().replace("_", "-");
    if (s === "kr" || s.indexOf("ko") === 0) return "ko";
    if (s.indexOf("ja") === 0) return "ja";
    if (s.indexOf("zh") === 0) return "zh";
    if (s.indexOf("en") === 0) return "en";
    return "";
  }

  function readUrlLang() {
    try {
      var q = new URLSearchParams(location.search || "").get("hl");
      return normalizeLang(q);
    } catch (e) {
      return "";
    }
  }

  function readPathLang() {
    return readPathLangFrom(location.pathname || "");
  }

  function stripHlQuery() {
    try {
      var url = new URL(location.href);
      if (!url.searchParams.has("hl")) return;
      url.searchParams.delete("hl");
      var next = url.pathname + url.search + url.hash;
      if (next !== location.pathname + location.search + location.hash) {
        history.replaceState(null, "", next);
      }
    } catch (e) {
      /* ignore */
    }
  }

  function navigateToLang(lang) {
    try {
      var url = new URL(location.href);
      url.pathname = pathWithLang(lang, url.pathname);
      url.searchParams.delete("hl");
      var next = url.pathname + url.search + url.hash;
      var cur = location.pathname + location.search + location.hash;
      if (next !== cur) {
        location.assign(next);
        return true;
      }
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  function readSavedLang() {
    try {
      return normalizeLang(localStorage.getItem(SITE_LANG_KEY));
    } catch (e) {
      return "";
    }
  }

  function detectSiteLang() {
    var fromPath = readPathLang();
    if (fromPath) return fromPath;
    var fromUrl = readUrlLang();
    if (fromUrl) return fromUrl;
    if (isCrawlerUa()) return "ko";
    var saved = readSavedLang();
    if (saved) return saved;
    var list = [];
    try {
      if (typeof Intl !== "undefined" && Intl.DateTimeFormat) {
        list.push(Intl.DateTimeFormat().resolvedOptions().locale || "");
      }
    } catch (e) {
      /* ignore */
    }
    if (navigator.languages && navigator.languages.length) {
      for (var i = 0; i < navigator.languages.length; i++) list.push(navigator.languages[i]);
    }
    if (navigator.language) list.push(navigator.language);
    for (var j = 0; j < list.length; j++) {
      var n = normalizeLang(list[j]);
      if (n) return n;
    }
    return "ko";
  }

  function pageI18nId() {
    var html = document.documentElement;
    var id = (html.getAttribute("data-tool-id") || "").trim();
    var path = String(location.pathname || "");
    var rest = contentPathname(path);
    if (isAdminPath(path)) return "";
    if (id) return id;
    if (/\/legal\/([a-z]+)\.html$/i.test(rest)) {
      var m = rest.match(/\/legal\/([a-z]+)\.html$/i);
      return m ? "legal-" + m[1] : "";
    }
    if (rest === "/" || rest === "/index.html") return "hub";
    return "";
  }

  function publicPageUrl(lang) {
    var origin = PUBLIC_ORIGIN;
    try {
      if (location.hostname && !/tools\.itmatzip\.com$/i.test(location.hostname)) {
        origin = location.origin || PUBLIC_ORIGIN;
      }
    } catch (e) {
      /* ignore */
    }
    return origin + pathWithLang(lang || currentLang, location.pathname || "/");
  }

  function pagePack() {
    var id = pageI18nId();
    var pack = (id && i18nPacks[id]) || {};
    var common = COMMON_I18N[currentLang] || COMMON_I18N.ko;
    var dict = pack[currentLang] || pack.ko || {};
    var out = {};
    var k;
    for (k in common) if (Object.prototype.hasOwnProperty.call(common, k)) out[k] = common[k];
    for (k in dict) if (Object.prototype.hasOwnProperty.call(dict, k)) out[k] = dict[k];
    return out;
  }

  function t(key) {
    var pack = pagePack();
    if (pack[key]) return pack[key];
    return key;
  }

  function setMeta(selector, attr, value) {
    if (!value) return;
    var el = document.querySelector(selector);
    if (el) el.setAttribute(attr, value);
  }

  function upsertLink(rel, hreflang, href) {
    var sel = hreflang
      ? 'link[rel="' + rel + '"][hreflang="' + hreflang + '"]'
      : 'link[rel="' + rel + '"]:not([hreflang])';
    var el = document.querySelector(sel);
    if (!el) {
      el = document.createElement("link");
      el.setAttribute("rel", rel);
      if (hreflang) el.setAttribute("hreflang", hreflang);
      document.head.appendChild(el);
    }
    el.setAttribute("href", href);
  }

  function isDownloadPage() {
    return /download\.html$/i.test(contentPathname(location.pathname || ""));
  }

  function adminLangMap(map) {
    if (!map || typeof map !== "object") return "";
    var v = map[currentLang] || "";
    return typeof v === "string" ? v.trim() : "";
  }

  function adminPageMeta() {
    var cfg = window.__itzSiteConfig;
    if (!cfg) return null;
    var id = pageI18nId();
    var meta = null;
    var ogImage = "";
    var displayTitle = "";
    if (id === "hub" && cfg.hub) {
      meta = cfg.hub.meta && cfg.hub.meta[currentLang];
      ogImage = cfg.hub.ogImage || "";
    } else if (id.indexOf("legal-") === 0 && cfg.legal) {
      var legalId = id.slice(6);
      if (cfg.legal[legalId] && cfg.legal[legalId].meta) {
        meta = cfg.legal[legalId].meta[currentLang];
      }
      ogImage = (cfg.hub && cfg.hub.ogImage) || "";
    } else if (cfg.tools && cfg.tools[id]) {
      var tool = cfg.tools[id];
      if (tool.meta) meta = tool.meta[currentLang];
      ogImage = tool.ogImage || (cfg.hub && cfg.hub.ogImage) || "";
      displayTitle = adminLangMap(tool.title);
    }
    return {
      title: meta && typeof meta.title === "string" ? meta.title.trim() : "",
      description: meta && typeof meta.description === "string" ? meta.description.trim() : "",
      keywords: meta && typeof meta.keywords === "string" ? meta.keywords.trim() : "",
      ogImage: typeof ogImage === "string" ? ogImage.trim() : "",
      displayTitle: displayTitle,
    };
  }

  function applySeo() {
    var pack = pagePack();
    var admin = isDownloadPage() ? null : adminPageMeta();
    var title = (admin && admin.title) || pack.title;
    var description = (admin && admin.description) || pack.description;
    var keywords = (admin && admin.keywords) || pack.keywords;
    document.documentElement.lang = HTML_LANG[currentLang] || currentLang;
    if (title) document.title = title;
    setMeta('meta[name="description"]', "content", description);
    setMeta('meta[name="keywords"]', "content", keywords);
    setMeta('meta[property="og:title"]', "content", title);
    setMeta('meta[property="og:description"]', "content", description);
    setMeta('meta[property="og:locale"]', "content", OG_LOCALE[currentLang] || "ko_KR");
    setMeta('meta[name="twitter:title"]', "content", title);
    setMeta('meta[name="twitter:description"]', "content", description);
    var selfUrl = publicPageUrl(currentLang);
    setMeta('meta[property="og:url"]', "content", selfUrl);
    var ogImage = admin && admin.ogImage;
    if (ogImage) {
      var abs = ogImage.indexOf("http") === 0 ? ogImage : (location.origin || "") + ogImage;
      setMeta('meta[property="og:image"]', "content", abs);
      setMeta('meta[name="twitter:image"]', "content", abs);
      setMeta('meta[property="og:image:alt"]', "content", title || pack.ldName || "ItMatZip Tools");
    }
    var canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) canonical.setAttribute("href", selfUrl);

    var langs = ["ko", "en", "ja", "zh"];
    var i;
    for (i = 0; i < langs.length; i++) upsertLink("alternate", langs[i], publicPageUrl(langs[i]));
    upsertLink("alternate", "x-default", publicPageUrl("ko"));

    var ld = document.querySelector('script[type="application/ld+json"]');
    if (ld && (title || description || pack.ldName || (admin && admin.displayTitle))) {
      try {
        var data = JSON.parse(ld.textContent);
        var nodes = data["@graph"] ? data["@graph"] : [data];
        var ldName = (admin && admin.displayTitle) || pack.ldName;
        for (i = 0; i < nodes.length; i++) {
          var node = nodes[i];
          if (!node || typeof node !== "object") continue;
          if (ldName) node.name = ldName;
          if (pack.ldAlternate) node.alternateName = pack.ldAlternate;
          if (description && (node["@type"] === "WebApplication" || node["@type"] === "WebSite" || node["@type"] === "WebPage")) {
            node.description = description;
            node.inLanguage = HTML_LANG[currentLang] || currentLang;
          }
        }
        ld.textContent = JSON.stringify(data, null, 2);
      } catch (e) {
        /* ignore */
      }
    }
  }

  function applyAdminDisplayTitle() {
    if (isDownloadPage()) return;
    var admin = adminPageMeta();
    if (!admin || !admin.displayTitle) return;
    var header =
      document.querySelector(".app-header") ||
      document.querySelector(".as-topbar") ||
      document.querySelector(".hub-header") ||
      document.querySelector(".itz-legal-shell > header");
    var titleEl = header
      ? header.querySelector(".logo-title-row > h1") ||
        header.querySelector(".as-topbar-left > .as-logo") ||
        header.querySelector("h1.as-logo") ||
        header.querySelector(".header-copy > h1") ||
        header.querySelector(".hub-title-cluster > .hub-title")
      : null;
    if (titleEl) fillEl(titleEl, admin.displayTitle);
  }

  function fillEl(el, value) {
    if (!el || value == null || value === "") return;
    if (String(value).indexOf("<") !== -1) el.innerHTML = value;
    else el.textContent = value;
  }

  function applyToolGuide(pack) {
    var guide = document.querySelector("section.tool-guide");
    if (!guide) return;
    var kicker = guide.querySelector(".tool-guide-kicker");
    if (kicker && pack["guide.kicker"]) kicker.textContent = pack["guide.kicker"];
    var h2 = guide.querySelector("h2");
    if (h2 && pack["guide.h2"]) h2.textContent = pack["guide.h2"];
    var lead = guide.querySelector(".tool-guide-lead");
    if (lead && pack["guide.lead"]) lead.textContent = pack["guide.lead"];
    var h3s = guide.querySelectorAll("h3");
    if (h3s[0] && pack["guide.what.h"]) h3s[0].textContent = pack["guide.what.h"];
    if (h3s[1] && pack["guide.how.h"]) h3s[1].textContent = pack["guide.how.h"];
    if (h3s[2] && pack["guide.plus.h"]) h3s[2].textContent = pack["guide.plus.h"];
    var whatP = guide.querySelector("h3 + p");
    if (whatP && pack["guide.what.p"]) whatP.textContent = pack["guide.what.p"];
    var howItems = guide.querySelectorAll("ol > li");
    var hi;
    for (hi = 0; hi < howItems.length; hi++) {
      fillEl(howItems[hi], pack["guide.how" + (hi + 1)]);
    }
    var plusItems = guide.querySelectorAll("ul > li");
    var pi;
    for (pi = 0; pi < plusItems.length; pi++) {
      fillEl(plusItems[pi], pack["guide.plus" + (pi + 1)]);
    }
    var note = guide.querySelector(".tool-guide-note");
    if (note && pack["guide.note"]) note.textContent = pack["guide.note"];
    if (pack["guide.aria"]) guide.setAttribute("aria-label", pack["guide.aria"]);
  }

  function applyMarked(pack) {
    var admin = adminPageMeta();
    var skipH1 = !!(admin && admin.displayTitle);
    var nodes = document.querySelectorAll("[data-i18n]");
    var i;
    for (i = 0; i < nodes.length; i++) {
      if (skipH1 && String(nodes[i].tagName || "").toLowerCase() === "h1") continue;
      var id = nodes[i].id || "";
      if (id === "bin-readiness" || id === "compute-capability" || id === "connection-status" || id === "summary-model-ready") continue;
      var key = nodes[i].getAttribute("data-i18n");
      if (key && pack[key] != null) fillEl(nodes[i], pack[key]);
    }
    nodes = document.querySelectorAll("[data-i18n-placeholder]");
    for (i = 0; i < nodes.length; i++) {
      var pk = nodes[i].getAttribute("data-i18n-placeholder");
      if (pk && pack[pk] != null) nodes[i].setAttribute("placeholder", pack[pk]);
    }
    nodes = document.querySelectorAll("[data-i18n-title]");
    for (i = 0; i < nodes.length; i++) {
      var tk = nodes[i].getAttribute("data-i18n-title");
      if (tk && pack[tk] != null) nodes[i].setAttribute("title", pack[tk]);
    }
    nodes = document.querySelectorAll("[data-i18n-aria]");
    for (i = 0; i < nodes.length; i++) {
      var ak = nodes[i].getAttribute("data-i18n-aria");
      if (ak && pack[ak] != null) nodes[i].setAttribute("aria-label", pack[ak]);
    }
    nodes = document.querySelectorAll("[data-i18n-alt]");
    for (i = 0; i < nodes.length; i++) {
      var altk = nodes[i].getAttribute("data-i18n-alt");
      if (altk && pack[altk] != null) nodes[i].setAttribute("alt", pack[altk]);
    }
  }

  function applyBind(pack) {
    var id = pageI18nId();
    var list = (id && i18nBind[id]) || [];
    var i;
    for (i = 0; i < list.length; i++) {
      var sel = list[i][0];
      var key = list[i][1];
      var mode = list[i][2] || "";
      if (!sel || pack[key] == null) continue;
      if (mode === "all") {
        var nodes = document.querySelectorAll(sel);
        var n;
        for (n = 0; n < nodes.length; n++) fillEl(nodes[n], pack[key]);
      } else if (mode === "title") {
        var elT = document.querySelector(sel);
        if (elT) elT.setAttribute("title", pack[key]);
      } else if (mode === "aria") {
        var elA = document.querySelector(sel);
        if (elA) elA.setAttribute("aria-label", pack[key]);
      } else if (mode === "placeholder") {
        var elP = document.querySelector(sel);
        if (elP) elP.setAttribute("placeholder", pack[key]);
      } else {
        var el = document.querySelector(sel);
        if (el) fillEl(el, pack[key]);
      }
    }
  }

  function fillAll(sel, value) {
    if (!value) return;
    var nodes = document.querySelectorAll(sel);
    var i;
    for (i = 0; i < nodes.length; i++) fillEl(nodes[i], value);
  }

  function applyChromeLang(lang) {
    currentLang = lang || currentLang;
    var pack = pagePack();
    var hub = "/" + (LANG_TO_URL_PREFIX[currentLang] || "kr") + "/";
    var dash = document.querySelectorAll("a.btn-to-dashboard");
    var i;
    for (i = 0; i < dash.length; i++) {
      dash[i].setAttribute("href", hub);
      if (!dash[i].getAttribute("data-i18n") || pack[dash[i].getAttribute("data-i18n")]) {
        var key = dash[i].getAttribute("data-i18n") || "chrome.dashboard";
        if (pack[key]) dash[i].textContent = pack[key];
        else if (pack["chrome.dashboard"]) dash[i].textContent = pack["chrome.dashboard"];
      }
    }
    var ads = document.querySelectorAll('[aria-label="광고"], [aria-label="Advertisement"], .editor-ad, .hub-ad-banner');
    for (i = 0; i < ads.length; i++) {
      if (pack["ad.label"] && ads[i].hasAttribute("aria-label")) {
        ads[i].setAttribute("aria-label", pack["ad.label"]);
      }
    }
  }

  var applyingI18n = false;
  function applyI18nDom() {
    if (applyingI18n) return;
    applyingI18n = true;
    try {
    var pack = pagePack();
    applySeo();
    applyMarked(pack);
    applyBind(pack);
    applyToolGuide(pack);
    var tagline = document.querySelector("p.header-tagline");
    if (tagline && pack.tagline && !tagline.getAttribute("data-i18n")) fillEl(tagline, pack.tagline);
    var hubLead = document.querySelector("p.hub-lead");
    if (hubLead && pack.lead) fillEl(hubLead, pack.lead);
    var menuLabel = document.querySelector(".hub-mobile-menu-label");
    if (menuLabel && pack.mobileMenu) fillEl(menuLabel, pack.mobileMenu);
    var hubSearch = document.querySelector("#hub-search");
    if (hubSearch && pack.searchPh) hubSearch.setAttribute("placeholder", pack.searchPh);
    var mobTitle = document.getElementById("mobile-only-title");
    if (mobTitle && pack.mobileTitle) fillEl(mobTitle, pack.mobileTitle);
    var mobDesc = document.querySelector(".mobile-only-desc");
    if (mobDesc && pack.mobileDesc) fillEl(mobDesc, pack.mobileDesc);
    var pathHint = document.getElementById("path-hint");
    if (pathHint && pack.pathHint && !pathHint.getAttribute("data-i18n-state")) fillEl(pathHint, pack.pathHint);
    var browseBtns = document.querySelectorAll(".btn-pick-file, #btn-pick-local-file");
    var bi;
    for (bi = 0; bi < browseBtns.length; bi++) {
      if (browseBtns[bi].disabled || browseBtns[bi].getAttribute("data-i18n-busy")) continue;
      if (pack.browse) fillEl(browseBtns[bi], pack.browse);
    }
    if (pack.analyze) {
      var analyze = document.getElementById("btn-start-separation") || document.getElementById("btn-analyze");
      if (analyze && !analyze.disabled && !document.body.classList.contains("analyze-overlay-open")) {
        fillEl(analyze, pack.analyze);
      }
    }
    var exportLink = document.getElementById("export-link");
    if (exportLink && pack.download) {
      var icon = exportLink.querySelector(".icon");
      exportLink.textContent = "";
      if (icon) exportLink.appendChild(icon);
      exportLink.appendChild(document.createTextNode(" " + pack.download));
    }
    applyChromeLang(currentLang);
    fillAll(".btn-new-job", pack["ui.newJob"]);
    fillAll("#btn-prepare, button.btn-prepare", pack["ui.prepare"]);
    fillAll("label[for='device-select']", pack["ui.device"]);
    fillAll("#device-select option[value='auto']", pack["ui.deviceAuto"]);
    fillAll("label[for='output-format']", pack["ui.outputFormat"]);
    fillAll(".preview-panel-heading:not([data-preview-mode='compare']), #preview-panel-heading:not([data-preview-mode='compare'])", pack["ui.previewOriginal"]);
    fillAll(".preview-panel-heading[data-preview-mode='compare'], #preview-panel-heading[data-preview-mode='compare']", pack["ui.previewCompare"] || pack["ui.previewCompareSlider"]);
    fillAll(".compare-label--original", pack["ui.original"]);
    fillAll(".compare-label--result", pack["ui.result"]);
    fillAll(".compare-hint", pack["ui.compareHint"]);
    fillAll(".preview-empty p, .preview-placeholder p", pack["ui.pickImageEmpty"]);
    fillAll("#setup-loading-message", pack["ui.preparing"]);
    fillAll("#enhance-loading-message, #remove-loading-message, #erase-loading-message, #convert-loading-message", pack["ui.processing"]);
    var modelReady = document.getElementById("summary-model-ready");
    if (modelReady && (modelReady.textContent === "확인 중" || modelReady.textContent === "Checking" || modelReady.textContent === "確認中" || modelReady.textContent === "检查中" || modelReady.textContent === pack["ui.checkingShort"])) {
      fillEl(modelReady, pack["ui.checkingShort"]);
    }
    syncLangSelect();
    syncThemeToggles();
    refreshFooter();
    applyAdminDisplayTitle();
    if (typeof document !== "undefined" && document.body) {
      document.dispatchEvent(new CustomEvent("itz:lang-change", { detail: { lang: currentLang } }));
    }
    } finally {
      applyingI18n = false;
    }
  }

  function persistLang(lang) {
    try {
      localStorage.setItem(SITE_LANG_KEY, lang);
    } catch (e) {
      /* ignore */
    }
  }

  function setSiteLang(lang, persist) {
    var next = normalizeLang(lang) || "ko";
    if (persist) persistLang(next);
    if (persist && !isAdminPath() && navigateToLang(next)) return;
    currentLang = next;
    applyI18nDom();
  }

  function syncLangSelect() {
    var sel = document.getElementById("lang-select");
    if (sel && sel.value !== currentLang) sel.value = currentLang;
  }

  function bindLangSelect(sel) {
    if (!sel || sel.getAttribute("data-itz-lang-bound") === "1") return;
    sel.setAttribute("data-itz-lang-bound", "1");
    sel.addEventListener("change", function () {
      setSiteLang(sel.value, true);
    });
  }

  function runtimeScriptSrc() {
    if (document.currentScript && document.currentScript.src) return document.currentScript.src;
    var scripts = document.getElementsByTagName("script");
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i].getAttribute("src") || "";
      if (s.indexOf("site-runtime.js") !== -1) return scripts[i].src || s;
    }
    return "";
  }

  function loadPublicSeoConfig() {
    fetch("/admin/api.php?action=public", { cache: "no-store", credentials: "same-origin" })
      .then(function (res) {
        return res.ok ? res.json() : Promise.reject();
      })
      .then(function (data) {
        if (data && data.ok && data.config) {
          window.__itzSiteConfig = data.config;
          applySeo();
          applyAdminDisplayTitle();
          if (document.body) {
            document.dispatchEvent(new CustomEvent("itz:lang-change", { detail: { lang: currentLang } }));
          }
        }
      })
      .catch(function () {
        /* ignore */
      });
  }

  function loadPageCatalog() {
    var id = pageI18nId();
    if (!id) {
      catalogReady = true;
      applyI18nDom();
      return;
    }
    var src = runtimeScriptSrc();
    var href = "common/i18n/" + id + ".js?v=13";
    if (src) href = src.replace(/site-runtime\.js[^/]*$/, "i18n/" + id + ".js?v=13");
    var el = document.createElement("script");
    el.src = href;
    el.onload = function () {
      catalogReady = true;
      applySeo();
      if (document.body) applyI18nDom();
    };
    el.onerror = function () {
      var fallback = href.replace(/-download\.js/, ".js");
      if (fallback !== href) {
        var el2 = document.createElement("script");
        el2.src = fallback;
        el2.onload = function () {
          catalogReady = true;
          applyI18nDom();
        };
        el2.onerror = function () {
          catalogReady = true;
          applyI18nDom();
        };
        (document.head || document.documentElement).appendChild(el2);
        return;
      }
      catalogReady = true;
      applyI18nDom();
    };
    (document.head || document.documentElement).appendChild(el);
  }

  function readSiteLang() {
    return currentLang;
  }

  function ensureLangField() {
    var existing = document.querySelector(".lang-field") || document.getElementById("lang-select");
    if (existing) {
      var field = existing;
      if (existing.id === "lang-select") {
        var parentField = existing.closest ? existing.closest(".lang-field") : null;
        if (parentField) field = parentField;
        else {
          var wrap = document.createElement("label");
          wrap.className = "lang-field";
          if (existing.parentNode) existing.parentNode.insertBefore(wrap, existing);
          wrap.appendChild(existing);
          field = wrap;
        }
      }
      var selExist = field.querySelector ? field.querySelector("select") : document.getElementById("lang-select");
      if (selExist) {
        if (!selExist.options.length) {
          for (var j = 0; j < SITE_LANGS.length; j++) {
            var o = document.createElement("option");
            o.value = SITE_LANGS[j].id;
            o.textContent = SITE_LANGS[j].label;
            selExist.appendChild(o);
          }
        }
        selExist.value = currentLang;
        bindLangSelect(selExist);
      }
      return field;
    }
    var label = document.createElement("label");
    label.className = "lang-field";
    var sel = document.createElement("select");
    sel.id = "lang-select";
    sel.setAttribute("aria-label", "Language");
    for (var i = 0; i < SITE_LANGS.length; i++) {
      var opt = document.createElement("option");
      opt.value = SITE_LANGS[i].id;
      opt.textContent = SITE_LANGS[i].label;
      if (SITE_LANGS[i].id === currentLang) opt.selected = true;
      sel.appendChild(opt);
    }
    bindLangSelect(sel);
    label.appendChild(sel);
    return label;
  }

  window.ITZ_I18N = {
    t: t,
    tf: function (key, vars) {
      var s = t(key);
      if (!vars) return s;
      var k;
      for (k in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, k)) {
          s = String(s).split("{" + k + "}").join(String(vars[k] == null ? "" : vars[k]));
        }
      }
      return s;
    },
    getLang: function () {
      return currentLang;
    },
    setLang: function (lang) {
      setSiteLang(lang, true);
    },
    detect: detectSiteLang,
    register: function (id, pack, bind) {
      if (!id || !pack) return;
      i18nPacks[id] = pack;
      if (bind) i18nBind[id] = bind;
      if (catalogReady) applyI18nDom();
    },
    isCatalogReady: function () {
      return catalogReady;
    }
  };

  window.itzT = function (key, fallback) {
    var v = t(key);
    if (v && v !== key) return v;
    return fallback != null ? fallback : key;
  };

  function itzAgentText(raw) {
    if (raw == null) return "";
    var s = String(raw);
    if (!s) return s;
    var trimmed = s.replace(/^\s+|\s+$/g, "");
    var tf = window.ITZ_I18N && typeof window.ITZ_I18N.tf === "function" ? window.ITZ_I18N.tf : t;
    var exact = {
      "설치 시작": "ui.installStart",
      "준비 중입니다…": "ui.preparing",
      "준비 중입니다...": "ui.preparing",
      "준비 중…": "ui.preparing",
      "진행 중": "ui.phaseRun",
      "처리 중": "ui.phaseRun",
      "완료": "ui.phaseDone",
      "실패": "ui.phaseFail",
      "오류": "ui.phaseFail",
      "환경": "ui.env",
      "환경 확인": "ui.envCheck",
      "AI 모델": "ui.aiModel",
      "설치 완료": "ui.phaseDone",
      "설치 실패": "ui.phaseFail",
      "AI 환경 준비": "ui.prepare",
      "AI 환경 준비 중": "ui.prepare",
      "연결 확인": "modal.checking",
      "설치 재시작": "ui.installStart",
      "확인 중…": "ui.checking",
      "확인 중": "ui.checkingShort",
      "에이전트 연결 확인 중…": "conn.checking",
      "연산 장치 확인 중…": "ui.gpuChecking",
      "라이브러리 · PyTorch": "ui.libTorch",
      "라이브러리 · GPU wheel": "ui.libGpu",
      "보컬·MR 분리": "ui.sepTitle",
      "Demucs AI 분리 중…": "ui.demucsRun",
      "음악(MR)과 보컬 스템을 생성하고 있습니다.": "ui.demucsStems",
      "에이전트에 분리 작업을 요청했습니다.": "ui.sepQueued",
      "화질 향상": "ui.enhanceTitle",
      "CodeFormer 처리 중…": "ui.cfProcess",
      "얼굴·디테일을 복원하고 있습니다.": "ui.restoreFaces",
      "작업 요청": "ui.jobRequest",
      "분리 작업 시작": "ui.sepStart",
      "에이전트에 요청 중": "ui.reqAgent",
      "준비 실패": "ui.prepFailTitle",
      "에이전트에 설치 작업을 요청하는 중…": "ui.askInstall",
      "오디오 파일 경로를 입력하거나 찾아보기를 이용하세요.": "ui.needAudioPath",
      "DiT 모델 로딩 중…": "ui.ditLoad",
      "LM 로딩 중…": "ui.lmLoad",
      "결과 정리 중…": "ui.tidyResult",
      "결과 정리 중...": "ui.tidyResult",
      "XML 생성 중…": "ui.xmlBuilding",
      "XML 생성 중...": "ui.xmlBuilding",
      "무음 구간 탐지 중…": "ui.detectSilence",
      "무음 구간 탐지 중...": "ui.detectSilence",
      "오디오 파형 확인 중…": "ui.checkWaveform",
      "오디오 파형 확인 중...": "ui.checkWaveform",
      "파형 준비 완료": "ui.waveformReady",
      "파형 메타 계산 중…": "ui.waveformMeta",
      "파형 메타 계산 중...": "ui.waveformMeta",
      "음악 생성 중…": "ui.musicGen",
      "음악 생성 중...": "ui.musicGen",
      "생성 완료": "ui.genDone",
      "CodeFormer를 시작합니다…": "ui.cfProcess",
      "분리 실패": "ui.sepFail",
      "Demucs AI 분리 준비 중…": "sepPrepStep",
      "MR·보컬 스템을 생성하고 있습니다.": "sepPrepMsg",
      "Demucs AI가 MR·보컬 스템을 생성합니다.": "ui.demucsStems"
    };
    if (exact[trimmed]) {
      return window.itzT(exact[trimmed], trimmed);
    }
    var look = trimmed.replace(/\.{2,}$/g, "…");
    if (look !== trimmed && exact[look]) {
      return window.itzT(exact[look], trimmed);
    }
    var py = trimmed.match(/^(.+?)\s*전용 Python(?: 3\.12)? 환경 설치 중/);
    if (py) {
      return tf("ui.agentPyEnv", { name: String(py[1] || "").replace(/^\s+|\s+$/g, "") });
    }
    if (/DiT/.test(trimmed) && /로딩/.test(trimmed)) return window.itzT("ui.ditLoad", trimmed);
    if (/\bLM\b/.test(trimmed) && /로딩/.test(trimmed)) return window.itzT("ui.lmLoad", trimmed);
    if (trimmed.indexOf("결과 정리") === 0) return window.itzT("ui.tidyResult", trimmed);
    if (/^XML 생성/.test(trimmed)) return window.itzT("ui.xmlBuilding", trimmed);
    if (/^무음 구간 탐지/.test(trimmed)) return window.itzT("ui.detectSilence", trimmed);
    if (/^오디오 파형 확인/.test(trimmed)) return window.itzT("ui.checkWaveform", trimmed);
    if (/^파형 준비 완료/.test(trimmed)) return window.itzT("ui.waveformReady", trimmed);
    if (/^파형 메타/.test(trimmed)) return window.itzT("ui.waveformMeta", trimmed);
    if (/^음악 생성 중/.test(trimmed)) return window.itzT("ui.musicGen", trimmed);
    var waitPrep = trimmed.match(/^(.+?)\s*[·•]\s*환경 준비 대기$/);
    if (waitPrep) {
      return waitPrep[1] + " · " + window.itzT("ui.waitPrepSuffix", "환경 준비 대기");
    }
    var envCheck = trimmed.match(/^(.+?)\s*[·•]\s*환경 확인 중…$/);
    if (envCheck) {
      return envCheck[1] + " · " + window.itzT("ui.envChecking", "환경 확인 중…");
    }
    var prepErr = trimmed.match(/^준비 중 오류가 발생했습니다:\s*(.*)$/);
    if (prepErr) {
      return tf("ui.prepError", { msg: prepErr[1] || "" });
    }
    if (currentLang !== "ko") {
      s = s.replace(/(\d+)\s*초 경과/g, function (_m, n) {
        return tf("ui.elapsedPassed", { n: n });
      });
      s = s.replace(/(\d+)\s*초/g, function (_m, n) {
        return tf("ui.secUnit", { n: n });
      });
    }
    return s;
  }

  window.itzAgentText = itzAgentText;

  currentLang = detectSiteLang();
  if (!isAdminPath()) {
    var pathLang = readPathLang();
    var hlLang = readUrlLang();
    if (hlLang && pathLang && hlLang !== pathLang) {
      if (navigateToLang(hlLang)) return;
    }
    var firstSeg = (pathSegments(location.pathname)[0] || "").toLowerCase();
    if (firstSeg === "ko") {
      if (navigateToLang("ko")) return;
    }
    if (!pathLang) {
      if (navigateToLang(currentLang)) return;
    }
    stripHlQuery();
  }
  document.documentElement.lang = HTML_LANG[currentLang] || currentLang;
  applySeo();
  loadPageCatalog();
  loadPublicSeoConfig();

  function pruneEmpty(el) {
    if (el && el.parentNode && !el.children.length) {
      el.parentNode.removeChild(el);
    }
  }

  function mountToolHeaderChrome() {
    if (document.querySelector(".itz-header-actions")) return;
    if (isAdminPath()) return;
    var header =
      document.querySelector(".app-header") ||
      document.querySelector(".as-topbar") ||
      document.querySelector(".hub-header") ||
      document.querySelector(".itz-legal-shell > header");
    if (!header) return;

    var title =
      header.querySelector(".logo-title-row > h1") ||
      header.querySelector(".as-topbar-left > .as-logo") ||
      header.querySelector(".hub-title-cluster > .hub-title") ||
      header.querySelector(".header-copy > h1") ||
      header.querySelector("h1");
    if (!title) return;

    var theme = document.querySelector(".itz-theme-toggle");
    var lang = ensureLangField();
    var dashboard = header.querySelector("a.btn-to-dashboard");

    var actions = document.createElement("div");
    actions.className = "itz-header-actions";
    if (theme) actions.appendChild(theme);
    if (lang) actions.appendChild(lang);
    if (dashboard) actions.appendChild(dashboard);

    var row = title.parentNode;
    if (
      row &&
      row.classList &&
      (row.classList.contains("logo-title-row") ||
        row.classList.contains("as-topbar-left") ||
        row.classList.contains("hub-title-cluster"))
    ) {
      if (title.nextSibling) row.insertBefore(actions, title.nextSibling);
      else row.appendChild(actions);
    } else if (row) {
      var wrap = document.createElement("div");
      wrap.className = "itz-title-row";
      row.insertBefore(wrap, title);
      wrap.appendChild(title);
      wrap.appendChild(actions);
    }

    pruneEmpty(header.querySelector(".header-actions"));
    pruneEmpty(header.querySelector(".header-top"));
    applyChromeLang(readSiteLang());
  }

  function mountChrome() {
    mountThemeToggle();
    mountToolHeaderChrome();
    mountSiteFooter();
    applyI18nDom();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountChrome);
  } else {
    mountChrome();
  }

  window.addEventListener("storage", function (ev) {
    if (ev.key === THEME_KEY) {
      applyTheme(readTheme());
      syncThemeToggles();
    }
    if (ev.key === SITE_LANG_KEY && ev.newValue) {
      var next = normalizeLang(ev.newValue);
      if (next && next !== currentLang) setSiteLang(next, true);
    }
  });

  try {
    var path = String(location.pathname || "");
    if (isAdminPath(path)) return;

    var parts = path.split("/").filter(Boolean);
    if (parts.length && URL_PREFIX_TO_LANG[parts[0].toLowerCase()]) parts.shift();
    if (!parts.length) return;
    var id = parts[0];
    if (id.indexOf(".") !== -1) return;
    if (id === "assets" || id === "common" || id === "admin" || id === "legal") return;

    var ua = String(navigator.userAgent || "");
    var isCrawler = /Googlebot|bingbot|Yeti|NaverBot|DuckDuckBot|Slurp|YandexBot|Baiduspider|facebookexternalhit|Twitterbot|kakaotalk|Discordbot|LinkedInBot/i.test(ua);

    if (!isCrawler) {
      var style = document.createElement("style");
      style.id = "itz-boot-hide";
      style.textContent = "html{visibility:hidden !important}";
      (document.head || document.documentElement).appendChild(style);
    }

    var revealed = false;
    function reveal() {
      if (revealed) return;
      revealed = true;
      var s = document.getElementById("itz-boot-hide");
      if (s && s.parentNode) s.parentNode.removeChild(s);
    }

    function blockPage() {
      window.__itzToolHidden = true;
      try {
        if (typeof window.stop === "function") window.stop();
      } catch (e) {
        /* ignore */
      }
      document.title = "이용할 수 없습니다";
      document.documentElement.innerHTML =
        "<head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
        "<title>이용할 수 없습니다</title><style>" +
        "html,body{margin:0;min-height:100%;background:#0f1115;color:#e2e8f0;font-family:Pretendard,system-ui,sans-serif}" +
        ".wrap{max-width:440px;margin:18vh auto;padding:0 20px;text-align:center}" +
        "h1{font-size:1.35rem;margin:0 0 10px}p{color:#94a3b8;line-height:1.6}" +
        "a{color:#60a5fa;text-decoration:none}</style></head><body><div class=\"wrap\">" +
        "<h1>이용할 수 없습니다</h1><p>이 도구는 현재 공개되지 않습니다.</p>" +
        "<p><a href=\"/" +
        (LANG_TO_URL_PREFIX[currentLang] || "kr") +
        "/\">대시보드로 이동</a></p></div></body>";
    }

    function apply(cfg) {
      var hidden = cfg && Array.isArray(cfg.hiddenToolIds) ? cfg.hiddenToolIds : [];
      if (hidden.indexOf(id) !== -1) {
        blockPage();
        return;
      }
      reveal();
    }

    var timer = window.setTimeout(reveal, 3500);
    var publicUrl = "/admin/api.php?action=public";
    var fileUrl = "/admin/site-config.json";

    fetch(publicUrl, { cache: "no-store", credentials: "same-origin" })
      .then(function (res) {
        return res.ok ? res.json() : Promise.reject(new Error("api"));
      })
      .then(function (data) {
        if (data && data.ok && data.config) return data.config;
        throw new Error("api-config");
      })
      .catch(function () {
        return fetch(fileUrl, { cache: "no-store" }).then(function (res) {
          return res.ok ? res.json() : Promise.reject(new Error("file"));
        });
      })
      .then(function (cfg) {
        window.__itzSiteConfig = cfg;
        window.clearTimeout(timer);
        apply(cfg);
      })
      .catch(function () {
        window.clearTimeout(timer);
        reveal();
      });
  } catch (err) {
    /* fail open */
  }
})();
