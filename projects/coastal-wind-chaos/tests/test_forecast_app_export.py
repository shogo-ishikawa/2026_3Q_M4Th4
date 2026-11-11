"""取得・学習・保存の境界を通す回帰確認。"""

import json
from pathlib import Path
import zipfile

import numpy as np
import pandas as pd
import pytest

from coastal_wind_chaos import forecast_app as app
from coastal_wind_chaos import forecast_sources as sources
from coastal_wind_chaos import forecast_diagnostics as diagnostics
from coastal_wind_chaos import sample_data
from coastal_wind_chaos.forecast_export import export_result, load_observations, load_forecast_history, merge_observations


def result_for(weather):
    time = weather.index[-1]
    predictions = pd.DataFrame({
        "issue_time": [time], "target_time": [time + pd.Timedelta(hours=1)],
        "horizon_h": [1], "station": [weather.attrs["station"]], "model": ["persistence"],
        "observed_u_ms": [np.nan], "observed_v_ms": [np.nan],
        "observed_speed_ms": [np.nan], "predicted_u_ms": [1.0], "predicted_v_ms": [2.0], "excluded": [""],
    })
    return {"predictions": predictions, "summary": diagnostics.summarise_errors(predictions),
            "skill": diagnostics.skill_against_baseline(predictions), "grouped": {},
            "metadata": {"station": weather.attrs["station"], "source_kind": "synthetic"}}


def test_observations_zip_and_standalone_csv_preserve_station_and_values(tmp_path):
    weather = sample_data.generate_weather(years=1, seed=6)
    weather.attrs["station"] = "仮想海辺観測点（合成）"
    archive = export_result(result_for(weather), tmp_path, weather=weather)
    for path in (archive, tmp_path / "observations.csv"):
        restored = load_observations([path])
        assert restored.attrs["station"] == weather.attrs["station"]
        np.testing.assert_allclose(restored["wind_speed_ms"], weather["wind_speed_ms"], equal_nan=True)
        np.testing.assert_allclose(restored["u_ms"], weather["u_ms"], equal_nan=True)
    with zipfile.ZipFile(archive) as saved:
        text = saved.read("observations.csv").decode("utf-8-sig")
        assert "+09:00" in text
        assert json.loads(saved.read("metadata.json"))["timezone"] == "Asia/Tokyo"


def test_recent_json_quality_survives_history_merge_and_zip_roundtrip(tmp_path):
    weather = sample_data.generate_weather(years=1, seed=6)
    weather.attrs["station"] = "辻堂"
    recent = weather.iloc[-5:].copy()
    recent = recent.drop(columns=[name for name in recent if name.endswith(("_quality", "_homogeneity"))])
    recent["wind_speed_ms"] = 7.8
    recent["wind_direction"] = "南"
    recent["u_ms"] = 0.0
    recent["v_ms"] = 7.8
    recent["amedas_wind_flag"] = 0
    recent.attrs["metadata"] = {"source": "JMA AMeDAS"}
    merged = merge_observations(recent, weather)
    restored = load_observations([export_result(result_for(merged), tmp_path, weather=merged)])
    np.testing.assert_allclose(restored["wind_speed_ms"].tail(5), [7.8] * 5)
    assert restored.attrs["metadata"]["source"] == "JMA AMeDAS"


def test_different_observation_stations_cannot_be_merged():
    first = sample_data.generate_weather(years=1)
    other = first.tail(3).copy()
    first.attrs["station"], other.attrs["station"] = "辻堂", "三浦"
    with pytest.raises(ValueError, match="地点"):
        merge_observations(other, first)


def test_coordinates_use_station_metadata_and_unknown_requires_input():
    weather = pd.DataFrame()
    weather.attrs = {"station": "辻堂", "metadata": {"latitude": 35.32, "longitude": 139.45}}
    assert app._coordinates({}, weather) == (35.32, 139.45)
    weather.attrs = {"station": "座標不明の地点"}
    with pytest.raises(ValueError, match="緯度"):
        app._coordinates({}, weather)


def test_future_roundtrip_is_unscored_but_has_plot_and_no_stale_outputs(tmp_path):
    weather = sample_data.generate_weather(years=1, seed=6, missing_rate=0)
    weather.attrs["station"] = "仮想海辺観測点（合成）"
    source_zip = export_result(result_for(weather), tmp_path / "input", weather=weather)
    options = {"horizons": [1, 3], "n_bootstrap": 0}
    first = app.run_analysis("future", [source_zip], options, tmp_path / "runs")
    assert first["summary"]["n_speed"].sum() == 0
    assert first["summary"]["speed_mae_ms"].isna().all()
    assert "predicted_speed_ms" in first["predictions"]
    assert any(Path(path).name == "unverified_forecasts.png" for path in first["figures"])
    second = app.run_analysis("future", [source_zip], {**options, "horizons": [6]}, tmp_path / "runs")
    assert first["zip_path"].parent != second["zip_path"].parent
    with zipfile.ZipFile(second["zip_path"]) as archive:
        assert not any("error_by" in name for name in archive.namelist())
        saved = pd.read_csv(archive.open("predictions.csv"))
        assert saved["horizon_h"].unique().tolist() == [6]


def test_forecast_zip_history_preserves_explicit_times(tmp_path):
    weather = sample_data.generate_weather(years=1)
    weather.attrs["station"] = "仮想海辺観測点（合成）"
    result = result_for(weather)
    result["forecast_history"] = result["predictions"].copy()
    restored = load_forecast_history([export_result(result, tmp_path)])
    pd.testing.assert_series_equal(restored[0]["issue_time"], result["predictions"]["issue_time"], check_names=False)


def test_latest_checkbox_fetches_observations_without_claiming_accuracy(tmp_path, monkeypatch):
    weather = sample_data.generate_weather(years=1, missing_rate=0)
    weather.attrs["station"] = "辻堂"
    weather.attrs["metadata"] = {"latitude": 35.32, "longitude": 139.45}
    predictions = result_for(weather)["predictions"]
    predictions["model"] = "jma_msm"
    predictions["cell_selection"] = "land"
    called = []
    monkeypatch.setattr(sources, "fetch_forecasts", lambda *args, **kwargs: predictions.copy())
    def recent(station_id, **kwargs):
        called.append(station_id)
        return weather
    monkeypatch.setattr(sources, "fetch_recent_amedas", recent)
    result = app.run_analysis("latest_forecast", options={"station": "辻堂", "station_id": "46141",
                              "use_recent_observations": True}, output_dir=tmp_path)
    assert called == ["46141"]
    assert result["summary"]["n_speed"].sum() == 0
    assert "observations.csv" in zipfile.ZipFile(result["zip_path"]).namelist()
