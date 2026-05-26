package main

import (
	"encoding/json"
	"net"
	"net/http"
)

const serviceRestartPath = "/api/agent/service/restart"

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
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":      true,
		"message": "tray mode — use system tray to quit/restart",
	})
}
