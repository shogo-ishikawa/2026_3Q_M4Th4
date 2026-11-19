"""Package the public TDRoute app and its portable source distribution."""
from base64 import b64encode
from hashlib import sha256
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json
import subprocess
import tempfile

PROJECT = Path(__file__).resolve().parents[1]
INVENTORY = 'DISTRIBUTION_FILES.json'

PARK_WEB_FILES = ('index.html', 'pwa.js', 'sw.js', 'manifest.webmanifest', 'style.css', 'app.js', 'planner.js', 'planner-worker.js',
                  'accuracy.html', 'accuracy.css', 'accuracy-page.js', 'forecast-accuracy.js',
                  'sync-ui.js', 'named-sync.js', 'firebase-sync.js', 'firebase-config.json', 'drive-memories.js',
                  'companion-plans.js', 'companion-view.js', 'joint-planning.js',
                  'assets/firebase/firebase-app.js', 'assets/firebase/firebase-auth.js',
                  'assets/firebase/firebase-firestore.js', 'assets/firebase/LICENSE.txt', 'assets/firebase/SOURCES.md',
                  'forecast-calendar.js', 'calendar-outlook.js',
                  'onsite-navigation.js', 'visit-day-view.js', 'wishlist-presets.js', 'itinerary-image.js', 'ticket-calendar.js', 'ticket-calendar-seed.js',
                  'day-progress-ui.js', 'day-progress-plan.js', 'repeat-visits.js', 'intraday-waits.js',
                  'map-view.js', 'map-display.js', 'map-gestures.js', 'storage.js', 'weather.js', 'weather-view.js', 'time-input.js', 'operation-windows.js', 'guide.html', 'data/parks.json',
                  'wait-data.js', 'wait-model.js', 'calendar-features.js', 'data/calendar.json', 'data/live-waits.json', 'data/wait-model.json',
                  'assets/land-geographic-map.webp', 'assets/sea-geographic-map.webp',
                  'assets/tdroute-logo.webp', 'assets/land-map.webp', 'assets/sea-map.webp', 'assets/land-hero.webp', 'assets/sea-hero.webp',
                  'data/sea-geography.json', 'data/sea-geography-LICENCE.md', 'assets/sea-geographic-map.svg',
                  'data/map-landmarks.json', 'data/land-map-scenery.json', 'data/sea-map-scenery.json',
                  'contingency.js', 'data/land-geography.json', 'data/land-geography-LICENCE.md', 'assets/land-geographic-map.svg',
                  'assets/pwa/icon-192.png', 'assets/pwa/icon-512.png', 'assets/pwa/icon-maskable-512.png',
                  'assets/pwa/apple-touch-icon.png',
                  'assets/pwa/startup-750x1334.jpg', 'assets/pwa/startup-1125x2436.jpg', 'assets/pwa/startup-828x1792.jpg',
                  'assets/pwa/startup-1170x2532.jpg', 'assets/pwa/startup-1179x2556.jpg', 'assets/pwa/startup-1206x2622.jpg',
                  'assets/pwa/startup-1284x2778.jpg', 'assets/pwa/startup-1290x2796.jpg', 'assets/pwa/startup-1320x2868.jpg')


def check_public_firebase_config(web):
    config = json.loads((web / 'firebase-config.json').read_text(encoding='utf-8'))
    if config == {}:
        return  # A release candidate can be tested before its dedicated project exists.
    required = {'apiKey', 'authDomain', 'projectId', 'appId'}
    optional = {'messagingSenderId', 'storageBucket', 'databaseURL', 'measurementId'}
    if (not isinstance(config, dict) or not required.issubset(config)
            or set(config) - required - optional
            or any(not isinstance(value, str) or not value.strip() or len(value) > 255
                   or 'PRIVATE KEY' in value for value in config.values())):
        raise ValueError('firebase-config.json must contain only the Firebase web app configuration')


def public_worker(web):
    """Give a new deployment its own offline cache whenever a published file changes."""
    digest = sha256()
    integrity = {}
    for name in sorted(PARK_WEB_FILES):
        file_hash = sha256((web / name).read_bytes()).digest()
        digest.update(name.encode('utf-8') + b'\0')
        digest.update(file_hash)
        if name != 'sw.js':
            integrity[name] = 'sha256-' + b64encode(file_hash).decode('ascii')
    source = (web / 'sw.js').read_text(encoding='utf-8')
    marker = "const BUILD_ID = 'source';"
    integrity_marker = "const INTEGRITY = {};"
    if source.count(marker) != 1 or source.count(integrity_marker) != 1:
        raise ValueError("sw.js: expected one build ID and one integrity marker")
    source = source.replace(marker, f"const BUILD_ID = '{digest.hexdigest()}';")
    return source.replace(integrity_marker, f'const INTEGRITY = {json.dumps(integrity)};').encode('utf-8')


def source_files(root):
    try:
        result = subprocess.run(['git', 'ls-files', '-z', '--', '.'], cwd=root, capture_output=True, check=True)
        tracked = result.stdout.decode('utf-8').split('\0')
        if 'version.json' in tracked:
            return sorted(name for name in tracked if name and (root / name).is_file())
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass
    inventory = root / INVENTORY
    if inventory.is_file():
        return json.loads(inventory.read_text(encoding='utf-8'))
    # A copy made without Git or the release inventory can still distribute the public app.
    return ['README.md', 'version.json', 'run.py', 'scripts/package-web.py', *('web/' + name for name in PARK_WEB_FILES)]


def build_archive(root=PROJECT, destination=None, worker=None):
    check_public_firebase_config(root / 'web')
    version = 'v' + json.loads((root / 'version.json').read_text(encoding='utf-8'))['version']
    if destination is None:
        destination = root / 'web/downloads' / f'TDRoute_{version}.zip'
    destination.parent.mkdir(parents=True, exist_ok=True)
    files = sorted(set(source_files(root)) - {INVENTORY})
    with tempfile.TemporaryDirectory(dir=destination.parent) as staging:
        temporary = Path(staging) / destination.name
        with ZipFile(temporary, 'w', ZIP_DEFLATED) as archive:
            for name in files:
                path = root / name
                if Path(name).is_absolute() or '..' in Path(name).parts or not path.resolve().is_relative_to(root.resolve()):
                    raise ValueError(f'Invalid distribution path: {name}')
                entry = f'{version}/{name}'
                if name == 'web/sw.js' and worker is not None:
                    archive.writestr(entry, worker)
                else:
                    archive.write(path, entry)
            archive.writestr(f'{version}/{INVENTORY}', json.dumps(files, ensure_ascii=False, indent=2) + '\n')
        temporary.replace(destination)
    return destination


if __name__ == '__main__':
    print(build_archive())
