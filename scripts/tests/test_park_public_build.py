import ast
from base64 import b64encode
from hashlib import sha256
import importlib.util
import json
import re
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
                    'pwa.js', 'manifest.webmanifest', 'sw.js', 'assets/pwa/splash.webp',
                    'forecast-calendar.js', 'calendar-outlook.js',
                    'onsite-navigation.js', 'visit-day-view.js', 'wishlist-presets.js', 'itinerary-image.js', 'ticket-calendar.js', 'ticket-calendar-seed.js',
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
            config_path = project / 'web/firebase-config.json'
            config_path.write_text('{"type":"service_account","private_key":"fixture"}')
            with self.assertRaisesRegex(ValueError, 'web app configuration'):
                builder.build_park_site(root / 'output')
            self.assertFalse((root / 'output/park-itinerary-lab/firebase-config.json').exists())
            config_path.write_text('{}')
            (project / 'web/sw.js').write_text("const BUILD_ID = 'source';\nconst INTEGRITY = {};\n")
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
                if name == 'sw.js':
                    self.assertRegex((public / name).read_text(), r"const BUILD_ID = '[a-f0-9]{64}';")
                else:
                    self.assertEqual((public / name).read_bytes(), (project / 'web' / name).read_bytes())
            worker_source = (public / 'sw.js').read_text()
            hashes = json.loads(re.search(r'^const INTEGRITY = (.*);$', worker_source, re.M).group(1))
            self.assertEqual(set(hashes), set(builder.PARK_WEB_FILES) - {'sw.js'})
            for name, integrity in hashes.items():
                digest = sha256((public / name).read_bytes()).digest()
                self.assertEqual(integrity, 'sha256-' + b64encode(digest).decode('ascii'))
            self.assertFalse((public / 'student-original.ipynb').exists())
            self.assertEqual(archive.name, 'TDRoute_v1.0.0.zip')
            with ZipFile(archive) as bundle:
                expected = {f'v1.0.0/web/{name}' for name in builder.PARK_WEB_FILES}
                expected.update({'v1.0.0/README.md', 'v1.0.0/version.json', 'v1.0.0/DISTRIBUTION_FILES.json'})
                self.assertEqual(set(bundle.namelist()), expected)
                for name in builder.PARK_WEB_FILES:
                    self.assertEqual(bundle.read(f'v1.0.0/web/{name}'), (public / name).read_bytes())
                bundle.extractall(root / 'unpacked')
            local = root / 'unpacked/v1.0.0'
            (local / 'web/data/private-plan.json').write_text('{"name":"private"}')
            local_zip = builder.park_packaging['build_archive'](local)
            with ZipFile(local_zip) as bundle:
                self.assertEqual(set(bundle.namelist()), expected)
                self.assertEqual(bundle.read('v1.0.0/web/sw.js'), (public / 'sw.js').read_bytes())
            worker = (public / 'sw.js').read_bytes()
            (project / 'web/style.css').write_text('new style')
            builder.build_park_site(root / 'output')
            self.assertNotEqual(worker, (public / 'sw.js').read_bytes())

    def test_precache_and_installer_files_are_published(self):
        repository = Path(__file__).resolve().parents[2]
        spec = importlib.util.spec_from_file_location('park_site_builder', repository / 'scripts/build_public_site.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        web = repository / 'projects/park-itinerary-lab/web'
        worker = (web / 'sw.js').read_text(encoding='utf-8')
        offline = ast.literal_eval(re.search(r'const OFFLINE_FILES = (\[.*?\]);', worker, re.S).group(1))
        manifest = json.loads((web / 'manifest.webmanifest').read_text(encoding='utf-8'))
        icons = [icon['src'].removeprefix('./') for icon in manifest['icons']]
        html = (web / 'index.html').read_text(encoding='utf-8')
        startup_images = re.findall(r'href=["\'](?:\./)?(assets/pwa/startup-[^"\']+)["\']', html)
        self.assertTrue(startup_images)
        for path in set(offline + icons + startup_images):
            self.assertIn(path, builder.PARK_WEB_FILES)
            self.assertTrue((web / path).is_file(), path)

    def test_gallery_order_places_park_after_motion(self):
        repository = Path(__file__).resolve().parents[2]
        text = (repository / 'web/index.html').read_text(encoding='utf-8')
        projects = re.findall(r'<article[^>]+aria-labelledby="([^"]+)"', text)
        self.assertEqual(projects[3:5], ['swing-title', 'park-title'])
        self.assertEqual(len(projects), 8)


if __name__ == '__main__':
    unittest.main()
