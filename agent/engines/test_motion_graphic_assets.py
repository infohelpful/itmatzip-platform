"""python -m unittest engines.test_motion_graphic_assets"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from engines import motion_graphic_assets as assets


class AssetSelectionTests(unittest.TestCase):
    def test_scene_context_and_license_filter(self):
        image = {"title": "Windows 11 search menu.png", "license": "CC BY-SA 4.0"}
        self.assertGreater(assets._score(image, "screenshot", "Windows 11", "search menu"),
                           assets._score(image, "screenshot", "Windows 11", "gaming keyboard"))
        self.assertTrue(assets._license_ok(image))
        self.assertFalse(assets._license_ok({"license": "CC BY-NC 4.0"}))
        self.assertFalse(assets._license_ok({"license": "unknown"}))

    def test_duplicate_candidates_are_assigned_to_different_scenes(self):
        shared = {"source": "Pexels", "stock": True, "title": "laptop desk", "license": "Pexels License (free)",
                  "url": "https://images.pexels.com/shared.jpg", "width": 1920, "height": 1080}
        alternate = {**shared, "title": "desk work", "url": "https://images.pexels.com/alternate.jpg"}
        urls = []

        def download(url, stem):
            urls.append(url)
            path = stem.with_suffix(".jpg")
            path.write_bytes(b"image")
            return path

        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(assets, "search_wikidata", return_value=[]), \
             mock.patch.object(assets, "search_commons", return_value=[]), \
             mock.patch.object(assets, "search_openverse", return_value=[shared, alternate]), \
             mock.patch.object(assets, "search_pexels", return_value=[]), \
             mock.patch.object(assets, "search_pixabay", return_value=[]), \
             mock.patch.object(assets, "_download", side_effect=download):
            result = assets.fetch(Path(tmp), [{"id": "first", "q": "laptop", "kind": "photo"},
                                             {"id": "second", "q": "desk", "kind": "photo"}])
        self.assertEqual(set(result), {"first", "second"})
        self.assertEqual(len(set(urls)), 2)

    def test_video_search_uses_mp4(self):
        video = {"id": 1, "duration": 8, "url": "https://www.pexels.com/video/1/", "user": {"name": "A"},
                 "video_files": [{"file_type": "video/mp4", "width": 1920, "height": 1080,
                                  "file_size": 1000, "link": "https://videos.pexels.com/video-files/1/clip.mp4"}]}
        with mock.patch.object(assets, "_api_key", return_value="test"), \
             mock.patch.object(assets, "_get_json", return_value={"videos": [video]}):
            self.assertEqual(assets.search_pexels_video("laptop")[0]["mime"], "video/mp4")

    def test_video_without_api_key_falls_back_to_photo(self):
        photo = {"source": "Pexels", "stock": True, "title": "laptop", "license": "Pexels License (free)",
                 "url": "https://images.pexels.com/laptop.jpg", "width": 1920, "height": 1080}

        def download(url, stem):
            path = stem.with_suffix(".jpg")
            path.write_bytes(b"image")
            return path

        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(assets, "_api_key", return_value=""), \
             mock.patch.object(assets, "search_commons_video", return_value=[]), \
             mock.patch.object(assets, "search_openverse", return_value=[photo]), \
             mock.patch.object(assets, "search_pexels", return_value=[]), \
             mock.patch.object(assets, "search_pixabay", return_value=[]), \
             mock.patch.object(assets, "_download", side_effect=download), \
             mock.patch.object(assets, "_download_video") as video_download:
            result = assets.fetch(Path(tmp), [{"id": "scene", "q": "laptop", "kind": "video"}])
        self.assertTrue(result["scene"].endswith(".jpg"))
        video_download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
