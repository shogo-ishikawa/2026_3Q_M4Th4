"""実音声の切り出し・無音処理・解析・比較DBをつないで確認します。"""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vocal_lab.analysis import analyse_samples
from vocal_lab.audio import AudioInputError, load_audio, probe_duration
from vocal_lab.examples import make_envelope
from vocal_lab.pipeline import run_analysis
from vocal_lab.reference_db import add_reference, compare_reference, empty_database
from vocal_lab.silence import SilenceConfig


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpegが必要です")
class PreprocessingIntegrationTests(unittest.TestCase):
    """合成した歌声風の音を使い、第三者の楽曲やモデルには接続しません。"""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.folder = Path(self.temporary.name)
        self.sr = 8000

    def tearDown(self):
        self.temporary.cleanup()

    def _source(self, name, voice_seconds=120, leading=6, trailing=8, frequency=440,
                internal_gap=False):
        count = round(voice_seconds * self.sr)
        time = np.arange(count) / self.sr
        envelope = np.interp(time, np.arange(round(voice_seconds * 100)) / 100,
                             make_envelope("pink", voice_seconds, seed=22))
        voice = .08 * envelope * np.sin(2 * np.pi * frequency * time)
        if internal_gap:
            voice[round(40 * self.sr):round(42 * self.sr)] = 0
        mono = np.concatenate((np.zeros(round(leading * self.sr)), voice,
                               np.zeros(round(trailing * self.sr))))
        path = self.folder / name
        # 単純な左右平均では消える逆位相ステレオです。
        sf.write(path, np.column_stack((mono, -mono)), self.sr, subtype="FLOAT")
        return path

    def test_whole_audio_keeps_input_and_raw_extraction_but_trims_only_selected_vocals(self):
        source = self._source("whole.wav", internal_gap=True)
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        bundle = run_analysis(source, 0, None, self.folder / "runs", already_vocals=True)
        analysis = bundle["analysis"]
        report = analysis["metadata"]["preprocessing"]
        self.assertAlmostEqual(probe_duration(bundle["clip_path"]), 134, places=3)
        self.assertAlmostEqual(probe_duration(bundle["extracted_vocals_path"]), 134, places=3)
        self.assertGreater(probe_duration(bundle["vocals_path"]), 120)
        self.assertLess(probe_duration(bundle["vocals_path"]), 120.3)
        self.assertAlmostEqual(report["input_duration_seconds"], 134, places=3)
        self.assertAlmostEqual(report["output_duration_seconds"], analysis["duration_seconds"], places=3)
        self.assertFalse(report["timeline_modified"])
        self.assertEqual(report["internal_removed_seconds"], 0)
        self.assertEqual(len(report["kept_segments_seconds"]), 1)
        begin, end = report["kept_segments_seconds"][0]
        self.assertAlmostEqual(begin, 6, delta=.15)
        self.assertAlmostEqual(end, 126, delta=.15)
        samples, _ = load_audio(bundle["vocals_path"])
        self.assertGreater(np.sqrt(np.mean(samples ** 2)), .05)
        self.assertLess(np.max(abs(samples.mean(axis=1))), 1e-6)
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), digest)
        self.assertEqual(json.loads(Path(bundle["result_path"]).read_text()), analysis)

    def test_internal_cut_reports_both_original_spans_and_changes_only_analysis_timeline(self):
        source = self._source("pause.wav", internal_gap=True)
        bundle = run_analysis(source, 0, None, self.folder / "runs", already_vocals=True,
                              silence_config=SilenceConfig(remove_internal=True))
        report = bundle["analysis"]["metadata"]["preprocessing"]
        segments = report["kept_segments_seconds"]
        self.assertTrue(report["timeline_modified"])
        self.assertEqual(len(segments), 2)
        self.assertGreater(report["internal_removed_seconds"], 1.5)
        self.assertLess(report["internal_removed_seconds"], 2.1)
        self.assertAlmostEqual(segments[0][1], 46, delta=.15)
        self.assertAlmostEqual(segments[1][0], 48, delta=.15)
        self.assertAlmostEqual(sum(end - begin for begin, end in segments),
                               report["output_duration_seconds"], places=3)
        self.assertAlmostEqual(probe_duration(bundle["extracted_vocals_path"]), 134, places=3)
        self.assertAlmostEqual(probe_duration(bundle["vocals_path"]),
                               report["output_duration_seconds"], places=3)

    def test_short_remaining_audio_is_not_promoted_by_the_long_original_duration(self):
        source = self._source("short-vocal.wav", voice_seconds=50, leading=20, trailing=20)
        bundle = run_analysis(source, 0, None, self.folder / "runs", already_vocals=True)
        analysis = bundle["analysis"]
        self.assertEqual(analysis["metadata"]["end_seconds"], 90)
        self.assertLess(analysis["duration_seconds"], 51)
        self.assertEqual(analysis["status"], "inconclusive")
        self.assertFalse(analysis["quality"]["usable_for_comparison"])
        self.assertTrue(any("60" in reason for reason in analysis["quality"]["reasons"]))

    def test_policy_signature_allows_different_trim_spans_but_excludes_old_and_raw_database_rows(self):
        first_source = self._source("first.wav", leading=6, trailing=8)
        second_source = self._source("second.wav", leading=3, trailing=11, frequency=660)
        first = run_analysis(first_source, 0, None, self.folder / "runs", already_vocals=True)["analysis"]
        second_bundle = run_analysis(second_source, 0, None, self.folder / "runs", already_vocals=True)
        second = second_bundle["analysis"]
        self.assertTrue(first["quality"]["usable_for_comparison"])
        self.assertTrue(second["quality"]["usable_for_comparison"])
        self.assertNotEqual(first["metadata"]["preprocessing"]["kept_segments_seconds"],
                            second["metadata"]["preprocessing"]["kept_segments_seconds"])
        self.assertEqual(first["analysis_signature"], second["analysis_signature"])
        database = add_reference(empty_database(), first, "確認用の合成音", "別の入力波形")
        self.assertEqual(len(compare_reference(second, database)), 1)
        self.assertEqual(compare_reference(first, database), [])

        raw = run_analysis(second_source, 0, None, self.folder / "runs", already_vocals=True,
                           silence_config=SilenceConfig(trim_edges=False))["analysis"]
        self.assertNotEqual(raw["analysis_signature"], second["analysis_signature"])
        self.assertEqual(raw["metadata"]["source_sha256"], second["metadata"]["source_sha256"])

        changed = run_analysis(second_source, 0, None, self.folder / "runs", already_vocals=True,
                               silence_config=SilenceConfig(threshold_db=-35))["analysis"]
        self.assertTrue(changed["quality"]["usable_for_comparison"])
        self.assertNotEqual(changed["analysis_signature"], second["analysis_signature"])
        self.assertEqual(compare_reference(changed, database), [])

        samples, sr = load_audio(second_bundle["vocals_path"])
        legacy = analyse_samples(samples, sr)
        legacy["metadata"] = dict(second["metadata"], source_sha256="a" * 64)
        old_database = add_reference(empty_database(), legacy, "旧条件の合成音", "無音処理の記録なし")
        self.assertNotEqual(legacy["analysis_signature"], second["analysis_signature"])
        self.assertEqual(compare_reference(second, old_database), [])

    def test_whole_track_limit_is_checked_before_decoding_or_separating_audio(self):
        source = self.folder / "long.wav"
        source.write_bytes(b"placeholder")
        with patch("vocal_lab.pipeline.probe_duration", return_value=601), \
             patch("vocal_lab.pipeline.extract_clip") as extract, \
             patch("vocal_lab.pipeline.separate_vocals") as separate:
            with self.assertRaises(AudioInputError):
                run_analysis(source, 0, None, self.folder / "runs", already_vocals=True)
        extract.assert_not_called()
        separate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
