//go:build !windows

package main

import "fmt"

func isCurrentProcessInteractive() bool { return false }

func pickFileViaUserDialog(audioOnly bool, projectOnly bool, fontOnly bool, imageOnly bool) (string, error) {
	return "", fmt.Errorf("file dialog is only available on Windows")
}

func pickFolderViaUserDialog() (string, error) {
	return "", fmt.Errorf("folder dialog is only available on Windows")
}
