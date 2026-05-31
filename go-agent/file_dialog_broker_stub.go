//go:build !windows

package main

import "fmt"

func isCurrentProcessInteractive() bool { return false }

func pickFileViaUserDialog(audioOnly bool, projectOnly bool, fontOnly bool) (string, error) {
	return "", fmt.Errorf("file dialog is only available on Windows")
}
