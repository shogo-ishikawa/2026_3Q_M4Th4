"""外部データと保存形式をまたぐ、独立した回帰確認。"""

import io
import json
import zipfile

import numpy as np
import pandas as pd
import pytest
import requests

from coastal_wind_chaos import forecast_diagnostics as diagnostics
from coastal_wind_chaos import forecast_export as saved
from coastal_wind_chaos import forecast_sources as sources
from coastal_wind_chaos import wind_pipeline as wp


class Response:
    def __init__(self, data=None, status=200):
        self.data, self.status = data, status

    def raise_for_status(self):
        if self.status >= 400:
            raise requests.HTTPError(str(self.status))

    def json(self):
        return self.data


def forecast_payload():
    times = pd.date_range("2026-06-01T00:00Z", periods=4, freq="h")
    return {"latitude": 35.74, "longitude": 140.86,
            "hourly_units": {"wind_speed_10m": "m/s", "wind_direction_10m": "°"},
            "hourly": {"time": (times.astype("int64") // 10**9).tolist(),
                       "wind_speed_10m": [2, 2, 3, 4], "wind_direction_10m": [180, 180, None, 180]}}


class Session:
    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, params))
        return self.handler(url, params)


def observations():
    frame = pd.DataFrame({"wind_speed_ms": [3.0] * 3, "wind_direction": ["南"] * 3},
                         index=pd.date_range("2026-06-01 10:00", periods=3, freq="h"))
    frame.attrs["station"] = "銚子"
    return wp.prepare_weather(frame)


def simple_result(weather, source_kind="observations"):
    frame = pd.DataFrame({"issue_time": [pd.Timestamp("2026-06-01 09:00")],
                          "target_time": [pd.Timestamp("2026-06-01 10:00")], "horizon_h": [1],
                          "station": [weather.attrs["station"]], "model": ["persistence"],
                          "observed_u_ms": [0.0], "observed_v_ms": [3.0],
                          "predicted_u_ms": [0.0], "predicted_v_ms": [2.0], "excluded": [""]})
    return {"predictions": frame, "summary": diagnostics.summarise_errors(frame),
            "skill": diagnostics.skill_against_baseline(frame), "forecast_history": frame.copy(),
            "metadata": {"station": weather.attrs["station"], "source_kind": source_kind}}


def write_canonical(path, **changes):
    table = pd.DataFrame({"observed_at": ["2026-06-01T10:00:00+09:00", "2026-06-01T11:00:00+09:00"],
                          "station": ["銚子", "銚子"], "wind_speed_ms": [2, 3], "wind_direction": ["南", "南"]})
    for key, value in changes.items():
        table[key] = value
    table.to_csv(path, index=False)
    return path


def test_missing_forecast_direction_does_not_discard_valid_scalar_speed():
    session = Session(lambda *_: Response(forecast_payload()))
    prediction = sources.fetch_single_run(35.7383333333, 140.8566666667, models="jma_msm", hours=3,
                                          run_time_utc="2026-06-01T00:00Z", session=session)
    prediction = sources.match_observations(prediction, observations(), station="銚子")
    score = diagnostics.summarise_errors(prediction).set_index("horizon_h")
    assert score.loc[2, "n_speed"] == 1
    assert score.loc[2, "speed_mae_ms"] == 0
    assert score.loc[2, "n_vector"] == 0
    assert score.loc[2, "n_direction"] == 0
    assert prediction.loc[1, "excluded"] == ""


def test_one_unavailable_weather_model_keeps_success_and_names_failure():
    def response(_, params):
        return Response(status=503) if params["models"] == "unavailable" else Response(forecast_payload())
    session = Session(response)
    prediction = sources.fetch_forecasts(35.7383333333, 140.8566666667,
                                         models=("jma_msm", "unavailable"), hours=3,
                                         fetched_at="2026-06-01T00:00Z", session=session)
    assert prediction["model"].unique().tolist() == ["jma_msm"]
    warnings = prediction.attrs["metadata"]["warnings"]
    assert len(warnings) == 1 and "unavailable" in warnings[0]
    assert len(session.calls) == 3


def test_malformed_units_are_reported_as_source_error():
    payload = forecast_payload()
    payload["hourly_units"] = None
    session = Session(lambda *_: Response(payload))
    with pytest.raises(sources.SourceError, match="単位"):
        sources.fetch_forecasts(35, 140, models="jma_msm", hours=3,
                                fetched_at="2026-06-01T00:00Z", session=session)


@pytest.mark.parametrize("bad", [None, "", "NaT"])
def test_canonical_observation_missing_timestamp_cannot_silently_drop_row(tmp_path, bad):
    path = write_canonical(tmp_path / "observations.csv", observed_at=["2026-06-01T10:00:00+09:00", bad])
    with pytest.raises(ValueError, match="日時"):
        saved.load_observations([path])


def test_canonical_observation_requires_station_for_every_row(tmp_path):
    path = write_canonical(tmp_path / "observations.csv", station=["銚子", None])
    with pytest.raises(ValueError, match="地点"):
        saved.load_observations([path])


def test_canonical_observation_rejects_mixed_stations(tmp_path):
    path = write_canonical(tmp_path / "observations.csv", station=["銚子", "稚内"])
    with pytest.raises(ValueError, match="観測地点"):
        saved.load_observations([path])


@pytest.mark.parametrize("bad_speed", [-1, 151, np.inf, "not-a-number"])
def test_canonical_observation_invalid_speed_is_not_used_for_training(tmp_path, bad_speed):
    path = write_canonical(tmp_path / "observations.csv", wind_speed_ms=[2, bad_speed])
    with pytest.raises(ValueError, match="風速"):
        saved.load_observations([path])


def test_off_hour_observations_cannot_be_used_as_hourly_lags(tmp_path):
    path = write_canonical(tmp_path / "observations.csv",
                           observed_at=["2026-06-01T10:30:00+09:00", "2026-06-01T11:30:00+09:00"])
    with pytest.raises(ValueError, match="毎正時"):
        saved.load_observations([path])


def test_synthetic_provenance_survives_zip_and_standalone_csv(tmp_path):
    weather = observations()
    # 地点名に合成という文字がなくても、記録したデータ区分を失わない。
    result = simple_result(weather, source_kind="synthetic")
    archive = saved.export_result(result, tmp_path, weather=weather)
    for path in (archive, tmp_path / "observations.csv"):
        restored = saved.load_observations([path])
        assert restored.attrs["source_kind"] == "synthetic"
        assert restored.attrs["station"] == "銚子"


def test_synthetic_and_real_data_cannot_be_combined_by_same_station_label(tmp_path):
    real = write_canonical(tmp_path / "real.csv", source_kind=["observations"] * 2)
    synthetic = write_canonical(tmp_path / "synthetic.csv", source_kind=["synthetic"] * 2)
    with pytest.raises(ValueError, match="合成データと実観測"):
        saved.load_observations([real, synthetic])


def test_recent_observations_cannot_be_appended_to_synthetic_training_history():
    historical = observations()
    historical.attrs["source_kind"] = "synthetic"
    recent = observations()
    recent.attrs["source_kind"] = "observations"
    with pytest.raises(ValueError, match="合成データと実観測"):
        saved.merge_observations(recent, historical)


def test_csv_and_metadata_source_kind_disagreement_is_rejected(tmp_path):
    path = write_canonical(tmp_path / "observations.csv", source_kind=["observations"] * 2)
    metadata = {"observation_metadata": {"station": "銚子", "source_kind": "synthetic"}}
    with pytest.raises(ValueError, match="区分が一致"):
        saved._prepared_observations(path.read_bytes(), metadata)


def test_metadata_list_is_clear_input_error(tmp_path):
    path = write_canonical(tmp_path / "observations.csv")
    with pytest.raises(ValueError, match="オブジェクト"):
        saved._prepared_observations(path.read_bytes(), [])


def test_forecast_history_validates_reported_lead_against_timestamps(tmp_path):
    result = simple_result(observations())
    result["forecast_history"]["horizon_h"] = 3
    archive = saved.export_result(result, tmp_path)
    with pytest.raises(ValueError, match="時間先"):
        saved.load_forecast_history([archive])


def test_forecast_history_missing_timestamp_is_rejected(tmp_path):
    result = simple_result(observations())
    archive = saved.export_result(result, tmp_path)
    with zipfile.ZipFile(archive) as existing:
        entries = {name: existing.read(name) for name in existing.namelist()}
    table = pd.read_csv(io.BytesIO(entries["forecast_history.csv"]))
    table["target_time"] = ""
    entries["forecast_history.csv"] = table.to_csv(index=False).encode()
    broken = tmp_path / "broken.zip"
    with zipfile.ZipFile(broken, "w") as output:
        for name, data in entries.items():
            output.writestr(name, data)
    with pytest.raises(ValueError, match="日時"):
        saved.load_forecast_history([broken])
