"""python -m unittest engines.test_motion_graphic_analyze"""
import unittest
from fractions import Fraction
from types import SimpleNamespace

from engines import motion_graphic_analyze as mga


def series(values, start=0.5):
    return [(start + i * 0.5, v) for i, v in enumerate(values)]


class AnalyzeTests(unittest.TestCase):
    def test_fps_keeps_ntsc_fraction(self):
        self.assertEqual(mga.parse_fps("30000/1001"), Fraction(30000, 1001))
        self.assertEqual(mga.parse_fps("0/0"), Fraction(30))
        # 14:45 를 30 으로 두면 29.97 대비 27 프레임(약 0.9초) 어긋난다
        self.assertEqual(mga.to_frame(885.29, Fraction(30)) - mga.to_frame(885.29, Fraction(30000, 1001)), 27)

    def test_parse_motion_output(self):
        text = "frame:0 pts:1 pts_time:0.5\nlavfi.signalstats.YAVG=0.13\nframe:1 pts:2 pts_time:1\nlavfi.signalstats.YAVG=12.5\n"
        self.assertEqual(mga.parse_motion(text), [(0.5, 0.13), (1.0, 12.5)])

    def test_static_runs_tolerate_one_blip(self):
        vals = [0.1] * 10 + [2.0] + [0.1] * 10 + [50, 60, 40] + [0.1] * 4
        runs = mga.static_runs(series(vals))
        self.assertEqual(len(runs), 1)  # 마지막 2초 정지는 4초 미만이라 버림
        self.assertAlmostEqual(runs[0][0], 0.0)
        self.assertGreaterEqual(runs[0][1] - runs[0][0], 10)

    def test_cuts_merge_nearby_spikes(self):
        self.assertEqual(mga.cuts(series([0, 80, 90, 0, 0, 0, 120])), [1.0, 3.5])

    def test_logo_candidate_needs_gap_and_cut(self):
        cues = [SimpleNamespace(start=0, end=50, text="a"), SimpleNamespace(start=55.6, end=58, text="b"),
                SimpleNamespace(start=60, end=62, text="c")]
        subs = mga.subs_table(cues, Fraction(30000, 1001))
        self.assertEqual(subs[2]["s"], round(55.6 * 30000 / 1001))
        found = mga.logo_candidates(subs, [52.1], duration=800)
        self.assertEqual([(c["after_sub"], c["before_sub"]) for c in found], [(1, 2)])
        self.assertEqual(mga.logo_candidates(subs, [], duration=800), [])

    def test_parse_directives_korean_times(self):
        text = ("설계단계로 넘어가는데\n"
                "0 ~ 41초 오프닝 배경 제거하고 전면 모션그래픽 적용\n"
                "41~45초 내 인트로 로고 영상 - 모션그래픽 효과 적용하면 안됨\n"
                "45초~2분6초 설명 영상 - 텍스트도 넣지말고 주요부분 확대 하이라이트 만 적용, 메일주소 블러 처리\n"
                "3분16초 ~ 3분56초 까지 설명글 + 전면 모션그래픽 섞어서 적용\n"
                "6분35초~8분11초 전면 모션그래픽으로 적용해줘.\n")
        got = [(d["from_sec"], d["to_sec"], d["kind"], d["blur"]) for d in mga.parse_directives(text)]
        self.assertEqual(got, [(0, 41, "FULL", False), (41, 45, "NONE", False), (45, 126, "OVERLAY", True),
                               (196, 236, "MIXED", False), (395, 491, "FULL", False)])

    def test_boundary_candidates_offer_each_kind(self):
        cues = [SimpleNamespace(start=40, end=41.2, text="a"), SimpleNamespace(start=55.6, end=58, text="b")]
        subs = mga.subs_table(cues, Fraction(30))
        got = {c["by"].split()[0]: c["sec"] for c in mga.boundary_candidates(41, subs, [52.08], [(0, 51.5)])}
        self.assertEqual(got, {"문장": 41.2, "화면": 52.08, "정지": 51.5})

    def test_classify_hint(self):
        self.assertEqual(mga.classify_hint({"mean": 0.1, "max": 0.4, "moving": 0.0}), "FULL")
        self.assertEqual(mga.classify_hint({"mean": 9.0, "max": 120, "moving": 0.4}), "OVERLAY")


if __name__ == "__main__":
    unittest.main()
