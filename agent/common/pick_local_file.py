"""로컬 파일 선택 대화상자 실행 (개발/서비스/Go 프록시 공통)."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

from common.subprocess_util import run_hidden
from runtime_paths import pick_audio_command, pick_audio_script_path, pick_file_command, pick_script_path


def _behind_go_proxy() -> bool:
    return os.environ.get("ITMATZIP_BEHIND_GO_PROXY", "").strip().lower() in ("1", "true", "yes")


def _use_interactive_user_session() -> bool:
    if os.name != "nt":
        return False
    if _behind_go_proxy():
        return True
    return os.environ.get("USERNAME", "").upper() in ("SYSTEM", "LOCAL SERVICE", "NETWORK SERVICE")


def _run_pick_argv(argv: list[str], *, timeout: float = 600) -> subprocess.CompletedProcess[str]:
    if _use_interactive_user_session():
        from common.win_user_process import run_as_active_console_user

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as tf:
            out_path = tf.name
        full_argv = [*argv, "--output", out_path]
        try:
            code = run_as_active_console_user(full_argv, timeout=timeout)
            out_file = Path(out_path)
            if not out_file.is_file():
                # 사용자 세션 실행이 실패했거나 출력 파일 생성 전에 종료된 경우를 보강합니다.
                fallback = run_hidden(
                    full_argv,
                    capture_output=True,
                    text=True,
                    timeout=timeout,
                    encoding="utf-8",
                    errors="replace",
                )
                fallback_stdout = (fallback.stdout or "").strip()
                if fallback_stdout:
                    return fallback
                raise RuntimeError(
                    f"파일 선택 프로세스 실행 후 출력 파일을 찾지 못했습니다: {out_path} (code={code})"
                )
            raw = out_file.read_text(encoding="utf-8", errors="replace").strip()
            lines = raw.splitlines()
            payload_line = lines[-1] if lines else raw
            return subprocess.CompletedProcess(
                args=full_argv,
                returncode=code,
                stdout=payload_line,
                stderr="",
            )
        finally:
            try:
                Path(out_path).unlink(missing_ok=True)
            except OSError:
                pass

    return run_hidden(
        argv,
        capture_output=True,
        text=True,
        timeout=timeout,
        encoding="utf-8",
        errors="replace",
    )


def _native_windows_pick_command(*, audio_only: bool) -> list[str]:
    def _ps_quote(text: str) -> str:
        return "'" + text.replace("'", "''") + "'"

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
    ps_script = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        "$out=''; "
        "for($i=0;$i -lt $args.Length;$i++){"
        "if($args[$i] -eq '--output' -and $i+1 -lt $args.Length){$out=$args[$i+1]}}; "
        "$dlg=New-Object System.Windows.Forms.OpenFileDialog; "
        "$dlg.Title="
        + _ps_quote(title)
        + "; "
        "$dlg.Filter="
        + _ps_quote(filt)
        + "; "
        "$dlg.CheckFileExists=$true; "
        "$dlg.Multiselect=$false; "
        "$null=$dlg.ShowDialog(); "
        "$path=''; "
        "if($dlg.FileName){$path=$dlg.FileName}; "
        "$payload=@{path=$path} | ConvertTo-Json -Compress; "
        "if($out){Set-Content -LiteralPath $out -Value $payload -Encoding UTF8}else{Write-Output $payload}"
    )
    return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps_script]


def _parse_pick_stdout(proc: subprocess.CompletedProcess[str]) -> dict[str, object]:
    if proc.returncode not in (0, None) and not (proc.stdout or "").strip():
        raise RuntimeError(
            f"파일 선택 프로세스가 비정상 종료되었습니다 (code={proc.returncode}). stderr={proc.stderr!r}"
        )
    line = (proc.stdout or "").strip().splitlines()
    raw = line[-1] if line else ""
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"대화상자 출력 파싱 실패: {exc}. stderr={proc.stderr!r}"
        ) from exc
    if not isinstance(payload, dict):
        raise ValueError("대화상자 출력이 JSON 객체가 아닙니다.")
    return payload


def _run_native_windows_pick_dialog(*, audio_only: bool, timeout: float = 600) -> dict[str, object]:
    proc = _run_pick_argv(_native_windows_pick_command(audio_only=audio_only), timeout=timeout)
    return _parse_pick_stdout(proc)


def run_media_pick_dialog(*, timeout: float = 600) -> str:
    if not pick_script_path().is_file() and not _behind_go_proxy():
        raise RuntimeError("파일 선택 스크립트를 찾을 수 없습니다.")
    proc = _run_pick_argv(pick_file_command(), timeout=timeout)
    payload = _parse_pick_stdout(proc)
    if payload.get("error") == "tkinter_unavailable":
        try:
            payload = _run_native_windows_pick_dialog(audio_only=False, timeout=timeout)
        except Exception as exc:
            raise RuntimeError(
                "tkinter를 사용할 수 없고 Windows 네이티브 파일 대화상자 실행도 실패했습니다."
            ) from exc
    return str(payload.get("path") or "").strip()


def run_audio_pick_dialog(*, timeout: float = 600) -> str:
    if not pick_audio_script_path().is_file() and not _behind_go_proxy():
        raise RuntimeError("오디오 파일 선택 스크립트를 찾을 수 없습니다.")
    proc = _run_pick_argv(pick_audio_command(), timeout=timeout)
    payload = _parse_pick_stdout(proc)
    if payload.get("error") == "tkinter_unavailable":
        try:
            payload = _run_native_windows_pick_dialog(audio_only=True, timeout=timeout)
        except Exception as exc:
            raise RuntimeError(
                "tkinter를 사용할 수 없고 Windows 네이티브 파일 대화상자 실행도 실패했습니다."
            ) from exc
    return str(payload.get("path") or "").strip()
