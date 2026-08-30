"""Render 1200x630 Open Graph images to match the existing ItMatZip Tools card."""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(__file__).resolve().parent
CONFIG = ROOT.parent / "admin" / "site-config.json"
REGISTRY_ACCENT = {
    "silence-remover": "#3b82f6",
    "auto-subtitle": "#8b5cf6",
    "vocal-remover": "#ec4899",
    "image-enhancer": "#06b6d4",
    "background-remover": "#14b8a6",
    "create-music": "#f59e0b",
    "magic-eraser": "#a855f7",
    "voice-changer": "#14b8a6",
    "watermark-remover": "#eab308",
    "thumbnail-grabber": "#f43f5e",
    "ico-maker": "#38bdf8",
    "image-combiner": "#10b981",
    "online-clock": "#22d3ee",
    "json-formatter": "#10b981",
    "currency-calculator": "#ca8a04",
    "unattend-maker": "#60a5fa",
}
HREF = {
    "silence-remover": "silence-remover/",
    "auto-subtitle": "auto-subtitle/",
    "vocal-remover": "vocal-remover/",
    "image-enhancer": "image-enhancer/",
    "background-remover": "background-remover/",
    "create-music": "create-music/",
    "magic-eraser": "magic-eraser/",
    "voice-changer": "voice-changer/",
    "watermark-remover": "fixed-area-remover/",
    "thumbnail-grabber": "thumbnail-grabber/",
    "ico-maker": "ico-maker/",
    "image-combiner": "image-combiner/",
    "online-clock": "online-clock/",
    "json-formatter": "json-formatter/",
    "currency-calculator": "currency-calculator/",
    "unattend-maker": "unattend-maker/",
}

W, H = 1200, 630
BG = (15, 17, 21, 255)
WHITE = (255, 255, 255, 255)
MUTED = (148, 163, 184, 255)
BAR_W = 18
PAD_X = 72
FONT_BRAND = r"C:\Windows\Fonts\segoeuib.ttf"
FONT_LATIN = r"C:\Windows\Fonts\segoeuib.ttf"
FONT_KR_B = r"C:\Windows\Fonts\malgunbd.ttf"
FONT_KR = r"C:\Windows\Fonts\malgun.ttf"


def hex_rgba(h: str, a: int = 255) -> tuple[int, int, int, int]:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def has_hangul(text: str) -> bool:
    return any("가" <= ch <= "힣" for ch in text)


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def pick_title_font(text: str) -> ImageFont.FreeTypeFont:
    face = FONT_KR_B if has_hangul(text) else FONT_LATIN
    probe = ImageDraw.Draw(Image.new("RGBA", (W, H), BG))
    for size in (88, 80, 72, 64, 56, 50):
        f = font(face, size)
        box = probe.textbbox((0, 0), text, font=f)
        if box[2] - box[0] <= W - PAD_X - 80:
            return f
    return font(face, 48)


def draw_text(draw: ImageDraw.ImageDraw, xy, text: str, fnt, fill):
    draw.text(xy, text, font=fnt, fill=fill)


def render_card(path: Path, accent: str, title: str, subtitle: str, url: str) -> None:
    accent_rgb = hex_rgba(accent)
    im = Image.new("RGBA", (W, H), BG)
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.ellipse((720, -80, 1380, 520), fill=hex_rgba(accent, 48))
    gdraw.ellipse((860, 260, 1460, 820), fill=hex_rgba(accent, 28))
    im = Image.alpha_composite(im, glow.filter(ImageFilter.GaussianBlur(48)))

    draw = ImageDraw.Draw(im)
    draw.rectangle((0, 0, BAR_W - 1, H), fill=accent_rgb)

    brand = font(FONT_BRAND, 20)
    draw_text(draw, (PAD_X, 78), "ITMATZIP", brand, accent_rgb)

    title_font = pick_title_font(title)
    title_box = draw.textbbox((0, 0), title, font=title_font)
    title_h = title_box[3] - title_box[1]
    draw_text(draw, (PAD_X, 128), title, title_font, WHITE)

    sub_face = FONT_KR if has_hangul(subtitle) else FONT_KR
    sub_font = font(sub_face, 28)
    draw_text(draw, (PAD_X, 128 + title_h + 28), subtitle, sub_font, MUTED)

    url_font = font(FONT_KR, 26)
    draw_text(draw, (PAD_X, 520), url, url_font, MUTED)

    rgb = im.convert("RGB")
    rgb.save(path, "PNG", optimize=True)


def main() -> None:
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    cards = [
        {
            "id": "hub",
            "accent": "#3b82f6",
            "title": "Tools",
            "subtitle": "영상 · 오디오 · 이미지 로컬 웹 도구",
            "url": "tools.itmatzip.com",
        }
    ]
    for tool_id, row in cfg["tools"].items():
        title = (row.get("title") or {}).get("ko") or tool_id
        subtitle = (row.get("subtitle") or {}).get("ko") or ""
        if title == subtitle:
            subtitle = "브라우저에서 바로 쓰는 로컬 웹 도구"
        cards.append(
            {
                "id": tool_id,
                "accent": REGISTRY_ACCENT.get(tool_id, "#3b82f6"),
                "title": title,
                "subtitle": subtitle,
                "url": "tools.itmatzip.com/" + HREF.get(tool_id, tool_id + "/"),
            }
        )

    for card in cards:
        dest = OUT / f"{card['id']}.png"
        render_card(path=dest, accent=card["accent"], title=card["title"], subtitle=card["subtitle"], url=card["url"])
        print(dest.name, card["title"])

    hub = OUT / "hub.png"
    default = ROOT / "og-image.png"
    default.write_bytes(hub.read_bytes())
    print("copied hub.png -> assets/og-image.png")


if __name__ == "__main__":
    main()
