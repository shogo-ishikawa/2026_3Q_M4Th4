"""Package explicitly selected public works, without publishing source directories."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import shutil

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / '_site'
PROJECT = ROOT / 'projects' / 'world-definition'
VERSION = 'v1.2.0'
PUBLIC_FILES = ('index.html', 'guide.html', 'style.css', 'engine.js', 'progress.js', 'renderer.js', 'session.js', 'app.js')


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
    print(f'Built {OUTPUT.relative_to(ROOT)} with {archive.stat().st_size:,}-byte distribution ZIP')


if __name__ == '__main__':
    main()
