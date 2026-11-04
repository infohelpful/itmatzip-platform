//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The tray must run as the signed-in user. Engine packages live in that user's %APPDATA%
// (ItMatZip\engine-runtime), so a tray running as LocalSystem — e.g. started from an MSI
// custom action (Impersonate="no") during an update — sees no packages and every tool fails.

// runningAsLocalSystem reports whether this process runs as NT AUTHORITY\SYSTEM.
func runningAsLocalSystem() bool {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return false
	}
	return user.User.Sid.IsWellKnown(windows.WinLocalSystemSid)
}

// relaunchTrayAsSessionUser starts `itmatzip-agent.exe --tray` as the user signed in to the
// active console session, with that user's own environment (APPDATA, USERPROFILE, ...).
func relaunchTrayAsSessionUser() error {
	session := windows.WTSGetActiveConsoleSessionId()
	if session == 0xFFFFFFFF {
		return fmt.Errorf("no active console session")
	}
	var token windows.Token
	if err := windows.WTSQueryUserToken(session, &token); err != nil {
		return fmt.Errorf("WTSQueryUserToken(session %d): %w", session, err)
	}
	defer token.Close()
	env, err := userEnvironment(token)
	if err != nil {
		return fmt.Errorf("user environment: %w", err)
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "--tray")
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Token:         syscall.Token(token),
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP,
	}
	hideExec(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start tray as session user: %w", err)
	}
	_ = cmd.Process.Release()
	return nil
}

// userEnvironment returns the token user's environment block (CreateEnvironmentBlock) as KEY=VALUE pairs.
func userEnvironment(token windows.Token) ([]string, error) {
	var block *uint16
	if err := windows.CreateEnvironmentBlock(&block, token, false); err != nil {
		return nil, err
	}
	defer windows.DestroyEnvironmentBlock(block)
	var env []string
	for p := unsafe.Pointer(block); ; {
		entry := windows.UTF16PtrToString((*uint16)(p))
		if entry == "" {
			break
		}
		env = append(env, entry)
		p = unsafe.Add(p, (len(windows.StringToUTF16(entry)))*2)
	}
	return env, nil
}
