//go:build windows

package main

import (
	"fmt"
	"log"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

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
	log.Printf("service %s started", windowsServiceName)
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
	log.Printf("service %s stopped", windowsServiceName)
	return nil
}
