"""4つの実験の関数を確かめる（手法の勝ち負けではなく、条件のそろえ方と仕組みを確かめる）。"""

import numpy as np
import pandas as pd
import pytest

from coastal_wind_chaos import experiments as ex
from coastal_wind_chaos import wind_pipeline as wp


@pytest.fixture(scope="module")
def split(three_year_weather):
    return wp.year_split(three_year_weather)


# ---------------------------------------------------------------------------
# 実験1：角度の罠
# ---------------------------------------------------------------------------

def test_mean_of_337_5_and_22_5():
    table = ex.mean_direction_example().set_index("method")
    assert table.loc["arithmetic mean", "mean_deg"] == pytest.approx(180.0)   # 南になってしまう
    assert table.loc["vector mean (u, v)", "mean_deg"] == pytest.approx(0.0)  # 北
    assert table.loc["vector mean (u, v)", "direction_label"] == "北"


def near_north_weather(seed=0, days=120):
    """いつも北寄り（北北西・北・北北東）の風が吹く、小さな合成データ。"""
    rng = np.random.default_rng(seed)
    times = pd.date_range("2024-01-01 01:00", periods=24 * days, freq=pd.Timedelta(hours=1))
    labels = rng.choice(["北北西", "北", "北北東"], size=len(times))
    raw = pd.DataFrame({"wind_speed_ms": 3.0, "wind_speed_ms_quality": 8, "wind_direction": labels.astype(object),
                        "wind_direction_quality": 8}, index=pd.DatetimeIndex(times, name="time"))
    return wp.prepare_weather(raw)


def test_direct_angle_regression_falls_into_the_south_when_the_truth_is_north():
    """北寄りの風（337.5度・0度・22.5度）を角度のまま回帰すると、数としての平均（約120度）に引っぱられ、
    北から大きく外れる。u, v で回帰すれば北寄りの予測になる（仕組みの確認）。"""
    weather = near_north_weather()
    split = wp.last_days_split(weather, test_days=20)
    models = ["linear:calendar+recent", "linear_angle:calendar+recent"]
    forecasts = wp.forecast_stage(weather, 3, models, split, "test", max_horizon=3)
    used = forecasts["excluded"] == ""
    by_angle = forecasts.loc[used, "linear_angle:calendar+recent"]
    by_vector = forecasts.loc[used, "linear:calendar+recent"]
    assert (wp.angular_error(by_angle, 0.0) > 45).mean() > 0.9
    assert (wp.angular_error(by_vector, 0.0) < 45).mean() > 0.9


def test_experiment1_trains_uv_and_angle_on_the_same_rows(three_year_weather, split, monkeypatch):
    """表し方だけを変えた比較にするため、u, v の回帰も角度の回帰と同じ（対象時刻が静穏でない）行で学習する。
    ふつうの u, v の予測（実験2・3）では、静穏の行も u = v = 0 として学習に使う。"""
    used = {}
    original_uv, original_angle = wp.fit_predict_uv, wp.fit_predict_angle

    def recording_uv(method, train, rows, columns, seed=0):
        used["uv"] = train.index
        return original_uv(method, train, rows, columns, seed)

    def recording_angle(method, train, rows, columns, seed=0):
        used["angle"] = train.dropna(subset=["target_direction_deg"]).index  # 角度の回帰が実際に使う行
        return original_angle(method, train, rows, columns, seed)

    monkeypatch.setattr(wp, "fit_predict_uv", recording_uv)
    monkeypatch.setattr(wp, "fit_predict_angle", recording_angle)
    result = ex.experiment_angle(three_year_weather, split, methods=("linear",), horizon=3)
    assert used["uv"].equals(used["angle"]) and len(used["uv"]) == result["n_train"]
    assert result["n_calm_train"] > 0
    used.clear()
    wp.forecast_stage(three_year_weather, 3, ["linear:calendar+recent"], split, "validation")
    assert len(used["uv"]) == result["n_train"] + result["n_calm_train"]


def test_experiment1_compares_the_same_inputs_period_and_settings(three_year_weather, split):
    result = ex.experiment_angle(three_year_weather, split, methods=("linear",), horizon=3)
    assert result["pairs"] == [("linear:calendar+recent", "linear_angle:calendar+recent")]
    uv, angle = result["pairs"][0]
    assert wp.parse_model(uv)[1] == wp.parse_model(angle)[1]                       # 同じ入力
    assert wp.split_method(wp.parse_model(angle)[0]) == ("linear", True)          # 同じ設定で、目的変数だけ違う
    assert f"{uv}__u" in result["forecasts"] and f"{angle}__u" not in result["forecasts"]
    assert result["scores"]["n_test"].nunique() == 1                               # 同じ行で比べる
    assert result["forecasts"].index.min() >= split["validation_start"]            # 検証期間で比べる
    assert list(result["by_direction"].index) == list(range(16))
    assert set(result["north"]["model"]) == set(result["models"])


# ---------------------------------------------------------------------------
# 実験2：3時間先の特徴量の比較と、48時間の例
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def experiment2(three_year_weather, split):
    return ex.experiment_features(three_year_weather, split, "linear", horizon=3)


def test_experiment2_compares_feature_sets_and_three_baselines(experiment2, split):
    assert experiment2["models"] == ["linear:calendar", "linear:recent", "linear:calendar+recent",
                                     "persistence", "climatology", "persistence_24h"]
    assert experiment2["scores"]["n_test"].nunique() == 1
    assert experiment2["forecasts"].index.min() >= split["test_start"]


def test_example_windows_depend_only_on_observations(three_year_weather, experiment2):
    forecasts = experiment2["forecasts"]
    scrambled = forecasts.copy()
    rng = np.random.default_rng(1)
    for spec in experiment2["models"]:
        scrambled[spec] = rng.uniform(0, 360, size=len(scrambled))   # 予測をでたらめにしても
    assert ex.choose_example_windows(three_year_weather, scrambled) == experiment2["windows"]   # 期間は同じ


def test_example_windows_follow_the_declared_rule(three_year_weather, experiment2):
    weather = three_year_weather
    hour = pd.Timedelta(hours=1)
    speed = np.hypot(weather["u_ms"], weather["v_ms"])
    change_3h = np.hypot(weather["u_ms"] - weather["u_ms"].shift(3), weather["v_ms"] - weather["v_ms"].shift(3))
    targets = experiment2["forecasts"].loc[experiment2["forecasts"]["excluded"] == "", "target_time"]
    for start, end in experiment2["windows"].values():
        assert (end - start) == 47 * hour and start >= targets.min() and end <= targets.max()
    calm_start, calm_end = experiment2["windows"]["calm"]
    assert calm_start.hour == 1
    assert speed.loc[calm_start:calm_end].notna().all() and (speed.loc[calm_start:calm_end] > 0).all()
    assert speed.loc[calm_start:calm_end].mean() >= speed.loc[targets.min():targets.max()].median()
    abrupt_start, abrupt_end = experiment2["windows"]["abrupt"]
    middle = abrupt_start + 24 * hour
    assert change_3h.loc[middle] == change_3h.loc[targets.min() + 24 * hour:targets.max() - 23 * hour].max()
    assert change_3h.loc[middle] > change_3h.loc[calm_start:calm_end].max()


def with_wind_gaps(weather, every_hours=36):
    """every_hours 時間ごとに風が欠測したデータ。欠測のない48時間がなくなる。"""
    gappy = weather.copy()
    columns = [name for name in ["u_ms", "v_ms", "wind_speed_ms", "wind_direction_deg"] if name in gappy]
    gappy.loc[gappy.index[::every_hours], columns] = np.nan
    return gappy


def test_experiment2_continues_when_an_example_window_cannot_be_chosen(two_year_weather):
    """穏やかな期間を規則どおりに選べなくても、成績は計算し、その期間の例だけを理由を付けて省く。"""
    weather = with_wind_gaps(two_year_weather)
    split = wp.last_days_split(weather, test_days=120)
    result = ex.experiment_features(weather, split, "linear", horizon=3)
    assert result["windows"]["calm"] is None and "calm" not in result["examples"]
    assert "欠測" in result["window_notes"]["calm"]
    assert result["windows"]["abrupt"] is not None and "abrupt" in result["examples"]
    assert "abrupt" not in result["window_notes"]
    assert result["scores"]["mae_deg"].notna().all() and (result["scores"]["n_test"] > 0).all()


def test_no_example_window_when_the_period_is_shorter_than_the_window(three_year_weather, experiment2):
    short = experiment2["forecasts"].iloc[:30]
    assert (short["excluded"] == "").any()
    assert ex.choose_example_windows(three_year_weather, short) == {"calm": None, "abrupt": None}


def test_example_window_plots_forecasts_at_their_target_time(experiment2):
    for name, (start, end) in experiment2["windows"].items():
        window = experiment2["examples"][name]
        assert window["target_time"].between(start, end).all() and len(window) == 48
        assert (window["target_time"] - window["issue_time"] == pd.Timedelta(hours=3)).all()
        angle = (window["excluded"] == "") & window["target_direction_deg"].notna()
        for spec in experiment2["models"]:
            errors = window.loc[angle, f"{spec} error"]
            undefined = window.loc[angle, spec].isna()
            assert (errors[undefined] == 90.0).all() and errors.notna().all()


# ---------------------------------------------------------------------------
# 検証期間での選択と、実験3
# ---------------------------------------------------------------------------

def test_selection_on_validation_ignores_the_final_test_period(three_year_weather, split):
    candidates = ["linear", "boosting_shallow"]
    scores, chosen = wp.select_on_validation(three_year_weather, split, candidates, horizon=3)
    changed = three_year_weather.copy()
    changed.loc[changed.index >= split["test_start"], ["u_ms", "v_ms"]] *= -1     # 最終テスト期間だけ変える
    changed_scores, changed_chosen = wp.select_on_validation(changed, split, candidates, horizon=3)
    pd.testing.assert_frame_equal(scores, changed_scores)
    assert chosen == changed_chosen and scores["selected"].sum() == 1
    assert chosen == scores.loc[scores["mae_deg"].idxmin(), "candidate"]


def test_without_a_validation_period_the_simplest_setting_is_used(two_year_weather):
    split = wp.last_days_split(two_year_weather, test_days=120, validation_days=0)
    assert ex.select_integrated(two_year_weather, split) == (None, "linear")
    with pytest.raises(ValueError, match="検証期間"):
        wp.select_on_validation(two_year_weather, split)


def test_lags_and_max_horizon_reach_the_selection_and_every_experiment(three_year_weather, split, monkeypatch):
    calls = []
    original = wp.prepare_stage

    def recording(weather, horizon, split, stage="test", lags=wp.LAG_HOURS, max_horizon=wp.COMMON_MAX_HORIZON):
        calls.append((tuple(lags), max_horizon))
        return original(weather, horizon, split, stage, lags, max_horizon)

    monkeypatch.setattr(wp, "prepare_stage", recording)
    options = {"lags": (0, 1, 3), "max_horizon": 48}
    ex.select_integrated(three_year_weather, split, candidates=["linear"], **options)
    ex.experiment_angle(three_year_weather, split, methods=("linear",), **options)
    ex.experiment_features(three_year_weather, split, "linear", **options)
    result = ex.experiment_horizons(three_year_weather, split, "linear", [1, 48], **options)
    assert len(calls) == 5 and set(calls) == {((0, 1, 3), 48)}
    test_hours = (split["end"] - split["test_start"]) // pd.Timedelta(hours=1) + 1
    assert (result["scores"]["n_issue"] == test_hours - 48).all()   # 48時間先まで収まる予測起点


def test_experiment3_uses_common_issue_times_and_reports_counts(three_year_weather, split):
    result = ex.experiment_horizons(three_year_weather, split, "linear", [1, 24, 25, 72])
    assert result["models"] == ["linear:calendar+recent", "persistence", "climatology", "persistence_24h"]
    scores = result["scores"]
    assert scores["n_issue"].nunique() == 1 and scores["n_missing_input"].nunique() == 1
    assert list(result["counts"]["horizon_h"]) == [1, 24, 25, 72]
    counts = result["counts"]
    assert (counts["n_test"] + counts["n_calm_target"] + counts["n_missing_target"] + counts["n_missing_input"]
            == counts["n_issue"]).all()
    # 24時間・48時間…ちょうどの予測時間では、24時間周期の持続予報は持続予報と同じ（t の値を使う）
    at_24 = scores[scores["horizon_h"] == 24].set_index("model")
    assert at_24.loc["persistence_24h", "mae_deg"] == pytest.approx(at_24.loc["persistence", "mae_deg"])


# ---------------------------------------------------------------------------
# 実験4：ローレンツ系
# ---------------------------------------------------------------------------

def test_lorenz_experiment_is_dimensionless_and_checks_a_smaller_time_step():
    result = ex.experiment_lorenz(n_start_points=4, perturbation_sizes=(1e-8, 1e-6, 1e-4), n_steps=2500,
                                  benettin_steps=5000, check_dts=(0.01, 0.005))
    assert "not hours" in result["summary"]["time_unit"]
    steps = result["time_steps"]
    assert sorted(steps["dt"].unique()) == [0.005, 0.01]
    coarse = steps[steps["dt"] == 0.01].set_index("initial_error")["median_time"]
    fine = steps[steps["dt"] == 0.005].set_index("initial_error")["median_time"]
    assert np.allclose(coarse, fine, rtol=0.15)   # 刻みを半分にしても、ほぼ同じ
