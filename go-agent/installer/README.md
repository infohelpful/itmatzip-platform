# WiX MSI installer

## Build

```powershell
cd go-agent
powershell -ExecutionPolicy Bypass -File installer/build.ps1
```

Options:

```powershell
# Skip venv (exe + python_worker only — faster dev MSI)
powershell -ExecutionPolicy Bypass -File installer/build.ps1 -SkipEngine

# Custom Python for staging venv
powershell -ExecutionPolicy Bypass -File installer/build.ps1 -Python "C:\Python311\python.exe"
```

## Staging layout

```
dist/staging/
├── itmatzip-agent.exe
├── engine/              # python -m venv --copies + pip install requirements
│   ├── Scripts/python.exe
│   └── Lib/site-packages/...
├── python_worker/
│   ├── worker.py
│   ├── worker_grpc.py
│   └── agent_pb2*.py
└── models/              # empty at install time
```

`heat.exe` harvests `dist/staging/` into `dist/staging.wxs` and links with `product.wxs`.

## Install result

```
C:\Program Files\itmatzip-agent\
├── itmatzip-agent.exe
├── engine\
├── python_worker\
└── models\

C:\ProgramData\itmatzip-agent\
└── logs\
```

Post-install custom action runs `itmatzip-agent.exe --install` (kardianos Windows service).

## Requirements

- Go 1.23+
- Python 3.10+ (build machine, for staging venv)
- WiX Toolset 3.14+: `winget install WiXToolset.WiXToolset`

WiX는 winget으로 설치되어도 **PATH에 등록되지 않을 수 있습니다**. `build.ps1`이 `C:\Program Files (x86)\WiX Toolset v3.14\bin` 등을 자동 탐색합니다.

```powershell
# WiX 탐색 확인
powershell -ExecutionPolicy Bypass -File installer/resolve-wix.ps1

# PATH 수동 추가 (선택)
$env:PATH = "C:\Program Files (x86)\WiX Toolset v3.14\bin;$env:PATH"
```

## Cross-machine venv note

**권장:** MSI 빌드 시 `-UseEmbeddable`로 Python 3.11 embeddable + pip + grpc를 `engine/`에 번들.

venv `--copies` 모드는 `pyvenv.cfg home`이 빌드 PC Python 경로를 참조합니다.

Go resolves Python at `{install_root}\engine\Scripts\python.exe` then `{install_root}\engine\python.exe`, then system `python`.
