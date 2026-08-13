"""ProPainter video inpainting subprocess — ROI crop + overlay + audio mux.

MSI engine python + engine-runtime/watermark-remover
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import traceback
from pathlib import Path


def _bootstrap_import_paths() -> None:
    agent = os.environ.get("ITMATZIP_AGENT_DIR", "").strip()
    if not agent:
        install = os.environ.get("ITMATZIP_AGENT_INSTALL_ROOT", "").strip()
        if install:
            agent = str(Path(install) / "agent")
    if agent and agent not in sys.path:
        sys.path.insert(0, agent)
    try:
        from common.runtime_site_packages import (
            TOOL_WATERMARK_REMOVER,
            activate_runtime_site_packages,
        )

        os.environ.setdefault("ITMATZIP_RUNTIME_TOOL", TOOL_WATERMARK_REMOVER)
        activate_runtime_site_packages(TOOL_WATERMARK_REMOVER)
    except Exception as exc:
        print(f"warning: runtime site-packages bootstrap failed: {exc}", file=sys.stderr)


_bootstrap_import_paths()


def _report(pct: float, message: str) -> None:
    print(f"ITZ_PROGRESS {pct:.1f} {message}", flush=True)


def _even(value: int) -> int:
    return value if value % 2 == 0 else value - 1


def _align8(value: int) -> int:
    return max(8, value - (value % 8))


def _run(cmd: list[str], *, timeout: float) -> None:
    creationflags = 0
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=creationflags,
    )
    if proc.returncode != 0:
        detail = ((proc.stderr or "") + "\n" + (proc.stdout or "")).strip()[-1500:]
        raise RuntimeError(f"명령 실패 ({proc.returncode}): {' '.join(cmd[:6])}\n{detail}")


def _ffprobe_json(ffprobe: str, video: Path) -> dict:
    proc = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            str(video),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe 실패: {(proc.stderr or proc.stdout or '')[-800:]}")
    return json.loads(proc.stdout or "{}")


def _video_meta(ffprobe: str, video: Path) -> tuple[int, int, float, bool]:
    data = _ffprobe_json(ffprobe, video)
    width = height = 0
    fps = 24.0
    has_audio = False
    for stream in data.get("streams") or []:
        codec_type = str(stream.get("codec_type") or "")
        if codec_type == "audio":
            has_audio = True
            continue
        if codec_type != "video" or width:
            continue
        width = int(stream.get("width") or 0)
        height = int(stream.get("height") or 0)
        rate = str(stream.get("avg_frame_rate") or stream.get("r_frame_rate") or "24/1")
        if "/" in rate:
            num, den = rate.split("/", 1)
            try:
                fps = float(num) / float(den) if float(den) else 24.0
            except ValueError:
                fps = 24.0
        else:
            try:
                fps = float(rate)
            except ValueError:
                fps = 24.0
    if width <= 0 or height <= 0:
        raise RuntimeError("영상 해상도를 읽지 못했습니다.")
    return width, height, max(1.0, fps), has_audio


def _mask_bbox(mask_path: Path, frame_w: int, frame_h: int, margin: int) -> tuple[int, int, int, int]:
    import cv2
    import numpy as np

    mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    if mask is None:
        raise RuntimeError(f"마스크를 열 수 없습니다: {mask_path}")
    if mask.shape[1] != frame_w or mask.shape[0] != frame_h:
        mask = cv2.resize(mask, (frame_w, frame_h), interpolation=cv2.INTER_NEAREST)
    _, binary = cv2.threshold(mask, 10, 255, cv2.THRESH_BINARY)
    ys, xs = np.where(binary > 0)
    if xs.size == 0:
        raise RuntimeError("마스크가 비어 있습니다. 워터마크 영역을 칠한 뒤 다시 실행하세요.")

    # ProPainter는 작은 크롭(예: 104px)에서 마스크 안을 0으로 내보낸다.
    # 마스크를 중심으로 충분한 배경 문맥을 포함하도록 ROI를 키운다.
    min_side = min(_align8(_even(min(frame_w, frame_h))), 384)
    bw = int(xs.max()) - int(xs.min()) + 1
    bh = int(ys.max()) - int(ys.min()) + 1
    need_w = max(_align8(_even(bw + margin * 2)), min_side)
    need_h = max(_align8(_even(bh + margin * 2)), min_side)
    need_w = min(need_w, _align8(_even(frame_w)))
    need_h = min(need_h, _align8(_even(frame_h)))
    cx = (int(xs.min()) + int(xs.max()) + 1) // 2
    cy = (int(ys.min()) + int(ys.max()) + 1) // 2
    x0 = cx - need_w // 2
    y0 = cy - need_h // 2
    x0 = max(0, min(x0, frame_w - need_w))
    y0 = max(0, min(y0, frame_h - need_h))
    return x0, y0, need_w, need_h


def _crop_mask(mask_path: Path, dest: Path, box: tuple[int, int, int, int], frame_w: int, frame_h: int) -> None:
    import cv2

    x, y, w, h = box
    mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    if mask is None:
        raise RuntimeError(f"마스크를 열 수 없습니다: {mask_path}")
    if mask.shape[1] != frame_w or mask.shape[0] != frame_h:
        mask = cv2.resize(mask, (frame_w, frame_h), interpolation=cv2.INTER_NEAREST)
    cropped = mask[y : y + h, x : x + w]
    _, cropped = cv2.threshold(cropped, 10, 255, cv2.THRESH_BINARY)
    dest.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(dest), cropped)


def _extract_first_frame(ffmpeg: str, video: Path, dest: Path, timeout: float) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [
            ffmpeg,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            "0",
            "-i",
            str(video),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            str(dest),
        ],
        timeout=min(120.0, timeout),
    )


def _run_propainter(
    python: str,
    script: Path,
    cwd: Path,
    frames_dir: Path,
    mask_path: Path,
    output_dir: Path,
    *,
    fps: float,
    fp16: bool,
    timeout: float,
    use_cuda: bool,
) -> Path:
    argv = [
        str(script),
        "--video",
        str(frames_dir),
        "--mask",
        str(mask_path),
        "--output",
        str(output_dir),
        "--save_fps",
        str(max(1, int(round(fps)))),
        "--mask_dilation",
        "4",
        "--subvideo_length",
        "80",
        "--neighbor_length",
        "10",
    ]
    if fp16:
        argv.append("--fp16")

    from common.runtime_site_packages import TOOL_WATERMARK_REMOVER, engine_python_c_prefix

    prefix = engine_python_c_prefix(TOOL_WATERMARK_REMOVER)
    code = (
        prefix
        + f"import os, sys; os.chdir({str(cwd)!r}); sys.path.insert(0, {str(cwd)!r}); "
        + f"sys.argv = {argv!r}; "
        + f"import runpy; runpy.run_path({str(script)!r}, run_name='__main__')"
    )
    command = [python, "-u", "-c", code]

    env = os.environ.copy()
    env["PYTHONNOUSERSITE"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    try:
        from common.runtime_site_packages import (
            TOOL_WATERMARK_REMOVER,
            runtime_site_packages_dir,
        )

        site = str(runtime_site_packages_dir(TOOL_WATERMARK_REMOVER))
        parts = [str(cwd), site]
        old = env.get("PYTHONPATH", "")
        if old:
            parts.append(old)
        env["PYTHONPATH"] = os.pathsep.join(parts)
        env["ITMATZIP_RUNTIME_TOOL"] = TOOL_WATERMARK_REMOVER
    except Exception:
        env["PYTHONPATH"] = str(cwd)
    if not use_cuda:
        env["CUDA_VISIBLE_DEVICES"] = ""
    creationflags = 0
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proc = subprocess.Popen(  # noqa: S603
        command,
        cwd=str(cwd),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=creationflags,
    )
    log_tail: list[str] = []
    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.strip()
            if not line:
                continue
            log_tail.append(line)
            if len(log_tail) > 60:
                log_tail.pop(0)
            if "%" in line and ("|" in line or "it/s" in line or "s/it" in line):
                digits = "".join(ch if ch.isdigit() or ch == "." else " " for ch in line.split("%", 1)[0])
                parts = digits.split()
                if parts:
                    try:
                        pct = max(0.0, min(100.0, float(parts[-1])))
                        _report(55.0 + pct * 0.30, line[:120])
                    except ValueError:
                        pass
            elif len(line) < 160:
                _report(58.0, line[:120])
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise RuntimeError(f"ProPainter 처리 시간 초과 ({int(timeout)}초)") from None

    if proc.returncode != 0:
        detail = "\n".join(log_tail)[-2000:]
        raise RuntimeError(f"ProPainter 실행 실패 (exit {proc.returncode})\n{detail}")

    matches = list(output_dir.rglob("inpaint_out.mp4"))
    if not matches:
        raise RuntimeError("ProPainter 결과 영상(inpaint_out.mp4)을 찾지 못했습니다.")
    return matches[0]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--mask", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--preview", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--ffprobe", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--script", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--timeout", type=float, default=7200.0)
    args = parser.parse_args()

    input_path = Path(args.input)
    mask_path = Path(args.mask)
    output_path = Path(args.output)
    preview_path = Path(args.preview)
    work_dir = Path(args.work_dir)
    script = Path(args.script)
    cwd = Path(args.cwd)
    timeout = float(args.timeout)
    device = str(args.device).lower()

    try:
        _report(4.0, "영상 정보 확인 중…")
        width, height, fps, has_audio = _video_meta(args.ffprobe, input_path)
        box = _mask_bbox(mask_path, width, height, margin=48)
        x, y, roi_w, roi_h = box
        _report(8.0, f"워터마크 영역 {roi_w}×{roi_h} @ ({x},{y})")

        frames_dir = work_dir / "roi_frames"
        if frames_dir.exists():
            shutil.rmtree(frames_dir, ignore_errors=True)
        frames_dir.mkdir(parents=True, exist_ok=True)
        roi_mask = work_dir / "roi_mask.png"
        _crop_mask(mask_path, roi_mask, box, width, height)

        _report(12.0, "워터마크 영역 프레임 추출 중…")
        _run(
            [
                args.ffmpeg,
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(input_path),
                "-vf",
                f"crop={roi_w}:{roi_h}:{x}:{y}",
                "-q:v",
                "2",
                str(frames_dir / "%06d.jpg"),
            ],
            timeout=timeout,
        )
        if not any(frames_dir.glob("*.jpg")):
            raise RuntimeError("ROI 프레임을 추출하지 못했습니다.")

        pp_out = work_dir / "propainter_out"
        pp_out.mkdir(parents=True, exist_ok=True)
        _report(20.0, "ProPainter 추론 중…")
        inpaint_mp4 = _run_propainter(
            args.python,
            script,
            cwd,
            frames_dir,
            roi_mask,
            pp_out,
            fps=fps,
            fp16=False,
            timeout=timeout,
            use_cuda=device == "cuda",
        )

        _report(88.0, "원본 영상에 복원 영역 합성 중…")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        filter_complex = (
            f"[1:v]scale={roi_w}:{roi_h}:flags=bicubic[wm];"
            f"[0:v][wm]overlay={x}:{y}:eof_action=endall"
        )
        encode = [
            args.ffmpeg,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(input_path),
            "-i",
            str(inpaint_mp4),
            "-filter_complex",
            filter_complex,
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
        ]
        if has_audio:
            encode.extend(["-c:a", "copy", "-shortest"])
        else:
            encode.append("-an")
        encode.append(str(output_path))
        _run(encode, timeout=min(timeout, 1800.0))
        if not output_path.is_file():
            raise RuntimeError("합성된 결과 영상을 만들지 못했습니다.")

        _report(96.0, "미리보기 프레임 저장 중…")
        _extract_first_frame(args.ffmpeg, output_path, preview_path, timeout)
        _report(100.0, "워터마크 제거가 완료되었습니다.")
        print(
            "ITZ_RESULT "
            + json.dumps(
                {
                    "output_path": str(output_path.resolve()),
                    "preview_path": str(preview_path.resolve()),
                    "width": width,
                    "height": height,
                    "fps": fps,
                    "roi": {"x": x, "y": y, "width": roi_w, "height": roi_h},
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 0
    except Exception as exc:
        traceback.print_exc()
        print(f"ITZ_ERROR {exc}", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
