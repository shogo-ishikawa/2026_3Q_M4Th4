"""図を描く関数（matplotlib）。

図の文字は、日本語フォントがない環境（Colabの初期状態など）でも文字化けしないよう、
英語（英国式の綴り）にしています。図の読み方は Notebook と README で日本語で説明します。
どの関数も matplotlib の Figure を返すので、save_figure で保存できます。
"""

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.colors import LinearSegmentedColormap

from . import lorenz_demo
from .wind_pipeline import (
    RANDOM_DIRECTION_EXPECTED_ERROR_DEG,
    direction_frequency_by_hour,
    model_label,
)

SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_SECONDARY = "#52514e"
INK_MUTED = "#898781"
GRID = "#e1e0d9"
AXIS = "#c3c2b7"

# 色覚の多様性を考えて検証した8色。手法や条件ごとに色を固定し、図が変わっても同じ色にする。
COLOURS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]
MODEL_STYLES = {
    "persistence": (COLOURS[0], "o"),
    "climatology": (COLOURS[1], "s"),
    "linear:calendar": (COLOURS[2], "^"),
    "linear:recent": (COLOURS[3], "v"),
    "linear:calendar+recent": (COLOURS[4], "D"),
    "boosting:calendar+recent": (COLOURS[5], "P"),
    "degrees_as_numbers": (COLOURS[6], "X"),
    "boosting:calendar": (COLOURS[7], "<"),
}
SCENARIO_STYLES = {
    "periodic_only": (COLOURS[0], "o", "Periodic only"),
    "periodic_ar": (COLOURS[1], "s", "Periodic + AR(1)"),
    "default": (COLOURS[2], "^", "All components"),
    "no_precursor": (COLOURS[3], "D", "All, fronts without precursor"),
}
COMPASS_16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
              "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
BLUE_RAMP = LinearSegmentedColormap.from_list(
    "blue_ramp",
    [SURFACE, "#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"],
)
# 90度の線の説明。「予測の限界」ではなく「独立な一様ランダム方向予測の期待誤差」と書く。
RANDOM_LINE_TEXT = "Independent uniform random direction: expected error 90°"


def apply_style():
    """図の見た目（背景、格子線、文字の色）をそろえる。最初に1回呼ぶ。"""
    plt.rcParams.update({
        "figure.facecolor": SURFACE,
        "axes.facecolor": SURFACE,
        "savefig.facecolor": SURFACE,
        "axes.edgecolor": AXIS,
        "axes.labelcolor": INK_SECONDARY,
        "axes.titlecolor": INK,
        "axes.grid": True,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "grid.color": GRID,
        "grid.linestyle": "-",
        "grid.linewidth": 0.6,
        "xtick.color": INK_SECONDARY,
        "ytick.color": INK_SECONDARY,
        "legend.frameon": False,
        "font.size": 10,
    })


def save_figure(fig, path):
    """図をPNGで保存する（フォルダがなければ作る）。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=150, bbox_inches="tight")
    return path


def model_style(spec):
    """手法ごとに決めた色と印。表にない手法は灰色。"""
    return MODEL_STYLES.get(spec, (INK_MUTED, "."))


def add_random_reference(ax, x_right):
    """90度の参照線（独立な一様ランダム方向予測の期待誤差）を引く。予測の限界を表す線ではない。"""
    ax.axhline(RANDOM_DIRECTION_EXPECTED_ERROR_DEG, color=INK_MUTED, linewidth=1.0, zorder=1)
    # 線と重なっても読めるよう、文字の後ろに半透明の背景を付ける
    ax.text(x_right, RANDOM_DIRECTION_EXPECTED_ERROR_DEG + 1.5, RANDOM_LINE_TEXT,
            ha="right", va="bottom", color=INK_SECONDARY, fontsize=8, zorder=4,
            bbox={"boxstyle": "square,pad=0.1", "facecolor": SURFACE, "edgecolor": "none", "alpha": 0.8})


# ---------------------------------------------------------------------------
# データを眺める図
# ---------------------------------------------------------------------------

def plot_direction_timeseries(weather, start, days=7):
    """風向（点）と風速（線）の時系列。

    風向は0度と360度がつながっているため、線で結ぶと北風のたびに上下へ大きく跳ぶ。
    そのため点で描く。
    """
    start = pd.Timestamp(start)
    part = weather.loc[start:start + pd.Timedelta(days=days)]
    fig, (top, bottom) = plt.subplots(2, 1, figsize=(10, 5), sharex=True, layout="constrained")
    top.scatter(part.index, part["wind_direction_deg"], s=14, color=COLOURS[0])
    top.set_ylim(-15, 375)
    top.set_yticks([0, 90, 180, 270, 360], ["N 0°", "E 90°", "S 180°", "W 270°", "N 360°"])
    top.set_ylabel("Direction (blowing from)")
    top.set_title(f"Observed wind from {start:%Y-%m-%d %H:%M} for {days} days (JST)")
    bottom.plot(part.index, part["wind_speed_ms"], color=COLOURS[0], linewidth=1.5)
    bottom.set_ylabel("Wind speed (m/s)")
    bottom.set_xlabel("Time (JST)")
    return fig


def plot_direction_by_hour(weather, title="Share of wind directions by hour of day"):
    """時刻（横軸）ごとに、どの方位から風が吹いたかの割合（色の濃さ）を描く。"""
    table = direction_frequency_by_hour(weather)
    fig, ax = plt.subplots(figsize=(9, 5), layout="constrained")
    image = ax.imshow(table.to_numpy(), origin="lower", aspect="auto", cmap=BLUE_RAMP,
                      extent=[-0.5, 23.5, -0.5, 15.5])
    ax.set_xticks(range(0, 24, 3))
    ax.set_yticks(range(16), COMPASS_16)
    ax.set_xlabel("Hour of day (JST, end of the hour)")
    ax.set_ylabel("Direction (blowing from)")
    ax.set_title(title)
    ax.grid(False)
    colourbar = fig.colorbar(image, ax=ax)
    colourbar.set_label("Share of hours at that hour of day (%)")
    return fig


# ---------------------------------------------------------------------------
# 予測の評価の図
# ---------------------------------------------------------------------------

def plot_error_vs_horizon(scores, models=None, title="Wind direction error vs lead time (test period)"):
    """予測時間（横軸）と平均絶対角度誤差（縦軸）。90度の参照線つき。"""
    if models is None:
        models = list(dict.fromkeys(scores["model"]))
    fig, ax = plt.subplots(figsize=(9, 4.8), layout="constrained")
    for spec in models:
        part = scores[scores["model"] == spec].sort_values("horizon_h")
        colour, marker = model_style(spec)
        ax.plot(part["horizon_h"], part["mae_deg"], color=colour, marker=marker,
                linewidth=1.5, markersize=5, label=model_label(spec, "en"), zorder=3)
    horizons = sorted(scores["horizon_h"].unique())
    add_random_reference(ax, horizons[-1])
    ax.set_xticks(horizons)
    ax.set_ylim(0, max(100, scores["mae_deg"].max() + 10))
    ax.set_xlabel("Lead time (hours ahead)")
    ax.set_ylabel("Mean absolute direction error (°)")
    ax.set_title(title)
    ax.legend(loc="upper left", bbox_to_anchor=(1.01, 1.0))
    return fig


def plot_error_by_hour(hourly_errors, title="Error by hour of day of the target time"):
    """対象時刻の時（0〜23時）ごとの平均絶対角度誤差。error_by_hour の結果を渡す。"""
    fig, ax = plt.subplots(figsize=(9, 4.5), layout="constrained")
    for spec in hourly_errors.columns:
        colour, marker = model_style(spec)
        ax.plot(hourly_errors.index, hourly_errors[spec], color=colour, marker=marker,
                linewidth=1.5, markersize=4, label=model_label(spec, "en"), zorder=3)
    add_random_reference(ax, 23)
    ax.set_xticks(range(0, 24, 3))
    ax.set_ylim(0, max(100, float(np.nanmax(hourly_errors.to_numpy())) + 10))
    ax.set_xlabel("Hour of day of the target time (JST)")
    ax.set_ylabel("Mean absolute direction error (°)")
    ax.set_title(title)
    ax.legend(loc="upper left", bbox_to_anchor=(1.01, 1.0))
    return fig


def plot_scenario_comparison(scenario_scores, models, title="Same methods on different synthetic data"):
    """シナリオ（合成データの成分の組み合わせ）ごとの誤差を、手法ごとの小さな図に並べる。"""
    fig, axes = plt.subplots(1, len(models), figsize=(5 * len(models), 4.5), sharey=True,
                             layout="constrained", squeeze=False)
    horizons = sorted(scenario_scores["horizon_h"].unique())
    for ax, spec in zip(axes[0], models):
        for scenario in dict.fromkeys(scenario_scores["scenario"]):
            part = scenario_scores[(scenario_scores["scenario"] == scenario) & (scenario_scores["model"] == spec)]
            colour, marker, label = SCENARIO_STYLES.get(scenario, (INK_MUTED, ".", scenario))
            ax.plot(part["horizon_h"], part["mae_deg"], color=colour, marker=marker,
                    linewidth=1.5, markersize=5, label=label, zorder=3)
        add_random_reference(ax, horizons[-1])
        ax.set_xticks(horizons)
        ax.set_title(model_label(spec, "en"))
        ax.set_xlabel("Lead time (hours ahead)")
    axes[0][0].set_ylabel("Mean absolute direction error (°)")
    axes[0][0].set_ylim(0, max(120, scenario_scores["mae_deg"].max() + 10))
    axes[0][-1].legend(loc="upper left", bbox_to_anchor=(1.01, 1.0))
    fig.suptitle(title)
    return fig


# ---------------------------------------------------------------------------
# ローレンツ系とAR(1)の図
# ---------------------------------------------------------------------------

def plot_twin_runs(runs, title="Lorenz-63: two runs that start almost at the same point"):
    """元の軌道と少しずらした軌道の x、その距離（対数目盛）を上下に並べる。twin_runs の結果を渡す。"""
    fig, (top, bottom) = plt.subplots(2, 1, figsize=(10, 6), sharex=True, layout="constrained")
    top.plot(runs["time"], runs["x_reference"], color=COLOURS[0], linewidth=1.2, label="Reference run")
    top.plot(runs["time"], runs["x_shifted"], color=COLOURS[1], linewidth=1.2, label="Slightly shifted start")
    top.set_ylabel("x")
    top.set_title(title)
    top.legend(loc="upper left")
    bottom.semilogy(runs["time"], runs["distance"], color=INK, linewidth=1.2)
    bottom.set_ylabel("Distance between runs")
    bottom.set_xlabel("Time (dimensionless Lorenz time units, not hours)")
    return fig


def plot_separation_growth(times, distances, tolerance, growth_rate=None,
                           title="Lorenz-63: growth of the distance between twin runs"):
    """出発点ごとの距離（細い灰色）と、その典型値（幾何平均、青）を対数目盛で描く。"""
    fig, ax = plt.subplots(figsize=(9, 4.8), layout="constrained")
    ax.semilogy(times, distances, color=INK_MUTED, linewidth=0.6, alpha=0.5)
    typical = np.exp(lorenz_demo.typical_log_distance(distances))
    ax.semilogy(times, typical, color=COLOURS[0], linewidth=2.0, label="Typical distance (geometric mean)")
    ax.axhline(tolerance, color=INK_SECONDARY, linewidth=1.0)
    ax.text(times[0], tolerance * 1.5, f"Tolerance = {tolerance}", ha="left", color=INK_SECONDARY, fontsize=8)
    if growth_rate is not None:
        guide = typical[0] * np.exp(growth_rate * times)
        visible = guide < tolerance * 10
        ax.semilogy(times[visible], guide[visible], color=COLOURS[1], linewidth=1.2,
                    label=f"Exponential growth, rate {growth_rate:.2f} per time unit")
    ax.set_xlabel("Time (dimensionless Lorenz time units, not hours)")
    ax.set_ylabel("Distance between runs (log scale)")
    ax.set_title(title)
    ax.legend(loc="lower right")
    return fig


def plot_predictability_times(table, tolerance, growth_rate=lorenz_demo.REFERENCE_LYAPUNOV_EXPONENT,
                              title="Lorenz-63: smaller initial errors buy only a little more time"):
    """初期誤差の大きさ（横軸、対数）と、距離が許容誤差に達するまでの時間（縦軸）。"""
    fig, ax = plt.subplots(figsize=(8, 4.8), layout="constrained")
    lower = table["median_time"] - table["q25_time"]
    upper = table["q75_time"] - table["median_time"]
    ax.errorbar(table["initial_error"], table["median_time"], yerr=[lower, upper], color=COLOURS[0],
                marker="o", markersize=6, linewidth=1.5, capsize=3, label="Median (bars: middle 50% of start points)")
    middle = len(table) // 2
    anchor_error = table["initial_error"].iloc[middle]
    anchor_time = table["median_time"].iloc[middle]
    errors = np.array(table["initial_error"], dtype=float)
    guide = anchor_time + np.log(anchor_error / errors) / growth_rate
    ax.plot(errors, guide, color=COLOURS[1], linewidth=1.2,
            label=f"Guide: ln(10)/λ = {np.log(10) / growth_rate:.1f} time units per 10× smaller error (λ = {growth_rate:.2f})")
    ax.set_xscale("log")
    ax.set_xlabel("Size of the initial error (log scale)")
    ax.set_ylabel(f"Time until distance > {tolerance} (Lorenz units)")
    ax.set_title(title)
    ax.legend(loc="upper right")
    return fig


def plot_ar1_vs_lorenz(ar_twin, ar_error, lorenz_times, lorenz_distances,
                       title="Stable AR(1) and Lorenz-63 behave in opposite ways"):
    """左：安定なAR(1)（同じ乱数で初期値だけ違う2本の差は縮む／新しい乱数のため予測誤差は増えて頭打ち）。
    右：ローレンツ系（乱数なしでも、初期値の小さな差が広がる）。"""
    fig, (left, right) = plt.subplots(1, 2, figsize=(11, 4.5), layout="constrained")
    left.semilogy(ar_twin["step"], ar_twin["gap"], color=COLOURS[0], marker="o", markersize=3,
                  linewidth=1.5, label="Gap between twin runs (same random shocks)")
    ar_error = ar_error[ar_error["step"] > 0]  # 0ステップ先の誤差は0で、対数目盛に描けない
    left.semilogy(ar_error["step"], ar_error["error_std"], color=COLOURS[1], marker="s", markersize=3,
                  linewidth=1.5, label="Typical forecast error (future shocks unknown)")
    left.set_xlabel("Steps (for example hours)")
    left.set_ylabel("Size (log scale)")
    left.set_title("Stable AR(1): randomness, not chaos")
    left.legend(loc="lower left", fontsize=8)
    right.semilogy(lorenz_times, np.exp(lorenz_demo.typical_log_distance(lorenz_distances)),
                   color=COLOURS[0], linewidth=1.5, label="Typical distance between twin runs")
    right.set_xlabel("Time (dimensionless Lorenz units)")
    right.set_title("Lorenz-63: deterministic chaos")
    right.legend(loc="lower right", fontsize=8)
    fig.suptitle(title)
    return fig
