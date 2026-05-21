//go:build windows

package main

import (
	"fmt"
	"log"
	"os/exec"
	"strings"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// SDDL: SY/BA full control; Authenticated Users + Interactive can start/stop/query.
const serviceUserControlSDDL = "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRRC;;;BA)(A;;RPWP;;;AU)(A;;CCLCSWRPWPDTLOCRRC;;;IU)"

func isWindowsServiceRunning() bool {
	st, ok := queryWindowsServiceState()
	return ok && st == svc.Running
}

func queryWindowsServiceState() (svc.State, bool) {
	m, err := mgr.Connect()
	if err != nil {
		return 0, false
	}
	defer m.Disconnect()
	s, err := m.OpenService(windowsServiceName)
	if err != nil {
		return 0, false
	}
	defer s.Close()
	status, err := s.Query()
	if err != nil {
		return 0, false
	}
	return status.State, true
}

func waitForServiceState(want svc.State, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		st, ok := queryWindowsServiceState()
		if ok && st == want {
			return true
		}
		time.Sleep(250 * time.Millisecond)
	}
	return false
}

func grantServiceControlToUsers() error {
	cmd := exec.Command("sc.exe", "sdset", windowsServiceName, serviceUserControlSDDL)
	hideExec(cmd)
	out, err := cmd.CombinedOutput()
	msg := strings.TrimSpace(string(out))
	if err != nil {
		if strings.Contains(msg, "1060") {
			return nil
		}
		return fmt.Errorf("sc sdset: %v (%s)", err, msg)
	}
	log.Printf("service ACL updated for user start/stop")
	return nil
}

func startWindowsService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect service manager: %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(windowsServiceName)
	if err != nil {
		return fmt.Errorf("open service %s: %w", windowsServiceName, err)
	}
	defer s.Close()
	status, err := s.Query()
	if err == nil && status.State == svc.Running {
		log.Printf("service %s already running", windowsServiceName)
		return nil
	}
	if err := s.Start(); err != nil {
		return fmt.Errorf("start service %s: %w", windowsServiceName, err)
	}
	log.Printf("service %s start requested", windowsServiceName)
	if !waitForServiceState(svc.Running, 60*time.Second) {
		return fmt.Errorf("service %s did not reach running state", windowsServiceName)
	}
	log.Printf("service %s running", windowsServiceName)
	return nil
}

func stopWindowsService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect service manager: %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(windowsServiceName)
	if err != nil {
		return fmt.Errorf("open service %s: %w", windowsServiceName, err)
	}
	defer s.Close()
	status, err := s.Query()
	if err == nil && status.State == svc.Stopped {
		return nil
	}
	if _, err := s.Control(svc.Stop); err != nil {
		return fmt.Errorf("stop service %s: %w", windowsServiceName, err)
	}
	log.Printf("service %s stop requested", windowsServiceName)
	if !waitForServiceState(svc.Stopped, 30*time.Second) {
		return fmt.Errorf("service %s did not stop in time", windowsServiceName)
	}
	log.Printf("service %s stopped", windowsServiceName)
	return nil
}

func restartWindowsServiceAndWait() error {
	if err := stopWindowsService(); err != nil {
		return err
	}
	return startWindowsService()
}
