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
    subtitle: "무음 구간 분석 · XML",
    description:
      "영상의 무음 구간을 자동 분석하고 편집 프로그램용 FCP7 XML을 생성합니다. 로컬 에이전트로 파일은 PC에서만 처리됩니다.",
    icon: "🔇",
    accent: "#3b82f6",
    available: true,
    badge: "AI",
    tags: ["무음", "silence", "xml", "premiere", "ffmpeg", "파형", "오디오", "davinci"],
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
    id: "image-enhancer",
    href: "image-enhancer/",
    title: "Image Enhancer",
    subtitle: "AI 얼굴·화질 복원 · CodeFormer",
    description:
      "저화질 사진의 얼굴과 디테일을 로컬 PC에서 복원합니다. CodeFormer AI 모델은 최초 사용 시 다운로드됩니다.",
    icon: "✨",
    accent: "#06b6d4",
    available: true,
    badge: "AI",
    tags: ["이미지", "화질", "복원", "얼굴", "codeformer", "ai", "사진", "photo"],
  },
  {
    id: "background-remover",
    href: "background-remover/",
    title: "Background Remover",
    subtitle: "AI 배경제거 · BiRefNet",
    description:
      "로컬 이미지에서 배경을 제거하고 투명 PNG와 마스크를 만듭니다. BiRefNet 모델은 최초 사용 시 다운로드됩니다.",
    icon: "✂️",
    accent: "#14b8a6",
    available: true,
    badge: "AI",
    tags: ["배경", "배경제거", "background", "remove", "birefnet", "투명", "png", "마스크", "ai"],
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
  {
    id: "magic-eraser",
    href: "magic-eraser/",
    title: "MagicEraser",
    subtitle: "객체 지우기 · LaMa Erase",
    description:
      "브러시로 지울 영역을 칠하면 AI가 객체를 제거하고 주변 배경으로 자연스럽게 채웁니다.",
    icon: "✨",
    accent: "#a855f7",
    available: true,
    badge: "AI",
    tags: ["지우기", "erase", "lama", "inpaint", "객체", "magic eraser", "iopaint"],
  },
];
