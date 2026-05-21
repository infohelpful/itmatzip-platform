//go:build !windows

package main

import "os/exec"

func hideExec(cmd *exec.Cmd) {}
