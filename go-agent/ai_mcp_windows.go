//go:build windows

package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/sys/windows/registry"
)

type aiClientState struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Installed  bool   `json:"installed"`
	LoggedIn   bool   `json:"loggedIn"`
	LoginKnown bool   `json:"loginKnown"`
	Configured bool   `json:"configured"`
	Note       string `json:"note"`
}

//go:embed installer/itmatzip-AutoSubtitle.md
var codexAutoSubtitlePrompt string

func codexAutoSubtitlePromptPath() string {
	return filepath.Join(os.Getenv("USERPROFILE"), ".codex", "prompts", "itmatzip-AutoSubtitle.md")
}

func codexAutoSubtitlePromptPresent() bool {
	data, err := os.ReadFile(codexAutoSubtitlePromptPath())
	return err == nil && string(data) == codexAutoSubtitlePrompt
}

func installCodexAutoSubtitlePrompt() error {
	path := codexAutoSubtitlePromptPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("Codex 자막 명령 폴더 생성 실패: %w", err)
	}
	if data, err := os.ReadFile(path); err == nil && string(data) != codexAutoSubtitlePrompt && !strings.Contains(string(data), "autosub_get_active_subtitles") {
		return fmt.Errorf("기존 Codex 명령과 이름이 겹칩니다: %s", path)
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.WriteFile(path, []byte(codexAutoSubtitlePrompt), 0o644); err != nil {
		return fmt.Errorf("Codex 자막 명령 등록 실패: %w", err)
	}
	return nil
}

func aiToolPath(name string) string {
	if path, err := exec.LookPath(name); err == nil {
		return path
	}
	// A tray started by Windows Installer inherits the installer's PATH, which often
	// omits CLIs installed for the signed-in user. Resolve their executable, then
	// let --version decide whether it is actually installed and runnable.
	filenames := []string{name + ".exe", name + ".cmd"}
	for _, root := range []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE} {
		for _, filename := range filenames {
			key, err := registry.OpenKey(root, `Software\Microsoft\Windows\CurrentVersion\App Paths\`+filename, registry.QUERY_VALUE)
			if err != nil {
				continue
			}
			path, _, err := key.GetStringValue("")
			key.Close()
			if err == nil && aiCommandFileExists(path) {
				return path
			}
		}
	}
	profile := os.Getenv("USERPROFILE")
	local := os.Getenv("LOCALAPPDATA")
	appData := os.Getenv("APPDATA")
	var candidates []string
	for _, dir := range []string{filepath.Join(profile, ".local", "bin"), filepath.Join(appData, "npm"), filepath.Join(local, "agy", "bin"), filepath.Join(local, "Programs", "OpenAI", "Codex", "bin"), filepath.Join(os.Getenv("ProgramFiles"), "nodejs")} {
		for _, filename := range filenames {
			candidates = append(candidates, filepath.Join(dir, filename))
		}
	}
	if name == "codex" {
		matches, _ := filepath.Glob(filepath.Join(local, "OpenAI", "Codex", "bin", "*", "codex.exe"))
		sort.Slice(matches, func(i, j int) bool {
			a, ea := os.Stat(matches[i])
			b, eb := os.Stat(matches[j])
			return ea == nil && (eb != nil || a.ModTime().After(b.ModTime()))
		})
		candidates = append(matches, candidates...)
	}
	for _, path := range candidates {
		if aiCommandFileExists(path) {
			return path
		}
	}
	return ""
}

func aiCommandFileExists(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func runAICommand(name string, args ...string) ([]byte, error) {
	cmd, err := newAICommand(name, args...)
	if err != nil {
		return nil, err
	}
	return cmd.CombinedOutput()
}

func newAICommand(name string, args ...string) (*exec.Cmd, error) {
	path := aiToolPath(name)
	if path == "" {
		return nil, fmt.Errorf("%s CLI를 찾을 수 없습니다", name)
	}
	var cmd *exec.Cmd
	if strings.EqualFold(filepath.Ext(path), ".cmd") || strings.EqualFold(filepath.Ext(path), ".bat") {
		cmd = exec.Command("cmd.exe", append([]string{"/d", "/c", "call", path}, args...)...)
	} else {
		cmd = exec.Command(path, args...)
	}
	// Codex CLI needs an explicit home in GUI-launched processes that lack HOME.
	cmd.Env = append(os.Environ(), "PATH="+filepath.Dir(path)+string(os.PathListSeparator)+os.Getenv("PATH"))
	if name == "npm" {
		if node := aiToolPath("node"); node != "" {
			cmd.Env = append(cmd.Env, "PATH="+filepath.Dir(node)+string(os.PathListSeparator)+filepath.Dir(path)+string(os.PathListSeparator)+os.Getenv("PATH"))
		}
	}
	if home := os.Getenv("USERPROFILE"); home != "" && name == "codex" {
		cmd.Env = append(cmd.Env, "HOME="+home, "CODEX_HOME="+filepath.Join(home, ".codex"))
	}
	hideExec(cmd)
	return cmd, nil
}

func mcpServerCommand() (string, []string, error) {
	python := filepath.Join(installRootPath, "engine", "python.exe")
	script := filepath.Join(installRootPath, "agent", "mcp_server.py")
	agentDir := filepath.Join(installRootPath, "agent")
	if _, err := os.Stat(python); err != nil {
		return "", nil, fmt.Errorf("설치된 Python 실행 파일을 찾지 못했습니다")
	}
	if _, err := os.Stat(script); err != nil {
		return "", nil, fmt.Errorf("설치된 MCP 서버 파일을 찾지 못했습니다")
	}
	// The bundled embeddable Python uses python312._pth and does not add the
	// script directory to sys.path. Bootstrap explicitly so agent_config imports.
	bootstrap := `import runpy,sys;sys.path.insert(0,sys.argv[1]);runpy.run_path(sys.argv[2],run_name="__main__")`
	return python, []string{"-c", bootstrap, agentDir, script}, nil
}

func aiMCPStatus() []aiClientState {
	clients := []aiClientState{
		{ID: "codex", Name: "Codex", Note: "Codex CLI 명령 결과로 설치·로그인·MCP 상태를 확인합니다."},
		{ID: "claude", Name: "Claude", Note: "Claude Code 명령 결과로 설치·로그인·MCP 상태를 확인합니다."},
		{ID: "antigravity", Name: "Antigravity", Note: "agy CLI 명령 결과로 설치와 MCP 상태를 확인합니다."},
	}
	for i := range clients {
		clients[i].Installed = aiCLIInstalled(clients[i].ID)
		clients[i].Configured = clients[i].Installed && aiMCPConfigMatches(clients[i].ID)
		if clients[i].ID == "codex" {
			clients[i].Configured = clients[i].Configured && codexAutoSubtitlePromptPresent()
		}
		if clients[i].Installed {
			clients[i].LoggedIn, clients[i].LoginKnown = aiClientLoggedIn(clients[i].ID)
		}
		if !clients[i].Installed {
			clients[i].Note = "설치되지 않았습니다."
		}
	}
	return clients
}

func aiCLIInstalled(id string) bool {
	name := map[string]string{"codex": "codex", "claude": "claude", "antigravity": "agy"}[id]
	if name == "" || aiToolPath(name) == "" {
		return false
	}
	out, err := runAICommand(name, "--version")
	return err == nil && strings.TrimSpace(string(out)) != ""
}

func aiClientLoggedIn(id string) (bool, bool) {
	if id == "codex" {
		out, err := runAICommand("codex", "login", "status")
		return err == nil && strings.Contains(strings.ToLower(string(out)), "logged in"), true
	}
	switch id {
	case "claude":
		out, err := runAICommand("claude", "auth", "status")
		if err != nil {
			return false, true
		}
		var status struct {
			LoggedIn bool `json:"loggedIn"`
		}
		if json.Unmarshal(out, &status) != nil {
			return false, false
		}
		return status.LoggedIn, true
	case "antigravity":
		// agy currently has no auth-status subcommand; don't guess from local files.
		return false, false
	}
	return false, false
}

func aiMCPConfigPresent(id string) bool {
	switch id {
	case "codex":
		out, err := runAICommand("codex", "mcp", "list")
		return err == nil && mcpListContains(string(out), "itmatzip")
	case "claude":
		out, _ := runAICommand("claude", "mcp", "list")
		return mcpListContains(string(out), "itmatzip")
	case "antigravity":
		out, err := runAICommand("agy", "mcp", "list")
		return err == nil && mcpListContains(string(out), "itmatzip")
	}
	return false
}

func aiMCPConfigMatches(id string) bool {
	command, args, err := mcpServerCommand()
	if err != nil || !aiMCPConfigPresent(id) {
		return false
	}
	var out []byte
	switch id {
	case "codex":
		out, err = runAICommand("codex", "mcp", "get", "itmatzip")
	case "claude":
		out, err = runAICommand("claude", "mcp", "get", "itmatzip")
	case "antigravity":
		out, err = runAICommand("agy", "mcp", "list")
	default:
		return false
	}
	if err != nil {
		return false
	}
	output := string(out)
	if !strings.Contains(strings.ToLower(output), strings.ToLower(command)) {
		return false
	}
	for _, arg := range args {
		if !strings.Contains(output, arg) {
			return false
		}
	}
	return true
}

func mcpListContains(output, serverName string) bool {
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) > 0 && strings.EqualFold(strings.Trim(fields[0], "|* `:"), serverName) {
			return true
		}
	}
	return false
}

func configureAIMCP(id string) error {
	command, args, err := mcpServerCommand()
	if err != nil {
		return err
	}
	switch id {
	case "codex":
		if aiToolPath("codex") == "" {
			return fmt.Errorf("Codex CLI를 먼저 설치하세요")
		}
		if aiMCPConfigPresent(id) {
			if out, e := runAICommand("codex", "mcp", "remove", "itmatzip"); e != nil {
				return fmt.Errorf("기존 Codex MCP 정리 실패: %s", strings.TrimSpace(string(out)))
			}
		}
		if out, e := runAICommand("codex", append([]string{"mcp", "add", "itmatzip", "--", command}, args...)...); e != nil {
			return fmt.Errorf("Codex MCP 등록 실패: %s", strings.TrimSpace(string(out)))
		}
		if err := installCodexAutoSubtitlePrompt(); err != nil {
			return err
		}
	case "claude":
		if aiToolPath("claude") == "" {
			return fmt.Errorf("Claude Code를 먼저 설치하세요")
		}
		if aiMCPConfigPresent(id) {
			if out, e := runAICommand("claude", "mcp", "remove", "--scope", "user", "itmatzip"); e != nil {
				return fmt.Errorf("기존 Claude MCP 정리 실패: %s", strings.TrimSpace(string(out)))
			}
		}
		if out, e := runAICommand("claude", append([]string{"mcp", "add", "--scope", "user", "--transport", "stdio", "itmatzip", "--", command}, args...)...); e != nil {
			return fmt.Errorf("Claude MCP 등록 실패: %s", strings.TrimSpace(string(out)))
		}
	case "antigravity":
		if aiToolPath("agy") == "" {
			return fmt.Errorf("Antigravity CLI를 찾을 수 없습니다")
		}
		if aiMCPConfigPresent(id) {
			if out, e := runAICommand("agy", "mcp", "remove", "itmatzip"); e != nil {
				return fmt.Errorf("기존 Antigravity MCP 정리 실패: %s", strings.TrimSpace(string(out)))
			}
		}
		if out, e := runAICommand("agy", append([]string{"mcp", "add", "itmatzip", "--", command}, args...)...); e != nil {
			return fmt.Errorf("Antigravity MCP 등록 실패: %s", strings.TrimSpace(string(out)))
		}
	default:
		return fmt.Errorf("지원하지 않는 AI 항목입니다")
	}
	return nil
}

func launchAIMCPAction(id, action string) error {
	if action == "configure" {
		return configureAIMCP(id)
	}
	switch id {
	case "codex":
		if action == "install" {
			return startPackageInstall("@openai/codex")
		}
		if action == "login" {
			return startAICommandHidden("codex", "login")
		}
	case "claude":
		if action == "install" {
			return startPackageInstall("@anthropic-ai/claude-code")
		}
		if action == "login" {
			return startAICommandHidden("claude", "auth", "login")
		}
	case "antigravity":
		if action == "install" {
			return startAntigravityCLIInstall()
		}
		if action == "login" {
			return startAICommandHidden("agy")
		}
	}
	return fmt.Errorf("알 수 없는 작업입니다")
}

func startPackageInstall(pkg string) error {
	if aiToolPath("npm") == "" {
		return fmt.Errorf("Node.js와 npm을 먼저 설치한 뒤 다시 눌러주세요")
	}
	out, err := runAICommand("npm", "install", "-g", pkg)
	if err != nil {
		return fmt.Errorf("설치 실패: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

func startAntigravityCLIInstall() error {
	command := "irm https://antigravity.google/cli/install.ps1 | iex"
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command)
	hideExec(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("Antigravity CLI 설치 실패: %s", strings.TrimSpace(string(out)))
	}
	return nil
}
func startAICommandHidden(name string, args ...string) error {
	cmd, err := newAICommand(name, args...)
	if err != nil {
		return err
	}
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func mountAIMCPSettings(mux *http.ServeMux) {
	mux.HandleFunc("/settings/ai-mcp", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", 405)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(aiMCPSettingsHTML))
	})
	mux.HandleFunc("/api/agent/ai-mcp", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		origin := r.Header.Get("Origin")
		if origin != "" && !allowLocalAIMCPOrigin(origin) {
			http.Error(w, "local settings page required", http.StatusForbidden)
			return
		}
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{"clients": aiMCPStatus()})
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		var req struct {
			ID     string `json:"id"`
			Action string `json:"action"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
			http.Error(w, "invalid request", 400)
			return
		}
		if err := launchAIMCPAction(req.ID, req.Action); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "clients": aiMCPStatus()})
	})
}

func allowLocalAIMCPOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

const aiMCPSettingsHTML = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AI MCP 설정</title><style>body{font:15px Segoe UI,sans-serif;background:#111827;color:#f3f4f6;margin:0;padding:32px}main{max-width:820px;margin:auto}h1{font-size:25px}.sub{color:#9ca3af}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin-top:24px}.card{background:#1f2937;border:1px solid #374151;border-radius:12px;padding:18px}.row{display:flex;justify-content:space-between;align-items:center}button{background:#2563eb;color:white;border:0;border-radius:7px;padding:9px 12px;cursor:pointer;margin:8px 5px 0 0}button.secondary{background:#374151}.state{color:#a7f3d0}.note{min-height:38px;color:#9ca3af;font-size:13px}.msg{margin-top:20px;color:#fde68a}</style><main><h1>AI MCP 설정</h1><p class="sub">각 AI 앱의 설치, 로그인, ItMatZip MCP 연결을 설정합니다. 로그인은 새 터미널 또는 앱에서 직접 완료하세요.</p><div id="cards" class="grid"></div><div id="msg" class="msg"></div></main><script>
async function refresh(){let d=await fetch('/api/agent/ai-mcp').then(r=>r.json());document.querySelector('#cards').innerHTML=d.clients.map(c=>'<section class="card"><div class="row"><b>'+c.name+'</b><span class="state">'+(c.installed?'설치됨':'미설치')+'</span></div><p class="note">'+c.note+'</p><div>'+(c.installed?'':'<button onclick="act(\''+c.id+'\',\'install\')">설치</button>')+(c.installed&&(!c.loginKnown||!c.loggedIn)?'<button class="secondary" onclick="act(\''+c.id+'\',\'login\')">로그인</button>':'')+(c.installed?'<button onclick="act(\''+c.id+'\',\'configure\')">'+(c.configured?'MCP 다시 설정':'MCP 설정')+'</button>':'')+'</div><p class="note">로그인: '+(c.loginKnown?(c.loggedIn?'로그인됨':'로그인 안 됨'):'CLI에서 확인 불가')+'</p><p class="note">MCP: '+(c.configured?'연결 설정됨':'설정되지 않음')+'</p></section>').join('')}
async function act(id,action){let m=document.querySelector('#msg');m.textContent='처리 중…';try{let r=await fetch('/api/agent/ai-mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,action})}),d=await r.json();if(!r.ok)throw Error(d.error||'작업 실패');m.textContent=action==='install'?'설치를 완료했습니다.':action==='login'?'브라우저에서 로그인을 완료하세요.':'MCP 등록을 설치된 에이전트 경로로 갱신했습니다. AI 앱을 완전히 종료한 뒤 다시 켜세요.';await refresh()}catch(e){m.textContent=e.message}}
refresh();setInterval(refresh,15000);
</script></html>`
