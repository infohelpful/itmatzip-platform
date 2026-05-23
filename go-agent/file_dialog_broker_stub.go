//go:build !windows

package main

import (
	"fmt"
	"time"
)

func startFileDialogBroker() error { return nil }
func stopFileDialogBroker()        {}
func runFileDialogBrokerOnly() error {
	return fmt.Errorf("file dialog broker is only available on Windows")
}
func isFileDialogBrokerListening() bool { return false }

func ensureFileDialogBrokerReady(timeout time.Duration) error {
	_ = timeout
	return fmt.Errorf("file dialog broker is only available on Windows")
}

func requestFileDialogBroker(audioOnly bool, projectOnly bool, timeout time.Duration) (string, error) {
	_ = audioOnly
	_ = projectOnly
	_ = timeout
	return "", fmt.Errorf("file dialog broker is only available on Windows")
}
