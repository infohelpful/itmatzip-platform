package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func mountAutoSubtitleMediaRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/tools/auto-subtitle/media/probe", handleAutoSubtitleMediaProbe)
	mux.HandleFunc("/api/tools/auto-subtitle/media/prepare-for-whisper", handleAutoSubtitlePrepareForWhisper)
	mux.HandleFunc("/api/tools/auto-subtitle/media/prepare-preview", handleAutoSubtitlePreparePreview)
	mux.HandleFunc("/api/tools/auto-subtitle/media/resolve-preview", handleAutoSubtitleResolvePreview)
	mux.HandleFunc("/api/tools/auto-subtitle/export/plain-burn-in", handleAutoSubtitlePlainBurnIn) // deprecated: use Python V41 export
	mux.HandleFunc("/api/agent/pick-local-subtitle-media", handlePickLocalSubtitleMedia)
	mux.HandleFunc("/api/agent/last-media-paths", handleAgentLastMediaPaths)
	mux.HandleFunc("/api/agent/prepare-preview-last", handleAgentPreparePreviewLast)
	mux.HandleFunc("/api/agent/resolve-preview-media", handleAgentResolvePreviewMedia)
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
	return resolveReadableMediaPath(raw)
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
		if contract, pyErr := probeMediaTimingViaPython(body.VideoPath); pyErr == nil && contract != nil {
			status := http.StatusOK
			if okVal, _ := contract["ok"].(bool); !okVal {
				status = http.StatusOK
			}
			writeJSON(w, status, contract)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":          false,
			"error":       "file not found: " + strings.TrimSpace(body.VideoPath),
			"source_path": strings.TrimSpace(body.VideoPath),
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

func handleAutoSubtitlePreparePreview(w http.ResponseWriter, r *http.Request) {
	var body mediaPathBody
	if !readJSONBody(w, r, &body) {
		return
	}
	rawPath := strings.TrimSpace(body.VideoPath)
	if rawPath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"ok":    false,
			"error": "video_path is required",
		})
		return
	}
	setMediaPathSessionSource(rawPath)

	payload, err := runPreparePreviewPython(rawPath)
	if err != nil {
		tail := err.Error()
		if len(tail) > 2000 {
			tail = tail[len(tail)-2000:]
		}
		log.Printf("prepare-preview python failed: %s", tail)
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"ok":          false,
			"error":       tail,
			"source_path": rawPath,
		})
		return
	}

	if okVal, _ := payload["ok"].(bool); okVal {
		if pmp, _ := payload["preview_media_path"].(string); strings.TrimSpace(pmp) != "" {
			setMediaPathSessionPreview(pmp)
		}
	}

	status := http.StatusOK
	if okVal, _ := payload["ok"].(bool); !okVal {
		status = http.StatusUnprocessableEntity
	}
	writeJSON(w, status, payload)
}

// Auto Subtitle 전용: 대화상자 → UTF-8 경로 session + video_path (CFR·media_timing 없음).
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
	setMediaPathSessionSource(path)
	writeJSON(w, http.StatusOK, map[string]any{"video_path": path})
}

func handleAgentLastMediaPaths(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		http.Error(w, `{"detail":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	src, preview := getMediaPathSession()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":                 src != "" || preview != "",
		"video_path":         src,
		"preview_media_path": preview,
	})
}

func handleAgentPreparePreviewLast(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"detail":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	src, _ := getMediaPathSession()
	src = strings.TrimSpace(src)
	if src == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"ok":    false,
			"error": "last picked media path is empty",
		})
		return
	}
	payload, err := runPreparePreviewPython(src)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"ok":          false,
			"error":       err.Error(),
			"source_path": src,
		})
		return
	}
	if okVal, _ := payload["ok"].(bool); okVal {
		if pmp, _ := payload["preview_media_path"].(string); strings.TrimSpace(pmp) != "" {
			setMediaPathSessionPreview(pmp)
		}
	}
	status := http.StatusOK
	if okVal, _ := payload["ok"].(bool); !okVal {
		status = http.StatusUnprocessableEntity
	}
	writeJSON(w, status, payload)
}

func handleAgentResolvePreviewMedia(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"detail":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	resolvePreviewMediaSSOT(w, "")
}

type resolvePreviewBody struct {
	VideoPath string `json:"video_path"`
}

func handleAutoSubtitleResolvePreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"detail":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	var body resolvePreviewBody
	if r.Body != nil {
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		_ = dec.Decode(&body)
	}
	resolvePreviewMediaSSOT(w, strings.TrimSpace(body.VideoPath))
}

func resolvePreviewMediaSSOT(w http.ResponseWriter, rawSource string) {
	_, cachedPreview := getMediaPathSession()
	if statReadableFile(cachedPreview) && strings.Contains(strings.ToLower(cachedPreview), `\auto-subtitle\workspace\`) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":                 true,
			"preview_media_path": cachedPreview,
			"resolved_from":      "session_cache",
		})
		return
	}

	if latest := findLatestWorkspaceCfrPreview(); latest != "" {
		setMediaPathSessionPreview(latest)
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":                 true,
			"preview_media_path": latest,
			"resolved_from":      "workspace_scan",
		})
		return
	}

	src := strings.TrimSpace(rawSource)
	if contractSrc := findLatestWorkspaceSourceMediaPath(); contractSrc != "" {
		src = contractSrc
		setMediaPathSessionSource(src)
	} else if src == "" {
		src, _ = getMediaPathSession()
		src = strings.TrimSpace(src)
	}
	if src != "" && !statReadableFile(src) {
		if contractSrc := findLatestWorkspaceSourceMediaPath(); contractSrc != "" {
			src = contractSrc
			setMediaPathSessionSource(src)
		}
	}
	if src != "" {
		payload, err := runPreparePreviewPython(src)
		if err == nil && payload != nil {
			if okVal, _ := payload["ok"].(bool); okVal {
				if pmp, _ := payload["preview_media_path"].(string); strings.TrimSpace(pmp) != "" {
					setMediaPathSessionPreview(pmp)
				}
			}
			if rawSource != "" {
				payload["resolved_from"] = "prepare_source"
			} else {
				payload["resolved_from"] = "prepare_last_source"
			}
			status := http.StatusOK
			if okVal, _ := payload["ok"].(bool); !okVal {
				status = http.StatusUnprocessableEntity
			}
			writeJSON(w, status, payload)
			return
		}
	}

	writeJSON(w, http.StatusNotFound, map[string]any{
		"ok":    false,
		"error": "preview media not found",
	})
}

func runPreparePreviewPython(rawPath string) (map[string]any, error) {
	agentDir, ok := resolveAgentDir()
	if !ok {
		return nil, fmt.Errorf("agent directory not found")
	}

	pythonPath := resolveFastAPIPython(agentDir)
	pathJSON, _ := json.Marshal(rawPath)
	agentJSON, _ := json.Marshal(agentDir)
	script := fmt.Sprintf(
		"import json, sys; sys.path.insert(0, %s); from pathlib import Path; from engines.auto_subtitle import normalize_media_path, resolve_existing_file, build_preview_media_ssot; raw=normalize_media_path(%s); p=resolve_existing_file(raw); print(json.dumps(build_preview_media_ssot(p if p else Path(raw)), ensure_ascii=False))",
		string(agentJSON),
		string(pathJSON),
	)

	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Minute)
	defer cancel()

	cmd := exec.CommandContext(ctx, pythonPath, "-c", script)
	cmd.Dir = agentDir
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("ITMATZIP_AGENT_INSTALL_ROOT=%s", installRootPath),
		fmt.Sprintf("ITMATZIP_AGENT_DATA=%s", settingsRootPath),
		fmt.Sprintf("ITMATZIP_AGENT_DIR=%s", agentDir),
		fmt.Sprintf("PYTHONPATH=%s", prependPathEnv(os.Getenv("PYTHONPATH"), agentDir)),
		"PYTHONNOUSERSITE=1",
	)
	hideExec(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		tail := strings.TrimSpace(stderr.String())
		if tail == "" {
			tail = strings.TrimSpace(string(out))
		}
		if tail == "" {
			tail = err.Error()
		}
		return nil, fmt.Errorf("%s", tail)
	}

	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var payload map[string]any
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(line, "{") {
			continue
		}
		if json.Unmarshal([]byte(line), &payload) == nil {
			return payload, nil
		}
	}
	return nil, fmt.Errorf("invalid python response: %s", string(out))
}

func handleAutoSubtitlePlainBurnIn(w http.ResponseWriter, r *http.Request) {
	log.Printf("[deprecated] plain-burn-in: migrate to Python V41 /export pipeline")
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
