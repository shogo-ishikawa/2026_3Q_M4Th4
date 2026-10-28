"""図の文字が教材の約束どおりかを確かめる。

- 90度の線は「独立な一様ランダム方向予測の期待誤差」と書き、「限界」や「壁」とは書かない。
- ローレンツ系の時間は無次元で、時間（hours）ではないと書く。
- 日本語フォントがあれば日本語、なければ理由を示して英語にする。
"""

import matplotlib

matplotlib.use("Agg")  # 画面のない環境でも図を作れるようにする

import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402
import pytest  # noqa: E402
from matplotlib import font_manager  # noqa: E402
from matplotlib.text import Text  # noqa: E402

from coastal_wind_chaos import lorenz_demo, plotting  # noqa: E402

FORBIDDEN_WORDS = ["limit", "wall", "barrier", "uniform random guess", "限界", "壁"]


@pytest.fixture(autouse=True)
def english_figures():
    """図の文字を英語にしてテストし、終わったら元に戻す（ほかのテストに影響しないように）。"""
    language, font = plotting.LANGUAGE, plotting.FONT_NAME
    plotting.apply_style("en", verbose=False)
    yield
    plotting.LANGUAGE, plotting.FONT_NAME = language, font
    plt.rcdefaults()


def figure_texts(fig, draw=True):
    """図の中のすべての文字（題名、軸の名前、凡例、注記）。"""
    if draw:
        fig.canvas.draw()
    texts = [artist.get_text() for artist in fig.findobj(Text)]
    plt.close(fig)
    return [text for text in texts if text]


def check_no_forbidden_words(texts):
    for text in texts:
        for word in FORBIDDEN_WORDS:
            assert word not in text.lower(), text


@pytest.fixture
def scores():
    rows = []
    for horizon, persistence, climatology in [(1, 20.0, 50.0), (6, 60.0, 50.0), (24, 45.0, 50.0)]:
        rows.append({"horizon_h": horizon, "model": "persistence", "mae_deg": persistence, "vector_rmse_ms": 2.0})
        rows.append({"horizon_h": horizon, "model": "climatology", "mae_deg": climatology, "vector_rmse_ms": 3.0})
    return pd.DataFrame(rows)


def test_reference_line_text_is_the_expected_error_of_a_random_direction():
    assert plotting.RANDOM_LINE_TEXT == "Independent uniform random direction: expected error 90°"
    assert plotting.RANDOM_LINE_TEXT_JA.startswith("独立な一様ランダム方向予測の期待誤差")


def test_error_figures_label_the_90_degree_line_as_a_reference(scores):
    hourly = pd.DataFrame({"persistence": range(24), "climatology": range(24)}, index=range(24), dtype=float)
    for fig in [plotting.plot_error_vs_horizon(scores), plotting.plot_error_by_hour(hourly)]:
        texts = figure_texts(fig)
        assert texts.count(plotting.RANDOM_LINE_TEXT) == 1
        check_no_forbidden_words(texts)
    check_no_forbidden_words(figure_texts(plotting.plot_vector_rmse_vs_horizon(scores)))


def test_every_panel_of_the_scenario_figure_has_the_full_label(scores):
    scenario_scores = pd.concat([scores.assign(scenario="periodic_only"), scores.assign(scenario="default")])
    models = ["persistence", "climatology"]
    texts = figure_texts(plotting.plot_scenario_comparison(scenario_scores, models))
    assert texts.count(plotting.RANDOM_LINE_TEXT) == len(models)
    check_no_forbidden_words(texts)


def lorenz_figures():
    points = lorenz_demo.attractor_points(3, seed=0)
    table = lorenz_demo.predictability_table(points, [1e-6, 1e-3], 1.0, 1500)
    times, distances = lorenz_demo.twin_distances(points, 1e-6, 1500)
    runs = lorenz_demo.twin_runs(points[0], 1e-6, 1500)
    steps = lorenz_demo.time_step_check(points, (0.01, 0.005), (1e-6,), 1.0, total_time=15.0, benettin_time=5.0)
    return {
        "twin": plotting.plot_twin_runs(runs),
        "growth": plotting.plot_separation_growth(times, distances, 1.0, 0.9),
        "predictability": plotting.plot_predictability_times(table, 1.0),
        "ar1": plotting.plot_ar1_vs_lorenz(lorenz_demo.ar1_twin(), lorenz_demo.ar1_forecast_error_std(),
                                           times, distances),
        "steps": plotting.plot_time_step_check(steps),
    }


def test_lorenz_figures_say_the_time_is_not_in_hours():
    figures = lorenz_figures()
    # ローレンツ系の時間を表す軸（ar1 は右の図がローレンツ系）
    time_labels = [figures["twin"].axes[1].get_xlabel(), figures["growth"].axes[0].get_xlabel(),
                   figures["predictability"].axes[0].get_ylabel(), figures["ar1"].axes[1].get_xlabel()]
    for label in time_labels:
        assert "Lorenz" in label, label
        assert "not hours" in label or "hour" not in label, label
    for fig in figures.values():
        check_no_forbidden_words(figure_texts(fig))


def test_english_with_the_reason_when_no_japanese_font_is_found(monkeypatch, capsys):
    monkeypatch.setattr(plotting, "find_japanese_font", lambda font_path=None: (None, "テスト用：見つからない"))
    assert plotting.apply_style("auto") == "en"
    message = capsys.readouterr().out
    assert "テスト用：見つからない" in message and "英語" in message
    assert plotting.text("mae_axis") == "Mean absolute direction error (°)"


def test_japanese_labels_when_a_japanese_font_is_found(monkeypatch, capsys, scores):
    monkeypatch.setattr(plotting, "find_japanese_font", lambda font_path=None: ("DejaVu Sans", "テスト用"))
    assert plotting.apply_style("auto") == "ja"
    assert "日本語" in capsys.readouterr().out
    assert plotting.text("mae_axis") == "平均絶対角度誤差（度）"
    texts = figure_texts(plotting.plot_error_vs_horizon(scores), draw=False)
    assert texts.count(plotting.RANDOM_LINE_TEXT_JA) == 1
    check_no_forbidden_words(texts)
    lorenz = lorenz_figures()
    assert "無次元" in lorenz["twin"].axes[1].get_xlabel() and "ではない" in lorenz["twin"].axes[1].get_xlabel()
    for fig in lorenz.values():
        check_no_forbidden_words(figure_texts(fig, draw=False))


def test_font_check_tells_japanese_fonts_from_others():
    dejavu = font_manager.findfont("DejaVu Sans")
    assert not plotting.font_has_japanese(dejavu)
    name, detail = plotting.find_japanese_font(font_path=dejavu)
    assert name is None and "日本語" in detail
    found, path = plotting.find_japanese_font()
    if found is None:
        pytest.skip("この環境には日本語フォントがない")
    assert plotting.font_has_japanese(path)
