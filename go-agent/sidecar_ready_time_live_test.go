//go:build windows

package main

import (
	"context"
	"os"
	"testing"
	"time"
)

// Live: time from Start() to the real sidecar answering /health.
// ITMATZIP_LIVE_SIDECAR_PYTHON + ITMATZIP_LIVE_SIDECAR_AGENT_DIR.
func TestLiveSidecarReadyTime(t *testing.T) {
	py := liveSidecarPython(t)
	dir := os.Getenv("ITMATZIP_LIVE_SIDECAR_AGENT_DIR")
	if dir == "" {
		t.Skip("set ITMATZIP_LIVE_SIDECAR_AGENT_DIR")
	}
	t.Setenv("ITMATZIP_AGENT_DIR", dir)
	t.Setenv("ITMATZIP_FASTAPI_PYTHON", py)
	oldLogs := logsRootPath
	logsRootPath = t.TempDir()
	t.Cleanup(func() { logsRootPath = oldLogs })
	s := newFastAPISidecar(freeTestPort(t))
	started := time.Now()
	if err := s.Start(context.Background(), &workerManager{}); err != nil {
		t.Fatal(err)
	}
	t.Logf("sidecar ready in %s", time.Since(started).Round(time.Millisecond))
	s.Stop()
}
