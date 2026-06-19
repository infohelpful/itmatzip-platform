from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from common.subprocess_util import no_window_creationflags, run_hidden
from engines import codeformer_runtime
from runtime_paths import agent_package_root, codeformer_python_executable, codeformer_runner_script, is_frozen

PrepareProgressCallback = Callable[[float, str, str], None]

IMAGE_ENHANCER_ROOT = Path(os.environ.get("APPDATA", Path.home() / ".itmatzip")) / "ItMatZip" / "image-enhancer"
MODEL_ROOT = IMAGE_ENHANCER_ROOT / "models"
WORKSPACE_ROOT = IMAGE_ENHANCER_ROOT / "workspace"
VENDOR_ROOT = IMAGE_ENHANCER_ROOT / "vendor" / "CodeFormer"
MANIFEST_PATH = IMAGE_ENHANCER_ROOT / "prepare-manifest.json"

ALLOWED_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".jfif"}
SUPPORTED_OUTPUT_FORMATS = {"png", "jpg", "jpeg"}

CODEFORMER_ZIP_URL = os.environ.get(
    "ITMATZIP_CODEFORMER_ZIP_URL",
    codeformer_runtime.DEFAULT_CODEFORMER_SOURCE_ZIP_URL,
)
CODEFORMER_WEIGHT_URL = os.environ.get(
    "ITMATZIP_CODEFORMER_WEIGHT_URL",
    codeformer_runtime.DEFAULT_CODEFORMER_WEIGHT_URL,
)
REALESRGAN_WEIGHT_URL = os.environ.get(
    "ITMATZIP_REALESRGAN_WEIGHT_URL",
    codeformer_runtime.DEFAULT_REALESRGAN_WEIGHT_URL,
)
CODEFORMER_WEIGHT_PATH = MODEL_ROOT / "CodeFormer" / "codeformer.pth"
REALESRGAN_WEIGHT_PATH = VENDOR_ROOT / "weights" / "realesrgan" / "RealESRGAN_x2plus.pth"

_TQDM_RE = re.compile(r"(\d+)%\|")


@dataclass
class EnhanceResult:
    original_path: Path
    result_path: Path
    width: int
    height: int


@dataclass
class EnhanceJobStatus:
    phase: str
    progress: float
    message: str | None = None
    result: EnhanceResult | None = None


_enhance_lock = threading.RLock()
_enhance_job = EnhanceJobStatus(phase="idle", progress=0.0, message=None)
_enhance_thread: threading.Thread | None = None


def _emit_prepare_progress(
    on_progress: PrepareProgressCallback | None,
    pct: float,
    step: str,
    detail: str = "",
) -> None:
    if on_progress is not None:
        on_progress(pct, step, detail)


def ensure_workspace() -> None:
    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
    VENDOR_ROOT.mkdir(parents=True, exist_ok=True)


def codeformer_python_version() -> str:
    try:
        py = codeformer_runtime.venv_python()
    except RuntimeError:
        return ""
    proc = run_hidden(
        [str(py), "--version"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    return (proc.stdout or proc.stderr or "").strip()


def is_codeformer_vendor_ready() -> bool:
    return (VENDOR_ROOT / "inference_codeformer.py").is_file()


def is_model_weight_ready() -> bool:
    return CODEFORMER_WEIGHT_PATH.is_file() and CODEFORMER_WEIGHT_PATH.stat().st_size > 1_000_000


def is_realesrgan_weight_ready() -> bool:
    return REALESRGAN_WEIGHT_PATH.is_file() and REALESRGAN_WEIGHT_PATH.stat().st_size > 1_000_000


def is_torch_installed() -> bool:
    return codeformer_runtime.is_torch_installed()


def is_pip_stack_ready() -> bool:
    return codeformer_runtime.is_pip_stack_ready(vendor_root=VENDOR_ROOT)


def is_model_ready() -> bool:
    try:
        if not codeformer_runtime.is_venv_ready(vendor_root=VENDOR_ROOT):
            return False
    except Exception:
        return False
    return is_codeformer_vendor_ready() and is_model_weight_ready()


def is_model_ready_fast() -> bool:
    if not codeformer_runtime.is_venv_ready_fast():
        return False
    return is_codeformer_vendor_ready() and is_model_weight_ready()


def has_nvidia_gpu() -> bool:
    return codeformer_runtime.has_nvidia_gpu()


def is_cuda_available() -> bool:
    return codeformer_runtime.is_cuda_available()


def installed_torch_version() -> str | None:
    return codeformer_runtime.installed_torch_version()


def select_torch_bundle() -> str:
    return codeformer_runtime.select_torch_bundle()


def normalize_enhance_upscale(upscale: int, *, background_enhance: bool) -> int:
    """CodeFormer RealESRGAN 배경 복원은 upscale>=2일 때 효과가 큼 (x2plus 모델)."""
    value = max(1, min(4, int(upscale)))
    if background_enhance and value < 2:
        return 2
    return value


def is_allowed_media_path(path: Path) -> bool:
    resolved = path.resolve()
    if WORKSPACE_ROOT in resolved.parents or resolved == WORKSPACE_ROOT:
        return True
    if IMAGE_ENHANCER_ROOT in resolved.parents or resolved == IMAGE_ENHANCER_ROOT:
        return True
    return resolved.is_file() and resolved.suffix.lower() in ALLOWED_IMAGE_SUFFIXES


def is_allowed_input_path(path: Path) -> bool:
    resolved = path.resolve()
    if not resolved.is_file():
        return False
    if resolved.suffix.lower() not in ALLOWED_IMAGE_SUFFIXES:
        return False
    return is_allowed_media_path(resolved)


def get_enhance_job_status() -> EnhanceJobStatus:
    with _enhance_lock:
        return EnhanceJobStatus(
            phase=_enhance_job.phase,
            progress=_enhance_job.progress,
            message=_enhance_job.message,
            result=_enhance_job.result,
        )


def _set_enhance_job(
    phase: str,
    progress: float,
    message: str | None = None,
    result: EnhanceResult | None = None,
) -> None:
    with _enhance_lock:
        _enhance_job.phase = phase
        _enhance_job.progress = progress
        _enhance_job.message = message
        if result is not None or phase in {"idle", "failed"}:
            _enhance_job.result = result


def cleanup_workspace() -> dict[str, object]:
    ensure_workspace()
    errors: list[str] = []
    files_removed = 0
    dirs_removed = 0

    with _enhance_lock:
        if _enhance_thread is not None and _enhance_thread.is_alive():
            return {
                "ok": False,
                "files_removed": 0,
                "dirs_removed": 0,
                "errors": ["향상 작업이 진행 중입니다. 완료 후 정리할 수 있습니다."],
            }
        _enhance_job.phase = "idle"
        _enhance_job.progress = 0.0
        _enhance_job.message = "작업 공간이 정리되었습니다."
        _enhance_job.result = None

    for entry in list(WORKSPACE_ROOT.iterdir()):
        try:
            if entry.is_dir():
                shutil.rmtree(entry)
                dirs_removed += 1
            elif entry.is_file():
                entry.unlink()
                files_removed += 1
        except OSError as exc:
            errors.append(f"{entry.name}: {exc}")

    return {
        "ok": len(errors) == 0,
        "files_removed": files_removed,
        "dirs_removed": dirs_removed,
        "errors": errors,
    }


def _download_file(url: str, dest: Path, on_progress: PrepareProgressCallback | None, pct: float, label: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "itmatzip-agent/1.0"})
    hasher = hashlib.sha256()
    read = 0
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            total = int(resp.headers.get("Content-Length") or 0)
            with open(tmp, "wb") as out:
                while True:
                    chunk = resp.read(1024 * 256)
                    if not chunk:
                        break
                    out.write(chunk)
                    hasher.update(chunk)
                    read += len(chunk)
                    if total > 0 and on_progress:
                        sub = pct + (read / total) * 8.0
                        _emit_prepare_progress(
                            on_progress,
                            min(pct + 8.0, sub),
                            label,
                            f"{read // (1024 * 1024)} / {total // (1024 * 1024)} MB",
                        )
    except urllib.error.URLError as exc:
        raise RuntimeError(f"다운로드 실패 ({url}): {exc}") from exc
    tmp.replace(dest)
    manifest = _load_manifest()
    manifest["files"] = manifest.get("files") or {}
    manifest["files"][dest.name] = {"url": url, "sha256": hasher.hexdigest(), "bytes": read}
    _save_manifest(manifest)


def _load_manifest() -> dict:
    if not MANIFEST_PATH.is_file():
        return {"version": 2, "python": "3.12", "files": {}}
    try:
        return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"version": 2, "python": "3.12", "files": {}}


def _save_manifest(data: dict) -> None:
    ensure_workspace()
    data.setdefault("python", "3.12")
    MANIFEST_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _find_codeformer_source_dir(extract_root: Path) -> Path:
    for pattern in ("CodeFormer-master", "CodeFormer-*"):
        for candidate in extract_root.glob(pattern):
            if candidate.is_dir() and (candidate / "inference_codeformer.py").is_file():
                return candidate
    for candidate in extract_root.iterdir():
        if candidate.is_dir() and (candidate / "inference_codeformer.py").is_file():
            return candidate
    raise RuntimeError("CodeFormer zip 안에 inference_codeformer.py 가 있는 폴더를 찾을 수 없습니다.")


def _ensure_codeformer_vendor(on_progress: PrepareProgressCallback | None = None) -> None:
    if is_codeformer_vendor_ready():
        _emit_prepare_progress(on_progress, 58.0, "CodeFormer 소스", "이미 설치됨")
        return

    _emit_prepare_progress(on_progress, 50.0, "CodeFormer 소스", "library-hub에서 다운로드 중…")
    ensure_workspace()
    with tempfile.TemporaryDirectory() as tmpdir:
        zip_path = Path(tmpdir) / "codeformer.zip"
        _download_file(CODEFORMER_ZIP_URL, zip_path, on_progress, 52.0, "CodeFormer zip")
        extract_root = Path(tmpdir) / "extract"
        extract_root.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(extract_root)
        src = _find_codeformer_source_dir(extract_root)
        if VENDOR_ROOT.exists():
            shutil.rmtree(VENDOR_ROOT, ignore_errors=True)
        shutil.copytree(src, VENDOR_ROOT)

    if not is_codeformer_vendor_ready():
        raise RuntimeError("CodeFormer vendor 설치 후 inference_codeformer.py 를 찾을 수 없습니다.")


def download_models(on_progress: PrepareProgressCallback | None = None) -> None:
    if not is_model_weight_ready():
        _emit_prepare_progress(on_progress, 72.0, "AI 모델", "codeformer.pth 다운로드")
        _download_file(CODEFORMER_WEIGHT_URL, CODEFORMER_WEIGHT_PATH, on_progress, 74.0, "codeformer.pth")
    else:
        _emit_prepare_progress(on_progress, 78.0, "AI 모델", "codeformer.pth 이미 있음")

    weights_dir = VENDOR_ROOT / "weights" / "CodeFormer"
    weights_dir.mkdir(parents=True, exist_ok=True)
    link_target = weights_dir / "codeformer.pth"
    if not link_target.is_file() and is_model_weight_ready():
        try:
            shutil.copy2(CODEFORMER_WEIGHT_PATH, link_target)
        except OSError:
            pass

    if not is_realesrgan_weight_ready():
        _emit_prepare_progress(on_progress, 84.0, "AI 모델", "RealESRGAN_x2plus.pth 다운로드")
        _download_file(
            REALESRGAN_WEIGHT_URL,
            REALESRGAN_WEIGHT_PATH,
            on_progress,
            86.0,
            "RealESRGAN_x2plus.pth",
        )
    else:
        _emit_prepare_progress(on_progress, 90.0, "AI 모델", "RealESRGAN 이미 있음")


def install_dependencies(on_progress: PrepareProgressCallback | None = None) -> str:
    if is_frozen():
        raise RuntimeError("Frozen exe 환경에서는 CodeFormer 자동 설치를 지원하지 않습니다.")

    ensure_workspace()
    bundle = codeformer_runtime.install_runtime_dependencies(on_progress)
    _emit_prepare_progress(
        on_progress,
        12.0,
        "CodeFormer Python",
        str(codeformer_runtime.venv_python()),
    )
    _ensure_codeformer_vendor(on_progress)
    codeformer_runtime.configure_vendor_basicsr(VENDOR_ROOT, on_progress)
    return bundle


def _resolve_device(device: str | None) -> str:
    if device is None:
        return "cuda" if is_cuda_available() else "cpu"
    normalized = str(device).lower()
    if normalized not in {"cpu", "cuda"}:
        raise ValueError("device must be 'cpu' or 'cuda'")
    if normalized == "cuda" and not is_cuda_available():
        raise RuntimeError(
            "CUDA를 사용할 수 없습니다. Image Enhancer 준비를 다시 실행하거나 CPU를 선택하세요."
        )
    return normalized


def _image_size(path: Path) -> tuple[int, int]:
    from PIL import Image

    with Image.open(path) as im:
        return im.size


def _convert_output(src: Path, output_format: str, jpg_quality: int) -> Path:
    from PIL import Image

    fmt = output_format.lower()
    if fmt == "png" and src.suffix.lower() == ".png":
        return src
    out = src.with_suffix(f".{fmt}")
    with Image.open(src) as im:
        if fmt in {"jpg", "jpeg"}:
            rgb = im.convert("RGB")
            rgb.save(out, format="JPEG", quality=jpg_quality, optimize=True)
        else:
            im.save(out, format="PNG")
    return out


def _find_result_image(output_dir: Path, input_stem: str) -> Path | None:
    candidates: list[Path] = []
    for pattern in ("**/final_results/**/*.png", "**/restored_faces/**/*.png", "**/*.png"):
        for path in output_dir.glob(pattern):
            if path.is_file() and input_stem in path.stem:
                candidates.append(path)
    if not candidates:
        for path in output_dir.rglob("*.png"):
            if path.is_file():
                candidates.append(path)
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def _run_codeformer_subprocess(
    input_path: Path,
    output_dir: Path,
    *,
    fidelity: float,
    upscale: int,
    background_enhance: bool,
    only_center_face: bool,
    face_upsample: bool,
    bg_tile: int,
    timeout_sec: float,
    on_progress: Callable[[float, str], None] | None = None,
) -> None:
    runner = codeformer_runner_script()
    if not runner.is_file():
        raise RuntimeError(f"codeformer_runner.py 없음: {runner}")

    cf_python = codeformer_python_executable()
    pkg = agent_package_root()
    env = codeformer_runtime.codeformer_inference_env(VENDOR_ROOT, agent_package_root=pkg)
    env["ITMATZIP_CODEFORMER_ROOT"] = str(VENDOR_ROOT.resolve())
    env["ITMATZIP_CODEFORMER_PYTHON"] = str(cf_python)
    env["ITMATZIP_AGENT_PACKAGE_ROOT"] = str(pkg)
    env["ITMATZIP_CODEFORMER_TIMEOUT"] = str(timeout_sec)

    command = [
        str(cf_python),
        "-P",
        "-u",
        str(runner),
        "--input",
        str(input_path.resolve()),
        "--output-dir",
        str(output_dir.resolve()),
        "--fidelity",
        str(fidelity),
        "--upscale",
        str(upscale),
    ]
    if face_upsample:
        command.append("--face-upsample")
    if only_center_face:
        command.append("--only-center-face")
    if background_enhance:
        command.append("--background-enhance")
        command.append("--bg-tile")
        command.append(str(max(128, min(1024, int(bg_tile)))))

    kwargs: dict = {
        "cwd": str(pkg),
        "env": env,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "creationflags": no_window_creationflags(),
    }
    codeformer_runtime.patch_basicsr_torchvision_compat(VENDOR_ROOT)
    codeformer_runtime.patch_vendor_unicode_imread(VENDOR_ROOT)

    proc = subprocess.Popen(command, **kwargs)  # noqa: S603
    last_pct = 15.0
    log_tail: list[str] = []
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            line_stripped = line.strip()
            if line_stripped:
                log_tail.append(line_stripped)
                if len(log_tail) > 80:
                    log_tail.pop(0)
            if not line_stripped:
                continue
            match = _TQDM_RE.search(line_stripped)
            if match and on_progress:
                pct = max(15.0, min(88.0, float(match.group(1))))
                last_pct = pct
                on_progress(pct, line_stripped[:120])
            elif on_progress and len(line_stripped) < 160:
                on_progress(last_pct, line_stripped)
        proc.wait(timeout=timeout_sec)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise RuntimeError(f"CodeFormer 처리 시간 초과 ({int(timeout_sec)}초)") from None

    if proc.returncode != 0:
        detail = "\n".join(log_tail)[-2000:] if log_tail else ""
        msg = f"CodeFormer 실행 실패 (exit {proc.returncode})"
        if detail:
            msg = f"{msg}\n{detail}"
        raise RuntimeError(msg)


def enhance_image(
    input_path: Path,
    *,
    fidelity: float = 0.7,
    upscale: int = 1,
    background_enhance: bool = False,
    only_center_face: bool = False,
    face_upsample: bool = True,
    output_format: str = "png",
    jpg_quality: int = 95,
    device: str | None = None,
    bg_tile: int = 400,
    timeout_sec: float = 1800.0,
    on_progress: Callable[[float, str], None] | None = None,
) -> EnhanceResult:
    def report(pct: float, msg: str) -> None:
        if on_progress:
            on_progress(pct, msg)

    if not is_model_ready():
        raise RuntimeError("CodeFormer 환경이 준비되지 않았습니다. 먼저 /prepare를 호출하세요.")
    if output_format.lower() not in SUPPORTED_OUTPUT_FORMATS:
        raise ValueError(f"지원되지 않는 출력 포맷: {output_format}")
    if not is_allowed_input_path(input_path):
        raise ValueError(f"허용되지 않은 입력 경로입니다: {input_path}")

    device_resolved = _resolve_device(device)
    report(5.0, f"작업 폴더 준비 중… ({device_resolved.upper()} · Python 3.12)")

    job_dir = WORKSPACE_ROOT / f"job-{int(time.time() * 1000)}"
    input_dir = job_dir / "input"
    output_dir = job_dir / "output"
    input_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    # CodeFormer/OpenCV imread cannot open non-ASCII paths on Windows.
    staged_input = input_dir / f"input{input_path.suffix.lower()}"
    shutil.copy2(input_path, staged_input)

    upscale_resolved = normalize_enhance_upscale(upscale, background_enhance=background_enhance)
    if background_enhance:
        report(
            10.0,
            f"CodeFormer 실행 중… (배경 RealESRGAN · {upscale_resolved}x)",
        )
    else:
        report(10.0, "CodeFormer AI 복원 실행 중…")
    _run_codeformer_subprocess(
        staged_input,
        output_dir,
        fidelity=fidelity,
        upscale=upscale_resolved,
        background_enhance=background_enhance,
        only_center_face=only_center_face,
        face_upsample=face_upsample,
        bg_tile=bg_tile,
        timeout_sec=timeout_sec,
        on_progress=on_progress,
    )

    report(90.0, "결과 파일을 찾는 중…")
    result_png = _find_result_image(output_dir, staged_input.stem)
    if result_png is None:
        raise RuntimeError("CodeFormer 결과 이미지를 찾을 수 없습니다.")

    final_path = _convert_output(result_png, output_format, jpg_quality)
    width, height = _image_size(final_path)
    report(100.0, "화질 향상이 완료되었습니다.")

    return EnhanceResult(
        original_path=input_path.resolve(),
        result_path=final_path.resolve(),
        width=width,
        height=height,
    )


def _run_enhance_job(
    input_path: Path,
    fidelity: float,
    upscale: int,
    background_enhance: bool,
    only_center_face: bool,
    face_upsample: bool,
    output_format: str,
    jpg_quality: int,
    device: str | None,
    bg_tile: int,
    timeout_sec: float,
) -> None:
    try:
        def on_progress(pct: float, msg: str) -> None:
            _set_enhance_job("running", pct, msg)

        result = enhance_image(
            input_path,
            fidelity=fidelity,
            upscale=upscale,
            background_enhance=background_enhance,
            only_center_face=only_center_face,
            face_upsample=face_upsample,
            output_format=output_format,
            jpg_quality=jpg_quality,
            device=device,
            bg_tile=bg_tile,
            timeout_sec=timeout_sec,
            on_progress=on_progress,
        )
        _set_enhance_job("ready", 100.0, "완료", result=result)
    except Exception as exc:
        _set_enhance_job("failed", 0.0, str(exc))


def start_enhance_job(
    input_path: Path,
    *,
    fidelity: float = 0.7,
    upscale: int = 1,
    background_enhance: bool = False,
    only_center_face: bool = False,
    face_upsample: bool = True,
    output_format: str = "png",
    jpg_quality: int = 95,
    device: str | None = None,
    bg_tile: int = 400,
    timeout_sec: float = 1800.0,
) -> EnhanceJobStatus:
    global _enhance_thread

    with _enhance_lock:
        if _enhance_thread is not None and _enhance_thread.is_alive():
            return get_enhance_job_status()
        _set_enhance_job("running", 2.0, "향상 작업을 시작합니다…")
        _enhance_thread = threading.Thread(
            target=_run_enhance_job,
            args=(
                input_path,
                fidelity,
                upscale,
                background_enhance,
                only_center_face,
                face_upsample,
                output_format,
                jpg_quality,
                device,
                bg_tile,
                timeout_sec,
            ),
            daemon=True,
        )
        _enhance_thread.start()
    return get_enhance_job_status()
