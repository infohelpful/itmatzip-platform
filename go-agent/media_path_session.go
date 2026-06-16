package main

import "sync"

// 에이전트가 파일 대화상자에서 받은 UTF-8 경로 — 브라우저 sessionStorage 깨짐 회피.
var mediaPathSession struct {
	sync.RWMutex
	source  string
	preview string
}

func setMediaPathSessionSource(source string) {
	source = normalizeMediaPathRaw(source)
	if source == "" {
		return
	}
	mediaPathSession.Lock()
	mediaPathSession.source = source
	mediaPathSession.Unlock()
}

func setMediaPathSessionPreview(preview string) {
	preview = normalizeMediaPathRaw(preview)
	if preview == "" {
		return
	}
	mediaPathSession.Lock()
	mediaPathSession.preview = preview
	mediaPathSession.Unlock()
}

func getMediaPathSession() (source string, preview string) {
	mediaPathSession.RLock()
	defer mediaPathSession.RUnlock()
	return mediaPathSession.source, mediaPathSession.preview
}
