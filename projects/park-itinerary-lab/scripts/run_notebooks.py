"""Notebook を新しいカーネルで上から順に実行し、エラーがないかを確かめる（ローカルでの確認用）。

使い方（作品フォルダで、依存を入れた環境から）:
    python scripts/run_notebooks.py                         # 2つの Notebook を実行
    python scripts/run_notebooks.py 01_pulp_intro           # 1つだけ実行
    python scripts/run_notebooks.py --cwd repo-root         # repoルートを作業フォルダにして実行

実行済みの Notebook は outputs/executed_notebooks/<日時>/ に保存します（Git には入れません）。
Notebook のセットアップセルは、このチェックアウトのコードを使います（REPO_REF は取得しません）。
"""

import argparse
import sys
import time
from datetime import datetime
from pathlib import Path

import nbformat
from nbclient import NotebookClient
from nbclient.exceptions import CellExecutionError

PROJECT_DIR = Path(__file__).resolve().parents[1]
NOTEBOOKS = ("01_pulp_intro", "02_day_plan_optimisation")
WORKING_DIRS = {
    "notebooks": PROJECT_DIR / "notebooks",
    "project": PROJECT_DIR,
    "repo-root": PROJECT_DIR.parents[1],
}


def run_notebook(name, working_dir, save_dir, timeout):
    """1つの Notebook を実行し、(成功したか, 秒数, エラーの説明) を返す。"""
    notebook = nbformat.read(PROJECT_DIR / "notebooks" / f"{name}.ipynb", as_version=4)
    client = NotebookClient(
        notebook,
        timeout=timeout,
        kernel_name="python3",
        resources={"metadata": {"path": str(working_dir)}},
    )
    started = time.perf_counter()
    error = ""
    try:
        client.execute()
    except CellExecutionError as exc:
        error = str(exc)
    nbformat.write(notebook, save_dir / f"{name}.ipynb")
    return not error, time.perf_counter() - started, error


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("names", nargs="*", default=list(NOTEBOOKS), help="実行する Notebook の名前（拡張子なし）")
    parser.add_argument("--cwd", choices=sorted(WORKING_DIRS), default="notebooks", help="カーネルの作業フォルダ")
    parser.add_argument("--timeout", type=int, default=900, help="1つのセルの制限時間（秒）")
    args = parser.parse_args()

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    save_dir = PROJECT_DIR / "outputs" / "executed_notebooks" / f"{stamp}_cwd-{args.cwd}"
    save_dir.mkdir(parents=True)
    failures = 0
    for name in args.names:
        ok, seconds, error = run_notebook(name, WORKING_DIRS[args.cwd], save_dir, args.timeout)
        print(f"{'成功' if ok else '失敗'}: {name}（{seconds:.1f} 秒, 作業フォルダ: {WORKING_DIRS[args.cwd]}）")
        if not ok:
            failures += 1
            print(error[-4000:])
    print(f"実行済みの Notebook: {save_dir}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
