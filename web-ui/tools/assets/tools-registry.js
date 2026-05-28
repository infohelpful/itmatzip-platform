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
  {
    id: "auto-subtitle",
    href: "auto-subtitle/",
    title: "Auto Subtitle",
    subtitle: "AI 자막 추출 · SRT",
    description:
      "로컬 영상·오디오에서 Faster-Whisper로 자막을 생성합니다. AI 모델은 추출 시 PC에 다운로드됩니다.",
    icon: "💬",
    accent: "#8b5cf6",
    available: true,
    badge: "AI",
    tags: ["자막", "subtitle", "whisper", "srt", "전사", "ffmpeg", "영상"],
  },
  {
    id: "vocal-remover",
    href: "vocal-remover/",
    title: "Vocal Remover",
    subtitle: "보컬 분리 · MR/보컬 추출",
    description:
      "로컬 오디오 파일에서 보컬과 반주를 분리하고, MR 또는 보컬만 원하는 포맷으로 다운로드합니다.",
    icon: "🎙️",
    accent: "#ec4899",
    available: true,
    badge: "AI",
    tags: ["보컬", "vocal", "mr", "분리", "audio", "demucs", "ai"],
  },
  {
    id: "create-music",
    href: "create-music/",
    title: "Create Music",
    subtitle: "AI 음악 생성 · ACE-Step 1.5",
    description:
      "텍스트와 가사로 AI 음악을 생성합니다. LoRA 학습으로 나만의 스타일을 커스터마이징할 수 있습니다.",
    icon: "🎵",
    accent: "#f59e0b",
    available: true,
    badge: "AI",
    tags: ["음악", "music", "ai", "생성", "작곡", "ace-step", "lora", "노래"],
  },
];
