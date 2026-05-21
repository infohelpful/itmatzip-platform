"""
에이전트가 subprocess로 실행해, Windows 등에서 tkinter 파일 선택 대화상자를 띄웁니다.
stdout 한 줄에 JSON: {"path": "..."} 또는 {"error": "...", "message": "..."}
--output <path> 지정 시 해당 파일에 JSON을 기록합니다.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def _output_path() -> str | None:
    args = sys.argv[1:]
    for i, arg in enumerate(args):
        if arg == "--output" and i + 1 < len(args):
            return args[i + 1]
    return None


def _emit(payload: dict) -> None:
    text = json.dumps(payload, ensure_ascii=False)
    out_arg = _output_path()
    if out_arg:
        Path(out_arg).write_text(text + "\n", encoding="utf-8")
    else:
        print(text)


def main() -> None:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as e:
        _emit({"error": "tkinter_unavailable", "message": str(e)})
        sys.exit(3)

    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)
    except tk.TclError:
        pass

    try:
        path = filedialog.askopenfilename(
            parent=root,
            title="ItMatZip — 미디어 파일 선택",
            filetypes=[
                ("동영상", "*.mp4 *.mov *.mkv *.webm *.avi *.m4v"),
                ("오디오/동영상", "*.mp4 *.mov *.mkv *.webm *.avi *.m4a *.wav *.mp3 *.aac *.flac"),
                ("모든 파일", "*.*"),
            ],
        )
    finally:
        root.destroy()

    _emit({"path": path or ""})


if __name__ == "__main__":
    main()
