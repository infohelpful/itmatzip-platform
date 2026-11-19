//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCompleteLoginURLSkipsLocalhostAndPartialURLs(t *testing.T) {
	out := "Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?response_type=code&client_id=app_X&state=abc\n"
	if got := completeLoginURL(out); got != "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_X&state=abc" {
		t.Fatalf("got %q", got)
	}
	if got := completeLoginURL("visit https://auth.openai.com/oauth/auth"); got != "" {
		t.Fatalf("URL at end of buffer may be cut off, got %q", got)
	}
	if got := completeLoginURL("\x1b[1mhttps://claude.ai/oauth/authorize?code=true\x1b[0m\n"); got != "https://claude.ai/oauth/authorize?code=true" {
		t.Fatalf("ANSI-wrapped URL: got %q", got)
	}
}

// npm's cmd-shim, as npm 11 writes it for global CLIs such as codex.cmd.
const npmCmdShim = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\n" +
	"IF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n" +
	"endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\fakecli\\cli.js\" %*\r\n"

// Runs a fake npm-installed CLI (cmd shim -> node) that prints a login URL and keeps waiting for the
// callback like `codex login`; the URL must be captured and opened while the CLI is still running.
func TestStartAILoginCapturesURLFromNpmShimCLI(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "node_modules", "fakecli"), 0o755); err != nil {
		t.Fatal(err)
	}
	js := "console.log('Starting local login server on http://localhost:1455.');\n" +
		"console.log('If your browser did not open, navigate to this URL to authenticate:');\n" +
		"console.log('');\n" +
		"console.log('https://auth.example.com/oauth/authorize?state=' + process.argv[2]);\n" +
		"setTimeout(() => {}, 60000);\n"
	if err := os.WriteFile(filepath.Join(dir, "node_modules", "fakecli", "cli.js"), []byte(js), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "fakelogin.cmd"), []byte(npmCmdShim), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	var opened []string
	old := openLoginURL
	openLoginURL = func(u string) error { opened = append(opened, u); return nil }
	t.Cleanup(func() { openLoginURL = old })

	url, err := startAILogin("fakelogin", "xyz")
	if err != nil {
		t.Fatal(err)
	}
	want := "https://auth.example.com/oauth/authorize?state=xyz"
	if url != want || len(opened) != 1 || opened[0] != want {
		t.Fatalf("url=%q opened=%v, want %q opened once", url, opened, want)
	}
	// A second click while the CLI still waits for the callback reopens the same page.
	if again, err := startAILogin("fakelogin", "xyz"); err != nil || again != want {
		t.Fatalf("second click: %q %v", again, err)
	}
	aiLoginMu.Lock()
	s := aiLoginRunning["fakelogin"]
	aiLoginMu.Unlock()
	if s == nil {
		t.Fatal("session not tracked")
	}
	if !strings.HasPrefix(url, "https://") {
		t.Fatal("must be https")
	}
}
