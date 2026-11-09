//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAIClientDetectionWithoutInstallerPATH(t *testing.T) {
	// MSI-launched trays can inherit a PATH with only system directories.
	systemRoot := os.Getenv("SystemRoot")
	if systemRoot == "" {
		t.Fatal("SystemRoot is unavailable")
	}
	profile := t.TempDir()
	t.Setenv("USERPROFILE", profile)
	t.Setenv("LOCALAPPDATA", filepath.Join(profile, "AppData", "Local"))
	t.Setenv("APPDATA", filepath.Join(profile, "AppData", "Roaming"))
	t.Setenv("PATH", systemRoot+`\System32;`+systemRoot+`\System32\WindowsPowerShell\v1.0`)
	bin := filepath.Join(profile, ".local", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, client := range []struct{ id, command string }{{"codex", "codex"}, {"claude", "claude"}, {"antigravity", "agy"}} {
		if err := os.WriteFile(filepath.Join(bin, client.command+".cmd"), []byte("@echo off\r\necho version 1.0\r\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Run(client.id, func(t *testing.T) {
			if path := aiToolPath(client.command); path == "" {
				t.Fatalf("%s executable not resolved", client.command)
			}
			if !aiCLIInstalled(client.id) {
				t.Fatalf("%s --version did not run", client.command)
			}
		})
	}
	if err := os.WriteFile(filepath.Join(bin, "claude.cmd"), []byte("@echo off\r\nexit /b 1\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if aiCLIInstalled("claude") {
		t.Fatal("a CLI that fails --version must not be marked installed")
	}
}

func TestMCPListMatchesServerNameOnly(t *testing.T) {
	if mcpListContains("unrelated C:\\Projects\\itmatzip\\mcp_server.py", "itmatzip") {
		t.Fatal("matched a path instead of a server name")
	}
	for _, output := range []string{"itmatzip    python.exe", "itmatzip: python.exe"} {
		if !mcpListContains(output, "itmatzip") {
			t.Fatalf("server missing from %q", strings.TrimSpace(output))
		}
	}
}
