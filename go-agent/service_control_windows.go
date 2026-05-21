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
	st, _, ok := queryWindowsServiceStatus()
	return st, ok
}

func queryWindowsServiceStatus() (svc.State, *svc.Status, bool) {
	m, err := mgr.Connect()
	if err != nil {
		return 0, nil, false
	}
	defer m.Disconnect()
	s, err := m.OpenService(windowsServiceName)
	if err != nil {
		return 0, nil, false
	}
	defer s.Close()
	status, err := s.Query()
	if err != nil {
		return 0, nil, false
	}
	return status.State, &status, true
}

func describeServiceStartFailure() string {
	st, status, ok := queryWindowsServiceStatus()
	if !ok || status == nil {
		return "서비스 상태를 읽을 수 없습니다."
	}
	hint := fmt.Sprintf("현재 상태=%s", st)
	if status.Win32ExitCode != 0 {
		hint += fmt.Sprintf(", Win32ExitCode=%d", status.Win32ExitCode)
		if status.Win32ExitCode == 1067 {
			hint += " (시작 직후 비정상 종료 — agent/engines 경로·service.log 확인, MSI 재설치 권장)"
		}
	}
	logPath := ""
	if logsRootPath != "" {
		logPath = logsRootPath + `\service.log`
	} else {
		logPath = `C:\ProgramData\itmatzip-agent\logs\service.log`
	}
	return hint + "\n로그: " + logPath
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
		if isServiceAccessDenied(err) {
			return fmt.Errorf(
				"start service %s: %w (관리자로 itmatzip-agent.exe --install 한 번 실행해 사용자 시작 권한을 부여하세요)",
				windowsServiceName,
				err,
			)
		}
		return fmt.Errorf("start service %s: %w", windowsServiceName, err)
	}
	log.Printf("service %s start requested", windowsServiceName)
	if !waitForServiceState(svc.Running, 60*time.Second) {
		return fmt.Errorf("%s did not reach running state\n%s", windowsServiceName, describeServiceStartFailure())
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
