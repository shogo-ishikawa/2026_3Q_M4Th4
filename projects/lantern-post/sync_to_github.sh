#!/usr/bin/env bash
set -euo pipefail
asset_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
checkout_dir="$(mktemp -d "${TMPDIR:-/tmp}/lantern-post-sync.XXXXXX")"
trap 'rm -rf -- "$checkout_dir"' EXIT
git clone --depth 1 --branch main https://github.com/shogo-ishikawa/2026_3Q_M4Th4.git "$checkout_dir/repo"
python3 - "$asset_dir" "$checkout_dir/repo/projects/lantern-post" <<'PY'
from pathlib import Path
import shutil
import sys

source, destination = map(Path, sys.argv[1:])
if destination.exists():
    shutil.rmtree(destination)
ignored = shutil.ignore_patterns('.git', '.openai', 'node_modules', '__pycache__',
                                'downloads', '*.zip', '.DS_Store')
shutil.copytree(source, destination, ignore=ignored)
PY
git -C "$checkout_dir/repo" add --all -- projects/lantern-post
if git -C "$checkout_dir/repo" diff --cached --quiet; then
  echo '変更はありません。'
  exit 0
fi
git -C "$checkout_dir/repo" commit -m 'Update Lantern Post'
git -C "$checkout_dir/repo" push origin HEAD:main
echo 'アップロードしました。GitHub Actionsで確認とPagesの更新が始まります。'
