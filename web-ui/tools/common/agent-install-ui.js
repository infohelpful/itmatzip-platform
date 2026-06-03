/**
 * 로컬 에이전트 설치 안내 다이얼로그 HTML (편집·다운로드 페이지 공용)
 * 다운로드 URL·버전은 agent-update-manifest.json 을 매번 조회합니다.
 */

/** @returns {boolean} */
function isBraveBrowser() {
  return typeof navigator !== "undefined" && navigator.brave != null;
}

/** agent/common/update_config.py 의 DEFAULT_UPDATE_MANIFEST_URL (원격 백업) */
export const AGENT_UPDATE_MANIFEST_URL =
  "https://raw.githubusercontent.com/infohelpful/itmatzip-platform/main/agent/agent-update-manifest.json";

const JSDELIVR_MANIFEST_URL =
  "https://cdn.jsdelivr.net/gh/infohelpful/itmatzip-platform@main/agent/agent-update-manifest.json";

/** manifest 조회 실패 시 사용 (agent/agent-update-manifest.json 과 동기화) */
const FALLBACK_RELEASE = {
  version: "1.3.5",
  download_url:
    "https://github.com/infohelpful/itmatzip-platform/releases/download/v1.3.5/itmatzip-agent.msi",
  package_type: "msi",
};

/** @returns {string[]} CORS-safe manifest URL 후보 (우선순위 순) */
function manifestSourceUrls() {
  const urls = [];
  if (typeof globalThis.location !== "undefined" && globalThis.location.href) {
    try {
      urls.push(
        new URL(
          "../assets/agent-update-manifest.json",
          globalThis.location.href,
        ).href,
      );
    } catch {
      /* ignore */
    }
  }
  urls.push(JSDELIVR_MANIFEST_URL, AGENT_UPDATE_MANIFEST_URL);
  return urls;
}

/** @type {Promise<{ version: string, download_url: string, package_type: string }> | null} */
let _manifestInflight = null;

/**
 * manifest JSON — 탭을 열어 둔 채 버전이 올라가도 stale URL 을 쓰지 않도록 매 호출 fresh fetch.
 * @returns {Promise<{ version: string, download_url: string, package_type: string }>}
 */
export async function fetchAgentReleaseManifest() {
  if (_manifestInflight) return _manifestInflight;

  _manifestInflight = (async () => {
    let lastErr = null;
    for (const baseUrl of manifestSourceUrls()) {
      try {
        const bust = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}_${Date.now()}`;
        // 커스텀 헤더는 GitHub raw 에서 CORS preflight 를 유발하므로 simple GET 만 사용
        const res = await fetch(bust, { cache: "no-store" });
        if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
        const data = await res.json();
        const version = String(data?.version ?? "").trim();
        const packageType = String(data?.package_type ?? "msi").trim() || "msi";
        const url = String(
          data?.msi_download_url ?? data?.download_url ?? "",
        ).trim();
        if (!url) throw new Error("manifest에 download_url 없음");
        return {
          version: version || FALLBACK_RELEASE.version,
          download_url: url,
          package_type: packageType,
        };
      } catch (e) {
        lastErr = e;
      }
    }
    console.warn("[agent-install] manifest 조회 실패 — fallback 사용", lastErr);
    return { ...FALLBACK_RELEASE };
  })().finally(() => {
    _manifestInflight = null;
  });

  return _manifestInflight;
}

/**
 * @returns {Promise<string>}
 */
export async function getAgentDownloadHref() {
  const manifest = await fetchAgentReleaseManifest();
  return manifest.download_url;
}

export function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * GitHub 등 외부 URL에 `download` 를 쓰면 브라우저가 현재 사이트에서 파일을 찾아 404가 납니다.
 * @param {string} rawHref
 */
function agentDownloadLinkAttrs(rawHref) {
  const href = escHtml(rawHref);
  let sameOrigin = false;
  try {
    const resolved = new URL(rawHref, globalThis.location?.href ?? "https://tools.itmatzip.com/");
    sameOrigin =
      typeof globalThis.location !== "undefined" &&
      resolved.origin === globalThis.location.origin;
  } catch {
    sameOrigin = true;
  }
  if (sameOrigin) {
    return `href="${href}" download`;
  }
  return `href="${href}" target="_blank" rel="noopener noreferrer"`;
}

/** 확장·Chrome 설정이 로컬(에이전트) 연결만 막을 때 — 광고 안내와 별도 */
export function buildAgentAccessBlockedDialogBodyHtml() {
  if (isBraveBrowser()) {
    return `
    <p class="itz-modal__msg">
      광고 허용·Shields 조정을 했어도, <strong>PC 프로그램(에이전트)과의 연결</strong>은
      여전히 막히고 있습니다.
    </p>
    <p class="itz-modal__msg">
      광고만 허용하는 설정으로는 <strong>에이전트 통신</strong>이 풀리지 않을 때가 많습니다.
      <strong>Shields 끔</strong> + 광고 차단 <strong>확장 사용 끔</strong>이 필요합니다.
    </p>
    <ol class="itz-modal__steps">
      <li>주소창 <strong>사자(Brave) 아이콘</strong> → <strong>Shields 끔</strong></li>
      <li>광고 차단 <strong>확장 아이콘</strong> 우클릭 → <strong>확장 프로그램 관리</strong> → <strong>사용 끔</strong></li>
      <li><strong>F5</strong> 새로고침 → 아래 <strong>다시 연결 확인</strong></li>
    </ol>
    <p class="itz-modal__hint">그래도 안 되면: 자물쇠 → 사이트 설정 → <strong>로컬 네트워크 허용</strong></p>
  `.trim();
  }
  return `
    <p class="itz-modal__msg">
      광고 차단을 이 사이트에서만 해제했어도,
      <strong>광고 차단 확장</strong>이 PC 프로그램(에이전트)과의 <strong>통신은 계속 막고</strong> 있습니다.
    </p>
    <p class="itz-modal__msg">
      「이 사이트 허용」「일시 중지」로는 부족한 경우가 많습니다.
      <strong>확장 프로그램 사용을 꺼 주세요.</strong>
    </p>
    <ol class="itz-modal__steps">
      <li>Chrome 위 <strong>광고 차단 확장 아이콘</strong> 우클릭</li>
      <li><strong>확장 프로그램 관리</strong> → 해당 확장 <strong>사용 끔</strong></li>
      <li><strong>F5</strong> 새로고침 → 아래 <strong>다시 연결 확인</strong></li>
    </ol>
    <p class="itz-modal__hint">그래도 안 되면: 주소창 <strong>자물쇠</strong> → <strong>로컬 네트워크 허용</strong></p>
  `.trim();
}

/** @param {() => Promise<unknown>} onPrimaryCheck */
export async function agentAccessBlockedDialogOptions(onPrimaryCheck) {
  return {
    title: "에이전트 통신이 차단되었습니다",
    bodyHtml: buildAgentAccessBlockedDialogBodyHtml(),
    primaryLabel: "다시 연결 확인",
    onPrimary: onPrimaryCheck,
    dialogKind: "agent-block",
  };
}

/**
 * @param {string} downloadHref
 * @param {string} [version]
 * @param {string} [packageType]
 */
export function buildAgentInstallDialogBodyHtml(
  downloadHref,
  version = "",
  packageType = "msi",
) {
  const linkAttrs = agentDownloadLinkAttrs(downloadHref);
  const verLabel = version ? ` v${escHtml(version)}` : "";
  const isMsi = String(packageType).toLowerCase() === "msi";
  const pkgName = isMsi ? "itmatzip-agent.msi" : "itmatzip-agent.exe";
  const installHint = isMsi
    ? "MSI를 실행해 설치한 뒤, 작업 표시줄 트레이에 ItMatZip 아이콘이 뜨는지 확인하세요."
    : "실행 파일을 받아 실행하면 설치됩니다.";

  return `
<div class="itz-install__intro">
  <p>
    본 웹사이트는 기능을 편리하게 이용할 수 있는 <strong>화면(인터페이스)</strong>만 제공할 뿐,
    회원님의 소중한 데이터는 <strong>외부 서버로 절대 업로드되거나 저장되지 않습니다</strong>.
  </p>
  <p>
    모든 기능은 오직 회원님의 컴퓨터 내부에서만 독립적으로 실행되므로 자료 유출 우려가 전혀 없습니다.
    이 안전하고 강력한 로컬 기능을 정상적으로 이용하기 위해 <strong>최초 1회 전용 프로그램(에이전트) 설치</strong>가 필요합니다.
  </p>
</div>
<div class="itz-install__cards">
  <section class="itz-install__card--new">
    <h3 class="itz-install__card-title">처음 이용하시나요?</h3>
    <p class="itz-install__card-text">
      아래에서 <strong>${escHtml(pkgName)}</strong>${verLabel} 을 받아 설치하세요.
      ${installHint}
    </p>
    <p class="itz-install__card-text itz-install__card-note">
      설치 후 웹에서 <strong>다시 연결 확인</strong>을 눌러 주세요.
      에이전트를 <strong>삭제·제거</strong>했거나 버전을 올릴 때도 여기서 최신 MSI 를 받으면 됩니다.
      (탭을 오래 켜 둔 경우 <strong>F5 새로고침</strong> 후 다운로드하세요.)
    </p>
    <a class="itz-install__download-btn" ${linkAttrs} role="button">에이전트 다운로드${verLabel}</a>
  </section>
  <section class="itz-install__card--installed">
    <h3 class="itz-install__card-title">이미 설치하셨나요?</h3>
    <p class="itz-install__card-text">
      프로그램이 켜져 있는지 확인하신 후, 하단 <strong>다시 연결 확인</strong>을 눌러 주세요.
      업데이트 직후에는 트레이 아이콘을 우클릭 → <strong>종료</strong> 후 다시 실행하거나 PC 를 재부팅하세요.
    </p>
    <p class="itz-install__card-text itz-install__card-note">
      Chrome 사용 시 주소창 왼쪽 <strong>사이트 설정</strong> → <strong>로컬 네트워크</strong>를
      <strong>허용</strong>해야 합니다. 콘솔에 <code>ERR_BLOCKED_BY_CLIENT</code> 가 보이면
      <strong>광고 차단 확장</strong>이 <code>127.0.0.1</code> 을 막는 경우가 많습니다.
    </p>
  </section>
</div>
`.trim();
}

/** @param {() => Promise<unknown>} onPrimaryCheck */
export async function agentInstallDialogOptions(onPrimaryCheck) {
  const manifest = await fetchAgentReleaseManifest();
  return {
    title: "로컬 에이전트에 연결할 수 없습니다",
    bodyHtml: buildAgentInstallDialogBodyHtml(
      manifest.download_url,
      manifest.version,
      manifest.package_type,
    ),
    primaryLabel: "다시 연결 확인",
    onPrimary: onPrimaryCheck,
  };
}
