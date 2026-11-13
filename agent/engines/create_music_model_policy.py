"""ACE-Step 모델 받기 정책 (runner 프로세스 안에서 ACE-Step import 후 호출).

ACE-Step 기본 모델 묶음(ACE-Step/Ace-Step1.5)에는 LM 1.7B(약 3.5GB)가 같이 들어 있지만,
Create Music은 thinking/CoT를 쓰지 않아 LM을 쓰지 않습니다.
- 설치 때 묶음에서 LM 폴더를 빼고 받고
- 생성 때 ACE-Step이 'LM이 없으니 기본 모델을 다시 받자'고 판단하지 않게 합니다.
"""
from __future__ import annotations

BUNDLED_LM_DIR = "acestep-5Hz-lm-1.7B"


def exclude_bundled_lm() -> None:
    """ACE-Step 기본 모델 구성에서 LM 1.7B를 뺍니다 (여러 번 불러도 안전)."""
    import acestep.model_downloader as md

    if BUNDLED_LM_DIR in md.MAIN_MODEL_COMPONENTS:
        md.MAIN_MODEL_COMPONENTS.remove(BUNDLED_LM_DIR)

    import huggingface_hub

    original = huggingface_hub.snapshot_download
    if getattr(original, "_itmatzip_skip_lm", False):
        return

    def snapshot_download(*args, **kwargs):
        repo_id = kwargs.get("repo_id") or (args[0] if args else "")
        if repo_id == md.MAIN_MODEL_REPO:
            ignore = list(kwargs.get("ignore_patterns") or [])
            ignore.append(f"{BUNDLED_LM_DIR}/*")
            kwargs["ignore_patterns"] = ignore
        return original(*args, **kwargs)

    snapshot_download._itmatzip_skip_lm = True  # type: ignore[attr-defined]
    huggingface_hub.snapshot_download = snapshot_download
