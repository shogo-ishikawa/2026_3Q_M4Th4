"""Build the portable browser distribution using only project source folders."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json


def build_archive():
    root = Path(__file__).resolve().parents[1]
    version = 'v' + json.loads((root / 'version.json').read_text(encoding='utf-8'))['version']
    destination = root / 'web/downloads' / f'TDRoute_{version}.zip'
    destination.parent.mkdir(exist_ok=True)
    allowed_roots = {'web', 'src', 'tests', 'tests-web', 'configs', 'data', 'docs', 'requirements', 'scripts'}
    excluded = {'__pycache__', 'node_modules', 'downloads', 'outputs', 'uploads', 'dist', '.pytest_cache', '.ipynb_checkpoints'}
    extensions = {'.js', '.mjs', '.py', '.html', '.css', '.json', '.csv', '.md', '.txt', '.toml', '.ipynb', '.sh', '.webp', '.svg', '.png'}
    files = []
    for path in root.rglob('*'):
        relative = path.relative_to(root)
        if (not path.is_file() or path.suffix not in extensions or any(part in excluded or part.startswith('.') for part in relative.parts)
                or (len(relative.parts) > 1 and relative.parts[0] not in allowed_roots)):
            continue
        files.append(path)
    with ZipFile(destination, 'w', ZIP_DEFLATED) as archive:
        for path in sorted(files):
            archive.write(path, Path(version) / path.relative_to(root))
    return destination


if __name__ == '__main__':
    print(build_archive())
