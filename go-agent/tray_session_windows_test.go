//go:build windows

package main

import (
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestUserEnvironmentHasAppData(t *testing.T) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE, &token); err != nil {
		t.Fatal(err)
	}
	defer token.Close()
	env, err := userEnvironment(token)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, kv := range env {
		if strings.HasPrefix(strings.ToUpper(kv), "APPDATA=") && strings.Contains(kv, `\AppData\Roaming`) {
			found = true
		}
		if !strings.Contains(kv, "=") {
			t.Fatalf("malformed entry %q", kv)
		}
	}
	if !found || len(env) < 5 {
		t.Fatalf("APPDATA not found in %d entries", len(env))
	}
}

func TestRunningAsLocalSystemFalseForUser(t *testing.T) {
	if runningAsLocalSystem() {
		t.Fatal("test runs as a normal user, not SYSTEM")
	}
}
