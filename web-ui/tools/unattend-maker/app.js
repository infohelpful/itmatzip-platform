import { showAdSense } from "../common/adsense.js?v=6";
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
  imageLanguageName,
} from "./catalog.js";
import { MODES, SCRIPT_PHASES, applyPreset, defaultConfig, migrateConfig, presetValues, syncAccounts } from "./config.js";
import { downloadName, generateXml, parseSavedXml } from "./generate-xml.js";
import { makeAutounattendIso } from "./iso.js";

function tx(key, fallback) {
  try {
    if (window.itzT) return window.itzT(key, fallback);
  } catch (e) {}
  return fallback;
}

function txf(key, fallback, vars) {
  let s = tx(key, fallback);
  if (!vars) return s;
  for (const k of Object.keys(vars)) {
    s = String(s).split("{" + k + "}").join(String(vars[k] == null ? "" : vars[k]));
  }
  return s;
}

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

function imageLangList() {
  return IMAGE_LANGUAGES.map((x) => ({ id: x.id, name: imageLanguageName(x.id) }));
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

function noneOpt() {
  return `<option value="">${tx("common.none", "없음")}</option>`;
}

function panelLanguage() {
  return `
    <h2>${tx("nav.language", "언어·지역")}</h2>
    <p class="lead">${tx("lang.lead", "여기서 고른 언어와 Windows 설치 파일 언어가 <strong>같아야</strong> 합니다. 한국어로 만들었다면 한국어 Windows만 쓰세요.")}</p>
    ${radios("languageInteractive", state.languageInteractive ? "1" : "0", [
      { value: "0", title: tx("lang.now.title", "지금 정해 두기"), hint: tx("lang.now.hint", "설치할 때 언어를 묻지 않습니다") },
      { value: "1", title: tx("lang.setup.title", "설치할 때 고르기"), hint: tx("lang.setup.hint", "언어 화면을 그대로 둡니다") },
    ]).replaceAll('data-bind="languageInteractive"', 'data-bool="languageInteractive"')}
    <div class="grid2">
      ${field(tx("lang.image", "Windows 설치 파일 언어"), select("imageLanguage", imageLangList()), tx("lang.imageHint", "설치 USB를 만들 때 받은 파일과 맞추세요"))}
      ${field(tx("lang.locale", "날짜·숫자 형식"), select("locale", LOCALES))}
      ${field(tx("lang.keyboard", "키보드"), select("keyboard", KEYBOARDS))}
      ${field(tx("lang.geo", "국가·지역"), select("geoId", GEO_IDS))}
      ${field(
        tx("lang.tz", "시간대"),
        `<select data-bind="timeZoneMode">
          <option value="implicit" ${state.timeZoneMode === "implicit" ? "selected" : ""}>${tx("lang.tzImplicit", "언어·지역에 맞추기")}</option>
          <option value="explicit" ${state.timeZoneMode === "explicit" ? "selected" : ""}>${tx("common.custom", "직접 지정")}</option>
        </select>`,
      )}
    </div>
    ${state.timeZoneMode === "explicit" ? field(tx("lang.tzPick", "시간대 선택"), select("timeZone", TIME_ZONES)) : ""}
    ${details(
      tx("lang.more", "추가로 쓸 언어"),
      `<div class="grid2">
        ${field(tx("lang.locale2", "추가 언어 2"), `<select data-bind="locale2">${noneOpt()}${optionsHtml(LOCALES, state.locale2)}</select>`)}
        ${field(tx("lang.kb2", "키보드 2"), `<select data-bind="keyboard2">${noneOpt()}${optionsHtml(KEYBOARDS, state.keyboard2)}</select>`)}
        ${field(tx("lang.locale3", "추가 언어 3"), `<select data-bind="locale3">${noneOpt()}${optionsHtml(LOCALES, state.locale3)}</select>`)}
        ${field(tx("lang.kb3", "키보드 3"), `<select data-bind="keyboard3">${noneOpt()}${optionsHtml(KEYBOARDS, state.keyboard3)}</select>`)}
      </div>`,
    )}
  `;
}

function panelAccount() {
  return `
    <h2>${tx("nav.account", "계정")}</h2>
    <p class="lead">${tx("acc.lead", "지금 계정을 정해 두면 Microsoft 계정 화면을 건너뜁니다.")}</p>
    ${radios("accountMode", state.accountMode, [
      { value: "local", title: tx("acc.local.title", "지금 로컬 계정 만들기"), hint: tx("acc.local.hint", "이름과 암호를 여기에 적습니다") },
      { value: "interactive-msa", title: tx("acc.msa.title", "설치할 때 Microsoft 계정"), hint: tx("acc.msa.hint", "인터넷으로 로그인합니다") },
      { value: "interactive-local", title: tx("acc.intLocal.title", "설치할 때 로컬 계정"), hint: tx("acc.intLocal.hint", "설치 화면에서 이름만 있는 계정을 만듭니다") },
    ])}
    ${
      state.accountMode === "local"
        ? `<div class="account-list">
            ${state.accounts
              .map(
                (acc, i) => `<div class="grid2">
              ${field(
                i === 0 ? tx("acc.name", "계정 이름") : txf("acc.nameN", "계정 {n} 이름", { n: i + 1 }),
                `<input type="text" data-account="${i}" data-acc-field="name" value="${htmlEsc(acc.name)}" placeholder="${i === 0 ? htmlEsc(tx("acc.phName", "예: mingyu")) : ""}">`,
              )}
              ${field(tx("acc.display", "표시 이름"), `<input type="text" data-account="${i}" data-acc-field="display" value="${htmlEsc(acc.display)}">`)}
              ${field(tx("common.password", "암호"), `<input type="password" data-account="${i}" data-acc-field="password" value="${htmlEsc(acc.password)}">`)}
              ${field(
                tx("acc.group", "그룹"),
                `<select data-account="${i}" data-acc-field="group">
                  <option value="Administrators" ${acc.group === "Administrators" ? "selected" : ""}>${tx("acc.admin", "관리자")}</option>
                  <option value="Users" ${acc.group === "Users" ? "selected" : ""}>${tx("acc.users", "표준 사용자")}</option>
                </select>`,
              )}
            </div>`,
              )
              .join("")}
          </div>
          ${field(
            tx("acc.autoLogon", "설치 직후 로그인"),
            `<select data-bind="autoLogon">
              <option value="first-admin" ${state.autoLogon === "first-admin" ? "selected" : ""}>${tx("acc.logonFirst", "만든 관리자 계정으로 한 번 로그인")}</option>
              <option value="builtin-admin" ${state.autoLogon === "builtin-admin" ? "selected" : ""}>${tx("acc.logonBuiltin", "기본 관리자 계정")}</option>
              <option value="none" ${state.autoLogon === "none" ? "selected" : ""}>${tx("acc.logonNone", "로그인 화면에서 끝내기")}</option>
            </select>`,
          )}
          ${state.autoLogon === "builtin-admin" ? field(tx("acc.builtinPw", "기본 관리자 암호"), input("builtinAdminPassword", "password")) : ""}
          ${check("obscurePasswords", tx("acc.obscure", "파일에 암호를 숨겨 저장"), tx("acc.obscureHint", "완벽한 암호화는 아닙니다"))}`
        : `<p class="note">${tx("acc.noteSetup", "계정은 Windows 설치 화면에서 만듭니다.")}</p>`
    }
    <h3>${tx("acc.pcNameH", "이 PC 이름")}</h3>
    <div class="grid2">
      ${field(
        tx("acc.computerName", "컴퓨터 이름"),
        `<select data-bind="computerNameMode">
          <option value="random" ${state.computerNameMode === "random" ? "selected" : ""}>${tx("acc.nameRandom", "Windows가 임의로 만들기")}</option>
          <option value="custom" ${state.computerNameMode === "custom" ? "selected" : ""}>${tx("common.custom", "직접 지정")}</option>
          <option value="script" ${state.computerNameMode === "script" ? "selected" : ""}>${tx("acc.nameScript", "명령으로 만들기")}</option>
        </select>`,
      )}
      ${state.computerNameMode === "custom" ? field(tx("common.name", "이름"), input("computerName", "text", "DESKTOP-HOME")) : ""}
      ${state.computerNameMode === "script" ? field(tx("acc.nameScriptLabel", "이름 만드는 스크립트"), textarea("computerNameScript", tx("acc.nameScriptPh", "원하는 컴퓨터 이름을 돌려주면 됩니다"))) : ""}
    </div>
    ${details(
      tx("acc.expireLock", "암호 만료 · 잠금"),
      `<div class="grid2">
        ${field(
          tx("acc.expire", "암호 만료"),
          `<select data-bind="passwordExpire">
            <option value="never">${tx("acc.expireNever", "만료 없음")}</option>
            <option value="default" ${state.passwordExpire === "default" ? "selected" : ""}>${tx("acc.winDefault42", "Windows 기본 (42일)")}</option>
            <option value="custom" ${state.passwordExpire === "custom" ? "selected" : ""}>${tx("common.custom", "직접 지정")}</option>
          </select>`,
        )}
        ${state.passwordExpire === "custom" ? field(tx("acc.expireDays", "만료 일수"), input("passwordExpireDays", "number")) : ""}
        ${field(
          tx("acc.lockout", "계정 잠금"),
          `<select data-bind="lockout">
            <option value="default">${tx("common.winDefault", "Windows 기본")}</option>
            <option value="disable" ${state.lockout === "disable" ? "selected" : ""}>${tx("common.off", "끄기")}</option>
            <option value="custom" ${state.lockout === "custom" ? "selected" : ""}>${tx("common.custom", "직접 지정")}</option>
          </select>`,
        )}
        ${
          state.lockout === "custom"
            ? `${field(tx("acc.failCount", "실패 횟수"), input("lockoutThreshold", "number"))}
               ${field(tx("acc.windowMin", "관찰 시간(분)"), input("lockoutWindow", "number"))}
               ${field(tx("acc.lockMin", "잠금 시간(분)"), input("lockoutDuration", "number"))}`
            : ""
        }
      </div>`,
    )}
  `;
}

function panelSetup() {
  return `
    <h2>${tx("nav.setup", "설치·디스크")}</h2>
    <p class="lead">${tx("setup.lead", "디스크를 자동으로 지우는 옵션은 그 안의 파일을 <strong>전부 삭제</strong>합니다. 잘 모르겠으면 설치 화면에서 고르세요.")}</p>
    <div class="grid2">
      ${field(tx("setup.edition", "에디션"), select("edition", EDITIONS), tx("setup.editionHint", "설치만 하고, 정품 인증은 나중에 해도 됩니다"))}
      ${field(
        tx("setup.productKey", "제품 키"),
        `<select data-bind="productKeyMode">
          <option value="generic" ${state.productKeyMode === "generic" ? "selected" : ""}>${tx("setup.keyGeneric", "에디션용 임시 키 (인증은 안 됨)")}</option>
          <option value="interactive" ${state.productKeyMode === "interactive" ? "selected" : ""}>${tx("setup.keyInteractive", "설치할 때 입력")}</option>
          <option value="custom" ${state.productKeyMode === "custom" ? "selected" : ""}>${tx("setup.keyCustom", "키를 직접 입력")}</option>
          <option value="firmware" ${state.productKeyMode === "firmware" ? "selected" : ""}>${tx("setup.keyFirmware", "메인보드에 있는 키 사용")}</option>
        </select>`,
      )}
    </div>
    ${state.productKeyMode === "custom" ? field(tx("setup.productKey", "제품 키"), input("productKey", "text", "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX")) : ""}
    ${field(tx("setup.activationKey", "나중에 쓸 인증 키 (선택)"), input("activationKey"))}
    <div class="arch-row">
      <span class="field-label">${tx("setup.processor", "프로세서")}</span>
      ${check("archAmd64", tx("setup.arch64", "64비트 (Intel/AMD) — 대부분"))}
      ${check("archX86", tx("setup.arch32", "32비트"))}
      ${check("archArm64", tx("setup.archArm", "Arm64"))}
    </div>
    ${check("bypassTpm", tx("setup.bypassTpm", "Windows 11 검사 건너뛰기"), tx("setup.bypassTpmHint", "TPM, 보안 부팅, CPU, 메모리, 저장 공간"), true)}
    ${check("narrator", tx("setup.narrator", "설치 중 내레이터 켜기"))}
    <h3>${tx("setup.howDisk", "디스크를 어떻게 고를까요")}</h3>
    ${radios("peStage", state.peStage, [
      { value: "setup", title: tx("setup.peSetup.title", "설치 화면에서 고르기"), hint: tx("setup.peSetup.hint", "어디에 설치할지 직접 고릅니다") },
      { value: "generate", title: tx("setup.peWipe.title", "디스크를 지우고 자동 설치"), hint: tx("setup.peWipe.hint", "고른 디스크의 파일이 전부 삭제됩니다"), danger: true },
      { value: "script", title: tx("setup.peScript.title", "내가 만든 명령으로 설치"), hint: tx("setup.peScript.hint", "고급 사용자용") },
    ])}
    ${
      state.peStage === "script"
        ? field(tx("setup.peScriptField", "설치 명령"), textarea("customPeScript"))
        : ""
    }
    <h3>${tx("setup.disk", "디스크")}</h3>
    ${
      state.peStage === "setup"
        ? radios("diskMode", state.diskMode, [
            { value: "interactive", title: tx("setup.diskInteractive.title", "설치할 때 내가 고른다"), hint: tx("setup.diskInteractive.hint", "이미 있는 파일을 남기고 싶을 때") },
          ])
        : radios("diskMode", state.diskMode, [
            { value: "wipe", title: tx("setup.diskWipe.title", "디스크를 지우고 자동 설치"), hint: tx("setup.diskWipe.hint", "고른 디스크가 전부 삭제됩니다"), danger: true },
            { value: "diskpartInteractive", title: tx("setup.diskpart.title", "설치 전에 직접 나누기"), hint: tx("setup.diskpart.hint", "검은 화면에서 디스크를 나눕니다") },
            { value: "custom", title: tx("setup.diskCustom.title", "내가 적은 명령으로 나누기") },
          ])
    }
    ${
      state.peStage === "generate" && state.diskMode === "wipe"
        ? `<div class="warn">${tx("setup.usbWarn", "USB가 0번 디스크로 잡히면 USB까지 지워질 수 있습니다. 설치할 디스크 번호를 확인하세요.")}</div>
          <div class="grid2">
            ${field(tx("setup.targetDisk", "설치할 디스크 번호 (0부터)"), input("targetDisk", "number"))}
            ${field(
              tx("setup.partLayout", "파티션 형식"),
              `<select data-bind="partitionLayout">
                <option value="auto" ${state.partitionLayout === "auto" ? "selected" : ""}>${tx("setup.partAuto", "자동 (요즘 PC는 GPT)")}</option>
                <option value="gpt" ${state.partitionLayout === "gpt" ? "selected" : ""}>${tx("setup.partGpt", "GPT (UEFI)")}</option>
                <option value="mbr" ${state.partitionLayout === "mbr" ? "selected" : ""}>${tx("setup.partMbr", "MBR (아주 오래된 PC)")}</option>
              </select>`,
            )}
            ${field(tx("setup.sysPartMb", "시스템 파티션 크기 (MB)"), input("systemPartitionMb", "number"))}
            ${field(
              tx("setup.recovery", "복구 파티션"),
              `<select data-bind="recoveryMode">
                <option value="partition">${tx("setup.recoveryMake", "만들기")}</option>
                <option value="none" ${state.recoveryMode === "none" ? "selected" : ""}>${tx("setup.recoveryNone", "만들지 않기")}</option>
              </select>`,
            )}
            ${state.recoveryMode === "partition" ? field(tx("setup.recoveryMb", "복구 파티션 크기 (MB)"), input("recoveryMb", "number")) : ""}
          </div>
          ${check("pauseBeforeFormat", tx("setup.pauseFormat", "나누기 전에 잠시 멈추기"))}
          ${check("pauseBeforeReboot", tx("setup.pauseReboot", "다시 시작하기 전에 잠시 멈추기"))}`
        : ""
    }
    ${state.peStage === "generate" && state.diskMode === "custom" ? field(tx("setup.diskpartCmd", "디스크 나누는 명령"), textarea("customDiskpart", "SELECT DISK=0")) : ""}
    ${
      state.peStage === "generate"
        ? details(
            tx("setup.assertTitle", "잘못 지우지 않게 확인"),
            `${field(
              tx("setup.assert", "검사"),
              `<select data-bind="assertDisk">
                <option value="none">${tx("setup.assertNone", "하지 않음")}</option>
                <option value="generated" ${state.assertDisk === "generated" ? "selected" : ""}>${tx("setup.assertGen", "용량·종류 확인")}</option>
                <option value="script" ${state.assertDisk === "script" ? "selected" : ""}>${tx("setup.assertScript", "내가 적은 확인")}</option>
              </select>`,
            )}
            ${
              state.assertDisk === "generated"
                ? `<div class="grid2">
                    ${field(tx("setup.minGib", "최소 용량 (GB)"), input("assertMinGiB", "number"))}
                    ${field(tx("setup.maxGib", "최대 용량 (GB)"), input("assertMaxGiB", "number"))}
                  </div>
                  ${check("assertNoPartitions", tx("setup.assertNoPart", "이미 나눠져 있으면 중단"))}
                  ${check("assertInterface", tx("setup.assertIface", "일반 저장장치인지 확인"))}
                  ${check("assertMedia", tx("setup.assertMedia", "내장 디스크인지 확인"))}`
                : ""
            }
            ${state.assertDisk === "script" ? field(tx("setup.assertScriptField", "확인용 스크립트"), textarea("assertScript")) : ""}`,
          )
        : ""
    }
    ${details(
      tx("setup.imageMore", "설치 이미지·기타"),
      `${check("compactOs", tx("setup.compact", "용량을 줄여 설치"))}
       ${check("skipIntegrity", tx("setup.skipIntegrity", "설치 파일 검사 건너뛰기"))}
       ${check("disable8dot3", tx("setup.disable8dot3", "짧은 파일 이름 끄기"))}
       ${check("disableDefenderPe", tx("setup.disableDefenderPe", "설치 초반에 Windows 보안 끄기"))}
       ${field(
         tx("setup.imageApply", "적용할 이미지"),
         `<select data-bind="imageSelect">
            <option value="edition">${tx("setup.imageEdition", "에디션 이름으로")}</option>
            <option value="name" ${state.imageSelect === "name" ? "selected" : ""}>${tx("setup.imageName", "이미지 이름")}</option>
            <option value="index" ${state.imageSelect === "index" ? "selected" : ""}>${tx("setup.imageIndex", "번호로 고르기")}</option>
            <option value="interactive" ${state.imageSelect === "interactive" ? "selected" : ""}>${tx("common.pickAtSetup", "설치할 때 고르기")}</option>
          </select>`,
       )}
       ${state.imageSelect === "name" ? field(tx("setup.imageNameField", "이미지 이름"), input("imageName", "text", "Windows 11 Pro")) : ""}
       ${state.imageSelect === "index" ? field(tx("setup.indexField", "번호"), input("imageIndex", "number")) : ""}`,
    )}
  `;
}

function panelNetwork() {
  return `
    <h2>${tx("nav.network", "네트워크")}</h2>
    ${radios("wifiMode", state.wifiMode, [
      { value: "interactive", title: tx("net.wifiPick", "설치할 때 Wi-Fi 고르기") },
      { value: "skip", title: tx("net.wifiSkip", "Wi-Fi 건너뛰기"), hint: tx("net.wifiSkipHint", "유선이거나 설치 후에 연결") },
      { value: "profile", title: tx("net.wifiProfile", "이름과 암호를 미리 넣기") },
    ])}
    ${
      state.wifiMode === "profile"
        ? `<div class="grid2">
            ${field(tx("net.ssid", "Wi-Fi 이름"), input("wifiSsid"))}
            ${field(tx("common.password", "암호"), input("wifiPassword", "password"))}
            ${field(
              tx("net.security", "보안"),
              `<select data-bind="wifiAuth">
                <option value="WPA2PSK">${tx("net.wpa2", "WPA2 (가장 흔함)")}</option>
                <option value="WPA3SAE" ${state.wifiAuth === "WPA3SAE" ? "selected" : ""}>${tx("net.wpa3", "WPA3")}</option>
                <option value="open" ${state.wifiAuth === "open" ? "selected" : ""}>${tx("net.open", "암호 없음")}</option>
              </select>`,
            )}
          </div>
          ${check("wifiHidden", tx("net.hidden", "목록에 안 보이는 Wi-Fi에도 연결"))}
          ${check("wifiConnectAuto", tx("net.autoConnect", "자동 연결"))}
          ${field(tx("net.wifiXml", "이미 내보낸 Wi-Fi 설정이 있으면 붙여 넣기"), textarea("wifiXml", tx("net.wifiXmlPh", "Windows에서 내보낸 Wi-Fi 설정")))}`
        : ""
    }
    ${check("bypassNetwork", tx("net.bypassNet", "인터넷 없이 설치 허용"), tx("net.bypassNetHint", "정말 인터넷이 없을 때만 켜세요. 로컬 계정만 만들 때는 필요 없습니다"))}
    ${field(
      tx("net.express", "진단·광고 데이터"),
      `<select data-bind="expressSettings">
        <option value="disable">${tx("net.expressOff", "모두 끄기")}</option>
        <option value="enable" ${state.expressSettings === "enable" ? "selected" : ""}>${tx("net.expressOn", "모두 켜기")}</option>
        <option value="interactive" ${state.expressSettings === "interactive" ? "selected" : ""}>${tx("common.pickAtSetup", "설치할 때 고르기")}</option>
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
    <h2>${tx("nav.desktop", "화면·작업줄")}</h2>
    <h3>${tx("desk.explorer", "파일 탐색기")}</h3>
    ${field(
      tx("desk.hideFiles", "숨김 파일"),
      `<select data-bind="hideFiles">
        <option value="hidden">${tx("desk.hideHidden", "숨김 파일 숨기기 (기본)")}</option>
        <option value="protected" ${state.hideFiles === "protected" ? "selected" : ""}>${tx("desk.hideProtected", "보호된 운영 체제 파일만 숨기기")}</option>
        <option value="showall" ${state.hideFiles === "showall" ? "selected" : ""}>${tx("desk.showAll", "모두 표시")}</option>
      </select>`,
    )}
    ${check("showExtensions", tx("desk.showExt", "파일 확장자 항상 표시"))}
    ${check("classicContextMenu", tx("desk.classicMenu", "예전처럼 우클릭 메뉴 쓰기"))}
    ${check("launchToThisPC", tx("desk.thisPc", "탐색기를 '이 PC'로 열기"))}
    ${check("showEndTask", tx("desk.endTask", "작업 표시줄에서 작업 끝내기 표시"))}
    ${check("hideInfoTip", tx("desk.hideTip", "폴더 설명 말풍선 숨기기"))}
    <h3>${tx("desk.taskbarStart", "작업 표시줄 · 시작")}</h3>
    ${field(
      tx("desk.search", "검색창"),
      `<select data-bind="taskbarSearch">
        <option value="box">${tx("desk.searchBox", "검색 상자")}</option>
        <option value="icon" ${state.taskbarSearch === "icon" ? "selected" : ""}>${tx("desk.searchIcon", "아이콘만")}</option>
        <option value="label" ${state.taskbarSearch === "label" ? "selected" : ""}>${tx("desk.searchLabel", "아이콘과 레이블")}</option>
        <option value="hide" ${state.taskbarSearch === "hide" ? "selected" : ""}>${tx("common.hide", "숨기기")}</option>
      </select>`,
    )}
    ${check("disableWidgets", tx("desk.noWidgets", "위젯 끄기"))}
    ${check("leftTaskbar", tx("desk.leftBar", "작업 표시줄 왼쪽 정렬"))}
    ${check("hideTaskView", tx("desk.hideTaskView", "작업 보기 단추 숨기기"))}
    ${check("showAllTray", tx("desk.showTray", "트레이 아이콘 모두 표시"))}
    ${check("disableBing", tx("desk.noBing", "시작 검색에서 Bing 결과 끄기"))}
    ${field(
      tx("desk.startPins", "시작 메뉴 고정 (Windows 11)"),
      `<select data-bind="startPins">
        <option value="default">${tx("common.winDefault", "Windows 기본")}</option>
        <option value="none" ${state.startPins === "none" ? "selected" : ""}>${tx("desk.pinsNone", "고정 모두 제거")}</option>
        <option value="json" ${state.startPins === "json" ? "selected" : ""}>${tx("common.custom", "직접 지정")}</option>
      </select>`,
    )}
    ${state.startPins === "json" ? field(tx("desk.pinsJson", "고정할 앱 목록"), textarea("startPinsJson")) : ""}
    ${field(
      tx("desk.startTiles", "시작 화면 타일 (Windows 10)"),
      `<select data-bind="startTiles">
        <option value="default">${tx("common.winDefault", "Windows 기본")}</option>
        <option value="none" ${state.startTiles === "none" ? "selected" : ""}>${tx("desk.tilesNone", "타일 모두 제거")}</option>
        <option value="xml" ${state.startTiles === "xml" ? "selected" : ""}>${tx("common.custom", "직접 지정")}</option>
      </select>`,
    )}
    ${state.startTiles === "xml" ? field(tx("desk.tilesXml", "타일 설정"), textarea("startTilesXml")) : ""}
    ${field(
      tx("desk.taskbarIcons", "작업 표시줄 아이콘"),
      `<select data-bind="taskbarIcons">
        <option value="default">${tx("common.winDefault", "Windows 기본")}</option>
        <option value="none" ${state.taskbarIcons === "none" ? "selected" : ""}>${tx("desk.iconsNone", "모두 제거")}</option>
        <option value="xml" ${state.taskbarIcons === "xml" ? "selected" : ""}>${tx("common.custom", "직접 지정")}</option>
      </select>`,
    )}
    ${state.taskbarIcons === "xml" ? field(tx("desk.taskbarXml", "작업 표시줄 설정"), textarea("taskbarIconsXml")) : ""}
    <h3>${tx("desk.desktopIcons", "바탕화면 아이콘")}</h3>
    <div class="chip-grid">${desk}</div>
    ${check("deleteEdgeShortcut", tx("desk.delEdge", "바탕화면 Edge 바로가기 삭제"))}
    ${details(tx("desk.startFolders", "시작 메뉴 옆 폴더"), `${check("startFoldersCustom", tx("desk.pickFolders", "직접 고르기"))}<div class="chip-grid">${folders}</div>`)}
    ${details(
      tx("desk.look", "색 · 배경 · 잠금키 · 시각 효과"),
      `${field(
        tx("desk.colorTheme", "색 테마"),
        `<select data-bind="colorMode">
          <option value="default">${tx("common.winDefault", "Windows 기본")}</option>
          <option value="custom" ${state.colorMode === "custom" ? "selected" : ""}>${tx("common.custom", "직접 지정")}</option>
        </select>`,
      )}
      ${
        state.colorMode === "custom"
          ? `<div class="grid2">
              ${field(
                tx("desk.taskbar", "작업 표시줄"),
                `<select data-bind="themeSystem"><option value="dark">${tx("desk.dark", "어둡게")}</option><option value="light" ${state.themeSystem === "light" ? "selected" : ""}>${tx("desk.light", "밝게")}</option></select>`,
              )}
              ${field(
                tx("desk.apps", "앱"),
                `<select data-bind="themeApps"><option value="dark">${tx("desk.dark", "어둡게")}</option><option value="light" ${state.themeApps === "light" ? "selected" : ""}>${tx("desk.light", "밝게")}</option></select>`,
              )}
              ${field(tx("desk.accent", "강조색"), `<input type="color" data-bind="accentColor" value="${htmlEsc(state.accentColor)}">`)}
            </div>
            ${check("accentOnStart", tx("desk.accentStart", "시작 메뉴에 강조색"))}
            ${check("accentOnBorders", tx("desk.accentBorder", "창 테두리에 강조색"))}
            ${check("enableTransparency", tx("desk.transparency", "반투명 효과"))}`
          : ""
      }
      ${field(
        tx("desk.wallpaper", "배경화면"),
        `<select data-bind="wallpaperMode">
          <option value="default">${tx("common.winDefault", "Windows 기본")}</option>
          <option value="solid" ${state.wallpaperMode === "solid" ? "selected" : ""}>${tx("desk.solid", "단색")}</option>
          <option value="script" ${state.wallpaperMode === "script" ? "selected" : ""}>${tx("desk.wpScript", "명령으로 이미지 넣기")}</option>
        </select>`,
      )}
      ${state.wallpaperMode === "solid" ? field(tx("desk.color", "색"), `<input type="color" data-bind="wallpaperColor" value="${htmlEsc(state.wallpaperColor)}">`) : ""}
      ${state.wallpaperMode === "script" ? field(tx("desk.wpScriptField", "배경 이미지를 만드는 스크립트"), textarea("wallpaperScript")) : ""}
      ${field(
        tx("desk.lockScreen", "잠금 화면"),
        `<select data-bind="lockScreenMode">
          <option value="default">${tx("common.winDefault", "Windows 기본")}</option>
          <option value="script" ${state.lockScreenMode === "script" ? "selected" : ""}>${tx("desk.wpScript", "명령으로 이미지 넣기")}</option>
        </select>`,
      )}
      ${state.lockScreenMode === "script" ? field(tx("desk.lockScriptField", "잠금 화면 이미지를 만드는 스크립트"), textarea("lockScreenScript")) : ""}
      ${field(
        tx("desk.effects", "시각 효과"),
        `<select data-bind="effectsMode">
          <option value="default">${tx("common.winDefault", "Windows 기본")}</option>
          <option value="appearance" ${state.effectsMode === "appearance" ? "selected" : ""}>${tx("desk.fxLook", "모양 우선")}</option>
          <option value="performance" ${state.effectsMode === "performance" ? "selected" : ""}>${tx("desk.fxSpeed", "성능 우선")}</option>
          <option value="custom" ${state.effectsMode === "custom" ? "selected" : ""}>${tx("common.custom", "직접 지정")}</option>
        </select>`,
      )}
      ${
        state.effectsMode === "custom"
          ? EFFECTS.map(
              (item) => `<label class="check-line"><input type="checkbox" data-nested="effects" data-key="${item.id}" ${state.effects[item.id] ? "checked" : ""}><span>${tx("effect." + item.id, item.name)}</span></label>`,
            ).join("")
          : ""
      }
      ${field(
        tx("desk.sticky", "고정키"),
        `<select data-bind="stickyKeys">
          <option value="default">${tx("common.winDefault", "Windows 기본")}</option>
          <option value="disable" ${state.stickyKeys === "disable" ? "selected" : ""}>${tx("common.off", "끄기")}</option>
          <option value="custom" ${state.stickyKeys === "custom" ? "selected" : ""}>${tx("common.custom", "직접 지정")}</option>
        </select>`,
      )}
      ${
        state.stickyKeys === "custom"
          ? `${check("stickyHotKey", tx("desk.stickyHot", "Shift 다섯 번으로 켜기"))}
             ${check("stickyIndicator", tx("desk.stickyIcon", "작업 표시줄 아이콘"))}
             ${check("stickyAudible", tx("desk.stickySound", "키 소리"))}
             ${check("stickyHotKeySound", tx("desk.stickyToggleSound", "켜고 끌 때 소리"))}
             ${check("stickyTwoKeysOff", tx("desk.stickyTwoKeys", "두 키 동시 누르면 끄기"))}
             ${check("stickyTriState", tx("desk.stickyLock", "두 번 누르면 잠금"))}`
          : ""
      }
      ${check("lockKeys", tx("desk.lockKeys", "Caps/Num/Scroll Lock 초기값 지정"))}
      ${
        state.lockKeys
          ? `<div class="grid2">
              ${field(tx("desk.capsInit", "Caps Lock 초기"), `<select data-bind="capsInitial"><option value="off">${tx("common.offState", "끔")}</option><option value="on" ${state.capsInitial === "on" ? "selected" : ""}>${tx("common.onState", "켬")}</option></select>`)}
              ${field(tx("desk.capsBeh", "Caps Lock 동작"), `<select data-bind="capsBehavior"><option value="toggle">${tx("desk.toggle", "토글")}</option><option value="ignore" ${state.capsBehavior === "ignore" ? "selected" : ""}>${tx("desk.ignore", "무시")}</option></select>`)}
              ${field(tx("desk.numInit", "Num Lock 초기"), `<select data-bind="numInitial"><option value="off">${tx("common.offState", "끔")}</option><option value="on" ${state.numInitial === "on" ? "selected" : ""}>${tx("common.onState", "켬")}</option></select>`)}
              ${field(tx("desk.numBeh", "Num Lock 동작"), `<select data-bind="numBehavior"><option value="toggle">${tx("desk.toggle", "토글")}</option><option value="ignore" ${state.numBehavior === "ignore" ? "selected" : ""}>${tx("desk.ignore", "무시")}</option></select>`)}
              ${field(tx("desk.scrollInit", "Scroll Lock 초기"), `<select data-bind="scrollInitial"><option value="off">${tx("common.offState", "끔")}</option><option value="on" ${state.scrollInitial === "on" ? "selected" : ""}>${tx("common.onState", "켬")}</option></select>`)}
              ${field(tx("desk.scrollBeh", "Scroll Lock 동작"), `<select data-bind="scrollBehavior"><option value="toggle">${tx("desk.toggle", "토글")}</option><option value="ignore" ${state.scrollBehavior === "ignore" ? "selected" : ""}>${tx("desk.ignore", "무시")}</option></select>`)}
            </div>`
          : ""
      }`,
    )}
  `;
}

function panelSystem() {
  return `
    <h2>${tx("nav.system", "시스템")}</h2>
    <div class="check-stack">
      ${check("preventBitlocker", tx("sys.bitlocker", "장치 자동 암호화(BitLocker) 끄기"))}
      ${check("disableAppSuggestions", tx("sys.noSuggest", "앱 추천·제안 끄기"))}
      ${check("hideEdgeFre", tx("sys.hideEdgeFre", "Edge 첫 실행 화면 숨기기"))}
      ${check("disableEdgeBoost", tx("sys.noEdgeBoost", "Edge 백그라운드·시작 부스트 끄기"))}
      ${check("makeEdgeUninstallable", tx("sys.edgeUninstall", "Edge 제거 가능하게 만들기"), tx("sys.edgeUninstallHint", "업데이트와 충돌할 수 있습니다"), true)}
      ${check("disableWindowsUpdate", tx("sys.delayWu", "Windows Update 계속 미루기"), tx("sys.delayWuHint", "권장하지 않습니다"), true)}
      ${check("preventReboot", tx("sys.noReboot", "업데이트 후 자동으로 다시 시작하지 않기"))}
      ${check("disableUac", tx("sys.noUac", "사용자 계정 컨트롤(UAC) 끄기"), tx("sys.noUacHint", "테스트용입니다. Microsoft 계정과 충돌할 수 있습니다"), true)}
      ${check("disableSmartScreen", tx("sys.noSmartScreen", "SmartScreen 끄기"))}
      ${check("disableSac", tx("sys.noSac", "앱 실행 보호 끄기"), tx("sys.noSacHint", "다시 켜기 어렵습니다"), true)}
      ${check("disableFastStartup", tx("sys.noFastStart", "빠른 시작 끄기"))}
      ${check("disableSystemRestore", tx("sys.noRestore", "시스템 복원 끄기"))}
      ${check("enableLongPaths", tx("sys.longPaths", "아주 긴 폴더 이름 허용"))}
      ${check("enableRdp", tx("sys.rdp", "원격 데스크톱 켜기"))}
      ${check("hardenAcl", tx("sys.hardenAcl", "C 드라이브 권한 강화"))}
      ${check("deleteJunctions", tx("sys.delJunctions", "숨겨진 바로가기 폴더 삭제"))}
      ${check("allowPsScripts", tx("sys.allowPs", "PowerShell 스크립트 실행 허용"))}
      ${check("disableLastAccess", tx("sys.noLastAccess", "파일 마지막 사용 시간 기록 끄기"))}
      ${check("turnOffSounds", tx("sys.noSounds", "시스템 소리 끄기"))}
      ${check("disablePointerPrecision", tx("sys.noPointer", "마우스 정확도 향상 끄기"))}
      ${check("deleteWindowsOld", tx("sys.delOld", "빈 Windows.old 폴더 삭제"))}
      ${check("disableAutoSignOn", tx("sys.noAutoSign", "다시 시작한 뒤 자동 로그인 끄기"))}
      ${check("disableWpbt", tx("sys.noWpbt", "제조사 사전 설치 프로그램 끄기"))}
      ${check("preventDeviceApps", tx("sys.noDeviceApps", "장치 연결 시 앱 자동 설치 막기"))}
      ${check("processAudit", tx("sys.audit", "프로그램 실행 기록 남기기"))}
      ${state.processAudit ? check("processAuditCmdline", tx("sys.auditCmd", "기록에 명령도 포함")) : ""}
      ${check("disableCoreIsolation", tx("sys.noCoreIso", "코어 격리 끄기"), tx("sys.noCoreIsoHint", "게임은 빨라질 수 있지만 가상 머신에 영향이 있습니다"))}
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
          <span>${item.name}${item.id === "RemoveStore" ? `<small>${tx("apps.storeWarn", "지우면 다시 설치하기 어렵습니다")}</small>` : ""}</span>
        </label>`,
      )
      .join("");
    return `<details class="more" ${group.id === "recommended" ? "open" : ""}><summary>${tx("group." + group.id, group.name)}</summary><div class="more-body chip-grid">${checks}</div></details>`;
  }).join("");
  return `
    <h2>${tx("nav.apps", "앱 제거")}</h2>
    <p class="lead">${tx("apps.lead", "설치가 끝난 뒤 선택한 앱을 지웁니다. Microsoft Store는 지우지 않는 것이 좋습니다.")}</p>
    <div class="row-actions">
      <button type="button" class="btn-ghost" data-bloat="none">${tx("apps.none", "모두 해제")}</button>
      <button type="button" class="btn-ghost" data-bloat="home">${tx("apps.home", "가정용 추천")}</button>
      <button type="button" class="btn-ghost" data-bloat="minimal">${tx("apps.minimal", "미니멀 추천")}</button>
    </div>
    ${groups}
  `;
}

function panelAdvanced() {
  return `
    <h2>${tx("nav.advanced", "고급")}</h2>
    ${check("useOemFolder", tx("adv.oem", "USB에 넣어 둔 추가 파일을 Windows에 복사"))}
    ${check("hidePowerShell", tx("adv.hidePs", "설치 중 검은 창 숨기기"), tx("adv.hidePsHint", "입력이 필요한 명령이면 끄세요"))}
    ${check("keepSensitiveFiles", tx("adv.keepFiles", "암호가 들어 있는 설치 파일을 남기기"), tx("adv.keepFilesHint", "기본은 설치가 끝나면 지웁니다"))}
    <h3>${tx("adv.vm", "가상머신 도구")}</h3>
    ${check("vboxGuest", tx("adv.vbox", "VirtualBox 게스트 도구"))}
    ${check("vmwareTools", tx("adv.vmware", "VMware Tools"))}
    ${check("virtio", tx("adv.virtio", "QEMU / KVM 게스트 도구"))}
    ${check("parallels", tx("adv.parallels", "Parallels Tools"))}
    <p class="note">${tx("adv.vmNote", "가상머신에 도구 디스크를 직접 넣어야 합니다. 이 옵션은 설치가 끝난 뒤 설치를 시도합니다.")}</p>
    <h3>${tx("adv.scripts", "사용자 스크립트")}</h3>
    ${SCRIPT_PHASES.map(
      (phase) => details(
        tx("phase." + phase.id, phase.name),
        (state.scriptSlots[phase.id] || [])
          .map(
            (slot, i) => `<div class="grid2">
              ${field(
                txf("adv.cmdN", "명령 {n} 종류", { n: i + 1 }),
                `<select data-slot-phase="${phase.id}" data-slot-index="${i}" data-slot-field="type">
                  ${phase.types.map((t) => `<option value="${t}" ${slot.type === t ? "selected" : ""}>.${t}</option>`).join("")}
                </select>`,
              )}
              ${field(tx("adv.content", "내용"), `<textarea data-slot-phase="${phase.id}" data-slot-index="${i}" data-slot-field="content" rows="5">${htmlEsc(slot.content)}</textarea>`)}
            </div>`,
          )
          .join(""),
      ),
    ).join("")}
    ${check("restartExplorer", tx("adv.restartExplorer", "스크립트 후 탐색기 다시 시작"))}
    ${field(tx("adv.appLocker", "앱 실행 허용 정책"), textarea("appLocker"))}
    ${details(
      tx("adv.components", "Windows 설치 항목을 직접 넣기"),
      COMPONENTS.map(
        (comp) => details(
          comp.id,
          comp.passes
            .map(
              (pass) => field(
                `${pass}`,
                `<textarea data-comp="${pass}|${comp.id}" rows="4" placeholder="${htmlEsc(tx("adv.compPh", "넣을 내용만 붙여 넣으세요"))}">${htmlEsc(state.componentXml?.[`${pass}|${comp.id}`] || "")}</textarea>`,
              ),
            )
            .join(""),
        ),
      ).join(""),
    )}
    ${field(tx("adv.extraXml", "추가로 넣을 설치 설정"), textarea("extraXml", tx("adv.extraXmlPh", "필요한 내용만 붙여 넣으세요")))}
    ${field(
      tx("adv.downloadName", "받을 파일 이름"),
      `<select data-bind="downloadName">
        <option value="autounattend.xml">${tx("adv.dlAuto", "autounattend.xml (USB에 넣으면 자동 적용)")}</option>
        <option value="notautounattend.xml" ${state.downloadName === "notautounattend.xml" ? "selected" : ""}>${tx("adv.dlOther", "다른 이름 (직접 지정해서 설치할 때)")}</option>
      </select>`,
    )}
    ${check("downloadIso", tx("adv.iso", "디스크 이미지(ISO)로 받기"))}
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
      return state.languageInteractive ? tx("sum.pickSetup", "설치 때 고름") : imageLanguageName(state.imageLanguage) || state.imageLanguage;
    case "account":
      if (state.accountMode === "local") return state.accountName ? txf("sum.localName", "로컬 {name}", { name: state.accountName }) : tx("sum.localNoName", "로컬 (이름 없음)");
      return tx("sum.pickSetup", "설치 때 고름");
    case "setup":
      return `${state.peStage === "generate" || state.diskMode === "wipe" ? tx("sum.wipeDisk", "디스크 자동 삭제") : tx("sum.pickInstall", "설치할 때 고름")} · ${state.bypassTpm ? tx("sum.skipChecks", "검사 건너뜀") : EDITIONS.find((e) => e.id === state.edition)?.name || ""}`;
    case "network":
      return state.wifiMode === "skip" ? tx("sum.wifiSkip", "Wi-Fi 건너뜀") : state.wifiMode === "profile" ? state.wifiSsid || tx("sum.wifiPre", "Wi-Fi 미리 입력") : tx("sum.wifiSetup", "Wi-Fi 설치 때");
    case "desktop":
      return [state.classicContextMenu && tx("sum.classic", "클래식 메뉴"), state.showExtensions && tx("sum.ext", "확장자")].filter(Boolean).join(" · ") || tx("sum.default", "기본");
    case "system": {
      const n = [
        "preventBitlocker",
        "disableAppSuggestions",
        "hideEdgeFre",
        "disableWindowsUpdate",
        "disableUac",
        "enableRdp",
      ].filter((k) => state[k]).length;
      return n ? txf("sum.nOn", "{n}개 켜짐", { n }) : tx("sum.default", "기본");
    }
    case "apps": {
      const n = Object.values(state.bloatware).filter(Boolean).length;
      return n ? txf("sum.nRemove", "{n}개 제거", { n }) : tx("sum.noRemove", "제거 없음");
    }
    case "advanced": {
      const slots = Object.values(state.scriptSlots || {}).flat();
      const hasScript = slots.some((s) => s?.content?.trim()) || state.extraXml;
      return hasScript || state.downloadIso ? tx("sum.custom", "사용자 정의 있음") : tx("sum.none", "없음");
    }
    default:
      return "";
  }
}

function navName(item) {
  return tx("nav." + item.id, item.name);
}

function renderNav() {
  $("#nav").innerHTML = NAV.map(
    (item) => `<button type="button" class="nav-item ${section === item.id ? "is-active" : ""}" data-nav="${item.id}">
      <span>${navName(item)}</span>
      <small>${summaryFor(item.id)}</small>
    </button>`,
  ).join("");
  const jump = $("#section-jump");
  if (!jump) return;
  jump.innerHTML = NAV.map((item) => {
    const extra = summaryFor(item.id);
    const label = extra ? `${navName(item)} · ${extra}` : navName(item);
    return `<option value="${item.id}" ${section === item.id ? "selected" : ""}>${label}</option>`;
  }).join("");
}

function renderModes() {
  $("#modes").innerHTML = MODES.map(
    (item) => `<button type="button" class="mode-btn ${state.mode === item.id ? "is-active" : ""}" data-mode="${item.id}" title="${htmlEsc(tx("mode." + item.id + ".hint", item.hint))}">
      ${tx("mode." + item.id + ".name", item.name)}
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
  const modeName = tx("mode." + state.mode + ".name", MODES.find((m) => m.id === state.mode)?.name || "");
  $("#mode-note").textContent =
    state.mode === "custom"
      ? tx("note.custom", "원하는 값을 직접 고릅니다. 빠르게 가려면 위의 가정용 클린을 누르세요.")
      : txf("note.filled", "{name} 설정이 채워져 있습니다. 왼쪽에서 바꾸고 싶은 항목만 고치면 됩니다.", { name: modeName });
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
    showToast(tx("toast.presetAgain", "자주 쓰는 설정을 다시 넣었습니다. 계정과 Wi-Fi는 그대로입니다."));
    return;
  }
  const ok = window.confirm(
    mode === "custom"
      ? tx("confirm.custom", "직접 설정으로 돌아가면 화면·앱 정리가 기본값으로 돌아갑니다. 계정과 Wi-Fi는 유지됩니다.")
      : tx("confirm.preset", "이 설정으로 화면·앱 정리 값이 바뀝니다. 계정, Wi-Fi, 컴퓨터 이름은 유지됩니다."),
  );
  if (!ok) return;
  state = applyPreset(state, mode);
  renderAll();
}

function downloadXml() {
  if (state.accountMode === "local" && !String(state.accountName || "").trim()) {
    section = "account";
    renderAll();
    showToast(tx("toast.needName", "로컬 계정 이름을 입력하세요."), true);
    return;
  }
  if (state.accountMode === "local" && !(state.accounts || []).some((a) => a.name && a.group === "Administrators") && state.autoLogon !== "builtin-admin") {
    section = "account";
    renderAll();
    showToast(tx("toast.needAdmin", "관리자 계정이 하나 필요합니다."), true);
    return;
  }
  if (!state.archAmd64 && !state.archX86 && !state.archArm64) {
    showToast(tx("toast.needArch", "프로세서 종류를 하나 이상 고르세요."), true);
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
    showToast(tx("toast.savedIso", "설치 파일을 이미지로 저장했습니다. USB나 가상머신에 넣으면 됩니다."));
    return;
  }
  const blob = new Blob([xml], { type: "text/xml;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = downloadName(state);
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(tx("toast.savedXml", "파일을 저장했습니다. USB 맨 위에 넣으세요."));
}

async function importXml(file) {
  const text = await file.text();
  try {
    const loaded = parseSavedXml(text);
    state = migrateConfig(loaded);
    if (!MODES.some((m) => m.id === state.mode)) state.mode = "custom";
    renderAll();
    showToast(tx("toast.imported", "설정을 불러왔습니다. 바꾸고 싶은 항목만 고치면 됩니다."));
  } catch (err) {
    showToast(err.message || tx("toast.importFail", "불러오지 못했습니다."), true);
  }
}

function previewXml() {
  const dlg = $("#preview-dialog");
  $("#preview-code").textContent = generateXml(state);
  dlg.showModal();
}

function boot() {
  const startRender = () => renderAll();
  if (window.ITZ_I18N && typeof window.ITZ_I18N.isCatalogReady === "function" && window.ITZ_I18N.isCatalogReady()) {
    startRender();
  } else {
    const fallback = window.setTimeout(startRender, 1200);
    document.addEventListener(
      "itz:lang-change",
      () => {
        window.clearTimeout(fallback);
        startRender();
      },
      { once: true },
    );
  }
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
  document.addEventListener("itz:lang-change", () => renderAll());
  void showAdSense("editorAboveWorkspace", "#editor-ad-above-path");
  void showAdSense("editorBelowExport", "#editor-ad-below-export");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
