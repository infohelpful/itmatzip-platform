package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	defaultHost         = "127.0.0.1"
	defaultPort         = 19876
	defaultGRPCPort     = 50051
	defaultFastAPIPort  = 19877
	wsPath              = "/ws"
	healthPath          = "/health"
	statusPath          = "/status"
)

type wsEvent struct {
	Type     string `json:"type"`
	Status   string `json:"status,omitempty"`
	Progress int    `json:"progress,omitempty"`
	Message  string `json:"message,omitempty"`
	Source   string `json:"source,omitempty"`
}

type wsHub struct {
	mu      sync.Mutex
	clients map[*websocket.Conn]struct{}
}

func newHub() *wsHub {
	return &wsHub{clients: make(map[*websocket.Conn]struct{})}
}

func (h *wsHub) broadcast(event wsEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for conn := range h.clients {
		err := conn.WriteJSON(event)
		if err != nil {
			log.Printf("websocket write error: %v", err)
			conn.Close()
			delete(h.clients, conn)
		}
	}
}

func allowWSOrigin(origin string) bool {
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	switch host {
	case "tools.itmatzip.com", "127.0.0.1", "localhost", "::1", "[::1]":
		return true
	}
	return strings.HasSuffix(host, ".localhost")
}

func (h *wsHub) serveWS(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return allowWSOrigin(r.Header.Get("Origin"))
		},
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade ws: %v", err)
		return
	}
	h.mu.Lock()
	h.clients[conn] = struct{}{}
	h.mu.Unlock()
	log.Printf("ws connected: %s", conn.RemoteAddr())

	go func() {
		defer func() {
			conn.Close()
			h.mu.Lock()
			delete(h.clients, conn)
			h.mu.Unlock()
			log.Printf("ws disconnected: %s", conn.RemoteAddr())
		}()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
}

func ensurePaths() error {
	for _, dir := range []string{settingsRootPath, installRootPath, modelsRootPath, logsRootPath} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	ensureDataFolderWritable()
	return nil
}

func setupLogging() {
	logPath := filepath.Join(logsRootPath, "service.log")
	fh, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		log.Printf("warning: could not open log file %s: %v", logPath, err)
		return
	}
	log.SetOutput(fh)
	log.Printf("logging to %s", logPath)
}

func withRecovery(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("HTTP PANIC (%s %s): %v\n%s", r.Method, r.URL.Path, rec, debug.Stack())
				http.Error(w, `{"detail":"internal server error"}`, http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func startHTTPServer(ctx context.Context, hub *wsHub, wm *workerManager, port int, sidecar *fastapiSidecar) error {
	mux := http.NewServeMux()
	mux.HandleFunc(wsPath, hub.serveWS)
	mux.HandleFunc(healthPath, func(w http.ResponseWriter, r *http.Request) {
		payload := map[string]any{
			"status":        "ok",
			"service":       "itmatzip-agent",
			"agent_version": readAgentVersion(),
			"go_controller": true,
			"fastapi_ready": sidecar != nil && sidecar.IsReady(),
		}
		if sidecar != nil && sidecar.IsReady() {
			if faHealth := fetchFastAPIHealth(sidecar.baseURL); faHealth != nil {
				if version, ok := faHealth["agent_version"]; ok {
					payload["agent_version"] = version
				}
				if _, ok := payload["update_available"]; !ok {
					payload["update_available"] = faHealth["update_available"]
				}
				if _, ok := payload["remote_version"]; !ok {
					payload["remote_version"] = faHealth["remote_version"]
				}
				payload["startup_installed"] = faHealth["startup_installed"]
			}
		}
		mergeUpdateHealth(payload)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(payload)
	})
	mux.HandleFunc(statusPath, func(w http.ResponseWriter, r *http.Request) {
		reqCtx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		w.Header().Set("Content-Type", "application/json")
		status := wm.collectStatus(reqCtx)
		if sidecar != nil {
			status["fastapi_port"] = sidecar.port
			status["fastapi_ready"] = sidecar.IsReady()
			status["fastapi_url"] = sidecar.baseURL
		}
		_ = json.NewEncoder(w).Encode(status)
	})
	mux.HandleFunc("/models", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"models": wm.store.List()})
	})
	mux.HandleFunc("/install-model", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			ModelID string `json:"model_id"`
			URL     string `json:"url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "invalid request body"})
			return
		}
		if req.ModelID == "" || req.URL == "" {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "model_id and url are required"})
			return
		}
		if err := wm.runInstallModel(ctx, req.ModelID, req.URL); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"accepted": true, "message": "install started"})
	})

	mux.HandleFunc(serviceRestartPath, handleServiceRestart)
	mux.HandleFunc("/api/agent/pick-local-file", func(w http.ResponseWriter, r *http.Request) {
		handlePickLocalFile(w, r, false, false, false, false)
	})
	mux.HandleFunc("/api/agent/pick-local-audio-file", func(w http.ResponseWriter, r *http.Request) {
		handlePickLocalFile(w, r, true, false, false, false)
	})
	mux.HandleFunc("/api/agent/pick-local-project-file", func(w http.ResponseWriter, r *http.Request) {
		handlePickLocalFile(w, r, false, true, false, false)
	})
	mux.HandleFunc("/api/agent/pick-local-font-file", func(w http.ResponseWriter, r *http.Request) {
		handlePickLocalFile(w, r, false, false, true, false)
	})
	mux.HandleFunc("/api/agent/pick-local-image-file", func(w http.ResponseWriter, r *http.Request) {
		handlePickLocalFile(w, r, false, false, false, true)
	})
	mux.HandleFunc("/api/agent/read-local-image", handleReadLocalImage)
	mountBundledToolsWeb(mux)

	if sidecar != nil {
		apiProxy := sidecar.ProxyHandler()
		mux.Handle("/api/", apiProxy)
		mux.Handle("/ui/", apiProxy)
		log.Printf("proxying /api/* and /ui/* to fastapi sidecar at %s", sidecar.baseURL)
	}
	mux.HandleFunc("/inference", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			ModelID string `json:"model_id"`
			Input   string `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "invalid request body"})
			return
		}
		if req.ModelID == "" {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "model_id is required"})
			return
		}
		if wm.grpcClient == nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "grpc client unavailable"})
			return
		}
		timeout := 30 * time.Second
		switch strings.ToLower(strings.TrimSpace(req.ModelID)) {
		case "mdx_extra_q", "vocal-remover", "vocal_remover":
			timeout = 3700 * time.Second
		}
		reqCtx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		result, err := wm.grpcClient.Predict(reqCtx, req.ModelID, []byte(req.Input))
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	})

	addr := fmt.Sprintf("%s:%d", defaultHost, port)
	srv := &http.Server{
		Addr:         addr,
		Handler:      withRecovery(withCORS(mux)),
		ReadTimeout:  120 * time.Second,
		WriteTimeout: 0,
		IdleTimeout:  300 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	log.Printf("starting http/ws server on %s", addr)
	return srv.ListenAndServe()
}

func runAgent(port int, grpcPort int, fastapiPort int, startGRPC bool, startFastAPI bool) error {
	initPaths()
	if err := ensurePaths(); err != nil {
		return fmt.Errorf("ensure paths: %w", err)
	}
	setupLogging()
	initJobObject()

	grpcAddr := fmt.Sprintf("%s:%d", defaultHost, grpcPort)
	hub := newHub()
	mgr := newWorkerManager(hub, grpcAddr)
	defer mgr.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	initUpdateManager(ctx)

	if startGRPC {
		if err := mgr.startGRPCWorker(ctx); err != nil {
			log.Printf("warning: grpc python worker failed to start: %v", err)
		} else {
			time.Sleep(500 * time.Millisecond)
			if err := mgr.grpcClient.Connect(ctx); err != nil {
				log.Printf("warning: grpc client connect failed: %v", err)
			}
		}
	}

	var sidecar *fastapiSidecar
	if startFastAPI {
		sidecar = newFastAPISidecar(fastapiPort)
		startFastAPISidecarWithRetry(ctx, sidecar, mgr)
		startFastAPISidecarWatchdog(ctx, sidecar, mgr)
	}

	return startHTTPServer(ctx, hub, mgr, port, sidecar)
}

func main() {
	var (
		install     = flag.Bool("install", false, "register tray autostart and launch tray")
		uninstall   = flag.Bool("uninstall", false, "unregister tray autostart")
		checkUpdate = flag.Bool("check-update", false, "check GitHub manifest for MSI update")
		applyUpdate = flag.Bool("apply-update", false, "download and apply MSI update if available")
		trayMode    = flag.Bool("tray", false, "run as tray application (full agent)")
		port        = flag.Int("port", defaultPort, "HTTP/WebSocket port")
		grpcPort    = flag.Int("grpc-port", defaultGRPCPort, "Python gRPC worker port")
		fastapiPort = flag.Int("fastapi-port", defaultFastAPIPort, "FastAPI sidecar port")
		noGRPC      = flag.Bool("no-grpc", false, "skip launching Python gRPC worker")
		noFastAPI   = flag.Bool("no-fastapi", false, "skip launching FastAPI sidecar")
	)
	flag.Parse()

	if *install {
		removeLegacyWindowsService()
		if err := registerTrayAutostart(); err != nil {
			log.Printf("warning: tray autostart register failed: %v", err)
		}
		if err := createLaunchShortcuts(); err != nil {
			log.Printf("warning: create shortcuts failed: %v", err)
		}
		if err := launchTrayProcess(); err != nil {
			log.Printf("warning: start tray after install: %v (reboot or run: itmatzip-agent.exe --tray)", err)
		}
		fmt.Println("agent installed (tray autostart registered)")
		return
	}
	if *uninstall {
		removeLegacyWindowsService()
		if err := unregisterTrayAutostart(); err != nil {
			log.Printf("warning: tray autostart unregister failed: %v", err)
		}
		if err := removeLaunchShortcuts(); err != nil {
			log.Printf("warning: remove shortcuts failed: %v", err)
		}
		fmt.Println("agent uninstalled (tray autostart removed)")
		return
	}
	if *trayMode {
		hideAgentConsole()
		if err := runTray(*port); err != nil {
			log.Fatalf("tray: %v", err)
		}
		return
	}
	if *checkUpdate || *applyUpdate {
		initPaths()
		setupLogging()
		mgr := newUpdateManager()
		snap := mgr.Check(*applyUpdate)
		out, _ := json.MarshalIndent(snap, "", "  ")
		fmt.Println(string(out))
		if snap.LastError != "" && *applyUpdate {
			os.Exit(1)
		}
		return
	}

	startGRPC := !*noGRPC
	startFastAPI := !*noFastAPI
	if err := runAgent(*port, *grpcPort, *fastapiPort, startGRPC, startFastAPI); err != nil && err != http.ErrServerClosed {
		log.Fatalf("agent failed: %v", err)
	}
}

func agentHTTPPortFromRequest(r *http.Request) int {
	if r == nil {
		return defaultPort
	}
	_, portStr, err := net.SplitHostPort(r.Host)
	if err != nil {
		return defaultPort
	}
	if p, err := strconv.Atoi(portStr); err == nil && p > 0 {
		return p
	}
	return defaultPort
}

func handlePickLocalFile(w http.ResponseWriter, r *http.Request, audioOnly bool, projectOnly bool, fontOnly bool, imageOnly bool) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	path, err := pickFileViaUserDialog(audioOnly, projectOnly, fontOnly, imageOnly)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"detail": fmt.Sprintf("파일 대화상자 오류: %v", err),
		})
		return
	}
	if strings.TrimSpace(path) == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"path": "", "cancelled": true})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if imageOnly {
		payload := map[string]any{"path": path}
		if strings.TrimSpace(path) != "" {
			preview := fmt.Sprintf(
				"http://%s:%d/api/agent/read-local-image?path=%s",
				defaultHost,
				agentHTTPPortFromRequest(r),
				url.QueryEscape(path),
			)
			payload["preview_url"] = preview
		}
		_ = json.NewEncoder(w).Encode(payload)
		return
	}
	if fontOnly {
		_ = json.NewEncoder(w).Encode(map[string]any{"path": path})
		return
	}
	if projectOnly {
		_ = json.NewEncoder(w).Encode(map[string]any{"project_path": path})
		return
	}
	if audioOnly {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"audio_path": path,
			"video_path": path,
		})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"video_path": path})
}
