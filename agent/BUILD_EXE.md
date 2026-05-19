# ItMatZip 로컬 에이전트 — Windows exe 만들기

## 한 줄 요약

프로젝트 루트(`itmatzip-platform`)에서 PowerShell:

```powershell
.\build-agent.ps1
```

생성 파일: `agent\dist\itmatzip-agent.exe`

---

## 사전 준비

1. **Windows 10/11**
2. **Python 3.10 이상** 설치  
   - 설치 시 **“Add python.exe to PATH”** 체크
3. 인터넷 연결 (최초 빌드 시 pip·PyInstaller 다운로드)

---

## 단계별 빌드 방법

### 1단계: 프로젝트 폴더로 이동

```powershell
cd "e:\Develop Program\2. itmatzip-platform\web-Tool\itmatzip-platform"
```

(본인 PC의 실제 경로로 바꿉니다.)

### 2단계: exe 아이콘 준비 (선택, 권장)

Windows exe 아이콘은 **`.ico`** 형식이어야 합니다.

1. 만든 아이콘을 아래 경로에 **`itmatzip-agent.ico`** 이름으로 저장:

   ```
   agent\assets\itmatzip-agent.ico
   ```

2. PNG만 있으면 [ICO 변환 사이트](https://convertio.co/ko/png-ico/) 등으로 `.ico` 변환 (256×256 포함 권장).

3. 다른 경로에 있으면 빌드 시 복사:

   ```powershell
   .\build-agent.ps1 -IconPath "D:\내아이콘.ico"
   ```

`.ico`가 없으면 Python 기본 아이콘으로 빌드됩니다.

### 3단계: 빌드 스크립트 실행

```powershell
.\build-agent.ps1
```

스크립트가 자동으로:

- `agent\.venv-build` 가상환경 생성 (없을 때만)
- `requirements.txt` 설치 (FastAPI, uvicorn, PyInstaller 등)
- PyInstaller로 `itmatzip-agent.exe` 생성

### 4단계: 결과 확인

```powershell
dir agent\dist\itmatzip-agent.exe
```

### 5단계: exe 실행

```powershell
.\agent\dist\itmatzip-agent.exe
```

또는 탐색기에서 `agent\dist\itmatzip-agent.exe` 더블클릭.

콘솔에 예시:

```text
ItMatZip Agent (exe) — http://127.0.0.1:19876
```

### 6단계: 동작 확인

브라우저에서:

- http://127.0.0.1:19876/health  
  → `{"status":"ok"}` 이면 정상

웹 UI(silence-remover)에서 **에이전트 연결됨**으로 표시되면 완료.

---

## 수동 빌드 (스크립트 없이)

```powershell
cd agent
python -m venv .venv-build
.\.venv-build\Scripts\Activate.ps1
pip install -r requirements.txt
pyinstaller itmatzip-agent.spec --noconfirm --clean
```

---

## 배포·사용 시 참고

| 항목 | 설명 |
|------|------|
| 포트 | 기본 `127.0.0.1:19876` (로컬만, `agent_config.py`) |
| FFmpeg | exe에 포함되지 않음. 첫 사용 시 `%APPDATA%\ItMatZip\bin\`에 자동 다운로드 |
| 파일 선택 | exe가 `--pick-file` 모드로 tkinter 대화상자 실행 |
| 설치(자동 실행) | **exe 1회 실행** → `%APPDATA%\ItMatZip\` 복사 + Windows 시작 프로그램 등록 (bat 불필요) |
| 백그라운드 | exe는 콘솔 창 없이 실행 (`console=False`) |
| 제거 | `itmatzip-agent.exe --uninstall` |
| 종료 | 작업 관리자에서 `itmatzip-agent.exe` 종료 (재부팅·로그인 시 다시 실행됨) |

exe만 다른 PC로 복사해 실행할 수 있습니다. Python 설치는 **받는 PC에는 필요 없습니다**.

---

## 문제 해결

**`python`을 찾을 수 없음**  
→ Python 재설치 후 PATH 추가, 터미널 재시작

**빌드는 됐는데 실행 시 바로 꺼짐**  
→ cmd에서 exe 실행해 오류 메시지 확인

**웹 UI에서 에이전트 연결 안 됨**  
→ exe 실행 중인지, 방화벽이 127.0.0.1:19876 을 막지 않는지 확인

**PyInstaller 오류**  
→ `pip install --upgrade pyinstaller` 후 `build-agent.ps1` 재실행

---

## 개발 모드 (exe 없이)

```powershell
.\start-agent.ps1
```

소스 수정 후 바로 테스트할 때 사용합니다.
