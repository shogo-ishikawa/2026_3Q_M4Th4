"""公開APIを呼ばず、取得時刻・品質・照合を固定データで確かめる。"""

import copy

import numpy as np
import pandas as pd
import pytest
import requests

from coastal_wind_chaos import forecast_sources as fs
from coastal_wind_chaos import wind_pipeline as wp


class Response:
    def __init__(self, payload=None, text="", status=200):
        self.payload, self.text, self.status = payload, text, status

    def raise_for_status(self):
        if self.status >= 400:
            raise requests.HTTPError(f"status {self.status}")

    def json(self):
        return copy.deepcopy(self.payload)


class Session:
    def __init__(self, handler):
        self.handler, self.calls = handler, []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, params, timeout))
        return self.handler(url, params)


def payload(start="2026-06-01T00:00Z", count=6):
    stamps = pd.date_range(start, periods=count, freq="h")
    return {"latitude": 35.3, "longitude": 139.5,
            "hourly_units": {"time": "unixtime", "wind_speed_10m": "m/s", "wind_direction_10m": "°"},
            "hourly": {"time": (stamps.astype("int64") // 10**9).tolist(),
                       "wind_speed_10m": [2.0] * count, "wind_direction_10m": [90.0] * count}}


def test_live_uses_actual_retrieval_time_and_jst():
    session = Session(lambda url, params: Response(payload()))
    frame = fs.fetch_forecasts(35, 139, models=("jma_msm",), hours=3,
                              fetched_at="2026-06-01T00:30Z", session=session)
    assert frame["issue_time"].eq(pd.Timestamp("2026-06-01 09:30")).all()
    assert frame["target_time"].tolist() == list(pd.date_range("2026-06-01 10:00", periods=3, freq="h"))
    assert frame["horizon_h"].tolist() == [0.5, 1.5, 2.5]
    assert frame["predicted_u_ms"].tolist() == pytest.approx([-2, -2, -2])
    assert frame["observed_u_ms"].isna().all()
    assert frame.attrs["metadata"]["issue_basis"] == "retrieval_time"
    assert frame.attrs["metadata"]["initialisation_time_utc"] is None
    assert session.calls[0][1]["wind_speed_unit"] == "ms"
    assert session.calls[0][2] == 30


def test_single_run_initialisation_is_not_retrieval_or_availability():
    session = Session(lambda url, params: Response(payload()))
    frame = fs.fetch_single_run(35, 139, models=("jma_msm",), hours=3,
                               run_time_utc="2026-06-01T00:00", session=session)
    assert frame["horizon_h"].tolist() == [1, 2, 3]
    assert frame["issue_time"].eq(pd.Timestamp("2026-06-01 09:00")).all()
    assert frame.attrs["metadata"]["availability_time_utc"] is None
    assert frame.attrs["metadata"]["issue_basis"] == "initialisation_time"
    assert session.calls[0][0] == fs.SINGLE_RUN_API
    assert session.calls[0][1]["run"] == "2026-06-01T00:00"


def test_missing_forecast_is_retained_and_not_fabricated():
    data = payload()
    data["hourly"]["wind_speed_10m"][2] = None
    data["hourly"]["wind_direction_10m"][3] = None
    session = Session(lambda url, params: Response(data))
    frame = fs.fetch_single_run(35, 139, models=("jma_msm",), hours=3,
                               run_time_utc="2026-06-01T00:00Z", session=session)
    assert frame["excluded"].tolist() == ["", "missing_forecast", ""]
    assert frame["predicted_u_ms"].isna().sum() == 2
    assert frame.attrs["metadata"]["models"][0]["available_horizon_max_h"] == 3


def test_model_suffix_response_and_unit_rejection():
    data = payload()
    for root in ("hourly", "hourly_units"):
        for key in ("wind_speed_10m", "wind_direction_10m"):
            data[root][key + "_jma_msm"] = data[root].pop(key)
    session = Session(lambda url, params: Response(data))
    frame = fs.fetch_forecasts(35, 139, models="jma_msm", hours=3,
                              fetched_at="2026-06-01T00:00Z", session=session)
    assert len(frame) == 3
    data["hourly_units"]["wind_speed_10m_jma_msm"] = "km/h"
    with pytest.raises(fs.SourceError, match="単位"):
        fs.fetch_forecasts(35, 139, models="jma_msm", hours=3,
                           fetched_at="2026-06-01T00:00Z", session=session)


def test_malformed_lengths_and_duplicate_time_are_rejected():
    data = payload()
    data["hourly"]["time"][1] = data["hourly"]["time"][0]
    session = Session(lambda url, params: Response(data))
    with pytest.raises(fs.SourceError, match="重複"):
        fs.fetch_forecasts(35, 139, models="jma_msm", fetched_at="2026-06-01T00:00Z", session=session)
    data["hourly"]["time"].pop()
    with pytest.raises(fs.SourceError, match="一致"):
        fs.fetch_forecasts(35, 139, models="jma_msm", fetched_at="2026-06-01T00:00Z", session=session)


@pytest.mark.parametrize("lat,lon,hours", [(np.nan, 139, 24), (91, 139, 24), (35, np.inf, 24), (35, 181, 24),
                                           (35, 139, 73), (35, 139, 0), (35, 139, 1.5), (35, 139, True)])
def test_invalid_requests_do_not_call_network(lat, lon, hours):
    session = Session(lambda url, params: pytest.fail("network must not be called"))
    with pytest.raises(ValueError):
        fs.fetch_forecasts(lat, lon, hours=hours, session=session)


def test_failed_request_retries_are_bounded():
    session = Session(lambda url, params: Response(status=503))
    with pytest.raises(fs.SourceError):
        fs.fetch_forecasts(35, 139, models="jma_msm", session=session)
    assert len(session.calls) == 2


def test_matching_is_exact_does_not_invent_truth_and_keeps_forecast_metadata():
    session = Session(lambda url, params: Response(payload()))
    frame = fs.fetch_forecasts(35, 139, models="jma_msm", hours=3,
                              fetched_at="2026-06-01T00:00Z", session=session)
    raw = pd.DataFrame({"wind_speed_ms": [3.0], "wind_direction": ["南"]},
                       index=pd.DatetimeIndex(["2026-06-01 10:00"]))
    weather = wp.prepare_weather(raw)
    result = fs.match_observations(frame, weather, station="銚子")
    assert result["observed_speed_ms"].tolist()[0] == 3
    assert result["observed_speed_ms"].isna().sum() == 2
    assert result["station"].eq("銚子").all()
    assert result.attrs["metadata"]["issue_basis"] == "retrieval_time"
    assert frame["observed_speed_ms"].isna().all()
    shifted = weather.copy()
    shifted.index = shifted.index + pd.Timedelta(minutes=1)
    assert fs.match_observations(frame, shifted)["observed_speed_ms"].isna().all()


def test_history_keeps_separate_snapshots_and_grid_choices():
    session = Session(lambda url, params: Response(payload()))
    a = fs.fetch_forecasts(35, 139, models="jma_msm", hours=3,
                          fetched_at="2026-06-01T00:00Z", session=session)
    b = fs.fetch_forecasts(35, 139, models="jma_msm", hours=3,
                          fetched_at="2026-06-01T00:10Z", session=session)
    c = a.copy()
    c["cell_selection"] = "sea"
    merged = fs.merge_forecast_history(a, b, c, a)
    assert len(merged) == 9
    assert merged["issue_time"].nunique() == 2
    assert merged.attrs["metadata"]["history_snapshots"] == 2


def amedas_session(*, missing_block=False):
    def handle(url, params):
        if url.endswith("amedastable.json"):
            return Response({"45148": {"kjName": "銚子", "lat": [35, 44.3], "lon": [140, 51.4], "alt": 5}})
        if url.endswith("latest_time.txt"):
            return Response(text="2026-06-01T12:10:00+09:00")
        if url.endswith("20260601_09.json"):
            if missing_block:
                return Response(status=404)
            return Response({
                "20260601090000": {"wind": [2, 0], "windDirection": [16, 0], "temp": [20, 0]},
                "20260601100000": {"wind": [3, 1], "windDirection": [4, 0]},  # QC1 excluded
                "20260601110000": {"wind": [0.1, 0], "windDirection": [0, 0]},
                "20260601111000": {"wind": [99, 0], "windDirection": [4, 0]},  # not hourly
                "20260601120000": {"wind": [99, 0], "windDirection": [4, 0]},  # wrong block
            })
        if url.endswith("20260601_12.json"):
            return Response({"20260601120000": {"wind": [4, 0], "windDirection": [4, 0], "temp": [21, 0]}})
        raise AssertionError(url)
    return Session(handle)


def test_recent_amedas_quality_calm_direction_index_and_grid():
    session = amedas_session()
    weather = fs.fetch_recent_amedas("45148", hours=4, session=session)
    assert weather.index.tolist() == list(pd.date_range("2026-06-01 09:00", periods=4, freq="h"))
    assert weather.loc["2026-06-01 09:00", "wind_direction"] == "北"
    assert weather.loc["2026-06-01 12:00", "wind_direction"] == "東"
    assert np.isnan(weather.loc["2026-06-01 10:00", "wind_speed_ms"])
    assert weather.loc["2026-06-01 11:00", "wind_is_calm"]
    assert weather.loc["2026-06-01 11:00", "u_ms"] == 0
    assert weather.attrs["station"] == "銚子"
    assert weather.attrs["metadata"]["latitude"] == pytest.approx(35.73833333333334)
    assert weather.attrs["metadata"]["n_observed_hours"] == 3
    assert weather.attrs["metadata"]["warnings"] == []


def test_missing_amedas_block_preserves_missing_hours_and_warning():
    weather = fs.fetch_recent_amedas("45148", hours=4, session=amedas_session(missing_block=True))
    assert len(weather) == 4
    assert weather["wind_speed_ms"].isna().sum() == 3
    assert len(weather.attrs["metadata"]["warnings"]) == 1


def test_unknown_amedas_station_is_clear_error():
    with pytest.raises(fs.SourceError, match="ありません"):
        fs.fetch_recent_amedas("99999", session=amedas_session())


def test_matching_rejects_known_different_forecast_and_observation_locations():
    session = Session(lambda url, params: Response(payload()))
    frame = fs.fetch_forecasts(35.0, 140.0, models="jma_msm", hours=3,
                              fetched_at="2026-06-01T00:00Z", session=session)
    weather = fs.fetch_recent_amedas("45148", hours=4, session=amedas_session())
    with pytest.raises(ValueError, match="地点と観測所が異なります"):
        fs.match_observations(frame, weather, station="銚子")


def test_history_row_coordinates_guard_survives_csv_roundtrip_and_merge():
    import io
    session = Session(lambda url, params: Response(payload()))
    beach = fs.fetch_forecasts(35.0, 140.0, models="jma_msm", hours=3,
                              fetched_at="2026-06-01T00:00Z", session=session)
    station = fs.fetch_forecasts(35.73833333333334, 140.85666666666665, models="jma_msm", hours=3,
                                fetched_at="2026-06-01T00:10Z", session=session)
    beach = pd.read_csv(io.StringIO(beach.to_csv(index=False)))  # attrs intentionally lost
    merged = fs.merge_forecast_history(station, beach)
    weather = fs.fetch_recent_amedas("45148", hours=4, session=amedas_session())
    with pytest.raises(ValueError, match="地点と観測所が異なります"):
        fs.match_observations(merged, weather, station="銚子")


def test_history_names_cannot_be_overwritten_to_another_station():
    session = Session(lambda url, params: Response(payload()))
    forecast = fs.fetch_forecasts(35.73833333333334, 140.85666666666665, models="jma_msm", hours=3,
                                 fetched_at="2026-06-01T00:00Z", session=session)
    weather = fs.fetch_recent_amedas("45148", hours=4, session=amedas_session())
    forecast["station"] = "稚内"
    with pytest.raises(ValueError, match="地点名と照合する観測所"):
        fs.match_observations(forecast, weather, station="銚子")
    forecast.loc[0, "station"] = "銚子"
    with pytest.raises(ValueError, match="混在"):
        fs.match_observations(forecast, weather, station="銚子")
    forecast["station"] = "指定地点"
    matched = fs.match_observations(forecast, weather, station="銚子")
    assert matched["station"].eq("銚子").all()


def test_native_calm_forecast_speed_is_preserved():
    data = payload()
    data["hourly"]["wind_speed_10m"] = [0.1] * 6
    data["hourly"]["wind_direction_10m"] = [None] * 6
    session = Session(lambda url, params: Response(data))
    forecast = fs.fetch_forecasts(35.73833333333334, 140.85666666666665, models="jma_msm", hours=3,
                                 fetched_at="2026-06-01T00:00Z", session=session)
    assert forecast["predicted_speed_ms"].tolist() == [0.1] * 3
    assert forecast["predicted_u_ms"].eq(0).all()
    assert forecast["predicted_v_ms"].eq(0).all()
    assert forecast["excluded"].eq("").all()


def test_same_grid_different_requested_locations_are_not_deduplicated():
    session = Session(lambda url, params: Response(payload()))
    a = fs.fetch_forecasts(35.73833333333334, 140.85666666666665, models="jma_msm", hours=3,
                          fetched_at="2026-06-01T00:00Z", session=session)
    b = fs.fetch_forecasts(35.3, 139.5, models="jma_msm", hours=3,
                          fetched_at="2026-06-01T00:00Z", session=session)
    assert a["grid_latitude"].equals(b["grid_latitude"])
    assert len(fs.merge_forecast_history(a, b)) == 6
