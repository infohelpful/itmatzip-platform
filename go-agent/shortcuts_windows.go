//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const shortcutBaseName = "ItMatZip Agent"

func launchShortcutPaths() (desktop string, startMenu string, err error) {
	public := os.Getenv("PUBLIC")
	if public == "" {
		public = `C:\Users\Public`
	}
	programData := os.Getenv("ProgramData")
	if programData == "" {
		programData = `C:\ProgramData`
	}
	desktop = filepath.Join(public, "Desktop", shortcutBaseName+".lnk")
	startMenu = filepath.Join(programData, "Microsoft", "Windows", "Start Menu", "Programs", shortcutBaseName+".lnk")
	return desktop, startMenu, nil
}

func psQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

func createWindowsShortcut(lnkPath, targetExe, arguments, iconPath, workDir, description string) error {
	if err := os.MkdirAll(filepath.Dir(lnkPath), 0o755); err != nil {
		return err
	}
	script := fmt.Sprintf(
		`$s = (New-Object -ComObject WScript.Shell).CreateShortcut(%s); $s.TargetPath = %s; $s.Arguments = %s; $s.IconLocation = %s; $s.WorkingDirectory = %s; $s.Description = %s; $s.Save()`,
		psQuote(lnkPath),
		psQuote(targetExe),
		psQuote(arguments),
		psQuote(iconPath+",0"),
		psQuote(workDir),
		psQuote(description),
	)
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	hideExec(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("create shortcut %s: %w (%s)", lnkPath, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func createLaunchShortcuts() error {
	initPaths()
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, err = filepath.Abs(exe)
	if err != nil {
		return err
	}
	workDir := filepath.Dir(exe)
	icon := resolveTrayIconPath()
	if icon == "" {
		icon = exe
	}
	desktop, startMenu, err := launchShortcutPaths()
	if err != nil {
		return err
	}
	args := "--tray"
	desc := "ItMatZip Agent 트레이 아이콘을 표시합니다 (서비스는 Windows 서비스로 실행)."
	for _, lnk := range []string{desktop, startMenu} {
		if err := createWindowsShortcut(lnk, exe, args, icon, workDir, desc); err != nil {
			return err
		}
		log.Printf("shortcut created: %s", lnk)
	}
	return nil
}

func removeLaunchShortcuts() error {
	desktop, startMenu, err := launchShortcutPaths()
	if err != nil {
		return err
	}
	for _, lnk := range []string{desktop, startMenu} {
		if err := os.Remove(lnk); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
