/**
 * OVERLAY 하이라이트 대상 추적 — 원본 화면이 스크롤·확대되어도 줌·링이 대상을 따라가게 한다 (의존성 없음, 토큰 0).
 *
 *   node track.mjs <job.json>
 *   job: { ffmpeg, video, w, h, items: [{ key, start, end, box: [x, y, w, h] }] }   (start/end 초, box 원본 픽셀)
 *   stdout: 한 줄에 하나 {"key", "track": [[초, x, y, w, h], ...]}  마지막에 {"done": true}
 *
 * 방법: 320×180 그레이 프레임(10fps)에서 대상 영역을 템플릿으로 잡고, 다음 프레임마다 직전 위치 주변(±18px)과
 * 크기 변화(0.9~1.1배)를 ±28px 범위에서 훑어 차이(SAD)가 가장 작은 곳을 고른다. 놓치면(차이가 너무 크면) 직전 위치를 유지한다.
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const GW = 320;
const GH = 180;
const RATE = 10;

function frames(job, start, end) {
  const out = spawnSync(job.ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", String(Math.max(0, start)), "-i", job.video,
    "-t", String(Math.max(0.1, end - start)), "-vf", `fps=${RATE},scale=${GW}:${GH},format=gray`, "-f", "rawvideo", "-"],
  { maxBuffer: 1 << 30, windowsHide: true });
  const buf = out.stdout || Buffer.alloc(0);
  const list = [];
  for (let o = 0; o + GW * GH <= buf.length; o += GW * GH) list.push(buf.subarray(o, o + GW * GH));
  return list;
}

function track(job, item) {
  const fr = frames(job, item.start, item.end);
  if (!fr.length) return [];
  const sx = GW / job.w;
  const sy = GH / job.h;
  const bw = Math.max(6, item.box[2] * sx);
  const bh = Math.max(4, item.box[3] * sy);
  let cx = (item.box[0] + item.box[2] / 2) * sx;
  let cy = (item.box[1] + item.box[3] / 2) * sy;
  let s = 1;
  // 템플릿: 대상 주변까지 넓게(질감이 적은 링크·버튼도 주변 글자·선으로 잡히게) 격자 샘플
  const cw = Math.min(GW * 0.9, Math.max(bw * 2.6, 90));
  const ch = Math.min(GH * 0.9, Math.max(bh * 3.2, 50));
  const pts = [];
  const nx = 36;
  const ny = 20;
  const f0 = fr[0];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const ox = ((i + 0.5) / nx - 0.5) * cw;
      const oy = ((j + 0.5) / ny - 0.5) * ch;
      const x = Math.round(cx + ox);
      const y = Math.round(cy + oy);
      if (x >= 0 && y >= 0 && x < GW && y < GH) pts.push([ox, oy, f0[y * GW + x]]);
    }
  }
  const out = [[item.start, item.box[0], item.box[1], item.box[2], item.box[3]]];
  const sad = (f, px, py, sc) => {
    let sum = 0;
    let n = 0;
    for (const [ox, oy, v] of pts) {
      const x = Math.round(px + ox * sc);
      const y = Math.round(py + oy * sc);
      if (x < 0 || y < 0 || x >= GW || y >= GH) continue;
      sum += Math.abs(f[y * GW + x] - v);
      n += 1;
    }
    return n > pts.length * 0.6 ? sum / n : Infinity;
  };
  for (let k = 1; k < fr.length; k++) {
    const f = fr[k];
    let best = { e: sad(f, cx, cy, s), x: cx, y: cy, s };
    for (const ds of [0.9, 0.95, 1, 1.05, 1.1]) {
      const sc = Math.min(4, Math.max(0.4, s * ds));
      for (let dy = -28; dy <= 28; dy += 2) {
        for (let dx = -28; dx <= 28; dx += 2) {
          const e = sad(f, cx + dx, cy + dy, sc);
          if (e < best.e) best = { e, x: cx + dx, y: cy + dy, s: sc };
        }
      }
    }
    // 2px 격자 결과를 1px 로 다듬기
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const e = sad(f, best.x + dx, best.y + dy, best.s);
        if (e < best.e) best = { e, x: best.x + dx, y: best.y + dy, s: best.s };
      }
    }
    if (best.e < 30) {
      cx = best.x;
      cy = best.y;
      s = best.s;
    }
    const w = (bw * s) / sx;
    const hh = (bh * s) / sy;
    out.push([item.start + k / RATE, Math.round(cx / sx - w / 2), Math.round(cy / sy - hh / 2), Math.round(w), Math.round(hh)]);
  }
  return out;
}

const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const item of job.items || []) {
  let result = [];
  try {
    result = track(job, item);
  } catch (err) {
    process.stderr.write(String(err?.stack || err));
  }
  process.stdout.write(`${JSON.stringify({ key: item.key, track: result })}\n`);
}
process.stdout.write(`${JSON.stringify({ done: true })}\n`);
