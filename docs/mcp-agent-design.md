# ItMatZip 공통 MCP 연동 설계

## 목표

ItMatZip 로컬 에이전트가 MCP 서버 역할을 맡고, Codex·Claude Code/Desktop·Google Antigravity가 같은 도구를 쓸 수 있게 한다. MCP 연결 계층은 공통으로 유지하고, 각 웹 도구의 기능은 개별 MCP 도구 모듈로 추가한다.

## 구성

```text
Codex / Claude / Antigravity
          │ MCP stdio (JSON-RPC)
          ▼
itmatzip-agent-mcp.exe --mcp
          │ loopback HTTP (127.0.0.1:19876)
          ▼
ItMatZip FastAPI 에이전트 ── 도구별 엔진·로컬 파일
```

stdio를 선택한 이유는 세 클라이언트가 모두 로컬 프로세스 MCP 연결을 지원하고, 에이전트가 이미 사용자 PC에 설치되기 때문이다. MCP 프로세스는 웹 서버와 분리해 실행하며, 내부에서 에이전트의 loopback API만 호출한다. MCP를 통해 임의 셸 명령이나 임의 경로 접근은 제공하지 않는다.

## 현재 작동 범위

- `itmatzip_agent_status`: 로컬 에이전트 상태 확인
- `autosub_ai_settings`: AutoSubtitle AI 제공자와 설정 상태 확인 (키 원문은 반환하지 않음)
- `autosub_get_active_subtitles`: 현재 열린 AutoSubtitle 화면에서 자막, 단어 인덱스, 타임스탬프, 줄 시작과 쉼 정보를 가져옴
- `autosub_submit_active_edits`: CLI가 만든 단어 교정 및 줄바꿈을 열린 화면으로 전달. revision이 달라지면 거부함
- `autosub_proofread`: 전달받은 자막 줄을 현재 AutoSubtitle 교정 엔진으로 교정하고 수정 제안 반환
- CLI가 가져온 수정안은 AutoSubtitle 화면의 `확인 후 적용` 또는 `자동 수정` 설정을 따른다. 자동 적용은 편집기 변경으로 반영되며 Ctrl+Z로 되돌릴 수 있다.
- AutoSubtitle의 왼쪽 아래 채팅은 MCP 클라이언트가 실제 연결된 동안에만 나타난다. 세션과 현재 자막은 heartbeat로 유지한다.
- `autosub_listen_active_audio`는 열린 편집기의 최대 6초 오디오를 전달한다. 오디오를 직접 이해할 수 있는 모델만 발화와 자막을 대조할 수 있다.
- `itmatzip-AutoSubtitle` MCP 프롬프트는 현재 편집기의 자막을 가져와 교정하고 페이지의 확인 후 적용/자동 수정 설정에 따라 전달하는 작업을 시작한다.

## 클라이언트 설정

먼저 ItMatZip 에이전트를 설치하고 트레이의 AI MCP 설정에서 각 클라이언트의 `MCP 설정`을 누른다. 서버 실행 파일은 설치 폴더를 사용한다.

### Codex CLI / 데스크톱

`%USERPROFILE%\.codex\config.toml`에 추가한다.

```toml
[mcp_servers.itmatzip]
command = 'C:\Program Files\itmatzip-agent\engine\python.exe'
args = ["-c", 'import runpy,sys;sys.path.insert(0,sys.argv[1]);runpy.run_path(sys.argv[2],run_name="__main__")', 'C:\Program Files\itmatzip-agent\agent', 'C:\Program Files\itmatzip-agent\agent\mcp_server.py']
startup_timeout_sec = 15
```

Codex CLI에서는 `codex mcp list`로 등록 여부를 확인한다. 트레이 설정은 `~/.codex/prompts/itmatzip-AutoSubtitle.md`도 등록하며, Codex의 슬래시 목록에는 `/prompts:itmatzip-AutoSubtitle`로 표시된다.

### Claude Code

사용자 전체 프로젝트에 적용하려면 다음 형식으로 등록한다.

```powershell
claude mcp add --scope user --transport stdio itmatzip -- "C:\Program Files\itmatzip-agent\engine\python.exe" -c 'import runpy,sys;sys.path.insert(0,sys.argv[1]);runpy.run_path(sys.argv[2],run_name="__main__")' "C:\Program Files\itmatzip-agent\agent" "C:\Program Files\itmatzip-agent\agent\mcp_server.py"
```

Claude Code는 MCP 프롬프트를 `/itmatzip:itmatzip-AutoSubtitle` 항목으로 표시한다. Claude Desktop의 `claude_desktop_config.json`은 아래 구조를 쓴다.

```json
{
  "mcpServers": {
    "itmatzip": {
      "command": "C:\\Program Files\\itmatzip-agent\\engine\\python.exe",
      "args": ["-c", "import runpy,sys;sys.path.insert(0,sys.argv[1]);runpy.run_path(sys.argv[2],run_name=\"__main__\")", "C:\\Program Files\\itmatzip-agent\\agent", "C:\\Program Files\\itmatzip-agent\\agent\\mcp_server.py"]
    }
  }
}
```

### Google Antigravity

`%USERPROFILE%\.gemini\config\mcp_config.json`의 `mcpServers`에 추가한다. workspace 범위는 `.agents/mcp_config.json`을 사용한다.

```json
{
  "mcpServers": {
    "itmatzip": {
      "command": "C:\\Program Files\\itmatzip-agent\\engine\\python.exe",
      "args": ["-c", "import runpy,sys;sys.path.insert(0,sys.argv[1]);runpy.run_path(sys.argv[2],run_name=\"__main__\")", "C:\\Program Files\\itmatzip-agent\\agent", "C:\\Program Files\\itmatzip-agent\\agent\\mcp_server.py"],
      "timeoutSeconds": 900
    }
  }
}
```

## 페이지 내 채팅

왼쪽 아래 채팅 UI는 Codex/Claude CLI의 현재 대화 세션을 조종하지 않는다. 각 CLI 세션은 클라이언트 소유이기 때문이다. 대신 웹 UI가 로컬 AI 교정 기능을 호출한다. CLI에서 `autosub_get_active_subtitles`로 현재 자막을 가져와 자체 모델로 수정한 뒤 `autosub_submit_active_edits`를 호출하면 열린 화면으로 돌아온다. 확인 모드는 검토 제안을 띄우고, 자동 수정 모드는 즉시 편집기에 반영한다. 자막이 가져온 뒤 바뀌면 오래된 수정안은 차단한다.

CLI에는 자막 텍스트와 단어별 시간/쉼 정보가 제공된다. `autosub_listen_active_audio`는 준비된 PCM 캐시에서 영상 타임라인 기준 최대 6초를 잘라 재인코딩 없이 `audio/wav` 콘텐츠로 반환한다. 오디오 입력을 지원하는 모델은 이 도구로 들은 발음을 자막과 대조할 수 있다. 지원하지 않는 모델은 이 도구의 오디오를 이해하지 못한다. MCP 서버는 음성을 텍스트로 바꾸지 않는다.

현재 설치본을 갱신하려면 관리자 PowerShell에서 저장소의 `agent/deploy_mcp_update.ps1`을 실행한다. 스크립트는 Program Files에 MCP 라우트와 빌드된 웹 앱만 복사하고 FastAPI sidecar를 재시작한 뒤 `/mcp/status` 라우트를 확인한다. 사용자 캐시·모델·오디오 데이터는 지우지 않는다.

## 새 사이트 기능 추가 절차

1. 사이트 기능이 기존 MCP 도구로 충분한지 확인한다.
2. 필요하면 해당 도구의 로컬 API 핸들러와 입력/출력 스키마를 구현한다.
3. 도구가 읽기/쓰기 중 무엇인지 명시하고, 변경은 미리보기와 사용자 적용 단계를 둔다.
4. MCP 프로토콜 테스트와 도구 핸들러 테스트를 거친 뒤 에이전트 배포본을 갱신한다.
5. Codex, Claude, Antigravity에서 각각 연결과 실제 호출을 확인한다.

## 버전 1 안전 경계

- MCP stdio는 클라이언트가 기동한 로컬 프로세스에만 열어 둔다.
- MCP 도구는 loopback 에이전트 API의 허용된 기능만 호출한다.
- API 키를 MCP 응답, 로그, 도구 결과에 포함하지 않는다.
- CLI 수정은 선택 설정에 따라 검토 제안 또는 편집기 자동 반영으로 처리한다. 원본 파일을 직접 덮어쓰지 않는다.
- 클라이언트별 설정과 도구 허용 권한은 각 클라이언트 설정에서 사용자가 관리한다.
