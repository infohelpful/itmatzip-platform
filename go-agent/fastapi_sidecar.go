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
	"sync"
	"time"
)

type fastapiSidecar struct {
	mu                  sync.Mutex
	port                int
	baseURL             string
	cmd                 *exec.Cmd
	cancel              context.CancelFunc
	ready               bool
	stickyReady         bool
	healthFailStreak    int
	proxyReadyCached    bool
	proxyReadyCheckedAt time.Time
}

func newFastAPISidecar(port int) *fastapiSidecar {
	return &fastapiSidecar{
		port:    port,
		baseURL: fmt.Sprintf("http://127.0.0.1:%d", port),
	}
}

func validateFastAPIAgent(pythonPath, agentDir string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	// MSI embedded python은 PYTHONPATH를 무시하므로 sys.path에 agentDir을 넣어 검증한다.
	importCheck := fmt.Sprintf("import sys; sys.path.insert(0, %q); import main", agentDir)
	cmd := exec.CommandContext(ctx, pythonPath, "-c", importCheck)
	cmd.Dir = agentDir
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("PYTHONPATH=%s", prependPathEnv(os.Getenv("PYTHONPATH"), agentDir)),
		"PYTHONNOUSERSITE=1",
	)
	hideExec(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		tail := string(out)
		if len(tail) > 1200 {
			tail = tail[len(tail)-1200:]
		}
		return fmt.Errorf("agent import check failed: %w: %s", err, tail)
	}
	return nil
}

func (s *fastapiSidecar) processRunningLocked() bool {
	return s.cmd != nil && s.cmd.Process != nil && s.cmd.ProcessState == nil
}

func (s *fastapiSidecar) ProcessRunning() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.processRunningLocked()
}

func (s *fastapiSidecar) HealthFailStreak() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.healthFailStreak
}

func (s *fastapiSidecar) invalidateReadyCacheLocked() {
	s.proxyReadyCheckedAt = time.Time{}
	s.proxyReadyCached = false
}

func (s *fastapiSidecar) evaluateHealthPingLocked(pinged bool) bool {
	if pinged {
		s.ready = true
		s.stickyReady = true
		s.healthFailStreak = 0
		return true
	}
	s.healthFailStreak++
	if s.processRunningLocked() && s.stickyReady && s.healthFailStreak < healthStickyMaxStreak {
		return true
	}
	s.ready = false
	return false
}

func (s *fastapiSidecar) checkReadyLocked(forcePing bool, pingTimeout time.Duration) bool {
	if !forcePing && time.Since(s.proxyReadyCheckedAt) < proxyReadyCacheTTL {
		return s.proxyReadyCached
	}
	if !forcePing && s.processRunningLocked() && s.stickyReady && s.healthFailStreak < healthStickyMaxStreak {
		s.proxyReadyCached = true
		s.proxyReadyCheckedAt = time.Now()
		return true
	}
	s.mu.Unlock()
	pinged := s.pingHealth(pingTimeout)
	s.mu.Lock()
	ready := s.evaluateHealthPingLocked(pinged)
	s.proxyReadyCached = ready
	s.proxyReadyCheckedAt = time.Now()
	return ready
}

func (s *fastapiSidecar) Start(ctx context.Context, wm *workerManager) error {
	s.mu.Lock()

	if s.cmd != nil && s.cmd.Process != nil && s.cmd.ProcessState == nil {
		s.stopLocked()
		time.Sleep(300 * time.Millisecond)
	}
	s.cmd = nil
	s.cancel = nil
	s.ready = false
	s.stickyReady = false
	s.healthFailStreak = 0
	s.invalidateReadyCacheLocked()

	agentDir, ok := resolveAgentDir()
	if !ok {
		s.mu.Unlock()
		return fmt.Errorf("agent directory not found (set ITMATZIP_AGENT_DIR)")
	}

	pythonPath := resolveFastAPIPython(agentDir)
	if err := validateFastAPIAgent(pythonPath, agentDir); err != nil {
		s.mu.Unlock()
		return err
	}

	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(
		ctx,
		pythonPath,
		"-m", "uvicorn",
		"main:app",
		"--app-dir", agentDir,
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
		s.mu.Unlock()
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
		s.mu.Lock()
		s.ready = false
		s.stickyReady = false
		s.healthFailStreak = 0
		s.invalidateReadyCacheLocked()
		s.mu.Unlock()
		wm.upsertWorker("fastapi", "python-fastapi", 0, status, lastError)
	}()

	s.mu.Unlock()

	deadline := time.Now().Add(120 * time.Second)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if s.pingHealth(2500 * time.Millisecond) {
			s.mu.Lock()
			s.ready = true
			s.stickyReady = true
			s.healthFailStreak = 0
			s.proxyReadyCached = true
			s.proxyReadyCheckedAt = time.Now()
			s.mu.Unlock()
			log.Printf("fastapi sidecar ready at %s (agent=%s python=%s)", s.baseURL, agentDir, pythonPath)
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}

	s.mu.Lock()
	s.stopLocked()
	s.mu.Unlock()
	return fmt.Errorf("fastapi sidecar did not become ready on port %d", s.port)
}

func (s *fastapiSidecar) pingHealth(timeout time.Duration) bool {
	client := &http.Client{Timeout: timeout}
	resp, err := client.Get(s.baseURL + "/health")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func (s *fastapiSidecar) stopLocked() {
	if s.cancel != nil {
		s.cancel()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	s.ready = false
	s.invalidateReadyCacheLocked()
}

func (s *fastapiSidecar) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopLocked()
	s.stickyReady = false
	s.healthFailStreak = 0
}

func (s *fastapiSidecar) IsReady() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.checkReadyLocked(false, 3500*time.Millisecond)
}

func (s *fastapiSidecar) ProxyReady() bool {
	if !s.mu.TryLock() {
		return s.proxyReadyCached
	}
	defer s.mu.Unlock()
	if !s.processRunningLocked() {
		s.proxyReadyCached = false
		s.proxyReadyCheckedAt = time.Now()
		return false
	}
	return s.checkReadyLocked(false, 1500*time.Millisecond)
}

func (s *fastapiSidecar) TryRestart(ctx context.Context, wm *workerManager) error {
	if s.IsReady() {
		return nil
	}
	s.Stop()
	time.Sleep(400 * time.Millisecond)
	return s.Start(ctx, wm)
}

func startFastAPISidecarWatchdog(ctx context.Context, sidecar *fastapiSidecar, wm *workerManager) {
	if sidecar == nil {
		return
	}
	go func() {
		ticker := time.NewTicker(watchdogTickInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if sidecar.IsReady() {
					continue
				}
				running := sidecar.ProcessRunning()
				streak := sidecar.HealthFailStreak()
				if running && streak < watchdogBusyMinStreak {
					log.Printf("fastapi watchdog: sidecar busy or slow (streak=%d), waiting…", streak)
					continue
				}
				log.Printf("fastapi watchdog: sidecar not ready (running=%v streak=%d), restarting…", running, streak)
				if err := sidecar.TryRestart(ctx, wm); err != nil {
					log.Printf("fastapi watchdog restart failed: %v", err)
				}
			}
		}
	}()
}

func startFastAPISidecarWithRetry(ctx context.Context, sidecar *fastapiSidecar, wm *workerManager) {
	go func() {
		delay := 3 * time.Second
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}
			if sidecar.IsReady() {
				return
			}
			if err := sidecar.Start(ctx, wm); err != nil {
				log.Printf("fastapi sidecar start failed, retry in %s: %v", delay, err)
				select {
				case <-ctx.Done():
					return
				case <-time.After(delay):
				}
				if delay < 30*time.Second {
					delay += 2 * time.Second
				}
				continue
			}
			return
		}
	}()
}

func (s *fastapiSidecar) ProxyHandler() http.Handler {
	target, err := url.Parse(s.baseURL)
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "invalid proxy target", http.StatusInternalServerError)
		})
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = newFastAPIProxyTransport()
	proxy.ModifyResponse = func(resp *http.Response) error {
		stripUpstreamCORS(resp.Header)
		log.Printf("api proxy response: %s %s → %d", resp.Request.Method, resp.Request.URL.Path, resp.StatusCode)
		return nil
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("api proxy error (%s %s): %v", r.Method, r.URL.Path, err)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Connection", "close")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"detail":"FastAPI sidecar unavailable","phase":"not_started","progress":0}`))
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.ProxyReady() {
			log.Printf("api proxy: sidecar not ready for %s %s", r.Method, r.URL.Path)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"detail":"FastAPI sidecar not ready","phase":"not_started","progress":0}`))
			return
		}
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("api proxy panic (%s %s): %v", r.Method, r.URL.Path, rec)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadGateway)
				_, _ = w.Write([]byte(`{"detail":"proxy internal error"}`))
			}
		}()
		proxy.ServeHTTP(w, r)
	})
}

func fetchFastAPIHealth(baseURL string) map[string]any {
	client := &http.Client{Timeout: 3500 * time.Millisecond}
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
