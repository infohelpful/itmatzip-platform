//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Live: opens a real console window that runs a script and closes itself. ITMATZIP_LIVE_TERMINAL=1.
func TestLiveLoginTerminalOpensVisibleWindow(t *testing.T) {
	if os.Getenv("ITMATZIP_LIVE_TERMINAL") != "1" {
		t.Skip("set ITMATZIP_LIVE_TERMINAL=1")
	}
	dir := t.TempDir()
	marker := filepath.Join(dir, "ran.txt")
	script := filepath.Join(dir, "fakecli.cmd")
	body := "@echo %* > \"" + marker + "\"\r\n@where node >> \"" + marker + "\" 2>&1\r\n@exit\r\n"
	if err := os.WriteFile(script, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	if err := startAICommandInTerminal("테스트 로그인", "fakecli", "login", "--x"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(marker); err == nil && len(b) > 0 {
			if !strings.Contains(string(b), "login --x") {
				t.Fatalf("args not passed: %q", b)
			}
			t.Logf("terminal ran: %q", strings.TrimSpace(string(b)))
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("terminal command did not run")
}
