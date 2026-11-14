"""Regressions for source duration and synchronized cuts in Resolve XML."""
import unittest
import xml.etree.ElementTree as ET

from engines.silence_remover import SilenceSegment, create_fcp7_xml


class FcpXmlTests(unittest.TestCase):
    def make_sequence(self, remove_silent=True, fps=30):
        xml = create_fcp7_xml(
            [(1000, 3000), (5000, 9000)], fps=fps,
            duration_sec=10, remove_silent=remove_silent,
            clip_filename="source & clip.mp4",
            silences=[SilenceSegment(0, 1), SilenceSegment(3, 5), SilenceSegment(9, 10)],
        )
        self.assertIn("rev=3", xml)
        return ET.fromstring(xml).find("sequence")

    def assert_valid_cuts(self, sequence):
        video = sequence.findall("media/video/track/clipitem")
        audio = sequence.findall("media/audio/track/clipitem")
        self.assertEqual(len(video), len(audio))
        cursor = 0
        source_duration = int(video[0].findtext("file/duration"))
        for v, a in zip(video, audio):
            values = {tag: int(v.findtext(tag)) for tag in ("duration", "start", "end", "in", "out")}
            self.assertEqual(values, {tag: int(a.findtext(tag)) for tag in values})
            self.assertEqual(values["duration"], source_duration)
            self.assertLessEqual(values["out"], values["duration"])
            self.assertGreater(values["out"], values["in"])
            self.assertEqual(values["start"], cursor)
            self.assertEqual(values["end"] - cursor, values["out"] - values["in"])
            cursor = values["end"]
        self.assertEqual(cursor, int(sequence.findtext("duration")))
        return video

    def test_remove_silence_preserves_source_offsets(self):
        sequence = self.make_sequence()
        clips = self.assert_valid_cuts(sequence)
        self.assertEqual(len(clips), 2)
        self.assertEqual(int(sequence.findtext("duration")), 180)
        self.assertEqual([(int(c.findtext("in")), int(c.findtext("out"))) for c in clips], [(30, 90), (150, 270)])

    def test_cut_only_keeps_full_duration(self):
        sequence = self.make_sequence(remove_silent=False)
        self.assertEqual(len(self.assert_valid_cuts(sequence)), 5)
        self.assertEqual(int(sequence.findtext("duration")), 300)

    def test_fractional_fps(self):
        sequence = self.make_sequence(fps=29.97)
        self.assert_valid_cuts(sequence)
        self.assertEqual(sequence.findtext("rate/ntsc"), "TRUE")

    def test_no_silence_keeps_one_complete_clip(self):
        sequence = ET.fromstring(create_fcp7_xml([(0, 10000)], fps=30, duration_sec=10)).find("sequence")
        self.assertEqual(len(self.assert_valid_cuts(sequence)), 1)
        self.assertEqual(int(sequence.findtext("duration")), 300)


if __name__ == "__main__":
    unittest.main()
