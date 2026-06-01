//go:build windows

package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/getlantern/systray"
	"github.com/itmatzip/itmatzip-agent-go-prototype/trayicon"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	trayMutexName = "Local\\ItMatZipAgentTray_v1"
	trayRunValue  = "ItMatZipAgentTray"
)


func toolsWebBase() string {
	if v := strings.TrimSpace(os.Getenv("ITMATZIP_TOOLS_WEB_BASE")); v != "" {
		return strings.TrimSuffix(v, "/")
	}
	return "https://tools.itmatzip.com"
}

func trayToolURLs() (dashboard, silence, vocal, autosub, createMusic, imageEnhancer string) {
	base := toolsWebBase()
	return base + "/", base + "/silence-remover/", base + "/vocal-remover/", base + "/auto-subtitle/", base + "/create-music/", base + "/image-enhancer/"
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
	return runTrayWithOptions(port)
}


var trayAgentCancel context.CancelFunc

func runTrayWithOptions(port int) error {
	initPaths()
	if err := ensurePaths(); err != nil {
		return fmt.Errorf("ensure paths: %w", err)
	}
	setupLogging()

	mutex, ok, err := acquireTraySingleInstance()
	if err != nil {
		return fmt.Errorf("tray mutex: %w", err)
	}
	if !ok {
		log.Print("tray already running, exiting")
		return nil
	}
	defer windows.CloseHandle(mutex)

	initJobObject()

	ctx, cancel := context.WithCancel(context.Background())
	trayAgentCancel = cancel
	initUpdateManager(ctx)

	grpcAddr := fmt.Sprintf("%s:%d", defaultHost, defaultGRPCPort)
	hub := newHub()
	mgr := newWorkerManager(hub, grpcAddr)

	go func() {
		if err := mgr.startGRPCWorker(ctx); err != nil {
			log.Printf("warning: grpc python worker failed to start: %v", err)
		} else {
			time.Sleep(500 * time.Millisecond)
			if err := mgr.grpcClient.Connect(ctx); err != nil {
				log.Printf("warning: grpc client connect failed: %v", err)
			}
		}
	}()

	sidecar := newFastAPISidecar(defaultFastAPIPort)
	go func() {
		startFastAPISidecarWithRetry(ctx, sidecar, mgr)
		startFastAPISidecarWatchdog(ctx, sidecar, mgr)
	}()

	go func() {
		if err := startHTTPServer(ctx, hub, mgr, port, sidecar); err != nil && err != http.ErrServerClosed {
			log.Printf("HTTP server error: %v", err)
		}
	}()

	iconData := loadTrayIconData()
	runtime.LockOSThread()
	systray.Run(func() {
		onTrayReady(port, iconData)
	}, func() {
		onTrayExit()
		cancel()
		mgr.Close()
	})
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

	dashboardURL, silenceURL, vocalURL, autosubURL, createMusicURL, remoteImageEnhancer := trayToolURLs()
	imageEnhancerURL := bundledImageEnhancerURL(port)
	if imageEnhancerURL == "" {
		imageEnhancerURL = remoteImageEnhancer
	} else {
		log.Printf("Image Enhancer: using bundled UI at %s", imageEnhancerURL)
	}

	mDashboard := systray.AddMenuItem("대시보드", dashboardURL)
	mSilence := systray.AddMenuItem("Silence Detector", silenceURL)
	mVocal := systray.AddMenuItem("Vocal Remover", vocalURL)
	mAutosub := systray.AddMenuItem("Auto Subtitle", autosubURL)
	mCreateMusic := systray.AddMenuItem("Create Music", createMusicURL)
	mImageEnhancer := systray.AddMenuItem("Image Enhancer", imageEnhancerURL)
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("종료", "에이전트를 종료합니다")

	updateTrayTooltip(port, "실행 중 · v"+readAgentVersion())

	go func() {
		for {
			select {
			case <-mDashboard.ClickedCh:
				openURL(dashboardURL)
			case <-mSilence.ClickedCh:
				openURL(silenceURL)
			case <-mVocal.ClickedCh:
				openURL(vocalURL)
			case <-mAutosub.ClickedCh:
				openURL(autosubURL)
			case <-mCreateMusic.ClickedCh:
				openURL(createMusicURL)
			case <-mImageEnhancer.ClickedCh:
				openURL(imageEnhancerURL)
			case <-mQuit.ClickedCh:
				systray.Quit()
				return
			}
		}
	}()
}


func onTrayExit() {
}



func updateTrayTooltip(port int, status string) {
	systray.SetTooltip(fmt.Sprintf("ItMatZip Agent — %s\nhttp://%s:%d", status, defaultHost, port))
}

func openURL(url string) {
	if err := shellOpen(url); err != nil {
		log.Printf("open url: %v", err)
	}
}

func setTrayRunKey(root registry.Key, exe string) error {
	k, err := registry.OpenKey(root, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(trayRunValue, fmt.Sprintf(`"%s" --tray`, exe))
}

func deleteTrayRunKey(root registry.Key) error {
	k, err := registry.OpenKey(root, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.SET_VALUE)
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

// registerTrayAutostart: tray must start in the user session (not from SYSTEM service).
func registerTrayAutostart() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, err = filepath.Abs(exe)
	if err != nil {
		return err
	}
	if err := setTrayRunKey(registry.CURRENT_USER, exe); err != nil {
		log.Printf("warning: HKCU Run tray autostart: %v", err)
	}
	if err := setTrayRunKey(registry.LOCAL_MACHINE, exe); err != nil {
		return fmt.Errorf("HKLM Run tray autostart: %w", err)
	}
	log.Printf("tray autostart registered (HKCU + HKLM Run): %s --tray", exe)
	return nil
}

func unregisterTrayAutostart() error {
	_ = deleteTrayRunKey(registry.CURRENT_USER)
	if err := deleteTrayRunKey(registry.LOCAL_MACHINE); err != nil {
		return err
	}
	return nil
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
