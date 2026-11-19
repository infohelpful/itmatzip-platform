//go:build windows

package main

// AI CLI login (Codex / Claude / Antigravity). The CLI runs hidden in the background — it has to keep
// running to receive the OAuth callback — and prints its login address. We read that address from
// its output, open it in the default browser ourselves and hand it to the settings page as a link,
// so users never depend on the CLI being able to open a browser or on reading a console window.

import (
	"fmt"
	"io"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	aiLoginURLWait     = 25 * time.Second
	aiLoginMaxLifetime = 15 * time.Minute
)

// https only: Codex also prints its local callback server (http://localhost:1455), which is not
// the page to open.
// openLoginURL opens the login page in the default browser (replaced in tests).
var openLoginURL = shellOpen

var aiLoginURLPattern = regexp.MustCompile(`https://[^\s"'<>\x00-\x1f\x7f]+`)

var (
	aiLoginMu      sync.Mutex
	aiLoginRunning = map[string]*aiLoginSession{}
)

type aiLoginSession struct {
	url  string
	done chan struct{}
}

// startAILogin starts `name args...`, waits for the login URL it prints, opens it in the browser and
// returns it. A second click while the same login is still waiting reuses that session.
func startAILogin(name string, args ...string) (string, error) {
	aiLoginMu.Lock()
	if s := aiLoginRunning[name]; s != nil {
		select {
		case <-s.done:
		default:
			url := s.url
			aiLoginMu.Unlock()
			if url != "" {
				_ = openLoginURL(url)
				return url, nil
			}
			return "", fmt.Errorf("로그인을 준비하는 중입니다. 잠시 후 다시 눌러 주세요")
		}
	}
	aiLoginMu.Unlock()

	cmd, err := newAICommand(name, args...)
	if err != nil {
		return "", err
	}
	pr, pw := io.Pipe()
	cmd.Stdin = nil
	cmd.Stdout = pw
	cmd.Stderr = pw
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("로그인을 시작하지 못했습니다: %w", err)
	}
	session := &aiLoginSession{done: make(chan struct{})}
	aiLoginMu.Lock()
	aiLoginRunning[name] = session
	aiLoginMu.Unlock()

	found := make(chan string, 1)
	var outMu sync.Mutex
	var output strings.Builder
	go func() {
		buf := make([]byte, 4096)
		sent := false
		for {
			n, err := pr.Read(buf)
			if n > 0 {
				outMu.Lock()
				if output.Len() < 64<<10 {
					output.Write(buf[:n])
				}
				text := output.String()
				outMu.Unlock()
				if !sent {
					if url := completeLoginURL(text); url != "" {
						sent = true
						found <- url
					}
				}
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		timer := time.AfterFunc(aiLoginMaxLifetime, func() { _ = cmd.Process.Kill() })
		err := cmd.Wait()
		timer.Stop()
		_ = pw.Close()
		close(session.done)
		if err != nil {
			log.Printf("ai-login: %s exited: %v", name, err)
		}
	}()

	select {
	case url := <-found:
		aiLoginMu.Lock()
		session.url = url
		aiLoginMu.Unlock()
		if err := openLoginURL(url); err != nil {
			log.Printf("ai-login: open browser failed: %v", err)
		}
		return url, nil
	case <-session.done:
		// Exited without printing a login URL: usually "already logged in" — let the status decide.
		outMu.Lock()
		tail := lastLines(output.String(), 3)
		outMu.Unlock()
		if loggedIn, known := aiClientLoggedInByName(name); known && loggedIn {
			return "", nil
		}
		return "", fmt.Errorf("로그인 주소를 받지 못했습니다: %s", tail)
	case <-time.After(aiLoginURLWait):
		return "", fmt.Errorf("로그인 주소가 나오지 않았습니다. 잠시 후 다시 눌러 주세요")
	}
}

// completeLoginURL returns the first https URL that is followed by a delimiter (so it is not cut
// off at a read boundary), or "".
func completeLoginURL(text string) string {
	for _, loc := range aiLoginURLPattern.FindAllStringIndex(text, -1) {
		if loc[1] < len(text) {
			return strings.TrimRight(text[loc[0]:loc[1]], ".,);]")
		}
	}
	return ""
}

func lastLines(text string, n int) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.TrimSpace(strings.Join(lines, " "))
}

func aiClientLoggedInByName(name string) (bool, bool) {
	switch name {
	case "codex":
		return aiClientLoggedIn("codex")
	case "claude":
		return aiClientLoggedIn("claude")
	}
	return false, false
}
