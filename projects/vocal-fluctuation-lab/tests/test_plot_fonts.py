"""日本語の書き出し画像で文字が欠けないことを確認する。"""

from io import BytesIO
from pathlib import Path
import sys
import unittest
import warnings

import matplotlib
matplotlib.use("Agg")
from matplotlib import pyplot as plt

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vocal_lab.plot_fonts import configure_plot_fonts


class PlotFontTests(unittest.TestCase):
    def test_japanese_png_has_no_missing_glyphs(self):
        configure_plot_fonts()
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            fig, ax = plt.subplots()
            ax.plot([0, 1, 2], [1, 0.5, 0.25], label="解析した歌声")
            ax.set_xlabel("解析した音声の時間［秒］")
            ax.set_ylabel("音量変化の強さ（相対値）")
            ax.set_title("ゆらぎの周波数と傾き β = −1.33")
            ax.legend()
            output = BytesIO()
            fig.savefig(output, format="png")
            plt.close(fig)
        self.assertTrue(output.getvalue().startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertFalse([str(item.message) for item in caught if "Glyph" in str(item.message)])


if __name__ == "__main__":
    unittest.main()
