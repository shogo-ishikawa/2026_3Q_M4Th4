"""解析結果と入力を、Webと次回のColabで読める形で保存する。"""

import io
import json
from pathlib import Path
import zipfile

import numpy as np
import pandas as pd

from . import __version__, environment_info
from . import wind_pipeline as wp

SCHEMA_VERSION = "1.0.0"
TIMEZONE = "Asia/Tokyo"
MAX_MEMBER_BYTES = 100 * 1024 * 1024


def json_value(value):
    """日時・NumPyの数をJSONで読める値にする。"""
    if isinstance(value, dict):
        return {str(key): json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, np.ndarray)):
        return [json_value(item) for item in value]
    if isinstance(value, (pd.Timestamp, Path)):
        return str(value)
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, float) and not np.isfinite(value):
        return None
    if value is pd.NaT:
        return None
    return value


def local_times(values):
    """明示された時差はJSTへ変換し、内部では時差なしのJSTにそろえる。"""
    times = pd.DatetimeIndex(pd.to_datetime(values))
    if times.isna().any():
        raise ValueError("日時に空欄があります。すべての観測・予報に日時を指定してください。")
    if times.tz is not None:
        times = times.tz_convert(TIMEZONE).tz_localize(None)
    return times


def portable_csv(table):
    """日時の列を +09:00 付きISO表記にし、数値の精度を保つ。"""
    table = table.copy()
    for name in ("issue_time", "target_time", "observed_at"):
        if name in table:
            times = local_times(table[name])
            table[name] = [time.tz_localize(TIMEZONE).isoformat() if pd.notna(time) else "" for time in times]
    return table.to_csv(index=False, encoding="utf-8", float_format="%.12g")


def _member(archive, name):
    """自分たちの出力形式の必要なファイルだけを読む。展開はしない。"""
    info = archive.getinfo(name)
    if info.file_size > MAX_MEMBER_BYTES:
        raise ValueError(f"{name} が大きすぎます。期間を分けて読み込んでください。")
    return archive.read(info)


def _prepared_observations(data, metadata=None):
    if metadata is not None and not isinstance(metadata, dict):
        raise ValueError("保存データのmetadata.jsonはオブジェクト形式である必要があります。")
    raw = pd.read_csv(io.BytesIO(data))
    required = {"observed_at", "wind_speed_ms", "wind_direction"}
    if not required.issubset(raw):
        raise ValueError("このCSVは本ラボが出力した観測履歴ではありません。")
    try:
        raw["wind_speed_ms"] = pd.to_numeric(raw["wind_speed_ms"], errors="raise")
    except (ValueError, TypeError) as error:
        raise ValueError("観測風速に数値ではない値があります。") from error
    known_speed = raw["wind_speed_ms"].dropna()
    if not (np.isfinite(known_speed).all() and known_speed.between(0, 150).all()):
        raise ValueError("観測風速は0〜150 m/sの有限な値、または欠測にしてください。")
    raw.index = local_times(raw.pop("observed_at"))
    raw.index.name = "time"
    if raw.index.has_duplicates:
        raise ValueError("観測履歴に同じ時刻が複数あります。地点の混在を確認してください。")
    # 保存済みのu/vを信用せず、風速・風向と品質情報から再計算する。
    raw = raw.drop(columns=["u_ms", "v_ms", "wind_direction_deg", "wind_is_calm"], errors="ignore")
    attrs = (metadata or {}).get("observation_metadata", {})
    if not isinstance(attrs, dict):
        raise ValueError("観測履歴のメタデータを読み込めません。")
    attrs = attrs.copy()
    if "station" in raw:
        station_values = raw.pop("station").fillna("").astype(str).str.strip()
        if station_values.eq("").any():
            raise ValueError("観測履歴の地点名に空欄があります。地点を確認してください。")
        stations = station_values.unique()
        if len(stations) > 1:
            raise ValueError("複数の観測地点が含まれています。地点ごとに読み込んでください。")
        if len(stations):
            if attrs.get("station") and attrs["station"] != stations[0]:
                raise ValueError("観測CSVとメタデータの地点が一致しません。")
            attrs["station"] = stations[0]
    source_kind = attrs.get("source_kind") or (metadata or {}).get("observation_source_kind")
    if source_kind is None and (metadata or {}).get("source_kind") == "synthetic":
        source_kind = "synthetic"
    if "source_kind" in raw:
        kinds = raw.pop("source_kind").fillna("").astype(str).str.strip().unique()
        if len(kinds) != 1 or not kinds[0]:
            raise ValueError("合成データと実観測の区分が混在、または空欄になっています。")
        if source_kind and source_kind != kinds[0]:
            raise ValueError("観測CSVとメタデータのデータ区分が一致しません。")
        source_kind = kinds[0]
    if source_kind:
        attrs["source_kind"] = source_kind
    raw.attrs.update(attrs)
    raw.attrs["station"] = attrs.get("station", (metadata or {}).get("station", ""))
    if not raw.attrs["station"]:
        raise ValueError("観測履歴の地点を確認できません。地点名を含むCSVか結果ZIPを選んでください。")
    weather = wp.prepare_weather(raw)
    weather.attrs.update(raw.attrs)
    return weather


def load_observations(paths):
    """JMA時別CSV、またはこのラボのCSV/結果ZIPを読み、同じ地点の年を結合する。"""
    if not paths:
        raise ValueError("観測CSVか、観測履歴を含む結果ZIPを選んでください。")
    tables = []
    for value in paths:
        path = Path(value)
        if path.suffix.lower() == ".zip":
            with zipfile.ZipFile(path) as archive:
                if "observations.csv" not in archive.namelist():
                    raise ValueError(f"{path.name} には観測履歴がありません。観測CSVを追加してください。")
                metadata = json.loads(_member(archive, "metadata.json"))
                tables.append(_prepared_observations(_member(archive, "observations.csv"), metadata))
        else:
            # 自分たちの履歴CSVだけUTF-8。JMAの多段見出しやCP932は既存の読込へ渡す。
            with path.open("rb") as stream:
                is_canonical = stream.read(256).lstrip(b"\xef\xbb\xbf").startswith(b"observed_at,")
            if is_canonical:
                tables.append(_prepared_observations(path.read_bytes()))
            else:
                table = wp.load_weather(path)
                # 教材が作るJMA形式の合成CSVも、実観測と区別したまま読み込む。
                with path.open("rb") as stream:
                    first_line = stream.readline().decode("cp932", errors="replace")
                table.attrs["source_kind"] = ("synthetic" if "合成" in str(table.attrs.get("station", ""))
                                              or first_line.startswith("合成データ") else "observations")
                tables.append(table)
    kinds = {table.attrs.get("source_kind") for table in tables} - {None, "unknown"}
    if len(kinds) > 1:
        raise ValueError("合成データと実観測を同じ学習データに混ぜることはできません。")
    combined = wp.join_tables(tables, paths)
    combined.attrs.update(tables[0].attrs)
    return wp.to_hourly_index(combined)


def merge_observations(recent, historical):
    """同じ地点の新しい観測を優先して結合する。取得経路による列の違いを許す。"""
    if not recent.attrs.get("station") or recent.attrs.get("station") != historical.attrs.get("station"):
        raise ValueError("最新観測と過去のCSVの地点が一致しません。同じ観測所のCSVを選んでください。")
    kinds = {table.attrs.get("source_kind") for table in (recent, historical)} - {None, "unknown"}
    if len(kinds) > 1:
        raise ValueError("合成データと実観測を同じ学習データに混ぜることはできません。")
    recent = recent.copy()
    # JSONのQCで採用済みの値を、CSV再読込でも欠測扱いにしない。
    # 元のamedas_*_flagも残す。8は本教材の標準CSVで正常値を表す番号。
    for quality in historical.columns:
        if quality.endswith("_quality") and quality not in recent:
            element = quality[:-len("_quality")]
            if element in recent:
                recent[quality] = np.where(recent[element].notna(), 8, 0)
    combined = pd.concat([recent, historical], sort=False)
    combined = combined[~combined.index.duplicated(keep="first")].sort_index()
    combined.attrs = {**historical.attrs, **recent.attrs}
    combined.attrs["merged_quality_policy"] = "Accepted JSON observations mapped to standard quality=8; raw flags retained"
    result = wp.to_hourly_index(combined)
    result.attrs = combined.attrs.copy()
    return result


def load_forecast_history(paths):
    """結果ZIPに保存された、取得時刻ごとの予報を読み戻す。"""
    tables = []
    for value in paths:
        path = Path(value)
        if path.suffix.lower() != ".zip":
            continue
        with zipfile.ZipFile(path) as archive:
            if "forecast_history.csv" not in archive.namelist():
                continue
            table = pd.read_csv(io.BytesIO(_member(archive, "forecast_history.csv")), keep_default_na=True)
            required = {"issue_time", "target_time", "horizon_h", "station", "model", "predicted_u_ms", "predicted_v_ms"}
            if not required.issubset(table):
                raise ValueError("予報履歴に必要な列がありません。結果ZIPを確認してください。")
            for name in ("issue_time", "target_time"):
                table[name] = local_times(table[name])
            horizon = pd.to_numeric(table["horizon_h"], errors="coerce")
            actual = (table["target_time"] - table["issue_time"]).dt.total_seconds() / 3600
            if not (np.isfinite(horizon).all() and horizon.gt(0).all()
                    and np.allclose(horizon, actual, atol=1e-6, rtol=0)):
                raise ValueError("予報履歴の時間先と、予測起点・対象時刻が一致しません。")
            table["horizon_h"] = horizon
            if "excluded" in table:
                table["excluded"] = table["excluded"].fillna("")
            tables.append(table)
    return tables


def export_result(result, output_dir, *, weather=None):
    """再解析用の履歴を含むZIPを作る。学習モデルの再読込は提供しない。"""
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    metadata = {
        "schema_version": SCHEMA_VERSION,
        "timezone": TIMEZONE,
        "bias_definition": "predicted_minus_observed",
        "runtime": environment_info(Path(__file__).resolve().parents[2]),
        **result.get("metadata", {}),
    }
    files = []
    tables = {"predictions": result["predictions"], "summary": result["summary"],
              "skill": result["skill"]}
    for key in ("validation_predictions", "selection_scores", "forecast_history", "learning_curve"):
        if key in result and isinstance(result[key], pd.DataFrame):
            tables[key] = result[key]
    for group, table in result.get("grouped", {}).items():
        tables[f"errors_by_{group}"] = table
    if weather is not None:
        observations = weather.copy()
        kind = weather.attrs.get("source_kind") or metadata.get("observation_source_kind")
        if kind is None:
            kind = "synthetic" if metadata.get("source_kind") == "synthetic" else "observations"
        observations.insert(0, "source_kind", kind)
        observations.insert(0, "station", weather.attrs.get("station", metadata.get("station", "")))
        observations.insert(0, "observed_at", weather.index)
        tables["observations"] = observations
        metadata["observation_metadata"] = dict(weather.attrs)
        metadata["observation_metadata"]["source_kind"] = kind
        metadata["observation_metadata"].setdefault("station", metadata.get("station", ""))
    for name, table in tables.items():
        target = output / f"{name}.csv"
        target.write_text(portable_csv(table), encoding="utf-8-sig")
        files.append(target)
    metadata_file = output / "metadata.json"
    metadata_file.write_text(json.dumps(json_value(metadata), ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    files.append(metadata_file)
    readme = output / "README.txt"
    readme.write_text(
        f"海岸の風速・風向予報ラボ v{__version__}\n"
        "日時はAsia/Tokyo（CSVには+09:00）。風速m/s、風向は風の来る方向。\n"
        "合成データ/実観測/気象モデルはmetadata.jsonのsource_kindで区別します。\n"
        "予測対象に観測がない行は未評価です。空欄は誤差ゼロを意味しません。\n"
        "speed_bias_ms=予測−観測（正なら強く予測）。\n"
        "observations.csvを含むZIPは次回の観測入力として読み込めます。\n"
        "forecast_history.csvは取得時刻別の予報履歴です。\n"
        "学習済みモデルは同じ環境での保存用です。モデルを取り込む機能はありません。\n"
        "公開前に入力データの出典と公開可能な範囲を確認してください。\n", encoding="utf-8")
    files.append(readme)
    # 再利用は入力・条件からの再学習を基本にする。実行中に作ったモデルだけ任意保存。
    if result.get("models"):
        import joblib
        model_file = output / "models.joblib"
        joblib.dump(result["models"], model_file)
        files.append(model_file)
    for value in result.get("figures", []):
        figure = Path(value).resolve()
        if figure.is_file() and figure.is_relative_to(output.resolve()):
            files.append(figure)
    destination = output / f"coastal_wind_result_v{__version__}.zip"
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file in files:
            archive.write(file, file.relative_to(output).as_posix())
    return destination
