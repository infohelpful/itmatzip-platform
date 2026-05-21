package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"time"
)

type fastapiSidecar struct {
	port    int
	baseURL string
	cmd     *exec.Cmd
	cancel  context.CancelFunc
	ready   bool
}

func newFastAPISidecar(port int) *fastapiSidecar {
	return &fastapiSidecar{
		port:    port,
		baseURL: fmt.Sprintf("http://127.0.0.1:%d", port),
	}
}

func (s *fastapiSidecar) Start(ctx context.Context, wm *workerManager) error {
	if s.cmd != nil && s.cmd.Process != nil && s.cmd.ProcessState == nil {
		s.Stop()
		time.Sleep(300 * time.Millisecond)
	}
	s.cmd = nil
	s.cancel = nil
	s.ready = false

	agentDir, ok := resolveAgentDir()
	if !ok {
		return fmt.Errorf("agent directory not found (set ITMATZIP_AGENT_DIR)")
	}

	pythonPath := resolveFastAPIPython(agentDir)
	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(
		ctx,
		pythonPath,
		"-m", "uvicorn",
		"main:app",
		"--host", defaultHost,
		"--port", strconv.Itoa(s.port),
		"--log-level", "warning",
	)
	hideExec(cmd)
	cmd.Dir = agentDir
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("ITMATZIP_AGENT_INSTALL_ROOT=%s", installRootPath),
		fmt.Sprintf("ITMATZIP_AGENT_DATA=%s", settingsRootPath),
		fmt.Sprintf("ITMATZIP_AGENT_DIR=%s", agentDir),
		fmt.Sprintf("PYTHONPATH=%s", prependPathEnv(os.Getenv("PYTHONPATH"), agentDir)),
		"ITMATZIP_BEHIND_GO_PROXY=1",
		"PYTHONNOUSERSITE=1",
	)
	if isMSIInstallLayout() {
		cmd.Env = append(cmd.Env, "ITMATZIP_DISABLE_AUTO_UPDATE=1")
	}

	if err := cmd.Start(); err != nil {
		cancel()
		return fmt.Errorf("start uvicorn: %w", err)
	}

	s.cmd = cmd
	s.cancel = cancel
	wm.upsertWorker("fastapi", "python-fastapi", cmd.Process.Pid, "running", "")

	go func() {
		err := cmd.Wait()
		status := "stopped"
		lastError := ""
		if err != nil {
			status = "failed"
			lastError = err.Error()
			log.Printf("fastapi sidecar exit: %v", err)
		}
		s.ready = false
		wm.upsertWorker("fastapi", "python-fastapi", 0, status, lastError)
	}()

	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if s.pingHealth() {
			s.ready = true
			log.Printf("fastapi sidecar ready at %s (agent=%s python=%s)", s.baseURL, agentDir, pythonPath)
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}

	cancel()
	return fmt.Errorf("fastapi sidecar did not become ready on port %d", s.port)
}

func (s *fastapiSidecar) pingHealth() bool {
	client := &http.Client{Timeout: 800 * time.Millisecond}
	resp, err := client.Get(s.baseURL + "/health")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func (s *fastapiSidecar) Stop() {
	if s.cancel != nil {
		s.cancel()
	}
	s.ready = false
}

func (s *fastapiSidecar) IsReady() bool {
	if s.ready {
		return true
	}
	// 자식 프로세스가 비정상 종료돼도 포트에 uvicorn이 남아 있으면 프록시 가능
	return s.pingHealth()
}

func (s *fastapiSidecar) ProxyHandler() http.Handler {
	target, err := url.Parse(s.baseURL)
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "invalid proxy target", http.StatusInternalServerError)
		})
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ModifyResponse = func(resp *http.Response) error {
		stripUpstreamCORS(resp.Header)
		return nil
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("api proxy error: %v", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"detail":"FastAPI sidecar unavailable"}`))
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.IsReady() {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"detail":"FastAPI sidecar not ready"}`))
			return
		}
		proxy.ServeHTTP(w, r)
	})
}

func fetchFastAPIHealth(baseURL string) map[string]any {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(baseURL + "/health")
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var payload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil
	}
	return payload
}
