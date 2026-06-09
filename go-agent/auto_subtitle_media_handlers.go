package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func mountAutoSubtitleMediaRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/tools/auto-subtitle/media/probe", handleAutoSubtitleMediaProbe)
	mux.HandleFunc("/api/tools/auto-subtitle/media/prepare-for-whisper", handleAutoSubtitlePrepareForWhisper)
	mux.HandleFunc("/api/tools/auto-subtitle/export/plain-burn-in", handleAutoSubtitlePlainBurnIn)
}

type mediaPathBody struct {
	VideoPath string `json:"video_path"`
	JobDir    string `json:"job_dir,omitempty"`
}

type plainBurnInBody struct {
	VideoPath  string `json:"video_path"`
	SrtPath    string `json:"srt_path"`
	OutputPath string `json:"output_path,omitempty"`
}

func readJSONBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	if r.Method != http.MethodPost {
		http.Error(w, `{"detail":"method not allowed"}`, http.StatusMethodNotAllowed)
		return false
	}
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		http.Error(w, `{"detail":"invalid request body"}`, http.StatusBadRequest)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func validateReadableMediaPath(raw string) (string, error) {
	p := strings.TrimSpace(raw)
	if p == "" {
		return "", errMediaPathEmpty
	}
	clean := filepath.Clean(p)
	info, err := os.Stat(clean)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", errMediaPathIsDir
	}
	return clean, nil
}

var (
	errMediaPathEmpty = os.ErrInvalid
	errMediaPathIsDir = os.ErrInvalid
)

func handleAutoSubtitleMediaProbe(w http.ResponseWriter, r *http.Request) {
	var body mediaPathBody
	if !readJSONBody(w, r, &body) {
		return
	}
	path, err := validateReadableMediaPath(body.VideoPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"ok":    false,
			"error": "file not found: " + strings.TrimSpace(body.VideoPath),
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	contract, err := ProbeMediaTiming(ctx, path)
	if err != nil && contract == nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	status := http.StatusOK
	if contract != nil && !contract.Ok {
		status = http.StatusUnprocessableEntity
	}
	writeJSON(w, status, contract)
}

func handleAutoSubtitlePrepareForWhisper(w http.ResponseWriter, r *http.Request) {
	var body mediaPathBody
	if !readJSONBody(w, r, &body) {
		return
	}
	path, err := validateReadableMediaPath(body.VideoPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "file not found"})
		return
	}

	jobDir := strings.TrimSpace(body.JobDir)
	if jobDir == "" {
		jobDir = filepath.Join(autoSubtitleWorkspaceRoot(), "prep-"+time.Now().Format("20060102-150405.000"))
	}
	jobDir = filepath.Clean(jobDir)
	if !strings.HasPrefix(strings.ToLower(jobDir), strings.ToLower(autoSubtitleWorkspaceRoot())) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "job_dir must be under auto-subtitle workspace"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 35*time.Minute)
	defer cancel()

	contract, err := PrepareMediaForWhisper(ctx, path, jobDir)
	if err != nil && (contract == nil || !contract.Ok) {
		status := http.StatusInternalServerError
		if contract != nil && contract.Error != "" {
			writeJSON(w, status, contract)
			return
		}
		writeJSON(w, status, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, contract)
}

func handleAutoSubtitlePlainBurnIn(w http.ResponseWriter, r *http.Request) {
	var body plainBurnInBody
	if !readJSONBody(w, r, &body) {
		return
	}
	videoPath, err := validateReadableMediaPath(body.VideoPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "video not found"})
		return
	}
	srtPath, err := validateReadableMediaPath(body.SrtPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "srt not found"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Hour)
	defer cancel()

	probe, err := ProbeMediaTiming(ctx, videoPath)
	if err != nil || probe == nil || !probe.Ok {
		msg := "probe failed"
		if probe != nil && probe.Error != "" {
			msg = probe.Error
		} else if err != nil {
			msg = err.Error()
		}
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": msg})
		return
	}

	outputPath := strings.TrimSpace(body.OutputPath)
	if outputPath == "" {
		outputPath = filepath.Join(autoSubtitleWorkspaceRoot(), "export-"+time.Now().Format("20060102-150405.000"), filepath.Base(videoPath)+"_subtitled.mp4")
	}
	outputPath = filepath.Clean(outputPath)

	mp, err := NewMediaProcessor()
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if err := mp.ExportPlainBurnInVideo(ctx, videoPath, srtPath, outputPath, probe); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"output_path": outputPath,
		"media_timing": probe,
	})
}
