# -*- mode: python ; coding: utf-8 -*-
# 배포용 단일 itmatzip-agent.exe — 내부에 agent-bundle.zip (onedir) 포함

from pathlib import Path

block_cipher = None

_SPEC_DIR = Path(SPECPATH)
_ICON_FILE = _SPEC_DIR / "assets" / "itmatzip-agent.ico"
_APP_ICON = str(_ICON_FILE.resolve()) if _ICON_FILE.is_file() else None
_BUNDLE_ZIP = _SPEC_DIR / "build" / "agent-bundle.zip"

if not _BUNDLE_ZIP.is_file():
    raise SystemExit(f"먼저 onedir 번들을 zip 으로 만드세요: {_BUNDLE_ZIP}")

hiddenimports = [
    "setup_entry",
    "agent_config",
    "runtime_paths",
    "common.windows_startup",
    "common.subprocess_util",
    "version",
]

a = Analysis(
    ["setup_entry.py"],
    pathex=["."],
    binaries=[],
    datas=[(str(_BUNDLE_ZIP), ".")],
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
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
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
