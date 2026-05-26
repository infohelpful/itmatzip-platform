//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/sys/windows"
	"golang.org/x/text/encoding/korean"
	"golang.org/x/text/transform"
)

const fileDialogBrokerAddr = "127.0.0.1:19879"

type pickDialogRequest struct {
	AudioOnly   bool `json:"audio_only"`
	ProjectOnly bool `json:"project_only"`
}

type pickDialogResponse struct {
	OK    bool   `json:"ok"`
	Path  string `json:"path,omitempty"`
	Error string `json:"error,omitempty"`
}

type fileDialogBrokerHealth struct {
	OK        bool   `json:"ok"`
	Broker    string `json:"broker"`
	SessionID uint32 `json:"session_id"`
}

var fileDialogBrokerServer *http.Server

func currentProcessSessionID() (uint32, error) {
	var sid uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &sid); err != nil {
		return 0, err
	}
	return sid, nil
}

func brokerSessionIsInteractive(sessionID uint32) bool {
	if sessionID == 0 {
		return false
	}
	activeSid, ok := activeConsoleSessionID()
	if !ok {
		return sessionID != 0
	}
	return sessionID == activeSid
}

func getFileDialogBrokerHealth() (fileDialogBrokerHealth, error) {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://" + fileDialogBrokerAddr + "/health")
	if err != nil {
		return fileDialogBrokerHealth{}, err
	}
	defer resp.Body.Close()
	var health fileDialogBrokerHealth
	if err := json.NewDecoder(resp.Body).Decode(&health); err != nil {
		return fileDialogBrokerHealth{}, err
	}
	return health, nil
}

func isFileDialogBrokerReadyInUserSession() bool {
	if !isFileDialogBrokerListening() {
		return false
	}
	health, err := getFileDialogBrokerHealth()
	if err != nil || !health.OK {
		return false
	}
	if health.SessionID == 0 {
		// Legacy /health without session_id: reject only when this service process hosts the broker.
		sid, err := currentProcessSessionID()
		if err == nil && sid == 0 {
			return fileDialogBrokerServer == nil
		}
		return true
	}
	return brokerSessionIsInteractive(health.SessionID)
}

func waitForUserSessionBroker(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if isFileDialogBrokerReadyInUserSession() {
			return true
		}
		time.Sleep(200 * time.Millisecond)
	}
	return isFileDialogBrokerReadyInUserSession()
}

func stopWrongSessionFileDialogBrokerIfOwned() {
	if isFileDialogBrokerReadyInUserSession() {
		return
	}
	if !isFileDialogBrokerListening() {
		return
	}
	if fileDialogBrokerServer != nil {
		log.Printf("file-dialog broker: stopping non-interactive in-process broker (session 0)")
		stopFileDialogBroker()
		time.Sleep(300 * time.Millisecond)
	}
}

func startFileDialogBroker() error {
	if fileDialogBrokerServer != nil {
		return nil
	}
	sid, err := currentProcessSessionID()
	if err != nil {
		return fmt.Errorf("current session id: %w", err)
	}
	if !brokerSessionIsInteractive(sid) {
		return fmt.Errorf("file dialog broker requires interactive user session (current=%d)", sid)
	}
	ln, err := net.Listen("tcp", fileDialogBrokerAddr)
	if err != nil {
		if isFileDialogBrokerReadyInUserSession() {
			return nil
		}
		return fmt.Errorf("listen broker %s: %w", fileDialogBrokerAddr, err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		healthSid, _ := currentProcessSessionID()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":         true,
			"broker":     "file-dialog",
			"session_id": healthSid,
		})
	})
	mux.HandleFunc("/pick", handleFileDialogBrokerPick)
	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	fileDialogBrokerServer = srv
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("file-dialog broker stopped: %v", err)
		}
	}()
	log.Printf("file-dialog broker ready at http://%s/pick", fileDialogBrokerAddr)
	return nil
}

func handleFileDialogBrokerPick(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req pickDialogRequest
	_ = json.NewDecoder(r.Body).Decode(&req)
	path, err := pickFileViaUserDialog(req.AudioOnly, req.ProjectOnly)
	resp := pickDialogResponse{OK: err == nil, Path: path}
	if err != nil {
		resp.Error = err.Error()
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(resp)
}

func stopFileDialogBroker() {
	if fileDialogBrokerServer == nil {
		return
	}
	_ = fileDialogBrokerServer.Close()
	fileDialogBrokerServer = nil
}

func runFileDialogBrokerOnly() error {
	initPaths()
	hideAgentConsole()
	if err := startFileDialogBroker(); err != nil {
		if isFileDialogBrokerReadyInUserSession() {
			return nil
		}
		return err
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	stopFileDialogBroker()
	return nil
}

func isFileDialogBrokerListening() bool {
	conn, err := net.DialTimeout("tcp", fileDialogBrokerAddr, 400*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func waitFileDialogBrokerListening(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if isFileDialogBrokerListening() {
			return true
		}
		time.Sleep(200 * time.Millisecond)
	}
	return isFileDialogBrokerListening()
}

// ensureFileDialogBrokerReady — 브로커(19879)가 없을 때 기동.
// 현재 프로세스가 이미 interactive 세션이면 in-process로 시작하고,
// 서비스(Session 0)인 경우에만 CreateProcessAsUser를 시도한다.
func ensureFileDialogBrokerReady(timeout time.Duration) error {
	if isFileDialogBrokerReadyInUserSession() {
		return nil
	}
	stopWrongSessionFileDialogBrokerIfOwned()
	if isFileDialogBrokerReadyInUserSession() {
		return nil
	}

	// 현재 프로세스가 interactive 세션이면 직접 broker 시작 (CreateProcessAsUser 불필요)
	sid, sidErr := currentProcessSessionID()
	if sidErr == nil && brokerSessionIsInteractive(sid) {
		if err := startFileDialogBroker(); err != nil {
			log.Printf("file-dialog broker in-process start failed: %v", err)
		} else {
			time.Sleep(100 * time.Millisecond)
			if isFileDialogBrokerReadyInUserSession() {
				return nil
			}
		}
	}

	// Session 0 (서비스)인 경우에만 새 프로세스 생성 시도
	if err := launchAgentModeInActiveUserSession("--broker"); err != nil {
		return fmt.Errorf("파일 대화상자 브로커를 사용자 세션에서 시작하지 못했습니다: %w", err)
	}
	if waitForUserSessionBroker(timeout) {
		return nil
	}
	if isFileDialogBrokerListening() {
		return fmt.Errorf(
			"파일 대화상자가 사용자 화면에 표시되지 않는 시스템 세션에서 실행 중입니다. ItMatZip Agent 서비스를 재시작한 뒤, 작업 표시줄 트레이 아이콘이 있는지 확인하세요",
		)
	}
	return fmt.Errorf(
		"파일 대화상자 브로커(127.0.0.1:19879)가 준비되지 않았습니다. 작업 표시줄에서 ItMatZip Agent 트레이를 실행한 뒤 다시 시도하세요",
	)
}

func requestFileDialogBroker(audioOnly bool, projectOnly bool, timeout time.Duration) (string, error) {
	body, _ := json.Marshal(pickDialogRequest{AudioOnly: audioOnly, ProjectOnly: projectOnly})
	client := &http.Client{Timeout: timeout}
	req, _ := http.NewRequest(http.MethodPost, "http://"+fileDialogBrokerAddr+"/pick", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("파일 대화상자 브로커 연결 실패: %w", err)
	}
	defer resp.Body.Close()
	var out pickDialogResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("파일 대화상자 브로커 응답 파싱 실패: %w", err)
	}
	if !out.OK {
		if out.Error == "" {
			out.Error = "파일 선택 실행 실패"
		}
		return "", fmt.Errorf(out.Error)
	}
	return strings.TrimSpace(out.Path), nil
}

func pickFileViaUserDialog(audioOnly bool, projectOnly bool) (string, error) {
	title := "ItMatZip — 미디어 파일 선택"
	filter := "동영상 파일 (*.mp4;*.mov;*.mkv;*.webm;*.avi;*.m4v)|*.mp4;*.mov;*.mkv;*.webm;*.avi;*.m4v|오디오/동영상 (*.mp4;*.mov;*.mkv;*.webm;*.avi;*.m4a;*.wav;*.mp3;*.aac;*.flac)|*.mp4;*.mov;*.mkv;*.webm;*.avi;*.m4a;*.wav;*.mp3;*.aac;*.flac|모든 파일 (*.*)|*.*"
	if projectOnly {
		title = "ItMatZip — 프로젝트 불러오기"
		filter = "Auto Subtitle 프로젝트 (*.autosub;*.json)|*.autosub;*.json|모든 파일 (*.*)|*.*"
	} else if audioOnly {
		title = "ItMatZip — 오디오 파일 선택"
		filter = "오디오 파일 (*.wav;*.mp3;*.flac;*.m4a;*.aac;*.ogg;*.wma;*.opus)|*.wav;*.mp3;*.flac;*.m4a;*.aac;*.ogg;*.wma;*.opus|모든 파일 (*.*)|*.*"
	}
	psExe := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	ps := "$ErrorActionPreference='Stop'; " +
		"Add-Type -AssemblyName System.Windows.Forms; " +
		"[System.Windows.Forms.Application]::EnableVisualStyles(); " +
		"Add-Type -Name WinAPI -Namespace User32 -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();'; " +
		"$owner=New-Object System.Windows.Forms.Form -Property @{TopMost=$true;ShowInTaskbar=$false;Width=0;Height=0;StartPosition='Manual';Location=New-Object System.Drawing.Point(-32000,-32000)}; " +
		"$owner.Show(); $owner.Activate(); $owner.BringToFront(); " +
		"[User32.WinAPI]::SetForegroundWindow($owner.Handle)|Out-Null; " +
		"$dlg=New-Object System.Windows.Forms.OpenFileDialog; " +
		"$dlg.Title='" + psDialogQuote(title) + "'; " +
		"$dlg.Filter='" + psDialogQuote(filter) + "'; " +
		"$dlg.CheckFileExists=$true; $dlg.Multiselect=$false; " +
		"$result=$dlg.ShowDialog($owner); " +
		"$owner.Close(); " +
		"$path=''; if($result -eq [System.Windows.Forms.DialogResult]::OK -and $dlg.FileName){$path=$dlg.FileName}; " +
		"[Console]::Out.WriteLine((@{path=$path}|ConvertTo-Json -Compress))"

	cmd := exec.Command(psExe, "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-STA", "-Command", ps)
	hidePickDialogHostExec(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("네이티브 파일 대화상자 실행 실패: %v", err)
	}
	line := lastNonEmptyLine(decodePickProcessOutput(out))
	if line == "" {
		return "", fmt.Errorf("네이티브 파일 대화상자 출력이 비어 있습니다")
	}
	var payload struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal([]byte(line), &payload); err != nil {
		return "", fmt.Errorf("네이티브 파일 대화상자 응답 파싱 실패: %w", err)
	}
	return strings.TrimSpace(payload.Path), nil
}

func hidePickDialogHostExec(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
}

func psDialogQuote(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}

func decodePickProcessOutput(raw []byte) string {
	b := bytes.TrimSpace(raw)
	if len(b) == 0 {
		return ""
	}
	if s, ok := decodeUTF16LEBytes(b); ok {
		return strings.TrimSpace(s)
	}
	if len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
		b = b[3:]
	}
	if utf8.Valid(b) {
		return strings.TrimSpace(string(b))
	}
	if dec, _, err := transform.Bytes(korean.EUCKR.NewDecoder(), b); err == nil && utf8.Valid(dec) {
		return strings.TrimSpace(string(dec))
	}
	return strings.TrimSpace(string(b))
}

func decodeUTF16LEBytes(b []byte) (string, bool) {
	if len(b) < 2 || len(b)%2 != 0 {
		return "", false
	}
	nulls := 0
	for i := 1; i < len(b); i += 2 {
		if b[i] == 0 {
			nulls++
		}
	}
	if nulls < len(b)/4 {
		return "", false
	}
	u := make([]uint16, len(b)/2)
	for i := range u {
		u[i] = uint16(b[2*i]) | uint16(b[2*i+1])<<8
	}
	out := string(utf16.Decode(u))
	if !utf8.ValidString(out) {
		return "", false
	}
	return out, true
}

func lastNonEmptyLine(s string) string {
	lines := strings.Split(s, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(strings.TrimRight(lines[i], "\r"))
		if line != "" {
			return line
		}
	}
	return strings.TrimSpace(s)
}
