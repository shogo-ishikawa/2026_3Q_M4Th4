"""外部配信に接続せず、実FFmpegと分離器の境界を確認します。"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vocal_lab import audio
from vocal_lab.pipeline import run_analysis


class IntervalTests(unittest.TestCase):
    def test_valid_fractional_interval(self):
        self.assertEqual(audio.validate_interval(1.25, 61.75, 100), (1.25, 61.75))

    def test_invalid_intervals_are_never_truncated(self):
        for start, end in [(0, 9), (0, 181), (-1, 60), (10, 10), (60, 10), (0, float("inf")),
                           (float("nan"), 60), (False, 60), ("bad", 60)]:
            with self.subTest(start=start, end=end), self.assertRaises(audio.AudioInputError):
                audio.validate_interval(start, end)
        with self.assertRaisesRegex(audio.AudioInputError, "超え"):
            audio.validate_interval(0, 90, 89.9)

    def test_youtube_url_is_one_canonical_video(self):
        for url in ["https://youtu.be/ABCDEFGHIJK?t=20", "https://www.youtube.com/watch?v=ABCDEFGHIJK&list=RD123",
                    "https://m.youtube.com/shorts/ABCDEFGHIJK", "https://www.youtube.com/embed/ABCDEFGHIJK"]:
            self.assertEqual(audio.canonical_youtube_url(url), "https://www.youtube.com/watch?v=ABCDEFGHIJK")

    def test_non_youtube_playlists_credentials_and_malformed_ports_are_refused(self):
        for url in ["https://example.com/a.mp3", "https://www.youtube.com/playlist?list=123", 
                    "https://youtube.com.evil.test/watch?v=ABCDEFGHIJK", "file:///etc/passwd",
                    "https://user:pass@youtube.com/watch?v=ABCDEFGHIJK", "https://youtube.com:wrong/watch?v=ABCDEFGHIJK",
                    "https://youtu.be/short", "https://youtu.be/ABCDEFGHIJK/extra"]:
            with self.subTest(url=url), self.assertRaises(audio.AudioInputError):
                audio.canonical_youtube_url(url)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpegが必要です")
class FileAudioTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name)
        self.source = self.folder / "source audio ; no shell.wav"
        self.sr = 16000
        # 途中で周波数が変わり、切り出しの時刻を確認できる音です。
        t = np.arange(24 * self.sr) / self.sr
        self.wave = .2 * np.sin(2 * np.pi * np.where(t < 8, 220, 440) * t)
        sf.write(self.source, np.column_stack([self.wave, -self.wave]), self.sr, subtype="FLOAT")

    def tearDown(self):
        self.tmp.cleanup()

    def test_actual_ffmpeg_trim_has_selected_length_and_stereo_does_not_cancel(self):
        clip = audio.extract_clip(self.source, self.folder / "clip.wav", 8.25, 20.75)
        samples, sr = audio.load_audio(clip)
        self.assertEqual(sr, 44100)
        self.assertEqual(samples.shape, (551250, 2))
        self.assertAlmostEqual(audio.probe_duration(clip), 12.5, places=4)
        self.assertGreater(np.sqrt(np.mean(samples ** 2)), .1)
        self.assertLess(np.max(np.abs(samples.mean(axis=1))), 1e-6)
        frequency = np.fft.rfftfreq(sr, 1 / sr)[np.argmax(abs(np.fft.rfft(samples[:sr, 0])))]
        self.assertAlmostEqual(frequency, 440, delta=1)

    def test_input_and_existing_destinations_are_not_overwritten(self):
        digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        with self.assertRaises(audio.AudioInputError):
            audio.extract_clip(self.source, self.source, 0, 10)
        existing = self.folder / "existing.wav"
        existing.write_bytes(b"keep")
        with self.assertRaises(audio.AudioInputError):
            audio.extract_clip(self.source, existing, 0, 10)
        self.assertEqual(existing.read_bytes(), b"keep")
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), digest)

    def test_truncated_and_corrupt_inputs_fail_clearly(self):
        with self.assertRaisesRegex(audio.AudioInputError, "最後まで"):
            audio.extract_clip(self.source, self.folder / "too-long.wav", 20, 40)
        bad = self.folder / "bad.mp3"
        bad.write_bytes(b"this is not audio")
        with self.assertRaisesRegex(audio.AudioInputError, "失敗"):
            audio.probe_duration(bad)

    def _analyse(self, samples, sr, config=None):
        self.assertEqual(sr, 44100)
        self.assertEqual(samples.shape[1], 2)
        return {"schema_version": "vocal-fluctuation-result-v1", "status": "inconclusive", "summary": "test",
                "duration_seconds": len(samples) / sr}

    def test_already_vocals_pipeline_writes_reproducible_metadata_and_unique_runs(self):
        fake = types.ModuleType("vocal_lab.analysis")
        fake.analyse_samples = self._analyse
        source_hash = hashlib.sha256(self.source.read_bytes()).hexdigest()
        with patch.dict(sys.modules, {"vocal_lab.analysis": fake}), patch("vocal_lab.pipeline.separate_vocals") as separator:
            first = run_analysis(self.source, 8, 20, self.folder / "outputs", already_vocals=True)
            second = run_analysis(self.source, 8, 20, self.folder / "outputs", already_vocals=True)
        separator.assert_not_called()
        self.assertNotEqual(first["result_path"], second["result_path"])
        self.assertEqual(first["metadata"]["source_sha256"], second["metadata"]["source_sha256"])
        self.assertEqual(first["metadata"]["source_hash_scope"], "selected-clip")
        self.assertEqual(first["metadata"]["separation_method"], "already-vocals")
        self.assertEqual(first["metadata"]["model_version"], "")
        self.assertEqual(first["analysis"]["metadata"], first["metadata"])
        saved = json.loads(Path(first["result_path"]).read_text())
        self.assertEqual(saved, first["analysis"])
        self.assertNotIn(str(self.folder), json.dumps(saved))
        self.assertAlmostEqual(saved["duration_seconds"], 12, places=3)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), source_hash)

    def test_demucs_receives_padded_context_but_analysis_and_playback_use_exact_interval(self):
        fake = types.ModuleType("vocal_lab.analysis")
        fake.analyse_samples = self._analyse
        def separate(context, out, device="auto", progress=None):
            self.assertAlmostEqual(audio.probe_duration(context), 16, places=3)
            return Path(context), "4.1.0"
        with patch.dict(sys.modules, {"vocal_lab.analysis": fake}), patch("vocal_lab.pipeline.separate_vocals", side_effect=separate):
            result = run_analysis(self.source, 8, 20, self.folder / "outputs")
        self.assertEqual(result["metadata"]["separation_method"], "demucs:htdemucs")
        self.assertEqual(result["metadata"]["model_version"], "4.1.0")
        self.assertAlmostEqual(audio.probe_duration(result["vocals_path"]), 12, places=3)

    def test_demucs_cli_uses_float_output_no_random_shifts_and_reports_tool_errors(self):
        out = self.folder / "separated"
        expected = out / "htdemucs" / self.source.stem / "vocals.wav"
        def complete(command, purpose, timeout):
            self.assertIn("demucs.separate", command)
            self.assertIn("--float32", command)
            self.assertIn("none", command)
            self.assertEqual(command[command.index("--shifts") + 1], "0")
            self.assertEqual(command[command.index("-d") + 1], "cpu")
            expected.parent.mkdir(parents=True)
            shutil.copyfile(self.source, expected)
            return ""
        with patch("vocal_lab.audio.importlib.metadata.version", return_value="4.1.0"), patch("vocal_lab.audio._run", side_effect=complete):
            path, version = audio.separate_vocals(self.source, out, device="cpu")
        self.assertEqual(path, expected)
        self.assertEqual(version, "4.1.0")
        with patch("vocal_lab.audio.subprocess.run", return_value=subprocess.CompletedProcess([], 1, "real decoder error")):
            with self.assertRaisesRegex(audio.AudioInputError, "real decoder error"):
                audio._run(["ffmpeg"], "デコード")


class YouTubeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name)
        self.options = []
        self.info = {"id": "ABCDEFGHIJK", "duration": 200, "is_live": False}

    def tearDown(self):
        self.tmp.cleanup()

    def _fake_ydl(self, options):
        test = self
        test.options.append(options)
        class Download:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def extract_info(self, url, download):
                test.assertEqual(url, "https://www.youtube.com/watch?v=ABCDEFGHIJK")
                if not download: return test.info.copy()
                path = test.folder / "download.webm"
                path.write_bytes(b"downloaded section")
                return {"requested_downloads": [{"filepath": str(path)}]}
        return Download()

    def test_download_requests_only_bounded_context_not_entire_song(self):
        with patch("yt_dlp.YoutubeDL", side_effect=self._fake_ydl), patch("vocal_lab.audio.require_tool", return_value="ffmpeg"):
            result = audio.download_youtube_section("https://youtu.be/ABCDEFGHIJK?list=abc", 40, 130, self.folder)
        self.assertEqual(result["context_start_seconds"], 38)
        self.assertEqual(result["context_end_seconds"], 132)
        self.assertEqual(list(self.options[1]["download_ranges"]({}, None)), [{"start_time": 38, "end_time": 132}])
        self.assertTrue(self.options[1]["noplaylist"])
        self.assertNotIn("cookiefile", self.options[1])
        self.assertNotIn("proxy", self.options[1])

    def test_live_and_missing_duration_are_refused_before_download(self):
        for changes in [{"is_live": True}, {"duration": None}, {"duration": float("inf")}, {"duration": 30}]:
            self.options.clear()
            self.info = {"duration": 200, "is_live": False, **changes}
            with patch("yt_dlp.YoutubeDL", side_effect=self._fake_ydl), patch("vocal_lab.audio.require_tool", return_value="ffmpeg"):
                with self.assertRaises(audio.AudioInputError):
                    audio.download_youtube_section("https://youtu.be/ABCDEFGHIJK", 40, 130, self.folder)
            self.assertEqual(len(self.options), 1)

    def test_remote_failure_recommends_upload_instead_of_bypassing(self):
        with patch("yt_dlp.YoutubeDL", side_effect=RuntimeError("HTTP 403")), patch("vocal_lab.audio.require_tool", return_value="ffmpeg"):
            with self.assertRaisesRegex(audio.AudioInputError, "アップロード"):
                audio.download_youtube_section("https://youtu.be/ABCDEFGHIJK", 0, 90, self.folder)


if __name__ == "__main__":
    unittest.main()
