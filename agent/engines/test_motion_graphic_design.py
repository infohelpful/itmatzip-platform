"""python -m unittest engines.test_motion_graphic_design"""
import unittest

from engines import motion_graphic_design as mgd


def subs():
    # 초당 30프레임 가정: 1번 0~90, 2번 90~180, 3번 180~270
    return {1: {"s": 3, "e": 90, "a": 0.1, "b": 3.0, "t": "하나"}, 2: {"s": 93, "e": 180, "a": 3.1, "b": 6.0, "t": "둘"},
            3: {"s": 183, "e": 270, "a": 6.1, "b": 9.0, "t": "셋"}}


def design(segments):
    return {"version": 2, "style": "MINT_WAVE", "fps": {"num": 30, "den": 1, "value": 30.0}, "width": 1920, "height": 1080,
            "durationInFrames": 600, "segments": segments}


class DesignTests(unittest.TestCase):
    def test_full_with_no_valid_beats_still_gets_a_scene(self):
        seg = {"id": "A", "type": "FULL", "from": 0, "durationInFrames": 270, "title": "설명"}
        out = mgd.normalize_segment({"scenes": [{"template": "PHOTO_POINTS", "beats": [], "vars": {}}]},
                                    seg, subs(), mgd.catalog())
        self.assertEqual(out["scenes"][0]["template"], "STATEMENT")
        self.assertEqual(out["scenes"][0]["beats"][0]["frame"], 0)

    def test_overlay_beat_until_is_sentence_end(self):
        seg = {"id": "C", "type": "OVERLAY", "from": 0, "durationInFrames": 270}
        out = mgd.normalize_segment({"beats": [{"sub": 2, "fx": "zoom", "target": [10, 10, 50, 20]}, {"sub": 3, "fx": "ring", "target": [1, 1, 5, 5]}]},
                                    seg, subs(), mgd.catalog())
        self.assertEqual([(b["frame"], b["until"]) for b in out["beats"]], [(90, 180), (180, 269)])  # 마지막은 구간 끝 안쪽으로 clamp

    def test_split_overlay_moves_beats_and_keeps_total(self):
        d = design([{"id": "C", "type": "OVERLAY", "from": 0, "durationInFrames": 300,
                     "beats": [{"frame": 10, "fx": "ring"}, {"frame": 120, "fx": "zoom"}, {"frame": 250, "fx": "ring"}]}])
        new = mgd.split_at(d, 100)
        self.assertEqual(new, "C2")
        a, b = d["segments"]
        self.assertEqual((a["from"], a["durationInFrames"], b["from"], b["durationInFrames"]), (0, 100, 100, 200))
        self.assertEqual([x["frame"] for x in a["beats"]], [10])
        self.assertEqual([x["frame"] for x in b["beats"]], [120, 250])
        self.assertIsNone(mgd.split_at(d, 100))  # 경계에서는 쪼개지 않음
        self.assertIsNone(mgd.split_at(d, 0))

    def test_split_full_keeps_active_scene_on_both_sides(self):
        sc = lambda tpl, frames: {"template": tpl, "vars": {"text": tpl}, "beats": [{"sub": None, "frame": f} for f in frames]}
        d = design([{"id": "A", "type": "FULL", "from": 0, "durationInFrames": 400,
                     "scenes": [sc("TITLE", [0, 60]), sc("STEPS", [150, 200, 260]), sc("ENDING", [330])]}])
        d["segments"][0]["beats"] = [x for s in d["segments"][0]["scenes"] for x in s["beats"]]
        self.assertEqual(mgd.split_at(d, 220), "A2")
        left, right = d["segments"]
        self.assertEqual([s["template"] for s in left["scenes"]], ["TITLE", "STEPS"])
        self.assertEqual([s["template"] for s in right["scenes"]], ["STEPS", "ENDING"])
        self.assertEqual([x["frame"] for x in left["scenes"][1]["beats"]], [150, 200])
        self.assertEqual([x["frame"] for x in right["scenes"][0]["beats"]], [220, 260])  # 진행 중이던 장면이 이어지고 첫 비트는 분할 지점
        self.assertEqual(right["from"], 220)

    def test_new_ids_are_unique_alnum(self):
        d = design([{"id": "A", "type": "NONE", "from": 0, "durationInFrames": 300, "beats": []},
                    {"id": "A2", "type": "NONE", "from": 300, "durationInFrames": 300, "beats": []}])
        self.assertEqual(mgd.split_at(d, 100), "A3")
        self.assertTrue(all(s["id"].isalnum() for s in d["segments"]))


if __name__ == "__main__":
    unittest.main()


class StyleTests(unittest.TestCase):
    def test_style_is_made_readable_and_dark(self):
        from engines import motion_graphic_styles as st
        r = st.normalize_style({"name": "밝은 시안", "bg": "waves", "energy": 3, "colors": {"bg": "#e8e8e8", "deep": "#ffffff", "primary": "#333333",
                                                                                          "accent": "#555555", "text": "#999999", "text2": "#bbbbbb"}})
        c = r["colors"]
        self.assertLess(st.luminance(c["bg"]), 0.08)               # 배경은 어둡게
        self.assertGreaterEqual(st.contrast(c["text"], c["bg"]), 7.0)  # 글자는 읽히게
        self.assertGreaterEqual(st.contrast(c["accent"], c["bg"]), 4.5)
        self.assertEqual((r["bg"], r["energy"]), ("waves", 1.4))     # 범위 밖은 clamp

    def test_bad_style_falls_back(self):
        from engines import motion_graphic_styles as st
        self.assertEqual(st.normalize_style("x")["colors"]["bg"], "#001E3C")
        self.assertEqual(st.normalize_style({"bg": "mystery", "colors": {"bg": "red"}})["bg"], "aurora")


class HistoryTests(unittest.TestCase):
    def test_history_reads_projects_automatically(self):
        import json
        import os
        import tempfile
        from pathlib import Path
        from engines import motion_graphic_styles as st
        root = Path(tempfile.mkdtemp())
        os.environ["ITMATZIP_MOTION_PROJECTS"] = str(root)
        try:
            for pid, name, ts, style in (("mg_a", "595화 윈도우 검색.mp4", "2026-11-18T10:00:00", {"name": "블루", "bg": "grid", "colors": {"bg": "#001e3c"}}),
                                         ("mg_b", "601화 무음.mp4", "2026-11-19T10:00:00", {"name": "민트", "bg": "waves", "colors": {"bg": "#04121a"}}),
                                         ("mg_c", "디자인 없는 프로젝트.mp4", "", None),
                                         ("mg_b2", "설계만 하고 내보내지 않은.mp4", "2026-11-20T10:00:00", {"name": "레드", "bg": "grid", "colors": {"bg": "#0b0608"}})):
                d = root / pid
                d.mkdir()
                (d / "project.json").write_text(json.dumps({"id": pid, "video_name": name, "created": ts}), encoding="utf-8")
                if style:
                    (d / "design.json").write_text(json.dumps({"version": 2, "style": style, "updated": ts}), encoding="utf-8")
                if style and pid != "mg_b2":
                    (d / "output.mp4").write_bytes(b"x")  # 내보내기를 끝낸 프로젝트
            items = st.list_styles()
            names = [x["name"] for x in items if not x["seed"]]
            self.assertEqual(names, ["601화 무음", "595화 윈도우 검색"])        # 최근 순, 프로젝트 이름(확장자 없이), 설계서 없거나 내보내지 않은 프로젝트는 제외
            self.assertEqual([x["id"] for x in st.list_styles(exclude="mg_b") if not x["seed"]], ["mg_a"])  # 열린 프로젝트는 뺀다
            self.assertEqual(sum(1 for x in items if x["seed"]), 2)             # 이전 작업 두 개는 항상 함께
            got = st.as_design(st.get_style("mg_a"))
            self.assertEqual((got["bg"], got["ref"], got["ref_name"]), ("grid", "mg_a", "595화 윈도우 검색"))
            self.assertIsNone(st.get_style("../etc"))
        finally:
            os.environ.pop("ITMATZIP_MOTION_PROJECTS", None)


class MediaTests(unittest.TestCase):
    def test_unused_asset_requests_are_skipped(self):
        d = {"segments": [{"scenes": [{"vars": {"img": "asset:used"}}]}]}
        wanted = [{"id": "used", "q": "RAM"}, {"id": "unused", "q": "screen"}]
        self.assertEqual(mgd._referenced_assets(d, wanted), wanted[:1])

    def test_media_modes_filter_downloads_in_code(self):
        wanted = [{"id": "a", "q": "Windows 11 logo", "kind": "logo"}, {"id": "b", "q": "laptop desk", "kind": "photo"},
                  {"id": "c", "q": "ui", "kind": "screenshot"}, {"id": "d", "q": "laptop motion", "kind": "video"}]
        self.assertEqual(len(mgd.filter_assets(wanted, "photo")), 3)
        self.assertEqual([a["id"] for a in mgd.filter_assets(wanted, "logo")], ["a"])
        self.assertEqual(mgd.filter_assets(wanted, "emoji"), [])  # 웹에서 아무것도 받지 않는다
        self.assertEqual(len(mgd.filter_assets(wanted, "video")), 4)

    def test_unfetched_assets_fall_back_sensibly(self):
        d = {"segments": [{"scenes": [{"vars": {"logo1": "asset:a", "i1": "asset:b", "img": "asset:c", "logo2": "asset:d"}}]}]}
        mgd.resolve_assets(d, {"d": "web/x.png"}, {"a": "Silicon Valley logo", "b": "x", "c": "y", "d": "z"})
        v = d["segments"][0]["scenes"][0]["vars"]
        self.assertEqual(v["logo1"], "Silicon Valley")  # 로고 자리: 이름 글자 (silicon 이 잘리지 않음)
        self.assertEqual(v["i1"], "◆")                   # 아이콘 자리: 기본 기호
        self.assertNotIn("img", v)                        # 사진 자리: 비워서 영상 화면 캡처가 채운다
        self.assertEqual(v["logo2"], "web/x.png")

    def test_prompts_carry_media_and_fetch_more_rules(self):
        an = {"duration_sec": 10, "fps": {"value": 30}, "subs": {"1": {"a": 0, "b": 3, "t": "x", "s": 3, "e": 90}}, "static_runs": []}
        self.assertIn("웹에서 이미지를 받지 않습니다", mgd.design_prompt(an, None, "", "", "emoji"))
        self.assertIn("kind 가 logo 인 것만", mgd.design_prompt(an, None, "", "", "logo"))
        self.assertNotIn("소재 규칙", mgd.design_prompt(an, None, "", "", "photo"))
        self.assertIn("kind=video", mgd.design_prompt(an, None, "", "", "video"))
        d = design([{"id": "A", "type": "FULL", "from": 0, "durationInFrames": 300, "beats": []}])
        base = mgd.edit_prompt(d, d["segments"], subs(), "문구 바꿔줘", 0, 300, None)
        more = mgd.edit_prompt(d, d["segments"], subs(), "문구 바꿔줘", 0, 300, None, True)
        self.assertNotIn("자료 보강 요청", base)
        self.assertIn("자료 보강 요청", more)


class RedesignTests(unittest.TestCase):
    def test_tracking_stops_at_sentence_or_next_beat(self):
        self.assertEqual(mgd._tracking_end({"frame": 100, "until": 160, "fx": "zoom"}, 300, 900), 174)
        self.assertEqual(mgd._tracking_end({"frame": 100, "until": 200, "fx": "zoom"}, 130, 900), 130)

    def test_detail_mode_prompt(self):
        d = design([{"id": "A", "type": "FULL", "from": 0, "durationInFrames": 300, "beats": []}])
        base = mgd.edit_prompt(d, d["segments"], subs(), "다시", 0, 300, None)
        det = mgd.edit_prompt(d, d["segments"], subs(), "다시", 0, 300, None, False, True)
        self.assertNotIn("디테일 재설계", base)
        self.assertIn("디테일 재설계", det)
        self.assertIn("keys", det)      # 장면마다 문장별 키워드
        self.assertIn("zoom 비트를 연달아", det)  # OVERLAY 연속 확대

    def test_edit_prompt_omits_old_tracking_path(self):
        d = design([{"id": "C", "type": "OVERLAY", "from": 0, "durationInFrames": 300,
                    "beats": [{"frame": 10, "fx": "zoom", "target": [10, 10, 40, 30], "track": [[10, 10, 10, 40, 30]] * 100}]}])
        prompt = mgd.edit_prompt(d, d["segments"], subs(), "다시", 0, 300, None)
        self.assertIn('"target": [10, 10, 40, 30]', prompt)
        self.assertNotIn('"track"', prompt)


class QualityGateTests(unittest.TestCase):
    def test_initial_design_is_checked_and_applied_automatically(self):
        import json
        import os
        import tempfile
        from pathlib import Path
        from unittest import mock
        from engines import motion_graphic as mg
        with tempfile.TemporaryDirectory() as tmp:
            old = os.environ.get("ITMATZIP_MOTION_PROJECTS")
            os.environ["ITMATZIP_MOTION_PROJECTS"] = tmp
            try:
                pid = "mg_20261121_000001_abcd"
                root = Path(tmp) / pid
                root.mkdir()
                (root / "project.json").write_text(json.dumps({"id": pid, "video_path": "unused.mp4"}), encoding="utf-8")
                an = {"duration_sec": 9, "duration_frames": 270, "fps": {"num": 30, "den": 1, "value": 30.0},
                      "width": 1920, "height": 1080, "static_runs": [],
                      "subs": {str(n): {**s, "mean": .01, "moving": 0} for n, s in subs().items()}}
                (root / "analysis.json").write_text(json.dumps(an), encoding="utf-8")
                answer = {"segments": [{"id": "A", "type": "FULL", "start_sec": 0, "title": "램 선택",
                             "scenes": [{"template": "SHOWCASE", "vars": {"header": "램 선택", "caption": "16GB", "img": "asset:missing"},
                                         "beats": [1]}]}],
                          "assets": [{"id": "missing", "q": "DDR5 RAM", "kind": "photo"}]}
                job = "quality-test"
                mgd._jobs[job] = {"cancel": False, "steps": [{"key": k, "state": "queued"}
                    for k in ("analyze", "design", "assets", "locate")]}
                with mock.patch.object(mgd, "_cli", return_value=answer), \
                     mock.patch.object(mgd.mgassets, "fetch", side_effect=RuntimeError("offline")), \
                     mock.patch.object(mgd, "locate_targets", return_value=0), \
                     mock.patch.object(mgd, "track_targets", return_value=0), \
                     mock.patch.object(mgd, "_thumbs"):
                    mgd._run_design(job, pid, "codex", None, "", "")
                saved = mgd.load_design(pid)
                self.assertTrue(saved["applied"])
                self.assertEqual(saved["segments"][0]["scenes"][0]["template"], "STATEMENT")
                self.assertEqual(saved["quality"]["graphic_fallbacks"], 1)
                mgd.validate_design(saved)
            finally:
                mgd._jobs.pop("quality-test", None)
                if old is None:
                    os.environ.pop("ITMATZIP_MOTION_PROJECTS", None)
                else:
                    os.environ["ITMATZIP_MOTION_PROJECTS"] = old

    def test_static_source_frames_become_content_graphics_and_keys_are_filled(self):
        scene = {"template": "IMAGE_CARDS", "vars": {"header": "램 선택", "t1": "용량표", "t2": "후기",
                 "s1": "어려운 사양", "s2": "제각각인 의견", "img1": "frames/one.jpg", "img2": "frames/two.jpg"},
                 "beats": [{"sub": 1, "frame": 0}], "keys": [{"sub": 1, "frame": 0, "text": "램 선택"}]}
        d = design([{"id": "A", "type": "FULL", "from": 0, "durationInFrames": 270, "title": "램 선택",
                     "scenes": [scene], "beats": scene["beats"]}])
        d["durationInFrames"] = 270
        an = {"subs": {str(n): {**s, "mean": .04, "moving": 0.0} for n, s in subs().items()}}
        report = mgd.finalize_design(d, an)
        self.assertEqual(report["stale_frames_removed"], 2)
        self.assertEqual(report["graphic_fallbacks"], 1)
        self.assertEqual(report["keys_added"], 2)
        self.assertEqual(scene["template"], "COMPARE")
        self.assertEqual(scene["vars"]["left"], "용량표")
        self.assertEqual([k["sub"] for k in scene["keys"]], [1, 2, 3])
        mgd.validate_design(d)

    def test_apply_repairs_existing_static_project_without_video_capture(self):
        import json
        import os
        import tempfile
        from pathlib import Path
        from engines import motion_graphic as mg
        with tempfile.TemporaryDirectory() as tmp:
            old = os.environ.get("ITMATZIP_MOTION_PROJECTS")
            os.environ["ITMATZIP_MOTION_PROJECTS"] = tmp
            try:
                pid = "mg_20261121_000000_abcd"
                root = Path(tmp) / pid
                root.mkdir()
                (root / "project.json").write_text(json.dumps({"id": pid, "video_path": "unused.mp4"}), encoding="utf-8")
                an = {"subs": {str(n): {**s, "mean": .01, "moving": 0} for n, s in subs().items()}}
                (root / "analysis.json").write_text(json.dumps(an), encoding="utf-8")
                sc = {"template": "SHOWCASE", "vars": {"header": "RAM", "caption": "16GB", "img": "frames/missing.jpg"},
                      "beats": [{"sub": 1, "frame": 0}]}
                d = design([{"id": "A", "type": "FULL", "from": 0, "durationInFrames": 270,
                             "scenes": [sc], "beats": sc["beats"]}])
                d["durationInFrames"] = 270
                mg._write_json(root / "design.json", d)
                got = mgd.apply(pid)
                self.assertTrue(got["applied"])
                self.assertEqual(got["segments"][0]["scenes"][0]["template"], "STATEMENT")
                self.assertEqual(got["quality"]["graphic_fallbacks"], 1)
            finally:
                if old is None:
                    os.environ.pop("ITMATZIP_MOTION_PROJECTS", None)
                else:
                    os.environ["ITMATZIP_MOTION_PROJECTS"] = old


class FetchRetryTests(unittest.TestCase):
    def test_query_variants_get_shorter(self):
        from engines import motion_graphic_assets as a
        self.assertEqual(a._variants("DDR5 desktop RAM stick module", "photo"),
                         ["DDR5 desktop RAM stick module", "DDR5 desktop RAM"])
        self.assertEqual(a._variants("Windows 11 Start menu screenshot", "screenshot")[:2], ["Windows 11 Start menu screenshot", "Windows 11 Start menu"])
        self.assertEqual(a._variants("PowerToys Run logo", "logo"), ["PowerToys Run logo"])  # 이미 짧은 로고 검색어는 그대로


class RelevanceTests(unittest.TestCase):
    def test_unrelated_hits_are_rejected(self):
        from engines import motion_graphic_assets as a
        self.assertFalse(a._relevant("File:Vought F4U Corsair (USMC).jpg", "logo", "Corsair"))          # 동음이의어 전투기
        self.assertFalse(a._relevant("File:Internet Explorer 10 (Windows 8 app).png", "logo", "Windows 11 logo modern"))
        self.assertFalse(a._relevant("File:ASUS V400 AiO 2026-08-08.jpg", "photo", "DDR5 desktop RAM memory kit closeup"))
        self.assertTrue(a._relevant("File:DeepSeek logo.svg", "logo", "DeepSeek AI logo"))
        self.assertTrue(a._relevant("File:DDR5 RAM module.jpg", "photo", "DDR5 RAM module"))


class OpenDirTests(unittest.TestCase):
    def test_open_project_folder_launches_explorer_with_the_project_dir(self):
        import os
        import tempfile
        from pathlib import Path
        from unittest import mock
        from engines import motion_graphic as mg
        root = Path(tempfile.mkdtemp())
        os.environ["ITMATZIP_MOTION_PROJECTS"] = str(root)
        try:
            pid = "mg_20261121_000000_abcd"
            (root / pid).mkdir()
            with mock.patch.object(mg.subprocess, "Popen") as popen:
                self.assertEqual(mg.open_project_folder(pid), os.name == "nt")
                if os.name == "nt":
                    self.assertEqual(popen.call_args[0][0], ["explorer", str(root / pid)])
            with mock.patch.object(mg.subprocess, "Popen") as popen:
                self.assertFalse(mg.open_project_folder("mg_20261121_000000_ffff"))  # 없는 프로젝트는 열지 않는다
                popen.assert_not_called()
        finally:
            os.environ.pop("ITMATZIP_MOTION_PROJECTS", None)


class QueryRuleTests(unittest.TestCase):
    def test_prompts_demand_concrete_names_and_gate_is_strict(self):
        from engines import motion_graphic_assets as a
        an = {"duration_sec": 10, "fps": {"value": 30}, "subs": {"1": {"a": 0, "b": 3, "t": "x", "s": 3, "e": 90}}, "static_runs": []}
        self.assertIn("검색어 규칙", mgd.design_prompt(an, None, "", "", "photo"))
        self.assertNotIn("검색어 규칙", mgd.design_prompt(an, None, "", "", "emoji"))
        d = design([{"id": "A", "type": "FULL", "from": 0, "durationInFrames": 300, "beats": []}])
        self.assertIn("검색어 규칙", mgd.edit_prompt(d, d["segments"], subs(), "다시", 0, 300, None))
        self.assertFalse(a._relevant("File:Anti ai data center 4 censored.png", "photo", "AI data center server racks GPU HBM memory"))
        self.assertTrue(a._score({"title": "x", "trusted": True}, "logo", "x") > a._score({"title": "x logo"}, "logo", "x logo"))


class UserImageTests(unittest.TestCase):
    PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32

    def _project(self):
        import json
        import os
        import tempfile
        from pathlib import Path
        root = Path(tempfile.mkdtemp())
        os.environ["ITMATZIP_MOTION_PROJECTS"] = str(root)
        self.addCleanup(lambda: os.environ.pop("ITMATZIP_MOTION_PROJECTS", None))
        pid = "mg_20261121_000000_abcd"
        (root / pid).mkdir()
        (root / pid / "project.json").write_text(json.dumps({"id": pid, "video_path": "x.mp4"}), encoding="utf-8")
        return pid

    def test_upload_checks_content_not_extension(self):
        pid = self._project()
        got = mgd.save_user_image(pid, "내 사진.exe", self.PNG)
        self.assertTrue(got["name"].endswith(".png"))           # 확장자가 아니라 내용으로 판단
        self.assertEqual(mgd.save_user_image(pid, "내 사진.png", self.PNG)["name"], "내_사진_2.png")  # 이름 충돌은 번호로
        with self.assertRaises(ValueError):
            mgd.save_user_image(pid, "a.png", b"MZ\x90\x00 not an image")
        with self.assertRaises(ValueError):
            mgd.save_user_image(pid, "big.png", self.PNG + b"0" * mgd.USER_IMAGE_MAX)
        self.assertEqual(len(mgd.list_user_images(pid)), 2)
        self.assertTrue(mgd.delete_user_image(pid, "../" + got["name"]))  # 경로 조작은 파일 이름만 본다

    def test_place_image_replaces_the_subtitle_range_only(self):
        from unittest import mock
        pid = self._project()
        name = mgd.save_user_image(pid, "ram.png", self.PNG)["name"]
        d = design([{"id": "A", "type": "NONE", "from": 0, "durationInFrames": 600, "beats": []}])
        saved = {}
        with mock.patch.object(mgd, "ensure_analysis", return_value={"subs": {str(n): s for n, s in subs().items()}}), \
             mock.patch.object(mgd, "load_design", return_value=d), mock.patch.object(mgd, "save_design", side_effect=lambda p, x: saved.update(x)), \
             mock.patch.object(mgd, "_thumbs"):
            out = mgd.place_user_image(pid, name, 2)
        segs = out["segments"]
        self.assertEqual([(s["from"], s["durationInFrames"], s["type"]) for s in segs], [(0, 93, "NONE"), (93, 87, "FULL"), (180, 420, "NONE")])  # 2번 자막(93~180)만 FULL
        self.assertEqual(sum(s["durationInFrames"] for s in segs), 600)
        sc = segs[1]["scenes"][0]
        self.assertEqual((sc["template"], sc["vars"]["img"]), ("SHOWCASE", f"user/{name}"))
        with self.assertRaises(ValueError):
            with mock.patch.object(mgd, "ensure_analysis", return_value={"subs": {}}), mock.patch.object(mgd, "load_design", return_value=d):
                mgd.place_user_image(pid, name, 9)
