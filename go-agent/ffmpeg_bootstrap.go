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
	src := filepath.Join(installRootPath, "vendor", "ffmpeg", "gpl-shared")
	srcBuild := ffmpegBuildMarker(src)
	if bundledFFmpegReady(dst) {
		// Same pinned build already in place (or an older MSI without a marker): keep it.
		if srcBuild == "" || ffmpegBuildMarker(dst) == srcBuild {
			return
		}
	}
	if !bundledFFmpegReady(src) {
		return
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		log.Printf("warning: mkdir ffmpeg dest: %v", err)
		return
	}
	// /MIR: the shared folder must hold exactly the MSI's pinned build. Runs before any worker starts,
	// so no FFmpeg DLL is in use; a leftover locked file would only be an unused extra DLL.
	log.Printf("installing bundled FFmpeg %q: %s -> %s", srcBuild, src, dst)
	cmd := exec.Command(
		"robocopy", src, dst,
		"/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS", "/NP",
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

// ffmpegBuildMarker reads ffmpeg-build.txt (written by scripts/install-ffmpeg-vendor.ps1 and
// agent/common/bin_manager.py) — the pinned FFmpeg zip name, or "" when absent.
func ffmpegBuildMarker(dir string) string {
	data, err := os.ReadFile(filepath.Join(dir, "ffmpeg-build.txt"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
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
