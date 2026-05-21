//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modKernel32  = windows.NewLazySystemDLL("kernel32.dll")
	modWtsapi32  = windows.NewLazySystemDLL("wtsapi32.dll")
	modUserenv   = windows.NewLazySystemDLL("userenv.dll")
	modAdvapi32  = windows.NewLazySystemDLL("advapi32.dll")
	procWTSGetActiveConsoleSessionId = modKernel32.NewProc("WTSGetActiveConsoleSessionId")
	procWTSEnumerateSessionsW        = modWtsapi32.NewProc("WTSEnumerateSessionsW")
	procWTSFreeMemory                = modWtsapi32.NewProc("WTSFreeMemory")
	procWTSQueryUserToken            = modWtsapi32.NewProc("WTSQueryUserToken")
	procCreateEnvironmentBlock       = modUserenv.NewProc("CreateEnvironmentBlock")
	procDestroyEnvironmentBlock      = modUserenv.NewProc("DestroyEnvironmentBlock")
	procDuplicateTokenEx             = modAdvapi32.NewProc("DuplicateTokenEx")
	procCreateProcessAsUserW         = modAdvapi32.NewProc("CreateProcessAsUserW")
)

const (
	wtsActive            = 0
	tokenAssignPrimary   = 0x0001
	tokenDuplicate       = 0x0002
	tokenQuery           = 0x0008
	tokenAdjustDefault   = 0x0080
	tokenAdjustSessionID = 0x0100
	securityImpersonation = 2
	tokenPrimary         = 1
	createUnicodeEnv     = 0x00040000
	startfUseShowWindow  = 0x00000001
	swHide               = 0
)

type wtsSessionInfo struct {
	sessionID  uint32
	_          [4]byte
	winStation *uint16
	state      uint32
}

func composeWindowsCommandLine(argv []string) string {
	var parts []string
	for _, arg := range argv {
		if arg == "" {
			parts = append(parts, `""`)
			continue
		}
		if strings.ContainsAny(arg, " \t\"") {
			parts = append(parts, `"`+strings.ReplaceAll(arg, `"`, `\"`)+`"`)
		} else {
			parts = append(parts, arg)
		}
	}
	return strings.Join(parts, " ")
}

func activeConsoleSessionID() (uint32, bool) {
	if err := procWTSGetActiveConsoleSessionId.Find(); err != nil {
		return 0, false
	}
	r, _, _ := procWTSGetActiveConsoleSessionId.Call()
	sid := uint32(r)
	if sid == 0xFFFFFFFF {
		return 0, false
	}
	return sid, true
}

func candidateUserSessionIDs() []uint32 {
	seen := make(map[uint32]struct{})
	var out []uint32
	if sid, ok := activeConsoleSessionID(); ok {
		seen[sid] = struct{}{}
		out = append(out, sid)
	}
	var infos uintptr
	var count uint32
	ok, _, _ := procWTSEnumerateSessionsW.Call(
		0, 0, 1,
		uintptr(unsafe.Pointer(&infos)),
		uintptr(unsafe.Pointer(&count)),
	)
	if ok == 0 || infos == 0 {
		return out
	}
	defer procWTSFreeMemory.Call(infos)
	const entrySize = 24
	for i := uint32(0); i < count; i++ {
		row := (*wtsSessionInfo)(unsafe.Pointer(infos + uintptr(i)*entrySize))
		if row.state != wtsActive {
			continue
		}
		if _, exists := seen[row.sessionID]; exists {
			continue
		}
		seen[row.sessionID] = struct{}{}
		out = append(out, row.sessionID)
	}
	return out
}

// launchProcessInUserSessions is for dev/test (test-tray.ps1). Production tray uses logon Run key, not SYSTEM.
func launchProcessInUserSessions(image string, args []string, workDir string) error {
	image, err := filepath.Abs(image)
	if err != nil {
		return err
	}
	argv := append([]string{image}, args...)
	cmdLineBuf, err := syscall.UTF16FromString(composeWindowsCommandLine(argv))
	if err != nil {
		return fmt.Errorf("command line utf16: %w", err)
	}
	if workDir == "" {
		workDir, _ = filepath.Split(image)
	}

	sessionIDs := candidateUserSessionIDs()
	if len(sessionIDs) == 0 {
		return fmt.Errorf("활성 사용자 세션이 없습니다")
	}

	var lastErr error
	for _, sessionID := range sessionIDs {
		var userToken windows.Handle
		ok, _, errno := procWTSQueryUserToken.Call(
			uintptr(sessionID),
			uintptr(unsafe.Pointer(&userToken)),
		)
		if ok == 0 {
			lastErr = errno
			continue
		}

		var primaryToken windows.Handle
		ok, _, errno = procDuplicateTokenEx.Call(
			uintptr(userToken),
			uintptr(tokenAssignPrimary|tokenDuplicate|tokenQuery|tokenAdjustDefault|tokenAdjustSessionID),
			0,
			uintptr(securityImpersonation),
			uintptr(tokenPrimary),
			uintptr(unsafe.Pointer(&primaryToken)),
		)
		windows.CloseHandle(userToken)
		if ok == 0 {
			lastErr = errno
			continue
		}

		var envBlock uintptr
		_, _, _ = procCreateEnvironmentBlock.Call(
			uintptr(unsafe.Pointer(&envBlock)),
			uintptr(primaryToken),
			0,
		)
		if envBlock != 0 {
			defer procDestroyEnvironmentBlock.Call(envBlock)
		}

		var si windows.StartupInfo
		si.Cb = uint32(unsafe.Sizeof(si))
		si.Desktop = windows.StringToUTF16Ptr("winsta0\\default")
		si.Flags = startfUseShowWindow
		si.ShowWindow = swHide
		var pi windows.ProcessInformation

		creationFlags := uint32(windows.CREATE_NEW_PROCESS_GROUP)
		if envBlock != 0 {
			creationFlags |= createUnicodeEnv
		}
		var wd *uint16
		if workDir != "" {
			wd = windows.StringToUTF16Ptr(workDir)
		}

		ok, _, errno = procCreateProcessAsUserW.Call(
			uintptr(primaryToken),
			0,
			uintptr(unsafe.Pointer(&cmdLineBuf[0])),
			0, 0, 0,
			uintptr(creationFlags),
			envBlock,
			uintptr(unsafe.Pointer(wd)),
			uintptr(unsafe.Pointer(&si)),
			uintptr(unsafe.Pointer(&pi)),
		)
		windows.CloseHandle(primaryToken)
		if ok == 0 {
			lastErr = errno
			continue
		}
		windows.CloseHandle(pi.Thread)
		windows.CloseHandle(pi.Process)
		log.Printf("user-session process started (session %d PID %d image=%s args=%v)", sessionID, pi.ProcessId, image, args)
		return nil
	}
	if lastErr != nil {
		return fmt.Errorf("CreateProcessAsUser %v: %w", args, lastErr)
	}
	return fmt.Errorf("사용자 세션에서 프로세스를 시작하지 못했습니다: %v", args)
}

func launchAgentModeInActiveUserSession(extraArgs ...string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return launchProcessInUserSessions(exe, extraArgs, "")
}

func launchTrayInActiveUserSession() error {
	return launchAgentModeInActiveUserSession("--tray")
}
