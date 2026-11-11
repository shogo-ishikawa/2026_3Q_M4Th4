"""公開予報の取得と、気象庁観測との照合。

内部の日時は既存教材に合わせてタイムゾーンなしの日本標準時（JST）とする。
live の issue_time は取得時刻、single_run はモデル初期時刻であり、同一ではない。
API の current 値や再解析を、アメダス実測として扱わない。
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping

import numpy as np
import pandas as pd
import requests

from . import wind_pipeline as wp

FORECAST_API = "https://api.open-meteo.com/v1/forecast"
SINGLE_RUN_API = "https://single-runs-api.open-meteo.com/v1/forecast"
AMEDAS_BASE = "https://www.jma.go.jp/bosai/amedas"
LOCATIONS = {
    "coastal_example": {"name": "沿岸の例示地点", "latitude": 35.0, "longitude": 140.0,
                  "station_id": None, "kind": "forecast_location"},
    # 観測所の最新座標は amedastable.json を参照する。下記は表示・予報取得の初期値。
    "choshi": {"name": "銚子", "latitude": 35.73833333333334, "longitude": 140.85666666666665,
                "station_id": "45148", "kind": "observation_station"},
    "wakkanai": {"name": "稚内", "latitude": 45.415, "longitude": 141.67833333333334,
              "station_id": "11016", "kind": "observation_station"},
}
PREDICTION_COLUMNS = [
    "issue_time", "target_time", "horizon_h", "station", "model",
    "observed_u_ms", "observed_v_ms", "predicted_u_ms", "predicted_v_ms",
    "observed_speed_ms", "predicted_speed_ms", "excluded", "cell_selection", "issue_basis",
    "retrieved_at_utc", "requested_latitude", "requested_longitude", "grid_latitude", "grid_longitude",
]


class SourceError(RuntimeError):
    """データを正しく取得できなかったときの、利用者向けエラー。"""


def _utc(value=None):
    stamp = pd.Timestamp.now(tz="UTC") if value is None else pd.Timestamp(value)
    if pd.isna(stamp):
        raise ValueError("日時が正しくありません。")
    return stamp.tz_localize("UTC") if stamp.tzinfo is None else stamp.tz_convert("UTC")


def _jst_naive(value):
    return _utc(value).tz_convert("Asia/Tokyo").tz_localize(None)


def _request(url, *, params=None, session=None, text=False):
    getter = requests.get if session is None else session.get
    last = None
    for _ in range(2):
        try:
            response = getter(url, params=params, timeout=30)
            response.raise_for_status()
            if text:
                return response.text.strip().strip('"')
            payload = response.json()
            if not isinstance(payload, Mapping) or payload.get("error"):
                reason = payload.get("reason", "オブジェクトではありません") if isinstance(payload, Mapping) else "オブジェクトではありません"
                raise SourceError(f"API の応答を読めません: {reason}")
            return payload
        except (requests.RequestException, ValueError, SourceError) as error:
            last = error
    raise SourceError(f"データを取得できませんでした: {url} ({last})") from last


def _check_settings(latitude, longitude, models, hours, cell_selection):
    try:
        latitude, longitude = float(latitude), float(longitude)
    except (TypeError, ValueError) as error:
        raise ValueError("緯度・経度は数値で指定してください。") from error
    if not math.isfinite(latitude) or not -90 <= latitude <= 90:
        raise ValueError("緯度は -90〜90 度で指定してください。")
    if not math.isfinite(longitude) or not -180 <= longitude <= 180:
        raise ValueError("経度は -180〜180 度で指定してください。")
    if isinstance(hours, bool) or not isinstance(hours, (int, np.integer)) or not 1 <= hours <= 72:
        raise ValueError("予測する長さは 1〜72 時間の整数で指定してください。")
    if isinstance(models, str):
        models = (models,)
    else:
        models = tuple(models)
    if not 1 <= len(models) <= 8 or len(set(models)) != len(models):
        raise ValueError("モデルは重複なしで1〜8種類指定してください。")
    if any(not isinstance(model, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", model) for model in models):
        raise ValueError("モデル名が正しくありません。")
    if cell_selection not in {"land", "sea", "nearest"}:
        raise ValueError("格子の選び方は land・sea・nearest のいずれかです。")
    return latitude, longitude, models


def _hourly_key(hourly, name, model):
    if name in hourly:
        return name
    candidate = f"{name}_{model}"
    return candidate if candidate in hourly else name


def _number(value):
    try:
        result = float(value)
    except (ValueError, TypeError, OverflowError):
        return np.nan
    return result if np.isfinite(result) else np.nan


def _forecast_frame(payload, *, model, anchor, retrieved_at, hours, cell_selection, basis, latitude, longitude):
    hourly = payload.get("hourly", {})
    if not isinstance(hourly, Mapping):
        raise SourceError(f"{model}: 時別データがありません。")
    speed_key = _hourly_key(hourly, "wind_speed_10m", model)
    direction_key = _hourly_key(hourly, "wind_direction_10m", model)
    times, speeds, directions = (hourly.get(key) for key in ("time", speed_key, direction_key))
    if not all(isinstance(values, list) for values in (times, speeds, directions)) or not times or not len(times) == len(speeds) == len(directions):
        raise SourceError(f"{model}: 時刻・風速・風向の並びが一致しません。")
    units = payload.get("hourly_units", {})
    if not isinstance(units, Mapping):
        raise SourceError(f"{model}: 風速・風向の単位を確認できません。")
    if units.get(speed_key) != "m/s" or units.get(direction_key) not in {"°", "degree", "degrees"}:
        raise SourceError(f"{model}: 風速・風向の単位を確認できません。")
    try:
        valid_times = pd.to_datetime(times, unit="s", utc=True, errors="raise")
    except (ValueError, TypeError, OverflowError) as error:
        raise SourceError(f"{model}: 予報の時刻を読めません。") from error
    if valid_times.has_duplicates or not valid_times.is_monotonic_increasing:
        raise SourceError(f"{model}: 予報の時刻が重複または逆転しています。")
    rows = []
    for target, raw_speed, raw_direction in zip(valid_times, speeds, directions):
        lead = (target - anchor).total_seconds() / 3600
        if not 0 < lead <= hours:
            continue
        speed, direction = _number(raw_speed), _number(raw_direction)
        if not 0 <= speed <= 150:
            speed = np.nan
        if not 0 <= direction <= 360:
            direction = np.nan
        if np.isfinite(speed) and speed <= wp.CALM_SPEED_MS:
            u, v = 0.0, 0.0
        elif np.isfinite(speed) and np.isfinite(direction):
            u, v = wp.wind_to_uv(np.array([speed]), np.array([direction % 360]))
            u, v = float(u[0]), float(v[0])
        else:
            u, v = np.nan, np.nan
        rows.append({
            "issue_time": _jst_naive(anchor), "target_time": _jst_naive(target),
            "horizon_h": lead, "station": "指定地点", "model": model,
            "observed_u_ms": np.nan, "observed_v_ms": np.nan,
            "predicted_u_ms": u, "predicted_v_ms": v, "observed_speed_ms": np.nan,
            "predicted_speed_ms": speed,
            # 風向だけが欠測でも、提供元の風速は速度の採点に利用できる。
            "excluded": "" if np.isfinite(speed) else "missing_forecast",
            "cell_selection": cell_selection, "issue_basis": basis,
            "retrieved_at_utc": retrieved_at.isoformat(),
            "requested_latitude": latitude, "requested_longitude": longitude,
            "grid_latitude": _number(payload.get("latitude")),
            "grid_longitude": _number(payload.get("longitude")),
        })
    if not rows:
        raise SourceError(f"{model}: 指定した時間範囲の予報がありません。")
    return pd.DataFrame(rows, columns=PREDICTION_COLUMNS)


def _fetch(latitude, longitude, *, models, hours, cell_selection, fetched_at, run_time_utc, session):
    latitude, longitude, models = _check_settings(latitude, longitude, models, hours, cell_selection)
    retrieved_at = _utc(fetched_at)
    anchor = retrieved_at if run_time_utc is None else _utc(run_time_utc)
    if run_time_utc is not None and (anchor.minute or anchor.second or anchor.microsecond):
        raise ValueError("モデル初期時刻は UTC の毎正時で指定してください。")
    basis = "retrieval_time" if run_time_utc is None else "initialisation_time"
    endpoint = FORECAST_API if run_time_utc is None else SINGLE_RUN_API
    frames, sources, warnings = [], [], []
    for model in models:
        params = {"latitude": latitude, "longitude": longitude, "models": model,
                  "cell_selection": cell_selection, "hourly": "wind_speed_10m,wind_direction_10m",
                  "wind_speed_unit": "ms", "timezone": "UTC", "timeformat": "unixtime",
                  "forecast_days": min(5, math.ceil(hours / 24) + 1)}
        if run_time_utc is not None:
            params["run"] = anchor.strftime("%Y-%m-%dT%H:%M")
        try:
            payload = _request(endpoint, params=params, session=session)
            frame = _forecast_frame(payload, model=model, anchor=anchor, retrieved_at=retrieved_at,
                                    hours=hours, cell_selection=cell_selection, basis=basis,
                                    latitude=latitude, longitude=longitude)
        except SourceError as error:
            warnings.append(f"{model}: {error}")
            sources.append({"model": model, "status": "unavailable", "n_rows": 0, "n_available": 0})
            continue
        frames.append(frame)
        good = frame[frame["excluded"].eq("")]
        sources.append({"model": model, "grid_latitude": _number(payload.get("latitude")),
                        "grid_longitude": _number(payload.get("longitude")),
                        "n_rows": len(frame), "n_available": len(good),
                        "available_horizon_max_h": float(good["horizon_h"].max()) if len(good) else None})
    if not frames:
        raise SourceError("指定したモデルの予報を取得できませんでした。" + " / ".join(warnings))
    result = pd.concat(frames, ignore_index=True)
    result.attrs["metadata"] = {
        "source": "Open-Meteo", "source_url": endpoint, "attribution": "Weather data by Open-Meteo.com; originating models: " + ", ".join(models),
        "data_kind": "numerical_weather_forecast", "time_zone": "Asia/Tokyo (timezone-naive columns)",
        "requested_latitude": latitude, "requested_longitude": longitude,
        "issue_basis": basis, "retrieved_at_utc": retrieved_at.isoformat(),
        "initialisation_time_utc": anchor.isoformat() if run_time_utc is not None else None,
        "availability_time_utc": None, "requested_hours": int(hours), "cell_selection": cell_selection,
        "models": sources, "warnings": warnings,
        "note": ("取得時刻からの時間差。モデルの初期時刻・発表時刻ではありません。" if run_time_utc is None else
                 "モデル初期時刻からの時間差。初期時刻に一般公開済みだったことは保証しません。"),
    }
    return result


def fetch_forecasts(latitude, longitude, *, models=("jma_msm", "ecmwf_ifs025"), hours=24,
                    cell_selection="land", fetched_at=None, session=None):
    """最新予報を取得する。horizon_h は取得時刻からの正確な時間差。"""
    return _fetch(latitude, longitude, models=models, hours=hours, cell_selection=cell_selection,
                  fetched_at=fetched_at, run_time_utc=None, session=session)


def fetch_single_run(latitude, longitude, *, run_time_utc, models=("jma_msm", "ecmwf_ifs025"),
                     hours=24, cell_selection="land", session=None):
    """UTC初期時刻を指定して個別runを取得する。日時文字列のUTC省略形も受け付ける。"""
    return _fetch(latitude, longitude, models=models, hours=hours, cell_selection=cell_selection,
                  fetched_at=None, run_time_utc=run_time_utc, session=session)


def match_observations(forecasts, weather, *, station=None):
    """同一地点の観測を対象時刻で厳密に照合する。地点間の補間は行わない。

    座標メタデータがある場合は地点の一致も確認する。ないCSVでは呼び出す側が確認する。
    時間の近似照合をせず、予測対象時刻に実測がなければ未評価のままにする。
    """
    forecast_meta = forecasts.attrs.get("metadata", {})
    weather_meta = weather.attrs.get("metadata", {})
    observed = [_number(weather_meta.get("latitude")), _number(weather_meta.get("longitude"))]
    if np.isfinite(observed).all():
        # attrs はCSV保存・履歴結合で失われるため、行に保存した取得要求座標を優先する。
        for column, expected in zip(("requested_latitude", "requested_longitude"), observed):
            requested = (pd.to_numeric(forecasts[column], errors="coerce") if column in forecasts
                         else pd.Series(_number(forecast_meta.get(column)), index=forecasts.index))
            if (requested.notna() & ((requested - expected).abs() > 0.01)).any():
                raise ValueError("予報を取得した地点と観測所が異なります。観測所の座標で予報を取得してください。")
    observed_station = str(weather.attrs.get("station", "")).strip()
    target_station = str(station).strip() if station is not None else observed_station
    if station is not None and observed_station and observed_station != target_station:
        raise ValueError("指定した地点名と観測データの地点名が異なります。")
    if "station" in forecasts:
        known_stations = set(forecasts["station"].dropna().astype(str).str.strip()) - {"", "指定地点"}
        if len(known_stations) > 1:
            raise ValueError("予報履歴に複数の地点が混在しています。地点ごとに分けて照合してください。")
        if known_stations and target_station and known_stations != {target_station}:
            raise ValueError("予報履歴の地点名と照合する観測所が異なります。")
    result = forecasts.copy()
    if not isinstance(weather.index, pd.DatetimeIndex) or weather.index.tz is not None:
        raise ValueError("観測時刻はタイムゾーンなしのJST DatetimeIndexにしてください。")
    if weather.index.has_duplicates:
        raise ValueError("観測時刻が重複しています。先に履歴を整理してください。")
    for column in ("u_ms", "v_ms", "wind_speed_ms"):
        if column not in weather:
            raise ValueError(f"観測に {column} がありません。")
    target = pd.to_datetime(result["target_time"], errors="raise")
    if target.dt.tz is not None:
        raise ValueError("予測対象時刻はタイムゾーンなしのJSTにしてください。")
    matched = weather.reindex(pd.DatetimeIndex(target))
    result["observed_u_ms"] = matched["u_ms"].to_numpy()
    result["observed_v_ms"] = matched["v_ms"].to_numpy()
    result["observed_speed_ms"] = matched["wind_speed_ms"].to_numpy()
    if target_station:
        result["station"] = target_station
    result.attrs = forecasts.attrs.copy()
    result.attrs["metadata"] = {**forecasts.attrs.get("metadata", {}),
                                "observation_station": station or weather.attrs.get("station", ""),
                                "observation_matching": "exact_target_time", "observation_source": weather.attrs.get("metadata", {})}
    return result


def merge_forecast_history(*frames):
    """取得回を保持したまま履歴を結合する。同じ取得回の重複だけ後勝ちで除く。"""
    tables = [frame for frame in frames if frame is not None and len(frame)]
    if not tables:
        return pd.DataFrame(columns=PREDICTION_COLUMNS)
    result = pd.concat(tables, ignore_index=True)
    for column in ("issue_time", "target_time"):
        result[column] = pd.to_datetime(result[column], errors="raise")
        if result[column].dt.tz is not None:
            raise ValueError("履歴の日時はタイムゾーンなしのJSTにそろえてください。")
    keys = [name for name in ("station", "model", "issue_basis", "cell_selection", "requested_latitude", "requested_longitude", "grid_latitude", "grid_longitude", "issue_time", "target_time") if name in result]
    result = result.drop_duplicates(keys, keep="last").sort_values(["issue_time", "target_time", "model"]).reset_index(drop=True)
    result.attrs["metadata"] = {"history_snapshots": int(result["issue_time"].nunique()), "source_metadata": [frame.attrs.get("metadata", {}) for frame in tables]}
    return result


def _amedas_value(record, name):
    item = record.get(name)
    if not isinstance(item, list) or len(item) < 2:
        return np.nan, None
    # 公開JSONの品質フラグは0だけを使う。未知のフラグを正常扱いしない。
    return (_number(item[0]) if item[1] == 0 else np.nan), item[1]


def _station_metadata(station_id, *, session):
    table = _request(f"{AMEDAS_BASE}/const/amedastable.json", session=session)
    station = table.get(station_id)
    if not isinstance(station, Mapping):
        raise SourceError(f"アメダス地点 {station_id} がありません。")
    try:
        latitude = float(station["lat"][0]) + float(station["lat"][1]) / 60
        longitude = float(station["lon"][0]) + float(station["lon"][1]) / 60
    except (KeyError, TypeError, ValueError, IndexError) as error:
        raise SourceError("観測所の座標を確認できません。") from error
    if not (np.isfinite([latitude, longitude]).all() and -90 <= latitude <= 90 and -180 <= longitude <= 180):
        raise SourceError("観測所の座標が範囲外です。")
    return {"station_id": station_id, "station_name": station.get("kjName", station_id),
            "latitude": latitude, "longitude": longitude,
            "altitude_m": station.get("alt"), "source_url": f"{AMEDAS_BASE}/const/amedastable.json"}


def fetch_recent_amedas(station_id, *, hours=72, session=None):
    """アメダスの最近の毎正時観測を読む（最大72時間、最大25個の3時間ファイル）。

    気象庁防災情報の公開JSONを利用する。長期学習には公式の過去データCSVを使う。
    一部のファイルが取得できない場合は欠測として残し、metadata['warnings']に記録する。
    """
    station_id = str(station_id)
    if not re.fullmatch(r"\d{5}", station_id):
        raise ValueError("アメダス地点番号は5桁で指定してください。")
    if isinstance(hours, bool) or not isinstance(hours, (int, np.integer)) or not 1 <= hours <= 72:
        raise ValueError("最近の観測は1〜72時間の整数で指定してください。")
    station = _station_metadata(station_id, session=session)
    latest_text = _request(f"{AMEDAS_BASE}/data/latest_time.txt", session=session, text=True)
    try:
        latest = _utc(latest_text).tz_convert("Asia/Tokyo")
    except (ValueError, TypeError) as error:
        raise SourceError("アメダスの最新時刻を読めません。") from error
    end = latest.floor("h").tz_localize(None)
    start = end - pd.Timedelta(hours=hours - 1)
    block = start.floor("3h")
    final_block = latest.floor("3h").tz_localize(None)
    rows, warnings = [], []
    while block <= final_block:
        url = f"{AMEDAS_BASE}/data/point/{station_id}/{block.strftime('%Y%m%d_%H')}.json"
        try:
            payload = _request(url, session=session)
        except SourceError as error:
            warnings.append(str(error))
            block += pd.Timedelta(hours=3)
            continue
        for key, record in payload.items():
            if not re.fullmatch(r"\d{14}", str(key)) or not isinstance(record, Mapping):
                continue
            try:
                stamp = pd.to_datetime(key, format="%Y%m%d%H%M%S", errors="raise")
            except ValueError:
                continue
            if not (start <= stamp <= end and block <= stamp < block + pd.Timedelta(hours=3)) or stamp.minute or stamp.second:
                continue
            speed, wind_flag = _amedas_value(record, "wind")
            direction, direction_flag = _amedas_value(record, "windDirection")
            if not 0 <= speed <= 150:
                speed = np.nan
            if np.isfinite(speed) and speed <= wp.CALM_SPEED_MS:
                label = wp.CALM_LABEL
            elif np.isfinite(direction) and direction.is_integer() and 1 <= direction <= 16:
                label = wp.DIRECTION_LABELS[int(direction) % 16]
            else:
                label = np.nan
            row = {"time": stamp, "wind_speed_ms": speed, "wind_direction": label,
                   "amedas_wind_flag": wind_flag, "amedas_direction_flag": direction_flag}
            temperature, temp_flag = _amedas_value(record, "temp")
            row["temperature_c"] = temperature
            row["amedas_temperature_flag"] = temp_flag
            rows.append(row)
        block += pd.Timedelta(hours=3)
    if not rows or not any(np.isfinite(row["wind_speed_ms"]) for row in rows):
        raise SourceError(f"{station['station_name']}: 指定期間の有効な風速観測がありません。")
    raw = pd.DataFrame(rows).drop_duplicates("time", keep="last").set_index("time").sort_index()
    weather = wp.prepare_weather(raw).reindex(pd.date_range(start, end, freq="h", name="time"))
    weather["wind_is_calm"] = weather["wind_is_calm"].eq(True)
    weather.attrs["station"] = station["station_name"]
    weather.attrs["source_kind"] = "observations"
    weather.attrs["metadata"] = {**station, "source": "JMA AMeDAS", "data_kind": "station_observation",
                                  "source_url": f"{AMEDAS_BASE}/data/point/{station_id}/",
                                  "time_zone": "Asia/Tokyo (timezone-naive index)",
                                  "latest_published_time_utc": latest.tz_convert("UTC").isoformat(),
                                  "quality_policy": "JSON flag 0 only; preserve other flags and mark missing",
                                  "n_expected_hours": hours, "n_observed_hours": int(weather["wind_speed_ms"].notna().sum()),
                                  "warnings": warnings,
                                  "note": "観測所の実測です。沿岸の例示地点の現地観測ではありません。"}
    return weather
