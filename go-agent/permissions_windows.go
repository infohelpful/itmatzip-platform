//go:build windows

package main

import (
	"log"
	"os"
	"os/exec"
	"path/filepath"
)

func ensureDataFolderWritable() {
	if settingsRootPath == "" {
		return
	}
	testFile := settingsRootPath + `\.write_test`
	f, err := os.Create(testFile)
	if err == nil {
		f.Close()
		os.Remove(testFile)
	} else {
		cmd := exec.Command("icacls", settingsRootPath, "/grant", "*S-1-5-32-545:(OI)(CI)M", "/T", "/Q")
		hideExec(cmd)
		if out, err := cmd.CombinedOutput(); err != nil {
			log.Printf("warning: icacls grant on %s failed: %v (%s)", settingsRootPath, err, string(out))
		} else {
			log.Printf("granted Users write access to %s", settingsRootPath)
		}
	}

	ensureRuntimeSitePackagesDir()
	ensureEngineSitePackagesWritable()
}

func ensureRuntimeSitePackagesDir() {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return
	}
	siteDir := filepath.Join(appData, "ItMatZip", "engine-runtime", "Lib", "site-packages")
	if err := os.MkdirAll(siteDir, 0755); err != nil {
		log.Printf("warning: create runtime site-packages %s: %v", siteDir, err)
		return
	}
	testFile := filepath.Join(siteDir, ".write_test")
	if err := os.WriteFile(testFile, []byte("1"), 0644); err != nil {
		log.Printf("warning: runtime site-packages not writable: %s (%v)", siteDir, err)
		return
	}
	os.Remove(testFile)
}

func ensureEngineSitePackagesWritable() {
	if installRootPath == "" {
		return
	}
	siteDir := filepath.Join(installRootPath, "engine", "Lib", "site-packages")
	if _, err := os.Stat(siteDir); err != nil {
		return
	}
	testFile := filepath.Join(siteDir, ".write_test")
	f, err := os.Create(testFile)
	if err == nil {
		f.Close()
		os.Remove(testFile)
		return
	}

	cmd := exec.Command("icacls", siteDir, "/grant", "*S-1-5-32-545:(OI)(CI)M", "/T", "/Q")
	hideExec(cmd)
	if out, icaclsErr := cmd.CombinedOutput(); icaclsErr != nil {
		log.Printf(
			"engine site-packages not writable (%s); runtime pip uses %%APPDATA%%\\ItMatZip\\engine-runtime: %v (%s)",
			siteDir, icaclsErr, string(out),
		)
	} else {
		log.Printf("granted Users write access to %s (legacy pip fallback)", siteDir)
	}
}
