"""テストで共通に使う小さなデータ。"""

import sys
from pathlib import Path

import pytest

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "src"))  # インストールしていなくてもテストできるようにする

from coastal_wind_chaos import sample_data  # noqa: E402


@pytest.fixture(scope="session")
def two_year_weather():
    """2年分の合成データ（すべての成分）。テスト期間は最後の180日に使う。"""
    return sample_data.generate_weather("default", years=2, seed=11)


def write_text(path, lines, encoding="cp932"):
    """気象庁のファイルと同じく CRLF で行をつないで保存する。"""
    path.write_bytes(("\r\n".join(lines) + "\r\n").encode(encoding))
    return path
