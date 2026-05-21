//go:build windows

package main

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

func shellOpen(target string) error {
	verb, err := windows.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	path, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	se := windows.NewLazySystemDLL("shell32.dll").NewProc("ShellExecuteW")
	ret, _, _ := se.Call(
		0,
		uintptr(unsafe.Pointer(verb)),
		uintptr(unsafe.Pointer(path)),
		0,
		0,
		1,
	)
	if ret <= 32 {
		return fmt.Errorf("ShellExecute failed (code %d)", ret)
	}
	return nil
}
