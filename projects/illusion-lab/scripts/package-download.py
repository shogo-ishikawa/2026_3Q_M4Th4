"""Package the laboratory source and guide in a version directory."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import argparse
import json

ROOT = Path(__file__).resolve().parents[1]


def build_archive(output=None):
    version = 'v' + json.loads((ROOT / 'version.json').read_text(encoding='utf-8'))['version']
    output = Path(output) if output else ROOT / 'web/downloads' / f'IllusionLab_{version}.zip'
    output.parent.mkdir(parents=True, exist_ok=True)
    files = [ROOT / name for name in ('README.md', 'package.json', 'version.json',
                                      'run.py', '.gitignore', 'sync_to_github.sh',
                                      'scripts/package-download.py')]
    for pattern in ('web/*.html', 'web/*.css', 'web/*.js', 'tests/*.mjs', 'docs/*.md'):
        files.extend(ROOT.glob(pattern))
    with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
        for path in sorted(set(files)):
            archive.write(path, Path(version) / path.relative_to(ROOT))
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    print(build_archive(parser.parse_args().output))
