import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from zipfile import ZipFile


class ParkPublicBuildTests(unittest.TestCase):
    def test_selected_web_assets_and_tracked_distribution(self):
        repository = Path(__file__).resolve().parents[2]
        spec = importlib.util.spec_from_file_location('park_site_builder', repository / 'scripts/build_public_site.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        required = {'accuracy.html', 'accuracy.css', 'accuracy-page.js', 'forecast-accuracy.js',
                    'repeat-visits.js', 'intraday-waits.js', 'day-progress-ui.js', 'day-progress-plan.js'}
        self.assertTrue(required.issubset(builder.PARK_WEB_FILES))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            builder.ROOT = root
            project = root / 'projects/park-itinerary-lab'
            for name in builder.PARK_WEB_FILES:
                path = project / 'web' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(f'public asset: {name}', encoding='utf-8')
            (project / 'version.json').write_text('{"version":"1.0.0"}')
            (project / 'README.md').write_text('パークの計画', encoding='utf-8')
            subprocess.run(['git', 'init', '-q'], cwd=root, check=True)
            subprocess.run(['git', 'add', '.'], cwd=root, check=True)
            (project / 'student-original.ipynb').write_text('{}')
            (project / 'outputs').mkdir()
            (project / 'outputs/plan.json').write_text('{}')
            archive = builder.build_park_site(root / 'output')
            public = root / 'output/park-itinerary-lab'
            for name in builder.PARK_WEB_FILES:
                self.assertEqual((public / name).read_bytes(), (project / 'web' / name).read_bytes())
            self.assertFalse((public / 'student-original.ipynb').exists())
            self.assertEqual(archive.name, 'TDRoute_v1.0.0.zip')
            with ZipFile(archive) as bundle:
                expected = {f'v1.0.0/web/{name}' for name in builder.PARK_WEB_FILES}
                expected.update({'v1.0.0/README.md', 'v1.0.0/version.json'})
                self.assertEqual(set(bundle.namelist()), expected)
                self.assertEqual(bundle.read('v1.0.0/web/data/parks.json'), (public / 'data/parks.json').read_bytes())

    def test_gallery_order_places_park_after_motion(self):
        repository = Path(__file__).resolve().parents[2]
        text = (repository / 'web/index.html').read_text(encoding='utf-8')
        import re
        projects = re.findall(r'<article[^>]+aria-labelledby="([^"]+)"', text)
        self.assertEqual(projects[3:5], ['swing-title', 'park-title'])
        self.assertEqual(len(projects), 8)


if __name__ == '__main__':
    unittest.main()
