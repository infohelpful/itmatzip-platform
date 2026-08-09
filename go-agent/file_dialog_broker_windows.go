//go:build windows

package main

import (
	"fmt"
	"strings"

	"github.com/ncruces/zenity"
	"golang.org/x/sys/windows"
)

func currentProcessSessionID() (uint32, error) {
	var sid uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &sid); err != nil {
		return 0, err
	}
	return sid, nil
}

func isCurrentProcessInteractive() bool {
	sid, err := currentProcessSessionID()
	if err != nil {
		return false
	}
	return sid != 0
}

func pickFileViaUserDialog(audioOnly bool, projectOnly bool, fontOnly bool, imageOnly bool) (string, error) {
	title := "ItMatZip — 미디어 파일 선택"
	filters := zenity.FileFilters{
		{Name: "동영상 파일", Patterns: []string{"*.mp4", "*.mov", "*.mkv", "*.webm", "*.avi", "*.m4v"}},
		{Name: "오디오/동영상", Patterns: []string{"*.mp4", "*.mov", "*.mkv", "*.webm", "*.avi", "*.m4a", "*.wav", "*.mp3", "*.aac", "*.flac"}},
		{Name: "모든 파일", Patterns: []string{"*.*"}},
	}
	if imageOnly {
		title = "ItMatZip — 워터마크 이미지 선택"
		filters = zenity.FileFilters{
			{Name: "이미지 파일", Patterns: []string{"*.png", "*.jpg", "*.jpeg", "*.webp", "*.gif", "*.bmp"}},
			{Name: "모든 파일", Patterns: []string{"*.*"}},
		}
	} else if fontOnly {
		title = "ItMatZip — 글꼴 파일 선택"
		filters = zenity.FileFilters{
			{Name: "글꼴 파일", Patterns: []string{"*.ttf", "*.otf", "*.ttc"}},
			{Name: "모든 파일", Patterns: []string{"*.*"}},
		}
	} else if projectOnly {
		title = "ItMatZip — 프로젝트 불러오기"
		filters = zenity.FileFilters{
			{Name: "Auto Subtitle 프로젝트", Patterns: []string{"*.autosub", "*.json"}},
			{Name: "모든 파일", Patterns: []string{"*.*"}},
		}
	} else if audioOnly {
		title = "ItMatZip — 오디오 파일 선택"
		filters = zenity.FileFilters{
			{Name: "오디오 파일", Patterns: []string{"*.wav", "*.mp3", "*.flac", "*.m4a", "*.aac", "*.ogg", "*.wma", "*.opus"}},
			{Name: "모든 파일", Patterns: []string{"*.*"}},
		}
	}

	fgHwnd := windows.GetForegroundWindow()

	opts := []zenity.Option{
		zenity.Title(title),
		zenity.FileFilters(filters),
	}
	if fgHwnd != 0 {
		opts = append(opts, zenity.Attach(fgHwnd))
		opts = append(opts, zenity.Modal())
	}

	path, err := zenity.SelectFile(opts...)
	if err == zenity.ErrCanceled {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("파일 대화상자 오류: %v", err)
	}
	return strings.TrimSpace(path), nil
}

func pickFolderViaUserDialog() (string, error) {
	title := "ItMatZip — 이미지 폴더 선택"
	fgHwnd := windows.GetForegroundWindow()

	opts := []zenity.Option{
		zenity.Title(title),
		zenity.Directory(),
	}
	if fgHwnd != 0 {
		opts = append(opts, zenity.Attach(fgHwnd))
		opts = append(opts, zenity.Modal())
	}

	path, err := zenity.SelectFile(opts...)
	if err == zenity.ErrCanceled {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("폴더 대화상자 오류: %v", err)
	}
	return strings.TrimSpace(path), nil
}
