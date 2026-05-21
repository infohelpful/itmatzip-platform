package main

import (
	"log"
	"os"
	"path/filepath"
	"strings"
)

var (
	installRootPath  string
	settingsRootPath string
	modelsRootPath   string
	engineRootPath   string
	logsRootPath     string
)

func initPaths() {
	exe, err := os.Executable()
	if err != nil {
		log.Fatalf("resolve executable path: %v", err)
	}
	exeDir, err := filepath.Abs(filepath.Dir(exe))
	if err != nil {
		log.Fatalf("resolve executable dir: %v", err)
	}

	switch {
	case hasBundledLayout(exeDir):
		installRootPath = exeDir
		settingsRootPath = `C:\ProgramData\itmatzip-agent`
		log.Printf("using bundled install layout (install=%s data=%s)", installRootPath, settingsRootPath)
	case os.Getenv("ITMATZIP_AGENT_DEV") == "1" || isDevLayout(exeDir):
		devRoot := exeDir
		if filepath.Base(exeDir) != "go-agent" {
			candidate := filepath.Join(exeDir, "go-agent")
			if info, statErr := os.Stat(candidate); statErr == nil && info.IsDir() {
				devRoot = candidate
			}
		}
		installRootPath = filepath.Join(devRoot, ".local", "install")
		settingsRootPath = filepath.Join(devRoot, ".local", "data")
		log.Printf("using dev paths (install=%s data=%s)", installRootPath, settingsRootPath)
	default:
		installRootPath = `C:\Program Files\itmatzip-agent`
		settingsRootPath = `C:\ProgramData\itmatzip-agent`
	}

	modelsRootPath = filepath.Join(installRootPath, "models")
	engineRootPath = filepath.Join(installRootPath, "engine")
	logsRootPath = filepath.Join(settingsRootPath, "logs")
}

func hasBundledLayout(exeDir string) bool {
	for _, name := range []string{"engine", "python_worker"} {
		info, err := os.Stat(filepath.Join(exeDir, name))
		if err == nil && info.IsDir() {
			return true
		}
	}
	return false
}

func isDevLayout(exeDir string) bool {
	if os.Getenv("ITMATZIP_AGENT_DEV") == "1" {
		return true
	}
	lower := strings.ToLower(filepath.Clean(exeDir))
	return strings.HasSuffix(lower, `\go-agent`) || strings.Contains(lower, `\go-agent\`)
}

func pythonWorkerScript(name string) string {
	candidates := []string{
		filepath.Join("python_worker", name),
	}
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		candidates = append(candidates, filepath.Join(exeDir, "python_worker", name))
		candidates = append(candidates, filepath.Join(exeDir, "..", "python_worker", name))
	}
	for _, candidate := range candidates {
		if abs, err := filepath.Abs(candidate); err == nil {
			if _, err := os.Stat(abs); err == nil {
				return abs
			}
		}
	}
	abs, _ := filepath.Abs(filepath.Join("python_worker", name))
	return abs
}

func resolvePythonExecutable() string {
	if custom := os.Getenv("ITMATZIP_PYTHON"); custom != "" {
		return custom
	}
	candidates := []string{
		filepath.Join(engineRootPath, "python.exe"),
		filepath.Join(engineRootPath, "Scripts", "python.exe"),
	}
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(exeDir, "engine", "python.exe"),
			filepath.Join(exeDir, "engine", "Scripts", "python.exe"),
		)
	}
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err == nil && !info.IsDir() {
			return candidate
		}
	}
	return "python"
}

func resolveFastAPIPython(agentDir string) string {
	if custom := os.Getenv("ITMATZIP_FASTAPI_PYTHON"); custom != "" {
		return custom
	}
	candidates := []string{
		filepath.Join(agentDir, ".venv-build", "Scripts", "python.exe"),
		filepath.Join(agentDir, ".venv", "Scripts", "python.exe"),
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return resolvePythonExecutable()
}

func resolveAgentDir() (string, bool) {
	if custom := os.Getenv("ITMATZIP_AGENT_DIR"); custom != "" {
		if _, err := os.Stat(filepath.Join(custom, "main.py")); err == nil {
			return custom, true
		}
	}

	candidates := []string{
		filepath.Join(installRootPath, "agent"),
	}
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(exeDir, "agent"),
			filepath.Join(exeDir, "..", "agent"),
			filepath.Join(exeDir, "..", "..", "agent"),
		)
	}
	candidates = append(candidates, filepath.Join("agent"))

	for _, candidate := range candidates {
		abs, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		if _, err := os.Stat(filepath.Join(abs, "main.py")); err == nil {
			return abs, true
		}
	}
	return "", false
}
