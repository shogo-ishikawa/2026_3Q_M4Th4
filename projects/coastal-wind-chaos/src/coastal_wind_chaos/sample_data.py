"""南側に海がある仮想観測点の、1時間ごとの気象データ（合成データ）を作る。

これは気象庁の観測値ではありません。海風・陸風、季節変化、数日規模の変動、
前線の通過、観測誤差などを、簡単な式と乱数で組み合わせた「現象のモデル」です。
大気の流れを物理法則に従って計算する数値予報とは違います。

風は東向きの成分 u と北向きの成分 v で作り、成分ごとに足し合わせます。
風向の角度どうしを足すと、0度と360度の境目で意味のない値になるためです。

この仮想地点では、日中は南の海から吹く海風、夜は北の陸から吹く陸風になるように
設定しています。実際の海岸では、海の向きや地形によって風向は変わります。

時刻は日本標準時です。気象庁の時別値と同じく、各行の時刻はその1時間の終わりを表し、
1日は1時から始まって翌日の0時（24時）で終わります。
"""

import csv
import io
from pathlib import Path

import numpy as np
import pandas as pd

from .wind_pipeline import (
    CALM_LABEL,
    CALM_SPEED_MS,
    angular_error,
    degrees_to_direction_label,
    prepare_weather,
    uv_to_direction,
    year_fraction,
)

DEFAULT_SETTINGS = {
    "start": "2023-01-01",           # 最初の日（この日の1時から始まる）
    "years": 3,                      # 何年分作るか
    "seed": 2026,                    # 乱数の種（同じなら同じデータになる）
    "station_name": "仮想海辺観測点（合成）",
    "latitude_deg": 35.0,            # 日の出・日の入りの計算に使う緯度
    # 周期成分（季節変化と日周期）
    "use_periodic": True,
    "breeze_strength": 1.0,          # 海風・陸風の強さの倍率
    "monsoon_strength": 1.0,         # 季節風の強さの倍率
    # 背景成分（数日かけてゆっくり変わる確率的な変動）
    "use_background": True,
    "background_strength": 1.0,
    "background_days": 3.0,          # 変化の目安の時間（日）
    # 不規則成分（AR(1)：1時間前の状態と相関する確率的な変動）
    "use_ar": True,
    "ar_strength": 1.0,
    "ar_phi": 0.85,                  # 1時間前との相関の強さ（-1 より大きく 1 より小さい）
    # 前線通過イベント（急変）
    "use_fronts": True,
    "front_strength": 1.0,
    "front_interval_days": 6.0,      # 前線が来る平均の間隔（日）
    "front_precursor_hours": 12,     # 通過前に気圧が下がり始める時間。0 なら予兆なし
    # 観測
    "observation_noise_ms": 0.3,     # u, v に加える観測誤差の標準偏差 (m/s)
    "missing_rate": 0.001,           # 欠測が始まる割合（1時間あたり）
}

PRESETS = {
    "default": {},
    "periodic_only": {"use_background": False, "use_ar": False, "use_fronts": False},
    "periodic_ar": {"use_background": False, "use_fronts": False},
    "no_precursor": {"front_precursor_hours": 0},
}
PRESET_LABELS = {
    "default": "すべての成分（周期＋背景＋AR＋前線）",
    "periodic_only": "周期成分のみ",
    "periodic_ar": "周期成分＋AR変動",
    "no_precursor": "すべての成分（前線の予兆なし）",
}

# 気象庁のCSVと同じ並びの列：（要素名, 補助見出し, 情報の種類, 列名）
JMA_LAYOUT = [
    ("気温(℃)", "", "", "temperature_c"),
    ("気温(℃)", "", "品質情報", "temperature_c_quality"),
    ("気温(℃)", "", "均質番号", "temperature_c_homogeneity"),
    ("日照時間(時間)", "", "", "sunshine_h"),
    ("日照時間(時間)", "", "現象なし情報", "sunshine_h_no_phenomenon"),
    ("日照時間(時間)", "", "品質情報", "sunshine_h_quality"),
    ("日照時間(時間)", "", "均質番号", "sunshine_h_homogeneity"),
    ("風速(m/s)", "", "", "wind_speed_ms"),
    ("風速(m/s)", "", "品質情報", "wind_speed_ms_quality"),
    ("風速(m/s)", "風向", "", "wind_direction"),
    ("風速(m/s)", "風向", "品質情報", "wind_direction_quality"),
    ("風速(m/s)", "", "均質番号", "wind_speed_ms_homogeneity"),
    ("海面気圧(hPa)", "", "", "sea_level_pressure_hpa"),
    ("海面気圧(hPa)", "", "品質情報", "sea_level_pressure_hpa_quality"),
    ("海面気圧(hPa)", "", "均質番号", "sea_level_pressure_hpa_homogeneity"),
]


# ---------------------------------------------------------------------------
# 設定と時刻
# ---------------------------------------------------------------------------

def make_settings(preset="default", **changes):
    """既定の設定に、プリセットと個別の変更を重ねた設定（辞書）を返す。

    例：make_settings("periodic_ar", ar_strength=2.0, seed=1)
    """
    if preset not in PRESETS:
        raise ValueError(f"未知のプリセットです: {preset}（{', '.join(PRESETS)} のどれか）")
    settings = dict(DEFAULT_SETTINGS)
    settings.update(PRESETS[preset])
    for name, value in changes.items():
        if name not in DEFAULT_SETTINGS:
            raise ValueError(f"未知の設定です: {name}")
        settings[name] = value
    if not -1 < settings["ar_phi"] < 1:
        raise ValueError("安定なAR(1)にするため、ar_phi は -1 より大きく 1 より小さくしてください。")
    settings["preset"] = preset
    return settings


def make_hourly_times(start, years):
    """start の日の1時から、years 年後の同じ日の0時（前日の24時）までの1時間ごとの時刻。"""
    first_day = pd.Timestamp(start).normalize()
    last_time = first_day + pd.DateOffset(years=years)
    return pd.date_range(first_day + pd.Timedelta(hours=1), last_time,
                         freq=pd.Timedelta(hours=1), name="time")


# ---------------------------------------------------------------------------
# 周期成分（季節と日周期）
# ---------------------------------------------------------------------------

def sun_height(times, latitude_deg):
    """太陽の高さの目安 sin(太陽高度)。0 より大きければ太陽は地平線より上。

    東経135度の地点を想定し、日本標準時の12時に太陽が最も高くなる簡単な式。
    """
    times = pd.DatetimeIndex(times)
    declination = np.deg2rad(23.44) * np.sin(2 * np.pi * (year_fraction(times) - 80 / 365))
    hours = np.asarray(times.hour + times.minute / 60, dtype=float)
    hour_angle = np.deg2rad(15.0 * (hours - 12.0))
    latitude = np.deg2rad(latitude_deg)
    return (np.sin(latitude) * np.sin(declination)
            + np.cos(latitude) * np.cos(declination) * np.cos(hour_angle))


def daylight_fraction(times, latitude_deg):
    """その1時間（時刻の1時間前から時刻まで）のうち、太陽が出ていた割合。10分ごとに確かめる。"""
    checks = [sun_height(times - pd.Timedelta(minutes=minutes), latitude_deg) > 0
              for minutes in (5, 15, 25, 35, 45, 55)]
    return np.mean(checks, axis=0)


def monsoon_uv(season, strength):
    """季節風の成分。冬（1月中旬が最大）は北西から、夏は南東から吹く。"""
    m = strength * np.cos(2 * np.pi * (season - 0.04))
    u = 1.4 * m   # 冬（m > 0）は西から東へ向かう成分
    v = -1.4 * m  # 冬は北から南へ向かう成分
    return u, v


def breeze_uv(times, season, strength):
    """海風・陸風（日周期）の成分。

    この仮想地点は海が南にあるので、日中は南から吹く海風（v > 0）、
    夜は北から吹く陸風（v < 0）になる。春から夏に強い。北半球の海風でよく見られる
    ように（地形などによっては逆回りの例もある）、時刻とともに向きが時計回りに
    少しずつ変わるよう、東西成分 u も加える。
    """
    hours = np.asarray(pd.DatetimeIndex(times).hour, dtype=float)
    amplitude = strength * (2.4 + 0.8 * np.cos(2 * np.pi * (season - 0.45)))
    phase = 2 * np.pi * (hours - 14.0) / 24
    v = amplitude * (np.cos(phase) + 0.35 * np.cos(2 * phase))
    u = amplitude * 0.4 * np.sin(phase)
    return u, v


def temperature_cycle(times, season):
    """気温の季節変化（8月初めが最も暑い）と日変化（14時ごろ最高）。"""
    hours = np.asarray(pd.DatetimeIndex(times).hour, dtype=float)
    annual = 16.0 + 9.5 * np.cos(2 * np.pi * (season - 0.58))
    daily_range = 3.5 + 1.0 * np.cos(2 * np.pi * (season - 0.30))
    phase = 2 * np.pi * (hours - 14.0) / 24
    return annual + daily_range * (np.cos(phase) + 0.2 * np.cos(2 * phase)) / 1.2


def pressure_cycle(times, season):
    """海面気圧の季節変化（冬に高め）と、1日に2回の小さな変化（大気潮汐の簡略形）。"""
    hours = np.asarray(pd.DatetimeIndex(times).hour, dtype=float)
    return 1013.0 + 4.0 * np.cos(2 * np.pi * season) + 0.7 * np.cos(2 * np.pi * (hours - 10.0) / 12)


def cloud_cycle(season):
    """雲の多さ（0〜1）の季節変化。6月下旬ごろに多く、冬に少ない。"""
    return 0.45 + 0.15 * np.cos(2 * np.pi * (season - 0.48))


def periodic_components(times, settings):
    """季節と日周期だけで決まる成分（乱数を使わない）。"""
    season = year_fraction(times)
    n_hours = len(times)
    if not settings["use_periodic"]:
        zeros = np.zeros(n_hours)
        return {"u": zeros, "v": zeros.copy(), "temperature": np.full(n_hours, 16.0),
                "pressure": np.full(n_hours, 1013.0), "cloud": np.full(n_hours, 0.45)}
    monsoon_u, monsoon_v = monsoon_uv(season, settings["monsoon_strength"])
    breeze_u, breeze_v = breeze_uv(times, season, settings["breeze_strength"])
    return {
        "u": monsoon_u + breeze_u,
        "v": monsoon_v + breeze_v,
        "temperature": temperature_cycle(times, season),
        "pressure": pressure_cycle(times, season),
        "cloud": cloud_cycle(season),
    }


# ---------------------------------------------------------------------------
# 確率的な成分（背景成分と不規則成分）
# ---------------------------------------------------------------------------

def ar1_series(n_values, phi, std, rng):
    """AR(1)過程 x[k] = phi * x[k-1] + e[k] の乱数列。std は x そのものの標準偏差。

    |phi| < 1 なので安定（ばらつきが一定の大きさにとどまる）。決定論的なカオスではない。
    """
    noise = rng.normal(0.0, std * np.sqrt(1 - phi**2), size=n_values)
    values = np.zeros(n_values)
    values[0] = rng.normal(0.0, std)
    for k in range(1, n_values):
        values[k] = phi * values[k - 1] + noise[k]
    return values


def smooth_random_series(n_values, timescale_hours, std, rng):
    """数日かけてゆっくり変わる乱数列。AR(1)を24時間の移動平均で滑らかにする。"""
    raw = ar1_series(n_values + 23, np.exp(-1 / timescale_hours), 1.0, rng)
    smooth = np.convolve(raw, np.ones(24) / 24, mode="valid")
    return std * smooth / smooth.std()


def background_components(n_hours, settings, rng):
    """数日規模の背景成分（高気圧や低気圧の通過などをまとめて表す確率的な変動）。"""
    timescale = 24 * settings["background_days"]
    strength = settings["background_strength"]
    u = smooth_random_series(n_hours, timescale, 1.5 * strength, rng)
    v = smooth_random_series(n_hours, timescale, 1.5 * strength, rng)
    warm_part = smooth_random_series(n_hours, timescale, 1.5 * strength, rng)
    return {
        "u": u,
        "v": v,
        "temperature": 0.8 * v + warm_part,  # 南寄りの風のときは暖かくなりやすい
        "pressure": smooth_random_series(n_hours, timescale, 4.0 * strength, rng),
        "cloud": smooth_random_series(n_hours, timescale, 0.15 * strength, rng),
    }


def ar_components(n_hours, settings, rng):
    """不規則成分：1時間前と相関する確率的な変動（AR(1)）。"""
    phi = settings["ar_phi"]
    strength = settings["ar_strength"]
    return {
        "u": ar1_series(n_hours, phi, 1.0 * strength, rng),
        "v": ar1_series(n_hours, phi, 1.0 * strength, rng),
        "temperature": ar1_series(n_hours, 0.9, 0.5 * strength, rng),
        "pressure": ar1_series(n_hours, 0.9, 0.2 * strength, rng),
        "cloud": ar1_series(n_hours, 0.8, 0.1 * strength, rng),
    }


# ---------------------------------------------------------------------------
# 前線通過イベント
# ---------------------------------------------------------------------------

def front_passage_hours(n_hours, interval_days, rng):
    """前線が通過する時刻（先頭から何時間目か）を、ランダムな間隔で選ぶ。

    間隔は平均 interval_days 日の指数分布（ポアソン過程）。到来は外から決まり、
    過去の天気とは関係しない。
    """
    mean_gap = 24 * interval_days
    passages = []
    time = rng.exponential(mean_gap)
    while time < n_hours:
        passages.append(int(time))
        time += rng.exponential(mean_gap)
    return np.array(passages, dtype=int)


def add_precursor(parts, passage, lead_hours, strength):
    """通過前の予兆：南西寄りの風が強まり、気圧が下がり、雲が増える。"""
    if lead_hours <= 0:
        return
    start = max(passage - lead_hours, 0)
    ramp = (np.arange(start, passage) - (passage - lead_hours) + 1) / lead_hours  # 0 から 1 へ
    parts["u"][start:passage] += 1.2 * strength * ramp
    parts["v"][start:passage] += 2.5 * strength * ramp
    parts["temperature"][start:passage] += 1.0 * strength * ramp
    parts["pressure"][start:passage] -= 6.0 * strength * ramp
    parts["cloud"][start:passage] += 0.5 * ramp


def add_after_passage(parts, passage, strength, n_after=240):
    """通過時と通過後：北西の風に急に変わり、気温が下がる。気圧は上がる。徐々に元に戻る。"""
    end = min(passage + n_after, len(parts["u"]))
    elapsed = np.arange(end - passage, dtype=float)  # 通過からの時間
    wind = 3.5 * strength * np.exp(-elapsed / 18.0)
    parts["u"][passage:end] += wind   # 北西から吹く風：東向き（u > 0）
    parts["v"][passage:end] -= wind   # 南向き（v < 0）
    cooling = (1 - np.exp(-(elapsed + 1) / 2.0)) * np.exp(-elapsed / 48.0)
    parts["temperature"][passage:end] -= 5.0 * strength * cooling
    rise = (1 - np.exp(-elapsed / 4.0)) * np.exp(-elapsed / 48.0)
    parts["pressure"][passage:end] += strength * (-6.0 * np.exp(-elapsed / 4.0) + 4.0 * rise)
    parts["cloud"][passage:end] += 0.5 * np.exp(-elapsed / 6.0)


def front_components(n_hours, settings, rng):
    """前線の通過による変化（u, v, 気温, 気圧, 雲）と、通過時刻の一覧を返す。"""
    passages = front_passage_hours(n_hours, settings["front_interval_days"], rng)
    strengths = settings["front_strength"] * rng.uniform(0.6, 1.4, size=len(passages))
    parts = {name: np.zeros(n_hours) for name in ["u", "v", "temperature", "pressure", "cloud"]}
    for passage, strength in zip(passages, strengths):
        add_precursor(parts, passage, int(settings["front_precursor_hours"]), strength)
        add_after_passage(parts, passage, strength)
    return parts, passages


def hours_since_last(passages, n_hours):
    """各時刻について、直前の前線通過から何時間たったか（まだ通過がなければ NaN）。"""
    elapsed = np.full(n_hours, np.nan)
    for passage in passages:
        elapsed[passage:] = np.arange(n_hours - passage)
    return elapsed


# ---------------------------------------------------------------------------
# 真の状態と観測
# ---------------------------------------------------------------------------

def simulate_truth(settings):
    """観測誤差を含まない「真の状態」と、その内訳（成分）を表にして返す。

    成分ごとに別の乱数の種を使うので、ある成分を止めても、ほかの成分は同じ値のまま。
    """
    times = make_hourly_times(settings["start"], settings["years"])
    n_hours = len(times)
    seed = settings["seed"]
    zeros = {name: np.zeros(n_hours) for name in ["u", "v", "temperature", "pressure", "cloud"]}

    periodic = periodic_components(times, settings)
    background = zeros
    if settings["use_background"]:
        background = background_components(n_hours, settings, np.random.default_rng([seed, 1]))
    ar = zeros
    if settings["use_ar"]:
        ar = ar_components(n_hours, settings, np.random.default_rng([seed, 2]))
    fronts, passages = zeros, np.array([], dtype=int)
    if settings["use_fronts"]:
        fronts, passages = front_components(n_hours, settings, np.random.default_rng([seed, 3]))

    truth = pd.DataFrame(index=times)
    for name, part in [("periodic", periodic), ("background", background), ("ar", ar), ("front", fronts)]:
        truth[f"u_{name}"] = part["u"]
        truth[f"v_{name}"] = part["v"]
    truth["u_true"] = periodic["u"] + background["u"] + ar["u"] + fronts["u"]
    truth["v_true"] = periodic["v"] + background["v"] + ar["v"] + fronts["v"]
    truth["speed_true"] = np.hypot(truth["u_true"], truth["v_true"])
    truth["direction_true_deg"] = uv_to_direction(truth["u_true"], truth["v_true"])
    truth["temperature_true"] = periodic["temperature"] + background["temperature"] + ar["temperature"] + fronts["temperature"]
    truth["pressure_true"] = periodic["pressure"] + background["pressure"] + ar["pressure"] + fronts["pressure"]
    cloud = np.clip(periodic["cloud"] + background["cloud"] + ar["cloud"] + fronts["cloud"], 0.0, 1.0)
    truth["daylight_fraction"] = daylight_fraction(times, settings["latitude_deg"])
    truth["sunshine_true_h"] = truth["daylight_fraction"] * (1 - cloud)
    truth["hours_since_front"] = hours_since_last(passages, n_hours)
    return truth


def missing_mask(n_hours, rate, rng):
    """欠測にする時刻（True）。rate の割合で欠測が始まり、1〜6時間続く。"""
    mask = np.zeros(n_hours, dtype=bool)
    starts = np.flatnonzero(rng.random(n_hours) < rate)
    lengths = rng.integers(1, 7, size=len(starts))
    for start, length in zip(starts, lengths):
        mask[start:start + length] = True
    return mask


def observe(truth, settings):
    """真の状態から、観測値（気象庁のCSVと同じ精度と表記）の表を作る。

    - u, v に観測誤差を加え、風速は 0.1 m/s 単位、風向は16方位に丸める
    - 風速 0.2 m/s 以下は「静穏」（風向なし）
    - 気温・気圧は 0.1 単位、日照時間は 0.1 時間単位。太陽が出ていない1時間は「現象なし」
    - まれに数時間の欠測（品質情報 1、値と現象なし情報は空欄）を入れる
    列名は read_jma_csv で読み込んだ表と同じにする。
    """
    rng = np.random.default_rng([settings["seed"], 4])
    n_hours = len(truth)
    noise = settings["observation_noise_ms"]
    u = truth["u_true"].to_numpy() + rng.normal(0.0, noise, n_hours)
    v = truth["v_true"].to_numpy() + rng.normal(0.0, noise, n_hours)
    speed = np.round(np.hypot(u, v), 1)
    labels = degrees_to_direction_label(np.nan_to_num(uv_to_direction(u, v)))
    labels = np.where(speed <= CALM_SPEED_MS, CALM_LABEL, labels).astype(object)
    night = truth["daylight_fraction"].to_numpy() == 0

    observed = pd.DataFrame(index=truth.index)
    observed["temperature_c"] = np.round(truth["temperature_true"].to_numpy() + rng.normal(0.0, 0.1, n_hours), 1)
    observed["sunshine_h"] = np.where(night, 0.0, np.round(truth["sunshine_true_h"].to_numpy(), 1))
    observed["wind_speed_ms"] = speed
    observed["wind_direction"] = labels
    observed["sea_level_pressure_hpa"] = np.round(truth["pressure_true"].to_numpy(), 1)

    missing = missing_mask(n_hours, settings["missing_rate"], rng)
    for value_column in ["temperature_c", "sunshine_h", "wind_speed_ms", "wind_direction", "sea_level_pressure_hpa"]:
        observed.loc[missing, value_column] = np.nan
        observed[value_column + "_quality"] = np.where(missing, 1, 8)
    # 現象なし情報は、欠測の行では空欄になる（気象庁のヘルプと実際のファイルに合わせる）
    observed["sunshine_h_no_phenomenon"] = np.where(missing, np.nan, night.astype(float))
    for element_column in ["temperature_c", "sunshine_h", "wind_speed_ms", "sea_level_pressure_hpa"]:
        observed[element_column + "_homogeneity"] = 1
    return observed[[column for _, _, _, column in JMA_LAYOUT]]


# ---------------------------------------------------------------------------
# 気象庁形式のCSVとして保存
# ---------------------------------------------------------------------------

def format_time_jma(time):
    """気象庁のCSVと同じ書き方の日時。真夜中（24時）は翌日の「00:00:00」と書く。"""
    clock = "00:00:00" if time.hour == 0 else f"{time.hour}:00:00"
    return f"{time.year}/{time.month}/{time.day} {clock}"


def format_cell(value, column, no_phenomenon):
    """1つの値を、気象庁のCSVと同じ書き方の文字列にする（欠損は空欄）。"""
    if pd.isna(value):
        return ""
    if column == "wind_direction":
        return str(value)
    if column.endswith(("_quality", "_homogeneity", "_no_phenomenon")):
        return str(int(value))
    if column == "sunshine_h" and no_phenomenon:
        return "0"  # 現象なしのときは「0」と書かれる（日照がある時間帯の 0 は「0.0」）
    return f"{value:.1f}"


def jma_header_rows(settings):
    """CSVの先頭の見出し行（気象庁のダウンロードファイルと同じ構造）。"""
    note = (f"合成データ（気象庁の観測値ではありません）：coastal_wind_chaos で生成、"
            f"プリセット {settings['preset']}、seed={settings['seed']}")
    return [
        [note],
        [],
        [""] + [settings["station_name"]] * len(JMA_LAYOUT),
        ["年月日時"] + [element for element, _, _, _ in JMA_LAYOUT],
        [""] + [sub_element for _, sub_element, _, _ in JMA_LAYOUT],
        [""] + [info for _, _, info, _ in JMA_LAYOUT],
    ]


def write_jma_csv(observed, path, settings, encoding="cp932"):
    """観測値の表を、気象庁のダウンロードファイルと同じ形式のCSVに保存する。

    文字コードは既定で Shift_JIS（cp932）、改行は CRLF（気象庁のファイルと同じ）。
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerows(jma_header_rows(settings))
    no_phenomenon = observed["sunshine_h_no_phenomenon"].to_numpy() == 1
    columns = [column for _, _, _, column in JMA_LAYOUT]
    values = observed[columns].to_numpy(dtype=object)
    for row_number, time in enumerate(observed.index):
        cells = [format_cell(value, column, no_phenomenon[row_number])
                 for value, column in zip(values[row_number], columns)]
        writer.writerow([format_time_jma(time)] + cells)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(buffer.getvalue().encode(encoding))
    return path


def generate_sample_csv(path="data/sample_coastal_amedas.csv", preset="default",
                        truth_path=None, encoding="cp932", **changes):
    """合成データを作り、気象庁形式のCSVに保存する。設定（辞書）を返す。

    truth_path を指定すると、観測誤差を含まない真の状態と成分の内訳も UTF-8 のCSVで保存する
    （観測誤差や外れる原因を調べる教材用。予測の入力には使わない）。
    """
    settings = make_settings(preset, **changes)
    truth = simulate_truth(settings)
    write_jma_csv(observe(truth, settings), path, settings, encoding)
    if truth_path is not None:
        truth_path = Path(truth_path)
        truth_path.parent.mkdir(parents=True, exist_ok=True)
        truth.to_csv(truth_path, encoding="utf-8", float_format="%.4f")
    return settings


def generate_weather(preset="default", **changes):
    """CSVを経由せずに、prepare_weather 済みの表を直接作る（シナリオ比較用）。"""
    settings = make_settings(preset, **changes)
    return prepare_weather(observe(simulate_truth(settings), settings))


def read_truth_csv(path):
    """generate_sample_csv で保存した真の状態のCSVを読む。"""
    return pd.read_csv(path, index_col="time", parse_dates=["time"], encoding="utf-8")


# ---------------------------------------------------------------------------
# 真の状態を使った分析（合成データだからできること。実データには真の状態はない）
# ---------------------------------------------------------------------------

def observation_error_summary(weather, truth):
    """観測した風向（16方位）と、観測誤差のない真の風向の差の平均（度）。"""
    true_direction = truth["direction_true_deg"].reindex(weather.index).to_numpy()
    errors = angular_error(true_direction, weather["wind_direction_deg"].to_numpy())
    return float(np.nanmean(errors))


def errors_against_truth(forecasts, models, truth):
    """各手法の誤差を、観測値に対してと、観測誤差のない真の風向に対しての両方で計算する。"""
    true_direction = truth["direction_true_deg"].reindex(forecasts["target_time"]).to_numpy()
    rows = []
    for spec in models:
        rows.append({
            "model": spec,
            "mae_vs_observation_deg": float(np.mean(angular_error(forecasts["target_direction_deg"], forecasts[spec]))),
            "mae_vs_truth_deg": float(np.nanmean(angular_error(true_direction, forecasts[spec]))),
        })
    return pd.DataFrame(rows)


def hours_from_nearest_front(truth, times):
    """各時刻から、最も近い前線通過までの時間（通過前は負、通過後は正）。前線がなければ NaN。"""
    passages = truth.index[truth["hours_since_front"] == 0]
    times = pd.DatetimeIndex(times)
    if len(passages) == 0:
        return np.full(len(times), np.nan)
    differences = (times.to_numpy()[:, None] - passages.to_numpy()[None, :]) / np.timedelta64(1, "h")
    nearest = np.argmin(np.abs(differences), axis=1)
    return differences[np.arange(len(times)), nearest]


def error_around_fronts(forecasts, models, truth, edges=(-24, -12, -6, -3, 0, 3, 6, 12, 24)):
    """対象時刻が前線通過の前後どのあたりかで分けて、平均絶対角度誤差を表にする。

    行の [0, 3) は「通過した時刻から3時間未満」、[-3, 0) は「通過の3時間前から直前まで」。
    """
    relative = hours_from_nearest_front(truth, forecasts["target_time"])
    groups = pd.cut(relative, list(edges), right=False)
    errors = pd.DataFrame(
        {spec: angular_error(forecasts["target_direction_deg"], forecasts[spec]) for spec in models},
        index=forecasts.index,
    )
    table = errors.groupby(groups, observed=True).mean()
    table["n"] = errors.groupby(groups, observed=True).size()
    table.index.name = "hours_from_front"
    return table
