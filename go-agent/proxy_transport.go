package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

const (
	proxyReadyCacheTTL    = 2 * time.Second
	healthStickyMaxStreak = 120
	watchdogBusyMinStreak = 120
	watchdogTickInterval  = 30 * time.Second
)

var defaultProxyDialer = &net.Dialer{
	Timeout:   10 * time.Second,
	KeepAlive: 30 * time.Second,
}

func proxyTimeoutForPath(path string) time.Duration {
	p := strings.ToLower(path)
	switch {
	case strings.HasSuffix(p, "/health") || strings.Contains(p, "/status"):
		return 8 * time.Second
	case strings.Contains(p, "video-burn-in/frame"):
		return 45 * time.Minute
	case strings.Contains(p, "/media/stream"), strings.Contains(p, "/download"):
		return 45 * time.Minute
	case strings.Contains(p, "/export"):
		return 45 * time.Minute
	case strings.Contains(p, "waveform"):
		return 20 * time.Minute
	case strings.Contains(p, "/prepare"), strings.Contains(p, "/transcribe"), strings.Contains(p, "/analyze"):
		return 65 * time.Minute
	default:
		return 3 * time.Minute
	}
}

func newProxyBaseTransport() *http.Transport {
	return &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           defaultProxyDialer.DialContext,
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          50,
		MaxIdleConnsPerHost:   10,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ResponseHeaderTimeout: 0,
	}
}

type contextTimeoutTransport struct {
	base http.RoundTripper
}

func (t *contextTimeoutTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	timeout := proxyTimeoutForPath(req.URL.Path)
	ctx, cancel := context.WithTimeout(req.Context(), timeout)
	resp, err := t.base.RoundTrip(req.WithContext(ctx))
	if err != nil {
		cancel()
		return nil, err
	}
	resp.Body = &cancelOnCloseBody{ReadCloser: resp.Body, cancel: cancel}
	return resp, nil
}

type cancelOnCloseBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b *cancelOnCloseBody) Close() error {
	err := b.ReadCloser.Close()
	b.cancel()
	return err
}

func newFastAPIProxyTransport() http.RoundTripper {
	return &contextTimeoutTransport{base: newProxyBaseTransport()}
}
