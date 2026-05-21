//go:build !windows

package main

import "fmt"

func isWindowsServiceRunning() bool { return false }

func startWindowsService() error { return fmt.Errorf("windows service control is not available on this platform") }

func stopWindowsService() error { return fmt.Errorf("windows service control is not available on this platform") }
