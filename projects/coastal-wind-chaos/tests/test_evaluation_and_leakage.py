"""評価の計算と、未来の情報が学習・特徴量に入らないこと（リーク防止）を確かめる。"""

import warnings

import numpy as np
import pandas as pd
import pytest

from coastal_wind_chaos import sample_data
from coastal_wind_chaos import wind_pipeline as wp


def change_after(weather, cut):
    """cut より後の観測（風・風向・気温・気圧・日照）を、すべて別の値に変えた表。"""
    changed = weather.copy()
    future = changed.index > cut
    changed.loc[future, ["u_ms", "v_ms"]] = -changed.loc[future, ["u_ms", "v_ms"]] + 5.0
    changed.loc[future, "wind_direction_deg"] = wp.uv_to_direction(changed.loc[future, "u_ms"],
                                                                   changed.loc[future, "v_ms"])
    changed.loc[future, "temperature_c"] = 99.0
    changed.loc[future, "sea_level_pressure_hpa"] = 900.0
    changed.loc[future, "sunshine_h"] = 0.77
    return changed


def test_score_forecasts_uses_angular_error():
    forecasts = pd.DataFrame({"target_direction_deg": [0.0, 90.0, 350.0], "guess": [10.0, 90.0, 10.0]})
    scores = wp.score_forecasts(forecasts, ["guess"])
    assert scores.loc[0, "mae_deg"] == pytest.approx(10.0)  # 誤差は 10, 0, 20 度
    assert scores.loc[0, "within_45_pct"] == pytest.approx(100.0)
    assert scores.loc[0, "n_test"] == 3


def test_within_45_counts_errors_of_exactly_45_degrees():
    """16方位どうしのちょうど45度の差は、計算の丸め誤差があっても「45度以内」に数える。"""
    u, v = wp.wind_to_uv(3.0, 45.0)
    forecasts = pd.DataFrame({
        "target_direction_deg": [0.0, 0.0, 0.0, 337.5],
        "guess": [float(wp.uv_to_direction(u, v)), 45.0 + 1e-12, 45.5, 22.5],
    })
    scores = wp.score_forecasts(forecasts, ["guess"])
    assert scores.loc[0, "within_45_pct"] == pytest.approx(75.0)


def test_persistence_with_zero_lead_time_has_zero_error(two_year_weather):
    forecasts = wp.forecast_one_horizon(two_year_weather, 0, ["persistence"], test_start="2024-07-01")
    assert wp.angular_error(forecasts["target_direction_deg"], forecasts["persistence"]).max() < 1e-9


def test_persistence_repeats_the_direction_at_the_issue_time(two_year_weather):
    forecasts = wp.forecast_one_horizon(two_year_weather, 6, ["persistence"], test_start="2024-07-01 01:00")
    assert (forecasts["target_time"] - forecasts.index == pd.Timedelta(hours=6)).all()
    observed_then = two_year_weather.loc[forecasts.index, "wind_direction_deg"]
    assert wp.angular_error(observed_then, forecasts["persistence"]).max() < 1e-9


def test_split_keeps_training_targets_before_the_test_period(two_year_weather):
    test_start = pd.Timestamp("2024-07-01 01:00")
    table = wp.make_forecast_table(two_year_weather, 24)
    train, test = wp.split_train_test(table, test_start)
    assert train["target_time"].max() < test_start
    assert train.index.max() <= test_start - pd.Timedelta(hours=25)
    assert test.index.min() >= test_start


def test_features_do_not_change_when_the_future_changes(two_year_weather):
    """予測時刻より後の観測をすべて変えても、その予測時刻の特徴量は変わらない。"""
    cut = pd.Timestamp("2024-03-01 12:00")
    before = wp.make_forecast_table(two_year_weather, 6)
    after = wp.make_forecast_table(change_after(two_year_weather, cut), 6)
    features = [name for name in before.columns if not name.startswith("target_")]
    assert set(wp.CALENDAR_COLUMNS + wp.recent_columns(before)) <= set(features)
    assert "sunshine_now" in features and "issue_direction_deg" in features
    past = before.index <= cut
    pd.testing.assert_frame_equal(before.loc[past, features], after.loc[past, features])
    # 目的変数（6時間後の風）は変わる：未来の値は目的変数だけに入っている
    assert not np.allclose(before.loc[past, "target_u"].tail(6), after.loc[past, "target_u"].tail(6))


@pytest.mark.parametrize("horizon, lags", [(-1, (0, 1)), (3, (0, -2)), (1.5, (0, 1)), (3, (0, 0.5))])
def test_negative_or_fractional_hours_are_rejected(two_year_weather, horizon, lags):
    """負の予測時間や lags を使うと、予測時刻より後の観測が入力に入ってしまう。"""
    with pytest.raises(ValueError, match="0以上の整数"):
        wp.make_forecast_table(two_year_weather, horizon, lags)


def test_numpy_integers_are_accepted_as_hours(two_year_weather):
    table = wp.make_forecast_table(two_year_weather, np.int64(3), (0, np.int64(2)))
    assert "u_lag2" in table.columns


def test_climatology_uses_only_the_training_period(two_year_weather):
    test_start = pd.Timestamp("2024-07-01 01:00")
    changed = two_year_weather.copy()
    changed.loc[changed.index >= test_start, ["u_ms", "v_ms"]] = 50.0
    pd.testing.assert_frame_equal(wp.fit_climatology(two_year_weather, test_start),
                                  wp.fit_climatology(changed, test_start))


def test_climatology_forecast_ignores_the_test_period(two_year_weather):
    """テスト期間の観測を変えても、気候値予報（学習期間の平均）は変わらない。"""
    test_start = pd.Timestamp("2024-07-01 01:00")
    changed = two_year_weather.copy()
    changed.loc[changed.index >= test_start, ["u_ms", "v_ms"]] *= -1
    original = wp.forecast_one_horizon(two_year_weather, 6, ["climatology"], test_start)
    modified = wp.forecast_one_horizon(changed, 6, ["climatology"], test_start)
    pd.testing.assert_series_equal(original["climatology"], modified["climatology"])


def test_predictions_do_not_use_observations_after_the_issue_time(two_year_weather):
    """cut までに出した予測は、cut より後の観測（対象時刻の答えを含む）を変えても同じ。"""
    test_start = pd.Timestamp("2024-07-01 01:00")
    cut = pd.Timestamp("2024-10-01 00:00")
    models = ["persistence", "climatology", "linear:calendar+recent", "boosting:calendar+recent",
              "degrees_as_numbers"]
    original = wp.forecast_one_horizon(two_year_weather, 3, models, test_start)
    modified = wp.forecast_one_horizon(change_after(two_year_weather, cut), 3, models, test_start)
    issued_by_cut = original.index[original.index <= cut]
    # 対象時刻が cut より後の行（答えが変わった行）も比べる。答えを読む予測なら、ここで違いが出る。
    answer_changed = issued_by_cut[original.loc[issued_by_cut, "target_time"] > cut]
    assert len(answer_changed) > 0
    assert not np.allclose(original.loc[answer_changed, "target_direction_deg"],
                           modified.loc[answer_changed, "target_direction_deg"])
    pd.testing.assert_frame_equal(original.loc[issued_by_cut, models], modified.loc[issued_by_cut, models])


def test_optional_inputs_are_chosen_from_the_training_part_only(two_year_weather):
    """学習期間の大半で欠けている気温は、テスト期間にあっても使わない（列がない場合と同じ予測）。"""
    test_start = pd.Timestamp("2024-01-01 01:00")
    changed = two_year_weather.copy()
    changed.loc[changed.index < pd.Timestamp("2023-10-01"), "temperature_c"] = np.nan
    models = ["linear:calendar+recent"]
    with_column = wp.forecast_one_horizon(changed, 6, models, test_start)
    without_column = wp.forecast_one_horizon(changed.drop(columns=["temperature_c"]), 6, models, test_start)
    pd.testing.assert_frame_equal(with_column, without_column)


def test_warns_when_a_missing_optional_input_removes_test_rows(two_year_weather):
    """学習期間にあった気温がテスト期間の途中から欠けると、評価する時刻が減ることを知らせる。"""
    changed = two_year_weather.copy()
    changed.loc[changed.index >= pd.Timestamp("2024-10-01"), "temperature_c"] = np.nan
    with pytest.warns(UserWarning, match="評価から外しました"):
        forecasts = wp.forecast_one_horizon(changed, 1, ["persistence"], test_start="2024-07-01 01:00")
    assert forecasts.index.max() < pd.Timestamp("2024-10-01")
    with warnings.catch_warnings():
        warnings.filterwarnings("error", message=".*評価から外しました")
        wp.forecast_one_horizon(two_year_weather, 1, ["persistence"], test_start="2024-07-01 01:00")


def test_too_little_training_data_is_explained():
    weather = sample_data.generate_weather("periodic_only", years=1, seed=3)
    with pytest.raises(ValueError, match="学習用のデータが .*test_days を短く"):
        wp.forecast_one_horizon(weather, 1, ["persistence"], wp.default_test_start(weather, 350))


def test_training_period_forecasts_cover_only_the_training_rows(two_year_weather):
    test_start = pd.Timestamp("2024-07-01 01:00")
    models = ["persistence", "linear:calendar+recent"]
    in_sample = wp.forecast_training_period(two_year_weather, 6, models, test_start)
    assert in_sample["target_time"].max() < test_start
    assert len(in_sample) > 300 * 24
    assert in_sample[models].notna().all().all()


def test_boosting_does_not_use_a_random_internal_validation_split():
    model = wp.make_regressor("boosting")
    assert model.estimator.early_stopping is False


def test_all_methods_are_scored_on_the_same_rows(two_year_weather):
    scores = wp.run_horizon_experiment(two_year_weather, [1, 12], wp.DEFAULT_MODELS, test_start="2024-07-01 01:00")
    assert set(scores["model"]) == set(wp.DEFAULT_MODELS)
    assert scores.groupby("horizon_h")["n_test"].nunique().eq(1).all()
    assert scores["mae_deg"].between(0, 180).all()


def test_degrees_as_numbers_is_worse_than_wind_components(two_year_weather):
    """0度と360度の境界を無視した悪い例は、u, v で予測する方法より大きく外れる。"""
    forecasts = wp.forecast_one_horizon(two_year_weather, 6, ["linear:calendar+recent", "degrees_as_numbers"],
                                        test_start="2024-07-01 01:00")
    hourly = wp.error_by_hour(forecasts, ["linear:calendar+recent", "degrees_as_numbers"])
    assert len(hourly) == 24
    night = hourly.loc[[0, 1, 2, 3]]
    assert (night["degrees_as_numbers"] > night["linear:calendar+recent"] + 20).all()


def test_climatology_fills_months_missing_from_training():
    times = pd.date_range("2024-01-01 01:00", "2024-02-29 23:00", freq=pd.Timedelta(hours=1))
    weather = pd.DataFrame({"u_ms": 1.0, "v_ms": -1.0}, index=times)
    climatology = wp.fit_climatology(weather, "2024-03-01")
    u, v = wp.predict_climatology(climatology, pd.DatetimeIndex(["2024-07-01 12:00"]))
    assert u[0] == pytest.approx(1.0) and v[0] == pytest.approx(-1.0)


def test_unknown_model_and_feature_set_are_reported(two_year_weather):
    with pytest.raises(ValueError, match="未知の手法"):
        wp.forecast_one_horizon(two_year_weather, 1, ["magic"], test_start="2024-07-01 01:00")
    with pytest.raises(ValueError, match="未知の特徴量"):
        wp.forecast_one_horizon(two_year_weather, 1, ["linear:everything"], test_start="2024-07-01 01:00")
