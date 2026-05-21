"""
Windows: 로그온 사용자(대화형 세션)에서 subprocess 실행.
서비스(Session 0)에서 tkinter 파일 대화상자를 띄울 때 사용합니다.
"""

from __future__ import annotations

import os
import subprocess
import sys
import ctypes
from ctypes import Structure, byref, c_void_p, sizeof
from ctypes.wintypes import DWORD, HANDLE, LPWSTR, WORD

if os.name != "nt":
    raise RuntimeError("win_user_process is Windows-only")


class STARTUPINFOW(Structure):
    _fields_ = [
        ("cb", DWORD),
        ("lpReserved", LPWSTR),
        ("lpDesktop", LPWSTR),
        ("lpTitle", LPWSTR),
        ("dwX", DWORD),
        ("dwY", DWORD),
        ("dwXSize", DWORD),
        ("dwYSize", DWORD),
        ("dwXCountChars", DWORD),
        ("dwYCountChars", DWORD),
        ("dwFillAttribute", DWORD),
        ("dwFlags", DWORD),
        ("wShowWindow", WORD),
        ("cbReserved2", WORD),
        ("lpReserved2", c_void_p),
        ("hStdInput", HANDLE),
        ("hStdOutput", HANDLE),
        ("hStdError", HANDLE),
    ]


class PROCESS_INFORMATION(Structure):
    _fields_ = [
        ("hProcess", HANDLE),
        ("hThread", HANDLE),
        ("dwProcessId", DWORD),
        ("dwThreadId", DWORD),
    ]


kernel32 = ctypes.windll.kernel32
wtsapi32 = ctypes.windll.wtsapi32
userenv = ctypes.windll.userenv
advapi32 = ctypes.windll.advapi32

CREATE_UNICODE_ENVIRONMENT = 0x00000400
STARTF_USESHOWWINDOW = 0x00000001
SW_SHOW = 5
WAIT_OBJECT_0 = 0
WAIT_TIMEOUT = 258
TOKEN_ASSIGN_PRIMARY = 0x0001
TOKEN_DUPLICATE = 0x0002
TOKEN_QUERY = 0x0008
TOKEN_ADJUST_DEFAULT = 0x0080
TOKEN_ADJUST_SESSIONID = 0x0100
PROCESS_TOKEN_ACCESS = (
    TOKEN_ASSIGN_PRIMARY
    | TOKEN_DUPLICATE
    | TOKEN_QUERY
    | TOKEN_ADJUST_DEFAULT
    | TOKEN_ADJUST_SESSIONID
)


def _close_handle(handle: int) -> None:
    if handle:
        kernel32.CloseHandle(handle)


def active_console_session_id() -> int | None:
    sid = int(kernel32.WTSGetActiveConsoleSessionId())
    if sid == 0xFFFFFFFF:
        return None
    return sid


def run_as_active_console_user(
    argv: list[str],
    *,
    timeout: float = 600,
    cwd: str | None = None,
) -> int:
    """
    활성 콘솔 세션의 사용자 토큰으로 프로세스를 실행하고 종료 코드를 반환합니다.
    실패 시 일반 subprocess.run 으로 폴백합니다.
    """
    if not argv:
        raise ValueError("argv is empty")

    def _fallback() -> int:
        proc = subprocess.run(argv, cwd=cwd, timeout=timeout)
        return int(proc.returncode or 0)

    session_id = active_console_session_id()
    if session_id is None:
        return _fallback()

    user_token = HANDLE()
    if not wtsapi32.WTSQueryUserToken(session_id, byref(user_token)):
        return _fallback()

    duplicated = HANDLE()
    env_block = c_void_p()
    pi = PROCESS_INFORMATION()
    si = STARTUPINFOW()
    si.cb = sizeof(STARTUPINFOW)
    si.lpDesktop = "winsta0\\default"
    si.dwFlags = STARTF_USESHOWWINDOW
    si.wShowWindow = SW_SHOW

    cmdline = subprocess.list2cmdline(argv)
    cmdline_buf = ctypes.create_unicode_buffer(cmdline)

    try:
        if not advapi32.DuplicateTokenEx(
            user_token,
            PROCESS_TOKEN_ACCESS,
            None,
            2,  # SecurityImpersonation
            1,  # TokenPrimary
            byref(duplicated),
        ):
            return _fallback()

        if not userenv.CreateEnvironmentBlock(byref(env_block), duplicated, False):
            env_block = None

        creation_flags = CREATE_UNICODE_ENVIRONMENT if env_block else 0
        ok = advapi32.CreateProcessAsUserW(
            duplicated,
            None,
            cmdline_buf,
            None,
            None,
            False,
            creation_flags,
            env_block,
            cwd,
            byref(si),
            byref(pi),
        )
        if not ok:
            return _fallback()

        wait_ms = int(max(timeout, 1) * 1000)
        wait_result = kernel32.WaitForSingleObject(pi.hProcess, wait_ms)
        if wait_result == WAIT_TIMEOUT:
            _close_handle(pi.hThread)
            _close_handle(pi.hProcess)
            raise subprocess.TimeoutExpired(argv, timeout)
        if wait_result != WAIT_OBJECT_0:
            return _fallback()

        exit_code = DWORD(0)
        if not kernel32.GetExitCodeProcess(pi.hProcess, byref(exit_code)):
            return _fallback()
        return int(exit_code.value)
    finally:
        if env_block:
            userenv.DestroyEnvironmentBlock(env_block)
        _close_handle(pi.hProcess)
        _close_handle(pi.hThread)
        _close_handle(duplicated)
        _close_handle(user_token)
