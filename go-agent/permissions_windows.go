//go:build windows

package main

import (
	"log"
	"os"
	"os/exec"
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
		return
	}

	cmd := exec.Command("icacls", settingsRootPath, "/grant", "*S-1-5-32-545:(OI)(CI)M", "/T", "/Q")
	hideExec(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		log.Printf("warning: icacls grant on %s failed: %v (%s)", settingsRootPath, err, string(out))
	} else {
		log.Printf("granted Users write access to %s", settingsRootPath)
	}

	ensureVenvSitePackagesWritable()
}

func ensureVenvSitePackagesWritable() {
	agentDir, ok := resolveAgentDir()
	if !ok {
		return
	}
	venvDir := agentDir + `\.venv-build`
	if _, err := os.Stat(venvDir); err != nil {
		return
	}
	testFile := venvDir + `\Lib\site-packages\.write_test`
	f, err := os.Create(testFile)
	if err == nil {
		f.Close()
		os.Remove(testFile)
		return
	}

	cmd := exec.Command("icacls", venvDir, "/grant", "*S-1-5-32-545:(OI)(CI)M", "/T", "/Q")
	hideExec(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		log.Printf("warning: icacls grant on %s failed: %v (%s)", venvDir, err, string(out))
	} else {
		log.Printf("granted Users write access to %s", venvDir)
	}
}
