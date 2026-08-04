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

func grantUsersModifyRecursive(dir string) {
	if dir == "" {
		return
	}
	if _, err := os.Stat(dir); err != nil {
		return
	}
	cmd := exec.Command("icacls", dir, "/grant", "*S-1-5-32-545:(OI)(CI)M", "/T", "/Q")
	hideExec(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		log.Printf("warning: icacls grant on %s failed: %v (%s)", dir, err, string(out))
		return
	}
	log.Printf("granted Users modify access to %s", dir)
}

func ensureRuntimeSitePackagesDir() {
	// engine-runtime/<tool>/Lib/site-packages — MSI embeddable Python 3.12 pip --target
	engineRuntimeTools := []string{"silence-remover", "vocal-remover", "auto-subtitle", "image-enhancer", "create-music", "background-remover", "magic-eraser"}
	appData := os.Getenv("APPDATA")
	if appData != "" {
		runtimeRoot := filepath.Join(appData, "ItMatZip", "engine-runtime")
		grantUsersModifyRecursive(runtimeRoot)
		for _, toolID := range engineRuntimeTools {
			siteDir := filepath.Join(runtimeRoot, toolID, "Lib", "site-packages")
			ensureDirWritable(siteDir)
		}
		// models / vendor / wheels-cache (packages are under engine-runtime/image-enhancer)
		imageEnhancerRoot := filepath.Join(appData, "ItMatZip", "image-enhancer")
		ensureDirWritable(imageEnhancerRoot)
		ensureDirWritable(filepath.Join(imageEnhancerRoot, "models"))
		ensureDirWritable(filepath.Join(imageEnhancerRoot, "vendor"))
		ensureDirWritable(filepath.Join(imageEnhancerRoot, "wheels-cache"))
		backgroundRemoverRoot := filepath.Join(appData, "ItMatZip", "background-remover")
		ensureDirWritable(backgroundRemoverRoot)
		ensureDirWritable(filepath.Join(backgroundRemoverRoot, "models"))
		ensureDirWritable(filepath.Join(backgroundRemoverRoot, "wheels-cache"))
		ensureDirWritable(filepath.Join(backgroundRemoverRoot, "workspace"))
		ensureDirWritable(filepath.Join(backgroundRemoverRoot, "hf-home"))
		magicEraserRoot := filepath.Join(appData, "ItMatZip", "magic-eraser")
		ensureDirWritable(magicEraserRoot)
		ensureDirWritable(filepath.Join(magicEraserRoot, "models"))
		ensureDirWritable(filepath.Join(magicEraserRoot, "wheels-cache"))
		ensureDirWritable(filepath.Join(magicEraserRoot, "workspace"))
	}

	if settingsRootPath != "" {
		grantUsersModifyRecursive(filepath.Join(settingsRootPath, "auto-subtitle"))
		createMusicRoot := filepath.Join(settingsRootPath, "create-music")
		ensureDirWritable(createMusicRoot)
		ensureDirWritable(filepath.Join(createMusicRoot, "acestep-source"))
		ensureDirWritable(filepath.Join(createMusicRoot, "wheels-cache"))
		ensureDirWritable(filepath.Join(createMusicRoot, "checkpoints"))
		ensureDirWritable(filepath.Join(createMusicRoot, "workspace"))
		ensureDirWritable(filepath.Join(settingsRootPath, "Font"))
	}

	if pd := os.Getenv("ProgramData"); pd != "" {
		grantUsersModifyRecursive(filepath.Join(pd, "Itmatzip"))
	}
}

func ensureDirWritable(dir string) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		log.Printf("warning: create runtime dir %s: %v", dir, err)
		return
	}
	testFile := filepath.Join(dir, ".write_test")
	if err := os.WriteFile(testFile, []byte("1"), 0644); err != nil {
		log.Printf("warning: runtime dir not writable: %s (%v)", dir, err)
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
			"engine site-packages not writable (%s); runtime pip uses per-tool dirs (engine-runtime/<tool>, create-music/.venv): %v (%s)",
			siteDir, icaclsErr, string(out),
		)
	} else {
		log.Printf("granted Users write access to %s (legacy pip fallback)", siteDir)
	}
}
