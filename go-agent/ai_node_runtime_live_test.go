//go:build windows

package main

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Live: downloads the real Node.js LTS zip. Run with ITMATZIP_LIVE_NODE=1.
func TestLivePortableNodeDownload(t *testing.T) {
	if os.Getenv("ITMATZIP_LIVE_NODE") != "1" {
		t.Skip("set ITMATZIP_LIVE_NODE=1")
	}
	client := &http.Client{Timeout: 15 * time.Minute}
	version, err := latestNodeLTSVersion(client)
	if err != nil {
		t.Fatal(err)
	}
	zipName := "node-" + version + "-win-x64.zip"
	sum, err := nodeZipSHA256(client, version, zipName)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	zipPath := filepath.Join(dir, zipName)
	if err := downloadWithSHA256(client, nodeDistBaseURL+version+"/"+zipName, zipPath, sum); err != nil {
		t.Fatal(err)
	}
	if err := downloadWithSHA256(client, nodeDistBaseURL+version+"/SHASUMS256.txt", filepath.Join(dir, "x"), sum); err == nil {
		t.Fatal("checksum mismatch must fail")
	}
	dest := filepath.Join(dir, "nodejs")
	if err := extractZipStripTop(zipPath, dest); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(filepath.Join(dest, "node.exe"), "--version").CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != version {
		t.Fatalf("node --version = %q, %v (want %s)", out, err, version)
	}
	npmOut, err := exec.Command("cmd.exe", "/d", "/c", "call", filepath.Join(dest, "npm.cmd"), "--version").CombinedOutput()
	if err != nil {
		t.Fatalf("npm --version: %s %v", npmOut, err)
	}
	t.Logf("node %s, npm %s", version, strings.TrimSpace(string(npmOut)))
}
