"""配布用ZIP（guitar-chord-lab-vX.Y.Z.zip）を作ります。

Gitで管理しているこの作品のファイルだけを集め、展開後の最上位フォルダを vX.Y.Z にします。
音源、モデル重み、キャッシュ、仮想環境、実験出力は含めません（Gitで管理していないため）。
ZIPには、使ったコミットを書いた release_info.json を加えます。

使い方（作品フォルダ projects/guitar-chord-lab で実行）:
    python scripts/make_release_zip.py
    python scripts/make_release_zip.py --output-dir dist
"""

import argparse
import json
import subprocess
import sys
import tomllib
import zipfile
from datetime import datetime, timezone
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
NAME = "guitar-chord-lab"

# Gitで管理していても、念のため配布しないもの
EXCLUDED_FOLDERS = {".git", ".venv", "venv", "__pycache__", ".pytest_cache", ".ipynb_checkpoints", "outputs", "dist"}
EXCLUDED_SUFFIXES = {
    ".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac",
    ".pt", ".pth", ".ckpt", ".onnx", ".safetensors", ".th", ".zip",
}


def read_version():
    """pyproject.toml から版を読み取ります。"""
    with open(PROJECT_DIR / "pyproject.toml", "rb") as file:
        return tomllib.load(file)["project"]["version"]


def git(*arguments):
    """作品フォルダで git コマンドを実行し、出力を返します。"""
    return subprocess.run(["git", *arguments], cwd=PROJECT_DIR, capture_output=True, text=True, check=True).stdout


def tracked_files():
    """Gitで管理している、この作品のファイルの一覧（作品フォルダからの相対パス）を返します。"""
    names = git("ls-files", "-z", "--", ".").split("\0")
    return sorted(Path(name) for name in names if name)


def is_excluded(path):
    """配布しないファイルなら True を返します。"""
    if any(part in EXCLUDED_FOLDERS for part in path.parts):
        return True
    return path.suffix.lower() in EXCLUDED_SUFFIXES


def make_zip(output_path, version, files, commit):
    """ファイルを vX.Y.Z/ の下にまとめたZIPを作ります。"""
    top = f"v{version}"
    info = {
        "name": NAME,
        "version": version,
        "git_commit": commit,
        "created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(PROJECT_DIR / path, f"{top}/{path.as_posix()}")
        archive.writestr(f"{top}/release_info.json", json.dumps(info, ensure_ascii=False, indent=2) + "\n")
    return output_path


def main():
    parser = argparse.ArgumentParser(description="Guitar Chord Lab の配布用ZIPを作ります")
    parser.add_argument("--output-dir", default=str(PROJECT_DIR / "dist"), help="ZIPの保存先")
    parser.add_argument("--allow-dirty", action="store_true", help="未コミットの変更があっても作る（確認用）")
    args = parser.parse_args()

    changes = git("status", "--porcelain", "--", ".").strip()
    if changes and not args.allow_dirty:
        print("未コミットの変更があります。コミットしてから実行してください:\n" + changes, file=sys.stderr)
        return 1
    version = read_version()
    commit = git("rev-parse", "HEAD").strip()
    files = [path for path in tracked_files() if not is_excluded(path)]
    output_path = Path(args.output_dir) / f"{NAME}-v{version}.zip"
    make_zip(output_path, version, files, commit)
    print(f"作成しました: {output_path.resolve()}（{len(files)}ファイル、最上位フォルダ v{version}/、コミット {commit[:12]}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
