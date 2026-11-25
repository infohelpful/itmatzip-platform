"""Run with python -m unittest engines.autosub.test_autosub_composition (cwd agent).
Optional real-media checks use AUTOSUB_TEST_FFMPEG and AUTOSUB_TEST_FFPROBE or the agent binaries.
"""
from __future__ import annotations

import array
import math
import os
import struct
import subprocess
import tempfile
import time
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

from engines.autosub import composition as comp, export, media, paths


def timing(has_audio=True):
    return media.MediaTiming(2, 0, 64, 64, has_audio, '30/1', False)


def fixture():
    return {'version': 1, 'duration': 3.5, 'assets': [
        {'id': 'photo', 'kind': 'image', 'path': 'photo.png'},
        {'id': 'movie', 'kind': 'video', 'path': 'movie.mkv'}], 'clips': [
        {'id': 's0', 'kind': 'source', 'sourceStart': 0, 'sourceEnd': 1, 'duration': 1, 'programStart': 0},
        {'id': 'i0', 'kind': 'image', 'assetId': 'photo', 'duration': 1, 'programStart': 1, 'fit': 'contain'},
        {'id': 'v0', 'kind': 'video', 'assetId': 'movie', 'sourceStart': 0, 'sourceEnd': .5,
         'duration': .5, 'programStart': 2, 'fit': 'cover', 'muted': False},
        {'id': 's1', 'kind': 'source', 'sourceStart': 1, 'sourceEnd': 2, 'duration': 1, 'programStart': 2.5}],
        'overlays': []}


def fake_probe(path, kind):
    return {'path': path, 'kind': kind, 'duration': 1, 'width': 64, 'height': 64,
            'sourceOriginSec': 0, 'hasAudio': kind == 'video'}


class CompositionTests(unittest.TestCase):
    def test_rejects_invalid_plan_without_silently_dropping_media(self):
        changes = [lambda p: p.update(duration=4), lambda p: p['clips'][1].update(programStart=2),
                   lambda p: p['clips'][2].update(sourceEnd=2, duration=2),
                   lambda p: p['clips'][2].update(assetId='missing'),
                   lambda p: p['clips'][1].update(id='s0'),
                   lambda p: p['clips'][1].update(duration=True),
                   lambda p: p['clips'][0].update(sourceStart=float('nan'))]
        for change in changes:
            plan = fixture()
            change(plan)
            with self.subTest(plan=plan), self.assertRaises(ValueError):
                comp.resolve_composition(plan, timing(), fake_probe)

    def test_missing_unused_asset_does_not_prevent_export(self):
        raw = fixture()
        raw['assets'].append({'id': 'unused', 'path': 'deleted.png', 'kind': 'image'})
        used = []
        plan = comp.resolve_composition(raw, timing(), lambda p, k: (used.append(p), fake_probe(p, k))[1])
        self.assertEqual(used, ['photo.png', 'movie.mkv'])
        self.assertEqual(plan.duration, 3.5)

    def test_actual_probed_duration_overrides_client_metadata(self):
        with self.assertRaisesRegex(ValueError, 'exceeds'):
            comp.resolve_composition(fixture(), timing(), lambda p, k: {**fake_probe(p, k), 'duration': .2})

    def test_image_and_muted_video_have_silence_even_when_original_has_audio(self):
        raw = fixture()
        raw['clips'][2]['muted'] = True
        _, graph = comp.build_composition_graph(comp.resolve_composition(raw, timing(), fake_probe), timing())
        self.assertIn('anullsrc=r=48000:cl=stereo,atrim=end_sample=48000', graph)
        self.assertIn('anullsrc=r=48000:cl=stereo,atrim=end_sample=24000', graph)
        self.assertNotIn('[ca2]', graph)

    def test_silent_original_can_receive_a_video_with_audio(self):
        _, graph = comp.build_composition_graph(comp.resolve_composition(fixture(), timing(False), fake_probe), timing(False))
        self.assertNotIn('[0:a:0]', graph)
        self.assertIn('[3:a:0]', graph)

    def test_paths_are_argv_values_not_filter_graph_text(self):
        raw = fixture()
        raw['assets'][0]['path'] = "C:/한글 폴더/a'; [bad].png"
        args, graph = comp.build_composition_graph(comp.resolve_composition(raw, timing(), fake_probe), timing())
        self.assertIn(raw['assets'][0]['path'], args)
        self.assertNotIn(raw['assets'][0]['path'], graph)

    def test_rejects_a_program_with_no_output_frame(self):
        raw = fixture()
        raw['duration'] = 1e-12
        raw['clips'] = [{**raw['clips'][1], 'duration': 1e-12, 'programStart': 0}]
        with self.assertRaisesRegex(ValueError, 'duration'):
            comp.resolve_composition(raw, timing(), fake_probe)


def png(path: Path, color: tuple[int, int, int], width=64, height=64):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    raw = (b'\0' + bytes((*color, 255)) * width) * height
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
                     + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


class CompositionFFmpegTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ff = ((os.environ['AUTOSUB_TEST_FFMPEG'], os.environ['AUTOSUB_TEST_FFPROBE'])
                  if os.environ.get('AUTOSUB_TEST_FFMPEG') else paths.ffmpeg_paths())
        if not cls.ff:
            raise unittest.SkipTest('FFmpeg/ffprobe unavailable')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='autosub-composition-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / '원본.mkv'
        self.movie = self.root / '삽입.mkv'
        self.photo = self.root / '사진.png'
        png(self.photo, (0, 0, 255))
        for target, color, frequency, duration in [(self.source, 'red', 440, 2), (self.movie, 'green', 880, 1)]:
            self.run_ff(['-f', 'lavfi', '-i', f'color={color}:s=64x64:r=30:d={duration}',
                         '-f', 'lavfi', '-i', f'sine=frequency={frequency}:sample_rate=48000:duration={duration}',
                         '-c:v', 'ffv1', '-c:a', 'pcm_s16le', str(target)])
        self.source_timing = media.probe_media_timing(self.ff[1], self.source)

    def run_ff(self, argv):
        result = subprocess.run([self.ff[0], '-hide_banner', '-loglevel', 'error', '-y', *argv],
                                capture_output=True, timeout=45, creationflags=media._NO_WINDOW)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))
        return result.stdout

    def render(self, raw):
        raw['assets'][0]['path'] = str(self.photo)
        raw['assets'][1]['path'] = str(self.movie)
        with patch.object(paths, 'ffmpeg_paths', return_value=self.ff):
            plan = comp.resolve_composition(raw, self.source_timing)
        args, graph = comp.build_composition_graph(plan, self.source_timing, first_asset_input=1)
        output = self.root / 'output.mkv'
        self.run_ff(['-i', str(self.source), *args, '-filter_complex', graph,
                     '-map', '[vmain]', '-map', '[amain]', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', str(output)])
        return output

    def test_pixels_and_audio_of_insertions_and_original_resume(self):
        raw = fixture()
        yellow = self.root / '덮기.png'
        png(yellow, (255, 255, 0), width=16)
        raw['assets'].append({'id': 'overlay', 'kind': 'image', 'path': str(yellow)})
        raw['overlays'] = [{'id': 'o1', 'assetId': 'overlay', 'start': .25, 'end': .75, 'fit': 'cover'},
                           {'id': 'o2', 'assetId': 'overlay', 'start': 3, 'end': 3.25, 'fit': 'contain'}]
        output = self.render(raw)
        pixels = self.run_ff(['-i', str(output), '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
        self.assertEqual(len(pixels) // (64 * 64 * 3), 105)
        for time, expected in [(.1, (255, 0, 0)), (.4, (255, 255, 0)), (1.5, (0, 0, 255)),
                               (2.2, (0, 128, 0)), (2.8, (255, 0, 0)), (3.1, (255, 255, 0)), (3.4, (255, 0, 0))]:
            offset = (round(time * 30) * 64 * 64 + 32 * 64 + 32) * 3
            actual = pixels[offset:offset+3]
            self.assertTrue(all(abs(a-b) < 12 for a, b in zip(actual, expected)), (time, actual, expected))
        outside = (93 * 64 * 64 + 32 * 64 + 3) * 3
        self.assertTrue(all(abs(a-b) < 12 for a, b in zip(pixels[outside:outside+3], (255, 0, 0))),
                        'Contained overlay must preserve the original outside the image')
        samples = array.array('h', self.run_ff(['-i', str(output), '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-']))
        self.assertEqual(len(samples), 168000)
        def window(time):
            return samples[round(time*48000):round(time*48000)+4800]
        self.assertEqual(max(abs(v) for v in window(1.1)), 0, 'Original audio leaked into image insertion')
        def energy(values, hz):
            return abs(sum(v * complex(math.cos(i*2*math.pi*hz/48000), math.sin(i*2*math.pi*hz/48000)) for i, v in enumerate(values)))
        for time, expected, absent in [(.1, 440, 880), (2.1, 880, 440), (2.7, 440, 880)]:
            self.assertGreater(energy(window(time), expected), 100 * max(1, energy(window(time), absent)))

    def test_many_fractional_boundaries_do_not_accumulate_av_drift(self):
        raw = fixture()
        raw['clips'] = []
        cursor = 0.0
        for i in range(20):
            raw['clips'].append({'id': f's{i}', 'kind': 'source', 'sourceStart': 0, 'sourceEnd': .101,
                                 'duration': .101, 'programStart': cursor})
            cursor += .101
            raw['clips'].append({'id': f'i{i}', 'kind': 'image', 'assetId': 'photo', 'duration': .051,
                                 'programStart': cursor, 'fit': 'cover'})
            cursor += .051
        raw['duration'] = cursor
        output = self.render(raw)
        video = self.run_ff(['-i', str(output), '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
        audio = self.run_ff(['-i', str(output), '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'])
        self.assertEqual(len(video) // (64*64*3), comp.frame_at(cursor))
        self.assertEqual(len(audio) // 2, comp.frame_at(cursor) * 1600)

    def test_existing_export_job_encodes_composition_and_uploaded_caption_states(self):
        raw = fixture()
        raw['assets'][0]['path'] = str(self.photo)
        raw['assets'][1]['path'] = str(self.movie)
        with patch.object(paths, 'ffmpeg_paths', return_value=self.ff), \
                patch.object(export, 'select_h264_encoder', return_value='libx264'):
            started = export.start_video(str(self.source), str(self.root))
            # Opaque white state only during the first source second; inserts must remain visible.
            state = self.root / 'state.png'
            png(state, (255, 255, 255), started['renderWidth'], started['renderHeight'])
            export.put_state(started['jobId'], 0, state.read_bytes())
            export.start_encode(started['jobId'], [{'startFrame': 0, 'endFrame': 30}], [], raw)
            deadline = time.monotonic() + 40
            while time.monotonic() < deadline:
                status = export.job_status(started['jobId'])
                if status['state'] in ('done', 'error'):
                    break
                time.sleep(.05)
            else:
                export.cancel_job(started['jobId'])
                self.fail('Composition export did not finish')
        self.assertEqual(status['state'], 'done', status.get('error'))
        output = Path(status['outputPath'])
        decoded = media.probe_media_timing(self.ff[1], output)
        self.assertAlmostEqual(decoded.duration, 3.5, delta=.05)
        self.assertTrue(decoded.has_audio)
        pixels = self.run_ff(['-i', str(output), '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
        for frame, expected in [(10, (255, 255, 255)), (45, (0, 0, 255)), (66, (0, 128, 0)), (90, (255, 0, 0))]:
            offset = (frame*64*64 + 32*64+32)*3
            self.assertTrue(all(abs(a-b) < 15 for a, b in zip(pixels[offset:offset+3], expected)))


if __name__ == '__main__':
    unittest.main()
