"""Package explicitly selected public works, without publishing source directories."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json
import shutil
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / '_site'
PROJECT = ROOT / 'projects' / 'world-definition'
VERSION = 'v1.3.0'
PUBLIC_FILES = ('index.html', 'guide.html', 'style.css', 'mystery.js', 'engine.js', 'progress.js', 'renderer.js', 'session.js', 'app.js')
COASTAL_WEB_FILES = ('index.html', 'style.css', 'learning.js', 'results-core.js', 'results-viewer.js', 'demo-data.js')
SWING_WEB_FILES = ('index.html', 'style.css', 'app.js', 'motion-core.js', 'demo-data.js', 'demo-renderer.js', 'video-input.js', 'time-input.js')
PIPE_WEB_FILES = ('index.html', 'style.css', 'app.js', 'physics.js', 'sph.js',
                  'accuracy.js', 'laminar-pipe.js', 'radial-sph.js', 'radial-fv.js',
                  'radial-reference.js', 'wall-measurement.js', 'learning-content.js',
                  'learning-tools.js', 'methods.html', 'methods.css', 'methods.js',
                  'experiment-state.js')
ILLUSION_WEB_FILES = ('index.html', 'style.css', 'app.js', 'core.js', 'renderer.js', 'guide.html', 'lessons.js', 'lesson-view.js', 'guide.js', 'lessons.css')


PARK_WEB_FILES = ('index.html', 'style.css', 'app.js', 'planner.js', 'planner-worker.js',
                  'map-view.js', 'storage.js', 'weather.js', 'time-input.js', 'operation-windows.js', 'guide.html', 'data/parks.json',
                  'wait-data.js', 'wait-model.js', 'calendar-features.js', 'data/calendar.json', 'data/live-waits.json', 'data/wait-model.json',
                  'assets/land-map.webp', 'assets/sea-map.webp', 'assets/land-hero.webp', 'assets/sea-hero.webp',
                  'data/sea-geography.json', 'data/sea-geography-LICENCE.md', 'assets/sea-geographic-map.svg')


def build_park_site(output=OUTPUT):
    project = ROOT / 'projects' / 'park-itinerary-lab'
    destination = Path(output) / 'park-itinerary-lab'
    destination.mkdir(parents=True, exist_ok=True)
    for name in PARK_WEB_FILES:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(project / 'web' / name, target)
    version = 'v' + json.loads((project / 'version.json').read_text(encoding='utf-8'))['version']
    downloads = destination / 'downloads'
    downloads.mkdir(exist_ok=True)
    archive = downloads / f'ParkItineraryLab_{version}.zip'
    tracked = subprocess.check_output(['git', 'ls-files', '-z', '--', str(project.relative_to(ROOT))], cwd=ROOT).decode().split('\0')
    with ZipFile(archive, 'w', ZIP_DEFLATED) as bundle:
        for name in sorted(filter(None, tracked)):
            path = ROOT / name
            if path.is_file():
                bundle.write(path, Path(version) / path.relative_to(project))
    print(f'Built park-itinerary-lab with {archive.stat().st_size:,}-byte distribution ZIP')
    return archive


def build_illusion_site(output=OUTPUT):
    project = ROOT / 'projects' / 'illusion-lab'
    destination = Path(output) / 'illusion-lab'
    destination.mkdir(parents=True, exist_ok=True)
    for name in ILLUSION_WEB_FILES:
        shutil.copy2(project / 'web' / name, destination / name)
    version = 'v' + json.loads((project / 'version.json').read_text(encoding='utf-8'))['version']
    downloads = destination / 'downloads'
    downloads.mkdir(exist_ok=True)
    archive = downloads / f'IllusionLab_{version}.zip'
    tracked = subprocess.check_output(['git', 'ls-files', '-z', '--', str(project.relative_to(ROOT))], cwd=ROOT).decode().split('\0')
    with ZipFile(archive, 'w', ZIP_DEFLATED) as bundle:
        for name in sorted(filter(None, tracked)):
            path = ROOT / name
            if path.is_file():
                bundle.write(path, Path(version) / path.relative_to(project))
    print(f'Built illusion-lab with {archive.stat().st_size:,}-byte distribution ZIP')
    return archive


def build_lantern_site(output=OUTPUT):
    project = ROOT / 'projects' / 'lantern-post'
    destination = Path(output) / 'lantern-post'
    destination.mkdir(parents=True, exist_ok=True)
    game = project / 'Lantern_Post.html'
    shutil.copy2(game, destination / 'index.html')
    shutil.copy2(game, destination / 'Lantern_Post.html')
    shutil.copy2(project / 'guide.html', destination / 'guide.html')
    version = 'v' + json.loads((project / 'version.json').read_text(encoding='utf-8'))['version']
    downloads = destination / 'downloads'
    downloads.mkdir(exist_ok=True)
    archive = downloads / f'LanternPost_{version}.zip'
    tracked = subprocess.check_output(['git', 'ls-files', '-z', '--', str(project.relative_to(ROOT))], cwd=ROOT).decode().split('\0')
    with ZipFile(archive, 'w', ZIP_DEFLATED) as bundle:
        for name in sorted(filter(None, tracked)):
            path = ROOT / name
            if path.is_file():
                bundle.write(path, Path(version) / path.relative_to(project))
    print(f'Built lantern-post with {archive.stat().st_size:,}-byte distribution ZIP')
    return archive


def build_pipe_site(output=OUTPUT):
    project = ROOT / 'projects' / 'reynolds-pipe-lab'
    destination = Path(output) / 'reynolds-pipe-lab'
    destination.mkdir(parents=True, exist_ok=True)
    for name in PIPE_WEB_FILES:
        shutil.copy2(project / 'dist' / name, destination / name)
    version = 'v' + json.loads((project / 'version.json').read_text(encoding='utf-8'))['version']
    downloads = destination / 'downloads'
    downloads.mkdir(exist_ok=True)
    archive = downloads / f'ReynoldsFlowLab_{version}.zip'
    tracked = subprocess.check_output(['git', 'ls-files', '-z', '--', str(project.relative_to(ROOT))], cwd=ROOT).decode().split('\0')
    with ZipFile(archive, 'w', ZIP_DEFLATED) as bundle:
        for name in sorted(filter(None, tracked)):
            path = ROOT / name
            if path.is_file():
                bundle.write(path, Path(version) / path.relative_to(project))
    print(f'Built reynolds-pipe-lab with {archive.stat().st_size:,}-byte distribution ZIP')
    return archive


def build_swing_site(output=OUTPUT):
    project = ROOT / 'projects' / 'swing-motion-lab'
    destination = Path(output) / 'swing-motion-lab'
    destination.mkdir(parents=True, exist_ok=True)
    for name in SWING_WEB_FILES:
        shutil.copy2(project / 'web' / name, destination / name)
    version = 'v' + json.loads((project / 'version.json').read_text(encoding='utf-8'))['version']
    downloads = destination / 'downloads'
    downloads.mkdir(exist_ok=True)
    archive = downloads / f'MotionAnalysisLab_{version}.zip'
    tracked = subprocess.check_output(['git', 'ls-files', '-z', '--', str(project.relative_to(ROOT))], cwd=ROOT).decode().split('\0')
    with ZipFile(archive, 'w', ZIP_DEFLATED) as bundle:
        for name in sorted(filter(None, tracked)):
            path = ROOT / name
            if path.is_file():
                bundle.write(path, Path(version) / path.relative_to(project))
    print(f'Built swing-motion-lab with {archive.stat().st_size:,}-byte distribution ZIP')
    return archive


def build_coastal_site(output=OUTPUT):
    """風のWeb教材は配信用ファイルだけをコピーする。解析入力や生成結果は公開しない。"""
    project = ROOT / 'projects' / 'coastal-wind-chaos'
    destination = Path(output) / 'coastal-wind-chaos'
    destination.mkdir(parents=True, exist_ok=True)
    for name in COASTAL_WEB_FILES:
        shutil.copy2(project / 'web' / name, destination / name)
    version = 'v' + tomllib.loads((project / 'pyproject.toml').read_text(encoding='utf-8'))['project']['version']
    downloads = destination / 'downloads'
    downloads.mkdir(exist_ok=True)
    archive = downloads / f'CoastalWindLab_{version}.zip'
    # 管理対象だけを収録する。利用者のCSV・モデル・結果・ローカル環境は含めない。
    tracked = subprocess.check_output(['git', 'ls-files', '-z', '--', str(project.relative_to(ROOT))], cwd=ROOT).decode().split('\0')
    with ZipFile(archive, 'w', ZIP_DEFLATED) as bundle:
        for name in sorted(filter(None, tracked)):
            path = ROOT / name
            if path.is_file():
                bundle.write(path, Path(version) / path.relative_to(project))
    print(f'Built coastal-wind-chaos with {archive.stat().st_size:,}-byte distribution ZIP')
    return archive


def main():
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    destination = OUTPUT / 'world-definition'
    destination.mkdir(parents=True)
    for name in PUBLIC_FILES:
        shutil.copy2(PROJECT / name, destination / name)
    shutil.copy2(ROOT / 'web' / 'index.html', OUTPUT / 'index.html')
    (OUTPUT / '.nojekyll').touch()
    downloads = destination / 'downloads'
    downloads.mkdir()
    archive = downloads / f'WORLD_DEFINITION_{VERSION}.zip'
    with ZipFile(archive, 'w', ZIP_DEFLATED) as bundle:
        for path in sorted(PROJECT.rglob('*')):
            relative = path.relative_to(PROJECT)
            if not path.is_file() or any(part.startswith('.') or part in {'__pycache__', 'downloads'} for part in relative.parts):
                continue
            bundle.write(path, Path(VERSION) / relative)
    vocal_project = ROOT / 'projects' / 'vocal-fluctuation-lab'
    vocal_destination = OUTPUT / 'vocal-fluctuation-lab'
    shutil.copytree(vocal_project / 'web', vocal_destination)
    subprocess.run([sys.executable, str(vocal_project / 'scripts' / 'generate_demos.py'),
                    '--output', str(vocal_destination / 'data')], check=True)
    catalogue_name = 'reference_catalogue_public.json'
    shutil.copy2(vocal_project / 'data' / catalogue_name, vocal_destination / 'data' / catalogue_name)
    listening_name = 'reference_listening_links.json'
    shutil.copy2(vocal_project / 'data' / listening_name, vocal_destination / 'data' / listening_name)
    vocal_downloads = vocal_destination / 'downloads'
    vocal_downloads.mkdir(exist_ok=True)
    vocal_version = 'v' + tomllib.loads((vocal_project / 'pyproject.toml').read_text(encoding='utf-8'))['project']['version']
    vocal_archive = vocal_downloads / f'VOCAL_FLUCTUATION_LAB_{vocal_version}.zip'
    text_extensions = {'.py', '.md', '.toml', '.txt', '.json', '.csv', '.html', '.css', '.js', '.ipynb'}
    with ZipFile(vocal_archive, 'w', ZIP_DEFLATED) as bundle:
        bundle.write(vocal_project / '.gitignore', Path(vocal_version) / '.gitignore')
        for path in sorted(vocal_project.rglob('*')):
            relative = path.relative_to(vocal_project)
            if (not path.is_file() or path.suffix not in text_extensions
                    or (relative.parent == Path('web/data') and path.match('demo-*.json'))
                    or any(part.startswith('.') or part in {'__pycache__', 'outputs', 'uploads', 'separated', 'downloads', 'vocal_lab_runs', 'vocal_lab_downloads', 'vocal_reference_build'} for part in relative.parts)):
                continue
            bundle.write(path, Path(vocal_version) / relative)
        for path in sorted((vocal_destination / 'data').glob('demo-*.json')):
            bundle.write(path, Path(vocal_version) / 'web/data' / path.name)
        bundle.write(vocal_destination / 'data' / catalogue_name, Path(vocal_version) / 'web/data' / catalogue_name)
        bundle.write(vocal_destination / 'data' / listening_name, Path(vocal_version) / 'web/data' / listening_name)
    print(f'Built vocal-fluctuation-lab with {vocal_archive.stat().st_size:,}-byte distribution ZIP')
    build_coastal_site()
    build_swing_site()
    build_pipe_site()
    build_lantern_site()
    build_illusion_site()
    build_park_site()
    print(f'Built {OUTPUT.relative_to(ROOT)} with {archive.stat().st_size:,}-byte distribution ZIP')


if __name__ == '__main__':
    main()
