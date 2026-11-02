package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// Auto Subtitle (web) only needs the native media picker from the controller; media preparation,
// preview and export now live in the FastAPI engine (agent/routers/autosub.py, /api/tools/auto-subtitle/v2).
func mountAutoSubtitleMediaRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/agent/pick-local-subtitle-media", handlePickLocalSubtitleMedia)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// Dialog -> UTF-8 absolute path ({"video_path": ...} or {"path": "", "cancelled": true}).
func handlePickLocalSubtitleMedia(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"detail":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if !isCurrentProcessInteractive() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"detail": "파일 선택 창을 띄울 수 없습니다. 작업 표시줄에서 ItMatZip Agent 트레이를 실행한 뒤 다시 시도하세요.",
		})
		return
	}
	path, err := pickFileViaUserDialog(false, false, false, false)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"detail": fmt.Sprintf("파일 대화상자 오류: %v", err),
		})
		return
	}
	if strings.TrimSpace(path) == "" {
		writeJSON(w, http.StatusOK, map[string]any{"path": "", "cancelled": true})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"video_path": path})
}
