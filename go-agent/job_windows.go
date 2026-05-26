//go:build windows

package main

import (
	"log"
	"unsafe"

	"golang.org/x/sys/windows"
)

var jobObjectHandle windows.Handle

func initJobObject() {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		log.Printf("warning: CreateJobObject failed: %v", err)
		return
	}

	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE

	_, err = windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	)
	if err != nil {
		log.Printf("warning: SetInformationJobObject failed: %v", err)
		windows.CloseHandle(job)
		return
	}

	proc := windows.CurrentProcess()
	err = windows.AssignProcessToJobObject(job, proc)
	if err != nil {
		log.Printf("warning: AssignProcessToJobObject failed: %v (process may already be in a job)", err)
		windows.CloseHandle(job)
		return
	}

	jobObjectHandle = job
	log.Print("job object initialized: child processes will be terminated on agent exit")
}
