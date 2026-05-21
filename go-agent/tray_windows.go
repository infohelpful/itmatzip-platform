//go:build windows

package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/getlantern/systray"
	"github.com/itmatzip/itmatzip-agent-go-prototype/trayicon"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	trayMutexName     = "Global\\ItMatZipAgentTray_v1"
	trayRunValue      = "ItMatZipAgentTray"
	trayPollInterval  = 8 * time.Second
	trayServicePollMs = 3 * time.Second
)

var (
	trayMenuMu   sync.Mutex
	trayStopSvc  *systray.MenuItem
	trayStartSvc *systray.MenuItem
)

func toolsWebBase() string {
	if v := strings.TrimSpace(os.Getenv("ITMATZIP_TOOLS_WEB_BASE")); v != "" {
		return strings.TrimSuffix(v, "/")
	}
	return "https://tools.itmatzip.com"
}

func trayToolURLs() (dashboard, silence, vocal string) {
	base := toolsWebBase()
	return base + "/", base + "/silence-remover/", base + "/vocal-remover/"
}

func resolveTrayIconPath() string {
	// Windows 트레이는 16×16 ICO 권장 (256px 단일만 있으면 빈 칸으로 보임)
	names := []string{"tray-16.ico", "itmatzip-agent-tray.ico", "itmatzip-agent.ico"}
	bases := []string{
		filepath.Join(installRootPath, "agent", "assets"),
		filepath.Join(installRootPath, "assets"),
	}
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		bases = append(bases,
			filepath.Join(exeDir, "agent", "assets"),
			filepath.Join(exeDir, "assets"),
			filepath.Join(exeDir, "..", "agent", "assets"),
		)
	}
	var candidates []string
	for _, base := range bases {
		for _, name := range names {
			candidates = append(candidates, filepath.Join(base, name))
		}
	}
	for _, p := range candidates {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

func acquireTraySingleInstance() (windows.Handle, bool, error) {
	name, err := windows.UTF16PtrFromString(trayMutexName)
	if err != nil {
		return 0, false, err
	}
	h, err := windows.CreateMutex(nil, false, name)
	if err != nil {
		return 0, false, err
	}
	if windows.GetLastError() == windows.ERROR_ALREADY_EXISTS {
		return h, false, nil
	}
	return h, true, nil
}

func runTray(port int) error {
	return runTrayWithOptions(port, false)
}

// ensureServiceForLaunch starts or restarts the Windows service only when needed.
// Normal users cannot run sc stop/start (exit 5); skip restart if the service is already healthy.
func ensureServiceForLaunch(port int) {
	if isWindowsServiceRunning() {
		if waitForAgentHealth(port, 12*time.Second) {
			return
		}
		log.Print("service running but agent not healthy; attempting reload")
		if err := restartAgentViaHTTP(port, 90*time.Second); err != nil {
			log.Printf("reload via HTTP failed: %v; trying SCM restart", err)
		} else if waitForAgentHealth(port, 30*time.Second) {
			return
		}
		if err := restartWindowsService(); err != nil {
			if isServiceAccessDenied(err) {
				log.Print("service restart skipped (administrator rights required)")
			} else {
				log.Printf("warning: service restart failed: %v", err)
			}
		}
		if !waitForAgentHealth(port, 60*time.Second) {
			log.Printf("warning: agent health not ready within timeout")
		}
		return
	}
	if err := startWindowsService(); err != nil {
		if isServiceAccessDenied(err) {
			log.Print("service start skipped (administrator rights required)")
		} else {
			log.Printf("warning: service start failed: %v", err)
		}
		return
	}
	if !waitForAgentHealth(port, 60*time.Second) {
		log.Printf("warning: agent health not ready within timeout")
	}
}

func isServiceAccessDenied(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "exit status 5") ||
		strings.Contains(strings.ToLower(s), "access is denied") ||
		strings.Contains(s, "액세스가 거부")
}

func runTrayWithOptions(port int, restartServiceFirst bool) error {
	initPaths()

	if restartServiceFirst {
		ensureServiceForLaunch(port)
	}

	mutex, ok, err := acquireTraySingleInstance()
	if err != nil {
		return fmt.Errorf("tray mutex: %w", err)
	}
	if !ok {
		if restartServiceFirst {
			log.Print("tray already running (service restarted)")
		} else {
			log.Print("tray already running, exiting")
		}
		return nil
	}
	defer windows.CloseHandle(mutex)

	iconData := loadTrayIconData()
	runtime.LockOSThread()
	systray.Run(func() {
		onTrayReady(port, iconData)
	}, onTrayExit)
	return nil
}

func loadTrayIconData() []byte {
	// Win10/11 알림 영역: 단일 해상도 ICO (16px가 가장 호환성 좋음)
	for _, pair := range []struct {
		name string
		data []byte
	}{
		{"tray-16.ico", trayicon.Tray16ICO},
		{"tray-32.ico", trayicon.Tray32ICO},
	} {
		if len(pair.data) > 0 {
			log.Printf("tray icon: embedded %s (%d bytes)", pair.name, len(pair.data))
			return pair.data
		}
	}
	iconPath := resolveTrayIconPath()
	if iconPath == "" {
		log.Print("warning: tray icon file not found")
		return nil
	}
	iconData, err := os.ReadFile(iconPath)
	if err != nil {
		log.Printf("warning: tray icon not loaded (%s): %v", iconPath, err)
		return nil
	}
	log.Printf("tray icon: %s (%d bytes)", iconPath, len(iconData))
	return iconData
}

func applyTrayIcon(iconData []byte) {
	if len(iconData) == 0 {
		return
	}
	systray.SetIcon(iconData)
	go func(data []byte) {
		for _, delay := range []time.Duration{400 * time.Millisecond, 2 * time.Second} {
			time.Sleep(delay)
			systray.SetIcon(data)
		}
	}(append([]byte(nil), iconData...))
}

func onTrayReady(port int, iconData []byte) {
	applyTrayIcon(iconData)
	systray.SetTitle("ItMatZip Agent")

	dashboardURL, silenceURL, vocalURL := trayToolURLs()

	mDashboard := systray.AddMenuItem("대시보드", dashboardURL)
	mSilence := systray.AddMenuItem("Silence Detector", silenceURL)
	mVocal := systray.AddMenuItem("Vocal Remover", vocalURL)
	systray.AddSeparator()

	mStopSvc := systray.AddMenuItem("서비스 종료", "에이전트 Windows 서비스만 중지합니다 (트레이는 유지)")
	mStartSvc := systray.AddMenuItem("서비스 재시작", "중지된 에이전트 서비스를 다시 시작합니다")
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("종료", "서비스를 중지하고 트레이 아이콘을 닫습니다")

	trayMenuMu.Lock()
	trayStopSvc = mStopSvc
	trayStartSvc = mStartSvc
	trayMenuMu.Unlock()

	refreshTrayServiceMenuItems(port)
	updateTrayTooltipFromState(port)

	go trayStatusPoller(port)
	go trayMenuEventLoop(port, dashboardURL, silenceURL, vocalURL, mDashboard, mSilence, mVocal, mStopSvc, mStartSvc, mQuit)
}

func trayMenuEventLoop(
	port int,
	dashboardURL, silenceURL, vocalURL string,
	mDashboard, mSilence, mVocal, mStopSvc, mStartSvc, mQuit *systray.MenuItem,
) {
	for {
		select {
		case <-mDashboard.ClickedCh:
			openURL(dashboardURL)
		case <-mSilence.ClickedCh:
			openURL(silenceURL)
		case <-mVocal.ClickedCh:
			openURL(vocalURL)
		case <-mStopSvc.ClickedCh:
			if err := stopWindowsService(); err != nil {
				log.Printf("tray stop service: %v", err)
				updateTrayTooltip(port, "서비스 중지 실패 · "+shortTrayErr(err))
			} else {
				updateTrayTooltip(port, "서비스 중지됨")
			}
			refreshTrayServiceMenuItems(port)
		case <-mStartSvc.ClickedCh:
			trayRestartOrStartService(port)
			refreshTrayServiceMenuItems(port)
		case <-mQuit.ClickedCh:
			if err := stopWindowsService(); err != nil {
				log.Printf("stop service on tray exit: %v", err)
			}
			systray.Quit()
			return
		}
	}
}

func refreshTrayServiceMenuItems(port int) {
	trayMenuMu.Lock()
	stopItem := trayStopSvc
	startItem := trayStartSvc
	trayMenuMu.Unlock()
	if stopItem == nil || startItem == nil {
		return
	}
	if isWindowsServiceRunning() || isAgentResponding(port) {
		stopItem.Enable()
		startItem.Enable()
		startItem.SetTitle("서비스 재시작")
		startItem.SetTooltip("Windows 서비스를 중지한 뒤 다시 시작합니다")
	} else {
		stopItem.Disable()
		startItem.Enable()
		startItem.SetTitle("서비스 시작")
		startItem.SetTooltip("중지된 ItMatZip Agent Windows 서비스를 시작합니다")
	}
}

func isAgentResponding(port int) bool {
	return waitForAgentHealth(port, 1500*time.Millisecond)
}

func shortTrayErr(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	if len(s) > 72 {
		return s[:72] + "…"
	}
	return s
}

func trayRestartOrStartService(port int) {
	if isWindowsServiceRunning() || isAgentResponding(port) {
		updateTrayTooltip(port, "Windows 서비스 재시작 중…")
		if err := restartWindowsServiceAndWait(); err != nil {
			log.Printf("tray SCM restart: %v", err)
			if isServiceAccessDenied(err) {
				updateTrayTooltip(port, "SCM 재시작 거부 · HTTP reload 시도…")
				if err := restartAgentViaHTTP(port, 90*time.Second); err != nil {
					log.Printf("tray reload via HTTP: %v", err)
					updateTrayTooltip(port, "재시작 실패 · "+shortTrayErr(err))
					return
				}
			} else {
				updateTrayTooltip(port, "재시작 실패 · "+shortTrayErr(err))
				return
			}
		}
		if waitForAgentHealth(port, 90*time.Second) {
			updateTrayTooltipFromState(port)
			return
		}
		updateTrayTooltip(port, "서비스 재시작됨 (health 대기 중)")
		return
	}

	updateTrayTooltip(port, "서비스 시작 중…")
	if err := startWindowsService(); err != nil {
		log.Printf("tray start service: %v", err)
		updateTrayTooltip(port, "서비스 시작 실패 · "+shortTrayErr(err))
		return
	}
	if waitForAgentHealth(port, 60*time.Second) {
		updateTrayTooltipFromState(port)
	} else {
		updateTrayTooltip(port, "서비스 시작됨 (health 대기 중)")
	}
}

func trayStatusPoller(port int) {
	tick := time.NewTicker(trayPollInterval)
	defer tick.Stop()
	svcTick := time.NewTicker(trayServicePollMs)
	defer svcTick.Stop()
	for {
		select {
		case <-tick.C:
			updateTrayTooltipFromState(port)
		case <-svcTick.C:
			refreshTrayServiceMenuItems(port)
		}
	}
}

func onTrayExit() {}

func waitForAgentHealth(port int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	url := fmt.Sprintf("http://%s:%d/health", defaultHost, port)
	client := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return true
			}
		}
		time.Sleep(400 * time.Millisecond)
	}
	return false
}

func runLaunch(port int) error {
	return runTrayWithOptions(port, true)
}

func updateTrayTooltipFromState(port int) {
	if !isWindowsServiceRunning() && !isAgentResponding(port) {
		updateTrayTooltip(port, "서비스 중지됨")
		return
	}
	updateTrayTooltip(port, fetchTrayHealthLabel(port))
}

func fetchTrayHealthLabel(port int) string {
	client := &http.Client{Timeout: 2 * time.Second}
	url := fmt.Sprintf("http://%s:%d/health", defaultHost, port)
	resp, err := client.Get(url)
	if err != nil {
		return "서비스 실행 중 · API 응답 없음"
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Sprintf("서비스 실행 중 · HTTP %d", resp.StatusCode)
	}
	return "실행 중 · v" + readAgentVersion()
}

func updateTrayTooltip(port int, status string) {
	systray.SetTooltip(fmt.Sprintf("ItMatZip Agent — %s\nhttp://%s:%d", status, defaultHost, port))
}

func openURL(url string) {
	if err := shellOpen(url); err != nil {
		log.Printf("open url: %v", err)
	}
}

func registerTrayAutostart() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, err = filepath.Abs(exe)
	if err != nil {
		return err
	}
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(trayRunValue, fmt.Sprintf(`"%s" --tray`, exe))
}

func unregisterTrayAutostart() error {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	err = k.DeleteValue(trayRunValue)
	if err == registry.ErrNotExist {
		return nil
	}
	return err
}

func launchTrayProcess() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "--tray")
	cmd.SysProcAttr = &windows.SysProcAttr{
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP,
	}
	hideExec(cmd)
	return cmd.Start()
}
