"""
오디오 파일만 선택하는 tkinter 대화상자.
stdout 한 줄 JSON: {"path": "..."} 또는 {"error": "...", "message": "..."}
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
            title="ItMatZip — 오디오 파일 선택",
            filetypes=[
                ("오디오", "*.wav *.mp3 *.flac *.m4a *.aac *.ogg *.wma *.opus"),
                ("WAV", "*.wav"),
                ("MP3", "*.mp3"),
                ("FLAC", "*.flac"),
                ("모든 파일", "*.*"),
            ],
        )
    finally:
        root.destroy()

    _emit({"path": path or ""})


if __name__ == "__main__":
    main()
