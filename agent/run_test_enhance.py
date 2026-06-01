"""Image Enhancer engine smoke test."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_AGENT = Path(__file__).resolve().parent
if str(_AGENT) not in sys.path:
    sys.path.insert(0, str(_AGENT))

from engines import image_enhancer  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--readiness-only", action="store_true")
    parser.add_argument("--image", type=str, default="")
    args = parser.parse_args()

    image_enhancer.ensure_workspace()
    from engines import codeformer_runtime

    try:
        print("python312:", codeformer_runtime.find_python312())
    except Exception as exc:
        print("python312: MISSING", exc)
    print("venv_dir:", codeformer_runtime.codeformer_venv_dir())
    try:
        from runtime_paths import codeformer_python_executable

        print("codeformer_python:", codeformer_python_executable())
        print("codeformer_py_version:", image_enhancer.codeformer_python_version())
    except Exception as exc:
        print("codeformer_python: MISSING (run prepare first)", exc)
    print("torch:", image_enhancer.is_torch_installed())
    print("pip_stack:", image_enhancer.is_pip_stack_ready())
    print("vendor:", image_enhancer.is_codeformer_vendor_ready())
    print("weights:", image_enhancer.is_model_weight_ready())
    print("model_ready:", image_enhancer.is_model_ready())

    if args.readiness_only:
        return 0

    if not args.image:
        print("Use --image <path> to run enhance (requires /prepare first).")
        return 0

    path = Path(args.image)
    if not path.is_file():
        print(f"File not found: {path}")
        return 1

    if not image_enhancer.is_model_ready():
        print("Running prepare…")
        image_enhancer.install_dependencies(
            on_progress=lambda p, s, d: print(f"  [{p:.0f}%] {s} {d}"),
        )
        image_enhancer.download_models(
            on_progress=lambda p, s, d: print(f"  [{p:.0f}%] {s} {d}"),
        )

    result = image_enhancer.enhance_image(
        path,
        on_progress=lambda p, m: print(f"  [{p:.0f}%] {m}"),
    )
    print("result:", result.result_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
