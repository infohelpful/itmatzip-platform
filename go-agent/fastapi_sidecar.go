package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	fastapiValidateMu       sync.Mutex
	fastapiValidatedDir     string
	fastapiValidatedAt      time.Time
	fastapiValidateCacheTTL = 10 * time.Minute
	fastapiStartMu          sync.Mutex
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
	starting            bool
	startAttempts       int
	lastStartError      string
	lastStartAt         time.Time
}

func newFastAPISidecar(port int) *fastapiSidecar {
	return &fastapiSidecar{
		port:    port,
		baseURL: fmt.Sprintf("http://127.0.0.1:%d", port),
	}
}

func validateFastAPIAgent(pythonPath, agentDir string) error {
	fastapiValidateMu.Lock()
	if fastapiValidatedDir == agentDir && time.Since(fastapiValidatedAt) < fastapiValidateCacheTTL {
		fastapiValidateMu.Unlock()
		return nil
	}
	fastapiValidateMu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
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
	fastapiValidateMu.Lock()
	fastapiValidatedDir = agentDir
	fastapiValidatedAt = time.Now()
	fastapiValidateMu.Unlock()
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

func (s *fastapiSidecar) setStartErrorLocked(msg string) {
	s.lastStartError = strings.TrimSpace(msg)
	s.starting = false
	s.ready = false
}

func (s *fastapiSidecar) evaluateHealthPingLocked(pinged bool) bool {
	if pinged {
		s.ready = true
		s.stickyReady = true
		s.healthFailStreak = 0
		s.starting = false
		s.lastStartError = ""
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
	if !s.processRunningLocked() {
		s.ready = false
		s.proxyReadyCached = false
		s.proxyReadyCheckedAt = time.Now()
		return false
	}
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

func (s *fastapiSidecar) HealthSnapshot() map[string]any {
	ready := s.FastapiReadyForHealth()
	s.mu.Lock()
	defer s.mu.Unlock()
	state := "not_started"
	switch {
	case ready:
		state = "ready"
	case s.processRunningLocked():
		if s.starting {
			state = "starting"
		} else {
			state = "warming"
		}
	case s.lastStartError != "":
		state = "failed"
	}
	lastStart := ""
	if !s.lastStartAt.IsZero() {
		lastStart = s.lastStartAt.Format(time.RFC3339)
	}
	stallSec := 0.0
	if !s.lastStartAt.IsZero() && !ready {
		stallSec = time.Since(s.lastStartAt).Seconds()
	}
	return map[string]any{
		"ready":              ready,
		"state":              state,
		"last_error":         s.lastStartError,
		"port":               s.port,
		"process_running":    s.processRunningLocked(),
		"port_listening":     isPortListening(s.port),
		"start_attempts":     s.startAttempts,
		"health_fail_streak": s.healthFailStreak,
		"stall_seconds":      stallSec,
		"last_start_at":      lastStart,
	}
}

func (s *fastapiSidecar) StallDuration() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastStartAt.IsZero() || s.ready {
		return 0
	}
	return time.Since(s.lastStartAt)
}

func isPortListening(port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 250*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func attachSidecarProcessLog(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	logPath := filepath.Join(logsRootPath, "fastapi-sidecar.log")
	fh, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		log.Printf("fastapi sidecar log open failed: %v", err)
		return
	}
	cmd.Stdout = fh
	cmd.Stderr = fh
}

func (s *fastapiSidecar) Start(ctx context.Context, wm *workerManager) error {
	fastapiStartMu.Lock()
	defer fastapiStartMu.Unlock()

	s.mu.Lock()
	s.startAttempts++
	s.lastStartAt = time.Now()
	s.starting = true
	s.lastStartError = ""

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
		s.setStartErrorLocked("agent directory not found (set ITMATZIP_AGENT_DIR)")
		s.mu.Unlock()
		return fmt.Errorf("agent directory not found (set ITMATZIP_AGENT_DIR)")
	}

	pythonPath := resolveFastAPIPython(agentDir)
	s.mu.Unlock()

	s.mu.Lock()
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
		"PYTHONUNBUFFERED=1",
	)
	if isMSIInstallLayout() {
		cmd.Env = append(cmd.Env, "ITMATZIP_DISABLE_AUTO_UPDATE=1")
	}
	attachSidecarProcessLog(cmd)

	if err := cmd.Start(); err != nil {
		cancel()
		s.setStartErrorLocked(fmt.Sprintf("start uvicorn: %v", err))
		s.mu.Unlock()
		return fmt.Errorf("start uvicorn: %w", err)
	}

	s.cmd = cmd
	s.cancel = cancel
	wm.upsertWorker("fastapi", "python-fastapi", cmd.Process.Pid, "running", "")
	log.Printf("fastapi sidecar starting pid=%d port=%d python=%s", cmd.Process.Pid, s.port, pythonPath)

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
		s.starting = false
		if lastError != "" {
			s.lastStartError = lastError
		}
		s.invalidateReadyCacheLocked()
		s.mu.Unlock()
		wm.upsertWorker("fastapi", "python-fastapi", 0, status, lastError)
	}()

	s.mu.Unlock()

	deadline := time.Now().Add(sidecarStartupDeadline)
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if s.pingHealth(sidecarStartupPingTimeout) {
			s.mu.Lock()
			s.ready = true
			s.stickyReady = true
			s.healthFailStreak = 0
			s.starting = false
			s.lastStartError = ""
			s.proxyReadyCached = true
			s.proxyReadyCheckedAt = time.Now()
			s.mu.Unlock()
			log.Printf("fastapi sidecar ready at %s (agent=%s python=%s)", s.baseURL, agentDir, pythonPath)
			return nil
		}
		s.mu.Lock()
		s.healthFailStreak++
		s.mu.Unlock()
		time.Sleep(250 * time.Millisecond)
	}

	s.mu.Lock()
	errMsg := fmt.Sprintf("fastapi sidecar did not become ready on port %d within %s", s.port, sidecarStartupDeadline)
	s.setStartErrorLocked(errMsg)
	s.stopLocked()
	s.mu.Unlock()
	return fmt.Errorf("%s", errMsg)
}

func (s *fastapiSidecar) pingHealth(timeout time.Duration) bool {
	client := &http.Client{Timeout: timeout}
	resp, err := client.Get(s.baseURL + "/health")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return false
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return false
	}
	status, _ := payload["status"].(string)
	if status != "ok" {
		return false
	}
	ver, _ := payload["agent_version"].(string)
	return strings.TrimSpace(ver) != ""
}

func (s *fastapiSidecar) stopLocked() {
	if s.cancel != nil {
		s.cancel()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	s.ready = false
	s.starting = false
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
	return s.checkReadyLocked(false, 1500*time.Millisecond)
}

func (s *fastapiSidecar) FastapiReadyForHealth() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.checkReadyLocked(false, healthReportPingTimeout)
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
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}
			interval := watchdogTickInterval
			if !sidecar.IsReady() {
				interval = watchdogFastTickInterval
			}
			if sidecar.IsReady() {
				time.Sleep(interval)
				continue
			}
			if sidecar.ProcessRunning() {
				if sidecar.IsReady() {
					time.Sleep(interval)
					continue
				}
				stall := sidecar.StallDuration()
				streak := sidecar.HealthFailStreak()
				if stall >= sidecarStallRestart || streak >= watchdogRestartStreak {
					log.Printf("fastapi watchdog: stalled (%s, streak=%d), force restarting…", stall.Round(time.Second), streak)
					if err := sidecar.TryRestart(ctx, wm); err != nil {
						log.Printf("fastapi watchdog force restart failed: %v", err)
					}
					time.Sleep(interval)
					continue
				}
				if stall > 10*time.Second && int(stall.Seconds())%15 < int(interval.Seconds())+1 {
					log.Printf("fastapi watchdog: still starting (%s, streak=%d)…", stall.Round(time.Second), streak)
				}
				time.Sleep(interval)
				continue
			}
			log.Printf("fastapi watchdog: sidecar process not running, restarting…")
			if err := sidecar.TryRestart(ctx, wm); err != nil {
				log.Printf("fastapi watchdog restart failed: %v", err)
			}
			time.Sleep(interval)
		}
	}()
}

func startFastAPISidecarWithRetry(ctx context.Context, sidecar *fastapiSidecar, wm *workerManager) {
	go func() {
		delay := 1 * time.Second
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
				if delay < 15*time.Second {
					delay += 1 * time.Second
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
			snap := s.HealthSnapshot()
			log.Printf("api proxy: sidecar not ready for %s %s (state=%v)", r.Method, r.URL.Path, snap["state"])
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

func handleFastAPIRestart(w http.ResponseWriter, r *http.Request, sidecar *fastapiSidecar, wm *workerManager) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !isLocalAgentRequest(r) {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "localhost only"})
		return
	}
	if sidecar == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": "fastapi sidecar disabled"})
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), sidecarStartupDeadline)
		defer cancel()
		if err := sidecar.TryRestart(ctx, wm); err != nil {
			log.Printf("fastapi manual restart failed: %v", err)
		}
	}()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":      true,
		"message": "FastAPI sidecar restart scheduled",
	})
}
