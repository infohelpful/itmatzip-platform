/**
 * premotion-core 렌더 진입점 — Python 워커(engines/motion_graphic.py)만 호출한다.
 *
 *   node render.mjs ensure-browser
 *   node render.mjs render <job.json>   # 설계서대로 원본 + 모션그래픽 + 오디오 → H.264 MP4
 *
 * stdout 에는 한 줄에 JSON 하나씩만 쓴다: {"type":"progress"|"log"|"done"|"error", ...}
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "src", "index.ts");
const COMPOSITION_ID = "Main";
const LICENSE_KEY = process.env.ITMATZIP_REMOTION_LICENSE_KEY || null;

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

function readJob(jobPath) {
  if (!jobPath) throw new Error("job.json 경로가 필요합니다.");
  return JSON.parse(fs.readFileSync(jobPath, "utf8"));
}

function onBrowserDownload() {
  emit({ type: "log", message: "렌더용 Chrome Headless Shell 다운로드 중…" });
  return {
    version: null,
    onProgress: ({ percent }) => emit({ type: "progress", stage: "browser", pct: Math.round((percent || 0) * 1000) / 10 }),
  };
}

async function makeBundle(publicDir) {
  let last = -1;
  return bundle({
    entryPoint: ENTRY,
    publicDir,
    outDir: fs.mkdtempSync(path.join(os.tmpdir(), "premotion-bundle-")),
    onProgress: (pct) => {
      if (pct !== last) {
        last = pct;
        emit({ type: "progress", stage: "bundle", pct });
      }
    },
  });
}

async function cmdEnsureBrowser() {
  await ensureBrowser({ onBrowserDownload, logLevel: "error" });
  emit({ type: "done" });
}

async function cmdRender(job) {
  const serveUrl = await makeBundle(job.publicDir);
  const inputProps = job.props;
  const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, onBrowserDownload, logLevel: "error" });
  const total = composition.durationInFrames;
  await renderMedia({
    composition,
    serveUrl,
    inputProps,
    codec: "h264",
    crf: job.crf || 18,
    x264Preset: "veryfast",
    audioCodec: "aac",
    imageFormat: "jpeg",
    jpegQuality: 92,
    outputLocation: job.out,
    overwrite: true,
    concurrency: job.concurrency || null,
    onBrowserDownload,
    licenseKey: LICENSE_KEY,
    logLevel: "error",
    onProgress: ({ renderedFrames, encodedFrames, stitchStage }) => {
      const pct = (((renderedFrames || 0) * 0.85 + (encodedFrames || 0) * 0.15) / total) * 100;
      emit({ type: "progress", stage: stitchStage || "render", pct: Math.round(pct * 10) / 10, frames: renderedFrames, total });
    },
  });
  emit({ type: "done", out: job.out });
}

async function main() {
  const [cmd, jobPath] = process.argv.slice(2);
  if (cmd === "ensure-browser") return cmdEnsureBrowser();
  if (cmd === "render") return cmdRender(readJob(jobPath));
  throw new Error(`알 수 없는 명령: ${cmd}`);
}

main().catch((err) => {
  emit({ type: "error", message: String(err?.stack || err?.message || err) });
  process.exit(1);
});
