"""図の文字が教材の約束どおりかを確かめる。

- 90度の線は「独立な一様ランダム方向予測の期待誤差」と書き、「限界」や「壁」とは書かない。
- ローレンツ系の時間は無次元で、時間（hours）ではないと書く。
"""

import matplotlib

matplotlib.use("Agg")  # 画面のない環境でも図を作れるようにする

import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402
import pytest  # noqa: E402
from matplotlib.text import Text  # noqa: E402

from coastal_wind_chaos import lorenz_demo, plotting  # noqa: E402

FORBIDDEN_WORDS = ["limit", "wall", "barrier", "uniform random guess"]


def figure_texts(fig):
    """図の中のすべての文字（題名、軸の名前、凡例、注記）。"""
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
        rows.append({"horizon_h": horizon, "model": "persistence", "mae_deg": persistence})
        rows.append({"horizon_h": horizon, "model": "climatology", "mae_deg": climatology})
    return pd.DataFrame(rows)


def test_reference_line_text_is_the_expected_error_of_a_random_direction():
    assert plotting.RANDOM_LINE_TEXT == "Independent uniform random direction: expected error 90°"


def test_error_figures_label_the_90_degree_line_as_a_reference(scores):
    hourly = pd.DataFrame({"persistence": range(24), "climatology": range(24)}, index=range(24), dtype=float)
    for fig in [plotting.plot_error_vs_horizon(scores), plotting.plot_error_by_hour(hourly)]:
        texts = figure_texts(fig)
        assert texts.count(plotting.RANDOM_LINE_TEXT) == 1
        check_no_forbidden_words(texts)


def test_every_panel_of_the_scenario_figure_has_the_full_label(scores):
    scenario_scores = pd.concat([scores.assign(scenario="periodic_only"), scores.assign(scenario="default")])
    models = ["persistence", "climatology"]
    texts = figure_texts(plotting.plot_scenario_comparison(scenario_scores, models))
    assert texts.count(plotting.RANDOM_LINE_TEXT) == len(models)
    check_no_forbidden_words(texts)


def test_lorenz_figures_say_the_time_is_not_in_hours():
    points = lorenz_demo.attractor_points(3, seed=0)
    table = lorenz_demo.predictability_table(points, [1e-6, 1e-3], 1.0, 1500)
    times, distances = lorenz_demo.twin_distances(points, 1e-6, 1500)
    runs = lorenz_demo.twin_runs(points[0], 1e-6, 1500)
    twin = plotting.plot_twin_runs(runs)
    growth = plotting.plot_separation_growth(times, distances, 1.0, 0.9)
    predictability = plotting.plot_predictability_times(table, 1.0)
    ar1 = plotting.plot_ar1_vs_lorenz(lorenz_demo.ar1_twin(), lorenz_demo.ar1_forecast_error_std(),
                                      times, distances)
    # ローレンツ系の時間を表す軸（ar1 は右の図がローレンツ系）
    time_labels = [twin.axes[1].get_xlabel(), growth.axes[0].get_xlabel(),
                   predictability.axes[0].get_ylabel(), ar1.axes[1].get_xlabel()]
    for label in time_labels:
        assert "Lorenz" in label, label
        assert "not hours" in label or "hour" not in label, label
    for fig in [twin, growth, predictability, ar1]:
        check_no_forbidden_words(figure_texts(fig))
