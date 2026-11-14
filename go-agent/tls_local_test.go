package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http/httptest"
	"testing"
	"time"
)

func makeBundle(t *testing.T, hostname string, notBefore, notAfter time.Time) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: hostname},
		DNSNames:     []string{hostname},
		NotBefore:    notBefore,
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(certBundle{
		Hostname: hostname,
		CertPEM:  string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		KeyPEM:   string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})),
	})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestParseCertBundle(t *testing.T) {
	now := time.Now()
	valid := makeBundle(t, localTLSHostname, now.Add(-time.Hour), now.Add(48*time.Hour))

	if c, err := parseCertBundle(valid, now); err != nil || c == nil {
		t.Fatalf("valid bundle rejected: %v", err)
	}
	cases := map[string][]byte{
		"wrong host":  makeBundle(t, "evil.example.com", now.Add(-time.Hour), now.Add(48*time.Hour)),
		"expired":     makeBundle(t, localTLSHostname, now.Add(-72*time.Hour), now.Add(-time.Hour)),
		"not yet":     makeBundle(t, localTLSHostname, now.Add(2*time.Hour), now.Add(48*time.Hour)),
		"garbage":     []byte("not json"),
		"empty":       []byte("{}"),
		"missing key": []byte(`{"hostname":"local.itmatzip.com","cert_pem":"x","key_pem":""}`),
	}
	for name, raw := range cases {
		if _, err := parseCertBundle(raw, now); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestCertHolderKeepsNewestUsableCert(t *testing.T) {
	now := time.Now()
	older, _ := parseCertBundle(makeBundle(t, localTLSHostname, now.Add(-time.Hour), now.Add(24*time.Hour)), now)
	newer, _ := parseCertBundle(makeBundle(t, localTLSHostname, now.Add(-time.Hour), now.Add(80*24*time.Hour)), now)

	h := &localCertHolder{}
	if _, err := h.getCertificate(nil); err == nil {
		t.Fatal("empty holder must not serve a certificate")
	}
	if !h.offer(older, now) || h.get() != older {
		t.Fatal("first certificate must be installed")
	}
	if !h.offer(newer, now) || h.get() != newer {
		t.Fatal("longer-lived certificate must replace the current one")
	}
	if h.offer(older, now) || h.get() != newer {
		t.Fatal("shorter-lived certificate must not replace the current one")
	}
	// An expired current certificate is always replaceable, even by a shorter-lived one.
	if !h.offer(older, newer.notAfter.Add(time.Hour)) || h.get() != older {
		t.Fatal("expired certificate must be replaced")
	}
}

func TestCertBundleURLMustBeHTTPS(t *testing.T) {
	t.Setenv(certBundleURLEnv, "http://example.com/bundle.json")
	if _, err := certBundleURL(); err == nil {
		t.Fatal("plain http bundle URL must be rejected")
	}
	t.Setenv(certBundleURLEnv, "")
	if u, err := certBundleURL(); err != nil || u != defaultCertBundleURL {
		t.Fatalf("default URL expected, got %q (%v)", u, err)
	}
}

func TestHolderServesTLSHandshake(t *testing.T) {
	now := time.Now()
	c, err := parseCertBundle(makeBundle(t, localTLSHostname, now.Add(-time.Hour), now.Add(48*time.Hour)), now)
	if err != nil {
		t.Fatal(err)
	}
	h := &localCertHolder{}
	h.offer(c, now)
	got, err := h.getCertificate(&tls.ClientHelloInfo{})
	if err != nil || got == nil || len(got.Certificate) == 0 {
		t.Fatalf("getCertificate failed: %v", err)
	}
}

func TestAgentHTTPPortMapsTLSPortBackToHTTP(t *testing.T) {
	old := localTLSPort
	defer func() { localTLSPort = old }()
	localTLSPort = defaultTLSPort
	r := httptest.NewRequest("GET", "http://local.itmatzip.com:19878/", nil)
	if got := agentHTTPPortFromRequest(r); got != defaultPort {
		t.Fatalf("got %d, want %d", got, defaultPort)
	}
}
