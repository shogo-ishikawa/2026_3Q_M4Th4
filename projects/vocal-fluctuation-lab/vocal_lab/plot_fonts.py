"""Colab とローカルで日本語のグラフを同じように表示する。"""

from importlib.util import find_spec
from pathlib import Path

import matplotlib
from matplotlib import font_manager


def configure_plot_fonts() -> str:
    """同梱フォントを登録し、描画時のネットワーク接続を不要にする。"""
    package = find_spec("japanize_matplotlib")
    if package is not None and package.origin:
        font_path = Path(package.origin).parent / "fonts" / "ipaexg.ttf"
        if font_path.is_file():
            font_manager.fontManager.addfont(str(font_path))
            family = font_manager.FontProperties(fname=str(font_path)).get_name()
            matplotlib.rcParams["font.family"] = [family, "sans-serif"]
            matplotlib.rcParams["axes.unicode_minus"] = False
            return family

    for family in ("Noto Sans CJK JP", "IPAexGothic", "Hiragino Sans", "Yu Gothic"):
        try:
            font_manager.findfont(family, fallback_to_default=False)
        except ValueError:
            continue
        matplotlib.rcParams["font.family"] = [family, "sans-serif"]
        matplotlib.rcParams["axes.unicode_minus"] = False
        return family
    raise RuntimeError("日本語フォントを準備できません。最初の準備セルをもう一度実行してください。")
