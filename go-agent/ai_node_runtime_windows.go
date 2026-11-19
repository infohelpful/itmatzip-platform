//go:build windows

package main

// Portable Node.js for the AI MCP "설치" buttons. Ordinary users do not have Node.js/npm, so when npm
// is missing the agent downloads the official Node.js LTS zip (SHA-256 checked against nodejs.org's
// SHASUMS256.txt) into %LOCALAPPDATA%\ItMatZip\nodejs — per user, no admin/UAC — and adds it plus
// the npm global prefix (%APPDATA%\npm) to the user PATH so the installed CLIs also work in a terminal.

import (
	"archive/zip"
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const nodeDistBaseURL = "https://nodejs.org/dist/"

func portableNodeDir() string {
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "ItMatZip", "nodejs")
}

func userNpmPrefix() string {
	return filepath.Join(os.Getenv("APPDATA"), "npm")
}

func isPortableNode(path string) bool {
	rel, err := filepath.Rel(portableNodeDir(), path)
	return err == nil && !strings.HasPrefix(rel, "..")
}

// ensureNodeRuntime makes node + npm available, installing portable Node.js LTS when absent.
func ensureNodeRuntime() error {
	if aiToolPath("npm") != "" && aiToolPath("node") != "" {
		return nil
	}
	client := &http.Client{Timeout: 15 * time.Minute}
	version, err := latestNodeLTSVersion(client)
	if err != nil {
		return fmt.Errorf("Node.js 버전 정보를 받지 못했습니다 (인터넷 연결 확인): %w", err)
	}
	zipName := fmt.Sprintf("node-%s-win-x64.zip", version)
	wantSum, err := nodeZipSHA256(client, version, zipName)
	if err != nil {
		return fmt.Errorf("Node.js 검증 정보를 받지 못했습니다: %w", err)
	}

	parent := filepath.Dir(portableNodeDir())
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	zipPath := filepath.Join(parent, zipName+".part")
	defer os.Remove(zipPath)
	if err := downloadWithSHA256(client, nodeDistBaseURL+version+"/"+zipName, zipPath, wantSum); err != nil {
		return fmt.Errorf("Node.js 다운로드 실패: %w", err)
	}

	stage := portableNodeDir() + ".new"
	_ = os.RemoveAll(stage)
	if err := extractZipStripTop(zipPath, stage); err != nil {
		_ = os.RemoveAll(stage)
		return fmt.Errorf("Node.js 압축 해제 실패: %w", err)
	}
	if _, err := os.Stat(filepath.Join(stage, "node.exe")); err != nil {
		_ = os.RemoveAll(stage)
		return fmt.Errorf("Node.js 압축 파일에 node.exe 가 없습니다")
	}
	_ = os.RemoveAll(portableNodeDir())
	if err := os.Rename(stage, portableNodeDir()); err != nil {
		return fmt.Errorf("Node.js 설치 폴더 준비 실패: %w", err)
	}
	if err := os.MkdirAll(userNpmPrefix(), 0o755); err != nil {
		return err
	}
	if err := addToUserPath(portableNodeDir(), userNpmPrefix()); err != nil {
		// Not fatal: the agent resolves both folders itself; only terminal use would need PATH.
		fmt.Fprintf(os.Stderr, "ai-mcp: could not update user PATH: %v\n", err)
	}
	if aiToolPath("npm") == "" {
		return fmt.Errorf("Node.js 설치 후 npm 을 찾지 못했습니다")
	}
	return nil
}

func latestNodeLTSVersion(client *http.Client) (string, error) {
	res, err := client.Get(nodeDistBaseURL + "index.json")
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", res.StatusCode)
	}
	var releases []struct {
		Version string          `json:"version"`
		LTS     json.RawMessage `json:"lts"`
		Files   []string        `json:"files"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(&releases); err != nil {
		return "", err
	}
	for _, r := range releases { // newest first
		if string(r.LTS) == "false" || len(r.LTS) == 0 {
			continue
		}
		for _, f := range r.Files {
			if f == "win-x64-zip" {
				return r.Version, nil
			}
		}
	}
	return "", fmt.Errorf("LTS 버전을 찾지 못했습니다")
}

func nodeZipSHA256(client *http.Client, version, zipName string) (string, error) {
	res, err := client.Get(nodeDistBaseURL + version + "/SHASUMS256.txt")
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", res.StatusCode)
	}
	sc := bufio.NewScanner(io.LimitReader(res.Body, 1<<20))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 2 && fields[1] == zipName {
			return strings.ToLower(fields[0]), nil
		}
	}
	return "", fmt.Errorf("%s 체크섬이 없습니다", zipName)
}

func downloadWithSHA256(client *http.Client, url, dst, wantSum string) error {
	res, err := client.Get(url)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(f, h), res.Body)
	closeErr := f.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != wantSum {
		return fmt.Errorf("체크섬 불일치 (%s)", got)
	}
	return nil
}

// extractZipStripTop extracts zipPath into dest, dropping the single top-level folder
// (node-vX-win-x64/...). Entries escaping dest are rejected.
func extractZipStripTop(zipPath, dest string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer zr.Close()
	destAbs, err := filepath.Abs(dest)
	if err != nil {
		return err
	}
	for _, f := range zr.File {
		name := strings.ReplaceAll(f.Name, "\\", "/")
		if i := strings.Index(name, "/"); i >= 0 {
			name = name[i+1:]
		} else {
			continue
		}
		if name == "" {
			continue
		}
		target := filepath.Join(destAbs, filepath.FromSlash(name))
		if rel, err := filepath.Rel(destAbs, target); err != nil || strings.HasPrefix(rel, "..") {
			return fmt.Errorf("잘못된 압축 경로: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := extractZipFile(f, target); err != nil {
			return err
		}
	}
	return nil
}

func extractZipFile(f *zip.File, target string) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.Create(target)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, rc); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// addToUserPath appends dirs to HKCU\Environment\Path (if missing), updates this process's PATH
// and notifies Explorer so newly opened terminals see the change.
func addToUserPath(dirs ...string) error {
	key, err := registry.OpenKey(registry.CURRENT_USER, "Environment", registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	current, _, err := key.GetStringValue("Path")
	if err != nil && err != registry.ErrNotExist {
		return err
	}
	parts := strings.Split(current, ";")
	has := func(dir string) bool {
		for _, p := range parts {
			if strings.EqualFold(strings.TrimRight(strings.TrimSpace(p), `\`), strings.TrimRight(dir, `\`)) {
				return true
			}
		}
		return false
	}
	changed := false
	for _, dir := range dirs {
		if !has(dir) {
			if strings.TrimSpace(current) != "" && !strings.HasSuffix(current, ";") {
				current += ";"
			}
			current += dir
			parts = append(parts, dir)
			changed = true
		}
		if !strings.Contains(strings.ToLower(os.Getenv("PATH")), strings.ToLower(dir)) {
			_ = os.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
		}
	}
	if !changed {
		return nil
	}
	if err := key.SetExpandStringValue("Path", current); err != nil {
		return err
	}
	broadcastEnvironmentChange()
	return nil
}

func broadcastEnvironmentChange() {
	const (
		hwndBroadcast   = 0xFFFF
		wmSettingChange = 0x001A
		smtoAbortIfHung = 0x0002
	)
	env, err := windows.UTF16PtrFromString("Environment")
	if err != nil {
		return
	}
	proc := windows.NewLazySystemDLL("user32.dll").NewProc("SendMessageTimeoutW")
	var result uintptr
	_, _, _ = proc.Call(hwndBroadcast, wmSettingChange, 0, uintptr(unsafe.Pointer(env)), smtoAbortIfHung, 3000,
		uintptr(unsafe.Pointer(&result)))
}
