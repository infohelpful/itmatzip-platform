package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFakeFFmpeg(t *testing.T, dir, build string, dlls ...string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range append([]string{"ffmpeg.exe", "ffprobe.exe"}, dlls...) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(build), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if build != "" {
		if err := os.WriteFile(filepath.Join(dir, "ffmpeg-build.txt"), []byte(build+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func withRoots(t *testing.T) (src, dst string) {
	t.Helper()
	settings, install := t.TempDir(), t.TempDir()
	oldSettings, oldInstall := settingsRootPath, installRootPath
	settingsRootPath, installRootPath = settings, install
	t.Cleanup(func() { settingsRootPath, installRootPath = oldSettings, oldInstall })
	return filepath.Join(install, "vendor", "ffmpeg", "gpl-shared"), filepath.Join(settings, "bin", "gpl-shared")
}

func TestFFmpegBuildMarker(t *testing.T) {
	dir := t.TempDir()
	if got := ffmpegBuildMarker(dir); got != "" {
		t.Fatalf("missing marker = %q, want empty", got)
	}
	writeFakeFFmpeg(t, dir, "ffmpeg-n7.1.5.zip", "avcodec-61.dll")
	if got := ffmpegBuildMarker(dir); got != "ffmpeg-n7.1.5.zip" {
		t.Fatalf("marker = %q", got)
	}
}

func TestBundledFFmpegReplacesOtherBuild(t *testing.T) {
	src, dst := withRoots(t)
	writeFakeFFmpeg(t, src, "pinned", "avcodec-61.dll")
	writeFakeFFmpeg(t, dst, "", "avcodec-63.dll") // older "latest" install without a marker

	ensureBundledFFmpegInstalled()

	if got := ffmpegBuildMarker(dst); got != "pinned" {
		t.Fatalf("dst marker = %q, want pinned", got)
	}
	if fileExists(filepath.Join(dst, "avcodec-63.dll")) {
		t.Fatal("old build DLL left behind")
	}
	if !fileExists(filepath.Join(dst, "avcodec-61.dll")) {
		t.Fatal("pinned DLL not copied")
	}
}

func TestBundledFFmpegKeepsSameBuild(t *testing.T) {
	src, dst := withRoots(t)
	writeFakeFFmpeg(t, src, "pinned", "avcodec-61.dll")
	writeFakeFFmpeg(t, dst, "pinned", "avcodec-61.dll", "extra.dll")

	ensureBundledFFmpegInstalled()

	if !fileExists(filepath.Join(dst, "extra.dll")) {
		t.Fatal("same build should be left untouched")
	}
}

func TestBundledFFmpegOldMSIWithoutMarkerKeepsExisting(t *testing.T) {
	src, dst := withRoots(t)
	writeFakeFFmpeg(t, src, "", "avcodec-63.dll")
	writeFakeFFmpeg(t, dst, "pinned", "avcodec-61.dll")

	ensureBundledFFmpegInstalled()

	if got := ffmpegBuildMarker(dst); got != "pinned" {
		t.Fatalf("dst marker = %q, want pinned kept", got)
	}
}
