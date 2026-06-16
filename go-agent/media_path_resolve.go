package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"golang.org/x/text/unicode/norm"
)

func normalizeMediaPathRaw(raw string) string {
	p := strings.TrimSpace(raw)
	p = strings.Trim(p, `"'`)
	p = strings.ReplaceAll(p, "¥", `\`)
	p = strings.ReplaceAll(p, "₩", `\`)
	return filepath.Clean(p)
}

func mediaPathStatCandidates(raw string) []string {
	base := normalizeMediaPathRaw(raw)
	if base == "" {
		return nil
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, 10)
	add := func(s string) {
		s = strings.TrimSpace(s)
		if s == "" {
			return
		}
		s = filepath.Clean(s)
		if _, ok := seen[s]; ok {
			return
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	for _, n := range []func(string) string{norm.NFC.String, norm.NFD.String} {
		normed := n(base)
		add(normed)
		if abs, err := filepath.Abs(normed); err == nil {
			add(abs)
			if len(abs) >= 2 && abs[1] == ':' {
				add(`\\?\` + abs)
			}
		}
	}
	return out
}

func resolveMediaPathViaPython(raw string) (string, error) {
	agentDir, ok := resolveAgentDir()
	if !ok {
		return "", fmt.Errorf("agent directory not found")
	}
	pythonPath := resolveFastAPIPython(agentDir)
	pathJSON, _ := json.Marshal(raw)
	agentJSON, _ := json.Marshal(agentDir)
	script := fmt.Sprintf(
		"import json,sys; sys.path.insert(0,%s); from engines.auto_subtitle import normalize_media_path, resolve_existing_file; p=resolve_existing_file(normalize_media_path(%s)); print(json.dumps({'path': str(p) if p else ''}))",
		string(agentJSON),
		string(pathJSON),
	)
	cmd := exec.Command(pythonPath, "-c", script)
	cmd.Dir = agentDir
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("ITMATZIP_AGENT_DIR=%s", agentDir),
		fmt.Sprintf("PYTHONPATH=%s", prependPathEnv(os.Getenv("PYTHONPATH"), agentDir)),
		"PYTHONNOUSERSITE=1",
	)
	hideExec(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("python resolve: %v: %s", err, strings.TrimSpace(stderr.String()))
	}
	line := strings.TrimSpace(string(out))
	if i := strings.LastIndex(line, "{"); i >= 0 {
		line = line[i:]
	}
	var payload struct {
		Path string `json:"path"`
	}
	if json.Unmarshal([]byte(line), &payload) != nil || strings.TrimSpace(payload.Path) == "" {
		return "", os.ErrNotExist
	}
	return filepath.Clean(payload.Path), nil
}

func resolveReadableMediaPath(raw string) (string, error) {
	p := strings.TrimSpace(raw)
	if p == "" {
		return "", errMediaPathEmpty
	}
	for _, candidate := range mediaPathStatCandidates(p) {
		info, err := os.Stat(candidate)
		if err != nil {
			continue
		}
		if info.IsDir() {
			return "", errMediaPathIsDir
		}
		return candidate, nil
	}
	resolved, err := resolveMediaPathViaPython(p)
	if err != nil || strings.TrimSpace(resolved) == "" {
		return "", os.ErrNotExist
	}
	info, statErr := os.Stat(resolved)
	if statErr == nil && info.IsDir() {
		return "", errMediaPathIsDir
	}
	return resolved, nil
}

func probeMediaTimingViaPython(raw string) (map[string]any, error) {
	agentDir, ok := resolveAgentDir()
	if !ok {
		return nil, fmt.Errorf("agent directory not found")
	}
	pythonPath := resolveFastAPIPython(agentDir)
	pathJSON, _ := json.Marshal(raw)
	agentJSON, _ := json.Marshal(agentDir)
	script := fmt.Sprintf(
		"import json,sys; sys.path.insert(0,%s); from engines.auto_subtitle import normalize_media_path, resolve_existing_file; from engines.auto_subtitle_media_probe import probe_media_timing; raw=normalize_media_path(%s); p=resolve_existing_file(raw); print(json.dumps(probe_media_timing(p, unify_ssot=True) if p else {'ok':False,'error':'file not found','source_path':raw}, ensure_ascii=False))",
		string(agentJSON),
		string(pathJSON),
	)
	cmd := exec.Command(pythonPath, "-c", script)
	cmd.Dir = agentDir
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("ITMATZIP_AGENT_DIR=%s", agentDir),
		fmt.Sprintf("PYTHONPATH=%s", prependPathEnv(os.Getenv("PYTHONPATH"), agentDir)),
		"PYTHONNOUSERSITE=1",
	)
	hideExec(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("python probe: %v: %s", err, strings.TrimSpace(stderr.String()))
	}
	line := strings.TrimSpace(string(out))
	if i := strings.LastIndex(line, "{"); i >= 0 {
		line = line[i:]
	}
	var payload map[string]any
	if json.Unmarshal([]byte(line), &payload) != nil {
		return nil, fmt.Errorf("invalid python probe response")
	}
	return payload, nil
}
