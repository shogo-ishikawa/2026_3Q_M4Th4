"""Package the offline game and its guide in one version directory."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import argparse
import json

ROOT = Path(__file__).resolve().parents[1]


def build_archive(output=None):
    version = 'v' + json.loads((ROOT / 'version.json').read_text(encoding='utf-8'))['version']
    output = Path(output) if output else ROOT / 'downloads' / f'LanternPost_{version}.zip'
    output.parent.mkdir(parents=True, exist_ok=True)
    names = ['Lantern_Post.html', 'guide.html', 'README.md', 'version.json',
             'package.json', '.gitignore', 'sync_to_github.sh', 'scripts/package-download.py']
    files = [ROOT / name for name in names]
    files.extend(ROOT.glob('tests/*.mjs'))
    with ZipFile(output, 'w', ZIP_DEFLATED) as bundle:
        for path in sorted(files):
            bundle.write(path, Path(version) / path.relative_to(ROOT))
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    print(build_archive(parser.parse_args().output))
