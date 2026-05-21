"""로컬 파일 선택 (Go 브로커 미사용 시: uvicorn 단독·레거시)."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from common.subprocess_util import run_hidden
from runtime_paths import pick_audio_command, pick_audio_script_path, pick_file_command, pick_script_path

_PICK_API = "POST /api/agent/pick-local-file"
_PICK_AUDIO_API = "POST /api/agent/pick-local-audio-file"


def behind_go_proxy() -> bool:
    return os.environ.get("ITMATZIP_BEHIND_GO_PROXY", "").strip().lower() in ("1", "true", "yes")


def _require_direct_pick() -> None:
    if behind_go_proxy():
        raise RuntimeError(f"파일 선택은 Go 에이전트 API({_PICK_API})를 사용하세요.")


def _ps_quote(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _native_windows_pick_script(*, audio_only: bool) -> str:
    title = "ItMatZip — 오디오 파일 선택" if audio_only else "ItMatZip — 미디어 파일 선택"
    if audio_only:
        filt = (
            "오디오 파일 (*.wav;*.mp3;*.flac;*.m4a;*.aac;*.ogg;*.wma;*.opus)|"
            "*.wav;*.mp3;*.flac;*.m4a;*.aac;*.ogg;*.wma;*.opus|모든 파일 (*.*)|*.*"
        )
    else:
        filt = (
            "동영상 파일 (*.mp4;*.mov;*.mkv;*.webm;*.avi;*.m4v)|"
            "*.mp4;*.mov;*.mkv;*.webm;*.avi;*.m4v|"
            "오디오/동영상 (*.mp4;*.mov;*.mkv;*.webm;*.avi;*.m4a;*.wav;*.mp3;*.aac;*.flac)|"
            "*.mp4;*.mov;*.mkv;*.webm;*.avi;*.m4a;*.wav;*.mp3;*.aac;*.flac|"
            "모든 파일 (*.*)|*.*"
        )
    return (
        "$ErrorActionPreference='Stop'; "
        "Add-Type -AssemblyName System.Windows.Forms; "
        "[System.Windows.Forms.Application]::EnableVisualStyles(); "
        f"$dlg=New-Object System.Windows.Forms.OpenFileDialog; "
        f"$dlg.Title={_ps_quote(title)}; "
        f"$dlg.Filter={_ps_quote(filt)}; "
        "$dlg.CheckFileExists=$true; $dlg.Multiselect=$false; "
        "$owner=New-Object System.Windows.Forms.Form; "
        "$owner.TopMost=$true; $owner.FormBorderStyle='None'; "
        "$owner.ShowInTaskbar=$false; $owner.Opacity=0; "
        "$owner.Width=1; $owner.Height=1; "
        "$null=$dlg.ShowDialog($owner); $owner.Dispose(); "
        "$path=''; if($dlg.FileName){$path=$dlg.FileName}; "
        "[Console]::Out.WriteLine((@{path=$path}|ConvertTo-Json -Compress))"
    )


def _native_windows_pick(*, audio_only: bool, timeout: float) -> str:
    if os.name != "nt":
        raise RuntimeError("네이티브 파일 대화상자는 Windows에서만 지원합니다.")
    ps_exe = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    argv = [
        str(ps_exe),
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-STA",
        "-Command",
        _native_windows_pick_script(audio_only=audio_only),
    ]
    if os.environ.get("USERNAME", "").upper() in ("SYSTEM", "LOCAL SERVICE", "NETWORK SERVICE"):
        from common.win_user_process import run_as_active_console_user

        code = run_as_active_console_user(argv, timeout=timeout, allow_subprocess_fallback=False)
        raise RuntimeError(f"서비스 세션 pick은 Go 브로커를 사용하세요 (code={code})")

    proc = run_hidden(argv, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
    line = (proc.stdout or "").strip().splitlines()
    raw = line[-1] if line else ""
    if not raw:
        return ""
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("파일 선택 출력이 JSON 객체가 아닙니다.")
    return str(payload.get("path") or "").strip()


def _run_tkinter_pick(audio_only: bool, timeout: float) -> str:
    cmd = pick_audio_command() if audio_only else pick_file_command()
    proc = run_hidden(cmd, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
    line = (proc.stdout or "").strip().splitlines()
    raw = line[-1] if line else ""
    if not raw:
        return ""
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("파일 선택 출력이 JSON 객체가 아닙니다.")
    if payload.get("error") == "tkinter_unavailable":
        return _native_windows_pick(audio_only=audio_only, timeout=timeout)
    return str(payload.get("path") or "").strip()


def run_media_pick_dialog(*, timeout: float = 600) -> str:
    _require_direct_pick()
    if os.name == "nt":
        try:
            return _native_windows_pick(audio_only=False, timeout=timeout)
        except Exception:
            if pick_script_path().is_file():
                return _run_tkinter_pick(False, timeout)
            raise
    if not pick_script_path().is_file():
        raise RuntimeError("파일 선택 스크립트를 찾을 수 없습니다.")
    return _run_tkinter_pick(False, timeout)


def run_audio_pick_dialog(*, timeout: float = 600) -> str:
    _require_direct_pick()
    if os.name == "nt":
        try:
            return _native_windows_pick(audio_only=True, timeout=timeout)
        except Exception:
            if pick_audio_script_path().is_file():
                return _run_tkinter_pick(True, timeout)
            raise
    if not pick_audio_script_path().is_file():
        raise RuntimeError("오디오 파일 선택 스크립트를 찾을 수 없습니다.")
    return _run_tkinter_pick(True, timeout)
