import { showAdSense } from "../common/adsense.js?v=3";
import {
  BLOATWARE,
  BLOATWARE_GROUPS,
  COMPONENTS,
  DESKTOP_ICONS,
  EDITIONS,
  EFFECTS,
  GEO_IDS,
  IMAGE_LANGUAGES,
  KEYBOARDS,
  LOCALES,
  START_FOLDERS,
  TIME_ZONES,
} from "./catalog.js";
import { MODES, SCRIPT_PHASES, applyPreset, defaultConfig, migrateConfig, presetValues, syncAccounts } from "./config.js";
import { downloadName, generateXml, parseSavedXml } from "./generate-xml.js";
import { makeAutounattendIso } from "./iso.js";

const NAV = [
  { id: "language", name: "언어·지역" },
  { id: "account", name: "계정" },
  { id: "setup", name: "설치·디스크" },
  { id: "network", name: "네트워크" },
  { id: "desktop", name: "화면·작업줄" },
  { id: "system", name: "시스템" },
  { id: "apps", name: "앱 제거" },
  { id: "advanced", name: "고급" },
];

let state = defaultConfig();
let section = "language";
let toastTimer = 0;

const $ = (sel) => document.querySelector(sel);

function showToast(message, isError = false) {
  const box = $("#toast");
  box.hidden = false;
  box.textContent = message;
  box.classList.toggle("is-error", isError);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    box.hidden = true;
  }, 3600);
}

function optionsHtml(list, value, extra = []) {
  const rows = extra.concat(list);
  return rows
    .map((item) => `<option value="${item.id}" ${item.id === value ? "selected" : ""}>${item.name}</option>`)
    .join("");
}

function radios(name, value, items) {
  return items
    .map(
      (item) => `<label class="choice ${item.danger ? "choice--danger" : ""}">
        <input type="radio" name="${name}" data-bind="${name}" value="${item.value}" ${value === item.value ? "checked" : ""}>
        <span><strong>${item.title}</strong>${item.hint ? `<small>${item.hint}</small>` : ""}</span>
      </label>`,
    )
    .join("");
}

function check(id, label, hint = "", danger = false) {
  return `<label class="check-line ${danger ? "is-danger" : ""}">
    <input type="checkbox" data-bind="${id}" ${state[id] ? "checked" : ""}>
    <span>${label}${hint ? `<small>${hint}</small>` : ""}</span>
  </label>`;
}

function field(label, control, hint = "") {
  return `<label class="field"><span class="field-label">${label}</span>${control}${hint ? `<span class="field-hint">${hint}</span>` : ""}</label>`;
}

function select(bind, list, extra) {
  return `<select data-bind="${bind}">${optionsHtml(list, state[bind], extra)}</select>`;
}

function htmlEsc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function input(bind, type = "text", placeholder = "") {
  const val = state[bind] ?? "";
  return `<input type="${type}" data-bind="${bind}" value="${htmlEsc(val)}" placeholder="${htmlEsc(placeholder)}">`;
}

function textarea(bind, placeholder = "") {
  return `<textarea data-bind="${bind}" rows="6" placeholder="${htmlEsc(placeholder)}">${htmlEsc(state[bind] || "")}</textarea>`;
}

function details(title, inner) {
  return `<details class="more"><summary>${title}</summary><div class="more-body">${inner}</div></details>`;
}

function panelLanguage() {
  return `
    <h2>언어·지역</h2>
    <p class="lead">여기서 고른 언어와 Windows 설치 파일 언어가 <strong>같아야</strong> 합니다. 한국어로 만들었다면 한국어 Windows만 쓰세요.</p>
    ${radios("languageInteractive", state.languageInteractive ? "1" : "0", [
      { value: "0", title: "지금 정해 두기", hint: "설치할 때 언어를 묻지 않습니다" },
      { value: "1", title: "설치할 때 고르기", hint: "언어 화면을 그대로 둡니다" },
    ]).replaceAll('data-bind="languageInteractive"', 'data-bool="languageInteractive"')}
    <div class="grid2">
      ${field("Windows 설치 파일 언어", select("imageLanguage", IMAGE_LANGUAGES), "설치 USB를 만들 때 받은 파일과 맞추세요")}
      ${field("날짜·숫자 형식", select("locale", LOCALES))}
      ${field("키보드", select("keyboard", KEYBOARDS))}
      ${field("국가·지역", select("geoId", GEO_IDS))}
      ${field(
        "시간대",
        `<select data-bind="timeZoneMode">
          <option value="implicit" ${state.timeZoneMode === "implicit" ? "selected" : ""}>언어·지역에 맞추기</option>
          <option value="explicit" ${state.timeZoneMode === "explicit" ? "selected" : ""}>직접 지정</option>
        </select>`,
      )}
    </div>
    ${state.timeZoneMode === "explicit" ? field("시간대 선택", select("timeZone", TIME_ZONES)) : ""}
    ${details(
      "추가로 쓸 언어",
      `<div class="grid2">
        ${field("추가 언어 2", `<select data-bind="locale2"><option value="">없음</option>${optionsHtml(LOCALES, state.locale2)}</select>`)}
        ${field("키보드 2", `<select data-bind="keyboard2"><option value="">없음</option>${optionsHtml(KEYBOARDS, state.keyboard2)}</select>`)}
        ${field("추가 언어 3", `<select data-bind="locale3"><option value="">없음</option>${optionsHtml(LOCALES, state.locale3)}</select>`)}
        ${field("키보드 3", `<select data-bind="keyboard3"><option value="">없음</option>${optionsHtml(KEYBOARDS, state.keyboard3)}</select>`)}
      </div>`,
    )}
  `;
}

function panelAccount() {
  return `
    <h2>계정</h2>
    <p class="lead">지금 계정을 정해 두면 Microsoft 계정 화면을 건너뜁니다.</p>
    ${radios("accountMode", state.accountMode, [
      { value: "local", title: "지금 로컬 계정 만들기", hint: "이름과 암호를 여기에 적습니다" },
      { value: "interactive-msa", title: "설치할 때 Microsoft 계정", hint: "인터넷으로 로그인합니다" },
      { value: "interactive-local", title: "설치할 때 로컬 계정", hint: "설치 화면에서 이름만 있는 계정을 만듭니다" },
    ])}
    ${
      state.accountMode === "local"
        ? `<div class="account-list">
            ${state.accounts
              .map(
                (acc, i) => `<div class="grid2">
              ${field(
                i === 0 ? "계정 이름" : `계정 ${i + 1} 이름`,
                `<input type="text" data-account="${i}" data-acc-field="name" value="${htmlEsc(acc.name)}" placeholder="${i === 0 ? "예: mingyu" : ""}">`,
              )}
              ${field("표시 이름", `<input type="text" data-account="${i}" data-acc-field="display" value="${htmlEsc(acc.display)}">`)}
              ${field("암호", `<input type="password" data-account="${i}" data-acc-field="password" value="${htmlEsc(acc.password)}">`)}
              ${field(
                "그룹",
                `<select data-account="${i}" data-acc-field="group">
                  <option value="Administrators" ${acc.group === "Administrators" ? "selected" : ""}>관리자</option>
                  <option value="Users" ${acc.group === "Users" ? "selected" : ""}>표준 사용자</option>
                </select>`,
              )}
            </div>`,
              )
              .join("")}
          </div>
          ${field(
            "설치 직후 로그인",
            `<select data-bind="autoLogon">
              <option value="first-admin" ${state.autoLogon === "first-admin" ? "selected" : ""}>만든 관리자 계정으로 한 번 로그인</option>
              <option value="builtin-admin" ${state.autoLogon === "builtin-admin" ? "selected" : ""}>기본 관리자 계정</option>
              <option value="none" ${state.autoLogon === "none" ? "selected" : ""}>로그인 화면에서 끝내기</option>
            </select>`,
          )}
          ${state.autoLogon === "builtin-admin" ? field("기본 관리자 암호", input("builtinAdminPassword", "password")) : ""}
          ${check("obscurePasswords", "파일에 암호를 숨겨 저장", "완벽한 암호화는 아닙니다")}`
        : `<p class="note">계정은 Windows 설치 화면에서 만듭니다.</p>`
    }
    <h3>이 PC 이름</h3>
    <div class="grid2">
      ${field(
        "컴퓨터 이름",
        `<select data-bind="computerNameMode">
          <option value="random" ${state.computerNameMode === "random" ? "selected" : ""}>Windows가 임의로 만들기</option>
          <option value="custom" ${state.computerNameMode === "custom" ? "selected" : ""}>직접 지정</option>
          <option value="script" ${state.computerNameMode === "script" ? "selected" : ""}>명령으로 만들기</option>
        </select>`,
      )}
      ${state.computerNameMode === "custom" ? field("이름", input("computerName", "text", "DESKTOP-HOME")) : ""}
      ${state.computerNameMode === "script" ? field("이름 만드는 스크립트", textarea("computerNameScript", "원하는 컴퓨터 이름을 돌려주면 됩니다")) : ""}
    </div>
    ${details(
      "암호 만료 · 잠금",
      `<div class="grid2">
        ${field(
          "암호 만료",
          `<select data-bind="passwordExpire">
            <option value="never">만료 없음</option>
            <option value="default" ${state.passwordExpire === "default" ? "selected" : ""}>Windows 기본 (42일)</option>
            <option value="custom" ${state.passwordExpire === "custom" ? "selected" : ""}>직접 지정</option>
          </select>`,
        )}
        ${state.passwordExpire === "custom" ? field("만료 일수", input("passwordExpireDays", "number")) : ""}
        ${field(
          "계정 잠금",
          `<select data-bind="lockout">
            <option value="default">Windows 기본</option>
            <option value="disable" ${state.lockout === "disable" ? "selected" : ""}>끄기</option>
            <option value="custom" ${state.lockout === "custom" ? "selected" : ""}>직접 지정</option>
          </select>`,
        )}
        ${
          state.lockout === "custom"
            ? `${field("실패 횟수", input("lockoutThreshold", "number"))}
               ${field("관찰 시간(분)", input("lockoutWindow", "number"))}
               ${field("잠금 시간(분)", input("lockoutDuration", "number"))}`
            : ""
        }
      </div>`,
    )}
  `;
}

function panelSetup() {
  return `
    <h2>설치·디스크</h2>
    <p class="lead">디스크를 자동으로 지우는 옵션은 그 안의 파일을 <strong>전부 삭제</strong>합니다. 잘 모르겠으면 설치 화면에서 고르세요.</p>
    <div class="grid2">
      ${field("에디션", select("edition", EDITIONS), "설치만 하고, 정품 인증은 나중에 해도 됩니다")}
      ${field(
        "제품 키",
        `<select data-bind="productKeyMode">
          <option value="generic" ${state.productKeyMode === "generic" ? "selected" : ""}>에디션용 임시 키 (인증은 안 됨)</option>
          <option value="interactive" ${state.productKeyMode === "interactive" ? "selected" : ""}>설치할 때 입력</option>
          <option value="custom" ${state.productKeyMode === "custom" ? "selected" : ""}>키를 직접 입력</option>
          <option value="firmware" ${state.productKeyMode === "firmware" ? "selected" : ""}>메인보드에 있는 키 사용</option>
        </select>`,
      )}
    </div>
    ${state.productKeyMode === "custom" ? field("제품 키", input("productKey", "text", "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX")) : ""}
    ${field("나중에 쓸 인증 키 (선택)", input("activationKey"))}
    <div class="arch-row">
      <span class="field-label">프로세서</span>
      ${check("archAmd64", "64비트 (Intel/AMD) — 대부분")}
      ${check("archX86", "32비트")}
      ${check("archArm64", "Arm64")}
    </div>
    ${check("bypassTpm", "Windows 11 검사 건너뛰기", "TPM, 보안 부팅, CPU, 메모리, 저장 공간", true)}
    ${check("narrator", "설치 중 내레이터 켜기")}
    <h3>디스크를 어떻게 고를까요</h3>
    ${radios("peStage", state.peStage, [
      { value: "setup", title: "설치 화면에서 고르기", hint: "어디에 설치할지 직접 고릅니다" },
      { value: "generate", title: "디스크를 지우고 자동 설치", hint: "고른 디스크의 파일이 전부 삭제됩니다", danger: true },
      { value: "script", title: "내가 만든 명령으로 설치", hint: "고급 사용자용" },
    ])}
    ${
      state.peStage === "script"
        ? field("설치 명령", textarea("customPeScript"))
        : ""
    }
    <h3>디스크</h3>
    ${
      state.peStage === "setup"
        ? radios("diskMode", state.diskMode, [
            { value: "interactive", title: "설치할 때 내가 고른다", hint: "이미 있는 파일을 남기고 싶을 때" },
          ])
        : radios("diskMode", state.diskMode, [
            { value: "wipe", title: "디스크를 지우고 자동 설치", hint: "고른 디스크가 전부 삭제됩니다", danger: true },
            { value: "diskpartInteractive", title: "설치 전에 직접 나누기", hint: "검은 화면에서 디스크를 나눕니다" },
            { value: "custom", title: "내가 적은 명령으로 나누기" },
          ])
    }
    ${
      state.peStage === "generate" && state.diskMode === "wipe"
        ? `<div class="warn">USB가 0번 디스크로 잡히면 USB까지 지워질 수 있습니다. 설치할 디스크 번호를 확인하세요.</div>
          <div class="grid2">
            ${field("설치할 디스크 번호 (0부터)", input("targetDisk", "number"))}
            ${field(
              "파티션 형식",
              `<select data-bind="partitionLayout">
                <option value="auto" ${state.partitionLayout === "auto" ? "selected" : ""}>자동 (요즘 PC는 GPT)</option>
                <option value="gpt" ${state.partitionLayout === "gpt" ? "selected" : ""}>GPT (UEFI)</option>
                <option value="mbr" ${state.partitionLayout === "mbr" ? "selected" : ""}>MBR (아주 오래된 PC)</option>
              </select>`,
            )}
            ${field("시스템 파티션 크기 (MB)", input("systemPartitionMb", "number"))}
            ${field(
              "복구 파티션",
              `<select data-bind="recoveryMode">
                <option value="partition">만들기</option>
                <option value="none" ${state.recoveryMode === "none" ? "selected" : ""}>만들지 않기</option>
              </select>`,
            )}
            ${state.recoveryMode === "partition" ? field("복구 파티션 크기 (MB)", input("recoveryMb", "number")) : ""}
          </div>
          ${check("pauseBeforeFormat", "나누기 전에 잠시 멈추기")}
          ${check("pauseBeforeReboot", "다시 시작하기 전에 잠시 멈추기")}`
        : ""
    }
    ${state.peStage === "generate" && state.diskMode === "custom" ? field("디스크 나누는 명령", textarea("customDiskpart", "SELECT DISK=0")) : ""}
    ${
      state.peStage === "generate"
        ? details(
            "잘못 지우지 않게 확인",
            `${field(
              "검사",
              `<select data-bind="assertDisk">
                <option value="none">하지 않음</option>
                <option value="generated" ${state.assertDisk === "generated" ? "selected" : ""}>용량·종류 확인</option>
                <option value="script" ${state.assertDisk === "script" ? "selected" : ""}>내가 적은 확인</option>
              </select>`,
            )}
            ${
              state.assertDisk === "generated"
                ? `<div class="grid2">
                    ${field("최소 용량 (GB)", input("assertMinGiB", "number"))}
                    ${field("최대 용량 (GB)", input("assertMaxGiB", "number"))}
                  </div>
                  ${check("assertNoPartitions", "이미 나눠져 있으면 중단")}
                  ${check("assertInterface", "일반 저장장치인지 확인")}
                  ${check("assertMedia", "내장 디스크인지 확인")}`
                : ""
            }
            ${state.assertDisk === "script" ? field("확인용 스크립트", textarea("assertScript")) : ""}`,
          )
        : ""
    }
    ${details(
      "설치 이미지·기타",
      `${check("compactOs", "용량을 줄여 설치")}
       ${check("skipIntegrity", "설치 파일 검사 건너뛰기")}
       ${check("disable8dot3", "짧은 파일 이름 끄기")}
       ${check("disableDefenderPe", "설치 초반에 Windows 보안 끄기")}
       ${field(
         "적용할 이미지",
         `<select data-bind="imageSelect">
            <option value="edition">에디션 이름으로</option>
            <option value="name" ${state.imageSelect === "name" ? "selected" : ""}>이미지 이름</option>
            <option value="index" ${state.imageSelect === "index" ? "selected" : ""}>번호로 고르기</option>
            <option value="interactive" ${state.imageSelect === "interactive" ? "selected" : ""}>설치할 때 고르기</option>
          </select>`,
       )}
       ${state.imageSelect === "name" ? field("이미지 이름", input("imageName", "text", "Windows 11 Pro")) : ""}
       ${state.imageSelect === "index" ? field("번호", input("imageIndex", "number")) : ""}`,
    )}
  `;
}

function panelNetwork() {
  return `
    <h2>네트워크</h2>
    ${radios("wifiMode", state.wifiMode, [
      { value: "interactive", title: "설치할 때 Wi-Fi 고르기" },
      { value: "skip", title: "Wi-Fi 건너뛰기", hint: "유선이거나 설치 후에 연결" },
      { value: "profile", title: "이름과 암호를 미리 넣기" },
    ])}
    ${
      state.wifiMode === "profile"
        ? `<div class="grid2">
            ${field("Wi-Fi 이름", input("wifiSsid"))}
            ${field("암호", input("wifiPassword", "password"))}
            ${field(
              "보안",
              `<select data-bind="wifiAuth">
                <option value="WPA2PSK">WPA2 (가장 흔함)</option>
                <option value="WPA3SAE" ${state.wifiAuth === "WPA3SAE" ? "selected" : ""}>WPA3</option>
                <option value="open" ${state.wifiAuth === "open" ? "selected" : ""}>암호 없음</option>
              </select>`,
            )}
          </div>
          ${check("wifiHidden", "목록에 안 보이는 Wi-Fi에도 연결")}
          ${check("wifiConnectAuto", "자동 연결")}
          ${field("이미 내보낸 Wi-Fi 설정이 있으면 붙여 넣기", textarea("wifiXml", "Windows에서 내보낸 Wi-Fi 설정"))}`
        : ""
    }
    ${check("bypassNetwork", "인터넷 없이 설치 허용", "정말 인터넷이 없을 때만 켜세요. 로컬 계정만 만들 때는 필요 없습니다")}
    ${field(
      "진단·광고 데이터",
      `<select data-bind="expressSettings">
        <option value="disable">모두 끄기</option>
        <option value="enable" ${state.expressSettings === "enable" ? "selected" : ""}>모두 켜기</option>
        <option value="interactive" ${state.expressSettings === "interactive" ? "selected" : ""}>설치할 때 고르기</option>
      </select>`,
    )}
  `;
}

function panelDesktop() {
  const desk = DESKTOP_ICONS.map(
    (item) => `<label class="check-line">
      <input type="checkbox" data-nested="desktopIcons" data-key="${item.id}" ${state.desktopIcons[item.id] ? "checked" : ""}>
      <span>${item.name}</span>
    </label>`,
  ).join("");
  const folders = START_FOLDERS.map(
    (item) => `<label class="check-line">
      <input type="checkbox" data-nested="startFolders" data-key="${item.id}" ${state.startFolders[item.id] ? "checked" : ""}>
      <span>${item.name}</span>
    </label>`,
  ).join("");
  return `
    <h2>화면·작업줄</h2>
    <h3>파일 탐색기</h3>
    ${field(
      "숨김 파일",
      `<select data-bind="hideFiles">
        <option value="hidden">숨김 파일 숨기기 (기본)</option>
        <option value="protected" ${state.hideFiles === "protected" ? "selected" : ""}>보호된 운영 체제 파일만 숨기기</option>
        <option value="showall" ${state.hideFiles === "showall" ? "selected" : ""}>모두 표시</option>
      </select>`,
    )}
    ${check("showExtensions", "파일 확장자 항상 표시")}
    ${check("classicContextMenu", "예전처럼 우클릭 메뉴 쓰기")}
    ${check("launchToThisPC", "탐색기를 '이 PC'로 열기")}
    ${check("showEndTask", "작업 표시줄에서 작업 끝내기 표시")}
    ${check("hideInfoTip", "폴더 설명 말풍선 숨기기")}
    <h3>작업 표시줄 · 시작</h3>
    ${field(
      "검색창",
      `<select data-bind="taskbarSearch">
        <option value="box">검색 상자</option>
        <option value="icon" ${state.taskbarSearch === "icon" ? "selected" : ""}>아이콘만</option>
        <option value="label" ${state.taskbarSearch === "label" ? "selected" : ""}>아이콘과 레이블</option>
        <option value="hide" ${state.taskbarSearch === "hide" ? "selected" : ""}>숨기기</option>
      </select>`,
    )}
    ${check("disableWidgets", "위젯 끄기")}
    ${check("leftTaskbar", "작업 표시줄 왼쪽 정렬")}
    ${check("hideTaskView", "작업 보기 단추 숨기기")}
    ${check("showAllTray", "트레이 아이콘 모두 표시")}
    ${check("disableBing", "시작 검색에서 Bing 결과 끄기")}
    ${field(
      "시작 메뉴 고정 (Windows 11)",
      `<select data-bind="startPins">
        <option value="default">Windows 기본</option>
        <option value="none" ${state.startPins === "none" ? "selected" : ""}>고정 모두 제거</option>
        <option value="json" ${state.startPins === "json" ? "selected" : ""}>직접 지정</option>
      </select>`,
    )}
    ${state.startPins === "json" ? field("고정할 앱 목록", textarea("startPinsJson")) : ""}
    ${field(
      "시작 화면 타일 (Windows 10)",
      `<select data-bind="startTiles">
        <option value="default">Windows 기본</option>
        <option value="none" ${state.startTiles === "none" ? "selected" : ""}>타일 모두 제거</option>
        <option value="xml" ${state.startTiles === "xml" ? "selected" : ""}>직접 지정</option>
      </select>`,
    )}
    ${state.startTiles === "xml" ? field("타일 설정", textarea("startTilesXml")) : ""}
    ${field(
      "작업 표시줄 아이콘",
      `<select data-bind="taskbarIcons">
        <option value="default">Windows 기본</option>
        <option value="none" ${state.taskbarIcons === "none" ? "selected" : ""}>모두 제거</option>
        <option value="xml" ${state.taskbarIcons === "xml" ? "selected" : ""}>직접 지정</option>
      </select>`,
    )}
    ${state.taskbarIcons === "xml" ? field("작업 표시줄 설정", textarea("taskbarIconsXml")) : ""}
    <h3>바탕화면 아이콘</h3>
    <div class="chip-grid">${desk}</div>
    ${check("deleteEdgeShortcut", "바탕화면 Edge 바로가기 삭제")}
    ${details("시작 메뉴 옆 폴더", `${check("startFoldersCustom", "직접 고르기")}<div class="chip-grid">${folders}</div>`)}
    ${details(
      "색 · 배경 · 잠금키 · 시각 효과",
      `${field(
        "색 테마",
        `<select data-bind="colorMode">
          <option value="default">Windows 기본</option>
          <option value="custom" ${state.colorMode === "custom" ? "selected" : ""}>직접 지정</option>
        </select>`,
      )}
      ${
        state.colorMode === "custom"
          ? `<div class="grid2">
              ${field(
                "작업 표시줄",
                `<select data-bind="themeSystem"><option value="dark">어둡게</option><option value="light" ${state.themeSystem === "light" ? "selected" : ""}>밝게</option></select>`,
              )}
              ${field(
                "앱",
                `<select data-bind="themeApps"><option value="dark">어둡게</option><option value="light" ${state.themeApps === "light" ? "selected" : ""}>밝게</option></select>`,
              )}
              ${field("강조색", `<input type="color" data-bind="accentColor" value="${htmlEsc(state.accentColor)}">`)}
            </div>
            ${check("accentOnStart", "시작 메뉴에 강조색")}
            ${check("accentOnBorders", "창 테두리에 강조색")}
            ${check("enableTransparency", "반투명 효과")}`
          : ""
      }
      ${field(
        "배경화면",
        `<select data-bind="wallpaperMode">
          <option value="default">Windows 기본</option>
          <option value="solid" ${state.wallpaperMode === "solid" ? "selected" : ""}>단색</option>
          <option value="script" ${state.wallpaperMode === "script" ? "selected" : ""}>명령으로 이미지 넣기</option>
        </select>`,
      )}
      ${state.wallpaperMode === "solid" ? field("색", `<input type="color" data-bind="wallpaperColor" value="${htmlEsc(state.wallpaperColor)}">`) : ""}
      ${state.wallpaperMode === "script" ? field("배경 이미지를 만드는 스크립트", textarea("wallpaperScript")) : ""}
      ${field(
        "잠금 화면",
        `<select data-bind="lockScreenMode">
          <option value="default">Windows 기본</option>
          <option value="script" ${state.lockScreenMode === "script" ? "selected" : ""}>명령으로 이미지 넣기</option>
        </select>`,
      )}
      ${state.lockScreenMode === "script" ? field("잠금 화면 이미지를 만드는 스크립트", textarea("lockScreenScript")) : ""}
      ${field(
        "시각 효과",
        `<select data-bind="effectsMode">
          <option value="default">Windows 기본</option>
          <option value="appearance" ${state.effectsMode === "appearance" ? "selected" : ""}>모양 우선</option>
          <option value="performance" ${state.effectsMode === "performance" ? "selected" : ""}>성능 우선</option>
          <option value="custom" ${state.effectsMode === "custom" ? "selected" : ""}>직접 지정</option>
        </select>`,
      )}
      ${
        state.effectsMode === "custom"
          ? EFFECTS.map(
              (item) => `<label class="check-line"><input type="checkbox" data-nested="effects" data-key="${item.id}" ${state.effects[item.id] ? "checked" : ""}><span>${item.name}</span></label>`,
            ).join("")
          : ""
      }
      ${field(
        "고정키",
        `<select data-bind="stickyKeys">
          <option value="default">Windows 기본</option>
          <option value="disable" ${state.stickyKeys === "disable" ? "selected" : ""}>끄기</option>
          <option value="custom" ${state.stickyKeys === "custom" ? "selected" : ""}>직접 지정</option>
        </select>`,
      )}
      ${
        state.stickyKeys === "custom"
          ? `${check("stickyHotKey", "Shift 다섯 번으로 켜기")}
             ${check("stickyIndicator", "작업 표시줄 아이콘")}
             ${check("stickyAudible", "키 소리")}
             ${check("stickyHotKeySound", "켜고 끌 때 소리")}
             ${check("stickyTwoKeysOff", "두 키 동시 누르면 끄기")}
             ${check("stickyTriState", "두 번 누르면 잠금")}`
          : ""
      }
      ${check("lockKeys", "Caps/Num/Scroll Lock 초기값 지정")}
      ${
        state.lockKeys
          ? `<div class="grid2">
              ${field("Caps Lock 초기", `<select data-bind="capsInitial"><option value="off">끔</option><option value="on" ${state.capsInitial === "on" ? "selected" : ""}>켬</option></select>`)}
              ${field("Caps Lock 동작", `<select data-bind="capsBehavior"><option value="toggle">토글</option><option value="ignore" ${state.capsBehavior === "ignore" ? "selected" : ""}>무시</option></select>`)}
              ${field("Num Lock 초기", `<select data-bind="numInitial"><option value="off">끔</option><option value="on" ${state.numInitial === "on" ? "selected" : ""}>켬</option></select>`)}
              ${field("Num Lock 동작", `<select data-bind="numBehavior"><option value="toggle">토글</option><option value="ignore" ${state.numBehavior === "ignore" ? "selected" : ""}>무시</option></select>`)}
              ${field("Scroll Lock 초기", `<select data-bind="scrollInitial"><option value="off">끔</option><option value="on" ${state.scrollInitial === "on" ? "selected" : ""}>켬</option></select>`)}
              ${field("Scroll Lock 동작", `<select data-bind="scrollBehavior"><option value="toggle">토글</option><option value="ignore" ${state.scrollBehavior === "ignore" ? "selected" : ""}>무시</option></select>`)}
            </div>`
          : ""
      }`,
    )}
  `;
}

function panelSystem() {
  return `
    <h2>시스템</h2>
    <div class="check-stack">
      ${check("preventBitlocker", "장치 자동 암호화(BitLocker) 끄기")}
      ${check("disableAppSuggestions", "앱 추천·제안 끄기")}
      ${check("hideEdgeFre", "Edge 첫 실행 화면 숨기기")}
      ${check("disableEdgeBoost", "Edge 백그라운드·시작 부스트 끄기")}
      ${check("makeEdgeUninstallable", "Edge 제거 가능하게 만들기", "업데이트와 충돌할 수 있습니다", true)}
      ${check("disableWindowsUpdate", "Windows Update 계속 미루기", "권장하지 않습니다", true)}
      ${check("preventReboot", "업데이트 후 자동으로 다시 시작하지 않기")}
      ${check("disableUac", "사용자 계정 컨트롤(UAC) 끄기", "테스트용입니다. Microsoft 계정과 충돌할 수 있습니다", true)}
      ${check("disableSmartScreen", "SmartScreen 끄기")}
      ${check("disableSac", "앱 실행 보호 끄기", "다시 켜기 어렵습니다", true)}
      ${check("disableFastStartup", "빠른 시작 끄기")}
      ${check("disableSystemRestore", "시스템 복원 끄기")}
      ${check("enableLongPaths", "아주 긴 폴더 이름 허용")}
      ${check("enableRdp", "원격 데스크톱 켜기")}
      ${check("hardenAcl", "C 드라이브 권한 강화")}
      ${check("deleteJunctions", "숨겨진 바로가기 폴더 삭제")}
      ${check("allowPsScripts", "PowerShell 스크립트 실행 허용")}
      ${check("disableLastAccess", "파일 마지막 사용 시간 기록 끄기")}
      ${check("turnOffSounds", "시스템 소리 끄기")}
      ${check("disablePointerPrecision", "마우스 정확도 향상 끄기")}
      ${check("deleteWindowsOld", "빈 Windows.old 폴더 삭제")}
      ${check("disableAutoSignOn", "다시 시작한 뒤 자동 로그인 끄기")}
      ${check("disableWpbt", "제조사 사전 설치 프로그램 끄기")}
      ${check("preventDeviceApps", "장치 연결 시 앱 자동 설치 막기")}
      ${check("processAudit", "프로그램 실행 기록 남기기")}
      ${state.processAudit ? check("processAuditCmdline", "기록에 명령도 포함") : ""}
      ${check("disableCoreIsolation", "코어 격리 끄기", "게임은 빨라질 수 있지만 가상 머신에 영향이 있습니다")}
    </div>
  `;
}

function panelApps() {
  const groups = BLOATWARE_GROUPS.map((group) => {
    const items = BLOATWARE.filter((item) => item.group === group.id);
    const checks = items
      .map(
        (item) => `<label class="check-line ${item.id === "RemoveStore" ? "is-danger" : ""}">
          <input type="checkbox" data-nested="bloatware" data-key="${item.id}" ${state.bloatware[item.id] ? "checked" : ""}>
          <span>${item.name}${item.id === "RemoveStore" ? "<small>지우면 다시 설치하기 어렵습니다</small>" : ""}</span>
        </label>`,
      )
      .join("");
    return `<details class="more" ${group.id === "recommended" ? "open" : ""}><summary>${group.name}</summary><div class="more-body chip-grid">${checks}</div></details>`;
  }).join("");
  return `
    <h2>앱 제거</h2>
    <p class="lead">설치가 끝난 뒤 선택한 앱을 지웁니다. Microsoft Store는 지우지 않는 것이 좋습니다.</p>
    <div class="row-actions">
      <button type="button" class="btn-ghost" data-bloat="none">모두 해제</button>
      <button type="button" class="btn-ghost" data-bloat="home">가정용 추천</button>
      <button type="button" class="btn-ghost" data-bloat="minimal">미니멀 추천</button>
    </div>
    ${groups}
  `;
}

function panelAdvanced() {
  return `
    <h2>고급</h2>
    ${check("useOemFolder", "USB에 넣어 둔 추가 파일을 Windows에 복사")}
    ${check("hidePowerShell", "설치 중 검은 창 숨기기", "입력이 필요한 명령이면 끄세요")}
    ${check("keepSensitiveFiles", "암호가 들어 있는 설치 파일을 남기기", "기본은 설치가 끝나면 지웁니다")}
    <h3>가상머신 도구</h3>
    ${check("vboxGuest", "VirtualBox 게스트 도구")}
    ${check("vmwareTools", "VMware Tools")}
    ${check("virtio", "QEMU / KVM 게스트 도구")}
    ${check("parallels", "Parallels Tools")}
    <p class="note">가상머신에 도구 디스크를 직접 넣어야 합니다. 이 옵션은 설치가 끝난 뒤 설치를 시도합니다.</p>
    <h3>사용자 스크립트</h3>
    ${SCRIPT_PHASES.map(
      (phase) => details(
        phase.name,
        (state.scriptSlots[phase.id] || [])
          .map(
            (slot, i) => `<div class="grid2">
              ${field(
                `명령 ${i + 1} 종류`,
                `<select data-slot-phase="${phase.id}" data-slot-index="${i}" data-slot-field="type">
                  ${phase.types.map((t) => `<option value="${t}" ${slot.type === t ? "selected" : ""}>.${t}</option>`).join("")}
                </select>`,
              )}
              ${field("내용", `<textarea data-slot-phase="${phase.id}" data-slot-index="${i}" data-slot-field="content" rows="5">${htmlEsc(slot.content)}</textarea>`)}
            </div>`,
          )
          .join(""),
      ),
    ).join("")}
    ${check("restartExplorer", "스크립트 후 탐색기 다시 시작")}
    ${field("앱 실행 허용 정책", textarea("appLocker"))}
    ${details(
      "Windows 설치 항목을 직접 넣기",
      COMPONENTS.map(
        (comp) => details(
          comp.id,
          comp.passes
            .map(
              (pass) => field(
                `${pass}`,
                `<textarea data-comp="${pass}|${comp.id}" rows="4" placeholder="넣을 내용만 붙여 넣으세요">${htmlEsc(state.componentXml?.[`${pass}|${comp.id}`] || "")}</textarea>`,
              ),
            )
            .join(""),
        ),
      ).join(""),
    )}
    ${field("추가로 넣을 설치 설정", textarea("extraXml", "필요한 내용만 붙여 넣으세요"))}
    ${field(
      "받을 파일 이름",
      `<select data-bind="downloadName">
        <option value="autounattend.xml">autounattend.xml (USB에 넣으면 자동 적용)</option>
        <option value="notautounattend.xml" ${state.downloadName === "notautounattend.xml" ? "selected" : ""}>다른 이름 (직접 지정해서 설치할 때)</option>
      </select>`,
    )}
    ${check("downloadIso", "디스크 이미지(ISO)로 받기")}
  `;
}

const PANELS = {
  language: panelLanguage,
  account: panelAccount,
  setup: panelSetup,
  network: panelNetwork,
  desktop: panelDesktop,
  system: panelSystem,
  apps: panelApps,
  advanced: panelAdvanced,
};

function summaryFor(id) {
  switch (id) {
    case "language":
      return state.languageInteractive ? "설치 때 고름" : IMAGE_LANGUAGES.find((x) => x.id === state.imageLanguage)?.name || state.imageLanguage;
    case "account":
      if (state.accountMode === "local") return state.accountName ? `로컬 ${state.accountName}` : "로컬 (이름 없음)";
      return "설치 때 고름";
    case "setup":
      return `${state.peStage === "generate" || state.diskMode === "wipe" ? "디스크 자동 삭제" : "설치할 때 고름"} · ${state.bypassTpm ? "검사 건너뜀" : EDITIONS.find((e) => e.id === state.edition)?.name || ""}`;
    case "network":
      return state.wifiMode === "skip" ? "Wi-Fi 건너뜀" : state.wifiMode === "profile" ? state.wifiSsid || "Wi-Fi 미리 입력" : "Wi-Fi 설치 때";
    case "desktop":
      return [state.classicContextMenu && "클래식 메뉴", state.showExtensions && "확장자"].filter(Boolean).join(" · ") || "기본";
    case "system": {
      const n = [
        "preventBitlocker",
        "disableAppSuggestions",
        "hideEdgeFre",
        "disableWindowsUpdate",
        "disableUac",
        "enableRdp",
      ].filter((k) => state[k]).length;
      return n ? `${n}개 켜짐` : "기본";
    }
    case "apps": {
      const n = Object.values(state.bloatware).filter(Boolean).length;
      return n ? `${n}개 제거` : "제거 없음";
    }
    case "advanced": {
      const slots = Object.values(state.scriptSlots || {}).flat();
      const hasScript = slots.some((s) => s?.content?.trim()) || state.extraXml;
      return hasScript || state.downloadIso ? "사용자 정의 있음" : "없음";
    }
    default:
      return "";
  }
}

function renderNav() {
  $("#nav").innerHTML = NAV.map(
    (item) => `<button type="button" class="nav-item ${section === item.id ? "is-active" : ""}" data-nav="${item.id}">
      <span>${item.name}</span>
      <small>${summaryFor(item.id)}</small>
    </button>`,
  ).join("");
  const jump = $("#section-jump");
  if (!jump) return;
  jump.innerHTML = NAV.map((item) => {
    const extra = summaryFor(item.id);
    const label = extra ? `${item.name} · ${extra}` : item.name;
    return `<option value="${item.id}" ${section === item.id ? "selected" : ""}>${label}</option>`;
  }).join("");
}

function renderModes() {
  $("#modes").innerHTML = MODES.map(
    (item) => `<button type="button" class="mode-btn ${state.mode === item.id ? "is-active" : ""}" data-mode="${item.id}" title="${item.hint}">
      ${item.name}
    </button>`,
  ).join("");
}

function renderPanel() {
  $("#panel").innerHTML = PANELS[section]();
}

function renderAll() {
  renderModes();
  renderNav();
  renderPanel();
  $("#mode-note").textContent =
    state.mode === "custom"
      ? "원하는 값을 직접 고릅니다. 빠르게 가려면 위의 가정용 클린을 누르세요."
      : `${MODES.find((m) => m.id === state.mode)?.name} 설정이 채워져 있습니다. 왼쪽에서 바꾸고 싶은 항목만 고치면 됩니다.`;
}

function readControl(el) {
  if (el.dataset.account !== undefined) {
    const i = Number(el.dataset.account);
    const fieldName = el.dataset.accField;
    const accounts = state.accounts.map((a) => ({ ...a }));
    accounts[i] = { ...accounts[i], [fieldName]: el.value };
    state.accounts = accounts;
    state = syncAccounts(state);
    return;
  }
  if (el.dataset.slotPhase) {
    const phase = el.dataset.slotPhase;
    const i = Number(el.dataset.slotIndex);
    const slots = state.scriptSlots[phase].map((s) => ({ ...s }));
    slots[i] = { ...slots[i], [el.dataset.slotField]: el.value };
    state.scriptSlots = { ...state.scriptSlots, [phase]: slots };
    return;
  }
  if (el.dataset.comp) {
    state.componentXml = { ...state.componentXml, [el.dataset.comp]: el.value };
    return;
  }
  if (el.dataset.nested) {
    const bag = { ...state[el.dataset.nested] };
    bag[el.dataset.key] = el.checked;
    state[el.dataset.nested] = bag;
    return;
  }
  if (el.dataset.bool) {
    state[el.dataset.bool] = el.value === "1";
    return;
  }
  const key = el.dataset.bind;
  if (!key) return;
  if (el.type === "checkbox") state[key] = el.checked;
  else if (el.type === "number") state[key] = el.value === "" ? 0 : Number(el.value);
  else state[key] = el.value;
}

function onPanelEvent(event) {
  const bloat = event.target.closest("[data-bloat]");
  if (bloat) {
    if (bloat.dataset.bloat === "none") {
      for (const id of Object.keys(state.bloatware)) state.bloatware[id] = false;
    } else if (bloat.dataset.bloat === "home") {
      state.bloatware = { ...defaultConfig().bloatware, ...presetValues("home").bloatware };
    } else if (bloat.dataset.bloat === "minimal") {
      state.bloatware = { ...defaultConfig().bloatware, ...presetValues("minimal").bloatware };
    }
    renderAll();
    return;
  }
  const el = event.target;
  if (!el.dataset.bind && !el.dataset.nested && !el.dataset.bool && el.dataset.account === undefined && !el.dataset.slotPhase && !el.dataset.comp) return;
  readControl(el);
  if (el.dataset.bind === "imageLanguage") {
    state.locale = state.imageLanguage;
  }
  if (el.dataset.bind === "accountMode" || el.dataset.bind === "diskMode" || el.dataset.bind === "peStage" || el.dataset.bind === "wifiMode" || el.dataset.bind === "productKeyMode" || el.dataset.bind === "computerNameMode" || el.dataset.bind === "timeZoneMode" || el.dataset.bind === "colorMode" || el.dataset.bind === "autoLogon" || el.dataset.bind === "passwordExpire" || el.dataset.bind === "lockout" || el.dataset.bind === "recoveryMode" || el.dataset.bind === "imageSelect" || el.dataset.bind === "startPins" || el.dataset.bind === "startTiles" || el.dataset.bind === "taskbarIcons" || el.dataset.bind === "wallpaperMode" || el.dataset.bind === "lockScreenMode" || el.dataset.bind === "effectsMode" || el.dataset.bind === "stickyKeys" || el.dataset.bind === "assertDisk" || el.dataset.bind === "processAudit" || el.dataset.bind === "lockKeys" || el.dataset.bool === "languageInteractive") {
    if (el.dataset.bind === "peStage") {
      if (state.peStage === "setup") state.diskMode = "interactive";
      else if (state.diskMode === "interactive") state.diskMode = "wipe";
    }
    renderPanel();
    renderNav();
    return;
  }
  renderNav();
}

function confirmPreset(mode) {
  if (mode === state.mode) {
    state = applyPreset(state, mode);
    renderAll();
    showToast("자주 쓰는 설정을 다시 넣었습니다. 계정과 Wi-Fi는 그대로입니다.");
    return;
  }
  const ok = window.confirm(
    mode === "custom"
      ? "직접 설정으로 돌아가면 화면·앱 정리가 기본값으로 돌아갑니다. 계정과 Wi-Fi는 유지됩니다."
      : "이 설정으로 화면·앱 정리 값이 바뀝니다. 계정, Wi-Fi, 컴퓨터 이름은 유지됩니다.",
  );
  if (!ok) return;
  state = applyPreset(state, mode);
  renderAll();
}

function downloadXml() {
  if (state.accountMode === "local" && !String(state.accountName || "").trim()) {
    section = "account";
    renderAll();
    showToast("로컬 계정 이름을 입력하세요.", true);
    return;
  }
  if (state.accountMode === "local" && !(state.accounts || []).some((a) => a.name && a.group === "Administrators") && state.autoLogon !== "builtin-admin") {
    section = "account";
    renderAll();
    showToast("관리자 계정이 하나 필요합니다.", true);
    return;
  }
  if (!state.archAmd64 && !state.archX86 && !state.archArm64) {
    showToast("프로세서 종류를 하나 이상 고르세요.", true);
    return;
  }
  const xml = generateXml(state);
  if (state.downloadIso) {
    const iso = makeAutounattendIso(xml);
    const blob = new Blob([iso], { type: "application/x-iso9660-image" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "autounattend.iso";
    a.click();
    URL.revokeObjectURL(a.href);
    showToast("설치 파일을 이미지로 저장했습니다. USB나 가상머신에 넣으면 됩니다.");
    return;
  }
  const blob = new Blob([xml], { type: "text/xml;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = downloadName(state);
  a.click();
  URL.revokeObjectURL(a.href);
  showToast("파일을 저장했습니다. USB 맨 위에 넣으세요.");
}

async function importXml(file) {
  const text = await file.text();
  try {
    const loaded = parseSavedXml(text);
    state = migrateConfig(loaded);
    if (!MODES.some((m) => m.id === state.mode)) state.mode = "custom";
    renderAll();
    showToast("설정을 불러왔습니다. 바꾸고 싶은 항목만 고치면 됩니다.");
  } catch (err) {
    showToast(err.message || "불러오지 못했습니다.", true);
  }
}

function previewXml() {
  const dlg = $("#preview-dialog");
  $("#preview-code").textContent = generateXml(state);
  dlg.showModal();
}

function boot() {
  renderAll();
  $("#modes").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-mode]");
    if (btn) confirmPreset(btn.dataset.mode);
  });
  $("#nav").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-nav]");
    if (!btn) return;
    section = btn.dataset.nav;
    renderNav();
    renderPanel();
  });
  $("#section-jump").addEventListener("change", (event) => {
    section = event.target.value;
    renderNav();
    renderPanel();
  });
  $("#panel").addEventListener("change", onPanelEvent);
  $("#panel").addEventListener("input", (event) => {
    const el = event.target;
    if (el.dataset.account !== undefined || el.dataset.slotPhase || el.dataset.comp) onPanelEvent(event);
  });
  $("#panel").addEventListener("click", (event) => {
    if (event.target.closest("[data-bloat]")) onPanelEvent(event);
  });
  $("#btn-download").addEventListener("click", downloadXml);
  $("#btn-preview").addEventListener("click", previewXml);
  $("#btn-import").addEventListener("click", () => $("#file-import").click());
  $("#file-import").addEventListener("change", () => {
    const file = $("#file-import").files?.[0];
    $("#file-import").value = "";
    if (file) void importXml(file);
  });
  $("#preview-dialog").addEventListener("click", (event) => {
    if (event.target === $("#preview-dialog")) $("#preview-dialog").close();
  });
  void showAdSense("editorAboveWorkspace", "#editor-ad-above-path");
  void showAdSense("editorBelowExport", "#editor-ad-below-export");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
