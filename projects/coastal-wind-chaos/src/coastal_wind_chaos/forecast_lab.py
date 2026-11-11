"""風速・風向予報ラボの共通処理。

時刻は日本標準時（JST）のタイムゾーン情報なし日時です。過去検証では、
学習→設定選択→最終テストの順に分けます。将来予測では、指定した時刻までの
観測だけを切り出してから、特徴量と教師データを作ります。
"""

from collections.abc import Mapping

import numpy as np
import pandas as pd
from threadpoolctl import threadpool_limits

from . import wind_pipeline as wp


DEFAULT_HORIZONS = (1, 3, 6, 12, 24)
MIN_TRAIN_ROWS = 24 * 30
BASELINES = tuple(wp.BASELINE_MODELS)
OPTIONAL_WEATHER_COLUMNS = (
    "temperature_c", "sea_level_pressure_hpa", "station_pressure_hpa", "sunshine_h",
)
COMMON_EXCLUSION = "other_horizon_missing"


def _time(value):
    """入力日時をJSTの日時にそろえる。終了時刻もその時刻を含む。"""
    stamp = pd.Timestamp(value)
    if pd.isna(stamp):
        raise ValueError("日時が空欄、または読み取れない値です。")
    if stamp.tzinfo is not None:
        stamp = stamp.tz_convert("Asia/Tokyo").tz_localize(None)
    return stamp


def _hours(values):
    values = tuple(values)
    if not values or any(isinstance(h, (bool, np.bool_)) or not isinstance(h, (int, np.integer))
                         or h < 1 or h > 72 for h in values):
        raise ValueError("予測時間は1〜72の整数を1つ以上指定してください。")
    return tuple(sorted(set(int(h) for h in values)))


def _weather_copy(weather, include_optional):
    if not isinstance(weather.index, pd.DatetimeIndex) or weather.empty:
        raise ValueError("日時を索引に持つ、空でない時別観測データが必要です。")
    data = weather.copy()
    if data.index.tz is not None:
        data.index = data.index.tz_convert("Asia/Tokyo").tz_localize(None)
    if not data.index.is_monotonic_increasing or data.index.has_duplicates:
        raise ValueError("観測データの日時を重複のない昇順にしてください。")
    required = {"u_ms", "v_ms", "wind_direction_deg"}
    if not required <= set(data.columns):
        raise ValueError("観測データを wind_pipeline.prepare_weather で整えてください。")
    wp.check_hourly(data)
    if not include_optional:
        data = data.drop(columns=list(OPTIONAL_WEATHER_COLUMNS), errors="ignore")
    return data


def _feature_set(value):
    value = wp.FEATURE_SET_ALIASES.get(value, value)
    wp.feature_columns(value, [])  # 未知の名前を先に検出する
    return value


def _method(value):
    """角度の直接回帰を含めず、風速も得られるu/v回帰だけを使う。"""
    method, features = wp.parse_model(str(value))
    if method not in wp.MODEL_SETTINGS or features is not None:
        raise ValueError(f"学習手法は {', '.join(wp.MODEL_SETTINGS)} から選んでください: {value}")
    return method


def _split(data, train_start, validation_start, test_start, end, max_horizon):
    start = data.index.min() if train_start is None else _time(train_start)
    last = data.index.max() if end is None else _time(end)
    if start < data.index.min() or last > data.index.max():
        raise ValueError("学習開始・解析終了は読み込んだ観測データの期間内で指定してください。")
    validation = start + pd.DateOffset(years=1) if validation_start is None else _time(validation_start)
    test = start + pd.DateOffset(years=2) if test_start is None else _time(test_start)
    if not start < validation < test <= last:
        raise ValueError("日時は 学習開始 < 調整開始 < 最終評価開始 <= 解析終了 の順で指定してください。"
                         "標準は3年分です。短いデータでは各開始日を指定してください。")
    minimum_window = pd.Timedelta(hours=max_horizon)
    if test - validation <= minimum_window or last - test < minimum_window:
        raise ValueError("調整期間と最終評価期間には、最大予測時間を超える長さが必要です。")
    return {"mode": "dates", "start": start, "validation_start": validation,
            "test_start": test, "end": last}


def _input_columns(table, in_train, feature_set):
    """実際に選んだ入力だけを要求し、基準予報との比較に必要な列を加える。"""
    recent = wp.recent_columns(table.loc[in_train]) if feature_set != "calendar" else []
    model_columns = wp.feature_columns(feature_set, recent)
    baseline_columns = ["u_lag0", "v_lag0", *wp.CYCLE_COLUMNS, *wp.CLIMATOLOGY_COLUMNS]
    evaluation_columns = list(dict.fromkeys(model_columns + baseline_columns))
    return recent, model_columns, evaluation_columns


def _prepare_stage(data, horizon, split, stage, feature_set, max_horizon):
    """選択した特徴量で学習表を作る。期間境界と比較する行は全手法でそろえる。"""
    train_start, train_end, eval_start, eval_end = wp.stage_bounds(split, stage)
    climatology = wp.fit_climatology(data, train_end, train_start)
    table = wp.add_climatology_columns(wp.make_forecast_table(data, horizon), climatology)
    in_train = (table.index >= train_start) & (table["target_time"] < train_end)
    in_eval = (table.index >= eval_start) & (table.index + pd.Timedelta(hours=max_horizon) < eval_end)
    recent, model_columns, inputs = _input_columns(table, in_train, feature_set)
    train = table.loc[in_train].dropna(subset=model_columns + ["target_u", "target_v"])
    evaluation = table.loc[in_eval].copy()
    evaluation["excluded"] = wp.exclusion_reasons(evaluation, inputs)
    wp.warn_if_optional_inputs_drop_rows(evaluation, recent)
    if len(train) < MIN_TRAIN_ROWS:
        raise ValueError(f"学習用のデータが{len(train)}行です。選択した入力と欠測を確認してください。"
                         "30日以上の学習データが必要です。")
    if not evaluation["excluded"].eq("").any():
        raise ValueError("指定した入力と期間で評価できる時刻がありません。欠測と期間を確認してください。")
    return {"train": train, "evaluation": evaluation, "recent": recent, "inputs": inputs,
            "climatology": climatology, "bounds": (train_start, train_end, eval_start, eval_end)}


def _common_stages(data, horizons, split, stage, feature_set):
    """比較する全予測時間で同じ起点・有効行を使い、除外行も保持する。"""
    stages = {h: _prepare_stage(data, h, split, stage, feature_set, max(horizons))
              for h in horizons}
    good = None
    for item in stages.values():
        usable = item["evaluation"]["excluded"].eq("")
        good = usable if good is None else good & usable
    if good is None or not good.any():
        raise ValueError("すべての予測時間で共通に評価できる観測がありません。欠測と期間を確認してください。")
    for item in stages.values():
        rows = item["evaluation"]
        rows.loc[rows["excluded"].eq("") & ~good, "excluded"] = COMMON_EXCLUSION
    return stages


def _fit_bundle(stage_data, spec, seed):
    method, features = wp.parse_model(spec)
    columns = wp.feature_columns(features, stage_data["recent"])
    train = stage_data["train"]
    regressor = wp.make_regressor(method, seed)
    with threadpool_limits(limits=1):
        regressor.fit(train[columns].to_numpy(), train[["target_u", "target_v"]].to_numpy())
    return {"spec": spec, "model": regressor, "columns": columns,
            "climatology": stage_data["climatology"],
            "train_issue_start": train.index.min(), "train_issue_end": train.index.max(),
            "train_target_end": train["target_time"].max(), "n_train": len(train)}


def _predictions(stage_data, spec, bundle=None):
    rows = stage_data["evaluation"]
    used = rows["excluded"].eq("")
    result = np.full((len(rows), 2), np.nan)
    if used.any():
        if bundle is None:
            _, u, v = wp.predict_one(spec, stage_data, rows.loc[used])
            result[used.to_numpy()] = np.column_stack([u, v])
        else:
            with threadpool_limits(limits=1):
                result[used.to_numpy()] = bundle["model"].predict(
                    rows.loc[used, bundle["columns"]].to_numpy())
    return result


def _observed_speed(data, times, fallback):
    if "wind_speed_ms" in data.columns:
        return data["wind_speed_ms"].reindex(pd.DatetimeIndex(times)).to_numpy()
    return fallback


def _long_table(data, stage_data, horizon, model, values, station):
    rows = stage_data["evaluation"]
    observed_speed = _observed_speed(data, rows["target_time"],
                                     np.hypot(rows["target_u"], rows["target_v"]).to_numpy())
    return pd.DataFrame({
        "issue_time": rows.index,
        "target_time": rows["target_time"].to_numpy(),
        "horizon_h": horizon,
        "station": station,
        "model": model,
        "observed_u_ms": rows["target_u"].to_numpy(),
        "observed_v_ms": rows["target_v"].to_numpy(),
        "observed_speed_ms": observed_speed,
        "predicted_u_ms": values[:, 0],
        "predicted_v_ms": values[:, 1],
        "excluded": rows["excluded"].to_numpy(),
    })


def _metadata(data, mode, horizons, feature_set, include_optional, seed):
    return {"mode": mode, "time_zone": "Asia/Tokyo", "time_storage": "naive_JST",
            "data_start": data.index.min().isoformat(), "data_end": data.index.max().isoformat(),
            "horizons_h": list(horizons), "feature_set": feature_set,
            "include_optional": bool(include_optional), "seed": int(seed),
            "selection_metric": "speed_mae_ms", "common_rows_across_horizons": True,
            "forecast_method": "direct_uv_regression", "future_observations_as_inputs": False}


def run_backtest(weather, *, horizons=DEFAULT_HORIZONS, train_start=None,
                 validation_start=None, test_start=None, end=None,
                 candidates=("linear", "boosting_shallow"), feature_set="calendar+recent",
                 include_optional=False, seed=2026, station=None):
    """過去検証を実行する。モデル選択は調整期間の風速MAEだけで行う。

    戻り値の predictions は最終評価、validation_predictions は設定選択の表です。
    selection は {予測時間: 選ばれた手法の名前}。models は最終評価用の学習済みモデルで、
    基準予報と同じ起点・対象時刻で比較しています。終了時刻は指定した時刻を含みます。
    """
    horizons = _hours(horizons)
    feature_set = _feature_set(feature_set)
    methods = tuple(dict.fromkeys(_method(value) for value in candidates))
    if not methods:
        raise ValueError("設定選択の候補を1つ以上指定してください。")
    data = _weather_copy(weather, include_optional)
    split = _split(data, train_start, validation_start, test_start, end, max(horizons))
    data = data.loc[split["start"]:split["end"]].copy()
    station = str(station or data.attrs.get("station", "観測地点"))
    validation_stages = _common_stages(data, horizons, split, "validation", feature_set)
    test_stages = _common_stages(data, horizons, split, "test", feature_set)
    validation_tables, test_tables, selection_rows = [], [], []
    selection, models = {}, {}
    for horizon in horizons:
        stage = validation_stages[horizon]
        scores = []
        for method in methods:
            spec = f"{method}:{feature_set}"
            bundle = _fit_bundle(stage, spec, seed)
            table = _long_table(data, stage, horizon, spec, _predictions(stage, spec, bundle), station)
            validation_tables.append(table)
            usable = table["excluded"].eq("")
            predicted_speed = np.hypot(table.loc[usable, "predicted_u_ms"],
                                       table.loc[usable, "predicted_v_ms"])
            errors = np.abs(predicted_speed - table.loc[usable, "observed_speed_ms"])
            score = float(errors.mean())
            if not np.isfinite(score):
                raise ValueError("調整期間の風速誤差を計算できません。観測風速の欠測を確認してください。")
            scores.append((score, spec))
            selection_rows.append({"horizon_h": horizon, "model": spec,
                                   "speed_mae_ms": score, "n_validation": int(errors.notna().sum())})
        # 同点なら候補の指定順を保つ。最終テストの成績を選択に使わない。
        selected = min(scores, key=lambda item: item[0])[1]
        selection[horizon] = selected
        stage = test_stages[horizon]
        bundle = _fit_bundle(stage, selected, seed)
        models[horizon] = bundle
        for spec in (*BASELINES, selected):
            values = _predictions(stage, spec, bundle if spec == selected else None)
            test_tables.append(_long_table(data, stage, horizon, spec, values, station))
    metadata = _metadata(data, "backtest", horizons, feature_set, include_optional, seed)
    metadata["station"] = station
    metadata["split"] = {key: value.isoformat() if isinstance(value, pd.Timestamp) else value
                         for key, value in split.items()}
    metadata["selection"] = {str(h): spec for h, spec in selection.items()}
    metadata["selection_basis"] = "validation_speed_mae"
    metadata["n_train_by_horizon"] = {str(h): item["n_train"] for h, item in models.items()}
    metadata["input_columns_by_horizon"] = {str(h): {"model": item["columns"],
                                                     "comparison": test_stages[h]["inputs"]}
                                             for h, item in models.items()}
    metadata["evaluation_kind"] = "retrospective_observation_cutoff"
    metadata["observation_release_delay_modelled"] = False
    return {"predictions": pd.concat(test_tables, ignore_index=True),
            "validation_predictions": pd.concat(validation_tables, ignore_index=True),
            "selection": selection, "selection_scores": pd.DataFrame(selection_rows),
            "split": split, "models": models, "metadata": metadata}


def _selected_spec(selected_methods, horizon, feature_set):
    if selected_methods is None:
        value = "linear"
    elif isinstance(selected_methods, Mapping):
        value = selected_methods.get(horizon, selected_methods.get(str(horizon)))
        if value is None:
            raise ValueError(f"{horizon}時間先の学習手法がありません。")
    else:
        value = selected_methods
    method, supplied_features = wp.parse_model(str(value))
    _method(method)
    if supplied_features is not None and _feature_set(supplied_features) != feature_set:
        raise ValueError("選ばれたモデルと将来予測の入力項目が異なります。feature_set をそろえてください。")
    return f"{method}:{feature_set}"


def forecast_future(weather, *, horizons=DEFAULT_HORIZONS, cutoff=None, train_start=None,
                    selected_methods=None, feature_set="calendar+recent", include_optional=False,
                    seed=2026, station=None):
    """指定時刻までの観測で学習し、その最後の観測時刻から将来を予測する。

    実行した現在時刻ではなく、入力の最後の時刻が予測起点です。最新の観測に必要な
    入力が欠ける場合は停止し、欠測を隠して古い起点や未来の値で埋めません。
    過去のデータを渡したときも、そのデータ末尾からの予測だとmetadataに記録します。
    """
    horizons = _hours(horizons)
    feature_set = _feature_set(feature_set)
    data = _weather_copy(weather, include_optional)
    requested_cutoff = data.index.max() if cutoff is None else _time(cutoff)
    data = data.loc[data.index <= requested_cutoff].copy()
    if data.empty:
        raise ValueError("指定した時刻以前の観測データがありません。")
    start = data.index.min() if train_start is None else _time(train_start)
    if start < data.index.min() or start > data.index.max():
        raise ValueError("学習開始日は指定時刻以前の観測期間内で指定してください。")
    data = data.loc[start:].copy()
    issue = data.index.max()
    if data.loc[issue, ["u_ms", "v_ms"]].isna().any():
        raise ValueError("最新の観測時刻に風の値がありません。予測起点または入力データを確認してください。")
    station = str(station or data.attrs.get("station", "観測地点"))
    # 予測起点までの観測は利用可能。学習の答えもこの時刻以前に限定する。
    climatology = wp.fit_climatology(data, issue + pd.Timedelta(nanoseconds=1), start)
    tables, models, selection, input_columns = [], {}, {}, {}
    for horizon in horizons:
        table = wp.add_climatology_columns(wp.make_forecast_table(data, horizon), climatology)
        in_train = (table.index >= start) & (table["target_time"] <= issue)
        recent, model_columns, inputs = _input_columns(table, in_train, feature_set)
        train = table.loc[in_train].dropna(subset=model_columns + ["target_u", "target_v"])
        if len(train) < MIN_TRAIN_ROWS:
            raise ValueError(f"{horizon}時間先の学習用データが{len(train)}行です。"
                             "欠測と直近24時間の入力分を除いた後で、30日以上のデータが必要です。")
        row = table.loc[[issue]].copy()
        missing = row[inputs].columns[row[inputs].isna().any()].tolist()
        if missing:
            raise ValueError(f"最新の観測から予測するための入力が不足しています: {', '.join(missing)}")
        row["excluded"] = ""
        stage = {"train": train, "evaluation": row, "recent": recent, "inputs": inputs,
                 "climatology": climatology}
        spec = _selected_spec(selected_methods, horizon, feature_set)
        bundle = _fit_bundle(stage, spec, seed)
        models[horizon] = bundle
        selection[horizon] = spec
        input_columns[str(horizon)] = {"model": model_columns, "comparison": inputs}
        for name in (*BASELINES, spec):
            values = _predictions(stage, name, bundle if name == spec else None)
            result = _long_table(data, stage, horizon, name, values, station)
            result["excluded"] = "future_target"
            tables.append(result)
    metadata = _metadata(data, "future", horizons, feature_set, include_optional, seed)
    metadata.update({"station": station, "requested_cutoff": requested_cutoff.isoformat(),
                     "input_cutoff": issue.isoformat(), "issue_time": issue.isoformat(),
                     "evaluation_kind": "not_yet_observed", "observations_available": False,
                     "selection": {str(h): spec for h, spec in selection.items()},
                     "selection_metric": None,
                     "input_columns_by_horizon": input_columns,
                     "selection_basis": "provided_methods" if selected_methods is not None else "fixed_linear_default",
                     "observation_release_delay_modelled": False})
    return {"predictions": pd.concat(tables, ignore_index=True), "models": models,
            "selection": selection, "metadata": metadata}
