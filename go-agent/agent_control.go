package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"
)

const serviceRestartPath = "/api/agent/service/restart"

var serviceProgramMu sync.RWMutex
var serviceProgram *program

func registerServiceProgram(p *program) {
	serviceProgramMu.Lock()
	serviceProgram = p
	serviceProgramMu.Unlock()
}

func getServiceProgram() *program {
	serviceProgramMu.RLock()
	defer serviceProgramMu.RUnlock()
	return serviceProgram
}

func isLocalAgentRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	switch host {
	case "127.0.0.1", "::1", "localhost", "[::1]":
		return true
	}
	return false
}

func handleServiceRestart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !isLocalAgentRequest(r) {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "localhost only"})
		return
	}

	p := getServiceProgram()
	if p == nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "agent service not active"})
		return
	}

	go func() {
		if err := p.reloadAgents(); err != nil {
			log.Printf("service reload failed: %v", err)
		}
	}()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":      true,
		"message": "agent reload started",
	})
}

func restartAgentViaHTTP(port int, clientTimeout time.Duration) error {
	url := fmt.Sprintf("http://%s:%d%s", defaultHost, port, serviceRestartPath)
	client := &http.Client{Timeout: clientTimeout}
	resp, err := client.Post(url, "application/json", nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusAccepted {
		return fmt.Errorf("reload HTTP %d", resp.StatusCode)
	}
	return nil
}
