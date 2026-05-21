package main

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultUpdateManifestURL = "https://raw.githubusercontent.com/infohelpful/itmatzip-platform/main/agent/agent-update-manifest.json"
)

//go:embed installer/apply-msi-update.ps1
var applyMSIUpdateScript []byte

type UpdateManifest struct {
	Version        string `json:"version"`
	DownloadURL    string `json:"download_url"`
	SHA256         string `json:"sha256"`
	MSIDownloadURL string `json:"msi_download_url"`
	MSISHA256      string `json:"msi_sha256"`
	PackageType    string `json:"package_type"`
	Mandatory      bool   `json:"mandatory"`
	ReleaseNotes   string `json:"release_notes"`
}

func (m UpdateManifest) MSIURL() string {
	if strings.TrimSpace(m.MSIDownloadURL) != "" {
		return strings.TrimSpace(m.MSIDownloadURL)
	}
	if strings.EqualFold(strings.TrimSpace(m.PackageType), "msi") {
		return strings.TrimSpace(m.DownloadURL)
	}
	return ""
}

func (m UpdateManifest) MSISum() string {
	if strings.TrimSpace(m.MSISHA256) != "" {
		return strings.ToLower(strings.TrimSpace(m.MSISHA256))
	}
	if strings.EqualFold(strings.TrimSpace(m.PackageType), "msi") {
		return strings.ToLower(strings.TrimSpace(m.SHA256))
	}
	return ""
}

type updateSnapshot struct {
	LastCheckAt      *time.Time `json:"last_check_at,omitempty"`
	LastError        string     `json:"last_error,omitempty"`
	RemoteVersion    string     `json:"remote_version,omitempty"`
	UpdateAvailable  bool       `json:"update_available"`
	Downloading      bool       `json:"downloading"`
	Applying         bool       `json:"applying"`
	LocalVersion     string     `json:"local_version,omitempty"`
	UpdateChannel    string     `json:"update_channel,omitempty"`
}

type updateManager struct {
	mu           sync.RWMutex
	state        updateSnapshot
	manifestURL  string
	updatesRoot  string
	localVersion string
}

func newUpdateManager() *updateManager {
	updatesRoot := filepath.Join(settingsRootPath, "updates")
	if custom := strings.TrimSpace(os.Getenv("ITMATZIP_UPDATE_ROOT")); custom != "" {
		updatesRoot = custom
	}
	manifestURL := strings.TrimSpace(os.Getenv("ITMATZIP_UPDATE_MANIFEST_URL"))
	if manifestURL == "" {
		manifestURL = defaultUpdateManifestURL
	}
	return &updateManager{
		manifestURL:  manifestURL,
		updatesRoot:  updatesRoot,
		localVersion: readAgentVersion(),
		state: updateSnapshot{
			LocalVersion:  readAgentVersion(),
			UpdateChannel: "msi",
		},
	}
}

func (u *updateManager) snapshot() updateSnapshot {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.state
}

func (u *updateManager) setState(mutator func(*updateSnapshot)) {
	u.mu.Lock()
	defer u.mu.Unlock()
	mutator(&u.state)
}

func autoUpdateDisabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("ITMATZIP_DISABLE_AUTO_UPDATE")))
	return v == "1" || v == "true" || v == "yes"
}

func updateInitialDelay() time.Duration {
	raw := strings.TrimSpace(os.Getenv("ITMATZIP_UPDATE_INITIAL_DELAY_SEC"))
	if raw == "" {
		return 45 * time.Second
	}
	sec, err := strconv.ParseFloat(raw, 64)
	if err != nil || sec < 5 {
		return 45 * time.Second
	}
	return time.Duration(sec * float64(time.Second))
}

func updateCheckInterval() time.Duration {
	raw := strings.TrimSpace(os.Getenv("ITMATZIP_UPDATE_CHECK_INTERVAL_SEC"))
	if raw == "" {
		return 6 * time.Hour
	}
	sec, err := strconv.ParseFloat(raw, 64)
	if err != nil || sec < 300 {
		return 6 * time.Hour
	}
	return time.Duration(sec * float64(time.Second))
}

var versionPartPattern = regexp.MustCompile(`(\d+)`)

func parseVersionParts(version string) []int {
	clean := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(version, "v"), "V"))
	parts := versionPartPattern.FindAllString(clean, -1)
	out := make([]int, 0, len(parts))
	for _, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil {
			n = 0
		}
		out = append(out, n)
	}
	if len(out) == 0 {
		return []int{0}
	}
	return out
}

func isRemoteVersionNewer(remote, local string) bool {
	r := parseVersionParts(remote)
	l := parseVersionParts(local)
	maxLen := len(r)
	if len(l) > maxLen {
		maxLen = len(l)
	}
	for i := 0; i < maxLen; i++ {
		rv, lv := 0, 0
		if i < len(r) {
			rv = r[i]
		}
		if i < len(l) {
			lv = l[i]
		}
		if rv > lv {
			return true
		}
		if rv < lv {
			return false
		}
	}
	return false
}

func (u *updateManager) fetchManifest(ctx context.Context) (*UpdateManifest, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.manifestURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "ItMatZip-Agent-Updater")
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("manifest download failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("manifest HTTP %d", resp.StatusCode)
	}

	var manifest UpdateManifest
	if err := json.NewDecoder(resp.Body).Decode(&manifest); err != nil {
		return nil, fmt.Errorf("manifest JSON parse failed: %w", err)
	}
	if strings.TrimSpace(manifest.Version) == "" {
		return nil, fmt.Errorf("manifest missing version")
	}
	if manifest.MSIURL() == "" {
		return nil, fmt.Errorf("manifest missing msi_download_url/package_type=msi")
	}
	return &manifest, nil
}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func (u *updateManager) downloadMSI(ctx context.Context, manifest *UpdateManifest, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, manifest.MSIURL(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "ItMatZip-Agent-Updater")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("msi download failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("msi download HTTP %d", resp.StatusCode)
	}

	tmp := dest + ".part"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, resp.Body)
	closeErr := out.Close()
	if copyErr != nil {
		_ = os.Remove(tmp)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(tmp)
		return closeErr
	}
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		return err
	}

	if expected := manifest.MSISum(); expected != "" {
		got, err := sha256File(dest)
		if err != nil {
			return err
		}
		if !strings.EqualFold(got, expected) {
			_ = os.Remove(dest)
			return fmt.Errorf("msi sha256 mismatch (expected %s got %s)", expected, got)
		}
	}
	return nil
}

func (u *updateManager) writeApplyScript() (string, error) {
	if err := os.MkdirAll(u.updatesRoot, 0o755); err != nil {
		return "", err
	}
	scriptPath := filepath.Join(u.updatesRoot, "apply-msi-update.ps1")
	if err := os.WriteFile(scriptPath, applyMSIUpdateScript, 0o644); err != nil {
		return "", err
	}
	return scriptPath, nil
}

func (u *updateManager) spawnMSIUpdater(msiPath string) error {
	scriptPath, err := u.writeApplyScript()
	if err != nil {
		return err
	}
	logPath := filepath.Join(u.updatesRoot, "agent-update.log")
	cmd := exec.Command(
		"powershell.exe",
		"-NoProfile",
		"-ExecutionPolicy", "Bypass",
		"-WindowStyle", "Hidden",
		"-File", scriptPath,
		"-MsiPath", msiPath,
		"-LogPath", logPath,
	)
	cmd.Dir = u.updatesRoot
	return cmd.Start()
}

func (u *updateManager) appendUpdateLog(line string) {
	logPath := filepath.Join(u.updatesRoot, "agent-update.log")
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = fmt.Fprintf(f, "%s %s\n", time.Now().Format(time.RFC3339), line)
}

func (u *updateManager) Check(apply bool) updateSnapshot {
	now := time.Now()
	u.setState(func(s *updateSnapshot) {
		s.LastCheckAt = &now
		s.LastError = ""
		s.LocalVersion = u.localVersion
		s.UpdateChannel = "msi"
	})

	if !isMSIInstallLayout() {
		u.setState(func(s *updateSnapshot) {
			s.UpdateAvailable = false
			s.LastError = "msi auto-update only runs in bundled install layout"
		})
		return u.snapshot()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	manifest, err := u.fetchManifest(ctx)
	if err != nil {
		u.setState(func(s *updateSnapshot) {
			s.UpdateAvailable = false
			s.LastError = err.Error()
		})
		u.appendUpdateLog("manifest check failed: " + err.Error())
		return u.snapshot()
	}

	u.setState(func(s *updateSnapshot) {
		s.RemoteVersion = manifest.Version
	})

	if !isRemoteVersionNewer(manifest.Version, u.localVersion) {
		u.setState(func(s *updateSnapshot) {
			s.UpdateAvailable = false
		})
		u.appendUpdateLog(fmt.Sprintf("up to date (%s)", u.localVersion))
		return u.snapshot()
	}

	u.setState(func(s *updateSnapshot) {
		s.UpdateAvailable = true
	})
	u.appendUpdateLog(fmt.Sprintf("update available: %s -> %s", u.localVersion, manifest.Version))

	if !apply {
		return u.snapshot()
	}

	if err := os.MkdirAll(u.updatesRoot, 0o755); err != nil {
		u.setState(func(s *updateSnapshot) {
			s.LastError = err.Error()
		})
		return u.snapshot()
	}

	dest := filepath.Join(u.updatesRoot, fmt.Sprintf("itmatzip-agent-%s.msi", manifest.Version))
	u.setState(func(s *updateSnapshot) { s.Downloading = true })
	u.appendUpdateLog("downloading " + manifest.MSIURL())

	downloadCtx, downloadCancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer downloadCancel()
	if err := u.downloadMSI(downloadCtx, manifest, dest); err != nil {
		u.setState(func(s *updateSnapshot) {
			s.Downloading = false
			s.LastError = err.Error()
		})
		u.appendUpdateLog("download failed: " + err.Error())
		return u.snapshot()
	}
	u.setState(func(s *updateSnapshot) { s.Downloading = false })

	u.setState(func(s *updateSnapshot) { s.Applying = true })
	u.appendUpdateLog("spawning MSI updater for " + dest)
	if err := u.spawnMSIUpdater(dest); err != nil {
		u.setState(func(s *updateSnapshot) {
			s.Applying = false
			s.LastError = err.Error()
		})
		u.appendUpdateLog("apply spawn failed: " + err.Error())
		return u.snapshot()
	}

	u.appendUpdateLog("MSI updater launched; service will restart")
	return u.snapshot()
}

func (u *updateManager) scheduleBackgroundChecks(ctx context.Context) {
	if autoUpdateDisabled() {
		log.Print("MSI auto-update disabled (ITMATZIP_DISABLE_AUTO_UPDATE)")
		return
	}
	if !isMSIInstallLayout() {
		log.Print("MSI auto-update skipped (not bundled install layout)")
		return
	}
	log.Printf("MSI auto-update scheduled (initial %s, interval %s)", updateInitialDelay(), updateCheckInterval())
	go func() {
		timer := time.NewTimer(updateInitialDelay())
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				u.Check(true)
				timer.Reset(updateCheckInterval())
			}
		}
	}()
}

var globalUpdateManager *updateManager

func initUpdateManager(ctx context.Context) *updateManager {
	if globalUpdateManager == nil {
		globalUpdateManager = newUpdateManager()
	}
	globalUpdateManager.scheduleBackgroundChecks(ctx)
	return globalUpdateManager
}

func mergeUpdateHealth(payload map[string]any) {
	if globalUpdateManager == nil {
		return
	}
	snap := globalUpdateManager.snapshot()
	if snap.LocalVersion != "" && snap.LocalVersion != "0.0.0" {
		payload["agent_version"] = snap.LocalVersion
	}
	payload["update_available"] = snap.UpdateAvailable
	if snap.RemoteVersion != "" {
		payload["remote_version"] = snap.RemoteVersion
	}
	payload["update_channel"] = snap.UpdateChannel
	if snap.LastError != "" {
		payload["update_error"] = snap.LastError
	}
}
