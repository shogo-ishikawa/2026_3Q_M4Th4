"""AACをMP4拡張子で保存した購入音源も、入力して区間を読み込めます。"""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vocal_lab.audio import extract_clip, probe_duration
from vocal_lab.notebook_ui import save_audio_upload, validate_audio_path


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpegが必要です")
class PurchasedAudioTests(unittest.TestCase):
    def test_aac_in_mp4_is_accepted_and_decoded_without_changing_the_source(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            source = directory / "sample.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
                            "-c:a", "aac", "-b:a", "128k", str(source)], check=True)
            content = source.read_bytes()
            self.assertEqual(validate_audio_path(source), source)
            saved = save_audio_upload(({"name": "sample.mp4", "content": content},), directory / "upload")
            self.assertEqual(saved.suffix, ".mp4")
            clip = extract_clip(saved, directory / "clip.wav", 0, 10)
            self.assertAlmostEqual(probe_duration(clip), 10, places=2)
            self.assertEqual(source.read_bytes(), content)


if __name__ == "__main__":
    unittest.main()
