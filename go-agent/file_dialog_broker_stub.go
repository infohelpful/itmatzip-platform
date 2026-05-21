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

func requestFileDialogBroker(audioOnly bool, timeout time.Duration) (string, error) {
	_ = audioOnly
	_ = timeout
	return "", fmt.Errorf("file dialog broker is only available on Windows")
}
