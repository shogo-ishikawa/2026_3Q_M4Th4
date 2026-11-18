import importlib.util
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from zipfile import ZipFile


class AsterionPublicBuildTests(unittest.TestCase):
    def test_public_allowlist_and_tracked_versioned_archive(self):
        repository = Path(__file__).resolve().parents[2]
        spec = importlib.util.spec_from_file_location('asterion_site_builder', repository / 'scripts/build_public_site.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            builder.ROOT = root
            project = root / 'projects/asterion-story'
            for name in builder.ASTERION_PUBLIC_FILES:
                path = project / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'\x00\xff image fixture' if name.endswith('.webp') else f'public: {name}'.encode())
            (project / 'version.json').write_text('{"version":"2.3.4"}', encoding='utf-8')
            (project / 'README.md').write_text('遊び方とコードの案内', encoding='utf-8')
            (project / 'tests').mkdir()
            (project / 'tests/check.mjs').write_text('/* distributable test */', encoding='utf-8')
            subprocess.run(['git', 'init', '-q'], cwd=root, check=True)
            subprocess.run(['git', 'add', '.'], cwd=root, check=True)
            (project / 'submitted.html').write_text('not selected for publication', encoding='utf-8')
            (project / 'outputs').mkdir()
            (project / 'outputs/save.json').write_text('{"private":"progress"}', encoding='utf-8')
            archive = builder.build_asterion_site(root / 'output')
            public = root / 'output/asterion-story'
            expected_public = set(builder.ASTERION_PUBLIC_FILES) | {'downloads/Asterion_v2.3.4.zip'}
            self.assertEqual({str(path.relative_to(public)) for path in public.rglob('*') if path.is_file()}, expected_public)
            for name in builder.ASTERION_PUBLIC_FILES:
                self.assertEqual((public / name).read_bytes(), (project / name).read_bytes())
            expected_source = set(builder.ASTERION_PUBLIC_FILES) | {'version.json', 'README.md', 'tests/check.mjs'}
            self.assertEqual(archive.name, 'Asterion_v2.3.4.zip')
            with ZipFile(archive) as bundle:
                self.assertEqual(set(bundle.namelist()), {'v2.3.4/' + name for name in expected_source})
                for name in expected_source:
                    self.assertEqual(bundle.read('v2.3.4/' + name), (project / name).read_bytes())

    def test_gallery_counts_and_existing_order_match_nine_projects(self):
        repository = Path(__file__).resolve().parents[2]
        text = (repository / 'web/index.html').read_text(encoding='utf-8')
        projects = re.findall(r'<article[^>]+data-category="([^"]+)"[^>]+aria-labelledby="([^"]+)"', text)
        self.assertEqual([heading for _, heading in projects], [
            'world-title', 'vocal-title', 'wind-title', 'swing-title', 'park-title',
            'pipe-title', 'lantern-title', 'illusion-title', 'asterion-title',
        ])
        self.assertIn('9作品を表示', text)
        self.assertIn('9つの実験室。', text)
        for category in ['all', 'game', 'sound', 'science', 'travel', 'sport']:
            match = re.search(r'data-filter="' + category + r'"[^>]*>.*?<span class="filter-count"[^>]*>(\d+)</span>', text)
            expected = len(projects) if category == 'all' else sum(kind == category for kind, _ in projects)
            self.assertIsNotNone(match, category)
            self.assertEqual(int(match.group(1)), expected, category)
        self.assertEqual(re.findall(r'class="visual-no">(\d{2}) / (\d{2})', text), [(f'{index:02d}', '09') for index in range(1, 10)])
        for path in ['asterion-story/', 'asterion-story/guide.html', 'asterion-story/downloads/Asterion_v1.0.0.zip']:
            self.assertIn('href="' + path + '"', text)


if __name__ == '__main__':
    unittest.main()
