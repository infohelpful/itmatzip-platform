package trayicon

import _ "embed"

// Windows 알림 영역용 ICO (256px 단일 원본은 트레이에서 빈 칸으로 보일 수 있음).
//
//go:embed tray-32.ico
var Tray32ICO []byte

//go:embed tray-16.ico
var Tray16ICO []byte
