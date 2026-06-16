"""custom_fonts — 중복 패밀리 설치 거부."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from engines import custom_fonts


class CustomFontDuplicateTests(unittest.TestCase):
    def test_install_rejects_duplicate_family(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fonts_dir = Path(tmp)
            manifest = [
                {
                    "id": "a.ttf",
                    "family": "Test Font",
                    "file_name": "a.ttf",
                    "installed_at": "2026-01-01T00:00:00",
                }
            ]
            src = fonts_dir / "b.ttf"
            src.write_bytes(b"font")

            with (
                patch.object(custom_fonts, "get_fonts_dir", return_value=fonts_dir),
                patch.object(custom_fonts, "_load_manifest", return_value=manifest),
                patch.object(custom_fonts, "read_font_family_name", return_value="Test Font"),
                patch.object(custom_fonts, "_register_font_windows"),
            ):
                with self.assertRaises(ValueError) as ctx:
                    custom_fonts.install_custom_font_from_path(str(src))
                self.assertIn("이미 추가된 글꼴입니다", str(ctx.exception))
                self.assertIn("Test Font", str(ctx.exception))

    def test_peek_reports_already_installed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fonts_dir = Path(tmp)
            src = fonts_dir / "new.ttf"
            src.write_bytes(b"font")
            manifest = [
                {
                    "id": "a.ttf",
                    "family": "My Korean",
                    "file_name": "a.ttf",
                    "installed_at": "",
                }
            ]

            with (
                patch.object(custom_fonts, "_load_manifest", return_value=manifest),
                patch.object(custom_fonts, "read_font_family_name", return_value="My Korean"),
            ):
                out = custom_fonts.peek_custom_font_install(str(src))
                self.assertTrue(out["already_installed"])
                self.assertEqual(out["family"], "My Korean")


if __name__ == "__main__":
    unittest.main()
