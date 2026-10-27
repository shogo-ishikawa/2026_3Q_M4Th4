"""配布用 zip を作る（展開すると v0.1.0/ のように版の名前のフォルダになる）。

使い方（作品フォルダで）:
    python scripts/make_dist.py

作るもの: dist/park-itinerary-lab-v<版>.zip（dist/ と *.zip は Git の管理対象外）

zip に入れるのは、Git で管理しているこの作品のファイルだけです（git ls-files）。
outputs/ の計算結果、キャッシュ、仮想環境、他の作品、.git は入りません。
同じコミットからは同じ内容の zip ができるよう、ファイルの順序と時刻を固定します。
作品フォルダにコミットしていない変更があると、zip の中身をコミットと対応させられないため止まります。
"""

import argparse
import subprocess
import sys
import tomllib
import zipfile
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
FIXED_TIME = (2026, 1, 1, 0, 0, 0)
FORBIDDEN_PARTS = {".git", "__pycache__", ".ipynb_checkpoints", ".pytest_cache", ".venv", "venv", "dist"}


def project_version():
    with (PROJECT_DIR / "pyproject.toml").open("rb") as file:
        return tomllib.load(file)["project"]["version"]


def run_git(args):
    done = subprocess.run(["git", *args], cwd=PROJECT_DIR, capture_output=True, text=True)
    if done.returncode != 0:
        raise SystemExit(f"git {' '.join(args)} が失敗しました。Git のチェックアウトの中で実行してください。\n{done.stderr}")
    return done.stdout


def tracked_files():
    """この作品のフォルダで Git が管理しているファイル（作品フォルダからの相対パス）。"""
    return sorted(name for name in run_git(["ls-files", "-z", "--", "."]).split("\0") if name)


def build_zip(files, version, target):
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in files:
            info = zipfile.ZipInfo(f"v{version}/{name}", date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, (PROJECT_DIR / name).read_bytes())


def check_zip(target, version):
    """zip の中身を確かめ、問題の一覧を返す。"""
    with zipfile.ZipFile(target) as archive:
        names = archive.namelist()
    problems = []
    if {name.split("/")[0] for name in names} != {f"v{version}"}:
        problems.append(f"最上位のフォルダが v{version} だけになっていません")
    for name in names:
        parts = name.split("/")
        if FORBIDDEN_PARTS & set(parts):
            problems.append(f"入れてはいけないファイル: {name}")
        if len(parts) > 2 and parts[1] == "outputs" and parts[-1] != "README.md":
            problems.append(f"計算結果が入っています: {name}")
        if name.endswith((".zip", ".pyc")):
            problems.append(f"生成物が入っています: {name}")
    for required in ("README.md", "pyproject.toml", "notebooks/01_pulp_intro.ipynb", "notebooks/02_day_plan_optimisation.ipynb"):
        if f"v{version}/{required}" not in names:
            problems.append(f"必要なファイルがありません: {required}")
    return names, problems


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--force", action="store_true", help="同じ名前の zip があれば上書きする")
    args = parser.parse_args()

    version = project_version()
    changes = run_git(["status", "--porcelain", "--", "."]).strip()
    if changes:
        raise SystemExit("作品フォルダにコミットしていない変更があります。コミットしてから実行してください。\n" + changes)
    target = PROJECT_DIR / "dist" / f"park-itinerary-lab-v{version}.zip"
    if target.exists() and not args.force:
        raise SystemExit(f"{target} はすでにあります。作り直す場合は --force を付けてください。")
    target.parent.mkdir(exist_ok=True)
    build_zip(tracked_files(), version, target)
    names, problems = check_zip(target, version)
    commit = run_git(["rev-parse", "HEAD"]).strip()
    print(f"作成しました: {target}（{len(names)} ファイル、コミット {commit}）")
    if problems:
        print("問題が見つかりました:")
        for problem in problems:
            print(" -", problem)
        return 1
    print(f"確認: 最上位のフォルダは v{version}/ だけで、.git・キャッシュ・計算結果・他の作品は含まれていません。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
