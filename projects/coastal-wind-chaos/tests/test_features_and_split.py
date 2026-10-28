"""追加した特徴量・24時間周期の持続予報・時間分割・評価の数え方が、未来の情報を使わないことを確かめる。"""

import numpy as np
import pandas as pd
import pytest

from coastal_wind_chaos import wind_pipeline as wp

HOUR = pd.Timedelta(hours=1)


def change_after(weather, cut):
    """cut より後の観測（風・風向・気温・気圧・日照）をすべて別の値に変えた表。"""
    changed = weather.copy()
    future = changed.index > cut
    changed.loc[future, ["u_ms", "v_ms"]] = -changed.loc[future, ["u_ms", "v_ms"]] + 5.0
    changed.loc[future, "wind_direction_deg"] = wp.uv_to_direction(changed.loc[future, "u_ms"],
                                                                   changed.loc[future, "v_ms"])
    changed.loc[future, "temperature_c"] = 99.0
    changed.loc[future, "sea_level_pressure_hpa"] = 900.0
    changed.loc[future, "sunshine_h"] = 0.77
    return changed


# ---------------------------------------------------------------------------
# 24時間周期の持続予報
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("horizon, lag", [(0, 0), (1, 23), (3, 21), (23, 1), (24, 0), (25, 23), (47, 1),
                                          (48, 0), (49, 23), (72, 0)])
def test_cycle_lag_is_never_in_the_future(horizon, lag):
    assert wp.cycle_lag(horizon) == lag
    assert 0 <= wp.cycle_lag(horizon) <= 23


@pytest.mark.parametrize("horizon", [1, 25, 48, 72])
def test_repeat_24h_uses_the_same_hour_at_or_before_the_issue_time(two_year_weather, horizon):
    table = wp.make_forecast_table(two_year_weather, horizon)
    issue = pd.Timestamp("2024-03-10 05:00")
    source = issue + pd.Timedelta(hours=horizon - 24 * int(np.ceil(horizon / 24)))  # t + h − 24⌈h/24⌉
    assert source <= issue
    assert source.hour == table.loc[issue, "target_time"].hour
    assert table.loc[issue, "u_cycle24"] == two_year_weather.loc[source, "u_ms"]
    assert table.loc[issue, "v_cycle24"] == two_year_weather.loc[source, "v_ms"]


@pytest.mark.parametrize("horizon", [25, 48, 72])
def test_repeat_24h_does_not_change_when_the_future_changes(two_year_weather, horizon):
    cut = pd.Timestamp("2024-09-01 00:00")
    original = wp.forecast_one_horizon(two_year_weather, horizon, ["persistence_24h"], "2024-07-01 01:00")
    modified = wp.forecast_one_horizon(change_after(two_year_weather, cut), horizon, ["persistence_24h"],
                                       "2024-07-01 01:00")
    issued = original.index[original.index <= cut]
    assert (original.loc[issued, "target_time"] > cut).any()  # 答えが変わる行も含めて比べる
    columns = ["persistence_24h", "persistence_24h__u", "persistence_24h__v"]
    pd.testing.assert_frame_equal(original.loc[issued, columns], modified.loc[issued, columns])


# ---------------------------------------------------------------------------
# 追加した特徴量
# ---------------------------------------------------------------------------

def test_new_features_do_not_change_when_the_future_changes(two_year_weather):
    cut = pd.Timestamp("2024-03-01 12:00")
    before = wp.make_forecast_table(two_year_weather, 30)
    after = wp.make_forecast_table(change_after(two_year_weather, cut), 30)
    new_columns = ["u_mean24", "v_mean24", "u_cycle24", "v_cycle24", "u_change_1h", "v_change_1h", "u_change_3h",
                   "v_change_3h", "temperature_lag1", "temperature_lag6", "temperature_change_1h",
                   "temperature_change_24h", "pressure_change_1h", "sunshine_now", "sunshine_today"]
    assert set(new_columns) <= set(before.columns)
    features = [name for name in before.columns if not name.startswith("target_")]
    past = before.index <= cut
    pd.testing.assert_frame_equal(before.loc[past, features], after.loc[past, features])


def test_past_24h_mean_and_changes_are_computed_up_to_the_issue_time(two_year_weather):
    table = wp.make_forecast_table(two_year_weather, 6)
    issue = pd.Timestamp("2024-05-20 15:00")
    window = two_year_weather.loc[issue - 23 * HOUR:issue]
    assert len(window) == 24
    assert table.loc[issue, "u_mean24"] == pytest.approx(window["u_ms"].mean())
    assert table.loc[issue, "v_mean24"] == pytest.approx(window["v_ms"].mean())
    temperature = two_year_weather["temperature_c"]
    assert table.loc[issue, "temperature_change_24h"] == pytest.approx(temperature[issue] - temperature[issue - 24 * HOUR])
    assert table.loc[issue, "temperature_lag3"] == temperature[issue - 3 * HOUR]
    assert table.loc[issue, "temperature_change_1h"] == pytest.approx(temperature[issue] - temperature[issue - HOUR])
    pressure = two_year_weather["sea_level_pressure_hpa"]
    assert table.loc[issue, "pressure_change_1h"] == pytest.approx(pressure[issue] - pressure[issue - HOUR])
    u, v = two_year_weather["u_ms"], two_year_weather["v_ms"]
    assert table.loc[issue, "u_change_1h"] == pytest.approx(u[issue] - u[issue - HOUR])
    assert table.loc[issue, "v_change_1h"] == pytest.approx(v[issue] - v[issue - HOUR])
    assert table.loc[issue, "u_change_3h"] == pytest.approx(u[issue] - u[issue - 3 * HOUR])
    assert table.loc[issue, "v_change_3h"] == pytest.approx(v[issue] - v[issue - 3 * HOUR])


def test_wind_changes_follow_the_lags(two_year_weather):
    """u, v の変化は、lags にその「何時間前」があるときだけ作る（使わない過去の値が、変化を通して入らない）。"""
    changes = {"u_change_1h", "v_change_1h", "u_change_3h", "v_change_3h"}
    assert changes <= set(wp.make_forecast_table(two_year_weather, 3).columns)
    assert not changes & set(wp.make_forecast_table(two_year_weather, 3, lags=(0,)).columns)
    split = wp.last_days_split(two_year_weather, test_days=120)
    recent = wp.prepare_stage(two_year_weather, 3, split, lags=(0, 1))["recent"]
    assert {"u_change_1h", "v_change_1h"} <= set(recent) and not {"u_change_3h", "v_change_3h"} & set(recent)


def test_past_24h_mean_is_missing_when_an_hour_is_missing(two_year_weather):
    weather = two_year_weather.copy()
    gap = pd.Timestamp("2024-05-20 03:00")
    weather.loc[gap, ["u_ms", "v_ms"]] = np.nan
    table = wp.make_forecast_table(weather, 1)
    assert table.loc[gap:gap + 23 * HOUR, "u_mean24"].isna().all()  # 欠けた1時間を含む24時間
    assert table.loc[gap + 24 * HOUR, "u_mean24"] == pytest.approx(weather.loc[gap + HOUR:gap + 24 * HOUR, "u_ms"].mean())


def test_sunshine_today_is_the_running_total_of_the_day_and_differs_from_the_hour():
    times = pd.date_range("2024-06-01 01:00", periods=48, freq=HOUR)
    sunshine = np.zeros(48)
    sunshine[8:12] = [0.2, 0.5, 1.0, 1.0]   # 9時〜12時
    sunshine[23] = 0.0                      # 翌日0時（＝6月1日の24時）
    sunshine[33] = 0.4                      # 6月2日10時
    sunshine[36] = np.nan                   # 6月2日13時が欠測
    total = wp.day_cumulative(sunshine, times)
    assert total[11] == pytest.approx(2.7)                    # 6月1日12時までの合計
    assert total[23] == pytest.approx(2.7)                    # 24時（翌日0時の行）は6月1日に数える
    assert total[24] == 0.0                                   # 6月2日1時から数え直す
    assert total[33] == pytest.approx(0.4)
    assert np.isnan(total[36]) and np.isnan(total[40])        # 欠測より後は、その日のうちは欠損
    assert total[11] != sunshine[11]                          # その1時間の日照とは別の量


# ---------------------------------------------------------------------------
# 時間分割と、段階ごとの気候値・使う列
# ---------------------------------------------------------------------------

def test_year_split_uses_calendar_years(three_year_weather):
    split = wp.year_split(three_year_weather)
    assert split["start"] == pd.Timestamp("2023-01-01 01:00")
    assert split["validation_start"] == pd.Timestamp("2024-01-01 01:00")
    assert split["test_start"] == pd.Timestamp("2025-01-01 01:00")
    assert split["end"] == pd.Timestamp("2026-01-01 00:00")


def test_year_split_needs_about_three_years(two_year_weather):
    with pytest.raises(ValueError, match="last_days"):
        wp.year_split(two_year_weather)
    split = wp.make_split(two_year_weather, "last_days", test_days=120, validation_days=90)
    assert split["validation_start"] == split["test_start"] - pd.Timedelta(days=90)
    assert wp.make_split(two_year_weather, "last_days", 120, 0)["validation_start"] is None
    with pytest.raises(ValueError, match="未知の分割"):
        wp.make_split(two_year_weather, "random")


@pytest.mark.parametrize("stage", ["validation", "test"])
def test_rows_never_cross_the_stage_boundaries(three_year_weather, stage):
    split = wp.year_split(three_year_weather)
    for horizon in [1, 24, 72]:
        data = wp.prepare_stage(three_year_weather, horizon, split, stage)
        train_start, train_end, eval_start, eval_end = data["bounds"]
        assert data["train"]["target_time"].max() < train_end         # 学習の答えは次の期間に入らない
        assert data["train"].index.min() >= train_start
        evaluation = data["evaluation"]
        assert evaluation.index.min() >= eval_start
        assert (evaluation.index + pd.Timedelta(hours=72)).max() < eval_end   # 72時間先まで期間内
        assert evaluation["target_time"].max() < eval_end              # 検証の答えは最終テスト期間に入らない
    if stage == "validation":
        assert data["bounds"][3] == split["test_start"]


def test_issue_times_are_the_same_for_every_lead_time(three_year_weather):
    split = wp.year_split(three_year_weather)
    indexes = [wp.forecast_stage(three_year_weather, horizon, ["persistence"], split).index for horizon in [1, 25, 72]]
    assert indexes[0].equals(indexes[1]) and indexes[0].equals(indexes[2])


@pytest.mark.parametrize("stage", ["validation", "test"])
def test_climatology_input_uses_only_the_stage_training_period(three_year_weather, stage):
    split = wp.year_split(three_year_weather)
    _, train_end, _, _ = wp.stage_bounds(split, stage)
    later = three_year_weather.copy()
    later.loc[later.index >= train_end, ["u_ms", "v_ms"]] = 40.0         # 評価期間以降を変える
    earlier = three_year_weather.copy()
    earlier.loc[earlier.index < train_end, ["u_ms", "v_ms"]] += 3.0      # 学習期間を変える
    base = wp.prepare_stage(three_year_weather, 6, split, stage)["evaluation"]
    for weather, should_change in [(later, False), (earlier, True)]:
        evaluation = wp.prepare_stage(weather, 6, split, stage)["evaluation"]
        same = np.allclose(base["clim_u"], evaluation["clim_u"]) and np.allclose(base["clim_v"], evaluation["clim_v"])
        assert same != should_change


def test_climatology_baseline_and_climatology_input_have_the_same_source(three_year_weather):
    split = wp.year_split(three_year_weather)
    forecasts = wp.forecast_stage(three_year_weather, 6, ["climatology"], split)
    data = wp.prepare_stage(three_year_weather, 6, split)
    used = forecasts["excluded"] == ""
    np.testing.assert_allclose(forecasts.loc[used, "climatology__u"], data["evaluation"].loc[used, "clim_u"])
    assert {"clim_u", "clim_v"} <= set(wp.feature_columns("calendar", data["recent"]))
    assert not {"clim_u", "clim_v"} & set(wp.feature_columns("recent", data["recent"]))


def test_feature_set_aliases_follow_the_original_names():
    recent = ["u_lag0", "v_lag0"]
    assert wp.feature_columns("global_only", recent) == wp.feature_columns("calendar", recent)
    assert wp.feature_columns("local_only", recent) == recent
    assert wp.feature_columns("combined", recent) == wp.feature_columns("calendar+recent", recent)
    assert wp.parse_model("linear:combined") == ("linear", "calendar+recent")


def test_basic_experiment_runs_without_pressure_and_sunshine(two_year_weather):
    weather = two_year_weather.drop(columns=["sea_level_pressure_hpa", "sunshine_h", "temperature_c"])
    forecasts = wp.forecast_one_horizon(weather, 3, wp.DEFAULT_MODELS, "2024-07-01 01:00")
    scores = wp.score_forecasts(forecasts, wp.DEFAULT_MODELS)
    assert scores["mae_deg"].between(0, 180).all()


def test_input_column_table_shows_unused_and_missing_inputs(two_year_weather):
    weather = two_year_weather.drop(columns=["sea_level_pressure_hpa", "sunshine_h"])
    split = wp.last_days_split(weather, test_days=120)
    stage = wp.prepare_stage(weather, 3, split)
    columns = wp.input_column_table(stage).set_index("column")
    assert not columns.loc["pressure_now", "used"] and pd.isna(columns.loc["pressure_now", "n_missing"])
    assert not columns.loc["sunshine_today", "used"] and pd.isna(columns.loc["sunshine_today", "n_missing"])
    assert columns.loc["temperature_now", "used"] and columns.loc["u_lag0", "used"]
    used = columns[columns["used"]]
    assert list(used.index) == stage["inputs"]
    assert used["n_missing"].astype(int).to_dict() == stage["evaluation"][stage["inputs"]].isna().sum().to_dict()


# ---------------------------------------------------------------------------
# 評価の数え方：静穏、予測ゼロ、ベクトルRMSE、共通の評価対象
# ---------------------------------------------------------------------------

def hand_made_forecasts():
    """手で作った4行：北風、静穏、西風（予測の向きが決まらない）、対象時刻の欠測。"""
    times = pd.date_range("2024-01-01 01:00", periods=4, freq=HOUR, name="issue_time")
    u10, v10 = wp.wind_to_uv(2.0, 10.0)
    return pd.DataFrame({
        "target_time": times + 3 * HOUR,
        "target_hour": (times + 3 * HOUR).hour,
        "target_u": [0.0, 0.0, 1.0, np.nan],
        "target_v": [-2.0, 0.0, 0.0, np.nan],
        "target_direction_deg": [0.0, np.nan, 270.0, np.nan],
        "excluded": ["", "", "", wp.EXCLUDED_TARGET],
        "vector_model": [10.0, 45.0, np.nan, np.nan],
        "vector_model__u": [u10, 0.5, 0.0, np.nan],
        "vector_model__v": [v10, 0.5, 0.0, np.nan],
        "angle_model": [30.0, 200.0, 300.0, np.nan],
    }, index=times)


def test_calm_targets_count_for_the_vector_error_but_not_for_the_angle():
    scores = wp.score_forecasts(hand_made_forecasts(), ["vector_model", "angle_model"]).set_index("model")
    vector = scores.loc["vector_model"]
    assert vector["n_test"] == 2 and vector["n_vector"] == 3 and vector["n_issue"] == 4
    assert vector["n_calm_target"] == 1 and vector["n_missing_target"] == 1
    # 向きの決まらない予測（0ベクトル）は90度として数え、件数も示す
    assert vector["mae_deg"] == pytest.approx((10.0 + 90.0) / 2)
    assert vector["within_45_pct"] == pytest.approx(50.0)
    assert vector["n_undefined"] == 1 and vector["undefined_pct"] == pytest.approx(50.0)
    u10, v10 = wp.wind_to_uv(2.0, 10.0)
    squared = [(u10 - 0.0) ** 2 + (v10 + 2.0) ** 2, 0.5**2 + 0.5**2, 1.0**2]
    assert vector["vector_rmse_ms"] == pytest.approx(np.sqrt(np.mean(squared)))
    angle = scores.loc["angle_model"]
    assert np.isnan(angle["vector_rmse_ms"])  # 風向だけの予測は、ベクトルの評価の対象外
    assert angle["mae_deg"] == pytest.approx((30.0 + 30.0) / 2)


def test_zero_prediction_from_a_calm_issue_time_is_counted_not_dropped(three_year_weather):
    split = wp.year_split(three_year_weather)
    forecasts = wp.forecast_stage(three_year_weather, 3, ["persistence", "linear:calendar+recent"], split)
    scores = wp.score_forecasts(forecasts, ["persistence", "linear:calendar+recent"]).set_index("model")
    used = forecasts["excluded"] == ""
    calm_issue = used & (forecasts["persistence__u"] == 0) & (forecasts["persistence__v"] == 0)
    assert calm_issue.sum() > 0
    assert scores.loc["persistence", "n_undefined"] == (calm_issue & forecasts["target_direction_deg"].notna()).sum()
    assert scores["n_test"].nunique() == 1   # 予測起点が静穏の行も、すべての手法で同じように評価する


def test_undefined_direction_rule_matches_a_random_guess():
    assert wp.UNDEFINED_DIRECTION_ERROR_DEG == wp.RANDOM_DIRECTION_EXPECTED_ERROR_DEG == 90.0
