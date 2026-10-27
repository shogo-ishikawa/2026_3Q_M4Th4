"""時刻の整合：欠けた時刻、年またぎ、うるう日、予測用の表の対応を確かめる。"""

import numpy as np
import pandas as pd
import pytest

from coastal_wind_chaos import sample_data
from coastal_wind_chaos import wind_pipeline as wp


def raw_table(times, u_values):
    """read_jma_csv の結果と同じ形の小さな表（風だけ）。u_values の符号で東風・西風を作る。"""
    speeds = np.abs(u_values)
    labels = np.where(np.asarray(u_values) >= 0, "西", "東")  # 西風は u > 0
    return pd.DataFrame({
        "wind_speed_ms": speeds,
        "wind_speed_ms_quality": 8,
        "wind_direction": labels.astype(object),
        "wind_direction_quality": 8,
    }, index=pd.DatetimeIndex(times, name="time"))


def test_make_hourly_times_covers_three_years_with_a_leap_day():
    times = sample_data.make_hourly_times("2023-01-01", 3)
    assert len(times) == (365 + 366 + 365) * 24
    assert times[0] == pd.Timestamp("2023-01-01 01:00")
    assert times[-1] == pd.Timestamp("2026-01-01 00:00")
    assert pd.Timestamp("2024-02-29 12:00") in times
    assert (np.diff(times.to_numpy()) == np.timedelta64(1, "h")).all()


def test_lag_and_target_follow_time_not_row_order():
    times = pd.date_range("2024-03-01 01:00", periods=12, freq=pd.Timedelta(hours=1))
    u_values = np.arange(1.0, 13.0)  # 値 = 時刻の番号（1, 2, ...）
    kept = [0, 1, 2, 3, 6, 7, 8, 9, 10, 11]  # 5時・6時の行がない
    weather = wp.prepare_weather(raw_table(times[kept], u_values[kept]))
    assert len(weather) == 12
    table = wp.make_forecast_table(weather, horizon=2, lags=(0, 1, 3))
    row = table.loc[pd.Timestamp("2024-03-01 08:00")]
    assert row["u_lag0"] == pytest.approx(8.0)
    assert row["u_lag1"] == pytest.approx(7.0)
    assert np.isnan(row["u_lag3"])  # 3時間前は5時で、欠けていた
    assert row["target_u"] == pytest.approx(10.0)
    assert row["target_time"] == pd.Timestamp("2024-03-01 10:00")
    # 欠けた時刻の直後でも「1行前」ではなく「1時間前」を使う
    after_gap = table.loc[pd.Timestamp("2024-03-01 07:00")]
    assert np.isnan(after_gap["u_lag1"])


def test_target_after_the_last_time_is_missing():
    times = pd.date_range("2024-03-01 01:00", periods=6, freq=pd.Timedelta(hours=1))
    weather = wp.prepare_weather(raw_table(times, np.arange(1.0, 7.0)))
    table = wp.make_forecast_table(weather, horizon=3)
    assert table["target_u"].isna().sum() == 3


def test_irregular_times_are_rejected():
    times = pd.DatetimeIndex(["2024-03-01 01:00", "2024-03-01 01:30"])
    with pytest.raises(ValueError, match="毎正時"):
        wp.to_hourly_index(raw_table(times, [1.0, 2.0]))
    weather = pd.DataFrame({"u_ms": [1.0, 2.0]}, index=pd.DatetimeIndex(["2024-03-01 01:00", "2024-03-01 03:00"]))
    with pytest.raises(ValueError, match="1時間刻み"):
        wp.make_forecast_table(weather, 1)


def test_year_fraction_handles_leap_years_and_new_year():
    times = pd.DatetimeIndex(["2023-12-31 23:00", "2024-01-01 00:00", "2024-12-31 23:00", "2025-01-01 00:00"])
    fraction = wp.year_fraction(times)
    assert fraction[0] == pytest.approx((364 + 23 / 24) / 365)
    assert fraction[1] == 0.0
    assert fraction[2] == pytest.approx((365 + 23 / 24) / 366)  # 2024年は366日
    assert fraction[3] == 0.0


def test_calendar_features_are_continuous_across_midnight_and_new_year():
    times = pd.date_range("2024-12-31 20:00", periods=8, freq=pd.Timedelta(hours=1))
    features = wp.calendar_features(times)
    steps = np.abs(np.diff(features.to_numpy(), axis=0))
    assert steps.max() < 0.6  # 23時→0時、12月31日→1月1日でも大きく飛ばない
    assert features.loc[pd.Timestamp("2025-01-01 00:00"), "hour_cos"] == pytest.approx(1.0)


def test_calendar_features_use_the_target_time():
    times = pd.date_range("2024-06-01 01:00", periods=48, freq=pd.Timedelta(hours=1))
    weather = wp.prepare_weather(raw_table(times, np.ones(48)))
    table = wp.make_forecast_table(weather, horizon=5)
    expected = wp.calendar_features(table["target_time"])
    np.testing.assert_allclose(table["hour_sin"].to_numpy(), expected["hour_sin"].to_numpy())
    assert (table["target_hour"].to_numpy() == (table.index.hour.to_numpy() + 5) % 24).all()
