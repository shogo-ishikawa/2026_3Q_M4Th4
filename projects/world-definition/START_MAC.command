#!/bin/bash
set -e
cd -- "$(dirname -- "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo 'Python 3が見つかりません。公開Web版で遊ぶか、Python 3を導入してください。'
  exit 1
fi
exec python3 server.py "$@"
