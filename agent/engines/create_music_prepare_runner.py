"""ACE-Step 모델 다운로드 (engine-runtime — 직접 실행하지 마세요)."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def _bootstrap_import_paths() -> None:
    agent = os.environ.get("ITMATZIP_AGENT_DIR", "").strip() or os.environ.get(
        "ITMATZIP_AGENT_PACKAGE_ROOT", ""
    ).strip()
    if not agent:
        install = os.environ.get("ITMATZIP_AGENT_INSTALL_ROOT", "").strip()
        if install:
            agent = str(Path(install) / "agent")
    if agent and agent not in sys.path:
        sys.path.insert(0, agent)
    try:
        from common.runtime_site_packages import TOOL_CREATE_MUSIC, activate_runtime_site_packages

        os.environ.setdefault("ITMATZIP_RUNTIME_TOOL", TOOL_CREATE_MUSIC)
        activate_runtime_site_packages(TOOL_CREATE_MUSIC)
    except Exception as exc:
        print(f"warning: runtime site-packages bootstrap failed: {exc}", file=sys.stderr)

    root = os.environ.get("ITMATZIP_ACESTEP_ROOT", "").strip() or os.environ.get(
        "ACESTEP_PROJECT_ROOT", ""
    ).strip()
    if root and root not in sys.path:
        sys.path.insert(0, root)


_bootstrap_import_paths()


def _write_progress(path: str, progress: float, message: str) -> None:
    if not path:
        return
    Path(path).write_text(
        json.dumps({"progress": progress, "message": message}, ensure_ascii=False),
        encoding="utf-8",
    )


def _prepare_main_model(ckpt: Path, *, force: bool) -> tuple[bool, str]:
    from acestep.model_downloader import download_main_model, ensure_main_model

    if force:
        return download_main_model(checkpoints_dir=ckpt, force=True)
    return ensure_main_model(checkpoints_dir=ckpt)


def _prepare_dit_model(name: str, ckpt: Path, *, force: bool) -> tuple[bool, str]:
    from acestep.model_downloader import download_submodel, ensure_dit_model

    if force:
        return download_submodel(name, checkpoints_dir=ckpt, force=True)
    return ensure_dit_model(name, checkpoints_dir=ckpt)


def _prepare_lm_model(name: str, ckpt: Path, *, force: bool) -> tuple[bool, str]:
    from acestep.model_downloader import download_submodel, ensure_lm_model

    if force:
        return download_submodel(name, checkpoints_dir=ckpt, force=True)
    return ensure_lm_model(name, checkpoints_dir=ckpt)


def main() -> int:
    req_path = Path(sys.argv[1])
    req = json.loads(req_path.read_text(encoding="utf-8"))
    progress_path = req.get("progress_path", "")
    result_path = req.get("result_path", "")

    os.environ["ACESTEP_PROJECT_ROOT"] = req["project_root"]
    os.environ["ACESTEP_CHECKPOINTS_DIR"] = req["checkpoints_dir"]

    try:
        ckpt = Path(req["checkpoints_dir"])
        force = bool(req.get("force", False))

        _write_progress(progress_path, 45, "메인 모델 확인·다운로드 중…")
        ok, msg = _prepare_main_model(ckpt, force=force)
        if not ok:
            raise RuntimeError(msg)

        dit_configs = req.get("dit_configs") or ["acestep-v15-turbo"]
        for i, dit in enumerate(dit_configs):
            pct = 50 + (20 * (i + 1) / max(1, len(dit_configs)))
            _write_progress(progress_path, pct, f"DiT 모델: {dit}")
            ok, msg = _prepare_dit_model(dit, ckpt, force=force)
            if not ok:
                raise RuntimeError(msg)

        lm_list = req.get("lm_models") or []
        for j, lm in enumerate(lm_list):
            pct = 72 + (18 * (j + 1) / max(1, len(lm_list)))
            _write_progress(progress_path, pct, f"LM 모델: {lm}")
            ok, msg = _prepare_lm_model(lm, ckpt, force=force)
            if not ok:
                raise RuntimeError(msg)

        _write_progress(progress_path, 95, "모델 준비 완료")
        result = {"ok": True, "message": "모델 준비 완료"}
    except Exception as e:
        result = {"ok": False, "error": str(e)}
        _write_progress(progress_path, 0, f"실패: {e}")

    if result_path:
        Path(result_path).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
