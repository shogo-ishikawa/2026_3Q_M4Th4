"""Notebookを上から順に実行し、最後までエラーなく動くかを確かめます（ローカルでの確認用）。

Colab上での動作確認の代わりにはなりません。実行結果付きのNotebookは outputs/notebook_runs/ に
保存します（Gitには追加しません）。必要なライブラリ: pip install -e ".[dev,separation]"

使い方（作品フォルダ projects/guitar-chord-lab で実行）:
    python scripts/run_notebooks.py notebooks/01_single_guitar_chords.ipynb
    python scripts/run_notebooks.py notebooks/*.ipynb --timeout 3600
"""

import argparse
import sys
import time
from pathlib import Path

import nbformat
from nbclient import NotebookClient

PROJECT_DIR = Path(__file__).resolve().parents[1]


def run_notebook(path, output_dir, timeout):
    """1つのNotebookを実行し、結果付きのNotebookを保存します。"""
    notebook = nbformat.read(path, as_version=4)
    client = NotebookClient(
        notebook, timeout=timeout, kernel_name="python3",
        resources={"metadata": {"path": str(path.parent)}},  # Notebookのあるフォルダで実行する
    )
    started = time.perf_counter()
    client.execute()
    seconds = time.perf_counter() - started
    output_path = output_dir / path.name
    nbformat.write(notebook, output_path)
    return seconds, output_path


def main():
    parser = argparse.ArgumentParser(description="Notebookを順に実行して確認します")
    parser.add_argument("notebooks", nargs="+", help="実行するNotebook")
    parser.add_argument("--output-dir", default=str(PROJECT_DIR / "outputs" / "notebook_runs"))
    parser.add_argument("--timeout", type=int, default=1800, help="1セルあたりの制限時間 [秒]")
    args = parser.parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    for name in args.notebooks:
        path = Path(name).resolve()
        print(f"実行中: {path.name}", flush=True)
        seconds, output_path = run_notebook(path, output_dir, args.timeout)
        print(f"  完了（{seconds:.0f}秒）: {output_path}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
