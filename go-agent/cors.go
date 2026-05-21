package main

import (
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

var corsOriginPattern = regexp.MustCompile(
	`^https://([\w-]+\.)*itmatzip\.com$|^http://(localhost|127\.0\.0\.1)(:\d+)?$`,
)

func allowCORSOrigin(origin string) bool {
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	switch host {
	case "tools.itmatzip.com", "silence.itmatzip.com", "127.0.0.1", "localhost", "::1", "[::1]":
		return true
	}
	if strings.HasSuffix(host, ".localhost") {
		return true
	}
	return corsOriginPattern.MatchString(strings.TrimSuffix(origin, "/"))
}

func stripUpstreamCORS(h http.Header) {
	for _, key := range []string{
		"Access-Control-Allow-Origin",
		"Access-Control-Allow-Methods",
		"Access-Control-Allow-Headers",
		"Access-Control-Expose-Headers",
		"Access-Control-Allow-Private-Network",
		"Access-Control-Allow-Credentials",
	} {
		h.Del(key)
	}
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if allowCORSOrigin(origin) {
			if origin != "" {
				w.Header().Set("Access-Control-Allow-Origin", origin)
			} else {
				w.Header().Set("Access-Control-Allow-Origin", "*")
			}
			w.Header().Add("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		w.Header().Set("Access-Control-Expose-Headers", "*")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
