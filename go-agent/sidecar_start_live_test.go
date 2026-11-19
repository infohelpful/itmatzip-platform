//go:build windows

package main

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Live tests against a real engine Python. ITMATZIP_LIVE_SIDECAR_PYTHON=<engine\python.exe>.
func liveSidecarPython(t *testing.T) string {
	py := os.Getenv("ITMATZIP_LIVE_SIDECAR_PYTHON")
	if py == "" {
		t.Skip("set ITMATZIP_LIVE_SIDECAR_PYTHON to an engine python.exe with uvicorn")
	}
	return py
}

func freeTestPort(t *testing.T) int {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

func TestLiveFreeSidecarPortStopsOnlyOurEnginePython(t *testing.T) {
	py := liveSidecarPython(t)

	// 1) A leftover engine python holding the port is stopped.
	port := freeTestPort(t)
	code := "import socket,time;s=socket.socket();s.bind(('127.0.0.1'," + strconv.Itoa(port) + "));s.listen();time.sleep(120)"
	stale := exec.Command(py, "-c", code)
	if err := stale.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stale.Process.Kill() }()
	for i := 0; i < 50 && !isPortListening(port); i++ {
		time.Sleep(100 * time.Millisecond)
	}
	if !isPortListening(port) {
		t.Fatal("stale listener did not start")
	}
	freeSidecarPort(port, py)
	if isPortListening(port) {
		t.Fatal("leftover engine python still holds the port")
	}

	// 2) Any other program on the port (here: this test process) is left alone.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	other := ln.Addr().(*net.TCPAddr).Port
	freeSidecarPort(other, py)
	if !isPortListening(other) {
		t.Fatal("a foreign listener must not be touched")
	}
}

func TestLiveSidecarStartReportsCrashImmediately(t *testing.T) {
	py := liveSidecarPython(t)
	agentDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(agentDir, "main.py"), []byte("raise RuntimeError('boom at startup')\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ITMATZIP_AGENT_DIR", agentDir)
	t.Setenv("ITMATZIP_FASTAPI_PYTHON", py)
	oldLogs := logsRootPath
	logsRootPath = t.TempDir()
	t.Cleanup(func() { logsRootPath = oldLogs })

	s := newFastAPISidecar(freeTestPort(t))
	started := time.Now()
	err := s.Start(context.Background(), &workerManager{})
	took := time.Since(started)
	if err == nil {
		t.Fatal("start must fail")
	}
	if took > 20*time.Second {
		t.Fatalf("crash reported after %s (must not wait for the 180 s deadline)", took)
	}
	if !strings.Contains(err.Error(), "boom at startup") {
		t.Fatalf("error should carry the Python traceback tail, got: %v", err)
	}
	t.Logf("crash reported in %s: %v", took.Round(time.Millisecond), err)
}
