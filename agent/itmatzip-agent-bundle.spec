# -*- mode: python ; coding: utf-8 -*-
# 내부용 onedir 번들 — setup exe 에 zip 으로 포함됨 (직접 배포 X)

from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

block_cipher = None

_SPEC_DIR = Path(SPECPATH)
_ICON_FILE = _SPEC_DIR / "assets" / "itmatzip-agent.ico"
_APP_ICON = str(_ICON_FILE.resolve()) if _ICON_FILE.is_file() else None

hiddenimports = [
    "launcher",
    "main",
    "agent_config",
    "runtime_paths",
    "engines.silence_remover",
    "routers.silence_remover",
    "common.bin_manager",
    "common.auto_update",
    "common.update_config",
    "common.windows_startup",
    "common.subprocess_util",
    "version",
    "scripts.pick_media_dialog",
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "uvicorn.__main__",
    "multipart",
    "PIL",
    "PIL.Image",
    "PIL.ImageDraw",
    "PIL.ImageFont",
]

datas = []
binaries = []

for pkg in ("uvicorn", "fastapi", "starlette", "pydantic", "anyio", "sniffio"):
    try:
        tmp = collect_all(pkg)
        datas += tmp[0]
        binaries += tmp[1]
        hiddenimports += tmp[2]
    except Exception:
        pass

hiddenimports += collect_submodules("uvicorn")

a = Analysis(
    ["launcher.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=["hooks/pyi_rth_stdio.py"],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="itmatzip-agent",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=_APP_ICON,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="itmatzip-agent",
)
