"""Package explicitly selected public works, without publishing source directories."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / '_site'
PROJECT = ROOT / 'projects' / 'world-definition'
VERSION = 'v1.3.0'
PUBLIC_FILES = ('index.html', 'guide.html', 'style.css', 'mystery.js', 'engine.js', 'progress.js', 'renderer.js', 'session.js', 'app.js')


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
    vocal_downloads = vocal_destination / 'downloads'
    vocal_downloads.mkdir(exist_ok=True)
    vocal_archive = vocal_downloads / 'VOCAL_FLUCTUATION_LAB_v1.0.0.zip'
    text_extensions = {'.py', '.md', '.toml', '.txt', '.json', '.html', '.css', '.js', '.ipynb'}
    with ZipFile(vocal_archive, 'w', ZIP_DEFLATED) as bundle:
        bundle.write(vocal_project / '.gitignore', Path('v1.0.0/.gitignore'))
        for path in sorted(vocal_project.rglob('*')):
            relative = path.relative_to(vocal_project)
            if (not path.is_file() or path.suffix not in text_extensions
                    or any(part.startswith('.') or part in {'__pycache__', 'outputs', 'uploads', 'separated', 'downloads', 'vocal_lab_runs', 'vocal_lab_downloads', 'vocal_reference_build'} for part in relative.parts)):
                continue
            bundle.write(path, Path('v1.0.0') / relative)
        for path in sorted((vocal_destination / 'data').glob('demo-*.json')):
            bundle.write(path, Path('v1.0.0/web/data') / path.name)
    print(f'Built vocal-fluctuation-lab with {vocal_archive.stat().st_size:,}-byte distribution ZIP')
    print(f'Built {OUTPUT.relative_to(ROOT)} with {archive.stat().st_size:,}-byte distribution ZIP')


if __name__ == '__main__':
    main()
