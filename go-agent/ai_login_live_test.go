//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Live, real CLIs: on a user profile where the CLI was never used (like a fresh remote PC) the login
// must still yield a login URL that we open. ITMATZIP_LIVE_AI_LOGIN=1. The real profile is not
// touched (USERPROFILE -> empty temp folder) and our browser opener is stubbed; the CLI itself may
// still open a browser tab on its own.
func TestLiveAILoginOnFreshProfile(t *testing.T) {
	if os.Getenv("ITMATZIP_LIVE_AI_LOGIN") != "1" {
		t.Skip("set ITMATZIP_LIVE_AI_LOGIN=1")
	}
	cases := []struct {
		name, id   string
		args       []string
		urlPrefix  string
		statusKnow bool
	}{
		{"codex", "codex", []string{"login"}, "https://auth.openai.com/", true},
		{"claude", "claude", []string{"auth", "login"}, "https://claude.", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path := aiToolPath(c.name)
			if path == "" {
				t.Skip(c.name + " not installed")
			}
			profile := t.TempDir()
			t.Setenv("USERPROFILE", profile)
			t.Setenv("PATH", filepath.Dir(path)+string(os.PathListSeparator)+os.Getenv("PATH"))
			var opened []string
			old := openLoginURL
			openLoginURL = func(u string) error { opened = append(opened, u); return nil }
			t.Cleanup(func() { openLoginURL = old })
			t.Cleanup(func() { stopAILogin(c.name) })

			if loggedIn, known := aiClientLoggedIn(c.id); loggedIn || known != c.statusKnow {
				t.Fatalf("fresh profile login status = %v/%v", loggedIn, known)
			}
			url, err := startAILogin(c.name, c.args...)
			if err != nil {
				t.Fatalf("login: %v", err)
			}
			if !strings.HasPrefix(url, c.urlPrefix) || len(opened) != 1 {
				t.Fatalf("url=%q opened=%v", url, opened)
			}
			t.Logf("%s login URL: %.70s...", c.name, url)
		})
	}
}
