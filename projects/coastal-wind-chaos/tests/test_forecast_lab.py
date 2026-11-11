"""公開ラボの学習・選択・将来推論を、未来情報を変える検査で確認する。"""

import numpy as np
import pandas as pd
import pytest

from coastal_wind_chaos import forecast_lab as lab
from coastal_wind_chaos import wind_pipeline as wp


@pytest.fixture
def lab_weather():
    times = pd.date_range("2023-01-01", periods=24 * 160, freq="h")
    step = np.arange(len(times))
    u = 2 + np.sin(step / 7) + 0.3 * np.sin(step / 24)
    v = -1 + 0.7 * np.cos(step / 9)
    weather = pd.DataFrame({"u_ms": u, "v_ms": v, "wind_speed_ms": np.hypot(u, v),
                            "wind_direction_deg": wp.uv_to_direction(u, v),
                            "temperature_c": 10 + np.sin(step / 24)}, index=times)
    weather.attrs["station"] = "試験観測点"
    return weather


def backtest(weather, **changes):
    arguments = {"horizons": (1, 3, 24), "validation_start": "2023-03-01",
                 "test_start": "2023-04-01", "candidates": ("linear",)}
    arguments.update(changes)
    return lab.run_backtest(weather, **arguments)


def test_backtest_outputs_canonical_rows_and_common_origins(lab_weather):
    result = backtest(lab_weather)
    table = result["predictions"]
    required = {"issue_time", "target_time", "station", "horizon_h", "model", "excluded",
                "observed_u_ms", "observed_v_ms", "observed_speed_ms", "predicted_u_ms", "predicted_v_ms"}
    assert required <= set(table.columns)
    assert table["station"].eq("試験観測点").all()
    assert set(table["model"]) == {*lab.BASELINES, "linear:calendar+recent"}
    assert (table["target_time"] - table["issue_time"]).eq(pd.to_timedelta(table["horizon_h"], unit="h")).all()
    origins = [set(part["issue_time"]) for _, part in table.groupby(["horizon_h", "model"])]
    assert all(values == origins[0] for values in origins)
    assert min(table["issue_time"]) == pd.Timestamp("2023-04-01")
    for artifact in result["models"].values():
        assert artifact["train_target_end"] < pd.Timestamp("2023-04-01")
        assert "temperature_now" not in artifact["columns"]


def test_missing_targets_have_same_used_origins_across_horizons(lab_weather):
    changed = lab_weather.copy()
    changed.loc[pd.Timestamp("2023-04-10 12:00"), ["u_ms", "v_ms", "wind_speed_ms"]] = np.nan
    table = backtest(changed)["predictions"]
    usable = table[table["excluded"].eq("")]
    origins = [set(part["issue_time"]) for _, part in usable.groupby(["horizon_h", "model"])]
    assert all(values == origins[0] for values in origins)
    assert table["excluded"].eq(lab.COMMON_EXCLUSION).any()
    assert table.loc[table["excluded"].ne(""), ["predicted_u_ms", "predicted_v_ms"]].isna().all().all()


def test_validation_selects_speed_not_direction_or_test_score(lab_weather, monkeypatch):
    actual = lab._predictions

    def prescribed(stage, spec, bundle=None):
        if stage.get("bounds", (None,) * 4)[2] == pd.Timestamp("2023-03-01"):
            observed = stage["evaluation"][["target_u", "target_v"]].to_numpy()
            # linearは向きが逆でも風速が正しい。boostingは向きが正しく風速が外れる。
            return -observed if spec.startswith("linear:") else 1.5 * observed
        return actual(stage, spec, bundle)

    monkeypatch.setattr(lab, "_predictions", prescribed)
    result = backtest(lab_weather, horizons=(3,), candidates=("boosting_shallow", "linear"))
    assert result["selection"] == {3: "linear:calendar+recent"}
    scores = result["selection_scores"].set_index("model")
    assert scores.loc["linear:calendar+recent", "speed_mae_ms"] == pytest.approx(0)
    assert scores.loc["boosting_shallow:calendar+recent", "speed_mae_ms"] > 0


def test_test_observations_cannot_change_selection_or_fitted_models(lab_weather):
    changed = lab_weather.copy()
    later = changed.index >= pd.Timestamp("2023-04-01")
    changed.loc[later, ["u_ms", "v_ms", "wind_speed_ms"]] *= 5
    original = backtest(lab_weather, horizons=(3,))
    altered = backtest(changed, horizons=(3,))
    assert original["selection"] == altered["selection"]
    pd.testing.assert_frame_equal(original["selection_scores"], altered["selection_scores"])
    for name in ("coef_", "intercept_"):
        np.testing.assert_allclose(getattr(original["models"][3]["model"][-1], name),
                                   getattr(altered["models"][3]["model"][-1], name))


def test_future_prediction_does_not_use_observations_after_cutoff(lab_weather):
    cutoff = pd.Timestamp("2023-04-15 12:00")
    changed = lab_weather.copy()
    changed.loc[changed.index > cutoff, ["u_ms", "v_ms", "wind_speed_ms", "temperature_c"]] = 999
    args = {"horizons": (1, 3, 24), "cutoff": cutoff, "include_optional": True}
    first = lab.forecast_future(lab_weather, **args)
    second = lab.forecast_future(changed, **args)
    pd.testing.assert_frame_equal(first["predictions"], second["predictions"])
    output = first["predictions"]
    assert output["issue_time"].eq(cutoff).all()
    assert output["target_time"].gt(cutoff).all()
    assert output[["observed_u_ms", "observed_v_ms", "observed_speed_ms"]].isna().all().all()
    assert output["excluded"].eq("future_target").all()
    assert output[["predicted_u_ms", "predicted_v_ms"]].notna().all().all()
    assert first["metadata"]["input_cutoff"] == cutoff.isoformat()
    assert first["metadata"]["observations_available"] is False
    assert first["metadata"]["selection_basis"] == "fixed_linear_default"
    assert first["metadata"]["selection_metric"] is None
    assert all(item["train_target_end"] <= cutoff for item in first["models"].values())


def test_future_rejects_missing_latest_input_instead_of_using_a_previous_day(lab_weather):
    changed = lab_weather.copy()
    changed.loc[changed.index[-10], "u_ms"] = np.nan
    with pytest.raises(ValueError, match="入力が不足"):
        lab.forecast_future(changed, horizons=(3,))
    changed = lab_weather.copy()
    changed.loc[changed.index[-1], "u_ms"] = np.nan
    with pytest.raises(ValueError, match="最新の観測時刻"):
        lab.forecast_future(changed, horizons=(3,))


def test_future_accepts_json_selection_keys_and_rejects_changed_features(lab_weather):
    result = lab.forecast_future(lab_weather, horizons=(3,),
                                 selected_methods={"3": "linear:recent"}, feature_set="recent")
    assert result["selection"] == {3: "linear:recent"}
    with pytest.raises(ValueError, match="入力項目が異なります"):
        lab.forecast_future(lab_weather, horizons=(3,), selected_methods={3: "linear:recent"})


def test_calm_native_speed_is_preserved_for_speed_error(lab_weather):
    changed = lab_weather.copy()
    calm_time = pd.Timestamp("2023-04-10 13:00")
    changed.loc[calm_time, ["u_ms", "v_ms"]] = 0
    changed.loc[calm_time, "wind_direction_deg"] = np.nan
    changed.loc[calm_time, "wind_speed_ms"] = 0.1
    table = backtest(changed, horizons=(3,))["predictions"]
    calm = table[table["target_time"].eq(calm_time)]
    assert calm["excluded"].eq("").all()
    assert calm["observed_speed_ms"].eq(0.1).all()
    assert calm[["observed_u_ms", "observed_v_ms"]].eq(0).all().all()


@pytest.mark.parametrize("horizons", [(), (0,), (73,), (1.5,), (True,)])
def test_invalid_horizons_rejected_before_fitting(lab_weather, horizons):
    with pytest.raises(ValueError, match="1〜72"):
        lab.forecast_future(lab_weather, horizons=horizons)


def test_custom_dates_validate_order_and_minimum_training(lab_weather):
    with pytest.raises(ValueError, match="学習開始 <"):
        backtest(lab_weather, validation_start="2023-04-01", test_start="2023-03-01")
    with pytest.raises(ValueError, match="30日以上"):
        backtest(lab_weather, validation_start="2023-01-20", test_start="2023-02-01")
    with pytest.raises(ValueError, match="候補を1つ以上"):
        backtest(lab_weather, candidates=())


def test_timezone_aware_cutoff_is_converted_to_jst(lab_weather):
    aware = pd.Timestamp("2023-04-15 03:00", tz="UTC")
    result = lab.forecast_future(lab_weather, horizons=(3,), cutoff=aware)
    assert result["predictions"]["issue_time"].eq(pd.Timestamp("2023-04-15 12:00")).all()


def test_three_year_default_uses_chronological_whole_years(three_year_weather):
    result = lab.run_backtest(three_year_weather, horizons=(3,), candidates=("linear",))
    assert result["split"]["validation_start"] == pd.Timestamp("2024-01-01 01:00")
    assert result["split"]["test_start"] == pd.Timestamp("2025-01-01 01:00")
    assert result["metadata"]["selection_metric"] == "speed_mae_ms"
