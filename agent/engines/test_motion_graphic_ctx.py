"""모션그래픽도구 순수 로직 테스트 — cd agent && python -m unittest engines.test_motion_graphic_ctx"""

from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engines import motion_graphic_ctx as mgx  # noqa: E402


SRT = """﻿1
00:00:01,000 --> 00:00:04,000
오늘은 <i>로컬 AI</i> 세팅법을
알아보겠습니다.

2
00:00:04,500 --> 00:00:08,000
기존 방식보다 속도가 3배 빠릅니다.

3
00:00:20,000 --> 00:00:22,000
끝
"""


def _pcm(segments):
    sr = 8000
    out = bytearray()
    for seconds, amp in segments:
        for i in range(int(sr * seconds)):
            out += struct.pack("<h", int(amp * math.sin(2 * math.pi * 220 * i / sr)))
    return bytes(out), sr


class MotionGraphicCtxTest(unittest.TestCase):
    def test_parse_srt_strips_numbers_tags_and_joins_lines(self):
        cues = mgx.parse_srt(SRT.replace("\n", "\r\n"))
        assert [c.text for c in cues] == ["오늘은 로컬 AI 세팅법을 알아보겠습니다.", "기존 방식보다 속도가 3배 빠릅니다.", "끝"]
        assert cues[0].start == 1.0 and cues[1].end == 8.0


    def test_parse_srt_with_doubled_line_endings(self):
        # 브라우저에서 읽은 \r\n 을 Windows 텍스트 모드로 저장하면 \r\r\n 이 된다 (595화 실제 사례: 0줄로 읽혀 AI 가 엉뚱한 내용을 지어냄)
        text = "1\r\r\n00:00:00,000 --> 00:00:03,962\r\r\n윈도우 11 검색창\r\r\n\r\r\n2\r\r\n00:00:03,962 --> 00:00:06,430\r\r\n느린 반응 속도\r\r\n"
        cues = mgx.parse_srt(text)
        self.assertEqual([c.text for c in cues], ["윈도우 11 검색창", "느린 반응 속도"])

    def test_cues_to_lines_are_30fps_frames(self):
        lines = mgx.cues_to_lines(mgx.parse_srt(SRT))
        assert lines[0] == {"f": [30, 119], "s": "오늘은 로컬 AI 세팅법을 알아보겠습니다."}
        assert lines[1]["f"][0] == 135


    def test_plan_chunks_short_video_is_single_chunk(self):
        assert mgx.plan_chunks([], 3000) == [[0, 3000]]


    def test_plan_chunks_splits_at_longest_gap_near_3min(self):
        lines = []
        f = 0
        while f < 12 * 60 * 30:
            gap = 200 if f in (5100, 10500) else 20
            lines.append({"f": [f, f + 100], "s": "x"})
            f += 100 + gap
        chunks = mgx.plan_chunks(lines, 12 * 60 * 30)
        assert chunks[0][0] == 0 and chunks[-1][1] == 12 * 60 * 30
        assert all(b > a for a, b in chunks)
        assert 3 <= len(chunks) <= 5
        for a, b in chunks[:-1]:
            assert abs((b - a) - mgx.CHUNK_FRAMES) <= mgx.CHUNK_SEARCH_WINDOW
        # 경계가 휴지기 한가운데 → 어떤 줄도 경계를 가로지르지 않는다
        for _, b in chunks[:-1]:
            assert not any(ln["f"][0] < b <= ln["f"][1] for ln in lines)


    def test_assign_keyframes_marks_same_screen(self):
        lines = [{"f": [0, 50], "s": "a"}, {"f": [60, 100], "s": "b"}, {"f": [400, 450], "s": "c"}]
        mgx.assign_keyframes(lines, [(0.0, "kf_0001.jpg"), (10.0, "kf_0002.jpg")])
        assert [ln["img"] for ln in lines] == ["kf_0001.jpg", "SAME", "kf_0002.jpg"]


    def test_onsets_and_snap(self):
        pcm, sr = _pcm([(1.0, 0), (1.0, 12000), (1.0, 0), (1.0, 12000)])
        levels = mgx.frame_levels_db(pcm, sr)
        assert 115 <= len(levels) <= 125
        onsets = mgx.detect_onsets(levels)
        assert [o for o in onsets if 25 <= o <= 35] and [o for o in onsets if 85 <= o <= 95]
        assert mgx.snap_frame(28, onsets) in range(29, 32)
        assert mgx.snap_frame(50, onsets) == 50  # 창 밖이면 그대로



if __name__ == "__main__":
    unittest.main()
