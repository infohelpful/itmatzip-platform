//go:build windows

package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Live: the Antigravity login window must stay open (agy running in it). ITMATZIP_LIVE_AGY=1.
func TestLiveAntigravityLoginWindowStaysOpen(t *testing.T) {
	if os.Getenv("ITMATZIP_LIVE_AGY") != "1" || aiToolPath("agy") == "" {
		t.Skip("set ITMATZIP_LIVE_AGY=1 (needs agy)")
	}
	if err := startAntigravityLoginWindow(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(3 * time.Second)
	out, _ := exec.Command("powershell", "-NoProfile", "-Command",
		"$w=Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | ? { $_.CommandLine -like '*Antigravity*' }; "+
			"if($w){ 'WINDOW_ALIVE'; Get-CimInstance Win32_Process | ? { $_.ParentProcessId -eq $w.ProcessId } | % { 'CHILD ' + $_.Name }; "+
			"Start-Process taskkill -ArgumentList '/T','/F','/PID',$w.ProcessId -WindowStyle Hidden -Wait }").CombinedOutput()
	t.Logf("%s", strings.TrimSpace(string(out)))
	if !strings.Contains(string(out), "WINDOW_ALIVE") || !strings.Contains(strings.ToLower(string(out)), "child agy.exe") {
		t.Fatal("Antigravity window closed or agy not running in it")
	}
}
