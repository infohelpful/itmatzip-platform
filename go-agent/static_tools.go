package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
)

func resolveBundledToolsWebDir() string {
	var candidates []string
	if installRootPath != "" {
		candidates = append(candidates, filepath.Join(installRootPath, "tools-web"))
	}
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		candidates = append(candidates, filepath.Join(exeDir, "tools-web"))
		if isDevLayout(exeDir) {
			candidates = append(candidates, filepath.Join(exeDir, "..", "web-ui", "tools"))
		}
	}
	for _, root := range candidates {
		index := filepath.Join(root, "image-enhancer", "index.html")
		if st, err := os.Stat(index); err == nil && !st.IsDir() {
			abs, err := filepath.Abs(root)
			if err != nil {
				return root
			}
			return abs
		}
	}
	return ""
}

func mountBundledToolsWeb(mux *http.ServeMux) {
	root := resolveBundledToolsWebDir()
	if root == "" {
		log.Print("bundled tools web UI not found (image-enhancer); tray will use remote tools site")
		return
	}
	fs := http.FileServer(http.Dir(root))
	mux.Handle("/tools/", http.StripPrefix("/tools/", fs))
	log.Printf("serving bundled tools web UI from %s at http://127.0.0.1:%d/tools/", root, defaultPort)
}

func bundledImageEnhancerURL(port int) string {
	if resolveBundledToolsWebDir() == "" {
		return ""
	}
	if port <= 0 {
		port = defaultPort
	}
	return "http://" + defaultHost + ":" + strconv.Itoa(port) + "/tools/image-enhancer/"
}
