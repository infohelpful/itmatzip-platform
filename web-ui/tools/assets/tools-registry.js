/**
 * 웹툴 메뉴 정의 — 새 툴 추가 시 이 배열에 항목만 추가하면 대시보드에 자동 반영됩니다.
 *
 * @typedef {Object} ToolEntry
 * @property {string} id
 * @property {string} href 상대 경로 (예: silence-remover/)
 * @property {string} title
 * @property {string} subtitle
 * @property {string} description
 * @property {string} icon 단일 문자 또는 이모지
 * @property {string} accent CSS 색 (카드 강조)
 * @property {boolean} available false면 준비 중 표시
 * @property {string[]} [tags] 검색용 키워드
 * @property {string} [badge] 카드 우측 상단 뱃지 (예: AI, NEW)
 */

/** @type {ToolEntry[]} */
export const TOOLS = [
  {
    id: "silence-remover",
    href: "silence-remover/",
    title: "Silence Detector",
    subtitle: "무음 구간 분석 · EDL",
    description:
      "영상의 무음 구간을 자동 분석하고 편집 프로그램용 EDL을 생성합니다. 로컬 에이전트로 파일은 PC에서만 처리됩니다.",
    icon: "🔇",
    accent: "#3b82f6",
    available: true,
    badge: "AI",
    tags: ["무음", "silence", "edl", "premiere", "ffmpeg", "파형", "오디오"],
  },
];
