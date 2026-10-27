"""風向きの予測実験：読込、変換、特徴量、時間分割、予測、評価。

気象庁「過去の気象データ・ダウンロード」の時別値CSVと、sample_data.py で作る
同じ形式の合成CSVを、同じ関数で読み込みます。

時刻は日本標準時（JST）で、タイムゾーン情報を持たない日時として扱います。
各行の時刻は、その時刻に終わる1時間の終わりを表します。例えば「2024/1/1 1:00:00」の
日照時間は0時から1時までの合計、気温と気圧は1時の値、風向・風速は1時までの
10分間の平均です。1日の最後の行は翌日の「0:00:00」（＝24時）です。
"""

import csv
import io
import re
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import LinearRegression, Ridge
from sklearn.multioutput import MultiOutputRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

# 北から時計回りの16方位。番号 × 22.5 が角度（度）になる。
DIRECTION_LABELS = [
    "北", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東",
    "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西",
]
CALM_LABEL = "静穏"
CALM_SPEED_MS = 0.2  # 風速がこの値以下なら「静穏」（風向なし）とする

# 正解と無関係に、0〜360度から一様ランダムに選んだ方向を予測とした場合の誤差の期待値。
# 「あらゆる予測の限界」ではない。偏りのある風向なら、気候値予報などはこれより小さくなる。
RANDOM_DIRECTION_EXPECTED_ERROR_DEG = 90.0

# 気象庁CSVの要素名 → このプログラムで使う列名
ELEMENT_COLUMNS = {
    "気温(℃)": "temperature_c",
    "風速(m/s)": "wind_speed_ms",
    "風向": "wind_direction",
    "日照時間(時間)": "sunshine_h",
    "現地気圧(hPa)": "station_pressure_hpa",
    "海面気圧(hPa)": "sea_level_pressure_hpa",
    "降水量(mm)": "precipitation_mm",
    "相対湿度(％)": "relative_humidity_pct",
}
# 値の横に並ぶ補助情報の列 → 列名の末尾
INFO_SUFFIXES = {
    "品質情報": "_quality",
    "均質番号": "_homogeneity",
    "現象なし情報": "_no_phenomenon",
}

LAG_HOURS = (0, 1, 2, 3, 6, 12, 24)
CALENDAR_COLUMNS = [
    "hour_sin", "hour_cos", "hour2_sin", "hour2_cos", "season_sin", "season_cos",
]
OPTIONAL_RECENT_COLUMNS = [
    "temperature_now", "temperature_change_3h", "pressure_now", "pressure_change_3h",
    "sunshine_now",
]
DEFAULT_MODELS = [
    "persistence",
    "climatology",
    "linear:calendar",
    "linear:recent",
    "linear:calendar+recent",
    "boosting:calendar+recent",
    "degrees_as_numbers",
]
METHOD_NAMES = {
    "persistence": ("持続予報", "Persistence"),
    "climatology": ("気候値予報（月×時刻の平均）", "Climatology (month x hour)"),
    "linear": ("線形回帰", "Linear"),
    "boosting": ("勾配ブースティング", "Boosting"),
    "degrees_as_numbers": ("悪い例：角度を数値のまま回帰", "Bad example: degrees as numbers"),
}
FEATURE_NAMES = {
    "calendar": ("季節・時刻", "calendar"),
    "recent": ("直近の観測", "recent obs."),
    "calendar+recent": ("季節・時刻＋直近の観測", "calendar + recent obs."),
}


# ---------------------------------------------------------------------------
# 風向の変換
# ---------------------------------------------------------------------------

def direction_label_to_degrees(label):
    """16方位の文字（例：「南南西」）を度（北=0, 東=90, 南=180, 西=270）に変える。

    静穏・空欄・不明な文字は NaN（風向なし）を返す。
    """
    if isinstance(label, str) and label.strip() in DIRECTION_LABELS:
        return DIRECTION_LABELS.index(label.strip()) * 22.5
    return np.nan


def degrees_to_direction_label(degrees):
    """度を最も近い16方位の文字に変える（配列も可）。"""
    index = np.round(np.asarray(degrees, dtype=float) / 22.5).astype(int) % 16
    return np.array(DIRECTION_LABELS)[index]


def normalise_degrees(degrees):
    """角度を0以上360未満にそろえる（例：-10 → 350、360 → 0）。

    np.mod は、0よりわずかに小さい値に 360.0 を返すことがあるので、それを 0 に直す。
    """
    degrees = np.mod(np.asarray(degrees, dtype=float), 360.0)
    return np.where(degrees >= 360.0, 0.0, degrees)


def wind_to_uv(speed, direction_deg):
    """風速と風向（風が吹いてくる方位）を、東向きの u と北向きの v に分ける。

    北風（北から吹く、0度）は南へ向かうので v < 0、西風（270度）は東へ向かうので u > 0。
    """
    radians = np.deg2rad(np.asarray(direction_deg, dtype=float))
    speed = np.asarray(speed, dtype=float)
    u = -speed * np.sin(radians)
    v = -speed * np.cos(radians)
    return u, v


def uv_to_direction(u, v):
    """u, v から、風が吹いてくる方位（0以上360未満の度）を求める。

    u = v = 0 のときは向きが決まらないので NaN を返す。
    """
    u = np.asarray(u, dtype=float)
    v = np.asarray(v, dtype=float)
    direction = normalise_degrees(np.rad2deg(np.arctan2(-u, -v)))
    return np.where((u == 0) & (v == 0), np.nan, direction)


def angular_difference(true_deg, predicted_deg):
    """予測 − 正解 の角度差を -180 以上 180 未満の度で返す。

    例：正解350度、予測10度なら +20度（340度ではない）。
    """
    true_deg = np.asarray(true_deg, dtype=float)
    predicted_deg = np.asarray(predicted_deg, dtype=float)
    return normalise_degrees(predicted_deg - true_deg + 180.0) - 180.0


def angular_error(true_deg, predicted_deg):
    """角度の誤差の大きさ（0〜180度）。"""
    return np.abs(angular_difference(true_deg, predicted_deg))


def circular_mean_deg(directions_deg):
    """風向の平均。単位ベクトル（cos, sin）を平均してから角度に戻す。"""
    radians = np.deg2rad(np.asarray(directions_deg, dtype=float))
    mean_sin = np.nanmean(np.sin(radians))
    mean_cos = np.nanmean(np.cos(radians))
    degrees = np.round(np.rad2deg(np.arctan2(mean_sin, mean_cos)), 9)  # 359.9999… を 0 にそろえる
    return float(normalise_degrees(degrees)) + 0.0  # + 0.0 で「-0.0」を「0.0」にする


def random_direction_errors(true_deg, seed=0):
    """正解と無関係に一様ランダムな方向を選んだときの誤差（平均すると約90度）。"""
    rng = np.random.default_rng(seed)
    guesses = rng.uniform(0.0, 360.0, size=len(true_deg))
    return angular_error(true_deg, guesses)


# ---------------------------------------------------------------------------
# 気象庁形式CSVの読込
# ---------------------------------------------------------------------------

def read_text(path, encoding=None):
    """CSVファイルを文字列として読む。

    encoding を省略すると、UTF-8 を試し、だめなら Shift_JIS（cp932）で読む。
    気象庁のダウンロードファイルは Shift_JIS である。
    """
    raw = Path(path).read_bytes()
    if encoding is not None:
        return raw.decode(encoding)
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp932")


LITERAL_TIME_PATTERN = r"(\d{4})/(\d{1,2})/(\d{1,2}) (\d{1,2}):(\d{2})(?::\d{2})?"


def find_header_row(rows):
    """日時の見出し（「年月日時」または「年,月,日,時」）がある行の番号と、日時の列数を返す。"""
    for number, row in enumerate(rows):
        first_cells = [cell.strip() for cell in row[:4]]
        if first_cells[:1] == ["年月日時"]:
            return number, 1
        if first_cells == ["年", "月", "日", "時"]:
            return number, 4
    raise ValueError(
        "「年月日時」の見出し行が見つかりません。気象庁の「過去の気象データ・ダウンロード」で、"
        "時別値を「すべて数値で格納」でダウンロードしたCSV"
        "（日付は「日付リテラルで格納」または「年月日などに分けて格納」）か確認してください。"
    )


def is_data_row(row, n_time_columns):
    """日時で始まるデータの行なら True。"""
    if n_time_columns == 1:
        return bool(row) and re.fullmatch(LITERAL_TIME_PATTERN, row[0].strip()) is not None
    return len(row) >= 4 and all(cell.strip().isdigit() for cell in row[:4])


def check_single_station(station_row):
    """複数地点が1つのファイルに入っていないか確かめる。"""
    names = {name.strip() for name in station_row if name.strip()}
    if len(names) > 1:
        raise ValueError(f"複数の地点が含まれています: {sorted(names)}。1地点ずつダウンロードしてください。")


def make_column_names(header, sub_rows, n_time_columns):
    """見出し行と、その下の補助見出し行から、値の列の名前の一覧を作る。

    例：「風速(m/s)」の下に「風向」とあれば wind_direction、
    さらにその下に「品質情報」とあれば wind_direction_quality になる。
    """
    names = []
    for column in range(n_time_columns, len(header)):
        element = header[column].strip()
        info = ""
        for sub_row in sub_rows:
            text = sub_row[column].strip() if column < len(sub_row) else ""
            if text in INFO_SUFFIXES:
                info = text
            elif text:
                element = text
        names.append(ELEMENT_COLUMNS.get(element, element) + INFO_SUFFIXES.get(info, ""))
    return names


def make_times(year, month, day, hour, minute=0):
    """年・月・日・時（・分）から日時を作る。時が24なら翌日の0時になる。"""
    dates = pd.to_datetime(pd.DataFrame({"year": year, "month": month, "day": day}))
    offsets = pd.to_timedelta(hour, unit="h") + pd.to_timedelta(minute, unit="min")
    return pd.DatetimeIndex(dates + offsets, name="time")


def parse_time_cells(time_cells, n_time_columns):
    """データ行の先頭の日時の文字列を日時に変える。

    気象庁のCSVでは、日付を1列にすると真夜中は翌日の「00:00:00」、
    年・月・日・時を別の列にすると同じ日の「24」時と書かれる。どちらも同じ日時になる。
    """
    cells = pd.DataFrame(time_cells)
    if n_time_columns == 1:
        parts = cells[0].str.strip().str.extract(LITERAL_TIME_PATTERN).astype(int)
        return make_times(parts[0], parts[1], parts[2], parts[3], parts[4])
    numbers = cells.apply(lambda column: column.str.strip().astype(int))
    return make_times(numbers[0], numbers[1], numbers[2], numbers[3])


def read_jma_csv(path, encoding=None):
    """気象庁形式の時別値CSVを読み、時刻を行の名前（index）にした表を返す。

    path にファイルの一覧を渡すと、つなげて1つの表にする（重複した時刻は最初のものを使う）。
    風向は文字のまま（wind_direction 列）、そのほかの値と品質情報は数値に変える。
    空欄は欠損（NaN）になる。
    """
    if isinstance(path, (list, tuple)):
        tables = [read_jma_csv(one_path, encoding) for one_path in path]
        combined = pd.concat(tables).sort_index()
        return combined[~combined.index.duplicated(keep="first")]

    rows = list(csv.reader(io.StringIO(read_text(path, encoding))))
    header_number, n_time_columns = find_header_row(rows)
    if header_number > 0:
        check_single_station(rows[header_number - 1])
    first_data = header_number + 1
    while first_data < len(rows) and not is_data_row(rows[first_data], n_time_columns):
        first_data += 1
    names = make_column_names(rows[header_number], rows[header_number + 1:first_data], n_time_columns)

    time_cells = []
    value_cells = []
    for row in rows[first_data:]:
        if is_data_row(row, n_time_columns):
            values = row[n_time_columns:n_time_columns + len(names)]
            time_cells.append(row[:n_time_columns])
            value_cells.append(values + [""] * (len(names) - len(values)))
    if not value_cells:
        raise ValueError("データの行がありません。期間や項目を選び直してダウンロードしてください。")

    table = pd.DataFrame(value_cells, columns=names, dtype=object)
    table.index = parse_time_cells(time_cells, n_time_columns)
    for column in table.columns:
        if column == "wind_direction":
            labels = table[column].str.strip()
            table[column] = labels.where(labels != "", np.nan)
        else:
            table[column] = pd.to_numeric(table[column].str.strip(), errors="coerce")
    return table.sort_index()


# ---------------------------------------------------------------------------
# 予測に使える形へ整える
# ---------------------------------------------------------------------------

def fill_no_phenomenon(raw, min_quality=5):
    """日照時間・降水量で「現象がない」ため空欄の値を 0 にする。

    気象庁のCSVでは、現象なし情報が 1 の行（例：夜の日照時間）は値が 0 と書かれる。
    現象なし情報の列がない地点（アメダス）では、夜の日照時間が空欄で、品質情報は正常（8）だった
    （2026年10月にダウンロードしたファイルで確認。気象庁のヘルプには書かれていない）。
    どちらも「その1時間に日照（降水）がなかった」として 0 時間（0 mm）にそろえる。
    品質情報が低い空欄（欠測など）は 0 にしない。0 にした行は「列名_blank_as_zero」に記録する。
    """
    table = raw.copy()
    for column in ["sunshine_h", "precipitation_mm"]:
        if column not in raw.columns:
            continue
        blank = raw[column].isna()
        no_phenomenon = raw.get(column + "_no_phenomenon", pd.Series(np.nan, index=raw.index)) == 1
        good_quality = raw.get(column + "_quality", pd.Series(np.nan, index=raw.index)) >= min_quality
        filled = (blank & (no_phenomenon | good_quality)).to_numpy()
        table.loc[filled, column] = 0.0
        table[column + "_blank_as_zero"] = filled
    return table


def apply_quality(raw, min_quality=5):
    """品質情報が min_quality 未満（または不明）の値を欠損にする。

    気象庁の品質情報は 8 が正常値、5 が準正常値、4 が資料不足値、2 が疑問値、
    1 が欠測、0 が観測していないことを表す。既定では 8 と 5 を使う。
    品質情報の列がない要素は、そのまま使う。
    """
    table = raw.copy()
    for column in raw.columns:
        quality_column = column + "_quality"
        if quality_column in raw.columns:
            quality = raw[quality_column]
            bad = (quality.isna() | (quality < min_quality)).to_numpy()
            table.loc[bad, column] = np.nan
    return table


def add_direction_degrees(table):
    """16方位の風向を度に変え、静穏かどうかの列も加える。"""
    table = table.copy()
    labels = table["wind_direction"].astype(object)
    table["wind_is_calm"] = labels.eq(CALM_LABEL).to_numpy()
    table["wind_direction_deg"] = labels.map(direction_label_to_degrees).astype(float)
    return table


def add_wind_components(table):
    """風速と風向から u（東向き）, v（北向き）を計算して列を加える。

    静穏は「風がほとんどない」ので u = v = 0 とする。風向が欠測なら u, v も欠損。
    """
    table = table.copy()
    u, v = wind_to_uv(table["wind_speed_ms"], table["wind_direction_deg"])
    calm = table["wind_is_calm"].to_numpy(dtype=bool)
    u[calm] = 0.0
    v[calm] = 0.0
    table["u_ms"] = u
    table["v_ms"] = v
    return table


def to_hourly_index(table):
    """1時間刻みで欠けのない時刻の列に並べ直す（なかった時刻の値は欠損）。

    これで shift(k) が「k 行前」ではなく「k 時間前」を正しく表すようになる。
    """
    if (table.index.minute != 0).any() or (table.index.second != 0).any():
        raise ValueError("毎正時でない時刻があります。1時間ごとの値（時別値）を使ってください。")
    table = table.sort_index()
    table = table[~table.index.duplicated(keep="first")]
    full_index = pd.date_range(table.index.min(), table.index.max(),
                               freq=pd.Timedelta(hours=1), name="time")
    hourly = table.reindex(full_index)
    for column in hourly.columns:
        if column == "wind_is_calm" or column.endswith("_blank_as_zero"):
            hourly[column] = hourly[column].eq(True).to_numpy()  # 追加した時刻は False
    return hourly


def prepare_weather(raw, min_quality=5):
    """読み込んだ表を、予測に使う1時間ごとの表に整える。

    1. 現象がないため空欄の日照時間・降水量を 0 にする
    2. 品質情報が低い値を欠損にする
    3. 16方位の風向を度に変え、静穏かどうかを記録する
    4. 風速・風向から u, v 成分を作る
    5. 1時間刻みの完全な時刻列に並べ直す
    """
    if "wind_speed_ms" not in raw.columns or "wind_direction" not in raw.columns:
        raise ValueError("風速と風向の列がありません。ダウンロードの項目で「風向・風速」を選んでください。")
    table = fill_no_phenomenon(raw, min_quality)
    table = apply_quality(table, min_quality)
    table = add_direction_degrees(table)
    table = add_wind_components(table)
    return to_hourly_index(table)


def load_weather(path, encoding=None, min_quality=5):
    """CSVの読込（read_jma_csv）と整形（prepare_weather）をまとめて行う。"""
    return prepare_weather(read_jma_csv(path, encoding), min_quality)


def direction_frequency_by_hour(weather):
    """時刻（0〜23時）ごとに、16方位それぞれの風向が現れた割合（%）を表にする。

    行は方位の番号（0 = 北, 4 = 東, 8 = 南, 12 = 西）、列は時刻。静穏と欠測は除く。
    """
    valid = weather["wind_direction_deg"].notna().to_numpy()
    sectors = np.round(weather["wind_direction_deg"].to_numpy()[valid] / 22.5).astype(int) % 16
    hours = weather.index.hour.to_numpy()[valid]
    table = pd.crosstab(pd.Series(sectors, name="sector"), pd.Series(hours, name="hour"),
                        normalize="columns") * 100
    return table.reindex(index=range(16), columns=range(24), fill_value=0.0)


def homogeneity_changes(weather):
    """均質番号が途中で変わった時刻を要素ごとに返す（観測環境が変わった目安）。

    均質番号はダウンロードしたファイルごとに1から付くため、複数のファイルをつないだときは、
    ファイルの境目でも番号が変わることがある。
    """
    changes = {}
    for column in weather.columns:
        if column.endswith("_homogeneity"):
            numbers = weather[column].dropna()
            changed = numbers.index[1:][numbers.to_numpy()[1:] != numbers.to_numpy()[:-1]]
            if len(changed) > 0:
                changes[column.removesuffix("_homogeneity")] = [str(time) for time in changed]
    return changes


def summarise_weather(weather):
    """期間、時刻の数、欠損や静穏の数などを表にする（実データを使う前の確認用）。"""
    rows = [
        ("最初の時刻", str(weather.index.min())),
        ("最後の時刻", str(weather.index.max())),
        ("時刻の数（1時間ごと）", len(weather)),
        ("風向・風速が使える時刻", int(weather["u_ms"].notna().sum())),
        ("静穏の時刻", int(weather["wind_is_calm"].sum())),
    ]
    for column in ["temperature_c", "sea_level_pressure_hpa", "station_pressure_hpa", "sunshine_h"]:
        if column in weather.columns:
            missing = int(weather[column].isna().sum())
            note = "（すべて欠損：この地点では観測していない可能性）" if missing == len(weather) else ""
            rows.append((f"{column} が欠損の時刻", f"{missing}{note}"))
    if "sunshine_h_blank_as_zero" in weather.columns:
        filled = weather["sunshine_h_blank_as_zero"].to_numpy(dtype=bool)
        daytime = np.isin(weather.index.hour, [10, 11, 12, 13, 14])
        note = "（日中の空欄は欠測の可能性。元のCSVを確かめる）" if (filled & daytime).any() else ""
        rows.append(("空欄を0時間とした日照時間（全体／10〜14時）",
                     f"{int(filled.sum())}／{int((filled & daytime).sum())}{note}"))
    labels = weather["wind_direction"].dropna().astype(str)
    unknown = labels[~labels.isin(DIRECTION_LABELS + [CALM_LABEL])]
    rows.append(("16方位・静穏以外の風向の記号", sorted(unknown.unique().tolist())))
    has_quality = any(column.endswith("_quality") for column in weather.columns)
    rows.append(("品質情報の列", "あり" if has_quality else
                 "なし（欠測・疑問値を区別できない。「利用上注意が必要なデータの扱い」で"
                 "情報をつける設定にしてダウンロードし直すとよい）"))
    rows.append(("均質番号が変わった時刻（観測環境の変化。ファイルの境目も含む）", homogeneity_changes(weather)))
    return pd.DataFrame(rows, columns=["項目", "値"])


# ---------------------------------------------------------------------------
# 特徴量と予測用の表
# ---------------------------------------------------------------------------

def year_fraction(times):
    """1年の中の位置（1月1日0時 = 0、12月31日24時 = 1）。うるう年は366日で割る。"""
    times = pd.DatetimeIndex(times)
    days_in_year = np.where(times.is_leap_year, 366.0, 365.0)
    elapsed_days = np.asarray(times.day_of_year - 1, dtype=float) + np.asarray(times.hour) / 24
    return elapsed_days / days_in_year


def calendar_features(times):
    """時刻と季節を、周期の端がつながるように sin と cos で表す。

    23時と0時、12月31日と1月1日が近い値になる。半日周期（hour2）も加える。
    """
    times = pd.DatetimeIndex(times)
    hour_angle = 2 * np.pi * np.asarray(times.hour) / 24
    season_angle = 2 * np.pi * year_fraction(times)
    return pd.DataFrame({
        "hour_sin": np.sin(hour_angle),
        "hour_cos": np.cos(hour_angle),
        "hour2_sin": np.sin(2 * hour_angle),
        "hour2_cos": np.cos(2 * hour_angle),
        "season_sin": np.sin(season_angle),
        "season_cos": np.cos(season_angle),
    }, index=times)


def check_hourly(weather):
    """1時間刻みで欠けのない時刻列か確かめる（to_hourly_index を通したか）。"""
    steps = np.diff(weather.index.to_numpy())
    if len(steps) > 0 and not (steps == np.timedelta64(1, "h")).all():
        raise ValueError("時刻が1時間刻みで並んでいません。先に to_hourly_index（prepare_weather）を使ってください。")


def pressure_column(weather):
    """使う気圧の列名（海面気圧を優先）。どちらもなければ None。"""
    for column in ["sea_level_pressure_hpa", "station_pressure_hpa"]:
        if column in weather.columns:
            return column
    return None


def make_forecast_table(weather, horizon, lags=LAG_HOURS):
    """予測時刻 t の情報から、horizon 時間後（t + horizon）の風を予測するための表を作る。

    1行が1つの予測時刻 t（行の名前 issue_time）。
    - 目的変数：t + horizon の u, v（target_u, target_v）
    - 季節・時刻：t + horizon の暦。暦は前もって分かるので使ってよい。
    - 直近の観測：t とそれより前の観測だけ。shift(k) は k 時間前の値。
    lags には必ず 0（予測時刻の値）を含める（持続予報に使うため）。
    """
    check_hourly(weather)
    lags = sorted(set(lags) | {0})
    table = pd.DataFrame(index=weather.index.rename("issue_time"))
    table["target_time"] = weather.index + pd.Timedelta(hours=horizon)
    table["target_hour"] = table["target_time"].dt.hour
    table["target_u"] = weather["u_ms"].shift(-horizon).to_numpy()
    table["target_v"] = weather["v_ms"].shift(-horizon).to_numpy()
    table["target_direction_deg"] = weather["wind_direction_deg"].shift(-horizon).to_numpy()
    table["issue_direction_deg"] = weather["wind_direction_deg"].to_numpy()

    calendar = calendar_features(table["target_time"])
    for column in CALENDAR_COLUMNS:
        table[column] = calendar[column].to_numpy()

    for lag in lags:
        table[f"u_lag{lag}"] = weather["u_ms"].shift(lag).to_numpy()
        table[f"v_lag{lag}"] = weather["v_ms"].shift(lag).to_numpy()
    if "temperature_c" in weather.columns:
        temperature = weather["temperature_c"]
        table["temperature_now"] = temperature.to_numpy()
        table["temperature_change_3h"] = (temperature - temperature.shift(3)).to_numpy()
    pressure_name = pressure_column(weather)
    if pressure_name is not None:
        pressure = weather[pressure_name]
        table["pressure_now"] = pressure.to_numpy()
        table["pressure_change_3h"] = (pressure - pressure.shift(3)).to_numpy()
    if "sunshine_h" in weather.columns:
        table["sunshine_now"] = weather["sunshine_h"].to_numpy()
    return table


def recent_columns(table, min_available=0.5):
    """直近の観測の特徴量のうち、使える列を返す。

    風の u, v は必ず使う。気温・気圧・日照は、半分以上の行に値がある場合だけ使う
    （その観測をしていない地点もあるため）。
    """
    columns = [name for name in table.columns if name.startswith(("u_lag", "v_lag"))]
    for name in OPTIONAL_RECENT_COLUMNS:
        if name in table.columns and table[name].notna().mean() >= min_available:
            columns.append(name)
    return columns


def feature_columns(feature_set, recent):
    """特徴量の組の名前（calendar, recent, calendar+recent）から列名の一覧を作る。

    recent には recent_columns で選んだ「直近の観測」の列名の一覧を渡す。
    """
    if feature_set == "calendar":
        return list(CALENDAR_COLUMNS)
    if feature_set == "recent":
        return list(recent)
    if feature_set == "calendar+recent":
        return list(CALENDAR_COLUMNS) + list(recent)
    raise ValueError(f"未知の特徴量の組です: {feature_set}（calendar, recent, calendar+recent のどれか）")


# ---------------------------------------------------------------------------
# 時間分割
# ---------------------------------------------------------------------------

def default_test_start(weather, test_days=365):
    """最後の test_days 日をテスト期間にするときの、テスト開始時刻。"""
    return weather.index.max() - pd.Timedelta(days=test_days) + pd.Timedelta(hours=1)


def split_train_test(table, test_start):
    """時間で学習用とテスト用に分ける（ランダムには分けない）。

    - テスト：予測時刻 t がテスト開始以降の行
    - 学習：予測の対象時刻 t + horizon がテスト開始より前の行
    学習の答え（目的変数）がテスト期間に入らないよう、境界の手前 horizon 時間分は使わない。
    """
    test_start = pd.Timestamp(test_start)
    train = table[table["target_time"] < test_start]
    test = table[table.index >= test_start]
    return train, test


# ---------------------------------------------------------------------------
# 予測の方法
# ---------------------------------------------------------------------------

def parse_model(spec):
    """「linear:calendar」のような文字列を、手法と特徴量の組に分ける。"""
    method, _, feature_set = spec.partition(":")
    return method, (feature_set or None)


def model_label(spec, language="ja"):
    """手法の表示名。language="en" で図用の英語名。"""
    method, feature_set = parse_model(spec)
    position = 0 if language == "ja" else 1
    label = METHOD_NAMES.get(method, (method, method))[position]
    if feature_set:
        label += f"（{FEATURE_NAMES[feature_set][0]}）" if language == "ja" else f" ({FEATURE_NAMES[feature_set][1]})"
    return label


def fit_climatology(weather, train_end):
    """学習期間（train_end より前）の、（月, 時刻）ごとの平均の風ベクトル。"""
    past = weather[weather.index < pd.Timestamp(train_end)]
    month = pd.Index(past.index.month, name="month")
    hour = pd.Index(past.index.hour, name="hour")
    return past.groupby([month, hour])[["u_ms", "v_ms"]].mean()


def predict_climatology(climatology, target_times):
    """対象時刻の（月, 時刻）の平均の風ベクトルを予測とする。

    学習期間にない月があれば、同じ時刻の全体平均で補う。
    """
    target_times = pd.DatetimeIndex(target_times)
    keys = pd.MultiIndex.from_arrays([target_times.month, target_times.hour], names=["month", "hour"])
    values = climatology.reindex(keys)
    u = values["u_ms"].to_numpy(copy=True)
    v = values["v_ms"].to_numpy(copy=True)
    missing = np.isnan(u) | np.isnan(v)
    if missing.any():
        hourly_mean = climatology.groupby(level="hour").mean().reindex(target_times.hour[missing])
        u[missing] = hourly_mean["u_ms"].to_numpy()
        v[missing] = hourly_mean["v_ms"].to_numpy()
    return u, v


def make_regressor(method, seed=0):
    """機械学習のモデルを作る。

    - linear：標準化してからリッジ回帰（係数が大きくなりすぎないよう少し抑えた線形回帰）
    - boosting：勾配ブースティング木（u 用と v 用に1つずつ）。浅い木（max_depth=3）と
      大きめの葉（min_samples_leaf=200）で、学習期間だけの偶然の変動を覚えにくくする。
      early_stopping=False で、学習データをランダムに分ける内部の検証を使わない。
    """
    if method == "linear":
        return make_pipeline(StandardScaler(), Ridge(alpha=1.0))
    if method == "boosting":
        booster = HistGradientBoostingRegressor(
            max_iter=200, learning_rate=0.05, max_depth=3, min_samples_leaf=200,
            early_stopping=False, random_state=seed,
        )
        return MultiOutputRegressor(booster)
    raise ValueError(f"未知の手法です: {method}")


def fit_predict_uv(method, train, test, columns, seed=0):
    """学習用の表でモデルを学習し、テスト用の表で u, v を予測する。"""
    model = make_regressor(method, seed)
    model.fit(train[columns].to_numpy(), train[["target_u", "target_v"]].to_numpy())
    predicted = model.predict(test[columns].to_numpy())
    return predicted[:, 0], predicted[:, 1]


def fit_predict_degrees_as_numbers(train, test):
    """悪い例：風向を普通の数値として線形回帰する。

    入力は予測時刻の風向（度）と対象時刻の時（0〜23）、出力は対象時刻の風向（度）。
    350度と10度が近いことを知らないため、北寄りの風で大きく外れやすい。
    """
    columns = ["issue_direction_deg", "target_hour"]
    usable = train.dropna(subset=columns + ["target_direction_deg"])
    model = LinearRegression()
    model.fit(usable[columns].to_numpy(), usable["target_direction_deg"].to_numpy())
    return normalise_degrees(model.predict(test[columns].to_numpy()))


def predict_direction(spec, train, test, climatology, recent, seed=0):
    """手法 spec で、テスト用の各行の風向（度）を予測する。

    recent は「直近の観測」として使う列名の一覧。
    """
    method, feature_set = parse_model(spec)
    if method == "persistence":
        u, v = test["u_lag0"].to_numpy(), test["v_lag0"].to_numpy()
    elif method == "climatology":
        u, v = predict_climatology(climatology, test["target_time"])
    elif method in ("linear", "boosting"):
        columns = feature_columns(feature_set, recent)
        u, v = fit_predict_uv(method, train, test, columns, seed)
    elif method == "degrees_as_numbers":
        return fit_predict_degrees_as_numbers(train, test)
    else:
        raise ValueError(f"未知の手法です: {spec}")
    return uv_to_direction(u, v)


# ---------------------------------------------------------------------------
# 実験と評価
# ---------------------------------------------------------------------------

def forecast_one_horizon(weather, horizon, models=DEFAULT_MODELS, test_start=None,
                         lags=LAG_HOURS, seed=0):
    """1つの予測時間について、テスト期間の各時刻での各手法の予測風向を並べた表を返す。

    すべての手法を同じ行（時刻）で比べる。評価に使うのは、使う特徴量がそろっていて、
    予測時刻と対象時刻の両方で風向が決まる（静穏・欠測でない）行。
    """
    if test_start is None:
        test_start = default_test_start(weather)
    table = make_forecast_table(weather, horizon, lags)
    recent = recent_columns(table[table.index < pd.Timestamp(test_start)])
    table = table.dropna(subset=list(CALENDAR_COLUMNS) + recent + ["target_u", "target_v"])
    train, test = split_train_test(table, test_start)
    test = test[test["target_direction_deg"].notna() & test["issue_direction_deg"].notna()]
    if len(train) < 24 * 30 or len(test) == 0:
        raise ValueError(
            f"学習用（{len(train)}行）またはテスト用（{len(test)}行）のデータが足りません。"
            "期間とテスト開始時刻を確認してください。"
        )

    climatology = fit_climatology(weather, test_start)
    forecasts = test[["target_time", "target_hour", "target_direction_deg"]].copy()
    for spec in models:
        forecasts[spec] = predict_direction(spec, train, test, climatology, recent, seed)
    return forecasts


def score_forecasts(forecasts, models):
    """各手法の平均絶対角度誤差（度）と、誤差45度以内の割合（%）をまとめる。"""
    rows = []
    for spec in models:
        errors = angular_error(forecasts["target_direction_deg"], forecasts[spec])
        rows.append({
            "model": spec,
            "label": model_label(spec),
            "mae_deg": float(np.mean(errors)),
            "within_45_pct": float(100 * np.mean(errors <= 45)),
            "n_test": int(len(errors)),
        })
    return pd.DataFrame(rows)


def run_horizon_experiment(weather, horizons, models=DEFAULT_MODELS, test_start=None,
                           lags=LAG_HOURS, seed=0):
    """予測時間を変えながら同じ評価を繰り返し、結果を1つの表にまとめる。"""
    tables = []
    for horizon in horizons:
        forecasts = forecast_one_horizon(weather, horizon, models, test_start, lags, seed)
        scores = score_forecasts(forecasts, models)
        scores.insert(0, "horizon_h", horizon)
        tables.append(scores)
    return pd.concat(tables, ignore_index=True)


def error_by_hour(forecasts, models):
    """対象時刻の時（0〜23時）ごとの平均絶対角度誤差。"""
    errors = pd.DataFrame(
        {spec: angular_error(forecasts["target_direction_deg"], forecasts[spec]) for spec in models},
        index=forecasts.index,
    )
    return errors.groupby(forecasts["target_hour"].to_numpy()).mean().rename_axis("target_hour")


def run_scenario_experiment(weather_by_scenario, horizons, models, test_days=365,
                            lags=LAG_HOURS, seed=0):
    """複数のデータ（シナリオ）に同じ実験を行い、結果を1つの表にまとめる。

    weather_by_scenario は {シナリオ名: prepare_weather 済みの表} の辞書。
    どのシナリオも、最後の test_days 日をテスト期間にする。
    """
    tables = []
    for name, weather in weather_by_scenario.items():
        test_start = default_test_start(weather, test_days)
        scores = run_horizon_experiment(weather, horizons, models, test_start, lags, seed)
        scores.insert(0, "scenario", name)
        tables.append(scores)
    return pd.concat(tables, ignore_index=True)
