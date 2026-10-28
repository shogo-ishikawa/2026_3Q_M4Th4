"""風向きの予測実験：読込、変換、特徴量、時間分割、予測、評価。

気象庁「過去の気象データ・ダウンロード」の時別値CSVと、sample_data.py で作る
同じ形式の合成CSVを、同じ関数で読み込みます。

時刻は日本標準時（JST）で、タイムゾーン情報を持たない日時として扱います。
各行の時刻は、その行の値が表す1時間の終わりの時刻です。例えば「2024/1/1 1:00:00」の
日照時間は0時から1時までの合計、気温と気圧は1時の値、風向・風速は1時までの
10分間の平均です。1日の最後の行は翌日の「00:00:00」（＝24時）です。

予測を出す時刻を「予測時刻」（コードでは issue_time）、予測の対象になる時刻を
「対象時刻」（target_time）と呼びます。
"""

import csv
import io
import math
import re
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import LinearRegression, Ridge
from sklearn.multioutput import MultiOutputRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from threadpoolctl import threadpool_limits

# 北から時計回りの16方位。番号 × 22.5 が角度（度）になる。
DIRECTION_LABELS = [
    "北", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東",
    "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西",
]
CALM_LABEL = "静穏"
CALM_SPEED_MS = 0.2  # 風速がこの値以下なら「静穏」（風向なし）とする

# 正解と無関係に、0〜360度から一様ランダムに選んだ方向を予測とした場合の誤差の期待値。
# 「あらゆる予測の限界」ではない。偏りのある風向なら、気候値予報などはこれより小さくなる
# ことが多い（必ずではない）。
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

# 品質情報の既定：正常値（8）だけを使う。準正常値（5）も使うときは min_quality=5 を明示して渡す。
DEFAULT_MIN_QUALITY = 8

LAG_HOURS = (0, 1, 2, 3, 6, 12, 24)     # u, v の「何時間前」（0 は予測起点の値）
TEMPERATURE_LAG_HOURS = (1, 2, 3, 6)   # 気温の「何時間前」
COMMON_MAX_HORIZON = 72                 # 予測時間を比べるとき、この時間先まで評価期間に収まる予測起点だけを使う

# 季節・日周期（calendar）：対象時刻の周期特徴量と、学習期間だけから計算した月×時刻の平均の風
CALENDAR_COLUMNS = [
    "hour_sin", "hour_cos", "hour2_sin", "hour2_cos", "season_sin", "season_cos",
]
CLIMATOLOGY_COLUMNS = ["clim_u", "clim_v"]
# 過去・直近の観測（recent）：u_lag*, v_lag* に加えて必ず使う、過去24時間の平均の風
WIND_STATE_COLUMNS = ["u_mean24", "v_mean24"]
# 気温・気圧・日照から作る列。観測していない地点もあるので、学習期間に半分以上ある列だけ使う
OPTIONAL_RECENT_COLUMNS = [
    "temperature_now", "temperature_lag1", "temperature_lag2", "temperature_lag3", "temperature_lag6",
    "temperature_change_3h", "temperature_change_24h",
    "pressure_now", "pressure_change_1h", "pressure_change_3h",
    "sunshine_now", "sunshine_today",
]
# 24時間周期の持続予報が使う、予測起点 t 以前で対象時刻と同じ時刻（t + h − 24 × ⌈h/24⌉）の風
CYCLE_COLUMNS = ["u_cycle24", "v_cycle24"]
# 特徴量の組の別名（元の仕様の名前）。どれも1地点の時間的な情報の区分で、広い範囲の大気を観測した値ではない
FEATURE_SET_ALIASES = {"global_only": "calendar", "local_only": "recent", "combined": "calendar+recent"}

BASELINE_MODELS = ["persistence", "climatology", "persistence_24h"]
DEFAULT_MODELS = BASELINE_MODELS + [
    "linear:calendar",
    "linear:recent",
    "linear:calendar+recent",
    "boosting:calendar+recent",
    "degrees_as_numbers",
]
# 回帰モデルの設定。ここに名前を足すと「名前:calendar+recent」のように使える。
# 名前の後ろに _angle を付けると、同じ設定で u, v の代わりに角度を直接回帰する（例：linear_angle）。
MODEL_SETTINGS = {
    "linear": {"kind": "linear", "alpha": 1.0},
    "boosting_shallow": {"kind": "boosting", "max_depth": 2},
    "boosting": {"kind": "boosting", "max_depth": 3},
    "boosting_deep": {"kind": "boosting", "max_depth": 6},
}
BOOSTING_DEFAULTS = {"max_iter": 200, "learning_rate": 0.05, "min_samples_leaf": 200}
# 検証期間で選ぶ、統合モデル（季節・日周期＋過去・直近の観測）の候補。最終テスト期間では選ばない。
INTEGRATED_CANDIDATES = ["linear", "boosting_shallow", "boosting", "boosting_deep"]

METHOD_NAMES = {
    "persistence": ("持続予報", "Persistence"),
    "climatology": ("気候値予報（月×時刻の平均）", "Climatology (month x hour)"),
    "persistence_24h": ("24時間周期の持続予報", "Repeat of the last 24 h"),
    "linear": ("線形回帰", "Linear"),
    "boosting_shallow": ("勾配ブースティング（深さ2）", "Boosting (depth 2)"),
    "boosting": ("勾配ブースティング（深さ3）", "Boosting (depth 3)"),
    "boosting_deep": ("勾配ブースティング（深さ6）", "Boosting (depth 6)"),
    "degrees_as_numbers": ("悪い例：角度と時刻を数値のまま回帰", "Bad example: degrees and hour as numbers"),
}
FEATURE_NAMES = {
    "calendar": ("季節・日周期", "season & time of day"),
    "recent": ("過去・直近の観測", "past & recent obs."),
    "calendar+recent": ("季節・日周期＋過去・直近の観測", "combined"),
}
# 予測した風ベクトルがほぼ0で向きが決まらないとき、角度の誤差として数える値。
# 向きを一様ランダムに選んだときの誤差の期待値と同じにする（件数は別に数えて示す）。
UNDEFINED_DIRECTION_ERROR_DEG = RANDOM_DIRECTION_EXPECTED_ERROR_DEG
# 評価から外した理由（forecast の excluded 列）
EXCLUDED_INPUT = "予測起点までの入力の欠測"
EXCLUDED_TARGET = "対象時刻の観測なし（欠測）"

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
    """度を最も近い16方位の文字に変える（配列も可）。風向が決まらない（NaN）ときは None。"""
    degrees = np.asarray(degrees, dtype=float)
    index = np.round(np.nan_to_num(degrees) / 22.5).astype(int) % 16
    labels = np.array(DIRECTION_LABELS, dtype=object)[index]
    return np.where(np.isnan(degrees), None, labels)


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
    """風向の平均。単位ベクトル（cos, sin）を平均してから角度に戻す。

    北と南のように向きが打ち消し合うと、平均の向きは決まらないので NaN を返す。
    """
    radians = np.deg2rad(np.asarray(directions_deg, dtype=float))
    mean_sin = np.nanmean(np.sin(radians))
    mean_cos = np.nanmean(np.cos(radians))
    if not np.hypot(mean_sin, mean_cos) > 1e-9:
        return np.nan
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


# 「2024/2/28 1:00:00」の形（表計算ソフトで保存し直したときの「2024-02-28 01:00:00」も読む）
LITERAL_TIME_PATTERN = r"(\d{4})[/-](\d{1,2})[/-](\d{1,2}) (\d{1,2}):(\d{2})(?::\d{2})?"


def count_time_columns(row):
    """日時の見出しの行なら、日時の列数（「年月日時」は1、「年,月,日,時」は4）。見出しでなければ0。"""
    first_cells = [cell.strip() for cell in row[:4]]
    if first_cells[:1] == ["年月日時"]:
        return 1
    if first_cells == ["年", "月", "日", "時"]:
        return 4
    return 0


def find_header_row(rows):
    """日時の見出しがある行の番号と、日時の列数を返す。"""
    for number, row in enumerate(rows):
        n_time_columns = count_time_columns(row)
        if n_time_columns > 0:
            return number, n_time_columns
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


def drop_trailing_empty_cells(row):
    """表計算ソフトで保存し直すと行末に付くことがある、空の列を除く。"""
    while row and not row[-1].strip():
        row = row[:-1]
    return row


def check_single_station(station_row):
    """複数地点が1つのファイルに入っていないか確かめ、地点名を返す。"""
    names = {name.strip() for name in station_row if name.strip()}
    if len(names) > 1:
        raise ValueError(f"複数の地点が含まれています: {sorted(names)}。1地点ずつダウンロードしてください。")
    return names.pop() if names else ""


def check_unique_names(names):
    """同じ列名が2回以上ないか確かめる（同じ名前の地点が2つ入っているときなど）。"""
    repeated = sorted({name for name in names if names.count(name) > 1})
    if repeated:
        raise ValueError(
            f"同じ名前の列が複数あります: {repeated[:3]}。同じ名前の地点が2つ入っていないか確かめ、"
            "1地点ずつダウンロードしてください。"
        )


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


def collect_data_rows(rows, n_time_columns, n_values):
    """データの行から、日時の部分と値の部分を取り出す。"""
    time_cells = []
    value_cells = []
    for row in rows:
        if count_time_columns(row) > 0:
            raise ValueError("見出し行が2回以上あります。ファイルをつなげずに、"
                             "ファイルの一覧（例：[\"2023.csv\", \"2024.csv\"]）を渡してください。")
        if is_data_row(row, n_time_columns):
            values = row[n_time_columns:n_time_columns + n_values]
            time_cells.append(row[:n_time_columns])
            value_cells.append(values + [""] * (n_values - len(values)))
    return time_cells, value_cells


def make_table(time_cells, value_cells, names, n_time_columns):
    """取り出した文字列から表を作る。風向は文字のまま、ほかは数値にする（空欄は NaN）。"""
    table = pd.DataFrame(value_cells, columns=names, dtype=object)
    table.index = parse_time_cells(time_cells, n_time_columns)
    for column in table.columns:
        if column == "wind_direction":
            labels = table[column].str.strip()
            table[column] = labels.where(labels != "", np.nan)
        else:
            table[column] = pd.to_numeric(table[column].str.strip(), errors="coerce")
    return table.sort_index()


def join_tables(tables, paths):
    """同じ地点・同じ形式の表をつなげる。重複した時刻は、先に渡したファイルの値を使う。"""
    for table, path in zip(tables[1:], paths[1:]):
        if table.attrs.get("station") != tables[0].attrs.get("station"):
            raise ValueError(f"{path} は別の地点（{table.attrs.get('station')}）のファイルです。"
                             "同じ地点のファイルだけを渡してください。")
        if set(table.columns) != set(tables[0].columns):
            raise ValueError(f"{path} は、ほかのファイルと項目や表示オプションが違います。"
                             "同じ設定でダウンロードしたファイルだけを渡してください。")
    combined = pd.concat(tables)
    combined = combined[~combined.index.duplicated(keep="first")]  # 並べ替える前に除くと、先のファイルの行が残る
    combined = combined.sort_index()
    combined.attrs["station"] = tables[0].attrs.get("station", "")
    return combined


def read_jma_csv(path, encoding=None):
    """気象庁形式の時別値CSVを読み、時刻を行の名前（index）にした表を返す。

    path にファイルの一覧を渡すと、つなげて1つの表にする。重複した時刻は、先に渡したファイルの
    値を使う（新しくダウンロードしたファイルを先に渡すと、修正後の値が使われる）。
    風向は文字のまま（wind_direction 列）、そのほかの値と品質情報は数値に変える。
    空欄は欠損（NaN）になる。地点名は表の attrs["station"] に入れる。
    """
    if isinstance(path, (list, tuple)):
        return join_tables([read_jma_csv(one_path, encoding) for one_path in path], path)

    rows = list(csv.reader(io.StringIO(read_text(path, encoding))))
    header_number, n_time_columns = find_header_row(rows)
    station = check_single_station(rows[header_number - 1]) if header_number > 0 else ""
    first_data = header_number + 1
    while first_data < len(rows) and not is_data_row(rows[first_data], n_time_columns):
        first_data += 1
    if first_data == len(rows):
        raise ValueError("日時で始まるデータの行がありません。日時が「2024/2/28 1:00:00」の形か"
                         "（表計算ソフトで保存し直すと変わることがある）、期間や項目を確かめてください。")
    header = drop_trailing_empty_cells(rows[header_number])
    names = make_column_names(header, rows[header_number + 1:first_data], n_time_columns)
    check_unique_names(names)
    time_cells, value_cells = collect_data_rows(rows[first_data:], n_time_columns, len(names))
    table = make_table(time_cells, value_cells, names, n_time_columns)
    table.attrs["station"] = station
    return table


# ---------------------------------------------------------------------------
# 予測に使える形へ整える
# ---------------------------------------------------------------------------

def fill_no_phenomenon(raw, min_quality=DEFAULT_MIN_QUALITY):
    """日照時間・降水量で「現象がない」ため空欄の値を 0 にする。

    気象庁のCSVでは、現象なし情報が 1 の行（例：夜の日照時間）は値が 0 と書かれる。
    現象なし情報の列がない地点（アメダス）では、夜の日照時間が空欄で、品質情報は正常（8）だった
    （2026年10月にダウンロードしたファイルで確認。気象庁のヘルプには書かれていない）。
    どちらも「その1時間に日照（降水）がなかった」として 0 時間（0 mm）にそろえる。
    品質情報が 4 未満の空欄（疑問値・欠測・観測していない）は、min_quality に関係なく 0 にしない。
    0 にした行は「列名_blank_as_zero」に記録する。
    品質情報も現象なし情報もない日照時間は、夜の空欄と欠測を区別できないので使わない（すべて欠損にする）。
    """
    table = raw.copy()
    for column in ["sunshine_h", "precipitation_mm"]:
        if column not in raw.columns:
            continue
        flags = {column + "_no_phenomenon", column + "_quality"} & set(raw.columns)
        if column == "sunshine_h" and not flags:
            # 昼の値だけ残すと、予測の表から夜の行がすべて消えてしまうので、日照時間は使わない
            table[column] = np.nan
            table[column + "_blank_as_zero"] = False
            continue
        blank = raw[column].isna()
        no_phenomenon = raw.get(column + "_no_phenomenon", pd.Series(np.nan, index=raw.index)) == 1
        good_quality = raw.get(column + "_quality", pd.Series(np.nan, index=raw.index)) >= max(min_quality, 4)
        filled = (blank & (no_phenomenon | good_quality)).to_numpy()
        table.loc[filled, column] = 0.0
        table[column + "_blank_as_zero"] = filled
    return table


def apply_quality(raw, min_quality=DEFAULT_MIN_QUALITY):
    """品質情報が min_quality 未満（または不明）の値を欠損にする。

    気象庁の品質情報は 8 が正常値、5 が準正常値、4 が資料不足値、2 が疑問値、
    1 が欠測、0 が観測していないことを表す。既定では正常値（8）だけを使う。
    準正常値も使うときは min_quality=5 とする。
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
    table = table[~table.index.duplicated(keep="first")].sort_index()  # 重複は先に除き、最初の行を残す
    full_index = pd.date_range(table.index.min(), table.index.max(),
                               freq=pd.Timedelta(hours=1), name="time")
    hourly = table.reindex(full_index)
    for column in hourly.columns:
        if column == "wind_is_calm" or column.endswith("_blank_as_zero"):
            hourly[column] = hourly[column].eq(True).to_numpy()  # 追加した時刻は False
    return hourly


def prepare_weather(raw, min_quality=DEFAULT_MIN_QUALITY):
    """読み込んだ表を、予測に使う1時間ごとの表に整える。

    1. 現象がないため空欄の日照時間・降水量を 0 にする
    2. 品質情報が低い値を欠損にする
    3. 16方位の風向を度に変え、静穏かどうかを記録する
    4. 風速・風向から u, v 成分を作る
    5. 1時間刻みの完全な時刻列に並べ直す
    """
    if "wind_speed_ms" not in raw.columns or "wind_direction" not in raw.columns:
        raise ValueError("風速と風向の列がありません。ダウンロードの項目で「風向・風速」を選んでください。")
    if raw["wind_speed_ms"].notna().sum() == 0:
        raise ValueError("風速の値が1つもありません。品質情報が0なら、この地点では風向・風速を観測していません。"
                         "風向・風速を観測している地点を選んでください。")
    table = fill_no_phenomenon(raw, min_quality)
    table = apply_quality(table, min_quality)
    table = add_direction_degrees(table)
    table = add_wind_components(table)
    return to_hourly_index(table)


def load_weather(path, encoding=None, min_quality=DEFAULT_MIN_QUALITY):
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
            note = "（すべて欠損：この地点では観測していないか、品質情報がなく使えない）" if missing == len(weather) else ""
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
    has_homogeneity = any(column.endswith("_homogeneity") for column in weather.columns)
    rows.append(("均質番号が変わった時刻（観測環境の変化。ファイルの境目も含む）",
                 homogeneity_changes(weather) if has_homogeneity else
                 "均質番号の列なし（観測環境の変化を確かめられない）"))
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


def check_hours(horizon, lags):
    """予測時間と「何時間前」が0以上の整数か確かめる。

    負の値を使うと、予測時刻より後の観測が入力に入ってしまう（リーク）。
    """
    for value in [horizon, *lags]:
        if not isinstance(value, (int, np.integer)) or value < 0:
            raise ValueError(f"予測時間と lags は0以上の整数（時間）にしてください: {value!r}")


def cycle_lag(horizon):
    """24時間周期の持続予報で、予測起点 t の何時間前の観測を使うか。

    対象時刻 t + h と同じ時刻で、t 以前の最も新しい観測は t + h − 24 × ⌈h/24⌉。
    これは t の 24 × ⌈h/24⌉ − h 時間前（0〜23時間前）で、t より後になることはない。
    例：h = 1 → 23時間前、h = 24, 48, 72 → 0時間前（t の値）、h = 25 → 23時間前。
    """
    return 24 * math.ceil(horizon / 24) - horizon


def day_cumulative(values, times):
    """その日の1時から各時刻までの合計（当日の累積）。

    気象庁の時別値と同じく、0時の行は前日の24時として前日に数える。その日のうちに欠損が
    あれば、それより後の累積は欠損にする（欠けた値を0とみなさない）。
    """
    times = pd.DatetimeIndex(times)
    day = (times - pd.Timedelta(hours=1)).normalize()
    values = pd.Series(np.asarray(values, dtype=float), index=times)
    missing_so_far = values.isna().astype(int).groupby(day).cummax() > 0
    total = values.fillna(0.0).groupby(day).cumsum()
    return total.where(~missing_so_far).to_numpy()


def make_forecast_table(weather, horizon, lags=LAG_HOURS):
    """予測起点（予測を出す時刻）t までの情報から、horizon 時間後の対象時刻 t + horizon の風を
    予測するための表を作る。

    1行が1つの予測起点 t（行の名前 issue_time）。t より後の観測は、目的変数（target_ で始まる列）にだけ入る。
    - 目的変数：t + horizon の u, v と風向（静穏なら風向は NaN、u = v = 0）
    - 季節・日周期：t + horizon の暦（暦は前もって分かる）。月×時刻の平均の風（clim_u, clim_v）は、
      学習期間が決まってから add_climatology_columns で加える。
    - 過去・直近の観測：t とそれより前の観測。shift(k) は k 時間前の値。
    - 24時間周期の持続予報に使う、t 以前で対象時刻と同じ時刻の風（u_cycle24, v_cycle24）
    lags には必ず 0（予測起点の値）を含める（持続予報に使うため）。
    """
    check_hourly(weather)
    check_hours(horizon, lags)
    lags = sorted(set(lags) | {0})
    u = weather["u_ms"]
    v = weather["v_ms"]
    table = pd.DataFrame(index=weather.index.rename("issue_time"))
    table["target_time"] = weather.index + pd.Timedelta(hours=horizon)
    table["target_hour"] = table["target_time"].dt.hour
    table["target_u"] = u.shift(-horizon).to_numpy()
    table["target_v"] = v.shift(-horizon).to_numpy()
    table["target_direction_deg"] = weather["wind_direction_deg"].shift(-horizon).to_numpy()
    table["issue_direction_deg"] = weather["wind_direction_deg"].to_numpy()

    calendar = calendar_features(table["target_time"])
    for column in CALENDAR_COLUMNS:
        table[column] = calendar[column].to_numpy()

    for lag in lags:
        table[f"u_lag{lag}"] = u.shift(lag).to_numpy()
        table[f"v_lag{lag}"] = v.shift(lag).to_numpy()
    table["u_mean24"] = u.rolling(24, min_periods=24).mean().to_numpy()  # t を含む過去24時間の平均
    table["v_mean24"] = v.rolling(24, min_periods=24).mean().to_numpy()
    cycle = cycle_lag(horizon)
    table["u_cycle24"] = u.shift(cycle).to_numpy()
    table["v_cycle24"] = v.shift(cycle).to_numpy()
    add_optional_columns(table, weather)
    return table


def add_optional_columns(table, weather):
    """気温・気圧・日照の観測があれば、予測起点 t までの値から作る列を table に加える。"""
    if "temperature_c" in weather.columns:
        temperature = weather["temperature_c"]
        table["temperature_now"] = temperature.to_numpy()
        for lag in TEMPERATURE_LAG_HOURS:
            table[f"temperature_lag{lag}"] = temperature.shift(lag).to_numpy()
        table["temperature_change_3h"] = (temperature - temperature.shift(3)).to_numpy()
        table["temperature_change_24h"] = (temperature - temperature.shift(24)).to_numpy()
    pressure_name = pressure_column(weather)
    if pressure_name is not None:
        pressure = weather[pressure_name]
        table["pressure_now"] = pressure.to_numpy()
        table["pressure_change_1h"] = (pressure - pressure.shift(1)).to_numpy()
        table["pressure_change_3h"] = (pressure - pressure.shift(3)).to_numpy()
    if "sunshine_h" in weather.columns:
        table["sunshine_now"] = weather["sunshine_h"].to_numpy()  # その1時間の日照時間
        table["sunshine_today"] = day_cumulative(weather["sunshine_h"], weather.index)  # その日の t までの合計


def add_climatology_columns(table, climatology):
    """対象時刻の（月, 時刻）の平均の風を、入力の列 clim_u, clim_v として加えた表を返す。

    climatology は、学習期間だけから fit_climatology で作ったものを渡す。値は基準予報の
    「気候値予報」と同じだが、こちらは統合モデルなどの入力（特徴量）として使う。
    """
    table = table.copy()
    u, v = predict_climatology(climatology, table["target_time"])
    table["clim_u"] = u
    table["clim_v"] = v
    return table


def recent_columns(table, min_available=0.5):
    """過去・直近の観測の列のうち、使う列を返す（学習用の行を渡す）。

    風の列（u_lag*, v_lag*, u_mean24, v_mean24）は必ず使う。気温・気圧・日照の列は、
    渡した行の半分以上に値がある場合だけ使う（その観測をしていない地点もあるため）。
    """
    columns = [name for name in table.columns if name.startswith(("u_lag", "v_lag"))] + WIND_STATE_COLUMNS
    for name in OPTIONAL_RECENT_COLUMNS:
        if name in table.columns and table[name].notna().mean() >= min_available:
            columns.append(name)
    return columns


def feature_columns(feature_set, recent):
    """特徴量の組の名前から列名の一覧を作る。

    - calendar（元の名前 global_only）：季節・日周期。対象時刻の周期特徴量と月×時刻の平均の風
    - recent（local_only）：過去・直近の観測。recent_columns で選んだ列
    - calendar+recent（combined）：両方
    どれも1地点の時間的な情報の区分で、広い範囲の大気の状態を観測した値ではない。
    """
    feature_set = FEATURE_SET_ALIASES.get(feature_set, feature_set)
    calendar = list(CALENDAR_COLUMNS) + list(CLIMATOLOGY_COLUMNS)
    if feature_set == "calendar":
        return calendar
    if feature_set == "recent":
        return list(recent)
    if feature_set == "calendar+recent":
        return calendar + list(recent)
    raise ValueError(f"未知の特徴量の組です: {feature_set}（calendar, recent, calendar+recent のどれか）")


# ---------------------------------------------------------------------------
# 時間分割
# ---------------------------------------------------------------------------

def year_split(weather):
    """1年目を学習、2年目を検証、3年目以降を最終テストにする分割（暦の上の1年ずつ）。

    最初の時刻が 2023-01-01 01:00 なら、検証は 2024-01-01 01:00、最終テストは 2025-01-01 01:00 から。
    """
    start = weather.index.min()
    validation_start = start + pd.DateOffset(years=1)
    test_start = start + pd.DateOffset(years=2)
    if test_start + pd.Timedelta(days=60) > weather.index.max():
        raise ValueError(
            f"年ごとの分割（1年目学習・2年目検証・3年目テスト）には3年分ほどのデータが必要です"
            f"（データは {start}〜{weather.index.max()}）。分割の mode を \"last_days\" にしてください。"
        )
    return {"mode": "years", "start": start, "validation_start": validation_start,
            "test_start": test_start, "end": weather.index.max()}


def last_days_split(weather, test_days=365, validation_days=0):
    """最後の test_days 日を最終テスト、その前の validation_days 日を検証にする分割（0 なら検証なし）。"""
    end = weather.index.max()
    test_start = end - pd.Timedelta(days=test_days) + pd.Timedelta(hours=1)
    validation_start = test_start - pd.Timedelta(days=validation_days) if validation_days > 0 else None
    return {"mode": "last_days", "start": weather.index.min(), "validation_start": validation_start,
            "test_start": test_start, "end": end}


def test_start_split(weather, test_start):
    """test_start より前を学習、test_start 以降を最終テストにする分割（検証なし）。"""
    return {"mode": "test_start", "start": weather.index.min(), "validation_start": None,
            "test_start": pd.Timestamp(test_start), "end": weather.index.max()}


def make_split(weather, mode="years", test_days=365, validation_days=365):
    """分割を作る。mode は "years"（1年目学習・2年目検証・3年目テスト）または "last_days"。"""
    if mode == "years":
        return year_split(weather)
    if mode == "last_days":
        return last_days_split(weather, test_days, validation_days)
    raise ValueError(f"未知の分割です: {mode}（years または last_days）")


def stage_bounds(split, stage):
    """段階の学習期間と評価期間：(学習の開始, 学習の終わり, 評価の開始, 評価の終わり)。

    終わりの時刻はその期間に含まない。stage は "validation"（学習期間で学習し検証期間で評価）
    または "test"（検証期間までで学習し最終テスト期間で評価）。
    """
    if stage == "validation":
        if split.get("validation_start") is None:
            raise ValueError("この分割には検証期間がありません。")
        return split["start"], split["validation_start"], split["validation_start"], split["test_start"]
    if stage == "test":
        return split["start"], split["test_start"], split["test_start"], split["end"] + pd.Timedelta(hours=1)
    raise ValueError(f"未知の段階です: {stage}（validation または test）")


def default_test_start(weather, test_days=365):
    """最後の test_days 日をテスト期間にするときの、テスト開始時刻。"""
    return weather.index.max() - pd.Timedelta(days=test_days) + pd.Timedelta(hours=1)


def split_train_test(table, test_start):
    """時間で学習用とテスト用に分ける（ランダムには分けない）。

    - テスト：予測起点 t がテスト開始以降の行
    - 学習：予測の対象時刻 t + horizon がテスト開始より前の行
    学習の答え（目的変数）がテスト期間に入らないよう、境界の手前 horizon 時間分は使わない。
    """
    test_start = pd.Timestamp(test_start)
    train = table[table["target_time"] < test_start]
    test = table[table.index >= test_start]
    return train, test


def exclusion_reasons(rows, inputs):
    """評価に使えない行の理由を返す（使える行は空の文字列）。"""
    reasons = pd.Series("", index=rows.index, dtype=object)
    reasons[rows[["target_u", "target_v"]].isna().any(axis=1).to_numpy()] = EXCLUDED_TARGET
    reasons[rows[inputs].isna().any(axis=1).to_numpy()] = EXCLUDED_INPUT
    return reasons


def warn_if_optional_inputs_drop_rows(evaluation, recent):
    """気温・気圧・日照の欠損だけが理由で、評価する行が5%より多く減るなら知らせる。"""
    optional = [name for name in recent if name in OPTIONAL_RECENT_COLUMNS]
    wind = [name for name in recent if name not in OPTIONAL_RECENT_COLUMNS] + ["target_u", "target_v"]
    wind_ok = evaluation[wind].notna().all(axis=1)
    if not optional or not wind_ok.any():
        return
    share = evaluation.loc[wind_ok, optional].isna().any(axis=1).mean()
    if share > 0.05:
        missing = [name for name in optional if evaluation.loc[wind_ok, name].isna().any()]
        warnings.warn(f"評価する予測起点の {share:.0%} で {missing} が欠けているため、すべての手法の評価から外しました。"
                      "途中で観測が止まった要素の列を weather から消してから実験すると、評価する時刻が減りません。")


def prepare_stage(weather, horizon, split, stage="test", lags=LAG_HOURS, max_horizon=COMMON_MAX_HORIZON):
    """1つの段階（検証または最終テスト）で使う、学習用の行と評価用の行を作る。

    - 学習用：予測起点も対象時刻も学習期間の中にある行（対象時刻が次の期間に入る行は除く）
    - 評価用：予測起点が評価期間の中にあり、max_horizon 時間先まで評価期間に収まる行。どの予測時間でも
      同じ予測起点になる。行は消さずに残し、使えない行には理由を excluded 列に書く。
    - 気候値（入力の列と基準予報）と、使う任意の列は、学習期間だけから決める。標準化はモデルの中で
      学習用の行だけから決まる。欠けた値の補完はしない（欠けた行は使わない）。
    戻り値は辞書：train, evaluation, inputs（評価に必要な入力の列）, recent, climatology, bounds。
    """
    if horizon > max_horizon:
        raise ValueError(f"予測時間 {horizon} が max_horizon（{max_horizon}）より長いです。")
    train_start, train_end, eval_start, eval_end = stage_bounds(split, stage)
    climatology = fit_climatology(weather, train_end, train_start)
    table = add_climatology_columns(make_forecast_table(weather, horizon, lags), climatology)
    in_train = (table.index >= train_start) & (table["target_time"] < train_end)
    in_eval = (table.index >= eval_start) & (table.index + pd.Timedelta(hours=max_horizon) < eval_end)
    recent = recent_columns(table[in_train])
    inputs = list(CALENDAR_COLUMNS) + list(CLIMATOLOGY_COLUMNS) + recent + list(CYCLE_COLUMNS)
    train = table[in_train].dropna(subset=inputs + ["target_u", "target_v"])
    evaluation = table[in_eval].copy()
    evaluation["excluded"] = exclusion_reasons(evaluation, inputs)
    warn_if_optional_inputs_drop_rows(evaluation, recent)
    if len(train) < 24 * 30:
        raise ValueError(
            f"学習用のデータが {len(train)} 行しかありません。学習期間は {train_start}〜{train_end} の前までで、"
            f"30日以上のデータが必要です（データは {weather.index.min()}〜{weather.index.max()}）。"
            "test_days を短くするか、期間を延ばしてください。"
        )
    if (evaluation["excluded"] == "").sum() == 0:
        raise ValueError(f"評価期間（{eval_start} から）に、{max_horizon} 時間先まで収まって評価できる時刻がありません。"
                         "期間を確認してください。")
    return {"train": train, "evaluation": evaluation, "inputs": inputs, "recent": recent,
            "climatology": climatology, "bounds": (train_start, train_end, eval_start, eval_end)}


def input_missing_counts(stage_data):
    """評価用の行で、入力の列ごとに欠けている数（欠けている列だけ）。どの観測で行が減ったかを見る。"""
    counts = stage_data["evaluation"][stage_data["inputs"]].isna().sum()
    return counts[counts > 0]


def input_column_table(stage_data):
    """入力の列ごとに、使うかどうか（used）と、評価用の行で欠けている数（n_missing）を表にする。

    気温・気圧・日照の列は、データにないとき（n_missing は空）や、学習期間に値が半分未満のときは使わない。
    """
    evaluation = stage_data["evaluation"]
    inputs = stage_data["inputs"]
    names = inputs + [name for name in OPTIONAL_RECENT_COLUMNS if name not in inputs]
    rows = []
    for name in names:
        n_missing = int(evaluation[name].isna().sum()) if name in evaluation.columns else None
        rows.append({"column": name, "used": name in inputs, "n_missing": n_missing})
    return pd.DataFrame(rows).astype({"n_missing": "Int64"})


# ---------------------------------------------------------------------------
# 予測の方法
# ---------------------------------------------------------------------------

def parse_model(spec):
    """「linear:calendar」のような文字列を、手法と特徴量の組に分ける（特徴量の組の別名も受け付ける）。"""
    method, _, feature_set = spec.partition(":")
    if feature_set:
        feature_set = FEATURE_SET_ALIASES.get(feature_set, feature_set)
    return method, (feature_set or None)


def split_method(method):
    """手法の名前を、回帰モデルの設定名と「角度を直接回帰するか」に分ける（例：linear_angle → linear, True）。"""
    if method.endswith("_angle"):
        return method[: -len("_angle")], True
    return method, False


def model_label(spec, language="ja"):
    """手法の表示名。language="en" で図用の英語名。"""
    method, feature_set = parse_model(spec)
    base, angle = split_method(method)
    position = 0 if language == "ja" else 1
    label = METHOD_NAMES.get(base, (base, base))[position]
    if angle:
        label += "・角度を直接回帰" if language == "ja" else ", angle as target"
    if feature_set:
        names = FEATURE_NAMES.get(feature_set, (feature_set, feature_set))
        label += f"（{names[0]}）" if language == "ja" else f" ({names[1]})"
    return label


def fit_climatology(weather, train_end, train_start=None):
    """学習期間（train_start 以上 train_end 未満）の、（月, 時刻）ごとの平均の風ベクトル。"""
    in_train = weather.index < pd.Timestamp(train_end)
    if train_start is not None:
        in_train &= weather.index >= pd.Timestamp(train_start)
    past = weather[in_train]
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


def make_regressor(method, seed=0, n_outputs=2):
    """MODEL_SETTINGS の名前から回帰モデルを作る。n_outputs=2 は u と v、1 は角度。

    - linear：標準化してからリッジ回帰（係数が大きくなりすぎないよう少し抑えた線形回帰）
    - boosting：勾配ブースティング木（u 用と v 用に1つずつ）。min_samples_leaf=200 の大きめの葉で、
      学習期間だけの偶然の変動を覚えにくくする。early_stopping=False で、学習データをランダムに分ける
      内部の検証を使わない。木の深さ（max_depth）は候補ごとに違い、検証期間の成績で選ぶ。
    """
    if method not in MODEL_SETTINGS:
        raise ValueError(f"未知の手法です: {method}（{', '.join(MODEL_SETTINGS)} のどれか）")
    settings = MODEL_SETTINGS[method]
    if settings["kind"] == "linear":
        return make_pipeline(StandardScaler(), Ridge(alpha=settings.get("alpha", 1.0)))
    params = {**BOOSTING_DEFAULTS, **{name: value for name, value in settings.items() if name != "kind"}}
    booster = HistGradientBoostingRegressor(early_stopping=False, random_state=seed, **params)
    return MultiOutputRegressor(booster) if n_outputs == 2 else booster


def fit_predict_uv(method, train, rows, columns, seed=0):
    """学習用の行でモデルを学習し、rows の u, v を予測する。

    並列計算は1スレッドにする。ほかの処理と同時に動かしたときに勾配ブースティングが
    極端に遅くなるのを防ぐためで、結果は変わらない。
    """
    model = make_regressor(method, seed)
    with threadpool_limits(limits=1):
        model.fit(train[columns].to_numpy(), train[["target_u", "target_v"]].to_numpy())
        predicted = model.predict(rows[columns].to_numpy())
    return predicted[:, 0], predicted[:, 1]


def fit_predict_angle(method, train, rows, columns, seed=0):
    """u, v の代わりに、対象時刻の風向（度）を数として直接回帰する（同じ入力・同じ設定で比べる用）。

    静穏の行は風向がないので、学習から外す。予測は0以上360未満にそろえる。
    """
    usable = train.dropna(subset=["target_direction_deg"])
    model = make_regressor(method, seed, n_outputs=1)
    with threadpool_limits(limits=1):
        model.fit(usable[columns].to_numpy(), usable["target_direction_deg"].to_numpy())
        predicted = model.predict(rows[columns].to_numpy())
    return normalise_degrees(predicted)


def fit_predict_degrees_as_numbers(train, rows):
    """悪い例：風向を普通の数値として線形回帰する。

    入力は予測起点の風向（度）と対象時刻の時（0〜23）、出力は対象時刻の風向（度）。
    350度と10度が近いことを知らないため、北寄りの風で大きく外れやすい。
    時刻もふつうの数として使うので、23時と0時が近いことも知らない。
    予測起点が静穏で風向がない行は予測できない（NaN）。
    """
    columns = ["issue_direction_deg", "target_hour"]
    usable = train.dropna(subset=columns + ["target_direction_deg"])
    model = LinearRegression()
    model.fit(usable[columns].to_numpy(), usable["target_direction_deg"].to_numpy())
    predicted = np.full(len(rows), np.nan)
    known = rows[columns].notna().all(axis=1).to_numpy()
    if known.any():
        predicted[known] = normalise_degrees(model.predict(rows.loc[known, columns].to_numpy()))
    return predicted


def predict_one(spec, stage_data, rows, seed=0):
    """手法 spec で rows の各行を予測し、(風向, u, v) を返す。風向だけを予測する手法は u, v が None。"""
    method, feature_set = parse_model(spec)
    if method == "persistence":
        u, v = rows["u_lag0"].to_numpy(), rows["v_lag0"].to_numpy()
    elif method == "persistence_24h":
        u, v = rows["u_cycle24"].to_numpy(), rows["v_cycle24"].to_numpy()
    elif method == "climatology":
        u, v = rows["clim_u"].to_numpy(), rows["clim_v"].to_numpy()
    elif method == "degrees_as_numbers":
        return fit_predict_degrees_as_numbers(stage_data["train"], rows), None, None
    else:
        base, angle = split_method(method)
        if base not in MODEL_SETTINGS:
            raise ValueError(f"未知の手法です: {spec}")
        if feature_set is None:
            raise ValueError(f"特徴量の組を「{method}:calendar+recent」のように指定してください: {spec}")
        columns = feature_columns(feature_set, stage_data["recent"])
        if angle:
            return fit_predict_angle(base, stage_data["train"], rows, columns, seed), None, None
        u, v = fit_predict_uv(base, stage_data["train"], rows, columns, seed)
    return uv_to_direction(u, v), u, v


# ---------------------------------------------------------------------------
# 実験と評価
# ---------------------------------------------------------------------------

def forecast_rows(stage_data, models, seed=0, rows=None):
    """評価用の行（rows を省略すると stage_data["evaluation"]）について、各手法の予測を表にする。

    列：target_time, target_hour, target_u, target_v, target_direction_deg（静穏なら NaN）, excluded（使えない理由）、
    手法ごとの予測風向（列名は手法名）と、u, v を予測する手法では予測した u, v（列名の後ろに __u, __v）。
    使えない行（excluded が空でない行）の予測は NaN にする。
    """
    rows = stage_data["evaluation"] if rows is None else rows
    used = (rows["excluded"] == "").to_numpy()
    columns = ["target_time", "target_hour", "target_u", "target_v", "target_direction_deg", "excluded"]
    forecasts = rows[columns].copy()
    predictions = {}
    for spec in models:
        direction, u, v = predict_one(spec, stage_data, rows[used], seed)
        predictions[spec] = direction
        if u is not None:
            predictions[f"{spec}__u"] = u
            predictions[f"{spec}__v"] = v
    for name, values in predictions.items():
        column = np.full(len(rows), np.nan)
        column[used] = values
        forecasts[name] = column
    return forecasts


def forecast_stage(weather, horizon, models, split, stage="test", lags=LAG_HOURS,
                   max_horizon=COMMON_MAX_HORIZON, seed=0):
    """1つの段階・1つの予測時間について、評価用の各行での各手法の予測を表にする（列は forecast_rows）。"""
    stage_data = prepare_stage(weather, horizon, split, stage, lags, max_horizon)
    return forecast_rows(stage_data, models, seed)


def forecast_one_horizon(weather, horizon, models=DEFAULT_MODELS, test_start=None, lags=LAG_HOURS, seed=0):
    """簡易版：test_start より前で学習し、それ以降で評価する（既定は最後の365日がテスト期間、検証なし）。

    評価の予測起点は、horizon 時間先まで評価期間に収まる時刻。予測時間どうしを比べるときは、
    どの予測時間でも同じ予測起点を使う forecast_stage と run_horizon_experiment を使う。
    """
    if test_start is None:
        test_start = default_test_start(weather)
    split = test_start_split(weather, test_start)
    return forecast_stage(weather, horizon, models, split, "test", lags, max_horizon=horizon, seed=seed)


def forecast_training_period(weather, horizon, models, split, stage="test", lags=LAG_HOURS,
                             max_horizon=COMMON_MAX_HORIZON, seed=0):
    """学習期間の各時刻を、その期間で学習したモデル自身で予測する（過学習を調べる用）。

    学習に使った時刻の成績なので、ふつうの評価には使わない。評価期間の成績と比べて、
    学習期間だけよく当たるなら、学習期間の偶然の変動まで覚えている（過学習）と考えられる。
    """
    stage_data = prepare_stage(weather, horizon, split, stage, lags, max_horizon)
    rows = stage_data["train"].assign(excluded="")
    return forecast_rows(stage_data, models, seed, rows)


def angle_rows(forecasts):
    """角度の評価に使う行：評価に使える行のうち、対象時刻の風向が決まる（静穏でない）行。"""
    used = forecasts["excluded"] == "" if "excluded" in forecasts else pd.Series(True, index=forecasts.index)
    return (used & forecasts["target_direction_deg"].notna()).to_numpy()


def angle_errors(forecasts, spec):
    """角度の評価に使う行での、手法 spec の誤差（度）。予測の向きが決まらない行は90度として数える。"""
    rows = angle_rows(forecasts)
    errors = angular_error(forecasts.loc[rows, "target_direction_deg"], forecasts.loc[rows, spec])
    return pd.Series(np.where(np.isnan(errors), UNDEFINED_DIRECTION_ERROR_DEG, errors),
                     index=forecasts.index[rows])


def vector_rmse(forecasts, spec):
    """予測と観測の風ベクトルの差の大きさの二乗平均平方根（m/s）。風向だけを予測する手法は NaN。

    静穏（u = v = 0）の対象時刻も含める。対象時刻の観測がない行と、評価から外した行は使わない。
    """
    if f"{spec}__u" not in forecasts:
        return np.nan
    used = forecasts["excluded"] == "" if "excluded" in forecasts else pd.Series(True, index=forecasts.index)
    part = forecasts[used & forecasts["target_u"].notna()]
    squared = (part[f"{spec}__u"] - part["target_u"]) ** 2 + (part[f"{spec}__v"] - part["target_v"]) ** 2
    return float(np.sqrt(squared.mean()))


def score_forecasts(forecasts, models):
    """各手法の成績と、評価に使った件数・外した件数を表にする。

    - mae_deg：角度の平均絶対誤差（度）。対象時刻の風向が決まる行で計算する。予測の向きが決まらない
      行（予測した風ベクトルが0）は、向きを一様ランダムに選んだときの期待誤差（90度）として数える。
    - within_45_pct：誤差45度以内の割合（%）。向きが決まらない予測は「外れ」として数える。
    - vector_rmse_ms：風ベクトルの差の二乗平均平方根（m/s）。静穏も含める。風向だけを予測する手法は NaN（対象外）。
    - n_test：角度の評価件数。n_vector：ベクトルの評価件数。n_undefined・undefined_pct：予測の向きが決まらない
      件数と、角度の評価件数に対する割合（%）。n_calm_target：対象時刻が静穏で角度の評価から外した件数。
      n_missing_target：対象時刻の観測がない件数。n_missing_input：予測起点までの入力が欠けていた件数。
      n_issue：予測起点の数（これらの合計の元）。どの手法も同じ行で評価する。
    """
    has_status = "excluded" in forecasts
    used = forecasts["excluded"] == "" if has_status else pd.Series(True, index=forecasts.index)
    rows_for_angle = angle_rows(forecasts)
    has_target_vector = "target_u" in forecasts
    rows = []
    for spec in models:
        predicted = forecasts.loc[rows_for_angle, spec].to_numpy(dtype=float)
        undefined = np.isnan(predicted)
        errors = angle_errors(forecasts, spec).to_numpy()
        within = ~undefined & (errors <= 45 + 1e-9)  # 16方位どうしのちょうど45度を丸め誤差で外さない
        rows.append({
            "model": spec,
            "label": model_label(spec),
            "mae_deg": float(np.mean(errors)) if len(errors) else np.nan,
            "within_45_pct": float(100 * np.mean(within)) if len(errors) else np.nan,
            "vector_rmse_ms": vector_rmse(forecasts, spec) if has_target_vector else np.nan,
            "n_test": int(rows_for_angle.sum()),
            "n_vector": int((used & forecasts["target_u"].notna()).sum()) if has_target_vector else 0,
            "n_undefined": int(undefined.sum()),
            "undefined_pct": float(100 * np.mean(undefined)) if len(errors) else np.nan,
            "n_calm_target": int((used & forecasts["target_direction_deg"].isna()).sum()),
            "n_missing_target": int((forecasts["excluded"] == EXCLUDED_TARGET).sum()) if has_status else 0,
            "n_missing_input": int((forecasts["excluded"] == EXCLUDED_INPUT).sum()) if has_status else 0,
            "n_issue": int(len(forecasts)),
        })
    return pd.DataFrame(rows)


def run_horizon_experiment(weather, horizons, models=DEFAULT_MODELS, split=None, stage="test",
                           lags=LAG_HOURS, max_horizon=None, seed=0, test_start=None):
    """予測時間を変えながら同じ評価を繰り返し、結果を1つの表にまとめる。

    どの予測時間でも同じ予測起点（max_horizon 時間先まで評価期間に収まる時刻）を使う。max_horizon を
    省略すると、COMMON_MAX_HORIZON（72）と horizons の最大値の大きい方。split を省略すると、
    test_start があればその前後で、なければ年ごとに分ける。
    """
    if split is None:
        split = test_start_split(weather, test_start) if test_start is not None else year_split(weather)
    if max_horizon is None:
        max_horizon = max(COMMON_MAX_HORIZON, max(horizons))
    tables = []
    for horizon in horizons:
        forecasts = forecast_stage(weather, horizon, models, split, stage, lags, max_horizon, seed)
        scores = score_forecasts(forecasts, models)
        scores.insert(0, "horizon_h", horizon)
        tables.append(scores)
    return pd.concat(tables, ignore_index=True)


def error_by_hour(forecasts, models):
    """対象時刻の時（0〜23時）ごとの平均絶対角度誤差（向きが決まらない予測は90度）。"""
    rows = angle_rows(forecasts)
    errors = pd.DataFrame({spec: angle_errors(forecasts, spec) for spec in models})
    hours = forecasts.loc[rows, "target_hour"].to_numpy()
    return errors.groupby(hours).mean().rename_axis("target_hour")


def select_on_validation(weather, split, candidates=INTEGRATED_CANDIDATES, horizon=3,
                         feature_set="calendar+recent", lags=LAG_HOURS, max_horizon=COMMON_MAX_HORIZON, seed=0):
    """検証期間の成績で、統合モデルの設定（MODEL_SETTINGS の名前）を選ぶ。最終テスト期間は見ない。

    学習期間で学習し、検証期間の horizon 時間先の平均絶対角度誤差が最も小さい候補を選ぶ
    （同じなら一覧で先の候補）。戻り値は（候補ごとの検証期間の成績の表, 選んだ名前）。
    """
    specs = [f"{name}:{feature_set}" for name in candidates]
    forecasts = forecast_stage(weather, horizon, specs, split, "validation", lags, max_horizon, seed)
    scores = score_forecasts(forecasts, specs)
    scores.insert(0, "candidate", list(candidates))
    best = int(np.argmin(scores["mae_deg"].to_numpy()))
    scores["selected"] = np.arange(len(scores)) == best
    return scores, candidates[best]


def run_scenario_experiment(weather_by_scenario, horizons, models, test_days=None,
                            lags=LAG_HOURS, seed=0, max_horizon=None):
    """複数のデータ（シナリオ）に同じ実験を行い、結果を1つの表にまとめる。

    weather_by_scenario は {シナリオ名: prepare_weather 済みの表} の辞書。test_days を省略すると
    年ごとに分けて3年目を最終テストにし、指定すると最後の test_days 日を最終テストにする。
    """
    tables = []
    for name, weather in weather_by_scenario.items():
        split = last_days_split(weather, test_days) if test_days else year_split(weather)
        scores = run_horizon_experiment(weather, horizons, models, split, "test", lags, max_horizon, seed)
        scores.insert(0, "scenario", name)
        tables.append(scores)
    return pd.concat(tables, ignore_index=True)
