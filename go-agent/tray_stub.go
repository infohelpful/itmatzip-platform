//go:build !windows

package main

func runTray(int) error             { return nil }
func registerTrayAutostart() error  { return nil }
func unregisterTrayAutostart() error { return nil }
func launchTrayProcess() error      { return nil }
