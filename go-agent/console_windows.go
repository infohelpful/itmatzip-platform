//go:build windows

package main

import "golang.org/x/sys/windows"

func hideAgentConsole() {
	// Detach console so --launch/--tray do not flash a terminal window.
	proc := windows.NewLazySystemDLL("kernel32.dll").NewProc("FreeConsole")
	_, _, _ = proc.Call()
}
