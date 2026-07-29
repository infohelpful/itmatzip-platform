"""CodeFormer inference subprocess entry (MSI engine python → vendor script)."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import traceback
from pathlib import Path


def _bootstrap_import_paths() -> None:
    """MSI embeddable Python 은 PYTHONPATH 를 무시 — agent·runtime 경로를 직접 삽입."""
    agent = os.environ.get("ITMATZIP_AGENT_DIR", "").strip()
    if not agent:
        install = os.environ.get("ITMATZIP_AGENT_INSTALL_ROOT", "").strip()
        if install:
            agent = str(Path(install) / "agent")
    if agent and agent not in sys.path:
        sys.path.insert(0, agent)
    try:
        from common.runtime_site_packages import TOOL_IMAGE_ENHANCER, activate_runtime_site_packages

        os.environ.setdefault("ITMATZIP_RUNTIME_TOOL", TOOL_IMAGE_ENHANCER)
        activate_runtime_site_packages(TOOL_IMAGE_ENHANCER)
    except Exception as exc:
        print(f"warning: runtime site-packages bootstrap failed: {exc}", file=sys.stderr)


_bootstrap_import_paths()


def _vendor_root() -> Path:
    raw = os.environ.get("ITMATZIP_CODEFORMER_ROOT", "").strip()
    if not raw:
        raise RuntimeError("ITMATZIP_CODEFORMER_ROOT is not set")
    root = Path(raw).resolve()
    if not root.is_dir():
        raise RuntimeError(f"CodeFormer vendor directory not found: {root}")
    return root


def _site_packages() -> Path | None:
    try:
        from engines.codeformer_runtime import codeformer_site_packages

        site = codeformer_site_packages()
        return site if site.is_dir() else None
    except Exception:
        return None


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

    infer_argv = [
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
        infer_argv.append("--face_upsample")
    if args.only_center_face:
        infer_argv.append("--only_center_face")
    if args.background_enhance:
        infer_argv.append("--bg_upsampler")
        infer_argv.append("realesrgan")
        tile = max(128, min(1024, int(args.bg_tile)))
        infer_argv.append("--bg_tile")
        infer_argv.append(str(tile))

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

    # Embeddable Python ignores PYTHONPATH — bootstrap paths then runpy.
    site = _site_packages()
    path_inserts: list[str] = [str(vendor)]
    if site is not None:
        path_inserts.append(str(site))
    pkg = os.environ.get("ITMATZIP_AGENT_PACKAGE_ROOT", "").strip()
    if pkg:
        path_inserts.append(pkg)

    boot = (
        "import runpy, sys\n"
        f"for _p in {path_inserts!r}:\n"
        "    if _p and _p not in sys.path:\n"
        "        sys.path.insert(0, _p)\n"
        f"sys.argv = {infer_argv!r}\n"
        f"runpy.run_path({str(script)!r}, run_name='__main__')\n"
    )
    cmd = [py, "-c", boot]

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
