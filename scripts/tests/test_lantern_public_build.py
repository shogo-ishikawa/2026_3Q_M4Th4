import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from zipfile import ZipFile


class LanternPublicBuildTests(unittest.TestCase):
    def test_shared_game_and_selected_public_files(self):
        repository = Path(__file__).resolve().parents[2]
        spec = importlib.util.spec_from_file_location('lantern_site_builder', repository / 'scripts/build_public_site.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            builder.ROOT = root
            project = root / 'projects/lantern-post'
            project.mkdir(parents=True)
            game = '<!doctype html><title>灯りの配達人</title><canvas></canvas>'
            (project / 'Lantern_Post.html').write_text(game, encoding='utf-8')
            (project / 'guide.html').write_text('<a href="Lantern_Post.html">ゲームへ戻る</a>', encoding='utf-8')
            (project / 'version.json').write_text('{"version":"3.0.0"}')
            (project / 'README.md').write_text('遊び方', encoding='utf-8')
            subprocess.run(['git', 'init', '-q'], cwd=root, check=True)
            subprocess.run(['git', 'add', '.'], cwd=root, check=True)
            (project / 'private-input.json').write_text('{"private":true}')
            (project / 'uploads').mkdir()
            (project / 'uploads/save.json').write_text('{}')
            archive = builder.build_lantern_site(root / 'output')
            public = root / 'output/lantern-post'
            self.assertEqual((public / 'index.html').read_text(encoding='utf-8'), game)
            self.assertEqual((public / 'Lantern_Post.html').read_bytes(), (public / 'index.html').read_bytes())
            self.assertEqual((public / 'guide.html').read_bytes(), (project / 'guide.html').read_bytes())
            self.assertEqual({path.name for path in public.iterdir()}, {'index.html', 'Lantern_Post.html', 'guide.html', 'downloads'})
            self.assertEqual(archive.name, 'LanternPost_v3.0.0.zip')
            with ZipFile(archive) as bundle:
                self.assertEqual(set(bundle.namelist()), {
                    'v3.0.0/Lantern_Post.html', 'v3.0.0/guide.html',
                    'v3.0.0/README.md', 'v3.0.0/version.json',
                })
                self.assertEqual(bundle.read('v3.0.0/Lantern_Post.html'), (public / 'index.html').read_bytes())


if __name__ == '__main__':
    unittest.main()
