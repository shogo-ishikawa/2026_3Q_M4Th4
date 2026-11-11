"""ColabとCLIに共通の入口。取得・学習・評価・保存を順に実行する。"""

from datetime import datetime
from pathlib import Path
import uuid
import zipfile

import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np
import pandas as pd

from . import plotting, sample_data, wind_pipeline as wp
from . import forecast_diagnostics as diagnostics
from . import forecast_lab as lab
from . import forecast_sources as sources
from .forecast_export import export_result, load_forecast_history, load_observations, merge_observations

MODES = ("demo", "csv_backtest", "latest_forecast", "historical_forecast", "future")


def _observation_inputs(paths):
    """予報だけを保存したZIPは、観測入力には数えない。"""
    selected = []
    for value in paths:
        path = Path(value)
        if path.suffix.lower() != ".zip":
            selected.append(path)
        else:
            with zipfile.ZipFile(path) as archive:
                if "observations.csv" in archive.namelist():
                    selected.append(path)
    return selected


def _source_kind(weather):
    name = str(weather.attrs.get("station", ""))
    if "合成" in name or weather.attrs.get("source_kind") == "synthetic":
        return "synthetic"
    return "observations"


def _coordinates(options, weather=None):
    latitude, longitude = options.get("latitude"), options.get("longitude")
    if latitude is None or longitude is None:
        metadata = weather.attrs.get("metadata", weather.attrs) if weather is not None else {}
        latitude = metadata.get("latitude", metadata.get("latitude_deg"))
        longitude = metadata.get("longitude", metadata.get("longitude_deg"))
        if latitude is None or longitude is None:
            station = weather.attrs.get("station") if weather is not None else None
            preset = next((value for value in sources.LOCATIONS.values() if value["name"] == station), None)
            if preset is not None:
                latitude, longitude = preset["latitude"], preset["longitude"]
            elif weather is not None:
                raise ValueError("この観測地点の緯度・経度を指定してください。別地点の座標は代用しません。")
            else:
                latitude, longitude = 35.3062, 139.5488
    return float(latitude), float(longitude)


def _learning_curve(weather, options, result):
    """最終テスト期間を固定し、学習に使う過去の長さだけを変えて比較する。"""
    months = options.get("learning_curve_months", [])
    if not months:
        return pd.DataFrame()
    rows = []
    split = result["split"]
    for length in sorted(set(int(value) for value in months)):
        if length < 2 or length > 120:
            raise ValueError("学習期間の比較は2〜120か月で指定してください。")
        train_start = pd.Timestamp(split["validation_start"]) - pd.DateOffset(months=length)
        if train_start < weather.index.min():
            continue
        trial = lab.run_backtest(
            weather, horizons=[3], train_start=train_start,
            validation_start=split["validation_start"], test_start=split["test_start"],
            end=split["end"], candidates=options.get("candidates", ("linear", "boosting_shallow")),
            feature_set=options.get("feature_set", "calendar+recent"),
            include_optional=options.get("include_optional", False), seed=options.get("seed", 2026),
        )
        scores = diagnostics.summarise_errors(trial["predictions"])
        scores.insert(0, "training_months", length)
        rows.append(scores)
    return pd.concat(rows, ignore_index=True) if rows else pd.DataFrame()


def _plot_pending(predictions, directory, language):
    """実測がまだない予報も表示する。最後の取得回を選び、誤差図とは区別する。"""
    figure, axes = plt.subplots(2, 1, figsize=(11, 6), sharex=True,
                                gridspec_kw={"height_ratios": [3, 2]}, layout="constrained")
    plotted = False
    for number, (model, series) in enumerate(predictions.groupby("model", sort=False)):
        series = series[series["issue_time"].eq(series["issue_time"].max())].sort_values("target_time")
        speed = np.hypot(series["predicted_u_ms"], series["predicted_v_ms"])
        if "predicted_speed_ms" in series:
            speed = series["predicted_speed_ms"].fillna(speed)
        good = np.isfinite(speed)
        if not good.any():
            continue
        plotted = True
        colour = f"C{number % 10}"
        label = wp.model_label(model, language=language)
        axes[0].plot(series["target_time"], speed, marker="o", markersize=3, color=colour, label=label)
        u, v = series["predicted_u_ms"].to_numpy(), series["predicted_v_ms"].to_numpy()
        vector_speed = np.hypot(u, v)
        moving = np.isfinite(vector_speed) & (vector_speed > wp.CALM_SPEED_MS)
        axes[1].quiver(mdates.date2num(series.loc[moving, "target_time"]),
                       np.full(int(moving.sum()), number), u[moving] / vector_speed[moving],
                       v[moving] / vector_speed[moving], color=colour, angles="uv",
                       scale_units="inches", scale=3, pivot="middle", width=0.003)
    if not plotted:
        plt.close(figure)
        return []
    axes[0].set_ylabel("予測風速（m/s）" if language == "ja" else "Predicted wind speed (m/s)")
    axes[0].set_title("予報の比較（対象時刻の実測による採点前）" if language == "ja" else "Forecast comparison — not yet verified")
    axes[0].legend(fontsize=8)
    axes[0].grid(alpha=0.2)
    axes[1].set_yticks(range(predictions["model"].nunique()),
                      [wp.model_label(name, language=language) for name in predictions["model"].unique()], fontsize=8)
    axes[1].set_ylim(-0.8, predictions["model"].nunique() - 0.2)
    axes[1].set_xlabel("対象時刻（日本時間）／矢印は風が進む向き（北は上）" if language == "ja" else "Target time (JST) / arrows show wind movement (north is up)")
    axes[1].xaxis.set_major_formatter(mdates.DateFormatter("%m/%d %H:%M"))
    figure.autofmt_xdate()
    path = Path(directory) / "unverified_forecasts.png"
    figure.savefig(path, dpi=150, bbox_inches="tight")
    plt.close(figure)
    return [path]


def run_analysis(mode="demo", observation_paths=None, options=None, output_dir="results/forecast-lab"):
    """利用者が選んだモードを1回実行し、表・図・ダウンロード用ZIPを返す。

    mode: demo / csv_backtest / latest_forecast / historical_forecast / future。
    optionsの日時はJST。run_time_utcだけは、気象モデルの初期時刻をUTCで指定する。
    出力は毎回別フォルダに作り、前回の図や精度表と混ざらないようにする。
    """
    if mode not in MODES:
        raise ValueError(f"モードは {', '.join(MODES)} から選んでください。")
    options = dict(options or {})
    paths = list(observation_paths or [])
    observation_inputs = _observation_inputs(paths)
    weather = load_observations(observation_inputs) if observation_inputs else None
    station = options.get("station") or (weather.attrs.get("station") if weather is not None else "材木座")
    messages = []
    horizons = options.get("horizons", (1, 3, 6, 12, 24))

    if mode == "demo":
        weather = sample_data.generate_weather(years=3, seed=options.get("seed", 2026))
        weather.attrs["station"] = "仮想海辺観測点（合成）"
        weather.attrs["source_kind"] = "synthetic"
        station = weather.attrs["station"]
        messages.append("これは仮想地点の合成データです。材木座・辻堂・三浦の実測値ではありません。")

    if mode in ("demo", "csv_backtest"):
        if weather is None:
            raise ValueError("過去検証には、同じ地点の観測CSVか観測履歴ZIPが必要です。")
        station = weather.attrs.get("station") or station
        result = lab.run_backtest(
            weather, horizons=horizons, station=station,
            train_start=options.get("train_start"), validation_start=options.get("validation_start"),
            test_start=options.get("test_start"), end=options.get("end"),
            candidates=options.get("candidates", ("linear", "boosting_shallow")),
            feature_set=options.get("feature_set", "calendar+recent"),
            include_optional=options.get("include_optional", False), seed=options.get("seed", 2026),
        )
        result["learning_curve"] = _learning_curve(weather, options, result)
    elif mode == "future":
        if options.get("use_recent_observations"):
            station_id = options.get("station_id")
            if not station_id:
                raise ValueError("最新観測を使う場合はアメダスの地点番号が必要です。")
            recent = sources.fetch_recent_amedas(station_id, hours=72)
            if weather is None:
                raise ValueError("最新3日分だけでは学習期間が足りません。同じ地点の過去観測CSVも選んでください。")
            weather = merge_observations(recent, weather)
        if weather is None:
            raise ValueError("将来予測には、学習に使う観測CSVか観測履歴ZIPが必要です。")
        station = weather.attrs.get("station") or station
        result = lab.forecast_future(
            weather, horizons=horizons, station=station, cutoff=options.get("cutoff"),
            train_start=options.get("train_start"), selected_methods=options.get("selected_methods"),
            feature_set=options.get("feature_set", "calendar+recent"),
            include_optional=options.get("include_optional", False), seed=options.get("seed", 2026),
        )
        messages.append("予測対象時刻の実測がないため、この予測の精度はまだ採点していません。")
    else:
        if mode == "latest_forecast" and options.get("use_recent_observations"):
            if not options.get("station_id"):
                raise ValueError("最新観測を使う場合はアメダスの地点番号が必要です。")
            recent = sources.fetch_recent_amedas(options["station_id"], hours=72)
            weather = recent if weather is None else merge_observations(recent, weather)
            if weather.attrs.get("station") != station:
                raise ValueError("指定した予報地点と最新観測の地点が異なります。観測所を選んでください。")
        latitude, longitude = _coordinates(options, weather)
        arguments = dict(models=options.get("models", ("jma_msm", "ecmwf_ifs025")),
                         hours=options.get("hours", 24), cell_selection=options.get("cell_selection", "land"))
        if mode == "historical_forecast":
            if weather is None:
                raise ValueError("過去の気象予報の検証には、同じ地点の観測CSVが必要です。")
            if not options.get("run_time_utc"):
                raise ValueError("計算の初期時刻をUTCで指定してください。")
            predictions = sources.fetch_single_run(latitude, longitude,
                                                   run_time_utc=options["run_time_utc"], **arguments)
        else:
            predictions = sources.fetch_forecasts(latitude, longitude, **arguments)
        source_metadata = dict(predictions.attrs.get("metadata", {}))
        predictions["station"] = station
        predictions["weather_model"] = predictions["model"]
        predictions["model"] = predictions["model"].astype(str) + ":" + predictions["cell_selection"].astype(str)
        # 違う場所の観測を海岸そのものの正解にしない。地点と座標を利用者が明示して検証する。
        if weather is not None:
            observed_station = str(weather.attrs.get("station", ""))
            if observed_station and observed_station != station:
                raise ValueError(f"予報地点「{station}」と観測地点「{observed_station}」が異なります。観測地点の予報を取得してください。")
        history_frames = load_forecast_history(paths)
        for previous in history_frames:
            stations = previous["station"].dropna().astype(str).unique()
            if any(name != station for name in stations):
                raise ValueError("保存した予報履歴の地点と、今回の予報地点が異なります。地点ごとに解析してください。")
            for column, expected in (("requested_latitude", latitude), ("requested_longitude", longitude)):
                if column in previous:
                    values = pd.to_numeric(previous[column], errors="coerce").dropna()
                    if len(values) and not np.allclose(values, expected, atol=1e-7, rtol=0):
                        raise ValueError("予報履歴と今回の要求座標が異なります。地点ごとに解析してください。")
        history = sources.merge_forecast_history(*history_frames, predictions)
        if weather is not None:
            history = sources.match_observations(history, weather, station=station)
        result = {"predictions": history, "forecast_history": history.copy(),
                  "metadata": {**source_metadata, "station": station,
                               "forecast_latitude": latitude, "forecast_longitude": longitude}}
        if weather is None or not np.isfinite(pd.to_numeric(history["observed_u_ms"], errors="coerce")).any():
            messages.append("照合できる観測がまだありません。予報履歴を保存し、対象時刻後の観測と照合してください。")

    predictions = diagnostics.add_errors(result["predictions"])
    result["predictions"] = predictions
    result["summary"] = diagnostics.summarise_errors(predictions)
    result["grouped"] = {group: diagnostics.grouped_errors(predictions, by=group)
                         for group in ("month", "hour", "direction", "speed_band")}
    result["skill"] = diagnostics.skill_against_baseline(
        predictions, n_bootstrap=options.get("n_bootstrap", 200), seed=options.get("seed", 2026))
    # 計算時の条件と実際の入力範囲を保存する。個人のファイルパスは記録しない。
    metadata = result.setdefault("metadata", {})
    metadata.update({"mode": mode, "station": station, "settings": options, "messages": messages,
                     "source_kind": (_source_kind(weather) if mode in ("demo", "csv_backtest", "future") else "numerical_forecast")})
    if weather is not None:
        metadata.update({"observation_start": weather.index.min(), "observation_end": weather.index.max(),
                         "observation_rows": len(weather), "observation_source_kind": _source_kind(weather)})
    if "split" in result:
        metadata["split"] = result["split"]
    if "selection" in result:
        metadata["selection"] = result["selection"]
    root = Path(output_dir)
    run_directory = root / (datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + mode + "-" + uuid.uuid4().hex[:6])
    figure_directory = run_directory / "figures"
    figure_directory.mkdir(parents=True, exist_ok=True)
    language = plotting.apply_style(verbose=False)
    result["figures"] = diagnostics.plot_diagnostics(predictions, figure_directory, language=language)
    if mode in ("latest_forecast", "historical_forecast", "future"):
        result["figures"].extend(_plot_pending(predictions, figure_directory, language))
    if "split" in result:
        figure = plotting.plot_time_split(weather, result["split"], max(horizons))
        path = figure_directory / "data_periods.png"
        figure.savefig(path, dpi=150, bbox_inches="tight")
        plt.close(figure)
        result["figures"].append(path)
    curve = result.get("learning_curve")
    if isinstance(curve, pd.DataFrame) and not curve.empty:
        figure, axis = plt.subplots(figsize=(8, 4), layout="constrained")
        for name, group in curve.groupby("model"):
            axis.plot(group["training_months"], group["speed_mae_ms"], marker="o", label=name)
        axis.set(xlabel="学習期間（月）" if language == "ja" else "Training period (months)",
                 ylabel="風速の平均絶対誤差（m/s）" if language == "ja" else "Wind speed MAE (m/s)")
        axis.legend()
        path = figure_directory / "learning_curve.png"
        figure.savefig(path, dpi=150)
        plt.close(figure)
        result["figures"].append(path)
    result["zip_path"] = export_result(result, run_directory, weather=weather)
    return result
