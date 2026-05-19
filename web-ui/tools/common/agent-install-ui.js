/**
 * 로컬 에이전트 설치 안내 다이얼로그 HTML (편집·다운로드 페이지 공용)
 */

import { showAdSense } from "./adsense.js";

/** 호스팅 경로에 맞게 수정 */
export const AGENT_DOWNLOAD_HREF = "/downloads/itmatzip-agent.exe";

export function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildAgentInstallDialogBodyHtml() {
  const href = escHtml(AGENT_DOWNLOAD_HREF);
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
    <div class="itz-install__ad-slot" id="itz-install-ad-slot" aria-label="광고 영역"></div>
    <a class="itz-install__download-btn" href="${href}" download role="button">에이전트 다운로드</a>
  </section>
  <section class="itz-install__card--installed">
    <h3 class="itz-install__card-title">이미 설치하셨나요?</h3>
    <p class="itz-install__card-text">
      프로그램이 켜져 있는지 확인하신 후, 하단 <strong>다시 연결 확인</strong>을 눌러 주세요.
    </p>
  </section>
</div>
`.trim();
}

/** @param {() => Promise<unknown>} onPrimaryCheck */
export function agentInstallDialogOptions(onPrimaryCheck) {
  return {
    title: "로컬 에이전트에 연결할 수 없습니다",
    bodyHtml: buildAgentInstallDialogBodyHtml(),
    primaryLabel: "다시 연결 확인",
    onPrimary: onPrimaryCheck,
    onShown: () => {
      void showAdSense("installDialog", "#itz-install-ad-slot");
    },
  };
}
