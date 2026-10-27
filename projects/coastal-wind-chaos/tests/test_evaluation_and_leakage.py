"""評価の計算と、未来の情報が学習・特徴量に入らないこと（リーク防止）を確かめる。"""

import numpy as np
import pandas as pd
import pytest

from coastal_wind_chaos import wind_pipeline as wp


def test_score_forecasts_uses_angular_error():
    forecasts = pd.DataFrame({"target_direction_deg": [0.0, 90.0, 350.0], "guess": [10.0, 90.0, 10.0]})
    scores = wp.score_forecasts(forecasts, ["guess"])
    assert scores.loc[0, "mae_deg"] == pytest.approx(10.0)  # 誤差は 10, 0, 20 度
    assert scores.loc[0, "within_45_pct"] == pytest.approx(100.0)
    assert scores.loc[0, "n_test"] == 3


def test_persistence_with_zero_lead_time_has_zero_error(two_year_weather):
    forecasts = wp.forecast_one_horizon(two_year_weather, 0, ["persistence"], test_start="2024-07-01")
    assert wp.angular_error(forecasts["target_direction_deg"], forecasts["persistence"]).max() < 1e-9


def test_split_keeps_training_targets_before_the_test_period(two_year_weather):
    test_start = pd.Timestamp("2024-07-01 01:00")
    table = wp.make_forecast_table(two_year_weather, 24)
    train, test = wp.split_train_test(table, test_start)
    assert train["target_time"].max() < test_start
    assert train.index.max() <= test_start - pd.Timedelta(hours=25)
    assert test.index.min() >= test_start


def test_features_do_not_change_when_the_future_changes(two_year_weather):
    cut = pd.Timestamp("2024-03-01 12:00")
    changed = two_year_weather.copy()
    future = changed.index > cut
    changed.loc[future, ["u_ms", "v_ms"]] = -changed.loc[future, ["u_ms", "v_ms"]] + 5.0
    changed.loc[future, "temperature_c"] = 99.0
    changed.loc[future, "sea_level_pressure_hpa"] = 900.0
    before = wp.make_forecast_table(two_year_weather, 6)
    after = wp.make_forecast_table(changed, 6)
    feature_columns = wp.CALENDAR_COLUMNS + wp.recent_columns(before)
    past_rows = before.index <= cut
    pd.testing.assert_frame_equal(before.loc[past_rows, feature_columns], after.loc[past_rows, feature_columns])
    # 目的変数（6時間後の風）は変わる：未来の値は目的変数だけに入っている
    assert not np.allclose(before.loc[past_rows, "target_u"].tail(6), after.loc[past_rows, "target_u"].tail(6))


def test_climatology_uses_only_the_training_period(two_year_weather):
    test_start = pd.Timestamp("2024-07-01 01:00")
    changed = two_year_weather.copy()
    changed.loc[changed.index >= test_start, ["u_ms", "v_ms"]] = 50.0
    pd.testing.assert_frame_equal(wp.fit_climatology(two_year_weather, test_start),
                                  wp.fit_climatology(changed, test_start))


def test_predictions_do_not_use_observations_after_the_issue_time(two_year_weather):
    test_start = pd.Timestamp("2024-07-01 01:00")
    cut = pd.Timestamp("2024-10-01 00:00")
    models = ["persistence", "climatology", "linear:calendar+recent", "boosting:calendar+recent"]
    changed = two_year_weather.copy()
    changed.loc[changed.index > cut, ["u_ms", "v_ms"]] *= -1
    original = wp.forecast_one_horizon(two_year_weather, 3, models, test_start)
    modified = wp.forecast_one_horizon(changed, 3, models, test_start)
    issued_before_cut = original.index[original.index <= cut - pd.Timedelta(hours=3)]
    pd.testing.assert_frame_equal(original.loc[issued_before_cut, models], modified.loc[issued_before_cut, models])


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
