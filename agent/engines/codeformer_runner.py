"""CodeFormer inference subprocess entry (MSI engine python → script path)."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import traceback
from pathlib import Path


def _vendor_root() -> Path:
    raw = os.environ.get("ITMATZIP_CODEFORMER_ROOT", "").strip()
    if not raw:
        raise RuntimeError("ITMATZIP_CODEFORMER_ROOT is not set")
    root = Path(raw).resolve()
    if not root.is_dir():
        raise RuntimeError(f"CodeFormer vendor directory not found: {root}")
    return root


def _inference_env(vendor: Path) -> dict[str, str]:
    try:
        from engines.codeformer_runtime import codeformer_inference_env

        pkg = os.environ.get("ITMATZIP_AGENT_PACKAGE_ROOT", "").strip()
        agent_pkg = Path(pkg) if pkg else None
        return codeformer_inference_env(vendor, agent_package_root=agent_pkg)
    except Exception:
        env = os.environ.copy()
        env["PYTHONSAFEPATH"] = "1"
        env["PYTHONNOUSERSITE"] = "1"
        return env


def main() -> int:
    parser = argparse.ArgumentParser(description="Run CodeFormer inference_codeformer.py")
    parser.add_argument("--input", required=True, help="Input image file path")
    parser.add_argument("--output-dir", required=True, help="Output directory")
    parser.add_argument("--fidelity", type=float, default=0.7)
    parser.add_argument("--face-upsample", action="store_true", default=True)
    parser.add_argument("--only-center-face", action="store_true")
    parser.add_argument("--background-enhance", action="store_true")
    parser.add_argument("--upscale", type=int, default=1)
    parser.add_argument("--bg-tile", type=int, default=400, help="RealESRGAN tile size (default 400)")
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    output_dir = Path(args.output_dir).resolve()
    if not input_path.is_file():
        print(f"error: input file not found: {input_path}", file=sys.stderr)
        return 1

    vendor = _vendor_root()
    script = vendor / "inference_codeformer.py"
    if not script.is_file():
        print(f"error: inference script not found: {script}", file=sys.stderr)
        return 1

    input_folder = input_path.parent
    output_dir.mkdir(parents=True, exist_ok=True)

    cmd: list[str] = [
        sys.executable,
        "-P",
        "-u",
        str(script),
        "--input_path",
        str(input_folder),
        "--output_path",
        str(output_dir),
        "-w",
        str(max(0.0, min(1.0, args.fidelity))),
        "--upscale",
        str(max(1, min(4, int(args.upscale)))),
    ]
    if args.face_upsample:
        cmd.append("--face_upsample")
    if args.only_center_face:
        cmd.append("--only_center_face")
    if args.background_enhance:
        cmd.append("--bg_upsampler")
        cmd.append("realesrgan")
        tile = max(128, min(1024, int(args.bg_tile)))
        cmd.append("--bg_tile")
        cmd.append(str(tile))

    env = _inference_env(vendor)
    env["ITMATZIP_CODEFORMER_ROOT"] = str(vendor)

    py = os.environ.get("ITMATZIP_CODEFORMER_PYTHON", "").strip()
    if not py:
        try:
            from runtime_paths import codeformer_python_executable

            py = str(codeformer_python_executable())
        except Exception as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
    cmd[0] = py

    try:
        proc = subprocess.run(
            cmd,
            cwd=str(vendor),
            env=env,
            capture_output=True,
            text=True,
            timeout=float(os.environ.get("ITMATZIP_CODEFORMER_TIMEOUT", "7200")),
        )
    except subprocess.TimeoutExpired:
        print("error: CodeFormer inference timed out", file=sys.stderr)
        return 1
    except Exception:
        traceback.print_exc(file=sys.stderr)
        return 1

    if proc.stdout:
        print(proc.stdout, file=sys.stderr, end="")
    if proc.returncode != 0:
        if proc.stderr:
            print(proc.stderr, file=sys.stderr, end="")
        return proc.returncode or 1
    if proc.stderr:
        print(proc.stderr, file=sys.stderr, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
