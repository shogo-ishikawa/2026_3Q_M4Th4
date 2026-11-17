#!/usr/bin/env bash
set -euo pipefail
asset_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
checkout_dir="$(mktemp -d "${TMPDIR:-/tmp}/park-itinerary-sync.XXXXXX")"
trap 'rm -rf -- "$checkout_dir"' EXIT
git clone --depth 1 --branch main https://github.com/shogo-ishikawa/2026_3Q_M4Th4.git "$checkout_dir/repo"
python3 - "$asset_dir" "$checkout_dir/repo/projects/park-itinerary-lab" <<'PY'
from pathlib import Path
import shutil
import sys

source, destination = map(Path, sys.argv[1:])
if destination.exists():
    shutil.rmtree(destination)
shutil.copytree(source, destination, ignore=shutil.ignore_patterns(
    '.git', '.openai', '.venv', 'node_modules', '__pycache__', '.pytest_cache',
    '.ipynb_checkpoints', 'downloads', 'outputs', 'uploads', 'student', 'dist', '*.zip', '.DS_Store'))
PY
git -C "$checkout_dir/repo" add --all -- projects/park-itinerary-lab
if git -C "$checkout_dir/repo" diff --cached --quiet; then
  echo '変更はありません。'
  exit 0
fi
git -C "$checkout_dir/repo" commit -m 'Update Park Itinerary Lab'
git -C "$checkout_dir/repo" push origin HEAD:main
echo 'アップロードしました。GitHub Actionsで確認とPagesの更新が始まります。'
