package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var agentVersionPattern = regexp.MustCompile(`AGENT_VERSION\s*=\s*"([^"]+)"`)

func readAgentVersion() string {
	if custom := strings.TrimSpace(os.Getenv("ITMATZIP_AGENT_VERSION")); custom != "" {
		return custom
	}
	if agentDir, ok := resolveAgentDir(); ok {
		if v := parseVersionFile(filepath.Join(agentDir, "version.py")); v != "" {
			return v
		}
	}
	return "0.0.0"
}

func parseVersionFile(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	match := agentVersionPattern.FindSubmatch(data)
	if len(match) < 2 {
		return ""
	}
	return strings.TrimSpace(string(match[1]))
}

func isMSIInstallLayout() bool {
	if strings.TrimSpace(os.Getenv("ITMATZIP_FORCE_MSI_UPDATE")) == "1" {
		return true
	}
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	exeDir, err := filepath.Abs(filepath.Dir(exe))
	if err != nil {
		return false
	}
	if !hasBundledLayout(exeDir) {
		return false
	}
	if isDevLayout(exeDir) || os.Getenv("ITMATZIP_AGENT_DEV") == "1" {
		return false
	}
	if _, ok := resolveAgentDir(); !ok {
		return false
	}
	return true
}
