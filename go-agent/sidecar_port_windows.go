//go:build windows

package main

import (
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// freeSidecarPort makes sure the sidecar port is not held by a leftover sidecar (our own engine
// python.exe from an earlier agent run or an interrupted update). Such a process makes the new
// uvicorn exit immediately with "address already in use". Processes that are not our engine Python
// are never touched.
func freeSidecarPort(port int, pythonPath string) {
	if !isPortListening(port) {
		return
	}
	pids, err := tcpListenerPIDs(port)
	if err != nil {
		log.Printf("fastapi sidecar: port %d busy, owner lookup failed: %v", port, err)
		return
	}
	want, _ := filepath.Abs(pythonPath)
	for _, pid := range pids {
		image, err := processImagePath(pid)
		if err != nil {
			continue
		}
		if !strings.EqualFold(filepath.Clean(image), filepath.Clean(want)) {
			log.Printf("fastapi sidecar: port %d is held by another program (pid=%d %s)", port, pid, image)
			continue
		}
		h, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, pid)
		if err != nil {
			log.Printf("fastapi sidecar: cannot stop leftover sidecar pid=%d: %v", pid, err)
			continue
		}
		_ = windows.TerminateProcess(h, 1)
		_, _ = windows.WaitForSingleObject(h, 3000)
		_ = windows.CloseHandle(h)
		log.Printf("fastapi sidecar: stopped leftover sidecar pid=%d holding port %d", pid, port)
	}
	for i := 0; i < 20 && isPortListening(port); i++ {
		time.Sleep(100 * time.Millisecond)
	}
}

func processImagePath(pid uint32) (string, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	size := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &size); err != nil {
		return "", err
	}
	return windows.UTF16ToString(buf[:size]), nil
}

// tcpListenerPIDs returns the PIDs listening on 127.0.0.1/0.0.0.0:port (IPv4) via GetExtendedTcpTable.
func tcpListenerPIDs(port int) ([]uint32, error) {
	const (
		afInet                = 2
		tcpTableOwnerPIDListn = 3 // TCP_TABLE_OWNER_PID_LISTENER
	)
	proc := windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetExtendedTcpTable")
	var size uint32
	_, _, _ = proc.Call(0, uintptr(unsafe.Pointer(&size)), 0, afInet, tcpTableOwnerPIDListn, 0)
	if size == 0 {
		return nil, fmt.Errorf("GetExtendedTcpTable: empty size")
	}
	buf := make([]byte, size)
	ret, _, _ := proc.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 0, afInet, tcpTableOwnerPIDListn, 0)
	if ret != 0 {
		return nil, fmt.Errorf("GetExtendedTcpTable: %d", ret)
	}
	// MIB_TCPTABLE_OWNER_PID: DWORD count, then rows of {state, localAddr, localPort, remoteAddr, remotePort, pid}.
	count := *(*uint32)(unsafe.Pointer(&buf[0]))
	const rowSize = 24
	var pids []uint32
	for i := uint32(0); i < count; i++ {
		off := 4 + int(i)*rowSize
		if off+rowSize > len(buf) {
			break
		}
		row := (*[6]uint32)(unsafe.Pointer(&buf[off]))
		localPort := int(row[2]&0xff)<<8 | int(row[2]>>8&0xff) // network byte order in the low 16 bits
		if localPort == port {
			pids = append(pids, row[5])
		}
	}
	return pids, nil
}
