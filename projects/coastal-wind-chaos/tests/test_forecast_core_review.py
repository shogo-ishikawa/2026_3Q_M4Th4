"""公開ラボの入力選択と時刻境界を、入力を壊す独立検査で確認する。"""

import numpy as np
import pandas as pd
import pytest

from coastal_wind_chaos import forecast_lab as lab
from coastal_wind_chaos import wind_pipeline as wp


@pytest.fixture
def weather():
    times = pd.date_range("2022-01-01", periods=24 * 150, freq="h")
    step = np.arange(len(times))
    u = 3 + np.sin(step / 11)
    v = -2 + np.cos(step / 7)
    table = pd.DataFrame({"u_ms": u, "v_ms": v, "wind_speed_ms": np.hypot(u, v),
                          "wind_direction_deg": wp.uv_to_direction(u, v),
                          "temperature_c": 15 + np.cos(step / 24)}, index=times)
    table.attrs["station"] = "公開試験観測点"
    return table


def arguments(**changes):
    settings = dict(horizons=(3,), candidates=("linear",),
                    validation_start="2022-03-01 09:00", test_start="2022-04-01 13:00")
    return {**settings, **changes}


def test_calendar_backtest_does_not_require_unused_temperature(weather):
    missing = weather.copy()
    missing.loc[missing.index >= "2022-03-01", "temperature_c"] = np.nan
    original = lab.run_backtest(weather, **arguments(feature_set="calendar", include_optional=False))
    changed = lab.run_backtest(missing, **arguments(feature_set="calendar", include_optional=True))
    pd.testing.assert_frame_equal(original["predictions"], changed["predictions"])
    assert not any("temperature" in name for name in changed["models"][3]["columns"])


def test_calendar_future_does_not_require_unused_past_wind_lag(weather):
    missing = weather.copy()
    # 現在の風と、3h先の24時間周期基準が参照する21h前は残す。
    missing.loc[missing.index[-7], ["u_ms", "v_ms", "wind_speed_ms"]] = np.nan
    missing.loc[missing.index[-1], "temperature_c"] = np.nan
    result = lab.forecast_future(missing, horizons=(3,), feature_set="calendar", include_optional=True)
    assert result["predictions"][["predicted_u_ms", "predicted_v_ms"]].notna().all().all()
    assert result["predictions"]["observed_speed_ms"].isna().all()


def test_recent_future_still_requires_its_missing_wind_history(weather):
    missing = weather.copy()
    missing.loc[missing.index[-7], "u_ms"] = np.nan
    with pytest.raises(ValueError, match="入力が不足"):
        lab.forecast_future(missing, horizons=(3,), feature_set="recent")


def test_explicit_end_discards_all_later_observations(weather):
    end = pd.Timestamp("2022-04-15 15:00")
    corrupted = weather.copy()
    corrupted.loc[corrupted.index > end, ["u_ms", "v_ms", "temperature_c", "wind_speed_ms"]] = 1000
    first = lab.run_backtest(weather, **arguments(end=end, include_optional=True))
    second = lab.run_backtest(corrupted, **arguments(end=end, include_optional=True))
    pd.testing.assert_frame_equal(first["predictions"], second["predictions"])
    assert first["predictions"]["target_time"].max() <= end
    assert first["validation_predictions"]["target_time"].max() < pd.Timestamp("2022-04-01 13:00")


def test_non_midnight_split_never_trains_on_the_first_test_answer(weather):
    settings = arguments(horizons=(1, 24, 72))
    result = lab.run_backtest(weather, **settings)
    boundary = pd.Timestamp(settings["test_start"])
    assert result["predictions"]["issue_time"].min() == boundary
    for bundle in result["models"].values():
        assert bundle["train_target_end"] < boundary
    assert result["validation_predictions"]["target_time"].lt(boundary).all()


def test_off_hour_cutoff_uses_latest_available_hour_and_records_both(weather):
    cutoff = pd.Timestamp("2022-04-20 04:37:12", tz="UTC")
    result = lab.forecast_future(weather, horizons=(3,), cutoff=cutoff)
    assert result["predictions"]["issue_time"].eq(pd.Timestamp("2022-04-20 13:00")).all()
    assert result["metadata"]["requested_cutoff"] == "2022-04-20T13:37:12"
    assert result["metadata"]["input_cutoff"] == "2022-04-20T13:00:00"
