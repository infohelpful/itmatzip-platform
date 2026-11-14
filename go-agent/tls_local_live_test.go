package main

// Opt-in end-to-end check of the real certificate bundle. It is skipped unless ITMATZIP_TEST_BUNDLE points
// at a bundle.json produced by scripts/local-cert/issue-local-cert.ps1:
//
//	$env:ITMATZIP_TEST_BUNDLE="$env:LOCALAPPDATA\itmatzip-local-cert\out\bundle.json"
//	go test -run TestLiveLocalTLS -count=1 -v ./
//
// It needs local.itmatzip.com to resolve to 127.0.0.1 (public DNS) and trusts the machine's normal root store,
// so a pass proves that browsers will accept the certificate too.

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func freeLoopbackPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestLiveLocalTLS(t *testing.T) {
	bundlePath := os.Getenv("ITMATZIP_TEST_BUNDLE")
	if bundlePath == "" {
		t.Skip("set ITMATZIP_TEST_BUNDLE to run the live certificate check")
	}
	raw, err := os.ReadFile(bundlePath)
	if err != nil {
		t.Fatal(err)
	}

	oldRoot := settingsRootPath
	settingsRootPath = t.TempDir()
	defer func() { settingsRootPath = oldRoot }()
	if err := saveCertToDisk(raw); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(settingsRootPath, "tls", localTLSHostname+".json")); err != nil {
		t.Fatal(err)
	}
	// Keep the test offline: the downloader must fall back to the cached bundle.
	t.Setenv(certBundleURLEnv, "https://127.0.0.1:1/unreachable.json")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	port := freeLoopbackPort(t)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok")
	})
	startLocalTLSServer(ctx, handler, port)

	client := &http.Client{Timeout: 3 * time.Second}
	url := fmt.Sprintf("https://%s:%d/", localTLSHostname, port)
	var (
		resp    *http.Response
		lastErr error
	)
	for i := 0; i < 50; i++ {
		resp, lastErr = client.Get(url)
		if lastErr == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if lastErr != nil {
		t.Fatalf("GET %s: %v", url, lastErr)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "ok" {
		t.Fatalf("unexpected response %d %q", resp.StatusCode, body)
	}
	if resp.TLS == nil || resp.TLS.Version < tls.VersionTLS12 || len(resp.TLS.VerifiedChains) == 0 {
		t.Fatalf("certificate was not verified against the system roots: %+v", resp.TLS)
	}
	leaf := resp.TLS.PeerCertificates[0]
	t.Logf("verified %s (TLS 0x%x), issuer %s, valid until %s",
		leaf.DNSNames, resp.TLS.Version, leaf.Issuer.CommonName, leaf.NotAfter.Format(time.RFC3339))
}

// TestLiveDownload exercises the real download path against the production URL (no local copy, default URL).
// Run with ITMATZIP_TEST_DOWNLOAD=1 after uploading bundle.json to https://tools.itmatzip.com/agent-cert/.
func TestLiveDownload(t *testing.T) {
	if os.Getenv("ITMATZIP_TEST_DOWNLOAD") == "" {
		t.Skip("set ITMATZIP_TEST_DOWNLOAD=1 to run the live download check")
	}
	oldRoot := settingsRootPath
	settingsRootPath = t.TempDir()
	defer func() { settingsRootPath = oldRoot }()
	t.Setenv(certBundleURLEnv, "")

	holder := &localCertHolder{}
	if !refreshLocalCert(context.Background(), holder) || holder.get() == nil {
		t.Fatal("could not download a valid certificate bundle from the default URL")
	}
	if _, err := os.Stat(localCertPath()); err != nil {
		t.Fatalf("downloaded bundle was not cached: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	port := freeLoopbackPort(t)
	startLocalTLSServer(ctx, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "ok") }), port)
	client := &http.Client{Timeout: 3 * time.Second}
	var lastErr error
	for i := 0; i < 50; i++ {
		var resp *http.Response
		if resp, lastErr = client.Get(fmt.Sprintf("https://%s:%d/", localTLSHostname, port)); lastErr == nil {
			resp.Body.Close()
			t.Logf("downloaded cert valid until %s", holder.get().notAfter.Format(time.RFC3339))
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("https server did not come up: %v", lastErr)
}
