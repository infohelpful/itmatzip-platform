/**
 * 모션그래픽도구 공용 렌더 코어 v2 — 브라우저 미리보기와 Remotion 최종 렌더가 같은 파일을 쓴다(미리보기 = 결과물).
 *
 * 설계서(design.json) 한 장을 받아 프레임마다 화면을 조립한다.
 *  - FULL    : 원본을 가리는 불투명 배경(Aurora) + 장면 템플릿. 구간끼리 이어지면 배경은 유지하고 내용만 바뀐다.
 *  - OVERLAY : 원본 유지 + 줌(펀치인)·스포트라이트·링·클릭 파동·밑줄·블러. 글자·도형 카드 없음.
 *  - NONE    : 아무것도 그리지 않는다(로고 인트로 등).
 * 장면 템플릿과 효과는 여기 코드로 고정돼 있고, AI 는 「구간별 템플릿 선택 + 문구 + 자막 번호(타이밍)」만 정한다.
 *
 * 노드 트리 {t, s, a, c}: t 태그, s style(숫자는 px, UNITLESS 제외), a 속성, c 자식 배열 또는 문자열.
 * 의존성 없음. ⚠ SSOT — agent/engines/motion_graphic_core/src/mg-core.js 는 이 파일의 바이트 복사본(테스트가 검사).
 */

export const MG_CORE_VERSION = 2;
export const FONT = "'Pretendard','Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',sans-serif";
export const MONO = "'JetBrains Mono',Consolas,monospace";
export const LEAD_FRAMES = 3; // 등장은 자막 시작보다 3프레임 먼저
export const SAFE_BOTTOM = 0.8; // 하단 20% 는 자막 전용 — 어떤 모션그래픽·배경 장식도 들어갈 수 없다

/* ── 스타일 프리셋 (스킬 레퍼런스 컬러) ─────────────────────────────────── */

export const STYLES = {
  CINEMATIC_BLUE: {
    label: "시네마틱 테크 블루",
    desc: "윈도우·PC·IT 리뷰. 딥 네이비 + 블루 글로우 (컴테크 592화 기준 작품)",
    C: { bg: "#001E3C", deep: "#0F3A73", primary: "#0078D4", sky: "#00A4EF", accent: "#50E6FF", text: "#EAF3FF", text2: "#A9C3E3", ok: "#3DDC97", bad: "#FF5A6A", warn: "#FFB020" },
  },
  MINT_WAVE: {
    label: "민트 웨이브",
    desc: "웹 도구·오디오·파형. 딥 틸 네이비 + 민트 (601화 무음 자동 제거 기준)",
    C: { bg: "#04121a", deep: "#0b3a3a", primary: "#1f9e82", sky: "#39dfbb", accent: "#7cffe0", text: "#e8fff8", text2: "#a6cfc6", ok: "#3ddc97", bad: "#ff5a6a", warn: "#ffb020" },
  },
  SECURITY_RED: {
    label: "보안 레드 다크",
    desc: "보안·경고·해킹·바이러스. 블랙 + 레드 경고 글로우",
    C: { bg: "#0b0608", deep: "#3a0d14", primary: "#d7263d", sky: "#ff4d5e", accent: "#ff8a8a", text: "#fff1f2", text2: "#d9a7ad", ok: "#3ddc97", bad: "#ff3b4f", warn: "#ffb020" },
  },
  SILVER_CLEAN: {
    label: "실버 클린",
    desc: "맥·애플·미니멀 제품 리뷰. 그래파이트 + 실버 화이트",
    C: { bg: "#0e1013", deep: "#2a2f37", primary: "#8e9aaf", sky: "#c9d3e3", accent: "#ffffff", text: "#f5f7fa", text2: "#a8b0bd", ok: "#3ddc97", bad: "#ff5a6a", warn: "#ffb020" },
  },
  ANDROID_GREEN: {
    label: "안드로이드 그린",
    desc: "안드로이드·모바일·구글. 딥 포레스트 + 라임 그린",
    C: { bg: "#06140b", deep: "#123d24", primary: "#1fa85a", sky: "#3ddc84", accent: "#b6ff6b", text: "#effff4", text2: "#a9cdb6", ok: "#3ddc84", bad: "#ff5a6a", warn: "#ffb020" },
  },
};
export const DEFAULT_STYLE = "CINEMATIC_BLUE";
export const BG_KINDS = ["aurora", "grid", "particles", "waves"];
const COLOR_KEYS = ["bg", "deep", "primary", "sky", "accent", "text", "text2", "ok", "bad", "warn"];

/**
 * 설계서의 style → { name, C(색 10개), bg(배경 종류), energy(움직임 세기 0.6~1.4) }.
 * 문자열은 예전 설계서의 고정 프리셋 id, 객체는 AI 가 영상에 맞게 만든 디자인(서버가 대비를 검증해 저장).
 */
export function resolveStyle(raw) {
  const base = STYLES[DEFAULT_STYLE];
  if (raw && typeof raw === "object") {
    const C = { ...base.C };
    for (const k of COLOR_KEYS) if (/^#[0-9a-fA-F]{6}$/.test(raw.colors?.[k] || "")) C[k] = raw.colors[k];
    return { name: String(raw.name || "새 디자인"), C, bg: BG_KINDS.includes(raw.bg) ? raw.bg : "aurora", energy: clamp(Number(raw.energy) || 1, 0.6, 1.4) };
  }
  const st = STYLES[raw] || base;
  return { name: st.label, C: st.C, bg: "aurora", energy: 1 };
}

/* ── 수학 유틸 (Remotion interpolate/spring 과 같은 의미) ───────────────── */

export function clamp(v, lo = 0, hi = 1) {
  return Math.min(hi, Math.max(lo, v));
}

export const Easing = {
  linear: (t) => t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};

export function interpolate(x, input, output, { easing = Easing.linear } = {}) {
  let i = 1;
  while (i < input.length - 1 && x > input[i]) i += 1;
  const x0 = input[i - 1];
  const x1 = input[i];
  const t = clamp(x1 === x0 ? 1 : (x - x0) / (x1 - x0));
  return output[i - 1] + (output[i] - output[i - 1]) * easing(t);
}

/** 감쇠 스프링 0 → 1 (스킬 기준 damping 18 · stiffness 120). 해석해라 프레임마다 결정적이다. */
export function spring(frame, { fps = 30, damping = 18, stiffness = 120, mass = 1 } = {}) {
  const t = frame / fps;
  if (t <= 0) return 0;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
}

export function rand(seed) {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/* ── 노드 헬퍼 ─────────────────────────────────────────────────────────── */

const h = (t, s, c, a) => {
  const node = { t, s: s || {} };
  if (a) node.a = a;
  if (c !== undefined && c !== null && c !== "") node.c = Array.isArray(c) ? c.filter(Boolean) : c;
  return node;
};
const fit = (text, max) => {
  const s = String(text ?? "").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const abs = (x, y, w, hh, extra = {}) => ({ position: "absolute", left: x, top: y, width: w, height: hh, ...extra });

/** 나타남 정도 0~1 (스프링) 과 투명도. local < 0 이면 아직 안 나타남. */
function appear(local, fps) {
  if (local < 0) return { p: 0, o: 0 };
  return { p: spring(local, { fps }), o: interpolate(local, [0, 8], [0, 1]) };
}

/* ── 공통 요소 ──────────────────────────────────────────────────────────── */

/** 모든 FULL 장면 공통 배경: 딥 네이비 + 움직이는 컬러 블롭 + 원근 그리드 + 보케 + 비네트. */
function aurora(c, g) {
  const { C, u, W, H, t } = c;
  const bx1 = 30 + Math.sin(t / 90) * 12;
  const by1 = 30 + Math.cos(t / 110) * 10;
  const bx2 = 72 + Math.cos(t / 100) * 10;
  const by2 = 68 + Math.sin(t / 80) * 8;
  const kind = c.bgKind || "aurora";
  const nBokeh = kind === "particles" ? 42 : kind === "grid" ? 8 : 14;
  const gridOp = kind === "grid" ? 0.95 : kind === "particles" ? 0 : kind === "waves" ? 0.2 : 0.55;
  const bokeh = [];
  for (let i = 0; i < nBokeh; i++) {
    const r = (10 + rand(i + 3) * 26) * u;
    const x = rand(i + 11) * W;
    const y = (rand(i + 29) * H * 0.8 + t * (0.15 + rand(i) * 0.25) * u) % (H * 0.86);
    bokeh.push(h("div", abs(x, y, r, r, { borderRadius: "50%", background: C.accent, opacity: 0.05 + rand(i + 7) * 0.08, filter: `blur(${2 * u}px)` })));
  }
  return h("div", { position: "absolute", inset: 0, overflow: "hidden", background: C.bg, opacity: g }, [
    h("div", { position: "absolute", inset: 0, background: `radial-gradient(circle at ${bx1}% ${by1}%, ${C.deep} 0%, transparent 55%), radial-gradient(circle at ${bx2}% ${by2}%, ${C.primary}${Math.round(0x55 + (c.pulse || 0) * 0x66).toString(16).padStart(2, "0")} 0%, transparent ${50 + (c.pulse || 0) * 12}%)` }),
    h("div", {
      position: "absolute", left: -W * 0.25, right: -W * 0.25, top: H * 0.52, height: H * 0.9,
      backgroundImage: `linear-gradient(${C.accent}22 1px, transparent 1px), linear-gradient(90deg, ${C.accent}22 1px, transparent 1px)`,
      backgroundSize: `${80 * u}px ${80 * u}px`, backgroundPosition: `0 ${(t * 0.6 * u) % (80 * u)}px`,
      transform: "perspective(900px) rotateX(62deg)", transformOrigin: "50% 0%", opacity: gridOp ? gridOp + (c.pulse || 0) * 0.3 : 0,
    }),
    kind === "waves" ? h("div", {
      position: "absolute", left: -W * 0.3, top: -H * 0.3, width: W * 1.6, height: H * 1.6, opacity: 0.55,
      background: `conic-gradient(from ${t * 0.25 * (c.energy || 1)}deg at 50% 55%, transparent 0deg, ${C.primary}44 40deg, transparent 90deg, ${C.accent}33 170deg, transparent 220deg, ${C.sky}44 290deg, transparent 360deg)`,
      filter: `blur(${40 * u}px)`,
    }) : null,
    ...bokeh,
    h("div", { position: "absolute", inset: 0, background: "radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,0.65) 100%)" }),
    // 하단 20% 자막 영역: 그리드·보케·빛 번짐 없이 단색 (위에서 부드럽게 이어짐)
    h("div", abs(0, H * (SAFE_BOTTOM - 0.08), W, H * (1 - SAFE_BOTTOM + 0.08), { background: `linear-gradient(180deg, transparent 0%, ${C.bg} 40%, ${C.bg} 100%)` })),
  ]);
}

/** 상단 헤더 한 줄 (y 110~200) — rise. */
function header(c, text, local) {
  if (!text) return null;
  const { C, u, W, fps } = c;
  const a = appear(local, fps);
  return h("div", abs(0, 110 * u, W, 90 * u, {
    display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, fontWeight: 800,
    fontSize: 52 * u, color: C.text, letterSpacing: -1 * u, opacity: a.o * c.out,
    transform: `translateY(${(1 - a.p) * 30 * u}px)`, textShadow: `0 0 ${24 * u}px ${C.primary}88`,
  }), fit(text, 28));
}

/** 핵심 문구 — 흰→accent 그라데이션 + 글로우. mode slam: 크게 떨어지며 박힘 + 충격파. */
function kinetic(c, text, local, { y, size = 70, mode = "rise", max = 0 } = {}) {
  if (!text || local < 0) return null;
  const { C, u, W, fps } = c;
  const a = appear(local, fps);
  const scale = mode === "slam" ? interpolate(local, [0, 7, 12], [1.9, 0.94, 1], { easing: Easing.outCubic }) : 1;
  const dy = mode === "slam" ? 0 : (1 - a.p) * 40 * u;
  const nodes = [h("div", abs(0, y * u - size * u * 0.75, W, size * u * 1.5, {
    display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, fontWeight: 900,
    fontSize: size * u, letterSpacing: -2 * u, opacity: a.o * c.out, transform: `translateY(${dy}px) scale(${scale})`,
    backgroundImage: `linear-gradient(180deg, #ffffff 20%, ${C.accent} 100%)`, WebkitBackgroundClip: "text", backgroundClip: "text",
    color: "transparent", filter: `drop-shadow(0 0 ${18 * u}px ${C.sky}aa)`,
  }), fit(text, max || Math.max(14, Math.round(1500 / size))))];
  if (mode === "slam") nodes.push(shockwave(c, W / 2, y * u, local - 5));
  return h("div", { position: "absolute", inset: 0 }, nodes);
}

function shockwave(c, x, y, local) {
  if (local < 0 || local > 24) return null;
  const { C, u } = c;
  const r = interpolate(local, [0, 24], [40, 520], { easing: Easing.outCubic }) * u;
  return h("div", abs(x - r, y - r, r * 2, r * 2, {
    borderRadius: "50%", border: `${3 * u}px solid ${C.accent}`, opacity: interpolate(local, [0, 24], [0.8, 0]) * c.out,
    boxShadow: `0 0 ${30 * u}px ${C.sky}`,
  }));
}

/** 글래스 카드. */
function glass(c, x, y, w, hh, local, children, { glow = false, dy = 36 } = {}) {
  if (local < 0) return null;
  const { C, u, fps } = c;
  const a = appear(local, fps);
  return h("div", abs(x, y, w, hh, {
    borderRadius: 26 * u, background: `linear-gradient(160deg, rgba(255,255,255,0.13), rgba(255,255,255,0.04))`,
    border: `${1.5 * u}px solid ${glow ? C.accent : "rgba(255,255,255,0.22)"}`,
    boxShadow: glow ? `0 0 ${46 * u}px ${C.sky}77, inset 0 1px 0 rgba(255,255,255,0.25)` : `0 ${18 * u}px ${48 * u}px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.2)`,
    backdropFilter: `blur(${14 * u}px)`, opacity: a.o * c.out, transform: `translateY(${(1 - a.p) * dy * u}px) scale(${0.94 + a.p * 0.06})`,
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 * u, padding: 24 * u,
    boxSizing: "border-box", fontFamily: FONT, color: C.text, textAlign: "center",
  }), children);
}

/** 아이콘 타일 (글래스 + 글로우 + 천천히 떠 있음). icon 은 이모지/기호 한 글자. */
/** 값이 에셋 파일(웹에서 받은 로고·사진 등, 프로젝트 assets 기준 경로)인가 */
export function isAsset(v) {
  return typeof v === "string" && /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(v.trim());
}

export function isVideoAsset(v) {
  return typeof v === "string" && /\.mp4$/i.test(v.trim());
}

/** 에셋 이미지 노드. 렌더러가 {asset} 을 미리보기 URL / Remotion staticFile 로 바꾼다. */
function pic(name, style, startFrame = 0) {
  const src = { asset: String(name).trim() };
  if (isVideoAsset(name)) return h("video", { display: "block", objectFit: "contain", ...style }, undefined, { src, startFrame });
  return h("img", { display: "block", objectFit: "contain", ...style }, undefined, { src });
}

/**
 * 비율을 지키는 이미지 칸: 원본 비율 그대로 contain(잘림·왜곡 없음) + 남는 여백은 같은 이미지를 흐리게 깐 배경으로 채운다.
 * 부모는 position:absolute/relative 여야 한다.
 */
function framedPic(name, local, dur, startFrame = 0) {
  if (isVideoAsset(name)) return [pic(name, { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", objectFit: "contain" }, startFrame)];
  const k = interpolate(local, [0, Math.max(30, dur)], [1.12, 1.22], { easing: Easing.inOutCubic });
  return [
    pic(name, { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", objectFit: "cover", filter: "blur(28px) brightness(0.55)", transform: `scale(${k})` }),
    pic(name, { position: "absolute", left: 0, top: 0, width: "100%", height: "100%", objectFit: "contain" }),
  ];
}

/** Ken Burns — 장면 안에서 천천히 확대(사진·스크린샷이 정지해 보이지 않게). */
function kenBurns(local, dur, from = 1.0, to = 1.08) {
  return interpolate(local, [0, Math.max(30, dur)], [from, to], { easing: Easing.inOutCubic });
}

function iconTile(c, icon, size, seed = 0) {
  const { C, u, t } = c;
  const float = Math.sin((t + seed * 23) / 22) * 6 * u;
  if (isAsset(icon)) {
    return h("div", {
      width: size * u, height: size * u, borderRadius: 24 * u, display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(255,255,255,0.92)", boxShadow: `0 0 ${26 * u}px ${C.sky}55`, padding: size * 0.16 * u, boxSizing: "border-box",
      transform: `translateY(${float}px)`, flexShrink: 0,
    }, [pic(icon, { width: "100%", height: "100%" })]);
  }
  return h("div", {
    width: size * u, height: size * u, borderRadius: 24 * u, display: "flex", alignItems: "center", justifyContent: "center",
    background: `linear-gradient(145deg, ${C.deep}, ${C.bg})`, border: `${1.5 * u}px solid ${C.accent}88`,
    boxShadow: `0 0 ${26 * u}px ${C.sky}55, inset 0 1px 0 rgba(255,255,255,0.25)`, fontSize: size * 0.5 * u,
    transform: `translateY(${float}px) rotateY(${Math.sin((t + seed * 40) / 40) * 10}deg)`, flexShrink: 0,
  }, fit(icon || "◆", 2));
}

const title = (c, text, size = 34, max = 18) => h("div", { fontSize: size * c.u, fontWeight: 800, lineHeight: 1.2, color: c.C.text }, fit(text, max));
const sub = (c, text, size = 22, max = 34) => (text ? h("div", { fontSize: size * c.u, fontWeight: 500, color: c.C.text2, lineHeight: 1.35 }, fit(text, max)) : null);

function chip(c, text, x, y, local, color) {
  if (!text || local < 0) return null;
  const { C, u, fps } = c;
  const a = appear(local, fps);
  return h("div", abs(x, y, 0, 0, { overflow: "visible", display: "flex", justifyContent: "center" }), [h("div", {
    position: "absolute", transform: `translate(-50%, 0) scale(${0.8 + a.p * 0.2})`, opacity: a.o * c.out, whiteSpace: "nowrap",
    padding: `${10 * u}px ${22 * u}px`, borderRadius: 999, fontFamily: FONT, fontWeight: 700, fontSize: 30 * u,
    color: C.bg, background: color || C.accent, boxShadow: `0 0 ${24 * u}px ${(color || C.accent)}88`,
  }, fit(text, 20))]);
}

function mark(c, ok, x, y, local) {
  if (local < 0) return null;
  const { C, u, fps } = c;
  const a = appear(local, fps);
  const s = 64 * u;
  return h("div", abs(x - s / 2, y - s / 2, s, s, {
    borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 38 * u, fontWeight: 900,
    color: "#fff", background: ok ? C.ok : C.bad, boxShadow: `0 0 ${24 * u}px ${ok ? C.ok : C.bad}`, opacity: a.o * c.out,
    transform: `scale(${a.p})`, fontFamily: FONT,
  }), ok ? "✓" : "✕");
}

/* ── FULL 장면 템플릿 ───────────────────────────────────────────────────
 * slots: 비트 순서대로 나타나는 요소 설명. AI 는 구간 비트(자막 번호)를 이 순서에 맞춘다.
 * 레이아웃 (1920×1080): 헤더 y110~200 · 콘텐츠 x160~1760, y220~860 · 중심 x960 좌우 대칭 · y>880 자막 영역 금지.
 */

const T = {};

T.TITLE = {
  name: "타이틀", desc: "오프닝·챕터 핵심 타이틀. 작은 eyebrow + 큰 제목 slam + 부제",
  vars: { eyebrow: 20, title: 18, sub: 32 }, slots: ["eyebrow + 제목 slam", "부제"],
  render(c) {
    const { v, u, W, C } = c;
    const rays = c.sl(0) >= 0 ? h("div", abs(W / 2 - 700 * u, 120 * u, 1400 * u, 800 * u, {
      background: `conic-gradient(from 0deg at 50% 50%, transparent 0deg, ${C.sky}22 10deg, transparent 22deg, transparent 40deg, ${C.accent}1c 52deg, transparent 64deg, transparent 90deg, ${C.sky}22 100deg, transparent 112deg, transparent 180deg, ${C.accent}1c 190deg, transparent 204deg, transparent 270deg, ${C.sky}22 280deg, transparent 292deg)`,
      borderRadius: "50%", filter: `blur(${8 * u}px)`, transform: `rotate(${c.t * 0.2}deg)`, opacity: 0.8 * c.out,
    })) : null;
    return [rays,
      kinetic(c, v.eyebrow, c.sl(0), { y: 380, size: 30 }),
      kinetic(c, v.title, c.sl(0) - 6, { y: 500, size: 92, mode: "slam" }),
      kinetic(c, v.sub, c.sl(1), { y: 640, size: 36 })];
  },
};

T.STATEMENT = {
  name: "핵심 문장", desc: "설명만 하는 정지 구간의 핵심 한 문장 + 보조 칩",
  vars: { header: 26, text: 22, chip: 18, icon: 2 }, slots: ["헤더", "아이콘 + 핵심 문장", "보조 칩"],
  render(c) {
    const { v, u, W } = c;
    const ic = c.sl(1) >= 0 && v.icon ? h("div", abs(W / 2 - 70 * u, 280 * u, 140 * u, 140 * u, { opacity: appear(c.sl(1), c.fps).o * c.out, display: "flex", justifyContent: "center" }), [iconTile(c, v.icon, 140)]) : null;
    return [header(c, v.header, c.sl(0)), ic, kinetic(c, v.text, c.sl(1) + 4, { y: v.icon ? 560 : 500, size: 74, mode: "rise" }), chip(c, v.chip, W / 2, 680 * u, c.sl(2))];
  },
};

T.COMPARE = {
  name: "좌우 비교", desc: "두 대상 비교 (x600 / x1320 같은 크기). 결론에서 한쪽 ✓ 다른 쪽 ✕",
  vars: { header: 26, left: 14, left_sub: 26, left_icon: 2, right: 14, right_sub: 26, right_icon: 2, verdict: 18, winner: 5 },
  slots: ["헤더", "왼쪽 카드", "오른쪽 카드", "결론 (✓/✕ + 칩)"],
  render(c) {
    const { v, u, W, C } = c;
    const cw = 520 * u;
    const ch = 420 * u;
    const y = 300 * u;
    const win = String(v.winner || "right").toLowerCase();
    const card = (i, x, label, s, icon, glow) => glass(c, x - cw / 2, y, cw, ch, c.sl(i), [iconTile(c, icon, 120, i), title(c, label, 44, 14), sub(c, s, 26, 26)], { glow });
    const vsA = appear(c.sl(2) - 4, c.fps);
    return [header(c, v.header, c.sl(0)),
      card(1, 600 * u, v.left, v.left_sub, v.left_icon, c.sl(3) >= 0 && win === "left"),
      card(2, 1320 * u, v.right, v.right_sub, v.right_icon, c.sl(3) >= 0 && win !== "left"),
      c.sl(2) >= 4 ? h("div", abs(W / 2 - 80 * u, y + ch / 2 - 60 * u, 160 * u, 120 * u, { display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, fontWeight: 900, fontSize: 64 * u, color: "#fff", textShadow: `0 0 ${28 * u}px ${C.sky}`, opacity: vsA.o * c.out, transform: `scale(${1.6 - vsA.p * 0.6})` }), "VS") : null,
      win !== "none" ? mark(c, win === "left", 600 * u, y - 10 * u, c.sl(3)) : null,
      win !== "none" ? mark(c, win !== "left", 1320 * u, y - 10 * u, c.sl(3)) : null,
      chip(c, v.verdict, W / 2, 770 * u, c.sl(3) + 6)];
  },
};

T.STEPS = {
  name: "단계 흐름", desc: "순서·절차 2~4단계. 번호 원 + 아이콘 타일이 가로로 하나씩 등장, 진행선이 이어짐",
  vars: { header: 26, s1: 12, s2: 12, s3: 12, s4: 12, i1: 2, i2: 2, i3: 2, i4: 2, d1: 20, d2: 20, d3: 20, d4: 20 },
  slots: ["헤더", "1단계", "2단계", "3단계", "4단계"],
  render(c) {
    const { v, u, W, C } = c;
    const steps = [1, 2, 3, 4].filter((i) => v[`s${i}`]);
    const n = Math.max(1, steps.length);
    const cw = (n === 4 ? 340 : 400) * u;
    const gap = 40 * u;
    const total = n * cw + (n - 1) * gap;
    const x0 = (W - total) / 2;
    const y = 320 * u;
    const out = [header(c, v.header, c.sl(0))];
    const last = steps.reduce((acc, _, k) => (c.sl(k + 1) >= 0 ? k : acc), -1);
    if (last > 0) {
      const p = interpolate(c.sl(last + 1), [0, 14], [0, 1]);
      const span = (last - 1 + p) * (cw + gap);
      out.push(h("div", abs(x0 + cw / 2, y + 190 * u, Math.max(0, span), 4 * u, { background: `linear-gradient(90deg, ${C.primary}, ${C.accent})`, boxShadow: `0 0 ${14 * u}px ${C.sky}`, opacity: c.out })));
    }
    steps.forEach((i, k) => {
      const x = x0 + k * (cw + gap);
      out.push(glass(c, x, y, cw, 400 * u, c.sl(k + 1), [
        h("div", { width: 52 * u, height: 52 * u, borderRadius: "50%", background: C.primary, color: "#fff", fontWeight: 900, fontSize: 28 * u, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 0 ${18 * u}px ${C.sky}` }, String(k + 1)),
        iconTile(c, v[`i${i}`], 110, k), title(c, v[`s${i}`], 34, 12), sub(c, v[`d${i}`], 22, 22),
      ], { glow: k === last }));
    });
    return out;
  },
};

T.NUMBER = {
  name: "숫자 강조", desc: "수치·시간·비율 한 방. 링 게이지가 차오르며 숫자가 from→to 로 바뀌고 slam",
  vars: { header: 26, from: 10, to: 10, unit: 6, caption: 26, ratio: 4 }, slots: ["헤더 + 링 게이지", "숫자 from→to slam", "캡션"],
  render(c) {
    const { v, u, W, C, fps } = c;
    const cx = W / 2;
    const cy = 500 * u;
    const R = 220 * u;
    const g = appear(c.sl(0), fps);
    const ratio = clamp(Number(v.ratio) || 1, 0.05, 1);
    const fill = interpolate(c.sl(1) < 0 ? c.sl(0) : c.sl(1), [0, 24], [c.sl(1) < 0 ? 0 : 1, ratio], { easing: Easing.inOutCubic });
    const circ = 2 * Math.PI * 200;
    const ring = c.sl(0) >= 0 ? h("svg", abs(cx - R, cy - R, R * 2, R * 2, { opacity: g.o * c.out, overflow: "visible" }), [
      h("circle", { fill: "none", stroke: `${C.accent}22`, strokeWidth: 18 }, undefined, { cx: 220, cy: 220, r: 200, fill: "none", stroke: `${C.accent}33`, "stroke-width": 18 }),
      h("circle", { filter: `drop-shadow(0 0 12px ${C.sky})` }, undefined, { cx: 220, cy: 220, r: 200, fill: "none", stroke: C.accent, "stroke-width": 18, "stroke-linecap": "round", "stroke-dasharray": `${circ}`, "stroke-dashoffset": `${circ * (1 - fill * g.p)}`, transform: "rotate(-90 220 220)" }),
    ], { viewBox: "0 0 440 440" }) : null;
    const showTo = c.sl(1) >= 0;
    const num = showTo ? v.to : v.from;
    const numEl = c.sl(0) >= 6 ? h("div", abs(0, cy - 80 * u, W, 160 * u, {
      display: "flex", alignItems: "baseline", justifyContent: "center", gap: 10 * u, fontFamily: MONO, fontWeight: 700,
      color: "#fff", fontSize: 110 * u, opacity: c.out, textShadow: `0 0 ${30 * u}px ${C.sky}`,
      transform: `scale(${showTo ? interpolate(c.sl(1), [0, 6, 11], [1.7, 0.95, 1]) : 1})`,
    }), [h("span", {}, fit(num, 10)), v.unit ? h("span", { fontSize: 46 * u, color: C.accent, fontFamily: FONT }, fit(v.unit, 6)) : null]) : null;
    return [header(c, v.header, c.sl(0)), ring, numEl, showTo ? shockwave(c, cx, cy, c.sl(1) - 4) : null, kinetic(c, v.caption, c.sl(2), { y: 800, size: 38 })];
  },
};

T.HUB = {
  name: "허브 연결", desc: "중심 개념 하나에 3~6개가 연결 (반지름 300 원 위에 차례로 팝, 점선 연결)",
  vars: { center: 12, center_icon: 2, n1: 12, n2: 12, n3: 12, n4: 12, n5: 12, n6: 12 }, slots: ["중심", "연결 1", "연결 2", "연결 3", "연결 4", "연결 5", "연결 6"],
  render(c) {
    const { v, u, C } = c;
    const cx = 960 * u;
    const cy = 490 * u;
    const R = 300 * u;
    const nodes = [1, 2, 3, 4, 5, 6].filter((i) => v[`n${i}`]);
    const out = [];
    const ca = appear(c.sl(0), c.fps);
    nodes.forEach((i, k) => {
      const ang = -Math.PI / 2 + (k * 2 * Math.PI) / nodes.length + c.t / 900;
      const x = cx + Math.cos(ang) * R;
      const y = cy + Math.sin(ang) * R;
      const a = appear(c.sl(k + 1), c.fps);
      if (a.o <= 0) return;
      const len = R - 110 * u;
      out.push(h("div", abs(cx, cy - 1 * u, len * a.p, 3 * u, { transformOrigin: "0 50%", transform: `rotate(${ang}rad) translateX(${90 * u}px)`, backgroundImage: `linear-gradient(90deg, ${C.accent} 50%, transparent 50%)`, backgroundSize: `${16 * u}px ${3 * u}px`, opacity: 0.8 * c.out })));
      out.push(h("div", abs(x - 120 * u, y - 46 * u, 240 * u, 92 * u, {
        display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 20 * u, fontFamily: FONT, fontWeight: 800, fontSize: 30 * u,
        color: C.text, background: "rgba(255,255,255,0.1)", border: `${1.5 * u}px solid ${C.accent}99`, boxShadow: `0 0 ${20 * u}px ${C.sky}44`,
        opacity: a.o * c.out, transform: `scale(${a.p})`,
      }), fit(v[`n${i}`], 12)));
    });
    out.unshift(c.sl(0) >= 0 ? h("div", abs(cx - 100 * u, cy - 100 * u, 200 * u, 200 * u, {
      borderRadius: "50%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6 * u,
      background: `radial-gradient(circle, ${C.primary}, ${C.deep})`, border: `${2 * u}px solid ${C.accent}`, fontFamily: FONT,
      boxShadow: `0 0 ${(40 + Math.sin(c.t / 12) * 14) * u}px ${C.sky}`, opacity: ca.o * c.out, transform: `scale(${ca.p})`,
    }), [v.center_icon ? h("div", { fontSize: 54 * u }, fit(v.center_icon, 2)) : null, h("div", { fontSize: 30 * u, fontWeight: 900, color: "#fff" }, fit(v.center, 10))]) : null);
    return out;
  },
};

T.CHECKLIST = {
  name: "체크리스트", desc: "확인 항목·장단점 2~4개. 항목이 하나씩 rise 하고 ✓(ok) 또는 ✕(no) 마크",
  vars: { header: 26, c1: 24, c2: 24, c3: 24, c4: 24, m1: 2, m2: 2, m3: 2, m4: 2 }, slots: ["헤더", "항목 1", "항목 2", "항목 3", "항목 4"],
  render(c) {
    const { v, u, W } = c;
    const items = [1, 2, 3, 4].filter((i) => v[`c${i}`]);
    const rowH = 110 * u;
    const gap = 26 * u;
    const top = 220 * u + (640 * u - (items.length * rowH + (items.length - 1) * gap)) / 2;
    const out = [header(c, v.header, c.sl(0))];
    items.forEach((i, k) => {
      const y = top + k * (rowH + gap);
      const ok = String(v[`m${i}`] || "ok").toLowerCase() !== "no";
      out.push(glass(c, W / 2 - 520 * u, y, 1040 * u, rowH, c.sl(k + 1), [h("div", { fontSize: 36 * u, fontWeight: 700, color: c.C.text, textAlign: "left", width: "100%", paddingLeft: 100 * u, boxSizing: "border-box" }, fit(v[`c${i}`], 24))], { dy: 24 }));
      out.push(mark(c, ok, W / 2 - 520 * u + 64 * u, y + rowH / 2, c.sl(k + 1) + 6));
    });
    return out;
  },
};

T.FLOW = {
  name: "데이터 흐름", desc: "A → B → C 처리 흐름. 노드가 차례로 뜨고 사이로 패킷이 흐름 (업로드·변환·전송 개념)",
  vars: { header: 26, a: 12, b: 12, c: 12, ia: 2, ib: 2, ic: 2, la: 16, lb: 16, lc: 16 }, slots: ["헤더", "A", "B", "C"],
  render(c) {
    const { v, u, C } = c;
    const keys = ["a", "b", "c"].filter((k) => v[k]);
    const n = Math.max(1, keys.length);
    const xs = n === 3 ? [500, 960, 1420] : n === 2 ? [640, 1280] : [960];
    const y = 520 * u;
    const out = [header(c, v.header, c.sl(0))];
    for (let k = 0; k < n - 1; k++) {
      const local = c.sl(k + 2);
      if (local < 0) continue;
      const x1 = xs[k] * u + 160 * u;
      const x2 = xs[k + 1] * u - 160 * u;
      out.push(h("div", abs(x1, y - 2 * u, (x2 - x1) * clamp(local / 12), 4 * u, { background: `${C.accent}66`, opacity: c.out })));
      for (let p = 0; p < 4; p++) {
        const ph = ((c.t * 2.4 + p * 25) % 100) / 100;
        out.push(h("div", abs(x1 + (x2 - x1) * ph - 8 * u, y - 8 * u, 16 * u, 16 * u, { borderRadius: "50%", background: C.accent, boxShadow: `0 0 ${14 * u}px ${C.sky}`, opacity: clamp(local / 12) * c.out })));
      }
    }
    keys.forEach((k, i) => {
      out.push(glass(c, xs[i] * u - 160 * u, y - 170 * u, 320 * u, 340 * u, c.sl(i + 1), [iconTile(c, v[`i${k}`], 120, i), title(c, v[k], 34, 12), sub(c, v[`l${k}`], 22, 16)], { glow: i === keys.length - 1 && c.sl(i + 1) >= 0 }));
    });
    return out;
  },
};

T.CHAPTER = {
  name: "챕터 카드", desc: "새 챕터 시작 50f 워프 카드 (큰 번호 + 제목). FULL 로 시작하는 챕터 첫 구간에만",
  vars: { num: 3, title: 20 }, slots: ["번호 + 제목"],
  render(c) {
    const { v, u, W, H, C } = c;
    const l = c.sl(0);
    if (l < 0) return [];
    const warp = [];
    for (let i = 0; i < 26; i++) {
      const ang = rand(i) * Math.PI * 2;
      const len = interpolate(l, [0, 20], [0, (200 + rand(i + 4) * 500) * u]);
      warp.push(h("div", abs(W / 2, H / 2, len, 2 * u, { transformOrigin: "0 50%", transform: `rotate(${ang}rad) translateX(${interpolate(l, [0, 30], [0, 400]) * u}px)`, background: `linear-gradient(90deg, transparent, ${C.accent})`, opacity: interpolate(l, [0, 10, 30], [0, 0.9, 0]) * c.out })));
    }
    const a = appear(l - 6, c.fps);
    return [...warp,
      h("div", abs(0, 300 * u, W, 260 * u, { display: "flex", justifyContent: "center", alignItems: "center", fontFamily: MONO, fontWeight: 700, fontSize: 220 * u, color: "transparent", WebkitTextStroke: `${3 * u}px ${C.accent}`, opacity: a.o * c.out, transform: `perspective(800px) rotateY(${(1 - a.p) * 50}deg)` }), fit(v.num, 3)),
      kinetic(c, v.title, l - 10, { y: 640, size: 64 })];
  },
};

T.ENDING = {
  name: "엔딩", desc: "요약 2~3개 + 구독·좋아요·알림 CTA",
  vars: { title: 20, p1: 22, p2: 22, p3: 22 }, slots: ["제목", "요약 1", "요약 2", "요약 3", "구독·좋아요·알림"],
  render(c) {
    const { v, u, W, C } = c;
    const pts = [1, 2, 3].filter((i) => v[`p${i}`]);
    const out = [kinetic(c, v.title, c.sl(0), { y: 190, size: 56 })];
    pts.forEach((i, k) => out.push(glass(c, W / 2 - 480 * u, 280 * u + k * 112 * u, 960 * u, 92 * u, c.sl(k + 1), [h("div", { fontSize: 32 * u, fontWeight: 700 }, fit(v[`p${i}`], 22))], { dy: 20 })));
    const cta = c.sl(pts.length + 1);
    if (cta >= 0) {
      ["구독", "좋아요", "알림"].forEach((label, k) => {
        const a = appear(cta - k * 5, c.fps);
        out.push(h("div", abs(W / 2 - 390 * u + k * 270 * u, 660 * u, 240 * u, 96 * u, {
          display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 18 * u, fontFamily: FONT, fontWeight: 900, fontSize: 36 * u,
          color: k === 0 ? "#fff" : C.bg, background: k === 0 ? C.bad : C.accent, boxShadow: `0 ${8 * u}px 0 ${k === 0 ? "#8a1020" : C.primary}, 0 0 ${22 * u}px ${k === 0 ? C.bad : C.sky}88`,
          opacity: a.o * c.out, transform: `translateY(${(1 - a.p) * 30 * u}px)`,
        }), label));
      });
    }
    return out;
  },
};

T.PHOTO_POINTS = {
  name: "사진 + 요점", desc: "왼쪽에 실제 사진·스크린샷(천천히 확대), 오른쪽에 요점 2~3줄이 하나씩 (문제 제기·특징 나열)",
  vars: { img: 80, p1: 16, p2: 16, p3: 16, d1: 24, d2: 24, d3: 24, i1: 80, i2: 80, i3: 80 }, slots: ["사진", "요점 1", "요점 2", "요점 3"],
  render(c) {
    const { v, u, C } = c;
    const out = [];
    if (v.img && c.sl(0) >= 0) {
      const a = appear(c.sl(0), c.fps);
      out.push(h("div", abs(160 * u, 230 * u, 760 * u, 600 * u, {
        borderRadius: 26 * u, overflow: "hidden", border: `${1.5 * u}px solid rgba(255,255,255,0.22)`, boxShadow: `0 ${24 * u}px ${60 * u}px rgba(0,0,0,0.5)`,
        opacity: a.o * c.out, transform: `translateX(${(1 - a.p) * -40 * u}px)`,
      }), framedPic(v.img, c.sl(0), c.dur, c.t - c.sl(0))));
    }
    [1, 2, 3].filter((i) => v[`p${i}`]).forEach((i, k) => {
      out.push(glass(c, 980 * u, (250 + k * 196) * u, 780 * u, 172 * u, c.sl(k + 1), [
        h("div", { display: "flex", alignItems: "center", gap: 26 * u, width: "100%", textAlign: "left" }, [
          iconTile(c, v[`i${i}`] || "•", 104, k),
          h("div", { display: "flex", flexDirection: "column", gap: 6 * u }, [title(c, v[`p${i}`], 40, 16), sub(c, v[`d${i}`], 24, 24)]),
        ]),
      ], { dy: 26 }));
    });
    return out;
  },
};

T.IMAGE_CARDS = {
  name: "이미지 카드", desc: "실제 스크린샷·제품 사진 카드 2~3장이 나란히, 지금 말하는 카드가 커지며 강조 (기능 소개·예고)",
  vars: { header: 26, img1: 80, img2: 80, img3: 80, t1: 16, t2: 16, t3: 16, s1: 22, s2: 22, s3: 22 }, slots: ["헤더 + 카드 1", "카드 2", "카드 3"],
  render(c) {
    const { v, u, W, C } = c;
    const ids = [1, 2, 3].filter((i) => v[`img${i}`] || v[`t${i}`]);
    const n = Math.max(1, ids.length);
    const cw = (n === 3 ? 500 : 680) * u;
    const gap = 40 * u;
    const x0 = (W - (n * cw + (n - 1) * gap)) / 2;
    const active = ids.reduce((acc, _, k) => (c.sl(k) >= 0 ? k : acc), -1);
    const out = [header(c, v.header, c.sl(0))];
    ids.forEach((i, k) => {
      const local = c.sl(k);
      if (local < 0) return;
      const a = appear(local, c.fps);
      const on = k === active;
      out.push(h("div", abs(x0 + k * (cw + gap), 250 * u, cw, 560 * u, {
        borderRadius: 24 * u, overflow: "hidden", background: "rgba(255,255,255,0.06)", fontFamily: FONT,
        border: `${2 * u}px solid ${on ? C.accent : "rgba(255,255,255,0.18)"}`, boxShadow: on ? `0 0 ${44 * u}px ${C.sky}88` : `0 ${18 * u}px ${44 * u}px rgba(0,0,0,0.45)`,
        opacity: a.o * c.out * (on ? 1 : 0.6), transform: `translateY(${(1 - a.p) * 40 * u}px) scale(${on ? 1.03 : 0.97})`,
        display: "flex", flexDirection: "column",
      }), [
        h("div", { flex: 1, overflow: "hidden", background: "#0b1220", position: "relative" }, v[`img${i}`] ? framedPic(v[`img${i}`], local, 240, c.t - local) : []),
        h("div", { padding: `${16 * u}px ${20 * u}px`, display: "flex", flexDirection: "column", gap: 4 * u }, [title(c, v[`t${i}`], 32, 16), sub(c, v[`s${i}`], 22, 24)]),
      ]));
    });
    return out;
  },
};

T.LOGO_SLAM = {
  name: "로고 + 핵심 문장", desc: "관련 회사·제품 로고 1~4개가 차례로 뜨고 핵심 문장 slam (발표·출시·개편 한 방)",
  vars: { header: 26, logo1: 80, logo2: 80, logo3: 80, logo4: 80, text: 20 }, slots: ["헤더 + 로고", "로고 2~4", "핵심 문장 slam"],
  render(c) {
    const { v, u, W, C } = c;
    const logos = [1, 2, 3, 4].map((i) => v[`logo${i}`]).filter(Boolean);
    const n = Math.max(1, logos.length);
    const size = (n >= 3 ? 250 : 320) * u;
    const gap = 80 * u;
    const x0 = (W - (n * size + (n - 1) * gap)) / 2;
    const out = [header(c, v.header, c.sl(0))];
    logos.forEach((lg, k) => {
      const local = k === 0 ? c.sl(0) : c.sl(1) - (k - 1) * 5;
      if (local < 0) return;
      const a = appear(local, c.fps);
      const float = Math.sin((c.t + k * 30) / 24) * 8 * u;
      out.push(h("div", abs(x0 + k * (size + gap), 250 * u, size, size, {
        display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 36 * u, padding: size * 0.14, boxSizing: "border-box",
        background: "rgba(255,255,255,0.95)", opacity: a.o * c.out, transform: `translateY(${float + (1 - a.p) * 40 * u}px) scale(${0.6 + a.p * 0.4}) rotateY(${(1 - a.p) * 50}deg)`,
        boxShadow: `0 ${24 * u}px ${60 * u}px rgba(0,0,0,0.5), 0 0 ${50 * u}px ${C.sky}77`,
      }), [isAsset(lg) ? pic(lg, { width: "100%", height: "100%" }) : /^[^\w가-힣]{1,2}$/u.test(String(lg).trim())
      ? h("div", { fontSize: 120 * u }, fit(lg, 2))
      : h("div", { fontFamily: FONT, fontWeight: 900, fontSize: Math.max(34, 64 - String(lg).length * 2.2) * u, color: "#0b1220", textAlign: "center", lineHeight: 1.15 }, fit(lg, 14))]));
    });
    out.push(kinetic(c, v.text, c.sl(2), { y: 700, size: 80, mode: "slam" }));
    return out;
  },
};

T.APP_WINDOW = {
  name: "앱 창 재현", desc: "설정·레지스트리·검색창 같은 앱 창을 화면에 그리고, 말하는 항목 줄을 차례로 강조 (설정 경로·옵션 설명)",
  vars: { title: 30, r1: 34, r2: 34, r3: 34, r4: 34, r5: 34, r6: 34, hl1: 2, hl2: 2, hl3: 2, note: 24 }, slots: ["창 열림", "강조 1", "강조 2", "강조 3 + 메모"],
  render(c) {
    const { v, u, W, C } = c;
    const rows = [1, 2, 3, 4, 5, 6].map((i) => v[`r${i}`]).filter(Boolean);
    const hl = [v.hl1, v.hl2, v.hl3].map((x) => Number(x) - 1);
    const a = appear(c.sl(0), c.fps);
    if (c.sl(0) < 0) return [];
    let on = -1;
    hl.forEach((r, k) => { if (r >= 0 && c.sl(k + 1) >= 0) on = r; });
    const winW = 1180 * u;
    const winH = 560 * u;
    const x = (W - winW) / 2;
    const rowEls = rows.map((r, i) => h("div", {
      fontFamily: MONO, fontSize: 24 * u, color: "#1d2b3c", padding: `${8 * u}px ${16 * u}px`, borderRadius: 8 * u, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      background: i === on ? "rgba(255,176,32,0.38)" : "transparent", boxShadow: i === on ? `0 0 0 ${2 * u}px ${C.warn}` : "none",
      opacity: interpolate(c.sl(0), [i * 2, i * 2 + 8], [0, 1]),
    }, fit(r, 40)));
    return [h("div", abs(x, 230 * u, winW, winH, {
      borderRadius: 16 * u, overflow: "hidden", background: "#f3f6fa", boxShadow: `0 ${30 * u}px ${80 * u}px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.2)`,
      opacity: a.o * c.out, transform: `perspective(1400px) rotateX(${(1 - a.p) * 12}deg) translateY(${(1 - a.p) * 40 * u}px)`,
    }), [
      h("div", { height: 54 * u, background: "#e6ebf2", display: "flex", alignItems: "center", padding: `0 ${20 * u}px`, gap: 10 * u, fontFamily: FONT, fontWeight: 700, fontSize: 22 * u, color: "#1d2b3c" }, [
        h("div", { display: "flex", gap: 8 * u }, ["#ff5f57", "#febc2e", "#28c840"].map((col) => h("div", { width: 14 * u, height: 14 * u, borderRadius: "50%", background: col }))),
        h("span", { marginLeft: 12 * u }, fit(v.title, 30)),
      ]),
      h("div", { padding: `${18 * u}px ${24 * u}px`, display: "flex", flexDirection: "column", gap: 6 * u }, rowEls),
    ]), chip(c, v.note, W / 2, 800 * u, c.sl(3) + 6, C.warn)];
  },
};

T.SHOWCASE = {
  name: "대표 이미지", desc: "공식 스크린샷·제품 사진 한 장을 크게 (3D 기울기 + 천천히 확대) + 아래 캡션. 실제 화면을 보여줄 때",
  vars: { header: 26, img: 80, caption: 26, chip: 18 }, slots: ["헤더 + 이미지", "캡션", "칩"],
  render(c) {
    const { v, u, W, C } = c;
    if (c.sl(0) < 0) return [];
    const a = appear(c.sl(0), c.fps);
    const iw = 1180 * u;
    const ih = 560 * u;
    const tilt = interpolate(c.sl(0), [0, 30], [14, 4], { easing: Easing.outCubic });
    return [header(c, v.header, c.sl(0)),
      v.img ? h("div", abs((W - iw) / 2, 220 * u, iw, ih, {
        borderRadius: 20 * u, overflow: "hidden", border: `${1.5 * u}px solid ${C.accent}66`, boxShadow: `0 ${30 * u}px ${80 * u}px rgba(0,0,0,0.6), 0 0 ${50 * u}px ${C.sky}44`,
        opacity: a.o * c.out, transform: `perspective(1600px) rotateX(${tilt}deg) scale(${0.92 + a.p * 0.08})`, background: "#0b1220",
      }), framedPic(v.img, c.sl(0), c.dur, c.t - c.sl(0))) : null,
      kinetic(c, v.caption, c.sl(1), { y: 830, size: 40 }),
      chip(c, v.chip, W / 2, 140 * u, c.sl(2))];
  },
};

export const TEMPLATES = T;
export const TEMPLATE_META = Object.entries(T).map(([id, d]) => ({ id, name: d.name, desc: d.desc, vars: Object.keys(d.vars), max: d.vars, slots: d.slots }));

/* ── OVERLAY 효과 ─────────────────────────────────────────────────────── */

export const OVERLAY_FX = {
  zoom: "펀치인 1.3~2.4x (18f 진입, 다음 줌까지 유지, 구간 끝 14f 복귀). 검은 여백 안 생기게 클램프",
  spotlight: "대상 밖 35% 디밍 (블러 없음)",
  ring: "대상 둘레 링 + 글로우",
  click: "클릭 지점 원형 파동 12f",
  underline: "문구 아래 선 스윕 10f",
  blur: "개인정보(메일 주소 등) 가림",
};

/** 비트 대상 위치 — 추적 경로(track: [[프레임, x, y, w, h], ...])가 있으면 그 프레임 위치를 보간한다 (원본이 움직여도 따라감). */
export function boxAt(b, f) {
  const tr = b.track;
  if (!Array.isArray(tr) || !tr.length) return b.target;
  if (f <= tr[0][0]) return tr[0].slice(1);
  for (let i = 0; i < tr.length - 1; i++) {
    const a = tr[i];
    const c = tr[i + 1];
    if (f < c[0]) {
      const k = (f - a[0]) / Math.max(1, c[0] - a[0]);
      return [1, 2, 3, 4].map((j) => a[j] + (c[j] - a[j]) * k);
    }
  }
  return tr[tr.length - 1].slice(1);
}

const CHAIN_GAP = 90; // 프레임(30fps 기준 3초): 이만큼 이내에 가까운 대상이 이어지면 줌을 풀지 않고 이동
const ZOOM_IN = 18;
const ZOOM_OUT = 14;

function centerOf(b, f) {
  const [x, y, w, hh] = boxAt(b, f);
  return { cx: x + w / 2, cy: y + hh / 2 };
}
function lerpState(a, b, k) {
  return { s: a.s + (b.s - a.s) * k, cx: a.cx + (b.cx - a.cx) * k, cy: a.cy + (b.cy - a.cy) * k };
}
function zoomHold(b, f) {
  return { s: clamp(Number(b.zoom) || 1.6, 1, 2.6), ...centerOf(b, f) };
}

/** 이어진 OVERLAY 구간 묶음(run) 안의 줌 비트 목록과 묶음 끝 프레임 */
export function zoomBeatsOfRun(segs, i) {
  let a = i;
  while (a > 0 && segs[a - 1].type === "OVERLAY") a--;
  let b = i;
  while (b < segs.length - 1 && segs[b + 1].type === "OVERLAY") b++;
  const list = [];
  for (let k = a; k <= b; k++) for (const bt of segs[k].beats || []) if (bt.fx === "zoom" && Array.isArray(bt.target)) list.push(bt);
  list.sort((x, y) => x.frame - y.frame);
  return { list, runEnd: segs[b].from + segs[b].durationInFrames };
}

/** 줌 비트의 유지 종료 프레임 = 그 문장(자막)이 끝나는 시점. 마지막 비트는 묶음 끝 전에 반드시 풀린다. */
function holdEnd(list, i, runEnd) {
  const b = list[i];
  const nxt = list[i + 1];
  let e = Number.isFinite(b.until) ? b.until : nxt ? nxt.frame : b.frame + 120;
  e = Math.max(b.frame + 20, e);
  if (!nxt) e = Math.min(e, runEnd - ZOOM_OUT - 1);
  return Math.max(b.frame + 1, e);
}

/** i 번 비트 다음 비트가 「이어지는」 줌인가: 간격이 짧고 대상이 화면 폭의 45% 안에 있음 */
function isChained(list, i, W, runEnd) {
  const a = list[i];
  const b = list[i + 1];
  if (!b) return false;
  const ae = holdEnd(list, i, runEnd);
  if (b.frame - ae > CHAIN_GAP) return false;
  const ca = centerOf(a, ae);
  const cb = centerOf(b, b.frame);
  return Math.hypot(ca.cx - cb.cx, ca.cy - cb.cy) <= 0.45 * W;
}

function zoomStateAt(list, f, W, H, runEnd) {
  const ident = { s: 1, cx: W / 2, cy: H * 0.4 };
  let i = -1;
  for (let k = 0; k < list.length; k++) if (list[k].frame <= f) i = k;
  if (i < 0) return ident;
  const b = list[i];
  let from = ident;
  if (i > 0) {
    const pe = holdEnd(list, i - 1, runEnd);
    if (isChained(list, i - 1, W, runEnd)) from = zoomHold(list[i - 1], Math.min(b.frame, pe)); // 확대한 채로 이동
    else from = lerpState(zoomHold(list[i - 1], pe), ident, Easing.inOutCubic(clamp((b.frame - pe) / ZOOM_OUT)));
  }
  let st = lerpState(from, zoomHold(b, f), Easing.inOutCubic(clamp((f - b.frame) / ZOOM_IN)));
  const ue = holdEnd(list, i, runEnd);
  if (f > ue && !isChained(list, i, W, runEnd)) {
    // 문장이 끝났고 이어지는 확대도 없다 → 원래 비율(scale 1.0)로 복귀
    const atEnd = lerpState(from, zoomHold(b, ue), Easing.inOutCubic(clamp((ue - b.frame) / ZOOM_IN)));
    st = lerpState(atEnd, ident, Easing.inOutCubic(clamp((f - ue) / ZOOM_OUT)));
  }
  return st;
}

/** 줌 변환. 유효 화면은 상단 80%(자막 영역 제외)라서 대상 중심을 그 영역의 가운데(0.4H)로 가져온다. */
export function overlayState(list, f, W, H, runEnd) {
  const st = zoomStateAt(list, f, W, H, runEnd);
  const ox = clamp(st.cx * st.s - W / 2, 0, W * st.s - W);
  const oy = clamp(st.cy * st.s - H * SAFE_BOTTOM * 0.5, 0, H * st.s - H);
  return { s: st.s, ox, oy };
}

/** 문장마다 상단 가장자리에 진행선이 달린다 — 원본을 가리지 않으면서 목소리가 나는 동안 화면에 늘 움직임이 있게 한다. */
function cueHud(design, f, C, u, W) {
  const cues = design?.cues || [];
  const s = lastAtOrBefore(cues, f);
  if (s === null || f - s > 400) return null;
  const nx = cues.find((c) => c > f);
  const e = Math.min(nx ?? s + 150, s + 240);
  const p = clamp((f - s) / Math.max(20, e - s));
  const tick = Math.exp(-(f - s) / 6);
  return h("div", { position: "absolute", inset: 0, pointerEvents: "none" }, [
    h("div", abs(0, 0, W * p, 5 * u, { background: `linear-gradient(90deg, ${C.primary}, ${C.accent})`, boxShadow: `0 0 ${12 * u}px ${C.accent}`, opacity: 0.8 })),
    h("div", abs(W * p - 80 * u, 0, 80 * u, 5 * u, { background: "#ffffff", opacity: 0.45 + 0.55 * tick, filter: `blur(${2 * u}px)` })),
  ]);
}

function overlayFx(seg, f, C, u) {
  const out = [];
  const beats = (seg.beats || []).slice().sort((a, b) => a.frame - b.frame);
  const end = seg.from + seg.durationInFrames;
  beats.forEach((b, i) => {
    if (!b.fx || !Array.isArray(b.target) || b.fx === "zoom") return;
    const local = f - b.frame;
    const until = Number.isFinite(b.until)
      ? Math.min(end, Math.max(b.frame + 20, b.until) + 6)
      : Math.min(end, i + 1 < beats.length ? Math.max(beats[i + 1].frame, b.frame + 30) : end, b.frame + 150);
    if (local < 0 || f >= until) return;
    const fade = Math.min(interpolate(local, [0, 8], [0, 1]), interpolate(f, [until - 8, until], [1, 0]));
    const [x, y, w, hh] = boxAt(b, f);
    const pad = 8 * u;
    if (b.fx === "spotlight") {
      const dim = `rgba(0,0,0,${0.35 * fade})`;
      out.push(h("div", abs(x - pad, y - pad, w + pad * 2, hh + pad * 2, { borderRadius: 12 * u, boxShadow: `0 0 0 9999px ${dim}` })));
    } else if (b.fx === "ring") {
      out.push(h("div", abs(x - pad, y - pad, w + pad * 2, hh + pad * 2, { borderRadius: 12 * u, border: `${3 * u}px solid ${C.accent}`, boxShadow: `0 0 ${16 * u}px ${C.accent}, inset 0 0 ${10 * u}px ${C.accent}66`, opacity: fade, transform: `scale(${1.06 - 0.06 * Easing.outCubic(clamp(local / 10))})` })));
    } else if (b.fx === "click") {
      for (const d of [0, 6]) {
        const l = local - d;
        if (l < 0 || l > 18) continue;
        const r = interpolate(l, [0, 18], [8, 70]) * u;
        out.push(h("div", abs(x + w / 2 - r, y + hh / 2 - r, r * 2, r * 2, { borderRadius: "50%", border: `${3 * u}px solid ${C.accent}`, opacity: interpolate(l, [0, 18], [0.9, 0]) })));
      }
    } else if (b.fx === "underline") {
      out.push(h("div", abs(x, y + hh + 4 * u, w * Easing.outCubic(clamp(local / 10)), 5 * u, { borderRadius: 3 * u, background: C.accent, boxShadow: `0 0 ${10 * u}px ${C.accent}`, opacity: fade })));
    } else if (b.fx === "blur") {
      out.push(h("div", abs(x - pad, y - pad, w + pad * 2, hh + pad * 2, { borderRadius: 8 * u, backdropFilter: `blur(${14 * u}px)`, background: "rgba(40,44,52,0.35)" })));
    }
  });
  return out;
}

/* ── 프레임 조립 ─────────────────────────────────────────────────────── */

/** 정렬된 배열에서 x 이하인 마지막 값 (없으면 null). */
function lastAtOrBefore(arr, x) {
  let lo = 0;
  let hi = arr.length - 1;
  let r = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] <= x) {
      r = arr[m];
      lo = m + 1;
    } else hi = m - 1;
  }
  return r;
}

export function findSegment(design, frame) {
  const segs = design?.segments || [];
  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segs[mid];
    if (frame < s.from) hi = mid - 1;
    else if (frame >= s.from + s.durationInFrames) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * frame 시점 화면.
 * @returns {{ seg: object|null, zoom: {s,ox,oy}, fx: object[], full: object|null, freeze: number|null }}
 *   zoom/fx 는 원본 영상과 같은 좌표계(원본 위에 함께 확대), full 은 그 위 화면 좌표.
 *   freeze: OVERLAY→FULL 전환 16f 동안 원본을 이 프레임에 멈춘다(렌더 전용, 줌 상태 유지).
 */
export function composeFrame(design, frame, { w, h: H, fps } = {}) {
  const W = w || design?.width || 1920;
  const HH = H || design?.height || 1080;
  const FPSV = fps || design?.fps?.value || 30;
  const u = Math.min(W, HH) / 1080;
  const style = resolveStyle(design?.style);
  const C = style.C;
  const idx = findSegment(design, frame);
  const none = { seg: null, zoom: { s: 1, ox: 0, oy: 0 }, fx: [], full: null, freeze: null };
  if (idx < 0) return none;
  const segs = design.segments;
  const seg = segs[idx];
  const prev = segs[idx - 1];
  const next = segs[idx + 1];
  const f = frame - seg.from;
  const end = seg.durationInFrames;
  if (seg.type === "OVERLAY") {
    const { list, runEnd } = zoomBeatsOfRun(segs, idx);
    return { seg, zoom: overlayState(list, frame, W, HH, runEnd), fx: overlayFx(seg, frame, C, u), full: cueHud(design, frame, C, u, W), freeze: null };
  }
  if (seg.type !== "FULL") return { ...none, seg };
  // 전면 MG 는 첫 프레임부터 마지막 프레임까지 배경이 완전 불투명 — 원본이 뒤로 비치지 않는다.
  // 앞뒤가 FULL 이 아니면 불투명 레이어 위의 플래시(8~10f)로 끊어 넘어간다.
  // 장면: 한 FULL 구간 안에서 자막 타이밍에 맞춰 여러 장면이 이어진다 (배경은 유지, 내용만 교체)
  const scenes = Array.isArray(seg.scenes) && seg.scenes.length ? seg.scenes : [{ template: seg.template, vars: seg.vars, beats: seg.beats }];
  const starts = scenes.map((sc, i) => (i === 0 ? seg.from : Math.min(...(sc.beats || []).map((b) => b.frame), Infinity)));
  let si = 0;
  for (let i = 0; i < scenes.length; i++) if (Number.isFinite(starts[i]) && frame >= starts[i]) si = i;
  const scene = scenes[si];
  const sFrom = starts[si];
  const sEnd = si + 1 < scenes.length && Number.isFinite(starts[si + 1]) ? starts[si + 1] : seg.from + end;
  const tpl = TEMPLATES[scene.template] || TEMPLATES.STATEMENT;
  const sf = frame - sFrom;
  const sDur = sEnd - sFrom;
  // 내용: 다음 장면(또는 다음 FULL 구간)이 오기 8f 전에 먼저 퇴장 (겹침 금지)
  const hasNext = si + 1 < scenes.length || next?.type === "FULL";
  const out = hasNext ? interpolate(sf, [sDur - 8, sDur], [1, 0]) : 1;
  const beatF = (scene.beats || []).map((b) => b.frame - sFrom).sort((a, b) => a - b);
  const nSlots = tpl.slots.length;
  const sl = (i) => {
    let at = beatF[i];
    if (at === undefined) {
      // 비트가 모자라면 마지막 비트 뒤에 오는 자막 시작 시점마다 나머지 요소를 하나씩 띄운다 (자막이 없으면 1.2초 간격)
      const last = beatF.length ? beatF[beatF.length - 1] : 0;
      const after = (design.cues || []).filter((c) => c - sFrom > last + 15 && c < sEnd).map((c) => c - sFrom);
      const m = i - beatF.length;
      at = i >= nSlots ? Infinity : after[m] !== undefined ? after[m] : last + Math.round(FPSV * 1.2) * (m + 1);
    }
    return sf - at;
  };
  const ctx = { C, u, W, H: HH, fps: FPSV, t: frame, f: sf, dur: sDur, v: scene.vars || {}, sl, out, scene: si, bgKind: style.bg, energy: style.energy };
  // 자막이 시작될 때마다(cues) 화면이 반응한다: 카메라 푸시, 배경 맥동, 빛줄기, 키워드 티커. 장면 안에서 계속 천천히 움직인다.
  const cueF = lastAtOrBefore(design.cues || [], frame);
  const k = cueF === null || cueF < seg.from - 30 ? 99 : frame - cueF;
  const pulse = Math.exp(-Math.max(0, k) / 9);
  ctx.pulse = pulse;
  const drift = 0.035 * ctx.energy * (sf / Math.max(1, sDur));
  const wrap = h("div", {
    position: "absolute", inset: 0, transformOrigin: "50% 50%",
    transform: `perspective(1800px) rotateY(${Math.sin(frame / 70) * 0.9}deg) rotateX(${Math.cos(frame / 90) * 0.5}deg) scale(${1 + drift + 0.016 * ctx.energy * pulse})`,
  }, tpl.render(ctx).filter(Boolean));
  const layers = [];
  if (k >= 0 && k < 18) {
    const bx = interpolate(k, [0, 18], [-0.25 * W, 1.15 * W], { easing: Easing.outCubic });
    layers.push(h("div", abs(bx, -0.15 * HH, 190 * u, HH * 1.3, {
      background: `linear-gradient(90deg, transparent, ${C.accent}33, ${C.sky}55, transparent)`, transform: "rotate(16deg)", opacity: 0.8 * out,
    })));
  }
  layers.push(wrap);
  const keys = scene.keys || [];
  let ki = -1;
  keys.forEach((kk, i) => { if (frame >= kk.frame) ki = i; });
  if (ki >= 0) {
    const kk = keys[ki];
    const a = appear(frame - kk.frame, FPSV);
    const swap = interpolate(frame - kk.frame, [0, 6], [0, 1]);
    layers.push(h("div", abs(0, 44 * u, W, 60 * u, { display: "flex", justifyContent: "center", alignItems: "center", opacity: a.o * out * swap }), [
      h("div", {
        display: "flex", alignItems: "center", gap: 12 * u, padding: `${8 * u}px ${24 * u}px`, borderRadius: 999, fontFamily: FONT, fontWeight: 800, fontSize: 28 * u,
        color: C.text, background: "rgba(255,255,255,0.1)", border: `${1.5 * u}px solid ${C.accent}88`, transform: `translateY(${(1 - a.p) * -16 * u}px)`,
      }, [h("span", { width: 12 * u, height: 12 * u, borderRadius: "50%", background: C.accent, boxShadow: `0 0 ${12 * u}px ${C.accent}`, opacity: 0.6 + 0.4 * Math.sin(frame / 5) }), h("span", {}, fit(kk.text, 18))]),
    ]));
  }
  // 플래시 컷: 앞이 FULL 이 아니면 시작에서 번쩍이며 나타나고, 뒤가 FULL 이 아니면 끝에서 하얗게 덮은 뒤 컷
  if (prev?.type !== "FULL" && f < 10) layers.push(h("div", { position: "absolute", inset: 0, background: `radial-gradient(circle, #ffffff, ${C.accent})`, opacity: interpolate(f, [0, 10], [0.95, 0]) }));
  if (next?.type !== "FULL" && f > end - 8) layers.push(h("div", { position: "absolute", inset: 0, background: "#ffffff", opacity: interpolate(f, [end - 8, end - 1], [0, 1]) }));
  const stage = h("div", abs(0, 0, W, HH * SAFE_BOTTOM, { overflow: "hidden" }), layers); // 상단 80% 로 잘림 = 자막 영역 보호
  const full = h("div", { position: "absolute", inset: 0, opacity: 1, overflow: "hidden", background: C.bg }, [aurora(ctx, 1), stage]);
  const freeze = null; // 원본을 뒤에 깔지 않는다
  return { seg, zoom: { s: 1, ox: 0, oy: 0 }, fx: [], full, freeze };
}

/** React 와 같은 단위 없는 CSS 속성 (숫자에 px 를 붙이지 않음). */
export const UNITLESS = new Set([
  "opacity", "zIndex", "fontWeight", "lineHeight", "flex", "flexGrow", "flexShrink", "order", "zoom",
  "strokeDasharray", "strokeDashoffset", "strokeOpacity", "strokeWidth", "strokeMiterlimit", "fillOpacity",
]);
