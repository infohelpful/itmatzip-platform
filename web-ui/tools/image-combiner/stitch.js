const MOBILE_BUDGET = 12_000_000;
const MAX_CANVAS_SIDE = 16384;
const MIN_WIDTH = 320;

export function isConstrainedDevice() {
  const ua = navigator.userAgent || "";
  if (/Android|webOS|iPhone|iPod|iPad|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true;
  try {
    if (navigator.userAgentData && navigator.userAgentData.mobile) return true;
  } catch {
    /* ignore */
  }
  if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return true;
  if (/Windows NT|Win64|WOW64/i.test(ua)) return false;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const narrow = window.matchMedia("(max-width: 900px)").matches;
  return coarse && narrow;
}

export function pixelBudget() {
  return isConstrainedDevice() ? MOBILE_BUDGET : Number.POSITIVE_INFINITY;
}

export function defaultWidthMode() {
  return isConstrainedDevice() ? "1080" : "max";
}

async function decodeOriented(source, extra = {}) {
  const tries = [{ imageOrientation: "from-image", ...extra }, extra, {}];
  let lastError = null;
  for (const opts of tries) {
    try {
      return await createImageBitmap(source, opts);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("decode failed");
}

export async function inspectImage(file) {
  const bmp = await decodeOriented(file);
  const size = { width: bmp.width, height: bmp.height };
  bmp.close();
  return size;
}

export function resolveTargetWidth(sizes, widthMode) {
  if (!sizes.length) return 0;
  const widths = sizes.map((s) => s.width);
  const maxW = Math.max(...widths);
  const minW = Math.min(...widths);
  if (widthMode === "min") return minW;
  if (widthMode === "720") return 720;
  if (widthMode === "1080") return 1080;
  if (widthMode === "1440") return 1440;
  if (widthMode === "original") return maxW;
  return maxW;
}

export function planLayout(sizes, { widthMode, gap }) {
  const n = sizes.length;
  const gapPx = Math.max(0, Math.min(50, Number(gap) || 0));
  const native = widthMode === "original";
  const targetW = resolveTargetWidth(sizes, widthMode);
  const rows = sizes.map((s) => {
    if (native) {
      return { drawW: s.width, drawH: s.height, srcW: s.width, srcH: s.height };
    }
    const scale = targetW / s.width;
    return {
      drawW: targetW,
      drawH: Math.max(1, Math.round(s.height * scale)),
      srcW: s.width,
      srcH: s.height,
    };
  });
  const canvasW = native ? Math.max(...rows.map((r) => r.drawW)) : targetW;
  const contentH = rows.reduce((sum, r) => sum + r.drawH, 0) + gapPx * Math.max(0, n - 1);
  return { canvasW, contentH, gapPx, native, rows };
}

export function fitLayoutToBudget(layout, budget) {
  if (layout.contentH <= 0 || layout.canvasW <= 0) {
    return { ...layout, scale: 1, scaled: false };
  }
  const area = layout.canvasW * layout.contentH;
  let scale = 1;
  if (Number.isFinite(budget) && area > budget) {
    scale = Math.min(scale, Math.sqrt(budget / area));
  }
  const maxDim = Math.max(layout.canvasW, layout.contentH);
  if (maxDim * scale > MAX_CANVAS_SIDE) {
    scale = Math.min(scale, MAX_CANVAS_SIDE / maxDim);
  }
  if (scale >= 0.9995) {
    return { ...layout, scale: 1, scaled: false };
  }
  const rows = layout.rows.map((r) => ({
    ...r,
    drawW: Math.max(1, Math.round(r.drawW * scale)),
    drawH: Math.max(1, Math.round(r.drawH * scale)),
  }));
  const canvasW = Math.max(
    MIN_WIDTH,
    Math.round(layout.canvasW * scale),
    ...rows.map((r) => r.drawW),
  );
  const contentH = rows.reduce((sum, r) => sum + r.drawH, 0) + layout.gapPx * Math.max(0, rows.length - 1);
  return { canvasW, contentH, gapPx: layout.gapPx, native: layout.native, rows, scale, scaled: true };
}

function fillBackground(ctx, width, height, background) {
  if (!background || background === "transparent") return;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("toBlob failed"));
      },
      mime,
      quality,
    );
  });
}

async function stitchOnce(files, layout, background, mime, quality) {
  const canvas = document.createElement("canvas");
  canvas.width = layout.canvasW;
  canvas.height = Math.max(1, layout.contentH);
  const ctx = canvas.getContext("2d", { alpha: mime === "image/png" });
  if (!ctx) throw new Error("canvas");
  fillBackground(ctx, canvas.width, canvas.height, background);
  ctx.imageSmoothingQuality = "high";
  let y = 0;
  const shrinkDecode = isConstrainedDevice();
  for (let i = 0; i < files.length; i += 1) {
    const row = layout.rows[i];
    const extra = {};
    if (shrinkDecode && row.drawW < row.srcW) {
      extra.resizeWidth = row.drawW;
      extra.resizeQuality = "high";
    }
    const bmp = await decodeOriented(files[i], extra);
    const x = Math.round((layout.canvasW - row.drawW) / 2);
    ctx.imageSmoothingEnabled = bmp.width !== row.drawW || bmp.height !== row.drawH;
    ctx.drawImage(bmp, x, y, row.drawW, row.drawH);
    bmp.close();
    y += row.drawH + (i < files.length - 1 ? layout.gapPx : 0);
  }
  const blob = await canvasToBlob(canvas, mime, quality);
  canvas.width = 1;
  canvas.height = 1;
  return { blob, width: layout.canvasW, height: layout.contentH, scaled: Boolean(layout.scaled) };
}

/**
 * @param {File[]} files
 * @param {{ sizes: {width:number,height:number}[], widthMode: string, gap: number, background: string, format: "jpg"|"png", quality: number }} options
 */
export async function stitchImages(files, options) {
  const mime = options.format === "png" ? "image/png" : "image/jpeg";
  let background = options.background;
  if (mime === "image/jpeg" && (!background || background === "transparent")) {
    background = "#ffffff";
  }
  const quality = Math.min(1, Math.max(0.8, Number(options.quality) || 0.92));
  let layout = fitLayoutToBudget(planLayout(options.sizes, options), pixelBudget());
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await stitchOnce(files, layout, background, mime, quality);
    } catch (error) {
      lastError = error;
      const nextW = Math.max(MIN_WIDTH, Math.floor(layout.canvasW * 0.8));
      if (nextW >= layout.canvasW) break;
      const scale = nextW / layout.canvasW;
      layout = {
        ...layout,
        canvasW: nextW,
        scaled: true,
        scale: (layout.scale || 1) * scale,
        rows: layout.rows.map((r) => ({
          ...r,
          drawW: Math.max(1, Math.round(r.drawW * scale)),
          drawH: Math.max(1, Math.round(r.drawH * scale)),
        })),
      };
      layout.contentH =
        layout.rows.reduce((sum, r) => sum + r.drawH, 0) + layout.gapPx * Math.max(0, layout.rows.length - 1);
    }
  }
  throw lastError || new Error("stitch failed");
}

export function tryAnchorDownload(blob, filename) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 4000);
}

export async function shareOrSave(blob, filename, options = {}) {
  const type = blob.type || "image/jpeg";
  const file = new File([blob], filename, { type });
  if (options.preferShare && navigator.canShare) {
    try {
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return { ok: true, via: "share" };
      }
    } catch (error) {
      if (error && error.name === "AbortError") return { ok: false, aborted: true };
    }
  }
  if (!isConstrainedDevice() && window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: "Image",
            accept: { [type]: [type === "image/png" ? ".png" : ".jpg"] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { ok: true, via: "picker" };
    } catch (error) {
      if (error && error.name === "AbortError") return { ok: false, aborted: true };
    }
  }
  tryAnchorDownload(blob, filename);
  return { ok: true, via: "anchor", needPreview: isConstrainedDevice() };
}
