package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const maxLocalImagePreviewBytes = 64 << 20 // 64 MiB

var localImagePreviewTypes = map[string]string{
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".jfif": "image/jpeg",
	".png":  "image/png",
	".webp": "image/webp",
	".gif":  "image/gif",
	".bmp":  "image/bmp",
}

func resolveLocalImagePath(raw string) (string, error) {
	cleaned := strings.TrimSpace(raw)
	cleaned = strings.Trim(cleaned, `"'`)
	if cleaned == "" {
		return "", fmt.Errorf("이미지 경로가 비어 있습니다")
	}
	abs, err := filepath.Abs(cleaned)
	if err != nil {
		return "", fmt.Errorf("경로를 해석할 수 없습니다: %w", err)
	}
	return filepath.Clean(abs), nil
}

func localImageMediaType(path string) (string, bool) {
	ext := strings.ToLower(filepath.Ext(path))
	media, ok := localImagePreviewTypes[ext]
	return media, ok
}

func handleReadLocalImage(w http.ResponseWriter, r *http.Request) {
	var raw string
	switch r.Method {
	case http.MethodGet:
		raw = strings.TrimSpace(r.URL.Query().Get("path"))
		if raw == "" {
			raw = strings.TrimSpace(r.URL.Query().Get("image_path"))
		}
	case http.MethodPost:
		var body struct {
			Path      string `json:"path"`
			ImagePath string `json:"image_path"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]any{"detail": "요청 본문이 올바르지 않습니다."})
			return
		}
		raw = strings.TrimSpace(body.Path)
		if raw == "" {
			raw = strings.TrimSpace(body.ImagePath)
		}
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	abs, err := resolveLocalImagePath(raw)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"detail": err.Error()})
		return
	}

	mediaType, ok := localImageMediaType(abs)
	if !ok {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"detail": fmt.Sprintf("지원하지 않는 이미지 형식입니다: %s", filepath.Ext(abs)),
		})
		return
	}

	info, err := os.Stat(abs)
	if err != nil {
		status := http.StatusNotFound
		if !os.IsNotExist(err) {
			status = http.StatusInternalServerError
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"detail": fmt.Sprintf("이미지 파일을 찾을 수 없습니다: %s", abs),
		})
		return
	}
	if info.IsDir() {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"detail": "폴더는 미리보기할 수 없습니다."})
		return
	}
	if info.Size() > maxLocalImagePreviewBytes {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"detail": "미리보기용 이미지가 너무 큽니다 (최대 64MB).",
		})
		return
	}

	f, err := os.Open(abs)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]any{"detail": "이미지 파일을 열 수 없습니다."})
		return
	}
	defer f.Close()

	w.Header().Set("Content-Type", mediaType)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
}
