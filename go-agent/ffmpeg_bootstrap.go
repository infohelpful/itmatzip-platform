package main

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func ensureBundledFFmpegInstalled() {
	if settingsRootPath == "" || installRootPath == "" {
		return
	}
	dst := filepath.Join(settingsRootPath, "bin", "gpl-shared")
	if bundledFFmpegReady(dst) {
		return
	}
	src := filepath.Join(installRootPath, "vendor", "ffmpeg", "gpl-shared")
	if !bundledFFmpegReady(src) {
		return
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		log.Printf("warning: mkdir ffmpeg dest: %v", err)
		return
	}
	log.Printf("installing bundled FFmpeg: %s -> %s", src, dst)
	cmd := exec.Command(
		"robocopy", src, dst,
		"/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS", "/NP",
	)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		code := exitErr.ExitCode()
		if code >= 0 && code <= 7 {
			return
		}
	}
	log.Printf("warning: robocopy bundled ffmpeg failed: %v (%s)", err, strings.TrimSpace(string(out)))
}

func bundledFFmpegReady(dir string) bool {
	if !fileExists(filepath.Join(dir, "ffmpeg.exe")) || !fileExists(filepath.Join(dir, "ffprobe.exe")) {
		return false
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if strings.HasSuffix(strings.ToLower(entry.Name()), ".dll") {
			return true
		}
	}
	return false
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
