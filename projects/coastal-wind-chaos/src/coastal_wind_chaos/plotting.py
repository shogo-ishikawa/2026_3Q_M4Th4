"""図を描く関数（matplotlib）。

apply_style() が日本語を表示できるフォントを探し、見つかれば図の文字を日本語に、見つからなければ
理由を表示して英語（英国式の綴り）にします。Colab の初期状態には日本語フォントがないので、英語になります。
どの関数も matplotlib の Figure を返すので、save_figure で保存できます。
"""

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib import font_manager
from matplotlib.colors import LinearSegmentedColormap
from matplotlib.ft2font import FT2Font

from . import lorenz_demo
from .wind_pipeline import (
    DIRECTION_LABELS,
    RANDOM_DIRECTION_EXPECTED_ERROR_DEG,
    direction_frequency_by_hour,
    model_label,
    parse_model,
    split_method,
)

SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_SECONDARY = "#52514e"
INK_MUTED = "#898781"
GRID = "#e1e0d9"
AXIS = "#c3c2b7"

# 色覚の多様性を考えて検証した8色。手法や条件ごとに色を固定し、図が変わっても同じ色にする。
COLOURS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]
BASELINE_STYLES = {
    "persistence": (COLOURS[0], "o"),
    "climatology": (COLOURS[1], "s"),
    "persistence_24h": (COLOURS[5], "h"),
}
FEATURE_STYLES = {
    "calendar": (COLOURS[2], "^"),
    "recent": (COLOURS[3], "v"),
    "calendar+recent": (COLOURS[4], "D"),
}
SCENARIO_STYLES = {
    "periodic_only": (COLOURS[0], "o", "周期成分のみ", "Periodic only"),
    "periodic_ar": (COLOURS[1], "s", "周期成分＋AR(1)", "Periodic + AR(1)"),
    "default": (COLOURS[2], "^", "すべての成分", "All components"),
    "no_precursor": (COLOURS[3], "D", "すべての成分（前線の予兆なし）", "All, fronts without precursor"),
}
SPLIT_COLOURS = {"train": COLOURS[0], "validation": COLOURS[3], "test": COLOURS[1]}
COMPASS_16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
              "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
BLUE_RAMP = LinearSegmentedColormap.from_list(
    "blue_ramp",
    [SURFACE, "#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"],
)

# 90度の線の説明。「予測の限界」ではなく「独立な一様ランダム方向予測の期待誤差」と書く。
RANDOM_LINE_TEXT = "Independent uniform random direction: expected error 90°"
RANDOM_LINE_TEXT_JA = "独立な一様ランダム方向予測の期待誤差：90°"

# 図の文字（日本語, 英語）。apply_style で決めた LANGUAGE の方を使う。
TEXTS = {
    "direction_axis": ("風向（吹いてくる方位）", "Direction (blowing from)"),
    "speed_axis": ("風速 (m/s)", "Wind speed (m/s)"),
    "time_axis": ("日時（日本時間）", "Time (JST)"),
    "target_time_axis": ("対象時刻（日本時間）", "Target time (JST)"),
    "timeseries_title": ("観測した風：{start} から {days} 日間", "Observed wind from {start} for {days} days (JST)"),
    "hour_axis": ("時刻（日本時間、その1時間の終わり）", "Hour of day (JST, end of the hour)"),
    "by_hour_title": ("時刻ごとの風向の割合", "Share of wind directions by hour of day"),
    "share_axis": ("その時刻のうちの割合 (%)", "Share of hours at that hour of day (%)"),
    "lead_axis": ("予測時間（何時間先か）", "Lead time (hours ahead)"),
    "mae_axis": ("平均絶対角度誤差（度）", "Mean absolute direction error (°)"),
    "rmse_axis": ("風ベクトルのRMSE (m/s)", "Wind vector RMSE (m/s)"),
    "horizon_title": ("予測時間と風向の誤差（最終テスト期間）", "Wind direction error vs lead time (final test period)"),
    "rmse_title": ("予測時間と風ベクトルの誤差（最終テスト期間）", "Wind vector error vs lead time (final test period)"),
    "target_hour_axis": ("対象時刻の時（日本時間）", "Hour of day of the target time (JST)"),
    "error_by_hour_title": ("対象時刻の時ごとの誤差", "Error by hour of day of the target time"),
    "scenario_title": ("同じ手法を、成分の違う合成データで比べる", "Same methods on different synthetic data"),
    "twin_title": ("ローレンツ系：ほとんど同じ点から始めた2本の軌道",
                   "Lorenz-63: two runs that start almost at the same point"),
    "reference_run": ("元の軌道", "Reference run"),
    "shifted_run": ("少しずらして始めた軌道", "Slightly shifted start"),
    "distance_axis": ("2本の距離", "Distance between runs"),
    "distance_log_axis": ("2本の距離（対数目盛）", "Distance between runs (log scale)"),
    "lorenz_time_axis": ("時間（ローレンツ系の無次元の時間。時間（hour）ではない）",
                         "Time (dimensionless Lorenz time units, not hours)"),
    "lorenz_time_short": ("時間（ローレンツ系の無次元の時間）", "Time (dimensionless Lorenz units)"),
    "growth_title": ("ローレンツ系：双子の軌道の距離が広がる", "Lorenz-63: growth of the distance between twin runs"),
    "typical_distance": ("典型的な距離（幾何平均）", "Typical distance (geometric mean)"),
    "tolerance": ("許容誤差 = {value}", "Tolerance = {value}"),
    "exponential_guide": ("指数関数的な増加、成長率 {rate:.2f}（無次元の時間あたり）",
                          "Exponential growth, rate {rate:.2f} per time unit"),
    "predictability_title": ("ローレンツ系：初期誤差を小さくしても、延びる時間はわずか",
                             "Lorenz-63: smaller initial errors buy only a little more time"),
    "median_bars": ("中央値（棒は出発点の真ん中50%）", "Median (bars: middle 50% of start points)"),
    "ln10_guide": ("目安：ln(10)/λ = 初期誤差を10分の1にするごとに {step:.1f}（λ = {rate:.2f}）",
                   "Guide: ln(10)/λ = {step:.1f} time units per 10× smaller error (λ = {rate:.2f})"),
    "initial_error_axis": ("初期誤差の大きさ（対数目盛）", "Size of the initial error (log scale)"),
    "reach_time_axis": ("距離が {value} を超えるまでの時間（無次元）", "Time until distance > {value} (Lorenz units)"),
    "ar1_title": ("安定なAR(1)とローレンツ系は逆のふるまい", "Stable AR(1) and Lorenz-63 behave in opposite ways"),
    "ar1_gap": ("双子の差（同じ乱数）", "Gap between twin runs (same random shocks)"),
    "ar1_error": ("典型的な予測誤差（これから加わる乱数は分からない）", "Typical forecast error (future shocks unknown)"),
    "steps_axis": ("ステップ（例えば1時間）", "Steps (for example hours)"),
    "size_log_axis": ("大きさ（対数目盛）", "Size (log scale)"),
    "ar1_left_title": ("安定なAR(1)：乱数による変動で、カオスではない", "Stable AR(1): randomness, not chaos"),
    "lorenz_typical": ("双子の典型的な距離", "Typical distance between twin runs"),
    "lorenz_right_title": ("ローレンツ系：決定論的なカオス", "Lorenz-63: deterministic chaos"),
    "dt_title": ("ローレンツ系：積分の刻み dt を小さくしても結果はほぼ同じ",
                 "Lorenz-63: a smaller time step gives almost the same result"),
    "dt_label": ("dt = {dt}", "dt = {dt}"),
    "angle_title": ("実験1：同じ入力・同じモデルで、u, v を回帰するか角度を直接回帰するか",
                    "Experiment 1: same inputs and model, u, v or the angle as target"),
    "sector_axis": ("観測した風向（対象時刻）", "Observed direction at the target time"),
    "predicted_axis": ("予測した風向（度）", "Predicted direction (°)"),
    "observed_axis": ("観測した風向（度）", "Observed direction (°)"),
    "angle_left_title": ("観測した風向ごとの平均誤差", "Mean error by observed direction"),
    "angle_right_title": ("観測と予測：{label}", "Observed and predicted: {label}"),
    "uv_target": ("u, v を回帰", "u, v as target"),
    "window_title": ("{name}：{start} から48時間（3時間先の予測を対象時刻の位置に描く）",
                     "{name}: 48 hours from {start} (3-hour forecasts plotted at their target time)"),
    "calm_window": ("急な変化のない穏やかな期間", "Steady period without abrupt changes"),
    "abrupt_window": ("急変を含む期間", "Period with an abrupt change"),
    "observed": ("観測", "Observed"),
    "window_mae": ("{label}\n平均誤差 {mae:.0f}°", "{label}\nmean error {mae:.0f}°"),
    "split_title": ("時間順の分割（学習・検証・最終テスト）", "Time-ordered split (training, validation, final test)"),
    "split_note": ("濃い部分：各期間の最後の{hours}時間（max_horizon）。評価ではこの時間の予測起点を使わない",
                   "Darker band: last {hours} h of each period (max_horizon); issue times there are not evaluated"),
    "weekly_u": ("u の1週間平均", "Weekly mean of u"),
    "train_period": ("学習", "Training"),
    "validation_period": ("検証", "Validation"),
    "test_period": ("最終テスト", "Final test"),
}

LANGUAGE = "en"  # apply_style で決める
FONT_NAME = None
JAPANESE_FONT_NAMES = [
    "Noto Sans CJK JP", "Noto Sans JP", "IPAexGothic", "IPAGothic", "IPAPGothic", "TakaoGothic",
    "VL Gothic", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "MS Gothic",
    "BIZ UDGothic", "Source Han Sans JP", "Noto Serif CJK JP", "IPAexMincho",
]
JAPANESE_FILE_HINTS = ["cjk", "jp", "ipa", "takao", "vl-gothic", "hiragino", "yugoth", "meiryo", "msgothic",
                       "bizud", "sourcehansans"]
FONT_FOLDERS = ["/usr/share/fonts", "/usr/local/share/fonts", "~/.fonts", "~/.local/share/fonts",
                "/Library/Fonts", "/System/Library/Fonts", "C:/Windows/Fonts"]
JAPANESE_TEST_TEXT = "風向の予測"


def text(key, **values):
    """図の文字を、いまの言語（LANGUAGE）で返す。"""
    japanese, english = TEXTS[key]
    return (japanese if LANGUAGE == "ja" else english).format(**values)


def label_of(spec):
    """手法の表示名（いまの言語）。"""
    return model_label(spec, LANGUAGE)


def font_has_japanese(path):
    """フォントファイルに、日本語のかなと漢字の字形があれば True。"""
    try:
        font = FT2Font(str(path))
    except (OSError, RuntimeError, ValueError):
        return False
    return all(font.get_char_index(ord(character)) != 0 for character in JAPANESE_TEST_TEXT)


def find_japanese_font(font_path=None):
    """日本語を表示できるフォントを探す。見つかれば（フォント名, ファイル）、なければ（None, 理由）。

    1. font_path を渡したら、そのファイルを使う
    2. matplotlib が知っているフォントから、よく使われる日本語フォントの名前を探す
    3. あとから入れたフォント（Colab で apt-get で入れた場合など）を、よく置かれる場所から探す
    """
    if font_path is not None:
        if not font_has_japanese(font_path):
            return None, f"{font_path} は日本語の文字を表示できるフォントではありません"
        font_manager.fontManager.addfont(str(font_path))
        return font_manager.FontProperties(fname=str(font_path)).get_name(), str(font_path)
    for entry in font_manager.fontManager.ttflist:
        if entry.name in JAPANESE_FONT_NAMES and font_has_japanese(entry.fname):
            return entry.name, entry.fname
    for folder in FONT_FOLDERS:
        folder = Path(folder).expanduser()
        if not folder.is_dir():
            continue
        for path in sorted(folder.rglob("*")):
            name = path.name.lower().replace("_", "").replace(" ", "")
            if path.suffix.lower() in (".ttf", ".otf", ".ttc") and any(hint in name for hint in JAPANESE_FILE_HINTS):
                if font_has_japanese(path):
                    font_manager.fontManager.addfont(str(path))
                    return font_manager.FontProperties(fname=str(path)).get_name(), str(path)
    return None, "日本語の文字を表示できるフォントが見つかりませんでした"


def apply_style(language="auto", font_path=None, verbose=True):
    """図の見た目をそろえ、図の文字の言語を決める。最初に1回呼ぶ。戻り値は "ja" か "en"。

    language="auto" または "ja"：日本語フォントを探し、見つかれば日本語、なければ理由を表示して英語にする。
    language="en"：英語にする。font_path に日本語フォントのファイルを渡すと、それを使う。
    """
    global LANGUAGE, FONT_NAME
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
    if language not in ("auto", "ja", "en"):
        raise ValueError("language は \"auto\"、\"ja\"、\"en\" のどれかにしてください。")
    if language == "en":
        LANGUAGE, FONT_NAME = "en", None
        message = "図の文字は英語にします（language=\"en\"）。"
    else:
        name, detail = find_japanese_font(font_path)
        if name is None:
            LANGUAGE, FONT_NAME = "en", None
            message = (f"{detail}。文字化けを防ぐため、図の文字を英語にします"
                       "（日本語フォントを入れる方法は README の「図の文字」）。")
        else:
            LANGUAGE, FONT_NAME = "ja", name
            plt.rcParams["font.family"] = "sans-serif"
            plt.rcParams["font.sans-serif"] = [name] + [font for font in plt.rcParams["font.sans-serif"] if font != name]
            plt.rcParams["axes.unicode_minus"] = False  # マイナス記号の字形がないフォントでも表示できるようにする
            message = f"日本語フォント「{name}」（{detail}）を使い、図の文字を日本語にします。"
    if verbose:
        print(message)
    return LANGUAGE


def save_figure(fig, path):
    """図をPNGで保存する（フォルダがなければ作る）。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=150, bbox_inches="tight")
    return path


def model_style(spec):
    """手法ごとの色と印。基準予報は手法ごと、機械学習は特徴量の組ごとに色を決め、勾配ブースティングは
    印を変える。角度を直接回帰する手法と悪い例は別の色。"""
    method, feature_set = parse_model(spec)
    if method in BASELINE_STYLES:
        return BASELINE_STYLES[method]
    if method == "degrees_as_numbers":
        return COLOURS[6], "X"
    base, angle = split_method(method)
    colour, marker = (COLOURS[7], "<") if angle else FEATURE_STYLES.get(feature_set, (INK_MUTED, "."))
    if base.startswith("boosting"):
        marker = "P"
    return colour, marker


def add_random_reference(ax, x_right):
    """90度の参照線（独立な一様ランダム方向予測の期待誤差）を引く。予測の限界を表す線ではない。"""
    ax.axhline(RANDOM_DIRECTION_EXPECTED_ERROR_DEG, color=INK_MUTED, linewidth=1.0, zorder=1)
    # 線と重なっても読めるよう、文字の後ろに半透明の背景を付ける
    ax.text(x_right, RANDOM_DIRECTION_EXPECTED_ERROR_DEG + 1.5,
            RANDOM_LINE_TEXT_JA if LANGUAGE == "ja" else RANDOM_LINE_TEXT,
            ha="right", va="bottom", color=INK_SECONDARY, fontsize=8, zorder=4,
            bbox={"boxstyle": "square,pad=0.1", "facecolor": SURFACE, "edgecolor": "none", "alpha": 0.8})


def set_direction_axis(ax):
    """縦軸を風向（0〜360度）にする。北は0度と360度の両方にある。"""
    ax.set_ylim(-15, 375)
    ax.set_yticks([0, 90, 180, 270, 360], ["N 0°", "E 90°", "S 180°", "W 270°", "N 360°"])


def set_horizon_ticks(ax, horizons):
    """予測時間の目盛り。多いときは12時間ごと。"""
    ax.set_xticks(horizons if len(horizons) <= 12 else list(range(0, max(horizons) + 1, 12)))


# ---------------------------------------------------------------------------
# データを眺める図
# ---------------------------------------------------------------------------

def plot_direction_timeseries(weather, start, days=7):
    """風向（点）と風速（線）の時系列。

    風向は0度と360度がつながっているため、線で結ぶと北風のたびに上下へ大きく跳ぶ。そのため点で描く。
    """
    start = pd.Timestamp(start)
    part = weather.loc[start:start + pd.Timedelta(days=days)]
    fig, (top, bottom) = plt.subplots(2, 1, figsize=(10, 5), sharex=True, layout="constrained")
    top.scatter(part.index, part["wind_direction_deg"], s=14, color=COLOURS[0])
    set_direction_axis(top)
    top.set_ylabel(text("direction_axis"))
    top.set_title(text("timeseries_title", start=f"{start:%Y-%m-%d %H:%M}", days=days))
    bottom.plot(part.index, part["wind_speed_ms"], color=COLOURS[0], linewidth=1.5)
    bottom.set_ylabel(text("speed_axis"))
    bottom.set_xlabel(text("time_axis"))
    return fig


def plot_direction_by_hour(weather, title=None):
    """時刻（横軸）ごとに、どの方位から風が吹いたかの割合（色の濃さ）を描く。"""
    table = direction_frequency_by_hour(weather)
    fig, ax = plt.subplots(figsize=(9, 5), layout="constrained")
    image = ax.imshow(table.to_numpy(), origin="lower", aspect="auto", cmap=BLUE_RAMP,
                      extent=[-0.5, 23.5, -0.5, 15.5])
    ax.set_xticks(range(0, 24, 3))
    ax.set_yticks(range(16), DIRECTION_LABELS if LANGUAGE == "ja" else COMPASS_16)
    ax.set_xlabel(text("hour_axis"))
    ax.set_ylabel(text("direction_axis"))
    ax.set_title(title or text("by_hour_title"))
    ax.grid(False)
    colourbar = fig.colorbar(image, ax=ax)
    colourbar.set_label(text("share_axis"))
    return fig


def plot_time_split(weather, split, max_horizon):
    """学習・検証・最終テストの期間と、評価に使う予測起点の範囲を時間軸に描く。"""
    hour = pd.Timedelta(hours=1)
    fig, ax = plt.subplots(figsize=(10, 2.4), layout="constrained")
    ax.plot(weather.index, weather["u_ms"].rolling(24 * 7, min_periods=1).mean(), color=INK_MUTED, linewidth=0.8)
    periods = [("train", split["start"], split["validation_start"] or split["test_start"])]
    if split.get("validation_start") is not None:
        periods.append(("validation", split["validation_start"], split["test_start"]))
    periods.append(("test", split["test_start"], split["end"] + hour))
    for name, start, end in periods:
        ax.axvspan(start, end, color=SPLIT_COLOURS[name], alpha=0.15, linewidth=0)
        ax.axvspan(end - pd.Timedelta(hours=max_horizon), end, color=SPLIT_COLOURS[name], alpha=0.35, linewidth=0)
        ax.text(start + (end - start) / 2, 1.02, text(f"{name}_period"), transform=ax.get_xaxis_transform(),
                ha="center", va="bottom", color=INK)
    ax.set_yticks([])
    ax.set_ylabel(text("weekly_u"))
    ax.set_xlabel(text("time_axis") + "\n" + text("split_note", hours=max_horizon))
    ax.set_title(text("split_title"), pad=18)
    return fig


# ---------------------------------------------------------------------------
# 予測の評価の図
# ---------------------------------------------------------------------------

def plot_error_vs_horizon(scores, models=None, title=None):
    """予測時間（横軸）と平均絶対角度誤差（縦軸）。90度の参照線つき。"""
    if models is None:
        models = list(dict.fromkeys(scores["model"]))
    horizons = sorted(scores["horizon_h"].unique())
    fig, ax = plt.subplots(figsize=(9, 4.8), layout="constrained")
    for spec in models:
        part = scores[scores["model"] == spec].sort_values("horizon_h")
        colour, marker = model_style(spec)
        ax.plot(part["horizon_h"], part["mae_deg"], color=colour, marker=marker if len(horizons) <= 12 else None,
                linewidth=1.5, markersize=5, label=label_of(spec), zorder=3)
    add_random_reference(ax, horizons[-1])
    set_horizon_ticks(ax, horizons)
    ax.set_ylim(0, max(100, scores["mae_deg"].max() + 10))
    ax.set_xlabel(text("lead_axis"))
    ax.set_ylabel(text("mae_axis"))
    ax.set_title(title or text("horizon_title"))
    ax.legend(loc="upper left", bbox_to_anchor=(1.01, 1.0))
    return fig


def plot_vector_rmse_vs_horizon(scores, models=None, title=None):
    """予測時間（横軸）と風ベクトルのRMSE（縦軸）。風向だけを予測する手法は描かない（対象外）。"""
    if models is None:
        models = list(dict.fromkeys(scores["model"]))
    models = [spec for spec in models if scores.loc[scores["model"] == spec, "vector_rmse_ms"].notna().any()]
    horizons = sorted(scores["horizon_h"].unique())
    fig, ax = plt.subplots(figsize=(9, 4.5), layout="constrained")
    for spec in models:
        part = scores[scores["model"] == spec].sort_values("horizon_h")
        colour, marker = model_style(spec)
        ax.plot(part["horizon_h"], part["vector_rmse_ms"], color=colour, marker=marker if len(horizons) <= 12 else None,
                linewidth=1.5, markersize=5, label=label_of(spec), zorder=3)
    set_horizon_ticks(ax, horizons)
    ax.set_ylim(0, None)
    ax.set_xlabel(text("lead_axis"))
    ax.set_ylabel(text("rmse_axis"))
    ax.set_title(title or text("rmse_title"))
    ax.legend(loc="upper left", bbox_to_anchor=(1.01, 1.0))
    return fig


def plot_error_by_hour(hourly_errors, title=None):
    """対象時刻の時（0〜23時）ごとの平均絶対角度誤差。error_by_hour の結果を渡す。"""
    fig, ax = plt.subplots(figsize=(9, 4.5), layout="constrained")
    for spec in hourly_errors.columns:
        colour, marker = model_style(spec)
        ax.plot(hourly_errors.index, hourly_errors[spec], color=colour, marker=marker,
                linewidth=1.5, markersize=4, label=label_of(spec), zorder=3)
    add_random_reference(ax, 23)
    ax.set_xticks(range(0, 24, 3))
    ax.set_ylim(0, max(100, float(np.nanmax(hourly_errors.to_numpy())) + 10))
    ax.set_xlabel(text("target_hour_axis"))
    ax.set_ylabel(text("mae_axis"))
    ax.set_title(title or text("error_by_hour_title"))
    ax.legend(loc="upper left", bbox_to_anchor=(1.01, 1.0))
    return fig


def plot_angle_trap(by_direction, forecasts, pair, title=None):
    """実験1：左は観測した風向（16方位）ごとの平均誤差、右は観測と予測の散布図（pair の2手法）。

    by_direction は experiments.error_by_target_direction の結果。pair は（u, v を回帰する手法,
    同じ設定で角度を直接回帰する手法）。
    """
    fig, (left, middle, right) = plt.subplots(1, 3, figsize=(15, 4.6), layout="constrained",
                                               gridspec_kw={"width_ratios": [1.4, 1, 1]})
    for spec in by_direction.columns:
        colour, marker = model_style(spec)
        left.plot(range(16), by_direction[spec], color=colour, marker=marker, linewidth=1.5, markersize=5,
                  label=label_of(spec), zorder=3)
    left.set_xticks(range(16), DIRECTION_LABELS if LANGUAGE == "ja" else COMPASS_16, rotation=90)
    left.set_xlabel(text("sector_axis"))
    left.set_ylabel(text("mae_axis"))
    left.set_ylim(0, None)
    left.set_title(text("angle_left_title"))
    fig.legend(*left.get_legend_handles_labels(), loc="outside lower center", ncol=2, fontsize=8)
    rows = forecasts[forecasts["target_direction_deg"].notna() & (forecasts["excluded"] == "")]
    sample = rows.iloc[:: max(1, len(rows) // 1500)]
    for ax, spec in zip([middle, right], pair):
        colour, _ = model_style(spec)
        ax.scatter(sample["target_direction_deg"], sample[spec], s=5, color=colour, alpha=0.5)
        ax.plot([0, 360], [0, 360], color=INK_MUTED, linewidth=0.8)
        ax.set_xlim(-10, 370)
        set_direction_axis(ax)
        ax.set_xticks([0, 90, 180, 270, 360])
        ax.set_xlabel(text("observed_axis"))
        ax.set_ylabel(text("predicted_axis"))
        method = parse_model(spec)[0]
        separator = "・" if LANGUAGE == "ja" else ", "
        name = label_of(method) if split_method(method)[1] else f"{label_of(method)}{separator}{text('uv_target')}"
        ax.set_title(text("angle_right_title", label=name), fontsize=9)
    fig.suptitle(title or text("angle_title"))
    return fig


def plot_example(result, name):
    """実験2の結果 result から、例の期間 name（"calm" か "abrupt"）の図を描く。

    規則どおりに選べなかった期間は、条件を緩めて別の期間を選ぶことはせず、図を作らずに理由を表示して
    None を返す（CLI と Notebook で同じ扱いにする）。
    """
    if name not in result["examples"]:
        print(f"例の期間（{TEXTS[name + '_window'][0]}）の図を省略します：{result['window_notes'][name]}")
        return None
    return plot_example_window(result["examples"][name], result["models"], f"{name}_window")


def plot_example_window(window, models, name_key, title=None):
    """実験2：48時間の、観測した風向（灰色）と各手法の3時間先の予測（色）を、手法ごとの小さな図に並べる。

    window は experiments.window_forecasts の結果。横軸は対象時刻（予測を出した時刻の3時間後）。
    """
    n_columns = 3
    n_rows = int(np.ceil(len(models) / n_columns))
    fig, axes = plt.subplots(n_rows, n_columns, figsize=(14, 3.2 * n_rows), sharex=True, sharey=True,
                             layout="constrained", squeeze=False)
    for ax, spec in zip(axes.flat, models):
        colour, marker = model_style(spec)
        ax.scatter(window["target_time"], window["target_direction_deg"], s=16, color=INK_MUTED, label=text("observed"))
        ax.scatter(window["target_time"], window[spec], s=12, color=colour, marker=marker, label=label_of(spec))
        errors = window[f"{spec} error"]
        ax.set_title(text("window_mae", label=label_of(spec), mae=errors.mean()), fontsize=9)
        set_direction_axis(ax)
        ax.tick_params(axis="x", labelrotation=30)
    for ax in axes.flat[len(models):]:
        ax.set_visible(False)
    for ax in axes[:, 0]:
        ax.set_ylabel(text("direction_axis"))
    for ax in axes[-1, :]:
        ax.set_xlabel(text("target_time_axis"))
    start = window["target_time"].min()
    fig.suptitle(title or text("window_title", name=text(name_key), start=f"{start:%Y-%m-%d %H:%M}"))
    return fig


def plot_scenario_comparison(scenario_scores, models, title=None):
    """シナリオ（合成データの成分の組み合わせ）ごとの誤差を、手法ごとの小さな図に並べる。"""
    fig, axes = plt.subplots(1, len(models), figsize=(5 * len(models), 4.5), sharey=True,
                             layout="constrained", squeeze=False)
    horizons = sorted(scenario_scores["horizon_h"].unique())
    for ax, spec in zip(axes[0], models):
        for scenario in dict.fromkeys(scenario_scores["scenario"]):
            part = scenario_scores[(scenario_scores["scenario"] == scenario) & (scenario_scores["model"] == spec)]
            colour, marker, japanese, english = SCENARIO_STYLES.get(scenario, (INK_MUTED, ".", scenario, scenario))
            ax.plot(part["horizon_h"], part["mae_deg"], color=colour, marker=marker if len(horizons) <= 12 else None,
                    linewidth=1.5, markersize=5, label=japanese if LANGUAGE == "ja" else english, zorder=3)
        add_random_reference(ax, horizons[-1])
        set_horizon_ticks(ax, horizons)
        ax.set_title(label_of(spec), fontsize=9)
        ax.set_xlabel(text("lead_axis"))
    axes[0][0].set_ylabel(text("mae_axis"))
    axes[0][0].set_ylim(0, max(120, scenario_scores["mae_deg"].max() + 10))
    axes[0][-1].legend(loc="upper left", bbox_to_anchor=(1.01, 1.0))
    fig.suptitle(title or text("scenario_title"))
    return fig


# ---------------------------------------------------------------------------
# ローレンツ系とAR(1)の図
# ---------------------------------------------------------------------------

def plot_twin_runs(runs, title=None):
    """元の軌道と少しずらした軌道の x、その距離（対数目盛）を上下に並べる。twin_runs の結果を渡す。"""
    fig, (top, bottom) = plt.subplots(2, 1, figsize=(10, 6), sharex=True, layout="constrained")
    top.plot(runs["time"], runs["x_reference"], color=COLOURS[0], linewidth=1.2, label=text("reference_run"))
    top.plot(runs["time"], runs["x_shifted"], color=COLOURS[1], linewidth=1.2, label=text("shifted_run"))
    top.set_ylabel("x")
    top.set_title(title or text("twin_title"))
    top.legend(loc="upper left")
    bottom.semilogy(runs["time"], runs["distance"], color=INK, linewidth=1.2)
    bottom.set_ylabel(text("distance_axis"))
    bottom.set_xlabel(text("lorenz_time_axis"))
    return fig


def plot_separation_growth(times, distances, tolerance, growth_rate=None, title=None):
    """出発点ごとの距離（細い灰色）と、その典型値（幾何平均、青）を対数目盛で描く。"""
    fig, ax = plt.subplots(figsize=(9, 4.8), layout="constrained")
    ax.semilogy(times, distances, color=INK_MUTED, linewidth=0.6, alpha=0.5)
    typical = np.exp(lorenz_demo.typical_log_distance(distances))
    ax.semilogy(times, typical, color=COLOURS[0], linewidth=2.0, label=text("typical_distance"))
    ax.axhline(tolerance, color=INK_SECONDARY, linewidth=1.0)
    ax.text(times[0], tolerance * 1.5, text("tolerance", value=tolerance), ha="left", color=INK_SECONDARY, fontsize=8)
    if growth_rate is not None:
        guide = typical[0] * np.exp(growth_rate * times)
        visible = guide < tolerance * 10
        ax.semilogy(times[visible], guide[visible], color=COLOURS[1], linewidth=1.2,
                    label=text("exponential_guide", rate=growth_rate))
    ax.set_xlabel(text("lorenz_time_axis"))
    ax.set_ylabel(text("distance_log_axis"))
    ax.set_title(title or text("growth_title"))
    ax.legend(loc="lower right")
    return fig


def plot_predictability_times(table, tolerance, growth_rate=lorenz_demo.REFERENCE_LYAPUNOV_EXPONENT, title=None):
    """初期誤差の大きさ（横軸、対数）と、距離が許容誤差に達するまでの時間（縦軸）。"""
    fig, ax = plt.subplots(figsize=(8, 4.8), layout="constrained")
    lower = table["median_time"] - table["q25_time"]
    upper = table["q75_time"] - table["median_time"]
    ax.errorbar(table["initial_error"], table["median_time"], yerr=[lower, upper], color=COLOURS[0],
                marker="o", markersize=6, linewidth=1.5, capsize=3, label=text("median_bars"))
    middle = len(table) // 2
    anchor_error = table["initial_error"].iloc[middle]
    anchor_time = table["median_time"].iloc[middle]
    errors = np.array(table["initial_error"], dtype=float)
    guide = anchor_time + np.log(anchor_error / errors) / growth_rate
    ax.plot(errors, guide, color=COLOURS[1], linewidth=1.2,
            label=text("ln10_guide", step=np.log(10) / growth_rate, rate=growth_rate))
    ax.set_xscale("log")
    ax.set_xlabel(text("initial_error_axis"))
    ax.set_ylabel(text("reach_time_axis", value=tolerance))
    ax.set_title(title or text("predictability_title"))
    ax.legend(loc="upper right")
    return fig


def plot_time_step_check(table, title=None):
    """積分の刻み dt ごとに、初期誤差と「許容誤差に達するまでの時間（中央値）」を重ねて描く。"""
    fig, ax = plt.subplots(figsize=(8, 4.5), layout="constrained")
    markers = ["o", "s", "^", "D"]
    for number, (dt, part) in enumerate(table.groupby("dt", sort=False)):
        ax.plot(part["initial_error"], part["median_time"], color=COLOURS[number % len(COLOURS)],
                marker=markers[number % len(markers)], linewidth=1.2, markersize=6 - number,
                label=text("dt_label", dt=dt))
    ax.set_xscale("log")
    ax.set_xlabel(text("initial_error_axis"))
    ax.set_ylabel(text("reach_time_axis", value=table["tolerance"].iloc[0]))
    ax.set_title(title or text("dt_title"))
    ax.legend(loc="upper right")
    return fig


def plot_ar1_vs_lorenz(ar_twin, ar_error, lorenz_times, lorenz_distances, title=None):
    """左：安定なAR(1)（同じ乱数で初期値だけ違う2本の差は縮む／新しい乱数のため予測誤差は増えて頭打ち）。
    右：ローレンツ系（乱数なしでも、初期値の小さな差が広がる）。"""
    fig, (left, right) = plt.subplots(1, 2, figsize=(11, 4.5), layout="constrained")
    left.semilogy(ar_twin["step"], ar_twin["gap"], color=COLOURS[0], marker="o", markersize=3,
                  linewidth=1.5, label=text("ar1_gap"))
    ar_error = ar_error[ar_error["step"] > 0]  # 0ステップ先の誤差は0で、対数目盛に描けない
    left.semilogy(ar_error["step"], ar_error["error_std"], color=COLOURS[1], marker="s", markersize=3,
                  linewidth=1.5, label=text("ar1_error"))
    left.set_xlabel(text("steps_axis"))
    left.set_ylabel(text("size_log_axis"))
    left.set_title(text("ar1_left_title"))
    left.legend(loc="lower left", fontsize=8)
    right.semilogy(lorenz_times, np.exp(lorenz_demo.typical_log_distance(lorenz_distances)),
                   color=COLOURS[0], linewidth=1.5, label=text("lorenz_typical"))
    right.set_xlabel(text("lorenz_time_short"))
    right.set_title(text("lorenz_right_title"))
    right.legend(loc="lower right", fontsize=8)
    fig.suptitle(title or text("ar1_title"))
    return fig
