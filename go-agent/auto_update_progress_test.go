package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestDownloadMSIReportsProgressAndPhaseMessages(t *testing.T) {
	body := strings.Repeat("x", 256<<10)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "262144")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	u := &updateManager{updatesRoot: t.TempDir()}
	m := &UpdateManifest{Version: "9.9.9", MSIDownloadURL: srv.URL + "/a.msi"}
	if err := u.downloadMSI(context.Background(), m, filepath.Join(u.updatesRoot, "a.msi")); err != nil {
		t.Fatal(err)
	}
	snap := u.snapshot()
	if snap.DownloadTotal != int64(len(body)) || snap.DownloadBytes != int64(len(body)) {
		t.Fatalf("progress = %d/%d, want %d/%d", snap.DownloadBytes, snap.DownloadTotal, len(body), len(body))
	}

	payload := map[string]any{}
	globalUpdateManager, u.state.Phase = u, "awaiting_admin"
	defer func() { globalUpdateManager = nil }()
	mergeUpdateHealth(payload)
	if payload["update_phase"] != "awaiting_admin" || payload["update_download_total"] != int64(len(body)) {
		t.Fatalf("health payload missing progress/phase: %v", payload)
	}
	if !strings.Contains(msiUpdaterErrorMessage(1223, "x"), "승인이 취소") {
		t.Fatal("UAC cancel must have a clear message")
	}
}
