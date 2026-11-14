package main

// HTTPS listener for https://local.itmatzip.com:<tlsPort>.
//
// local.itmatzip.com is a public DNS name that resolves to 127.0.0.1, so a page served from
// https://tools.itmatzip.com can talk to this agent over HTTPS without Mixed Content and without a
// host name that ad blockers treat as "LAN intrusion" (127.0.0.1 / localhost literals).
//
// The certificate is issued for local.itmatzip.com only and is delivered as a JSON bundle from a
// static URL, so renewals do not require shipping a new agent build. Everything here is best-effort:
// without a valid certificate the listener simply does not start and the plain-HTTP port keeps
// working, which is also what the web UI falls back to.

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	defaultTLSPort       = 19878
	localTLSHostname     = "local.itmatzip.com"
	defaultCertBundleURL = "https://tools.itmatzip.com/agent-cert/bundle.json"
	certBundleURLEnv     = "ITMATZIP_AGENT_CERT_URL"
	certRefreshInterval  = 24 * time.Hour
	certRetryInterval    = 15 * time.Minute
	certBundleMaxBytes   = 256 << 10
	certMinRemaining     = 24 * time.Hour
)

// localTLSPort is set from the -tls-port flag (0 disables the HTTPS listener).
var localTLSPort = defaultTLSPort

// certBundle is the wire/disk format. Only the PEM fields are trusted; everything is re-validated.
type certBundle struct {
	Hostname string `json:"hostname"`
	CertPEM  string `json:"cert_pem"`
	KeyPEM   string `json:"key_pem"`
}

type localCert struct {
	pair     tls.Certificate
	notAfter time.Time
}

// parseCertBundle validates a bundle for local.itmatzip.com and returns the usable certificate.
func parseCertBundle(raw []byte, now time.Time) (*localCert, error) {
	var b certBundle
	if err := json.Unmarshal(raw, &b); err != nil {
		return nil, fmt.Errorf("decode bundle: %w", err)
	}
	if h := strings.ToLower(strings.TrimSpace(b.Hostname)); h != "" && h != localTLSHostname {
		return nil, fmt.Errorf("bundle is for %q, want %q", b.Hostname, localTLSHostname)
	}
	pair, err := tls.X509KeyPair([]byte(b.CertPEM), []byte(b.KeyPEM))
	if err != nil {
		return nil, fmt.Errorf("load key pair: %w", err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("parse leaf: %w", err)
	}
	if err := leaf.VerifyHostname(localTLSHostname); err != nil {
		return nil, fmt.Errorf("certificate does not cover %s: %w", localTLSHostname, err)
	}
	if now.Before(leaf.NotBefore.Add(-5 * time.Minute)) {
		return nil, fmt.Errorf("certificate not valid before %s", leaf.NotBefore.Format(time.RFC3339))
	}
	if now.After(leaf.NotAfter) {
		return nil, fmt.Errorf("certificate expired at %s", leaf.NotAfter.Format(time.RFC3339))
	}
	pair.Leaf = leaf
	return &localCert{pair: pair, notAfter: leaf.NotAfter}, nil
}

// localCertHolder lets the listener pick up renewed certificates without restarting.
type localCertHolder struct {
	mu   sync.RWMutex
	cert *localCert
}

func (h *localCertHolder) get() *localCert {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.cert
}

// offer installs c when there is no usable certificate yet or c outlives the current one.
func (h *localCertHolder) offer(c *localCert, now time.Time) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.cert != nil && now.Before(h.cert.notAfter) && !c.notAfter.After(h.cert.notAfter) {
		return false
	}
	h.cert = c
	return true
}

func (h *localCertHolder) getCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	c := h.get()
	if c == nil {
		return nil, errors.New("no local certificate available")
	}
	return &c.pair, nil
}

func localCertPath() string {
	return filepath.Join(settingsRootPath, "tls", localTLSHostname+".json")
}

func loadCertFromDisk(h *localCertHolder, now time.Time) error {
	raw, err := os.ReadFile(localCertPath())
	if err != nil {
		return err
	}
	c, err := parseCertBundle(raw, now)
	if err != nil {
		return err
	}
	h.offer(c, now)
	return nil
}

func saveCertToDisk(raw []byte) error {
	path := localCertPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func certBundleURL() (string, error) {
	raw := strings.TrimSpace(os.Getenv(certBundleURLEnv))
	if raw == "" {
		raw = defaultCertBundleURL
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return "", fmt.Errorf("%s must be an https URL", certBundleURLEnv)
	}
	return u.String(), nil
}

func fetchCertBundle(ctx context.Context, bundleURL string) ([]byte, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, bundleURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Cache-Control", "no-cache")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, certBundleMaxBytes))
}

// refreshLocalCert downloads the bundle, validates it and installs it. It returns true when the
// holder now has a usable certificate.
func refreshLocalCert(ctx context.Context, h *localCertHolder) bool {
	bundleURL, err := certBundleURL()
	if err != nil {
		log.Printf("tls: %v", err)
		return h.get() != nil
	}
	raw, err := fetchCertBundle(ctx, bundleURL)
	if err != nil {
		log.Printf("tls: fetch certificate bundle failed: %v", err)
		return h.get() != nil
	}
	now := time.Now()
	c, err := parseCertBundle(raw, now)
	if err != nil {
		log.Printf("tls: rejected downloaded certificate bundle: %v", err)
		return h.get() != nil
	}
	if h.offer(c, now) {
		if err := saveCertToDisk(raw); err != nil {
			log.Printf("tls: could not cache certificate: %v", err)
		}
		log.Printf("tls: using certificate for %s valid until %s", localTLSHostname, c.notAfter.Format(time.RFC3339))
	}
	return true
}

// startLocalTLSServer serves handler over HTTPS on 127.0.0.1:port once a valid certificate exists.
// It never blocks and never fails the agent: problems are logged and retried later.
func startLocalTLSServer(ctx context.Context, handler http.Handler, port int) {
	if port <= 0 {
		return
	}
	holder := &localCertHolder{}
	if err := loadCertFromDisk(holder, time.Now()); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("tls: cached certificate unusable: %v", err)
	}

	var startOnce sync.Once
	startListener := func() {
		startOnce.Do(func() {
			addr := net.JoinHostPort(defaultHost, fmt.Sprintf("%d", port))
			ln, err := net.Listen("tcp", addr)
			if err != nil {
				log.Printf("tls: cannot listen on %s: %v", addr, err)
				return
			}
			srv := &http.Server{
				Handler:      handler,
				ReadTimeout:  120 * time.Second,
				WriteTimeout: 0,
				IdleTimeout:  300 * time.Second,
				TLSConfig: &tls.Config{
					MinVersion:     tls.VersionTLS12,
					GetCertificate: holder.getCertificate,
				},
			}
			go func() {
				<-ctx.Done()
				shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = srv.Shutdown(shutdownCtx)
			}()
			go func() {
				log.Printf("tls: https server on https://%s:%d (loopback only)", localTLSHostname, port)
				if err := srv.ServeTLS(ln, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
					log.Printf("tls: https server stopped: %v", err)
				}
			}()
		})
	}

	go func() {
		for {
			if refreshLocalCert(ctx, holder) || holder.get() != nil {
				startListener()
			}
			wait := certRefreshInterval
			if c := holder.get(); c == nil || time.Until(c.notAfter) < certMinRemaining {
				wait = certRetryInterval
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
		}
	}()
}
