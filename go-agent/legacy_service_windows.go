//go:build windows

package main

import (
	"log"
	"os/exec"
	"strings"
	"time"
)

const legacyServiceName = "ItMatZipAgent"

func removeLegacyWindowsService() {
	if !legacyWindowsServiceInstalled() {
		return
	}
	log.Printf("removing legacy Windows service %q (tray autostart replaces it)", legacyServiceName)
	stop := exec.Command("sc.exe", "stop", legacyServiceName)
	if out, err := stop.CombinedOutput(); err != nil {
		text := strings.TrimSpace(string(out))
		if text != "" && !strings.Contains(text, "1062") { // not started
			log.Printf("legacy service stop: %v (%s)", err, text)
		}
	} else {
		time.Sleep(500 * time.Millisecond)
	}
	del := exec.Command("sc.exe", "delete", legacyServiceName)
	if out, err := del.CombinedOutput(); err != nil {
		log.Printf("legacy service delete: %v (%s)", err, strings.TrimSpace(string(out)))
		return
	}
	log.Printf("legacy Windows service %q removed", legacyServiceName)
}

func legacyWindowsServiceInstalled() bool {
	out, err := exec.Command("sc.exe", "query", legacyServiceName).CombinedOutput()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), "SERVICE_NAME")
}
