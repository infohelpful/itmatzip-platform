package main

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func findLatestWorkspaceCfrPreview() string {
	root := autoSubtitleWorkspaceRoot()
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return ""
	}

	var best string
	var bestMod time.Time
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() {
			return nil
		}
		base := strings.ToLower(filepath.Base(path))
		if base != "media-cfr.mp4" && base != "media-av-sync.mp4" && base != "media-preview.mp4" {
			return nil
		}
		fi, statErr := d.Info()
		if statErr != nil {
			return nil
		}
		if fi.ModTime().After(bestMod) {
			bestMod = fi.ModTime()
			best = filepath.Clean(path)
		}
		return nil
	})
	return best
}

// workspace job — media_timing_contract.json 의 UTF-8 원본 (브라우저 session 깨짐 복구)
func findLatestWorkspaceSourceMediaPath() string {
	root := autoSubtitleWorkspaceRoot()
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return ""
	}

	var best string
	var bestMod time.Time
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || d.IsDir() {
			return nil
		}
		if strings.ToLower(filepath.Base(path)) != "media_timing_contract.json" {
			return nil
		}
		fi, statErr := d.Info()
		if statErr != nil {
			return nil
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		var contract map[string]any
		if json.Unmarshal(raw, &contract) != nil {
			return nil
		}
		src := ""
		for _, key := range []string{"source_media_path", "source_path"} {
			if v, ok := contract[key].(string); ok && strings.TrimSpace(v) != "" {
				src = strings.TrimSpace(v)
				break
			}
		}
		if src == "" || !statReadableFile(src) {
			return nil
		}
		if fi.ModTime().After(bestMod) {
			bestMod = fi.ModTime()
			best = src
		}
		return nil
	})
	return best
}

func statReadableFile(path string) bool {
	path = strings.TrimSpace(path)
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info != nil && !info.IsDir()
}
