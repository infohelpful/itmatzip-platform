// node --test web-ui/tools/motion-graphic/mg-core.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OVERLAY_FX, STYLES, TEMPLATES, TEMPLATE_META, composeFrame, findSegment, interpolate, resolveStyle, spring } from "./mg-core.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.resolve(HERE, "../../../agent/engines/motion_graphic_core");

const design = (segments) => ({ version: 2, style: "MINT_WAVE", fps: { num: 30000, den: 1001, value: 29.97003 }, width: 1920, height: 1080, durationInFrames: 900, segments });

test("브라우저 mg-core.js 와 렌더 엔진 복사본이 바이트 단위로 같다 (미리보기 = 결과물)", () => {
  assert.ok(fs.readFileSync(path.join(HERE, "mg-core.js")).equals(fs.readFileSync(path.join(CORE, "src", "mg-core.js"))));
});

test("catalog.json 이 스타일·템플릿·효과 목록과 같다 (Python 설계 검증용)", () => {
  const cat = JSON.parse(fs.readFileSync(path.join(CORE, "catalog.json"), "utf8"));
  assert.deepEqual(cat.templates, TEMPLATE_META);
  assert.deepEqual(cat.overlay_fx, OVERLAY_FX);
  assert.deepEqual(Object.keys(cat.styles), Object.keys(STYLES));
});

test("spring·interpolate", () => {
  assert.equal(spring(0), 0);
  assert.ok(Math.abs(spring(120) - 1) < 0.01);
  assert.equal(interpolate(15, [0, 10], [0, 1]), 1);
});

test("모든 템플릿이 NaN 없이 그려진다", () => {
  const vars = { header: "헤더", title: "제목", text: "문장", eyebrow: "e", sub: "s", left: "L", right: "R", from: "2h", to: "1h", unit: "h", caption: "c",
    center: "C", n1: "a", n2: "b", n3: "c", c1: "x", c2: "y", a: "A", b: "B", c: "C", num: "01", p1: "p", s1: "1", s2: "2", icon: "⏱" };
  for (const id of Object.keys(TEMPLATES)) {
    const d = design([{ id: "X", type: "FULL", from: 0, durationInFrames: 300, template: id, vars, beats: [{ frame: 0 }, { frame: 20 }, { frame: 40 }] }]);
    for (const f of [0, 10, 30, 60, 120, 299]) {
      const j = JSON.stringify(composeFrame(d, f));
      assert.ok(!j.includes("NaN") && !j.includes("undefined"), `${id} f${f}`);
    }
  }
});

test("FULL 은 모든 프레임에서 배경이 완전 불투명 — 구간 시작·끝·전환 어디서도 원본이 비치지 않는다", () => {
  const d = design([
    { id: "A", type: "OVERLAY", from: 0, durationInFrames: 100, beats: [] },
    { id: "B", type: "FULL", from: 100, durationInFrames: 100, template: "STATEMENT", vars: { text: "x" }, beats: [{ frame: 100 }] },
    { id: "C", type: "FULL", from: 200, durationInFrames: 100, template: "STATEMENT", vars: { text: "y" }, beats: [{ frame: 200 }] },
    { id: "D", type: "NONE", from: 300, durationInFrames: 50, beats: [] },
    { id: "E", type: "FULL", from: 350, durationInFrames: 60, template: "TITLE", vars: { title: "z" }, beats: [{ frame: 350 }] },
  ]);
  d.cues = [98, 120, 150, 200, 250];
  for (let f = 100; f < 300; f++) {
    const s = composeFrame(d, f);
    assert.equal(s.full.s.opacity, 1, `f${f}`);
    assert.equal(s.full.s.background !== undefined, true);
    assert.equal(s.freeze, null, `원본을 멈춰 두지 않는다 f${f}`);
  }
  for (const f of [350, 351, 380, 409]) assert.equal(composeFrame(d, f).full.s.opacity, 1, `E f${f}`);
  // 전환은 불투명 레이어 위의 플래시: 시작 직후 · 끝 직전에 덮는 판이 있다
  const first = JSON.stringify(composeFrame(d, 100).full);
  const last = JSON.stringify(composeFrame(d, 199).full); // B(FULL) → C(FULL) 경계
  assert.ok(first.includes("radial-gradient(circle, #ffffff"), "OVERLAY→FULL 시작 플래시");
  assert.ok(!JSON.stringify(composeFrame(d, 200).full).includes("radial-gradient(circle, #ffffff"), "FULL→FULL 은 플래시 없이 이어짐");
  assert.ok(!last.includes('"background":"#ffffff"'), "FULL→FULL 끝은 덮지 않음");
  assert.ok(JSON.stringify(composeFrame(d, 408).full).includes('"background":"#ffffff"'), "FULL→OVERLAY 끝은 하얗게 덮고 컷");
});

test("자막 큐마다 화면이 반응한다: 큐 직후 카메라가 밀리고 빛줄기가 지나가며, 큐가 없으면 반응하지 않는다", () => {
  const seg = { id: "A", type: "FULL", from: 0, durationInFrames: 300, template: "STATEMENT", vars: { text: "x" }, beats: [{ frame: 0 }] };
  seg.scenes = [{ template: "STATEMENT", vars: { text: "x" }, beats: [{ frame: 0 }], keys: [{ sub: 3, frame: 60, text: "핵심 키워드" }] }];
  const d = design([seg]);
  d.cues = [60];
  const scaleOf = (f) => Number(/scale\(([\d.]+)\)/.exec(JSON.stringify(composeFrame(d, f).full).match(/perspective\(1800px\)[^"]*/)[0])[1]);
  assert.ok(scaleOf(61) > scaleOf(120) - 0.0001 || scaleOf(61) !== scaleOf(59), "큐 직후 푸시");
  assert.ok(JSON.stringify(composeFrame(d, 65).full).includes("rotate(16deg)"), "빛줄기");
  assert.ok(!JSON.stringify(composeFrame(d, 150).full).includes("rotate(16deg)"), "큐가 지나면 빛줄기 없음");
  assert.ok(JSON.stringify(composeFrame(d, 70).full).includes("핵심 키워드"), "키워드 티커");
  assert.ok(!JSON.stringify(composeFrame(d, 30).full).includes("핵심 키워드"), "키워드는 그 자막부터");
});

test("OVERLAY 줌은 대상으로 펀치인하고 구간 끝에 1.0 으로 돌아오며, 화면 밖 여백이 생기지 않게 클램프", () => {
  const d = design([{ id: "C", type: "OVERLAY", from: 0, durationInFrames: 300, beats: [{ frame: 10, fx: "zoom", target: [1700, 900, 100, 80], zoom: 2 }] }]);
  const mid = composeFrame(d, 100).zoom;
  assert.equal(mid.s, 2);
  assert.equal(mid.ox, 1920); // 오른쪽 끝으로 클램프 (W*s - W)
  assert.equal(mid.oy, 1080);
  assert.equal(composeFrame(d, 299).zoom.s, 1);
  assert.equal(findSegment(d, 300), -1);
});

const ovl = (beats, dur = 600) => design([{ id: "C", type: "OVERLAY", from: 0, durationInFrames: dur, beats }]);

test("줌 연쇄: 가까운 대상이 이어지면 줌을 풀지 않고 확대한 채 이동, 이어지지 않으면 문장 끝에서 1.0 으로 복귀", () => {
  // 1번(0~100 문장) → 가까운 2번(105부터) → 멀리 떨어진 3번(400부터)
  const d = ovl([
    { frame: 10, until: 100, fx: "zoom", zoom: 1.8, target: [800, 400, 200, 80] },
    { frame: 105, until: 190, fx: "zoom", zoom: 1.8, target: [1100, 450, 200, 80] },
    { frame: 400, until: 470, fx: "zoom", zoom: 2.0, target: [200, 300, 200, 80] },
  ]);
  const at = (f) => composeFrame(d, f).zoom;
  assert.equal(at(5).s, 1);
  assert.ok(at(60).s > 1.79);
  // 1번 문장이 끝난 직후~2번 시작 사이에도 확대가 유지된다 (풀렸다 다시 들어가지 않음)
  assert.ok(at(103).s > 1.79, "연쇄 구간에서 줌이 풀리면 안 된다");
  // 2번에서 3번 사이: 2번 문장이 끝나고 이어지는 대상이 멀어서 → 원래 비율로 복귀
  assert.equal(at(190 + 14 + 5).s, 1);
  assert.equal(at(300).s, 1);
  // 3번도 문장이 끝나면 복귀
  assert.ok(at(440).s > 1.99);
  assert.equal(at(470 + 14 + 2).s, 1);
});

test("자막 문장이 끝난 뒤에는 어떤 확대도 남지 않는다 (잔류 금지) + 상단 80% 기준으로 대상을 중앙에 둔다", () => {
  const d = ovl([{ frame: 30, until: 120, fx: "zoom", zoom: 2, target: [900, 300, 100, 100] }], 400);
  for (let f = 120 + 14; f < 400; f++) assert.equal(composeFrame(d, f).zoom.s, 1, `f${f}`);
  const z = composeFrame(d, 100).zoom;
  // 대상 중심 y=350 → 화면의 0.4H(432)에 오도록: oy = 350*2 - 432 = 268
  assert.equal(Math.round(z.oy), 268);
});

test("OVERLAY 는 문장마다 가리지 않는 진행선(HUD)이 달려 목소리가 나는 동안 공백이 없다", () => {
  const d = ovl([], 400);
  d.cues = [0, 100, 250];
  const hud = (f) => composeFrame(d, f).full;
  for (const f of [3, 50, 99, 120, 240, 300]) assert.ok(hud(f), `f${f}`);
  const w = (f) => /"width":([\d.]+)/.exec(JSON.stringify(hud(f)))[1] * 1;
  assert.ok(w(50) > w(10), "문장이 진행될수록 선이 길어짐");
  assert.ok(w(101) < w(99), "다음 문장이 시작되면 다시 시작");
});

test("FULL 의 모든 콘텐츠·빛·플래시는 상단 80% 로 잘려 하단 20%(자막 영역)에 들어가지 않는다", () => {
  const vars = { header: "h", img: "web/a.jpg", p1: "a", p2: "b", p3: "c", left: "L", right: "R", text: "t", title: "T", caption: "c", chip: "칩", from: "1", to: "2", note: "n",
    c1: "a", c2: "b", c3: "c", c4: "d", s1: "1", s2: "2", s3: "3", s4: "4", n1: "a", n2: "b", n3: "c", n4: "d", n5: "e", n6: "f", center: "C", r1: "a", r2: "b", p4: "x", logo1: "web/l.png", img1: "web/a.png", img2: "web/b.png", t1: "a", t2: "b" };
  for (const id of Object.keys(TEMPLATES)) {
    const d = design([{ id: "X", type: "FULL", from: 0, durationInFrames: 400, template: id, vars, beats: [{ frame: 0 }, { frame: 30 }, { frame: 60 }, { frame: 90 }, { frame: 120 }, { frame: 150 }] }]);
    d.cues = [0, 40, 80, 120];
    for (const f of [20, 100, 250, 399]) {
      const full = composeFrame(d, f).full;
      const stage = full.c[1]; // [배경(aurora), 콘텐츠 무대]
      assert.equal(stage.s.height, 1080 * 0.8, `${id} f${f} 무대는 상단 80%`);
      assert.equal(stage.s.overflow, "hidden");
      // 배경 하단 20% 는 단색 띠
      assert.ok(JSON.stringify(full.c[0]).includes("transparent 0%"), "하단 단색 띠");
    }
  }
});

test("이미지는 비율을 지킨다: 사진·스크린샷은 contain (cover 로 잘리지 않음) + 흐린 배경", () => {
  const d = design([{ id: "X", type: "FULL", from: 0, durationInFrames: 300, template: "SHOWCASE", vars: { img: "web/tall.jpg" }, beats: [{ frame: 0 }] }]);
  const j = JSON.stringify(composeFrame(d, 60).full);
  const fgs = j.match(/"objectFit":"(cover|contain)"/g);
  assert.deepEqual(fgs.sort(), ['"objectFit":"contain"', '"objectFit":"cover"']); // cover 는 흐린 배경 한 장뿐
  assert.ok(/"objectFit":"contain"[^}]*"transform"/.test(j) === false, "원본 이미지(contain)에는 확대 변형이 없다");
});

test("영상 소재는 장면 시작에 맞춘 무음 영상 노드로 나온다", () => {
  const d = design([{ id: "X", type: "FULL", from: 90, durationInFrames: 210, template: "SHOWCASE",
    vars: { img: "web/scene.mp4", caption: "움직임" }, beats: [{ frame: 90 }] }]);
  const j = JSON.stringify(composeFrame(d, 120).full);
  assert.ok(j.includes('"t":"video"'));
  assert.ok(j.includes('"asset":"web/scene.mp4"'));
  assert.ok(j.includes('"startFrame":90'));
  assert.ok(!j.includes('"t":"img"'), "같은 영상을 배경에 중복 재생하지 않는다");
});

test("디자인(style)은 문자열(예전 설계서)과 AI 가 만든 객체 모두 해석되고, 잘못된 색은 기본값으로 대체된다", () => {
  const a = resolveStyle("MINT_WAVE");
  assert.equal(a.name, "민트 웨이브");
  const b = resolveStyle({ name: "보안", bg: "grid", energy: 9, colors: { bg: "#0b0608", accent: "not-a-color", primary: "#d7263d" } });
  assert.equal(b.C.bg, "#0b0608");
  assert.equal(b.C.primary, "#d7263d");
  assert.equal(b.C.accent, STYLES.CINEMATIC_BLUE.C.accent); // 잘못된 값은 기본값
  assert.equal(b.energy, 1.4); // 범위 밖은 clamp
  assert.equal(resolveStyle({ bg: "nope" }).bg, "aurora");
});

test("배경 종류 4가지 모두 NaN 없이 그려지고 AI 가 고른 색이 실제로 쓰인다", () => {
  for (const bg of ["aurora", "grid", "particles", "waves"]) {
    const d = design([{ id: "A", type: "FULL", from: 0, durationInFrames: 300, template: "TITLE", vars: { title: "t" }, beats: [{ frame: 0 }] }]);
    d.style = { name: "x", bg, energy: 1.2, colors: { bg: "#0a0f1a", primary: "#d7263d" } };
    d.cues = [0, 100];
    const j = JSON.stringify(composeFrame(d, 50).full);
    assert.ok(!j.includes("NaN") && !j.includes("undefined") && !j.includes("null"), bg);
    assert.ok(j.includes("#0a0f1a"), `${bg} 배경색`);
  }
});
