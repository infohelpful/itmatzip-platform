"""
에이전트가 subprocess로 실행해, Windows 등에서 tkinter 파일 선택 대화상자를 띄웁니다.
stdout 한 줄에 JSON: {"path": "..."} 또는 {"error": "...", "message": "..."}
"""

from __future__ import annotations

import json
import sys


def main() -> None:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as e:
        print(json.dumps({"error": "tkinter_unavailable", "message": str(e)}))
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

    print(json.dumps({"path": path or ""}))


if __name__ == "__main__":
    main()
