"""海辺の風は何時間先まで予測できるか――機械学習とカオスから考える予測可能性。

- sample_data：南側に海がある仮想観測点の合成データを、気象庁形式のCSVで作る
- wind_pipeline：読込、変換、特徴量、時間分割、予測、評価
- lorenz_demo：ローレンツ系の初期値鋭敏性の実験（風向きの予測とは独立）
- plotting：図を描く関数
"""

import platform
import subprocess
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

__version__ = "0.1.0"


def git_commit(folder="."):
    """folder を含むGitリポジトリの、現在のコミットID（取得できなければ None）。"""
    try:
        result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=Path(folder),
                                capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    return result.stdout.strip()


def environment_info(folder="."):
    """実行環境（Pythonと主なライブラリの版、Gitのコミット）を辞書で返す。結果の記録用。"""
    info = {"python": platform.python_version(), "coastal_wind_chaos": __version__}
    for package in ["numpy", "pandas", "scikit-learn", "matplotlib"]:
        try:
            info[package] = version(package)
        except PackageNotFoundError:
            info[package] = None
    info["git_commit"] = git_commit(folder)
    return info
