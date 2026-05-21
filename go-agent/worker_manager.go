package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type workerProcess struct {
	id     string
	kind   string
	cmd    *exec.Cmd
	cancel context.CancelFunc
}

type workerManager struct {
	hub        *wsHub
	store      *modelStore
	downloader *modelDownloader
	grpcAddr   string
	grpcClient *grpcWorkerClient

	mu       sync.Mutex
	stdio    *workerProcess
	grpcProc *workerProcess
}

func newWorkerManager(hub *wsHub, grpcAddr string) *workerManager {
	store, err := newModelStore(defaultStateDBPath())
	if err != nil {
		log.Printf("warning: failed to open state db: %v", err)
		store = &modelStore{}
	}
	return &workerManager{
		hub:        hub,
		store:      store,
		downloader: newModelDownloader(hub, store),
		grpcAddr:   grpcAddr,
		grpcClient: newGRPCWorkerClient(grpcAddr),
	}
}

func (wm *workerManager) Close() {
	wm.stopAll()
	if wm.store != nil {
		_ = wm.store.Close()
	}
	if wm.grpcClient != nil {
		_ = wm.grpcClient.Close()
	}
}

func (wm *workerManager) stopAll() {
	wm.mu.Lock()
	defer wm.mu.Unlock()
	if wm.stdio != nil && wm.stdio.cancel != nil {
		wm.stdio.cancel()
	}
	if wm.grpcProc != nil && wm.grpcProc.cancel != nil {
		wm.grpcProc.cancel()
	}
}

func (wm *workerManager) stop() {
	wm.stopAll()
}

func (wm *workerManager) resetWorkers() {
	wm.stopAll()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		wm.mu.Lock()
		busy := wm.stdio != nil || wm.grpcProc != nil
		wm.mu.Unlock()
		if !busy {
			return
		}
		time.Sleep(120 * time.Millisecond)
	}
	wm.mu.Lock()
	wm.stdio = nil
	wm.grpcProc = nil
	wm.mu.Unlock()
}

func (wm *workerManager) startPythonWorker(ctx context.Context) error {
	wm.mu.Lock()
	defer wm.mu.Unlock()
	if wm.stdio != nil {
		return fmt.Errorf("stdio worker already running")
	}

	pythonPath := resolvePythonExecutable()
	workerPath := pythonWorkerScript("worker.py")
	workerDir := filepath.Dir(workerPath)

	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(ctx, pythonPath, filepath.Base(workerPath), "--serve")
	hideExec(cmd)
	cmd.Dir = workerDir
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("ITMATZIP_AGENT_INSTALL_ROOT=%s", installRootPath),
		fmt.Sprintf("ITMATZIP_AGENT_DATA=%s", settingsRootPath),
		fmt.Sprintf("PYTHONPATH=%s", workerDir),
		"PYTHONNOUSERSITE=1",
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return err
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return err
	}

	wm.stdio = &workerProcess{id: "stdio", kind: "python-stdio", cmd: cmd, cancel: cancel}
	wm.upsertWorker("stdio", "python-stdio", cmd.Process.Pid, "running", "")

	go wm.scanWorkerOutput(stdout, "stdout")
	go wm.scanWorkerOutput(stderr, "stderr")
	go wm.waitWorker(wm.stdio)

	wm.hub.broadcast(wsEvent{Type: "worker", Status: "started", Message: "Python stdio worker launched", Source: "python"})
	return nil
}

func (wm *workerManager) startGRPCWorker(ctx context.Context) error {
	wm.mu.Lock()
	if wm.grpcProc != nil {
		wm.mu.Unlock()
		return fmt.Errorf("grpc worker already running")
	}

	pythonPath := resolvePythonExecutable()
	workerPath := pythonWorkerScript("worker_grpc.py")
	workerDir := filepath.Dir(workerPath)
	log.Printf("starting grpc worker: python=%s script=%s bind=%s", pythonPath, workerPath, wm.grpcAddr)

	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(ctx, pythonPath, filepath.Base(workerPath), "--bind", wm.grpcAddr)
	hideExec(cmd)
	cmd.Dir = workerDir
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("ITMATZIP_AGENT_INSTALL_ROOT=%s", installRootPath),
		fmt.Sprintf("ITMATZIP_AGENT_DATA=%s", settingsRootPath),
		fmt.Sprintf("PYTHONPATH=%s", workerDir),
		"PYTHONNOUSERSITE=1",
	)
	if agentDir, ok := resolveAgentDir(); ok {
		cmd.Env = append(cmd.Env, fmt.Sprintf("ITMATZIP_AGENT_DIR=%s", agentDir))
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		wm.mu.Unlock()
		return err
	}
	if err := cmd.Start(); err != nil {
		cancel()
		wm.mu.Unlock()
		return err
	}

	wm.grpcProc = &workerProcess{id: "grpc", kind: "python-grpc", cmd: cmd, cancel: cancel}
	wm.upsertWorker("grpc", "python-grpc", cmd.Process.Pid, "running", "")
	wm.mu.Unlock()

	go wm.scanWorkerOutput(stderr, "python-grpc")
	go wm.waitWorker(wm.grpcProc)
	wm.hub.broadcast(wsEvent{Type: "worker", Status: "started", Message: "Python gRPC worker launched", Source: "python-grpc"})

	return wm.waitGRPCWorkerAlive(45 * time.Second)
}

func (wm *workerManager) grpcWorkerAliveLocked() bool {
	if wm.grpcProc == nil || wm.grpcProc.cmd == nil || wm.grpcProc.cmd.Process == nil {
		return false
	}
	return wm.grpcProc.cmd.ProcessState == nil
}

func (wm *workerManager) grpcWorkerAlive() bool {
	wm.mu.Lock()
	defer wm.mu.Unlock()
	return wm.grpcWorkerAliveLocked()
}

func (wm *workerManager) waitGRPCWorkerAlive(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		wm.mu.Lock()
		alive := wm.grpcWorkerAliveLocked()
		wm.mu.Unlock()
		if alive {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("gRPC worker exited before ready (port %s may be in use by another process)", wm.grpcAddr)
}

func (wm *workerManager) waitWorker(proc *workerProcess) {
	err := proc.cmd.Wait()
	status := "stopped"
	lastError := ""
	if err != nil {
		status = "failed"
		lastError = err.Error()
		log.Printf("%s worker exit error: %v", proc.kind, err)
		wm.hub.broadcast(wsEvent{Type: "worker", Status: status, Message: lastError, Source: proc.kind})
	} else {
		log.Printf("%s worker stopped cleanly", proc.kind)
		wm.hub.broadcast(wsEvent{Type: "worker", Status: status, Message: "clean exit", Source: proc.kind})
	}
	wm.upsertWorker(proc.id, proc.kind, 0, status, lastError)

	wm.mu.Lock()
	defer wm.mu.Unlock()
	if wm.stdio == proc {
		wm.stdio = nil
	}
	if wm.grpcProc == proc {
		wm.grpcProc = nil
	}
}

func (wm *workerManager) runInstallModel(ctx context.Context, modelID string, modelURL string) error {
	if wm.downloader == nil {
		return fmt.Errorf("model downloader is not initialized")
	}
	if modelID == "" || modelURL == "" {
		return fmt.Errorf("modelID and modelURL are required")
	}

	wm.hub.broadcast(wsEvent{Type: "install", Status: "started", Message: "Model install started", Source: "go"})
	go func() {
		if err := wm.downloader.DownloadModel(ctx, modelID, modelURL); err != nil {
			log.Printf("download model failed: %v", err)
			if wm.store != nil && wm.store.db != nil {
				_ = wm.store.db.RecordDownload(modelID, modelURL, "failed", err.Error(), 0, 0)
			}
			wm.hub.broadcast(wsEvent{Type: "install", Status: "failed", Message: err.Error(), Source: "go"})
			return
		}
		wm.hub.broadcast(wsEvent{Type: "install", Status: "completed", Message: "Model download complete", Source: "go"})
	}()
	return nil
}

func (wm *workerManager) scanWorkerOutput(pipe io.ReadCloser, source string) {
	scanner := bufio.NewScanner(pipe)
	for scanner.Scan() {
		line := scanner.Text()
		var event wsEvent
		if err := json.Unmarshal([]byte(line), &event); err == nil && event.Type != "" {
			event.Source = source
			wm.hub.broadcast(event)
			continue
		}
		log.Printf("%s: %s", source, line)
		wm.hub.broadcast(wsEvent{Type: "log", Message: line, Source: source})
	}
	if err := scanner.Err(); err != nil {
		log.Printf("scan worker output error: %v", err)
	}
}

func (wm *workerManager) collectStatus(ctx context.Context) map[string]any {
	status := map[string]any{
		"install_root":  installRootPath,
		"data_root":     settingsRootPath,
		"models_root":   modelsRootPath,
		"grpc_addr":     wm.grpcAddr,
		"models":        wm.store.List(),
		"workers":       []WorkerRecord{},
		"grpc_health":   nil,
		"grpc_status":   nil,
		"grpc_error":    "",
	}

	if wm.store != nil && wm.store.db != nil {
		if workers, err := wm.store.db.ListWorkers(); err == nil {
			status["workers"] = workers
		}
	}

	if wm.grpcClient != nil {
		health, err := wm.grpcClient.Health(ctx)
		if err != nil {
			status["grpc_error"] = err.Error()
		} else {
			status["grpc_health"] = health
		}
		workerStatus, err := wm.grpcClient.Status(ctx)
		if err == nil {
			status["grpc_status"] = workerStatus
			if msg, ok := workerStatus["worker_status"].(string); ok {
				if !strings.Contains(strings.ToLower(msg), strings.ToLower(installRootPath)) {
					status["grpc_error"] = fmt.Sprintf(
						"gRPC worker install_root mismatch (expected %s, got %q)",
						installRootPath, msg,
					)
					status["grpc_health"] = nil
				}
			}
		}
		if !wm.grpcWorkerAlive() && status["grpc_health"] != nil {
			status["grpc_error"] = fmt.Sprintf(
				"gRPC worker process not running; port %s may be held by a stale worker",
				wm.grpcAddr,
			)
			status["grpc_health"] = nil
		}
	}

	return status
}

func (wm *workerManager) upsertWorker(id, kind string, pid int, status, lastError string) {
	if wm.store != nil && wm.store.db != nil {
		_ = wm.store.db.UpsertWorker(id, kind, pid, status, lastError)
	}
}
