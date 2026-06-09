package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func autoSubtitleWorkspaceRoot() string {
	return filepath.Join(settingsRootPath, "auto-subtitle", "workspace")
}

func resolveFFmpegExecutable() (string, error) {
	if p, err := resolveBundledFFmpegTool("ffmpeg.exe"); err == nil {
		return p, nil
	}
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("ffmpeg not found: install via silence-remover prepare or place under %s", filepath.Join(settingsRootPath, "bin"))
}

func resolveFFprobeExecutable() (string, error) {
	if p, err := resolveBundledFFmpegTool("ffprobe.exe"); err == nil {
		return p, nil
	}
	if p, err := exec.LookPath("ffprobe"); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("ffprobe not found: install via silence-remover prepare or place under %s", filepath.Join(settingsRootPath, "bin"))
}

func resolveBundledFFmpegTool(name string) (string, error) {
	binRoot := filepath.Join(settingsRootPath, "bin")
	candidates := []string{
		filepath.Join(binRoot, "gpl-shared", name),
		filepath.Join(binRoot, name),
	}
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("%s not found under %s", name, binRoot)
}

func prependFFmpegBinToPath(env []string) []string {
	binDirs := []string{
		filepath.Join(settingsRootPath, "bin", "gpl-shared"),
		filepath.Join(settingsRootPath, "bin"),
	}
	out := append([]string(nil), env...)
	for _, dir := range binDirs {
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			continue
		}
		out = prependPathEnvEntry(out, "PATH", dir)
	}
	return out
}

func prependPathEnvEntry(env []string, key, value string) []string {
	prefix := key + "="
	for i, entry := range env {
		if !strings.HasPrefix(entry, prefix) {
			continue
		}
		existing := strings.TrimPrefix(entry, prefix)
		if existing == "" {
			env[i] = prefix + value
			return env
		}
		if strings.HasPrefix(existing, value+string(os.PathListSeparator)) || existing == value {
			return env
		}
		env[i] = prefix + value + string(os.PathListSeparator) + existing
		return env
	}
	return append(env, prefix+value)
}
