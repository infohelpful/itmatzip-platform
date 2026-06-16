/**
 * Vrew transcript vs ItMatZip AutoSubtitle.json — 배정 vs 스냅 분류
 *
 * Usage:
 *   node timing-assignment-vs-snap.mjs <vrew-transcript.json> <autosubtitle-project.json>
 *
 * Vrew: GET /result/{guid}/transcript body (dsfsdfdsf.txt 형식)
 * ItMatZip: 프로젝트 저장 JSON (format autosubtitle-project)
 */

import fs from "node:fs";

function normToken(s) {
  return String(s ?? "")
    .replace(/\s+/g, "")
    .replace(/[.,!?…·"'「」『』()[\]{}]/g, "")
    .toLowerCase();
}

function loadVrewWords(path) {
  const d = JSON.parse(fs.readFileSync(path, "utf8"));
  const out = [];
  for (const para of d.paragraphs ?? []) {
    for (const w of para) {
      if (w[5] === 0) out.push({ text: w[0], start: w[1], end: w[2] });
    }
  }
  return out;
}

function loadItmWords(path) {
  const d = JSON.parse(fs.readFileSync(path, "utf8"));
  const out = [];
  for (const cue of d.subtitles ?? []) {
    if (cue.is_silence || cue.isSilence) continue;
    for (const w of cue.words ?? []) {
      if (w.is_silence || w.isSilence || w.is_deleted || w.isDeleted) continue;
      const t = String(w.word ?? "").trim();
      if (!t || t === "--") continue;
      out.push({ text: t, start: Number(w.start), end: Number(w.end) });
    }
  }
  return out;
}

/** Greedy token alignment (same order). */
function alignWords(ref, hyp) {
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < ref.length && j < hyp.length) {
    const a = normToken(ref[i].text);
    const b = normToken(hyp[j].text);
    if (a && b && a === b) {
      pairs.push({ ref: ref[i], hyp: hyp[j], refIdx: i, hypIdx: j });
      i += 1;
      j += 1;
      continue;
    }
    const nextRef = i + 1 < ref.length ? normToken(ref[i + 1].text) : "";
    const nextHyp = j + 1 < hyp.length ? normToken(hyp[j + 1].text) : "";
    if (nextRef === b && nextRef) {
      i += 1;
    } else if (nextHyp === a && nextHyp) {
      j += 1;
    } else {
      i += 1;
      j += 1;
    }
  }
  return pairs;
}

function pct(sorted, q) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx];
}

function classifyPair(ref, hyp) {
  const ds = (hyp.start - ref.start) * 1000;
  const de = (hyp.end - ref.end) * 1000;
  const refMid = (ref.start + ref.end) / 2;
  const hypMid = (hyp.start + hyp.end) / 2;
  const mid = Math.abs(hypMid - refMid) * 1000;
  const refDur = Math.max(1e-6, ref.end - ref.start);
  const overlap = Math.max(0, Math.min(ref.end, hyp.end) - Math.max(ref.start, hyp.start));
  const iou = overlap / Math.max(1e-6, refDur + (hyp.end - hyp.start) - overlap);

  let kind = "snap";
  if (mid > 350 || iou < 0.35) kind = "assignment";
  else if (Math.abs(ds) > 150 || Math.abs(de) > 150) kind = "snap";
  else kind = "ok";

  return { ds, de, mid, iou, kind };
}

function main() {
  const [vrewPath, itmPath] = process.argv.slice(2);
  if (!vrewPath || !itmPath) {
    console.error("Usage: node timing-assignment-vs-snap.mjs <vrew.json> <autosubtitle-project.json>");
    process.exit(1);
  }

  const ref = loadVrewWords(vrewPath);
  const hyp = loadItmWords(itmPath);
  const pairs = alignWords(ref, hyp);
  const matchRate = pairs.length / Math.max(ref.length, hyp.length);

  const stats = pairs.map((p) => classifyPair(p.ref, p.hyp));
  const absStart = stats.map((s) => Math.abs(s.ds)).sort((a, b) => a - b);
  const absEnd = stats.map((s) => Math.abs(s.de)).sort((a, b) => a - b);
  const absMid = stats.map((s) => s.mid).sort((a, b) => a - b);

  const snap = stats.filter((s) => s.kind === "snap").length;
  const assign = stats.filter((s) => s.kind === "assignment").length;
  const ok = stats.filter((s) => s.kind === "ok").length;

  const refText = ref.map((w) => normToken(w.text)).join("|");
  const hypText = hyp.map((w) => normToken(w.text)).join("|");
  const textIdentical = refText === hypText;

  console.log("=== 배정 vs 스냅 진단 ===\n");
  console.log(`Vrew words: ${ref.length}`);
  console.log(`ItMatZip words: ${hyp.length}`);
  console.log(`Greedy matched: ${pairs.length} (${(matchRate * 100).toFixed(1)}% of max)`);
  console.log(`Full text sequence identical: ${textIdentical ? "YES" : "NO"}`);
  console.log("");
  console.log("Matched word timing (ms):");
  console.log(`  |Δstart| p50=${pct(absStart, 0.5).toFixed(0)}  p90=${pct(absStart, 0.9).toFixed(0)}`);
  console.log(`  |Δend|   p50=${pct(absEnd, 0.5).toFixed(0)}  p90=${pct(absEnd, 0.9).toFixed(0)}`);
  console.log(`  |Δmid|   p50=${pct(absMid, 0.5).toFixed(0)}  p90=${pct(absMid, 0.9).toFixed(0)}`);
  console.log("");
  console.log("Per-word classification (matched only):");
  console.log(`  ok (≤150ms):     ${ok} (${((100 * ok) / pairs.length).toFixed(1)}%)`);
  console.log(`  snap (>150ms):   ${snap} (${((100 * snap) / pairs.length).toFixed(1)}%)`);
  console.log(`  assignment:      ${assign} (${((100 * assign) / pairs.length).toFixed(1)}%)`);
  console.log("");

  let verdict;
  if (matchRate < 0.92) {
    verdict = "배정/칩(텍스트·단어 나눔) 문제 우세 — 타이밍 스냅으로는 한계";
  } else if (assign / pairs.length > 0.25) {
    verdict = "배정 문제 우세 — Whisper가 단어를 다른 구간에 배치";
  } else if (snap / pairs.length > 0.3 || pct(absMid, 0.5) > 120) {
    verdict = "스냅 문제 우세 — 같은 단어인데 경계만 밀림 (valley/align 여지)";
  } else {
    verdict = "전반적으로 양호 — 체감 이슈는 미디어 싱크·재생축 또는 소수 outlier";
  }
  console.log("판정:", verdict);
  console.log("");

  const worst = pairs
    .map((p, idx) => ({ ...stats[idx], text: p.ref.text, ref: p.ref, hyp: p.hyp }))
    .sort((a, b) => b.mid - a.mid)
    .slice(0, 15);
  console.log("Worst 15 by |Δmid| (ms):");
  for (const w of worst) {
    console.log(
      `  ${w.mid.toFixed(0)}ms [${w.kind}] "${w.text}" ref ${w.ref.start.toFixed(2)}-${w.ref.end.toFixed(2)} itm ${w.hyp.start.toFixed(2)}-${w.hyp.end.toFixed(2)} iou=${w.iou.toFixed(2)}`,
    );
  }
}

main();
