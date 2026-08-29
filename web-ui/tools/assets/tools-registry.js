/**
 * 웹툴 메뉴 정의 — 새 툴 추가 시 이 배열에 항목만 추가하면 대시보드와 sitemap.xml에 자동 반영됩니다.
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
  {
    id: "voice-changer",
    href: "voice-changer/",
    title: "Voice Changer",
    subtitle: "AI 목소리 변환 · Seed-VC",
    description:
      "소스 음성을 레퍼런스 음색으로 로컬에서 변환합니다. Seed-VC 모델은 최초 사용 시 다운로드됩니다.",
    icon: "🗣️",
    accent: "#14b8a6",
    available: true,
    badge: "AI",
    tags: ["보이스", "voice", "changer", "seed-vc", "변조", "음색", "변환", "ai"],
  },
  {
    id: "watermark-remover",
    href: "watermark-remover/",
    title: "Watermark Remover",
    subtitle: "고정 워터마크 제거 · ProPainter",
    description:
      "영상에서 워터마크 영역을 칠하면 ProPainter가 해당 부분만 지우고 일반 재생 가능한 영상으로 저장합니다.",
    icon: "🚫",
    accent: "#eab308",
    available: true,
    badge: "AI",
    tags: ["워터마크", "watermark", "로고", "제거", "propainter", "영상", "inpaint", "ai"],
  },
  {
    id: "thumbnail-grabber",
    href: "thumbnail-grabber/",
    title: "Thumbnail Grabber",
    subtitle: "유튜브 썸네일 저장",
    description:
      "유튜브 영상 주소만 붙여넣으면 공개 썸네일을 미리보고 원하는 화질로 저장합니다. AI·에이전트 없이 바로 동작합니다.",
    icon: "🖼️",
    accent: "#f43f5e",
    available: true,
    tags: ["유튜브", "youtube", "썸네일", "thumbnail", "다운로드", "커버", "shorts"],
  },
  {
    id: "ico-maker",
    href: "ico-maker/",
    title: "ICO Maker",
    subtitle: "PNG → 다중 해상도 ICO",
    description:
      "PNG를 올리면 16부터 256까지 Windows용 해상도를 한 .ico 파일로 묶어 저장합니다. AI·에이전트 없이 바로 동작합니다.",
    icon: "🧩",
    accent: "#38bdf8",
    available: true,
    tags: ["ico", "아이콘", "png", "favicon", "윈도우", "icon", "변환"],
  },
  {
    id: "online-clock",
    href: "online-clock/",
    title: "온라인 시계",
    subtitle: "알람 · 타이머 · 스톱워치 · 세계 시계",
    description:
      "현재 시각과 세계 시계, 여러 개의 알람, 카운트다운 타이머, 랩 스톱워치를 브라우저에서 바로 사용합니다. 설치 없이 동작하며 한국어·영어·일본어·중국어를 지원합니다.",
    icon: "🕐",
    accent: "#22d3ee",
    available: true,
    tags: [
      "시계",
      "clock",
      "알람",
      "alarm",
      "타이머",
      "timer",
      "스톱워치",
      "stopwatch",
      "세계시계",
      "온라인 시계",
    ],
  },
  {
    id: "json-formatter",
    href: "json-formatter/",
    title: "JSON Formatter",
    subtitle: "정렬 · 압축 · 복구",
    description:
      "붙여넣은 JSON을 바로 정렬하고 한 줄로 압축합니다. 오류가 있으면 고칩니다. 설치 없이 브라우저에서 씁니다.",
    icon: "{}",
    accent: "#10b981",
    available: true,
    badge: "NEW",
    tags: ["json", "포맷터", "formatter", "jsonpath", "정렬", "beautify", "압축", "뷰티파이", "api"],
  },
  {
    id: "unattend-maker",
    href: "unattend-maker/",
    title: "Unattend Maker",
    subtitle: "윈도우 자동설치 · XML",
    description:
      "Windows 설치 때 묻는 언어, 계정, Wi-Fi를 미리 정해 두는 파일을 만듭니다. 자주 쓰는 설정으로 채운 뒤 원하는 항목만 바꾸면 됩니다.",
    icon: "💿",
    accent: "#60a5fa",
    available: true,
    tags: ["윈도우", "windows", "설치", "autounattend", "xml", "무인설치", "응답파일", "iso"],
  },
];
