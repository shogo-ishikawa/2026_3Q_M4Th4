"""風速・風向の誤差解析。予測と観測を1行ずつ並べた表を共通の入口にする。

時刻はタイムゾーンなしの日本時間（JST）。風速の偏りは「予測 − 観測」で、
正なら強く予測したことを表す。観測のない将来予測には成績を付けない。
静穏な観測は風向の採点から除き、向きが決まらない予測には既存教材と同じ
90度の誤差を与える。この90度は予測限界ではなく、一様ランダムな方向の期待誤差。
"""

from pathlib import Path

import numpy as np
import pandas as pd

from .wind_pipeline import (
    CALM_SPEED_MS,
    DIRECTION_LABELS,
    UNDEFINED_DIRECTION_ERROR_DEG,
    angular_error,
    model_label,
    uv_to_direction,
)

GROUP_COLUMNS = ["station", "model", "horizon_h"]
PAIR_COLUMNS = ["station", "issue_time", "target_time", "horizon_h"]
VECTOR_COLUMNS = ["observed_u_ms", "observed_v_ms", "predicted_u_ms", "predicted_v_ms"]
SUMMARY_COLUMNS = GROUP_COLUMNS + [
    "speed_mae_ms", "speed_rmse_ms", "speed_bias_ms", "direction_mae_deg",
    "within_45_pct", "vector_rmse_ms", "n_rows", "n_speed", "n_direction", "n_vector",
    "n_excluded", "n_missing_observation", "n_missing_prediction", "n_calm",
    "n_undefined_direction",
]
SKILL_COLUMNS = GROUP_COLUMNS + [
    "baseline", "speed_skill_pct", "ci_low_pct", "ci_high_pct", "model_mae_ms",
    "baseline_mae_ms", "n_pairs", "n_days", "n_bootstrap", "status",
]
COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
           "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def _finite(values):
    return np.isfinite(np.asarray(values, dtype=float))


def add_errors(predictions, calm_threshold_ms=CALM_SPEED_MS):
    """元の列を残し、誤差と指標ごとの採点対象マスクを追加したコピーを返す。

    observed_speed_ms / predicted_speed_ms があれば元の風速を優先する。
    静穏の u/v がゼロに整理されても、元の微弱な風速を風速誤差に使える。
    欠けていれば u/v の大きさから求める。
    風向の定まる観測に対し、予測ベクトルがゼロなら90度として採点する。
    """
    if not np.isfinite(calm_threshold_ms) or calm_threshold_ms < 0:
        raise ValueError("静穏の閾値は0以上の有限な風速にしてください。")
    required = GROUP_COLUMNS + ["issue_time", "target_time"] + VECTOR_COLUMNS
    missing = [name for name in required if name not in predictions]
    if missing:
        raise ValueError(f"予測結果に必要な列がありません: {', '.join(missing)}")
    result = predictions.copy()
    for name in ["issue_time", "target_time"]:
        times = pd.to_datetime(result[name], errors="raise")
        if getattr(times.dt, "tz", None) is not None:
            raise ValueError("解析用の時刻はタイムゾーンなしの日本時間（JST）にそろえてください。")
        if times.isna().any():
            raise ValueError("予測起点と対象時刻に欠けた日時があります。時刻を確認してください。")
        result[name] = times
    result["station"] = result["station"].fillna("")
    if "issue_basis" in result:
        # 同じ「3時間先」でも、初期時刻基準と取得時刻基準は同じ実験ではない。
        basis = result["issue_basis"].fillna("unspecified").astype(str)
        counts = result.assign(issue_basis=basis).groupby(GROUP_COLUMNS, dropna=False)["issue_basis"].nunique()
        if counts.gt(1).any():
            raise ValueError("同じ地点・モデル・予測時間に異なる予測基準が混在しています。"
                             "初期時刻基準と取得時刻基準を分けて解析してください。")
    for name in VECTOR_COLUMNS:
        result[name] = pd.to_numeric(result[name], errors="coerce").replace([np.inf, -np.inf], np.nan)
    result["excluded"] = result.get("excluded", pd.Series("", index=result.index)).fillna("").astype(str)
    observed_vector_speed = np.hypot(result["observed_u_ms"], result["observed_v_ms"])
    if "observed_speed_ms" in result:
        native = pd.to_numeric(result["observed_speed_ms"], errors="coerce")
        native = native.where(_finite(native) & (native >= 0))
        result["observed_speed_ms"] = native.fillna(observed_vector_speed)
    else:
        result["observed_speed_ms"] = observed_vector_speed
    predicted_vector_speed = np.hypot(result["predicted_u_ms"], result["predicted_v_ms"])
    if "predicted_speed_ms" in result:
        native = pd.to_numeric(result["predicted_speed_ms"], errors="coerce")
        native = native.where(_finite(native) & (native >= 0))
        result["predicted_speed_ms"] = native.fillna(predicted_vector_speed)
    else:
        result["predicted_speed_ms"] = predicted_vector_speed
    eligible = result["excluded"].eq("")
    observed_vector = _finite(result["observed_u_ms"]) & _finite(result["observed_v_ms"])
    predicted_vector = _finite(result["predicted_u_ms"]) & _finite(result["predicted_v_ms"])
    observed_speed = _finite(result["observed_speed_ms"])
    predicted_speed = _finite(result["predicted_speed_ms"])
    result["speed_evaluated"] = eligible & observed_speed & predicted_speed
    result["vector_evaluated"] = eligible & observed_vector & predicted_vector
    result["observed_direction_deg"] = uv_to_direction(result["observed_u_ms"], result["observed_v_ms"])
    result["predicted_direction_deg"] = uv_to_direction(result["predicted_u_ms"], result["predicted_v_ms"])
    calm = observed_speed & (result["observed_speed_ms"] <= calm_threshold_ms)
    result.loc[calm, "observed_direction_deg"] = np.nan
    result["direction_evaluated"] = eligible & observed_vector & ~calm & predicted_vector
    result["undefined_direction"] = result["direction_evaluated"] & result["predicted_direction_deg"].isna()
    # observed u/v = 0 でも native speed が大きいという不整合は方向の採点に使わない。
    result["direction_evaluated"] &= result["observed_direction_deg"].notna()
    result["undefined_direction"] &= result["direction_evaluated"]
    result["calm_observation"] = eligible & calm
    result["missing_observation"] = ~observed_speed
    result["missing_prediction"] = ~predicted_speed
    residual = result["predicted_speed_ms"] - result["observed_speed_ms"]
    result["speed_error_ms"] = residual.where(result["speed_evaluated"])
    result["speed_absolute_error_ms"] = result["speed_error_ms"].abs()
    result["speed_squared_error"] = result["speed_error_ms"] ** 2
    vector_squared = ((result["predicted_u_ms"] - result["observed_u_ms"]) ** 2
                      + (result["predicted_v_ms"] - result["observed_v_ms"]) ** 2)
    result["vector_squared_error"] = vector_squared.where(result["vector_evaluated"])
    direction_error = angular_error(result["observed_direction_deg"], result["predicted_direction_deg"])
    direction_error = np.where(result["undefined_direction"], UNDEFINED_DIRECTION_ERROR_DEG, direction_error)
    result["direction_absolute_error_deg"] = pd.Series(direction_error, index=result.index).where(result["direction_evaluated"])
    result["direction_within_45"] = (result["direction_evaluated"] & ~result["undefined_direction"]
                                     & (result["direction_absolute_error_deg"] <= 45 + 1e-9))
    return result


def _summary(part):
    angle = part.loc[part["direction_evaluated"]]
    return {
        "speed_mae_ms": part["speed_absolute_error_ms"].mean(),
        "speed_rmse_ms": np.sqrt(part["speed_squared_error"].mean()),
        "speed_bias_ms": part["speed_error_ms"].mean(),
        "direction_mae_deg": angle["direction_absolute_error_deg"].mean(),
        "within_45_pct": 100 * angle["direction_within_45"].mean(),
        "vector_rmse_ms": np.sqrt(part["vector_squared_error"].mean()),
        "n_rows": len(part), "n_speed": int(part["speed_evaluated"].sum()),
        "n_direction": int(part["direction_evaluated"].sum()),
        "n_vector": int(part["vector_evaluated"].sum()),
        "n_excluded": int(part["excluded"].ne("").sum()),
        "n_missing_observation": int(part["missing_observation"].sum()),
        "n_missing_prediction": int(part["missing_prediction"].sum()),
        "n_calm": int(part["calm_observation"].sum()),
        "n_undefined_direction": int(part["undefined_direction"].sum()),
    }


def summarise_errors(predictions):
    """地点・手法・予測時間ごとの誤差と件数。評価0件の指標は NaN。"""
    data = add_errors(predictions)
    rows = []
    for keys, part in data.groupby(GROUP_COLUMNS, sort=False, dropna=False):
        rows.append({**dict(zip(GROUP_COLUMNS, keys)), **_summary(part)})
    return pd.DataFrame(rows, columns=SUMMARY_COLUMNS)


def grouped_errors(predictions, *, by="month"):
    """対象時刻の月／時刻／観測風向／観測風速帯ごとに集計する。

    風向は16方位、風速帯は [0,2), [2,5), [5,10), [10,∞) m/s。
    静穏・欠測のグループも残し、どのデータを採点から除いたか確認できる。
    予測時間はまとめず、horizon_h 別の行として保つ。
    """
    if by not in {"month", "hour", "direction", "speed_band"}:
        raise ValueError("by は month, hour, direction, speed_band から選んでください。")
    data = add_errors(predictions)
    if by == "month":
        data[by] = data["target_time"].dt.month
    elif by == "hour":
        data[by] = data["target_time"].dt.hour
    elif by == "direction":
        direction = data["observed_direction_deg"]
        sector = np.floor(((direction.fillna(0) + 11.25) % 360) / 22.5).astype(int)
        data[by] = np.asarray(COMPASS, dtype=object)[sector]
        data.loc[direction.isna(), by] = "calm_or_missing"
    else:
        data[by] = pd.cut(data["observed_speed_ms"], [0, 2, 5, 10, np.inf],
                          labels=["0–2", "2–5", "5–10", "10+"], right=False).astype(object)
        data[by] = data[by].fillna("missing")
    columns = GROUP_COLUMNS + [by]
    rows = []
    for keys, part in data.groupby(columns, sort=False, dropna=False):
        rows.append({**dict(zip(columns, keys)), **_summary(part)})
    return pd.DataFrame(rows, columns=columns + SUMMARY_COLUMNS[len(GROUP_COLUMNS):])


def skill_against_baseline(predictions, *, baseline="persistence", n_bootstrap=200, seed=2026):
    """同じ行で比較した風速MAEの改善率と、日単位ブロック再標本化の95%区間。

    改善率 = 100 × (1 − 手法のMAE / 基準予報のMAE)。正なら改善。
    両手法で採点できる同じ地点・予測起点・対象時刻だけを比較する。
    同じ日の相関を残すため、予測起点の日を単位に日全体を復元抽出する。
    区間は性能の普遍的保証ではなく、この評価期間での日ごとの変動の目安。
    """
    if not isinstance(n_bootstrap, (int, np.integer)) or n_bootstrap < 0:
        raise ValueError("n_bootstrap は0以上の整数にしてください。")
    data = add_errors(predictions)
    if data.duplicated(PAIR_COLUMNS + ["model"]).any():
        raise ValueError("同じ地点・予測起点・対象時刻・手法の行が重複しています。")
    rng = np.random.default_rng(seed)
    rows = []
    for (station, horizon), part in data.groupby(["station", "horizon_h"], sort=False, dropna=False):
        reference = part.loc[part["model"].eq(baseline) & part["speed_evaluated"],
                             PAIR_COLUMNS + ["speed_absolute_error_ms", "observed_speed_ms"]]
        for model, forecast in part.loc[~part["model"].eq(baseline)].groupby("model", sort=False):
            usable = forecast.loc[forecast["speed_evaluated"],
                                  PAIR_COLUMNS + ["speed_absolute_error_ms", "observed_speed_ms"]]
            pairs = usable.merge(reference, on=PAIR_COLUMNS, suffixes=("_model", "_baseline"), validate="one_to_one")
            if len(pairs) and not np.allclose(pairs["observed_speed_ms_model"], pairs["observed_speed_ms_baseline"], atol=1e-9):
                raise ValueError("比較する手法で同じ時刻の観測風速が異なっています。")
            row = {"station": station, "model": model, "horizon_h": horizon, "baseline": baseline,
                   "speed_skill_pct": np.nan, "ci_low_pct": np.nan, "ci_high_pct": np.nan,
                   "model_mae_ms": np.nan, "baseline_mae_ms": np.nan, "n_pairs": len(pairs),
                   "n_days": 0, "n_bootstrap": 0, "status": "no_paired_data"}
            if pairs.empty:
                rows.append(row)
                continue
            model_error = pairs["speed_absolute_error_ms_model"]
            baseline_error = pairs["speed_absolute_error_ms_baseline"]
            row["model_mae_ms"] = float(model_error.mean())
            row["baseline_mae_ms"] = float(baseline_error.mean())
            pairs["day"] = pairs["issue_time"].dt.normalize()
            daily = pairs.groupby("day")[["speed_absolute_error_ms_model", "speed_absolute_error_ms_baseline"]].sum()
            row["n_days"] = len(daily)
            if baseline_error.mean() == 0:
                row["status"] = "zero_baseline_error"
            else:
                row["speed_skill_pct"] = 100 * (1 - model_error.mean() / baseline_error.mean())
                row["status"] = "too_few_days" if len(daily) < 2 else "ok"
                samples = []
                if len(daily) >= 2:
                    values = daily.to_numpy()
                    for _ in range(n_bootstrap):
                        total = values[rng.integers(0, len(values), len(values))].sum(axis=0)
                        if total[1] > 0:
                            samples.append(100 * (1 - total[0] / total[1]))
                if samples:
                    row["ci_low_pct"], row["ci_high_pct"] = np.percentile(samples, [2.5, 97.5])
                    row["n_bootstrap"] = len(samples)
            rows.append(row)
    return pd.DataFrame(rows, columns=SKILL_COLUMNS)


def plot_diagnostics(predictions, output_dir, *, language="ja"):
    """誤差図をPNGに保存しパス一覧を返す。観測0件なら空の一覧を返す。

    条件別図と時系列は最短の予測時間を表示し、全予測時間の違いは予測時間別図で示す。
    地点と予測時間を混ぜて風配図や条件別誤差を集計しない。
    """
    import matplotlib.dates as mdates
    import matplotlib.pyplot as plt

    from . import plotting

    actual_language = plotting.apply_style(language=language, verbose=False)
    ja = actual_language == "ja"
    text = lambda japanese, english: japanese if ja else english
    data = add_errors(predictions)
    if not data["speed_evaluated"].any():
        return []
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    paths = []

    def save(figure, filename):
        figure.tight_layout()
        path = output / filename
        figure.savefig(path, dpi=140, bbox_inches="tight")
        plt.close(figure)
        paths.append(path)

    def model_name(model):
        """表では識別子を保ち、図では教材と共通の手法名にする。"""
        base, _, grid = str(model).partition(":")
        weather_models = {
            "jma_msm": "JMA MSM", "jma_gsm": "JMA GSM",
            "ecmwf_ifs025": "ECMWF IFS 0.25°", "ecmwf_ifs": "ECMWF IFS HRES",
            "ecmwf_ifs_hres": "ECMWF IFS HRES", "best_match": text("自動選択予報", "Best match"),
        }
        if base in weather_models:
            suffix = {"land": text("陸格子", "land grid"), "sea": text("海格子", "sea grid")}.get(grid, grid)
            return weather_models[base] + (f"（{suffix}）" if ja and suffix else (f" ({suffix})" if suffix else ""))
        return model_label(str(model), language=actual_language)

    def label(station, model):
        # ASCII station identifiers still label exported figures when no Japanese font is installed.
        name = str(station)
        if not ja and not name.isascii():
            name = "Station " + str(list(data["station"].unique()).index(station) + 1)
        display = model_name(model) if model else ""
        return f"{name} / {display}" if name and display else (name or display)

    speed_axis = text("風速 (m/s)", "Wind speed (m/s)")
    mae_axis = text("風速の平均絶対誤差 (m/s)", "Wind speed MAE (m/s)")
    scores = summarise_errors(predictions)
    figure, axes = plt.subplots(1, 2, figsize=(12, 4.5))
    for (station, model), part in scores.groupby(["station", "model"], sort=False):
        part = part.sort_values("horizon_h")
        n = part["n_speed"]
        count = str(int(n.min())) if n.min() == n.max() else f"{int(n.min())}–{int(n.max())}"
        series_label = f"{label(station, model)} (n={count})"
        axes[0].plot(part["horizon_h"], part["speed_mae_ms"], "o-", label=series_label)
        axes[1].plot(part["horizon_h"], part["direction_mae_deg"], "o-", label=label(station, model))
    for ax in axes:
        ax.set_xlabel(text("予測時間（何時間先か）", "Lead time (hours ahead)"))
        ax.grid(alpha=0.25)
    axes[0].set_ylabel(mae_axis)
    axes[1].set_ylabel(text("風向の平均絶対誤差（度）", "Wind direction MAE (degrees)"))
    axes[0].legend(fontsize=7)
    axes[1].legend(fontsize=7)
    save(figure, "error_by_lead.png")

    horizon = data.loc[data["speed_evaluated"], "horizon_h"].min()
    shortest = data.loc[data["horizon_h"].eq(horizon)]
    for number, (station, part) in enumerate(shortest.groupby("station", sort=False), start=1):
        evaluated = part.loc[part["speed_evaluated"]]
        start = evaluated["target_time"].min()
        end = start + pd.Timedelta(days=7)
        # 欠測・除外行を落とすと、その前後が線でつながり、途中も予測できたように見える。
        # 時刻の行を残し、予測できない値をNaNにして線を途切れさせる。
        shown = part.loc[part["target_time"].ge(start) & part["target_time"].lt(end)].copy()
        figure, axes = plt.subplots(2, 1, figsize=(12, 6), sharex=True, gridspec_kw={"height_ratios": [2, 1]})
        observed = shown.drop_duplicates("target_time").sort_values("target_time")
        axes[0].plot(observed["target_time"], observed["observed_speed_ms"], color="black", label=text("観測", "Observed"), linewidth=1.8)
        winds = [(text("観測", "Observed"), observed, "observed")]
        for model, forecast in shown.groupby("model", sort=False):
            forecast = forecast.sort_values("target_time").copy()
            forecast.loc[~forecast["speed_evaluated"], "predicted_speed_ms"] = np.nan
            forecast.loc[~forecast["vector_evaluated"], ["predicted_u_ms", "predicted_v_ms"]] = np.nan
            axes[0].plot(forecast["target_time"], forecast["predicted_speed_ms"], label=model_name(model), alpha=.8)
            winds.append((model_name(model), forecast, "predicted"))
        for row, (_, wind, prefix) in enumerate(winds):
            sampled = wind.iloc[::6]
            u, v = sampled[f"{prefix}_u_ms"], sampled[f"{prefix}_v_ms"]
            length = np.hypot(u, v).replace(0, np.nan)
            axes[1].quiver(mdates.date2num(sampled["target_time"]), np.full(len(sampled), row), u / length, v / length,
                           angles="uv", scale_units="inches", scale=5, width=.003)
        axes[1].set_yticks(range(len(winds)), [wind[0] for wind in winds], fontsize=7)
        axes[1].set_ylim(-.6, len(winds) - .4)
        axes[1].set_title(text("矢印は風の向かう方向（長さは風速を表しません）", "Arrows show where wind travels; length does not encode speed"), fontsize=9)
        axes[0].set_ylabel(speed_axis)
        axes[0].set_title(text(f"最初の7日間・{horizon:g}時間先：", f"First 7 days, {horizon:g} h ahead: ") + label(station, ""))
        axes[0].legend(fontsize=7, ncol=2)
        axes[0].grid(alpha=.25)
        axes[1].set_xlabel(text("対象時刻（日本時間）", "Target time (JST)"))
        axes[1].xaxis.set_major_formatter(mdates.DateFormatter("%m-%d\n%H:%M"))
        save(figure, f"timeseries_station_{number}.png")

    groups = list(shortest.loc[shortest["speed_evaluated"]].groupby(["station", "model"], sort=False))
    columns = min(3, len(groups))
    rows = (len(groups) + columns - 1) // columns
    figure, axes = plt.subplots(rows, columns, figsize=(4 * columns, 3.8 * rows), squeeze=False)
    for ax, ((station, model), part) in zip(axes.flat, groups):
        ax.scatter(part["observed_speed_ms"], part["predicted_speed_ms"], alpha=.18, s=8, rasterized=True)
        limit = max(part["observed_speed_ms"].max(), part["predicted_speed_ms"].max(), 1)
        ax.plot([0, limit], [0, limit], color="black", linestyle="--", linewidth=.8)
        ax.set_xlabel(text("観測した風速 (m/s)", "Observed wind speed (m/s)"))
        ax.set_ylabel(text("予測した風速 (m/s)", "Predicted wind speed (m/s)"))
        ax.set_title(f"{label(station, model)}\n{horizon:g} h, n={len(part)}", fontsize=9)
    for ax in list(axes.flat)[len(groups):]:
        ax.set_visible(False)
    save(figure, "speed_scatter.png")

    for by, axis_name in [("month", text("月", "Month")), ("hour", text("時刻（日本時間）", "Hour of day (JST)")),
                          ("direction", text("観測した風向", "Observed wind direction")),
                          ("speed_band", text("観測した風速帯 (m/s)", "Observed wind speed band (m/s)"))]:
        grouped = grouped_errors(shortest, by=by)
        figure, ax = plt.subplots(figsize=(10, 4.7))
        categories = {"month": list(range(1, 13)), "hour": list(range(24)), "direction": COMPASS + ["calm_or_missing"],
                      "speed_band": ["0–2", "2–5", "5–10", "10+", "missing"]}[by]
        for (station, model), part in grouped.groupby(["station", "model"], sort=False):
            part = part.set_index(by).reindex(categories)
            counts = part["n_speed"].fillna(0)
            ax.plot(range(len(categories)), part["speed_mae_ms"], "o-", label=f"{label(station, model)} (n={int(counts.sum())})")
        labels = [str(item) for item in categories]
        if by == "direction":
            if ja:
                labels[:-1] = DIRECTION_LABELS
            labels[-1] = text("静穏・欠測", "Calm/missing")
        elif by == "speed_band":
            labels[-1] = text("欠測", "Missing")
        ax.set_xticks(range(len(categories)), labels, rotation=45 if by == "direction" else 0)
        ax.set_xlabel(axis_name)
        ax.set_ylabel(mae_axis)
        ax.set_title(text(f"条件別の誤差（{horizon:g}時間先）", f"Conditional errors ({horizon:g} h ahead)"))
        ax.legend(fontsize=7)
        ax.grid(alpha=.25)
        save(figure, f"error_by_{by}.png")

    # 風配図も最短hだけ。観測は手法の数だけ重複させず、同じ対象時刻を1度だけ数える。
    direction_available = shortest["speed_evaluated"] & (
        shortest["observed_direction_deg"].notna() | shortest["predicted_direction_deg"].notna())
    stations = list(shortest.loc[direction_available, "station"].unique())
    if not stations:
        return paths
    figure, axes = plt.subplots(1, len(stations), figsize=(5 * len(stations), 5.2), subplot_kw={"projection": "polar"}, squeeze=False)
    edges = np.arange(-11.25, 360, 22.5)
    for ax, station in zip(axes.flat, stations):
        part = shortest.loc[shortest["station"].eq(station)]
        series = [(text("観測", "Observed"), part.drop_duplicates("target_time"), "observed_direction_deg")]
        series += [(model_name(model), group, "predicted_direction_deg") for model, group in part.groupby("model", sort=False)]
        for name, group, column in series:
            # 風配図は照合済みの行だけで比較。静穏と向き不定は分母から除く。
            use = group.loc[group["speed_evaluated"], column].dropna().to_numpy()
            if not len(use):
                continue
            angles = np.where(use >= 348.75, use - 360, use)
            counts, _ = np.histogram(angles, bins=edges)
            share = 100 * counts / len(use)
            centres = np.deg2rad(np.arange(0, 360, 22.5))
            ax.plot(np.r_[centres, centres[0]], np.r_[share, share[0]], label=f"{name} (n={len(use)})")
        ax.set_theta_zero_location("N")
        ax.set_theta_direction(-1)
        compass_labels = DIRECTION_LABELS[::2] if ja else COMPASS[::2]
        ax.set_xticks(np.deg2rad(np.arange(0, 360, 45)), compass_labels)
        ax.set_title(label(station, "") + text("風配図（割合 %）", "Wind rose (share %)"), fontsize=10)
        ax.legend(loc="lower center", bbox_to_anchor=(.5, -.25), fontsize=7)
    save(figure, "wind_rose.png")
    return paths
