"""4つの実験を実行する関数（CLI と Notebook で共通に使う）。

- 実験1 experiment_angle：角度の罠。2つの風向の算術平均とベクトル平均、同じ入力・同じ期間・同じモデル設定での
  「角度を直接回帰」と「u, v を回帰」の比較、北付近の誤差。予測の表し方を決めるための比較なので、検証期間で比べる。
- 実験2 experiment_features：3時間先について、季節・日周期だけ／過去・直近の観測だけ／両方（統合モデル）と、
  3つの基準予報を最終テスト期間で比べる。穏やかな期間と急変を含む期間の48時間を、観測値だけから選んで取り出す。
- 実験3 experiment_horizons：予測時間を変えて、統合モデルと3つの基準予報を最終テスト期間で比べる。
- 実験4 experiment_lorenz：ローレンツ系の初期値鋭敏性（風向きの予測とは独立）。

統合モデルの設定は、検証期間の成績で選ぶ（select_integrated）。最終テスト期間では何も選ばない。
"""

import numpy as np
import pandas as pd

from . import lorenz_demo
from . import wind_pipeline as wp

MEAN_EXAMPLE_DEG = (337.5, 22.5)
FEATURE_SETS = ["calendar", "recent", "calendar+recent"]


def select_integrated(weather, split, horizon=3, candidates=wp.INTEGRATED_CANDIDATES, seed=0):
    """検証期間の成績で統合モデルの設定を選ぶ。戻り値は（検証期間の成績の表, 選んだ名前）。

    検証期間のない分割では選べないので、表は None、名前は "linear"（いちばん単純な候補）にする。
    """
    if split.get("validation_start") is None:
        return None, "linear"
    return wp.select_on_validation(weather, split, candidates, horizon, seed=seed)


# ---------------------------------------------------------------------------
# 実験1：角度の罠
# ---------------------------------------------------------------------------

def mean_direction_example(directions=MEAN_EXAMPLE_DEG):
    """2つの風向の、ふつうの平均（算術平均）と、風向の平均（ベクトル平均）を比べる表。"""
    means = [float(np.mean(directions)), wp.circular_mean_deg(directions)]
    return pd.DataFrame({
        "method": ["arithmetic mean", "vector mean (u, v)"],
        "mean_deg": means,
        "direction_label": list(wp.degrees_to_direction_label(means)),
    })


def error_by_target_direction(forecasts, models):
    """観測した風向（対象時刻）を16方位に分け、方位ごとの平均絶対角度誤差を表にする（行 0 = 北）。"""
    rows = wp.angle_rows(forecasts)
    sectors = np.round(forecasts.loc[rows, "target_direction_deg"].to_numpy() / 22.5).astype(int) % 16
    errors = pd.DataFrame({spec: wp.angle_errors(forecasts, spec).to_numpy() for spec in models})
    return errors.groupby(sectors).mean().reindex(range(16)).rename_axis("sector")


def north_summary(forecasts, models, half_width=22.5):
    """観測した風向が北（0度）から half_width 度以内の時刻について、各手法の平均誤差と、
    予測が南半分（90度より大きく270度より小さい）に入った割合（%）。"""
    rows = wp.angle_rows(forecasts)
    target = forecasts.loc[rows, "target_direction_deg"].to_numpy()
    near_north = wp.angular_error(target, 0.0) <= half_width
    table = []
    for spec in models:
        errors = wp.angle_errors(forecasts, spec).to_numpy()[near_north]
        predicted = forecasts.loc[rows, spec].to_numpy()[near_north]
        southern = (predicted > 90) & (predicted < 270)
        table.append({"model": spec, "n_near_north": int(near_north.sum()),
                      "mae_deg": float(np.mean(errors)), "predicted_south_pct": float(100 * np.mean(southern))})
    return pd.DataFrame(table)


def experiment_angle(weather, split, methods=("linear", "boosting"), horizon=3, stage="validation", seed=0):
    """実験1。methods の各設定で、u, v の回帰（"名前:calendar+recent"）と角度の直接回帰
    （"名前_angle:calendar+recent"）を、同じ入力・同じ期間・同じ設定で比べる。

    悪い例（degrees_as_numbers：入力もモデルも違う）は参考として加えるが、表し方の比較には使わない。
    """
    pairs = [(f"{method}:calendar+recent", f"{method}_angle:calendar+recent") for method in methods]
    models = [spec for pair in pairs for spec in pair] + ["degrees_as_numbers"]
    forecasts = wp.forecast_stage(weather, horizon, models, split, stage, seed=seed)
    return {
        "means": mean_direction_example(),
        "scores": wp.score_forecasts(forecasts, models),
        "by_direction": error_by_target_direction(forecasts, models),
        "north": north_summary(forecasts, models),
        "forecasts": forecasts,
        "pairs": pairs,
        "models": models,
    }


# ---------------------------------------------------------------------------
# 実験2：3時間先の特徴量の比較と、48時間の例
# ---------------------------------------------------------------------------

def choose_example_windows(weather, forecasts, hours=48):
    """例として見せる hours 時間を、予測を見る前に決めた規則で、観測値だけから選ぶ。

    範囲は、評価に使う行の対象時刻の最初から最後まで。候補は毎日1時に始まる hours 時間。
    - 穏やかな期間（calm）：風の欠測も静穏もなく、平均風速が範囲全体の中央値以上の候補のうち、
      3時間の風ベクトルの変化 |(u, v)(t) − (u, v)(t − 3)| の最大値が最も小さいもの
      （弱い風で向きがふらつく期間ではなく、急な変化のない期間）
    - 急変を含む期間（abrupt）：3時間の風ベクトルの変化が範囲の中で最も大きい時刻が、
      ちょうど真ん中（hours/2 時間目）に来る hours 時間
    同じ値なら早い方を選ぶ。予測の列は使わないので、どの手法が当たるかで期間は変わらない。
    戻り値は {"calm": (最初の対象時刻, 最後の対象時刻), "abrupt": (...)}。
    """
    targets = forecasts.loc[forecasts["excluded"] == "", "target_time"]
    first, last = targets.min(), targets.max()
    span = pd.Timedelta(hours=hours - 1)
    u, v = weather["u_ms"], weather["v_ms"]
    speed = pd.Series(np.hypot(u, v), index=weather.index)
    change_3h = pd.Series(np.hypot(u - u.shift(3), v - v.shift(3)), index=weather.index)
    typical_speed = speed.loc[first:last].median()

    best_start, best_value = None, np.inf
    for start in pd.date_range(first.normalize() + pd.Timedelta(hours=1), last - span, freq="D"):
        window = change_3h.loc[start:start + span]
        window_speed = speed.loc[start:start + span]
        steady = (len(window) == hours and window.notna().all() and window_speed.notna().all()
                  and (window_speed > 0).all() and window_speed.mean() >= typical_speed)
        if start >= first and steady and window.max() < best_value:
            best_start, best_value = start, window.max()

    half = pd.Timedelta(hours=hours // 2)
    peak = change_3h.loc[first + half:last - span + half].idxmax()
    return {"calm": (best_start, best_start + span), "abrupt": (peak - half, peak - half + span)}


def window_forecasts(forecasts, models, start, end):
    """対象時刻が start から end までの行を取り出す（予測を出した時刻ではなく、対象時刻で選ぶ）。

    issue_time（予測を出した時刻）を列に戻し、手法ごとの誤差の列（"手法 error"）を加える。
    予測の向きが決まらない行は、score_forecasts と同じく90度として数える。
    """
    part = forecasts[(forecasts["target_time"] >= start) & (forecasts["target_time"] <= end)].reset_index()
    angle = part["target_direction_deg"].notna() & (part["excluded"] == "")
    for spec in models:
        errors = wp.angular_error(part["target_direction_deg"], part[spec])
        errors = np.where(angle & part[spec].isna(), wp.UNDEFINED_DIRECTION_ERROR_DEG, errors)
        part[f"{spec} error"] = np.where(angle, errors, np.nan)
    return part.sort_values("target_time").reset_index(drop=True)


def experiment_features(weather, split, integrated, horizon=3, seed=0, window_hours=48):
    """実験2。integrated（検証期間で選んだ統合モデルの設定）で、特徴量の組だけを変えた3つと、
    3つの基準予報を、最終テスト期間の同じ行で比べる。"""
    models = [f"{integrated}:{feature_set}" for feature_set in FEATURE_SETS] + list(wp.BASELINE_MODELS)
    forecasts = wp.forecast_stage(weather, horizon, models, split, "test", seed=seed)
    windows = choose_example_windows(weather, forecasts, window_hours)
    examples = {name: window_forecasts(forecasts, models, start, end) for name, (start, end) in windows.items()}
    return {"scores": wp.score_forecasts(forecasts, models), "forecasts": forecasts, "models": models,
            "windows": windows, "examples": examples}


# ---------------------------------------------------------------------------
# 実験3：予測時間の比較
# ---------------------------------------------------------------------------

def experiment_horizons(weather, split, integrated, horizons, seed=0, extra_models=()):
    """実験3。統合モデルと3つの基準予報を、horizons の各予測時間で、最終テスト期間の同じ予測起点で比べる。"""
    models = [f"{integrated}:calendar+recent"] + list(wp.BASELINE_MODELS) + list(extra_models)
    scores = wp.run_horizon_experiment(weather, horizons, models, split, "test", seed=seed)
    return {"scores": scores, "models": models, "counts": count_table(scores)}


def count_table(scores):
    """予測時間ごとの評価件数と、外した件数（どの手法でも同じなので、予測時間ごとに1行）。"""
    columns = ["horizon_h", "n_issue", "n_missing_input", "n_missing_target", "n_calm_target", "n_vector", "n_test"]
    return scores.drop_duplicates("horizon_h")[columns].reset_index(drop=True)


# ---------------------------------------------------------------------------
# 実験4：ローレンツ系
# ---------------------------------------------------------------------------

def experiment_lorenz(n_start_points=10, perturbation_sizes=(1e-10, 1e-8, 1e-6, 1e-4, 1e-2), tolerance=1.0,
                      n_steps=3000, dt=0.01, benettin_steps=20000, check_dts=(0.01, 0.005), seed=0):
    """実験4。双子実験、成長率、Benettin法の最大リアプノフ指数、積分の刻みを小さくした確認、AR(1)との比較。

    時間はどれもローレンツ系の無次元の時間で、時間（hour）には換算しない。
    """
    points = lorenz_demo.attractor_points(n_start_points, seed=seed, dt=dt)
    table = lorenz_demo.predictability_table(points, perturbation_sizes, tolerance, n_steps, dt, seed)
    smallest = min(perturbation_sizes)
    times, distances = lorenz_demo.twin_distances(points, smallest, n_steps, dt, seed)
    growth_rate = lorenz_demo.fit_growth_rate(times, distances, smallest * 100, tolerance / 10)
    benettin = lorenz_demo.estimate_lyapunov_benettin(points[0], benettin_steps, dt)
    check_sizes = sorted(perturbation_sizes)[1::2] or list(perturbation_sizes)
    time_steps = lorenz_demo.time_step_check(points, check_dts, check_sizes, tolerance, total_time=n_steps * dt,
                                             seed=seed)
    return {
        "points": points,
        "predictability": table,
        "times": times,
        "distances": distances,
        "growth_rate": growth_rate,
        "benettin": benettin,
        "time_steps": time_steps,
        "twin_runs": lorenz_demo.twin_runs(points[0], 1e-6, n_steps, dt, seed),
        "ar_twin": lorenz_demo.ar1_twin(seed=seed),
        "ar_error": lorenz_demo.ar1_forecast_error_std(),
        "summary": {
            "fitted_growth_rate": growth_rate,
            "benettin_lyapunov_exponent": benettin,
            "reference_lyapunov_exponent": lorenz_demo.REFERENCE_LYAPUNOV_EXPONENT,
            "time_unit": "dimensionless Lorenz time (not hours)",
        },
    }
