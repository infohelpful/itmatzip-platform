"""PyInstaller runtime hook — main.py 보다 먼저 실행."""

import os
import sys

if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8", errors="replace")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8", errors="replace")


def _patch_uvicorn_formatters() -> None:
    try:
        from uvicorn.logging import AccessFormatter, DefaultFormatter
    except ImportError:
        return

    for cls in (DefaultFormatter, AccessFormatter):
        _orig = cls.__init__

        def _init(self, *args, _orig=_orig, use_colors=None, **kwargs):
            if use_colors is None:
                out = sys.stdout
                use_colors = False if out is None else out.isatty()
            _orig(self, *args, use_colors=use_colors, **kwargs)

        cls.__init__ = _init  # type: ignore[method-assign]


_patch_uvicorn_formatters()
