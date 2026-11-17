import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from zipfile import ZipFile


class IllusionPublicBuildTests(unittest.TestCase):
    def test_selected_assets_and_tracked_distribution(self):
        repository = Path(__file__).resolve().parents[2]
        spec = importlib.util.spec_from_file_location('illusion_site_builder', repository / 'scripts/build_public_site.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            builder.ROOT = root
            project = root / 'projects/illusion-lab'
            web = project / 'web'
            web.mkdir(parents=True)
            for name in builder.ILLUSION_WEB_FILES:
                (web / name).write_text(f'public asset: {name}', encoding='utf-8')
            (project / 'version.json').write_text('{"version":"1.0.0"}')
            (project / 'README.md').write_text('錯視の実験室の使い方', encoding='utf-8')
            subprocess.run(['git', 'init', '-q'], cwd=root, check=True)
            subprocess.run(['git', 'add', '.'], cwd=root, check=True)
            (web / 'private-image.png').write_bytes(b'input image')
            (project / 'student-original.ipynb').write_text('{}')
            (project / 'outputs').mkdir()
            (project / 'outputs/results.json').write_text('{}')

            archive = builder.build_illusion_site(root / 'output')
            public = root / 'output/illusion-lab'
            self.assertEqual({path.name for path in public.iterdir()}, {*builder.ILLUSION_WEB_FILES, 'downloads'})
            for name in builder.ILLUSION_WEB_FILES:
                self.assertEqual((public / name).read_bytes(), (web / name).read_bytes())
            self.assertEqual(archive.name, 'IllusionLab_v1.0.0.zip')
            with ZipFile(archive) as bundle:
                expected = {f'v1.0.0/web/{name}' for name in builder.ILLUSION_WEB_FILES}
                expected.update({'v1.0.0/README.md', 'v1.0.0/version.json'})
                self.assertEqual(set(bundle.namelist()), expected)
                self.assertEqual(bundle.read('v1.0.0/web/index.html'), (public / 'index.html').read_bytes())


if __name__ == '__main__':
    unittest.main()
