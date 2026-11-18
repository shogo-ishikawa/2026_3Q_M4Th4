#!/usr/bin/env bash
set -euo pipefail
ASSET_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
CHECKOUT_DIR="${ASTERION_CHECKOUT_DIR:-$ASSET_DIR/../class-repository}"
REPOSITORY_URL="https://github.com/shogo-ishikawa/2026_3Q_M4Th4.git"
if [ ! -d "$CHECKOUT_DIR/.git" ]; then
  git clone "$REPOSITORY_URL" "$CHECKOUT_DIR"
fi
git -C "$CHECKOUT_DIR" pull --ff-only
TARGET_DIR="$CHECKOUT_DIR/projects/asterion-story"
mkdir -p "$TARGET_DIR"
rsync -a --exclude='.git' --exclude='__pycache__' --exclude='*.zip' --exclude='.openai' "$ASSET_DIR/" "$TARGET_DIR/"
git -C "$CHECKOUT_DIR" add -- projects/asterion-story
if git -C "$CHECKOUT_DIR" diff --cached --quiet; then
  echo '変更はありません。'
  exit 0
fi
git -C "$CHECKOUT_DIR" commit -m 'Update Asterion story game'
git -C "$CHECKOUT_DIR" push
echo 'コードを同期しました。公開ビルドの結果はGitHub Actionsで確認できます。'
