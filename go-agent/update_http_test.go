package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestUpdateHTTPHandlerRejectsUntrustedOrigins(t *testing.T) {
	handler := updateHTTPHandler(&updateManager{})
	for _, origin := range []string{"", "https://example.com", "null"} {
		req := httptest.NewRequest(http.MethodPost, "/api/agent/update", nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		if res.Code != http.StatusForbidden {
			t.Errorf("origin %q: got %d, want 403", origin, res.Code)
		}
	}
}

func TestUpdateHTTPHandlerExposesStatusOnlyToTrustedOrigin(t *testing.T) {
	handler := updateHTTPHandler(&updateManager{})
	req := httptest.NewRequest(http.MethodGet, "/api/agent/update", nil)
	req.Header.Set("Origin", "https://tools.itmatzip.com")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", res.Code)
	}
	if res.Body.String() == "" {
		t.Fatal("empty updater status")
	}
}
