import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from zipfile import ZipFile


class SwingPublicBuildTests(unittest.TestCase):
    def test_selected_web_assets_and_tracked_distribution(self):
        repository = Path(__file__).resolve().parents[2]
        spec = importlib.util.spec_from_file_location('swing_site_builder', repository / 'scripts/build_public_site.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            builder.ROOT = root
            project = root / 'projects/swing-motion-lab'
            (project / 'web').mkdir(parents=True)
            (project / 'version.json').write_text('{"version":"1.0.0"}')
            for name in builder.SWING_WEB_FILES:
                (project / 'web' / name).write_text('public asset')
            (project / 'README.md').write_text('manual')
            subprocess.run(['git', 'init', '-q'], cwd=root, check=True)
            subprocess.run(['git', 'add', '.'], cwd=root, check=True)
            (project / 'web/input-video.mp4').write_bytes(b'local video')
            (project / 'uploads').mkdir()
            (project / 'uploads/pose.json').write_text('{}')
            archive = builder.build_swing_site(root / 'output')
            public = root / 'output/swing-motion-lab'
            self.assertFalse((public / 'input-video.mp4').exists())
            self.assertFalse((public / 'uploads').exists())
            self.assertTrue((public / 'app.js').is_file())
            self.assertEqual(archive.name, 'MotionAnalysisLab_v1.0.0.zip')
            with ZipFile(archive) as bundle:
                self.assertTrue(all(name.startswith('v1.0.0/') for name in bundle.namelist()))
                self.assertIn('v1.0.0/README.md', bundle.namelist())
                self.assertNotIn('v1.0.0/web/input-video.mp4', bundle.namelist())
                self.assertNotIn('v1.0.0/uploads/pose.json', bundle.namelist())


if __name__ == '__main__':
    unittest.main()
