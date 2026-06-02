/**
 * 로컬 에이전트 설치 안내 다이얼로그 HTML (편집·다운로드 페이지 공용)
 * 다운로드 URL은 agent-update-manifest.json 의 download_url 을 사용합니다.
 */

/** agent/common/update_config.py 의 DEFAULT_UPDATE_MANIFEST_URL 과 동일 */
export const AGENT_UPDATE_MANIFEST_URL =
  "https://raw.githubusercontent.com/infohelpful/itmatzip-platform/main/agent/agent-update-manifest.json";

/** manifest 조회 실패 시 사용 (agent/agent-update-manifest.json 의 download_url 과 동일하게 유지) */
const FALLBACK_DOWNLOAD_HREF =
  "https://github.com/infohelpful/itmatzip-platform/releases/download/v1.1.8/itmatzip-agent.msi";

/** @type {string | null} */
let _downloadHrefCache = null;

/** @type {Promise<string> | null} */
let _downloadHrefPromise = null;

/**
 * manifest JSON 에서 download_url 을 읽습니다 (결과 캐시).
 * @returns {Promise<string>}
 */
export async function getAgentDownloadHref() {
  if (_downloadHrefCache) return _downloadHrefCache;
  if (_downloadHrefPromise) return _downloadHrefPromise;

  _downloadHrefPromise = (async () => {
    try {
      const res = await fetch(AGENT_UPDATE_MANIFEST_URL, {
        cache: "no-cache",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
      const data = await res.json();
      const url = String(data?.download_url ?? "").trim();
      if (!url) throw new Error("manifest에 download_url 없음");
      _downloadHrefCache = url;
      return url;
    } catch (e) {
      console.warn("[agent-install] manifest에서 download_url을 읽지 못해 fallback 사용", e);
      _downloadHrefCache = FALLBACK_DOWNLOAD_HREF;
      return FALLBACK_DOWNLOAD_HREF;
    } finally {
      _downloadHrefPromise = null;
    }
  })();

  return _downloadHrefPromise;
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

/**
 * @param {string} downloadHref
 */
/**
 * 광고 차단·보안 확장이 127.0.0.1 /health 를 막을 때 (에이전트는 실행 중)
 * @param {string} [downloadHref]
 */
export function buildAgentAccessBlockedDialogBodyHtml(downloadHref) {
  const linkAttrs = downloadHref ? agentDownloadLinkAttrs(downloadHref) : "";
  const downloadBlock = downloadHref
    ? `<a class="itz-install__download-btn" ${linkAttrs} role="button">에이전트 다운로드</a>`
    : "";
  return `
<div class="itz-install__intro">
  <p>
    <strong>에이전트는 PC에 설치·실행 중</strong>인데, 이 Chrome 창(프로필)의 확장 프로그램이
  <strong>로컬 주소(<code>127.0.0.1</code>) 연결</strong>을 막고 있습니다.
  (콘솔에 <code>ERR_BLOCKED_BY_CLIENT</code> 가 보이면 동일한 증상입니다.)
  </p>
  <p>Chrome을 두 개 띄웠다면, <strong>확장 설정이 프로필마다 다릅니다.</strong> 연결되는 창과 안 되는 창의 확장 목록을 비교해 보세요.</p>
</div>
<div class="itz-install__cards">
  <section class="itz-install__card--new">
    <h3 class="itz-install__card-title">1. 광고·보안 확장 프로그램</h3>
    <p class="itz-install__card-text">
      AdBlock, uBlock, AdGuard, 「우클릭 차단」 등이 <strong>이 사이트(tools.itmatzip.com)에서 허용</strong>되어 있는지 확인하세요.
      「전역 비활성화」만으로는 <strong>localhost / 127.0.0.1 요청</strong>이 계속 막히는 경우가 많습니다.
    </p>
    <p class="itz-install__card-text itz-install__card-note">
      확장 설정에서 <strong>127.0.0.1</strong> 또는 <strong>로컬 네트워크 요청</strong> 허용을 켜거나,
      테스트용으로 확장을 잠시 끈 뒤 <strong>새로고침(F5)</strong> 하세요.
    </p>
  </section>
  <section class="itz-install__card--installed">
    <h3 class="itz-install__card-title">2. Chrome 사이트 설정</h3>
    <p class="itz-install__card-text">
      주소창 왼쪽 자물쇠(또는 슬라이더) → <strong>사이트 설정</strong> →
      <strong>로컬 네트워크</strong> 를 <strong>허용</strong>한 뒤 새로고침하세요.
    </p>
    <p class="itz-install__card-text itz-install__card-note">
      작업 표시줄에 <strong>ItMatZip Agent</strong> 가 떠 있는지도 확인하세요.
    </p>
  </section>
</div>
${downloadBlock ? `<p class="itz-install__card-text" style="margin-top:1rem;text-align:center">에이전트가 없다면: ${downloadBlock}</p>` : ""}
`.trim();
}

/** @param {() => Promise<unknown>} onPrimaryCheck */
export async function agentAccessBlockedDialogOptions(onPrimaryCheck) {
  const downloadHref = await getAgentDownloadHref();
  return {
    title: "브라우저가 로컬 에이전트 연결을 차단하고 있습니다",
    bodyHtml: buildAgentAccessBlockedDialogBodyHtml(downloadHref),
    primaryLabel: "다시 연결 확인",
    onPrimary: onPrimaryCheck,
  };
}

export function buildAgentInstallDialogBodyHtml(downloadHref) {
  const linkAttrs = agentDownloadLinkAttrs(downloadHref);
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
      아래에서 <strong>itmatzip-agent.exe</strong> 하나만 받아 실행하세요.
      첫 실행 시 자동으로 설치되고, 이후 Windows 로그인마다 백그라운드에서 켜집니다.
    </p>
    <p class="itz-install__card-text itz-install__card-note">
      별도 bat·설치 마법사는 필요 없습니다. 실행 후 잠시 뒤 웹에서 <strong>다시 연결 확인</strong>을 눌러 주세요.
    </p>
    <a class="itz-install__download-btn" ${linkAttrs} role="button">에이전트 다운로드</a>
  </section>
  <section class="itz-install__card--installed">
    <h3 class="itz-install__card-title">이미 설치하셨나요?</h3>
    <p class="itz-install__card-text">
      프로그램이 켜져 있는지 확인하신 후, 하단 <strong>다시 연결 확인</strong>을 눌러 주세요.
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
  const downloadHref = await getAgentDownloadHref();
  return {
    title: "로컬 에이전트에 연결할 수 없습니다",
    bodyHtml: buildAgentInstallDialogBodyHtml(downloadHref),
    primaryLabel: "다시 연결 확인",
    onPrimary: onPrimaryCheck,
  };
}
