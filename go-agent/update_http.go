package main

import (
	"encoding/json"
	"net/http"
)

func updateHTTPHandler(manager *updateManager) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// CORS headers alone do not prevent a cross-site POST from reaching localhost.
		origin := r.Header.Get("Origin")
		if origin == "" || !allowCORSOrigin(origin) {
			http.Error(w, "forbidden origin", http.StatusForbidden)
			return
		}
		if manager == nil {
			http.Error(w, "updater unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(manager.snapshot())
		case http.MethodPost:
			if !isMSIInstallLayout() {
				http.Error(w, "MSI installation required", http.StatusBadRequest)
				return
			}
			if !manager.startUpdateNow() {
				w.WriteHeader(http.StatusConflict)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": "update already running"})
				return
			}
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(map[string]any{"accepted": true})
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
}
