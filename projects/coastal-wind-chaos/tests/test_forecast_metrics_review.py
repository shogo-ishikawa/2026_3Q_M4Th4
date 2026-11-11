"""既知の小さなデータで、誤差の読み方と欠測を隠さない表示を確認する。"""

import numpy as np
import pandas as pd
import pytest
import warnings

from coastal_wind_chaos import forecast_diagnostics as diagnostics


def rows(times, actual, predicted, model="persistence"):
    times = pd.DatetimeIndex(times)
    return pd.DataFrame({
        "station": "Station A", "model": model, "horizon_h": 3,
        "issue_time": times, "target_time": times + pd.Timedelta(hours=3),
        "observed_u_ms": 0.0, "observed_v_ms": -np.asarray(actual, dtype=float),
        "predicted_u_ms": 0.0, "predicted_v_ms": -np.asarray(predicted, dtype=float),
        "observed_speed_ms": actual, "excluded": "",
    })


def test_missing_hour_breaks_both_observed_and_forecast_timeseries(tmp_path, monkeypatch):
    import matplotlib.axes
    import matplotlib.figure

    frame = rows(pd.date_range("2025-01-01", periods=3, freq="h"), [2, np.nan, 4], [2, 3, 4])
    frame.loc[1, ["observed_u_ms", "predicted_u_ms", "predicted_v_ms"]] = np.nan
    frame.loc[1, "excluded"] = "missing_input"
    captured = {}
    original = matplotlib.axes.Axes.plot

    def capture(axis, *args, **kwargs):
        if kwargs.get("label") in ("Observed", "Persistence") and len(args) >= 2:
            captured[kwargs["label"]] = (np.asarray(args[0]), np.asarray(args[1], dtype=float))
        return original(axis, *args, **kwargs)

    monkeypatch.setattr(matplotlib.axes.Axes, "plot", capture)
    monkeypatch.setattr(matplotlib.figure.Figure, "savefig", lambda *args, **kwargs: None)
    diagnostics.plot_diagnostics(frame, tmp_path, language="en")
    for label in ("Observed", "Persistence"):
        x, y = captured[label]
        assert len(x) == 3
        np.testing.assert_allclose(y, [2, np.nan, 4], equal_nan=True)


def test_excluded_prediction_does_not_hide_available_observation(tmp_path, monkeypatch):
    import matplotlib.axes
    import matplotlib.figure

    frame = rows(pd.date_range("2025-01-01", periods=3, freq="h"), [2, 5, 4], [2, 8, 4])
    frame.loc[1, "excluded"] = "missing_input"
    captured = {}
    original = matplotlib.axes.Axes.plot

    def capture(axis, *args, **kwargs):
        if kwargs.get("label") in ("Observed", "Persistence") and len(args) >= 2:
            captured[kwargs["label"]] = np.asarray(args[1], dtype=float)
        return original(axis, *args, **kwargs)

    monkeypatch.setattr(matplotlib.axes.Axes, "plot", capture)
    monkeypatch.setattr(matplotlib.figure.Figure, "savefig", lambda *args, **kwargs: None)
    diagnostics.plot_diagnostics(frame, tmp_path, language="en")
    np.testing.assert_allclose(captured["Observed"], [2, 5, 4])
    np.testing.assert_allclose(captured["Persistence"], [2, np.nan, 4], equal_nan=True)


def test_unequal_day_sizes_use_paired_error_sums_not_mean_of_day_ratios():
    times = ["2025-01-01 23:00", "2025-01-02 00:00", "2025-01-02 01:00", "2025-01-02 02:00"]
    baseline = rows(times, [2] * 4, [12, 3, 3, 3])
    candidate = rows(times, [2] * 4, [2, 4, 4, 4], model="linear:recent")
    result = diagnostics.skill_against_baseline(pd.concat([baseline, candidate]), n_bootstrap=1000, seed=7).iloc[0]
    # Errors are model [0,2,2,2] and baseline [10,1,1,1].
    assert result.n_pairs == 4
    assert result.n_days == 2
    assert result.speed_skill_pct == pytest.approx(100 * (1 - 6 / 13))
    assert result.ci_low_pct == -100
    assert result.ci_high_pct == 100


def test_different_retrievals_for_same_target_are_distinct_forecasts():
    first = rows(["2025-01-01 00:00"], [2], [3])
    second = rows(["2025-01-01 01:00"], [2], [4])
    second["target_time"] = first["target_time"].to_numpy()
    second["horizon_h"] = 2
    candidate = pd.concat([first, second], ignore_index=True)
    candidate["model"] = "linear:recent"
    candidate["predicted_v_ms"] = -2
    summary = diagnostics.skill_against_baseline(pd.concat([first, second, candidate]), n_bootstrap=0)
    assert sorted(summary.n_pairs.tolist()) == [1, 1]
    assert summary.speed_skill_pct.tolist() == [100, 100]


def test_scalar_speed_counts_are_separate_from_direction_and_vector_counts():
    frame = rows(pd.date_range("2025-01-01", periods=3, freq="h"), [.1, 3, 4], [.1, 2, 6])
    frame["predicted_speed_ms"] = [.1, 2, 6]
    frame.loc[0, ["observed_u_ms", "observed_v_ms", "predicted_u_ms", "predicted_v_ms"]] = 0
    frame.loc[1, ["observed_u_ms", "observed_v_ms", "predicted_u_ms", "predicted_v_ms"]] = np.nan
    summary = diagnostics.summarise_errors(frame).iloc[0]
    assert summary.n_speed == 3
    assert summary.n_vector == 2
    assert summary.n_direction == 1
    assert summary.n_calm == 1
    assert summary.speed_mae_ms == 1
    assert summary.speed_bias_ms == pytest.approx(1 / 3)


@pytest.mark.parametrize("analyse", [diagnostics.summarise_errors, diagnostics.grouped_errors,
                                   diagnostics.skill_against_baseline])
def test_initialisation_and_retrieval_leads_are_not_silently_pooled(analyse):
    frame = rows(pd.date_range("2025-01-01", periods=2, freq="h"), [2, 3], [2, 4])
    frame["issue_basis"] = ["initialisation_time", "retrieval_time"]
    with pytest.raises(ValueError, match="予測基準"):
        analyse(frame)


def test_consistent_basis_preserves_the_existing_summary_schema():
    frame = rows(pd.date_range("2025-01-01", periods=2, freq="h"), [2, 3], [2, 4])
    frame["issue_basis"] = "initialisation_time"
    summary = diagnostics.summarise_errors(frame)
    assert summary.columns.tolist() == diagnostics.SUMMARY_COLUMNS
    assert summary.n_speed.tolist() == [2]
    assert summary.speed_mae_ms.tolist() == [.5]


def test_speed_only_data_does_not_produce_an_empty_wind_rose(tmp_path, monkeypatch):
    import matplotlib.figure

    frame = rows(pd.date_range("2025-01-01", periods=3, freq="h"), [2, 3, 4], [2, 4, 5])
    frame["predicted_speed_ms"] = [2, 4, 5]
    frame[diagnostics.VECTOR_COLUMNS] = np.nan
    monkeypatch.setattr(matplotlib.figure.Figure, "savefig", lambda *args, **kwargs: None)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        paths = diagnostics.plot_diagnostics(frame, tmp_path, language="en")
    assert paths
    assert "wind_rose.png" not in {path.name for path in paths}
    assert not any("No artists" in str(warning.message) for warning in caught)
