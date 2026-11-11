"""誤差の定義、時刻の照合、日単位の不確かさを小さな既知の値で確認する。"""

import numpy as np
import pandas as pd
import pytest

from coastal_wind_chaos import forecast_diagnostics as diagnostics
from coastal_wind_chaos.wind_pipeline import wind_to_uv


def prediction_rows(observed, predicted, *, model="linear:calendar+recent", times=None, directions=None):
    n = len(observed)
    times = pd.date_range("2025-01-01", periods=n, freq="h") if times is None else pd.DatetimeIndex(times)
    directions = np.zeros(n) if directions is None else np.asarray(directions)
    observed_u, observed_v = wind_to_uv(observed, directions)
    predicted_u, predicted_v = wind_to_uv(predicted, directions)
    return pd.DataFrame({"station": "test", "model": model, "horizon_h": 3,
                         "issue_time": times, "target_time": times + pd.Timedelta(hours=3),
                         "observed_u_ms": observed_u, "observed_v_ms": observed_v,
                         "predicted_u_ms": predicted_u, "predicted_v_ms": predicted_v,
                         "observed_speed_ms": observed, "excluded": ""})


def test_hand_computed_speed_scores_and_bias_sign():
    data = prediction_rows([1, 2, 4], [2, 0, 5])
    summary = diagnostics.summarise_errors(data).iloc[0]
    assert summary.speed_mae_ms == pytest.approx(4 / 3)
    assert summary.speed_rmse_ms == pytest.approx(np.sqrt(2))
    assert summary.speed_bias_ms == pytest.approx(0)  # (+1 -2 +1) / 3
    assert summary.vector_rmse_ms == pytest.approx(np.sqrt(2))
    assert summary.n_speed == summary.n_vector == summary.n_direction == 3
    assert summary.n_undefined_direction == 1
    assert summary.direction_mae_deg == pytest.approx(30)  # zero vector counts as 90 degrees
    assert summary.within_45_pct == pytest.approx(200 / 3)


def test_circle_wrap_calm_native_speed_and_undefined_prediction():
    data = prediction_rows([2, 2, .1], [3, 0, 0], directions=[350, 0, 0])
    u, v = wind_to_uv([3], [10])
    data.loc[0, ["predicted_u_ms", "predicted_v_ms"]] = [u[0], v[0]]
    data.loc[2, ["observed_u_ms", "observed_v_ms"]] = 0  # quiet source keeps native .1 m/s
    result = diagnostics.add_errors(data)
    assert result.direction_absolute_error_deg.iloc[0] == pytest.approx(20)
    assert result.direction_absolute_error_deg.iloc[1] == 90
    assert np.isnan(result.direction_absolute_error_deg.iloc[2])
    assert result.speed_absolute_error_ms.iloc[2] == .1
    assert diagnostics.summarise_errors(data).iloc[0].n_calm == 1
    assert diagnostics.summarise_errors(data).iloc[0].n_direction == 2
    assert result.undefined_direction.tolist() == [False, True, False]
    assert "speed_error_ms" not in data  # do not mutate callers' tables


def test_native_predicted_speed_preserves_calm_speed_without_changing_vector_metrics():
    data = prediction_rows([.1, 2], [0, 0])
    data.loc[0, ["observed_u_ms", "observed_v_ms"]] = 0
    data["predicted_speed_ms"] = [.1, .1]
    result = diagnostics.add_errors(data)
    assert result.predicted_speed_ms.tolist() == [.1, .1]
    assert result.speed_error_ms.tolist() == [0, -1.9]
    summary = diagnostics.summarise_errors(data).iloc[0]
    assert summary.speed_mae_ms == pytest.approx(.95)
    assert summary.vector_rmse_ms == pytest.approx(np.sqrt(2))
    assert summary.n_direction == 1
    assert summary.direction_mae_deg == 90
    assert summary.n_calm == 1


def test_missing_invalid_native_predicted_speeds_fall_back_to_vector_magnitude():
    data = prediction_rows([2] * 4, [3, 4, 5, 6])
    data["predicted_speed_ms"] = [np.nan, -1, np.inf, 7]
    result = diagnostics.add_errors(data)
    assert result.predicted_speed_ms.tolist() == [3, 4, 5, 7]
    assert result.speed_error_ms.tolist() == [1, 2, 3, 5]


def test_native_speed_can_be_scored_when_direction_is_missing():
    data = prediction_rows([2], [3])
    data[["observed_u_ms", "observed_v_ms", "predicted_u_ms", "predicted_v_ms"]] = np.nan
    data["predicted_speed_ms"] = 3
    row = diagnostics.summarise_errors(data).iloc[0]
    assert row.n_speed == 1
    assert row.n_direction == row.n_vector == 0
    assert row.speed_mae_ms == 1


def test_future_and_excluded_rows_have_no_fake_scores():
    data = prediction_rows([1, 2, 3], [2, 3, 4])
    data.loc[0, "excluded"] = "missing_input"
    data.loc[1:, ["observed_u_ms", "observed_v_ms", "observed_speed_ms"]] = np.nan
    summary = diagnostics.summarise_errors(data).iloc[0]
    assert summary.n_rows == 3
    assert summary.n_speed == summary.n_direction == summary.n_vector == 0
    assert summary.n_excluded == 1
    assert summary.n_missing_observation == 2
    assert np.isnan(summary.speed_mae_ms)
    assert np.isnan(summary.direction_mae_deg)
    assert not diagnostics.add_errors(data).speed_evaluated.any()


def test_empty_tables_keep_the_export_schema():
    data = prediction_rows([], [])
    assert diagnostics.summarise_errors(data).columns.tolist() == diagnostics.SUMMARY_COLUMNS
    assert diagnostics.skill_against_baseline(data).columns.tolist() == diagnostics.SKILL_COLUMNS
    assert "month" in diagnostics.grouped_errors(data).columns


def test_nonfinite_predictions_and_missing_observations_are_not_scored():
    data = prediction_rows([1, 2, 3, 4], [2, 3, 4, 5])
    data.loc[0, "predicted_u_ms"] = np.inf
    data.loc[1, ["observed_u_ms", "observed_v_ms", "observed_speed_ms"]] = np.nan
    data.loc[2, "excluded"] = "missing_input"
    summary = diagnostics.summarise_errors(data).iloc[0]
    assert summary.n_speed == 1
    assert summary.n_missing_prediction == 1
    assert summary.n_missing_observation == 1
    assert summary.speed_mae_ms == 1


def test_grouped_errors_use_target_time_and_preserve_horizons():
    data = prediction_rows([1, 3, 8, 12, 0], [2, 4, 10, 8, 0],
                           times=["2025-01-31 22:00", "2025-02-01 00:00", "2025-02-01 01:00",
                                  "2025-02-01 02:00", "2025-02-01 03:00"],
                           directions=[0, 90, 180, 270, 0])
    data.loc[0, "horizon_h"] = 1
    # target_time remains Feb 1 for all rows, even though one issue time is Jan 31.
    month = diagnostics.grouped_errors(data, by="month")
    assert month.month.tolist() == [2, 2]
    assert set(month.horizon_h) == {1, 3}
    assert month.n_speed.sum() == 5
    bands = diagnostics.grouped_errors(data, by="speed_band")
    assert set(bands.speed_band) == {"0–2", "2–5", "5–10", "10+"}
    directions = diagnostics.grouped_errors(data, by="direction")
    assert set(directions.direction) == {"N", "E", "S", "W", "calm_or_missing"}
    with pytest.raises(ValueError, match="by"):
        diagnostics.grouped_errors(data, by="year")


def test_baseline_comparison_uses_paired_rows_only():
    reference = prediction_rows([2, 2, 2], [3, 4, 102], model="persistence")
    candidate = prediction_rows([2, 2, 2], [2, 3, 2])
    candidate.loc[2, "excluded"] = "missing_input"
    skill = diagnostics.skill_against_baseline(pd.concat([reference, candidate]), n_bootstrap=0).iloc[0]
    assert skill.n_pairs == 2
    assert skill.model_mae_ms == .5
    assert skill.baseline_mae_ms == 1.5  # excluded 100 m/s error cannot improve candidate's score
    assert skill.speed_skill_pct == pytest.approx(100 * (1 - .5 / 1.5))
    assert np.isnan(skill.ci_low_pct)
    assert skill.status == "too_few_days"


def test_bootstrap_resamples_whole_days_and_is_reproducible():
    reference = prediction_rows([2] * 48, [3] * 48, model="persistence")
    candidate = prediction_rows([2] * 48, [2] * 24 + [4] * 24)
    data = pd.concat([reference, candidate], ignore_index=True)
    first = diagnostics.skill_against_baseline(data, n_bootstrap=300, seed=17)
    pd.testing.assert_frame_equal(first, diagnostics.skill_against_baseline(data, n_bootstrap=300, seed=17))
    row = first.iloc[0]
    assert row.n_pairs == 48
    assert row.n_days == 2
    assert row.speed_skill_pct == 0
    assert row.ci_low_pct == -100
    assert row.ci_high_pct == 100  # an hourly iid bootstrap would give a much narrower interval


def test_perfect_baseline_does_not_divide_by_zero():
    reference = prediction_rows([2, 2], [2, 2], model="persistence")
    candidate = prediction_rows([2, 2], [3, 3])
    row = diagnostics.skill_against_baseline(pd.concat([reference, candidate])).iloc[0]
    assert row.n_pairs == 2
    assert row.status == "zero_baseline_error"
    assert np.isnan(row.speed_skill_pct)
    assert np.isnan(row.ci_low_pct)


def test_pairing_rejects_duplicates_and_conflicting_observations():
    reference = prediction_rows([2], [3], model="persistence")
    candidate = prediction_rows([2], [2])
    with pytest.raises(ValueError, match="重複"):
        diagnostics.skill_against_baseline(pd.concat([reference, reference, candidate]))
    candidate["observed_speed_ms"] = 4
    with pytest.raises(ValueError, match="異な"):
        diagnostics.skill_against_baseline(pd.concat([reference, candidate]))


def test_timezone_aware_input_requires_explicit_jst_conversion():
    data = prediction_rows([2], [3])
    data["issue_time"] = data.issue_time.dt.tz_localize("UTC")
    with pytest.raises(ValueError, match="JST"):
        diagnostics.add_errors(data)
    data["issue_time"] = pd.NaT
    with pytest.raises(ValueError, match="欠けた日時"):
        diagnostics.add_errors(data)


def test_plots_are_created_and_future_only_has_no_diagnostic_figures(tmp_path):
    reference = prediction_rows([2, 3, 4, 5] * 6, [3, 4, 3, 5] * 6, model="persistence")
    candidate = prediction_rows([2, 3, 4, 5] * 6, [2, 3, 3, 6] * 6)
    paths = diagnostics.plot_diagnostics(pd.concat([reference, candidate]), tmp_path, language="en")
    assert {path.name for path in paths} == {
        "error_by_lead.png", "timeseries_station_1.png", "speed_scatter.png", "error_by_month.png",
        "error_by_hour.png", "error_by_direction.png", "error_by_speed_band.png", "wind_rose.png",
    }
    assert all(path.is_file() and path.stat().st_size > 1000 for path in paths)
    future = candidate.copy()
    future[["observed_u_ms", "observed_v_ms", "observed_speed_ms"]] = np.nan
    assert diagnostics.plot_diagnostics(future, tmp_path / "future", language="en") == []
