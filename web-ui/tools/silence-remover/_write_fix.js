const fs = require("fs");
const py = `# -*- coding: utf-8 -*-
from __future__ import annotations
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCRIPT_JS = ROOT / "script.js"
INDEX_HTML = ROOT / "index.html"

D = "motion"
D = "motion"
D = "div"

def _js_string(raw: str) -> str:
    return json.loads('"' + raw.replace("\\\\", "\\\\\\\\").replace('"', '\\\\"') + '"')

def load_labels() -> dict:
    text = SCRIPT_JS.read_text(encoding="utf-8")
    btn_m = re.search(r'const BTN_ANALYZE_LABEL\\s*=\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"', text)
    btn = _js_string(btn_m.group(1)) if btn_m else ""
    export_m = re.search(r"exportA\\.innerHTML\\s*=\\s*'([^']+)'", text)
    export_html = export_m.group(1) if export_m else ""
    start = text.index("function applyStaticUiLabels")
    end = text.index('document.addEventListener("DOMContentLoaded"', start)
    block = text[start:end]
    pat = re.compile(r'"(?:[^"\\\\]|\\\\.)*"', re.DOTALL)
    strings = []
    for m in pat.finditer(block):
        raw = m.group(0)[1:-1]
        try:
            strings.append(_js_string(raw))
        except json.JSONDecodeError:
            strings.append(raw)
    conn_m = re.search(r'ok \\? "([^"]+)" : "([^"]+)"', text)
    conn_fail = conn_m.group(2) if conn_m else ""
    return dict(
        video_path_label=strings[4], btn_pick=strings[6], bin_readiness=strings[8],
        opt_fps=strings[10], opt_fps_hint=strings[12], opt_avg_db=strings[14],
        opt_avg_db_hint=strings[16], opt_rec_db=strings[18], opt_rec_db_hint=strings[20],
        opt_sensitivity=strings[22], opt_sensitivity_hint=strings[24], opt_padding=strings[26],
        min_silence_label=strings[28], summary_aria=strings[31], summary_title=strings[33],
        summary_dts=strings[34:43], waveform_title=strings[45], zoom_hint=strings[47],
        zoom_reset_title=strings[49], analyze_strip=strings[51], analyze_label=strings[53],
        wave_hint=strings[55], canvas_aria=strings[58], remove_caption=strings[63],
        probe_title=strings[65], probe_desc=strings[67], btn_analyze=btn,
        export_html=export_html, conn_fail=conn_fail,
    )

def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def build_html(L: dict) -> str:
    dts = L["summary_dts"]
    em = "\\u2014"
    pre = chr(0xBD84) + chr(0xC11D) + chr(0x20) + chr(0xC804)
    e = esc
    out = []
    a = out.append
    a("<!DOCTYPE html>")
    a('<html lang="ko">')
    a("<head>")
    a('  <meta charset="UTF-8">')
    a('  <meta name="viewport" content="width=device-width, initial-scale=1.0">')
    a("  <title>AI Silence Detector Pro</title>")
    a('  <link rel="stylesheet" href="style.css?v=8">')
    a('  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css">')
    a('  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-################" crossorigin="anonymous"></script>')
    a("</head>")
    a("<body>")
    a(f'  <{D} class="app-container">')
    a('    <aside class="sidebar-ad">')
    a('      <ins class="adsbygoogle" style="display:block" data-ad-client="ca-pub-################" data-ad-slot="0987654321" data-ad-format="vertical"></ins>')
    a("      <script>(adsbygoogle = window.adsbygoogle || []).push({});</script>")
    a("    </aside>")
    a('    <main class="main-content">')
    a('      <header class="app-header">')
    a('        <div class="logo-area">')
    a('          <span class="badge">AI Powered</span>')
    a('          <h1>Silence <span class="accent">Detector</span></h1>')
    a("        </motion>")
    a('        <div class="header-status-col">')
    a(f'          <div id="connection-status" class="status-dot">{e(L["conn_fail"])}</div>')
    a(f'          <div class="bin-readiness" id="bin-readiness">{e(L["bin_readiness"])}</motion>')
    a("        </div>")
    a("      </header>")
    return "\\n".join(out) + "\\n"

def main() -> int:
    L = load_labels()
    INDEX_HTML.write_text(build_html(L), encoding="utf-8")
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;
fs.writeFileSync(process.argv[2], py, "utf8");
console.log("wrote", process.argv[2], py.length);
