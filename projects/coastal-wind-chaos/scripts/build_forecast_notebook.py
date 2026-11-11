"""操作パネル付きの風速・風向予報ラボを再生成する（標準ライブラリだけで実行可）。"""

import argparse
import json
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = PROJECT_DIR / "notebooks" / "coastal_wind_forecast_lab.ipynb"
SOURCE_REF = "feature/coastal-wind-colab-v1"
LAB_VERSION = "1.0.0"
REPOSITORY = "shogo-ishikawa/2026_3Q_M4Th4"
NOTEBOOK_PATH = "projects/coastal-wind-chaos/notebooks/coastal_wind_forecast_lab.ipynb"


def build(output=DEFAULT_OUTPUT, source_ref=SOURCE_REF):
    cells = []

    def cell(kind, source):
        metadata = {}
        if kind == "code":
            metadata = {"cellView": "form", "jupyter": {"source_hidden": True}}
        result = {
            "cell_type": kind,
            "id": f"forecast-{len(cells) + 1:02d}",
            "metadata": metadata,
            "source": source.strip("\n").splitlines(keepends=True),
        }
        if kind == "code":
            result.update(execution_count=None, outputs=[])
        cells.append(result)

    def md(source):
        cell("markdown", source)

    def code(source):
        cell("code", source)

    colab_url = f"https://colab.research.google.com/github/{REPOSITORY}/blob/{source_ref}/{NOTEBOOK_PATH}"
    md(f"""
# 海岸の風速・風向予報ラボ

**予報を比べる。過去に戻って確かめる。自分のモデルで先の風を予測する。**

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)]({colab_url})

学生が取り組んだ材木座海岸の予報比較を入口に、観測データと既存の気象予報を区別して検証するラボです。
初めての人は **「ランタイム」→「すべてのセルを実行」** を選び、下に現れる操作パネルで
**「デモで過去検証」→「解析を実行」** と進んでください。CPUで使えます。

| やりたいこと | 選ぶモード |
| --- | --- |
| ファイルを用意せず、予測と誤差解析を体験する | デモで過去検証 |
| 自分の地域の過去の観測から学習し、未使用期間で答え合わせする | CSVで過去検証 |
| 材木座や指定地点の、既存の気象予報を比べる | 最新予報の比較 |
| 過去のある計算回の気象予報を、観測値と比べる | 過去の気象予報の検証 |
| 利用可能な観測までで学習し、それより先の風を予測する | 将来予測 |

デモは**仮想観測点の合成データ**です。実際の材木座・辻堂・三浦の観測値や予測精度を表すものではありません。
Google Driveへの接続は任意です。全セル実行だけではファイル選択やデータ取得は始まりません。
""")

    md("""
## まず知っておきたいこと

- **風速**は風の速さで、単位は m/s です。例えば 5 m/s は1秒で5 m進む速さに相当します。
- **風向**は風が**吹いてくる側**です。北風なら北から南へ吹きます。角度では北0°、東90°、南180°、西270°です。
- 材木座には、このラボで使う現地の実測がありません。予報の比較地点は材木座、観測で答え合わせする地点は辻堂や三浦など、**観測値のある地点**として扱います。
- 「Open-Meteoの現在値」は気象モデルの値です。アメダスの実測と同じものではありません。
- 同じJMAモデルで陸・海の参照格子を変えた予報は、独立した別モデルではありません。
- 地点の位置、風速計の高さ、地形による違いも、予報と観測の差に含まれます。

最初に「何を、どこで、いつまでの情報から予測するか」を決めることが、精度の数値以上に大切です。
""")

    code(r'''
#@title 準備：必要なコードとライブラリを読み込む
import importlib
import importlib.util
import os
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

LAB_VERSION = "__LAB_VERSION__"
SOURCE_REF = "__SOURCE_REF__"
REPOSITORY_URL = "https://github.com/shogo-ishikawa/2026_3Q_M4Th4.git"
PROJECT_PATH = Path("projects/coastal-wind-chaos")
try:
    IN_COLAB = importlib.util.find_spec("google.colab") is not None
except ModuleNotFoundError:
    IN_COLAB = False


def find_local_project():
    here = Path.cwd().resolve()
    for directory in (here, *here.parents):
        for candidate in (directory, directory / PROJECT_PATH):
            if (candidate / "src/coastal_wind_chaos/wind_pipeline.py").is_file():
                return candidate
    raise FileNotFoundError("作品フォルダが見つかりません。リポジトリ内でNotebookを開いてください。")


if IN_COLAB:
    # セルを再実行したときも、以前読み込んだコードと混ざらない新しい場所に取得する。
    checkout = Path(tempfile.mkdtemp(prefix="coastal-wind-source-", dir="/content")) / "repository"
    subprocess.run(["git", "clone", "--quiet", "--depth", "1", "--branch", SOURCE_REF,
                    REPOSITORY_URL, str(checkout)], check=True)
    PROJECT_DIR = checkout / PROJECT_PATH
else:
    PROJECT_DIR = find_local_project()

required_sources = ("forecast_app", "forecast_lab", "forecast_sources", "forecast_diagnostics")
missing_sources = [name for name in required_sources
                   if not (PROJECT_DIR / "src/coastal_wind_chaos" / f"{name}.py").is_file()]
if missing_sources:
    raise RuntimeError("このNotebookに対応するコードがありません。最新の公開リンクから開き直してください。"
                       f" 不足するファイル: {', '.join(missing_sources)}")
source_version = tomllib.loads((PROJECT_DIR / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
if source_version != LAB_VERSION:
    raise RuntimeError(f"Notebook v{LAB_VERSION} と取得コード v{source_version} の版が一致しません。"
                       "最新の公開リンクからNotebookを開き直してください。")

required_packages = ("numpy", "pandas", "sklearn", "matplotlib", "requests", "ipywidgets")
missing_packages = [name for name in required_packages if importlib.util.find_spec(name) is None]
if missing_packages:
    if IN_COLAB:
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "-e",
                        f"{PROJECT_DIR}[colab]"], check=True)
    else:
        raise ImportError("不足するライブラリがあります。作品フォルダで pip install -e '.[colab]' を実行してください。"
                          f" 不足: {', '.join(missing_packages)}")

for name in list(sys.modules):
    if name == "coastal_wind_chaos" or name.startswith("coastal_wind_chaos."):
        del sys.modules[name]
sys.path.insert(0, str(PROJECT_DIR / "src"))
importlib.invalidate_caches()

from coastal_wind_chaos.forecast_app import run_analysis

RESULTS_ROOT = Path("/content/coastal-wind-results") if IN_COLAB else PROJECT_DIR / "results/forecast_lab"
RESULTS_ROOT.mkdir(parents=True, exist_ok=True)
print(f"風速・風向予報ラボ v{LAB_VERSION} の準備ができました。")
print(f"コードの版: {SOURCE_REF}")
print("下の操作パネルでモードを選び、「解析を実行」を押してください。")
'''.replace("__SOURCE_REF__", json.dumps(source_ref, ensure_ascii=False)[1:-1]).replace("__LAB_VERSION__", LAB_VERSION))

    md("""
## 操作パネル

**初回は設定を変えず、デモを実行できます。** デモでは3年分の仮想データを作り、
学習・調整・最終評価を時間順に分けます。1・3・6・12・24時間先について、
持続予報などの基準と、学習したモデルを比較します。

実データに進むときはモードを変更し、**「CSV・保存データを選ぶ」**から読み込みます。
複数年に分かれたCSVは一度に選んでください。選び直すと前の選択を置き換えます。
日時の空欄は自動設定です。手動で変えた日時は**「日時をリセット」**で空欄に戻せます。

過去の気象予報の「初期時刻」はUTCです。それ以外の入力日時と図の日時はJSTです。
JSTはUTCより9時間進んでいます。
""")

    code(r'''
#@title 操作パネルを開く
import html
import json
import shutil
from datetime import datetime
from zoneinfo import ZoneInfo

import ipywidgets as widgets
from IPython.display import HTML, Image, Markdown, clear_output, display

from coastal_wind_chaos.forecast_sources import LOCATIONS

try:
    if IN_COLAB:
        from google.colab import output as colab_output
        colab_output.enable_custom_widget_manager()
except ImportError:
    pass

STATE = {"paths": [], "result": None, "busy": False}
field_style = {"description_width": "150px"}


def field(widget_type, **kwargs):
    return widget_type(style=field_style, layout=widgets.Layout(width="100%"), **kwargs)


mode = field(widgets.Dropdown, description="やりたいこと", options=[
    ("デモで過去検証", "demo"), ("CSVで過去検証", "csv_backtest"),
    ("最新予報の比較", "latest_forecast"), ("過去の気象予報の検証", "historical_forecast"),
    ("将来予測", "future")], value="demo")
mode_help = widgets.HTML()
location = field(widgets.Dropdown, description="地点", options=[
    ("辻堂（観測所）", "tsujido"), ("三浦（観測所）", "miura"),
    ("材木座（予報比較地点）", "zaimokuza"), ("自分で指定する", "custom")], value="tsujido")
station = field(widgets.Text, description="地点名", value="辻堂")
latitude = field(widgets.BoundedFloatText, description="緯度", min=-90, max=90, value=35.3)
longitude = field(widgets.BoundedFloatText, description="経度", min=-180, max=180, value=139.5)
station_id = field(widgets.Text, description="アメダス地点番号", value="46141")
recent = field(widgets.Checkbox, description="直近のアメダスを使う", value=False, indent=False)
upload_button = widgets.Button(description="CSV・保存データを選ぶ", icon="upload", layout=widgets.Layout(width="100%"))
upload_status = widgets.HTML("ファイルはまだ選ばれていません。")
local_upload = widgets.FileUpload(accept=".csv,.zip", multiple=True, description="ファイルを選ぶ", layout=widgets.Layout(width="100%"))
local_upload.layout.display = "none" if IN_COLAB else ""

train_start = field(widgets.Text, description="学習開始（JST）", placeholder="空欄で自動。例：2023-01-01 00:00")
validation_start = field(widgets.Text, description="調整開始（JST）", placeholder="空欄で自動。例：2024-01-01 00:00")
test_start = field(widgets.Text, description="最終評価開始（JST）", placeholder="空欄で自動。例：2025-01-01 00:00")
end = field(widgets.Text, description="データ終了（JST）", placeholder="空欄で全期間。例：2025-12-31 23:00")
cutoff = field(widgets.Text, description="予測の基準（JST）", placeholder="空欄で利用可能な最新観測まで")
run_time_utc = field(widgets.Text, description="初期時刻（UTC）", placeholder="例：2026-10-01T00:00")
horizons = field(widgets.SelectMultiple, description="予測する時間先（h）", options=[1, 3, 6, 12, 24, 36, 48, 72],
                 value=(1, 3, 6, 12, 24), rows=8)
feature_set = field(widgets.Dropdown, description="入力項目", options=[
    ("季節・時刻＋過去の風", "calendar+recent"), ("過去の風だけ", "recent"),
    ("季節・時刻だけ", "calendar")], value="calendar+recent")
include_optional = field(widgets.Checkbox, description="気温・気圧・日照も使う", value=False, indent=False)
candidates = field(widgets.SelectMultiple, description="学習候補", options=[
    ("線形モデル（リッジ回帰）", "linear"), ("勾配ブースティング", "boosting_shallow")],
    value=("linear", "boosting_shallow"), rows=2)
future_method = field(widgets.Dropdown, description="将来予測のモデル", options=[
    ("線形モデル（リッジ回帰）", "linear"), ("勾配ブースティング", "boosting_shallow")], value="linear")
learning_curve = field(widgets.Checkbox, description="学習期間を変えて比べる", value=False, indent=False)
learning_months = field(widgets.SelectMultiple, description="比べる学習期間（月）", options=[3, 6, 12, 24, 36],
                        value=(3, 6, 12), rows=5)
models = field(widgets.SelectMultiple, description="既存の気象予報", options=[
    ("JMA MSM", "jma_msm"), ("ECMWF IFS 0.25°", "ecmwf_ifs025")],
    value=("jma_msm", "ecmwf_ifs025"), rows=2)
forecast_hours = field(widgets.Dropdown, description="既存予報の範囲（h）", options=[24, 48, 72], value=24)
cell_selection = field(widgets.Dropdown, description="参照する格子", options=[("陸を優先", "land"), ("海を優先", "sea")], value="land")
seed = field(widgets.IntText, description="乱数の種", value=2026)
date_reset = widgets.Button(description="日時をリセット", icon="calendar", layout=widgets.Layout(width="100%"))
reset_button = widgets.Button(description="設定を初期化", icon="refresh", layout=widgets.Layout(width="100%"))
drive_button = widgets.Button(description="Google Driveを接続", icon="folder-open", layout=widgets.Layout(width="100%"))
drive_status = widgets.HTML("Driveを使わなくても実行できます。")
run_button = widgets.Button(description="解析を実行", icon="play", button_style="primary", layout=widgets.Layout(width="100%", height="44px"))
download_button = widgets.Button(description="結果ZIPをダウンロード", icon="download", disabled=True, layout=widgets.Layout(width="100%"))
status = widgets.HTML("準備できました。「解析を実行」を押してください。")
results = widgets.Output(layout=widgets.Layout(width="100%"))
messages = widgets.Output(layout=widgets.Layout(width="100%"))

dates_box = widgets.VBox([train_start, validation_start, test_start, end])
learning_curve_box = widgets.VBox([learning_curve, learning_months,
    widgets.HTML("追加実験です。同じ最終評価期間を保ち、学習に使う期間の長さを変えます。計算回数が増えます。")])
learning_box = widgets.VBox([horizons, feature_set, include_optional, candidates, future_method, learning_curve_box, seed])
nwp_box = widgets.VBox([models, forecast_hours, cell_selection])
observation_box = widgets.VBox([recent, upload_button, local_upload, upload_status])
location_box = widgets.VBox([location, station, latitude, longitude, station_id])

MODE_HELP = {
    "demo": "<b>デモ：</b>仮想観測点の合成データ3年分で、過去検証と誤差解析を体験します。実測の結果ではありません。地点・ファイルは使いません。",
    "csv_backtest": "<b>CSVで過去検証：</b>同じ観測所の時別CSVを読み込み、学習→調整→最終評価の順に進めます。必要な場合は日時を変更してください。",
    "latest_forecast": "<b>最新予報：</b>指定地点の既存の気象モデルを比較します。まだ先の観測はないため、その場で未来の予報の精度は採点できません。",
    "historical_forecast": "<b>過去の気象予報：</b>UTCの初期時刻を指定した計算回を取り出し、同じ地点・対象時刻の観測CSVと照合します。初期時刻と実際に公開された時刻は異なります。",
    "future": "<b>将来予測：</b>観測CSV（または直近のアメダス）を使い、基準時刻までの情報から先の風を予測します。学習には十分な期間の観測CSVが必要です。未来の精度はまだ採点できません。",
}


def invalidate_result(*_):
    if STATE["busy"]:
        return
    STATE["result"] = None
    download_button.disabled = True
    results.clear_output()
    status.value = "設定が変わりました。「解析を実行」で結果を更新してください。"


def update_location(change=None):
    if location.value == "custom":
        station.disabled = latitude.disabled = longitude.disabled = station_id.disabled = False
    else:
        info = LOCATIONS[location.value]
        station.value = str(info.get("name", info.get("station", location.label.split("（")[0])))
        latitude.value = float(info.get("latitude", info.get("lat", latitude.value)))
        longitude.value = float(info.get("longitude", info.get("lon", longitude.value)))
        station_id.value = str(info.get("station_id", "") or "")
        station.disabled = latitude.disabled = longitude.disabled = station_id.disabled = True
    invalidate_result()


def update_mode(change=None):
    selected = mode.value
    mode_help.value = MODE_HELP[selected]
    learning_box.layout.display = "" if selected in ("demo", "csv_backtest", "future") else "none"
    dates_box.layout.display = "" if selected in ("demo", "csv_backtest", "future") else "none"
    for widget in (validation_start, test_start, end):
        widget.layout.display = "none" if selected == "future" else ""
    candidates.layout.display = "none" if selected == "future" else ""
    future_method.layout.display = "" if selected == "future" else "none"
    learning_curve_box.layout.display = "" if selected in ("demo", "csv_backtest") else "none"
    learning_months.disabled = not learning_curve.value
    nwp_box.layout.display = "" if selected in ("latest_forecast", "historical_forecast") else "none"
    observation_box.layout.display = "none" if selected == "demo" else ""
    location_box.layout.display = "none" if selected == "demo" else ""
    recent.layout.display = "" if selected in ("future", "latest_forecast") else "none"
    run_time_utc.layout.display = "" if selected == "historical_forecast" else "none"
    cutoff.layout.display = "" if selected == "future" else "none"
    upload_button.layout.display = "none" if selected == "latest_forecast" and recent.value else ""
    invalidate_result()


def store_uploads(uploaded):
    """選び直したファイルだけを使い、以前の選択と混ぜない。"""
    STATE["paths"] = []
    upload_status.value = "新しく選んだファイルを確認しています。"
    invalidate_result()
    destination = Path(tempfile.mkdtemp(prefix="wind-input-"))
    paths = []
    for filename, payload in uploaded.items():
        name = Path(filename.replace("\\", "/")).name
        if not name or Path(name).suffix.lower() not in (".csv", ".zip"):
            raise ValueError("時別の観測CSV、またはこのラボで保存したZIPを選んでください。")
        path = destination / name
        if path.exists():
            raise ValueError("同じ名前のファイルがあります。名前を変えて選び直してください。")
        path.write_bytes(bytes(payload))
        paths.append(str(path))
    STATE["paths"] = paths
    names = "、".join(html.escape(Path(path).name) for path in paths)
    upload_status.value = f"使用するファイル：{names}" if paths else "ファイルは選ばれていません。"
    invalidate_result()


def choose_files(_):
    with messages:
        clear_output()
        if IN_COLAB:
            from google.colab import files
            try:
                uploaded = files.upload()
                if uploaded:
                    store_uploads(uploaded)
            except Exception as error:
                print(f"ファイルの読み込みに失敗しました：{error}")
        else:
            print("下の「ファイルを選ぶ」からCSV・ZIPを選んでください。")


def receive_local_upload(change):
    value = change["new"]
    if not value:
        return
    if isinstance(value, dict):
        uploaded = {name: item["content"] for name, item in value.items()}
    else:
        uploaded = {item["name"]: item["content"] for item in value}
    try:
        store_uploads(uploaded)
    except Exception as error:
        with messages:
            clear_output()
            print(f"ファイルの読み込みに失敗しました：{error}")


def reset_dates(_=None):
    for widget in (train_start, validation_start, test_start, end, cutoff, run_time_utc):
        widget.value = ""


def reset_settings(_):
    reset_dates()
    mode.value = "demo"
    location.value = "tsujido"
    horizons.value = (1, 3, 6, 12, 24)
    feature_set.value = "calendar+recent"
    include_optional.value = False
    candidates.value = ("linear", "boosting_shallow")
    future_method.value = "linear"
    learning_curve.value = False
    learning_months.value = (3, 6, 12)
    models.value = ("jma_msm", "ecmwf_ifs025")
    forecast_hours.value = 24
    cell_selection.value = "land"
    seed.value = 2026
    recent.value = False
    STATE["paths"] = []
    upload_status.value = "ファイルはまだ選ばれていません。"
    local_upload.value = ()
    update_location()
    update_mode()


def connect_drive(_):
    with messages:
        clear_output()
        if not IN_COLAB:
            print("手元の環境では、結果ZIPを保存してください。Driveへの接続はColabで使えます。")
            return
        try:
            from google.colab import drive
            drive.mount("/content/drive")
            STATE["drive_dir"] = Path("/content/drive/MyDrive/CoastalWindLab")
            STATE["drive_dir"].mkdir(parents=True, exist_ok=True)
            drive_status.value = "接続しました。以降の結果ZIPを MyDrive/CoastalWindLab にも保存します。"
        except Exception as error:
            print(f"Driveに接続できませんでした：{error}。接続せずに解析を続けられます。")


def selected_options():
    options = {
        "station": station.value.strip(), "latitude": latitude.value, "longitude": longitude.value,
        "station_id": station_id.value.strip() or None,
        "horizons": list(horizons.value), "candidates": list(candidates.value),
        "feature_set": feature_set.value, "include_optional": include_optional.value,
        "seed": seed.value, "models": list(models.value), "hours": forecast_hours.value,
        "cell_selection": cell_selection.value, "use_recent_observations": recent.value,
    }
    if mode.value in ("demo", "csv_backtest"):
        for name, widget in (("train_start", train_start), ("validation_start", validation_start),
                             ("test_start", test_start), ("end", end)):
            options[name] = widget.value.strip() or None
        options["learning_curve_months"] = list(learning_months.value) if learning_curve.value else []
    if mode.value == "historical_forecast":
        options["run_time_utc"] = run_time_utc.value.strip()
    if mode.value == "future":
        options["cutoff"] = cutoff.value.strip() or None
        options["train_start"] = train_start.value.strip() or None
        options["selected_methods"] = {horizon: future_method.value for horizon in horizons.value}
    return options


TABLE_LABELS = {
    "model": "予測方法", "station": "地点", "horizon_h": "何時間先（h）",
    "speed_mae_ms": "風速MAE（m/s）", "speed_rmse_ms": "風速RMSE（m/s）",
    "speed_bias_ms": "風速の偏り（m/s）", "direction_mae_deg": "風向MAE（°）",
    "within_45_pct": "風向45°以内（%）", "vector_rmse_ms": "風ベクトルRMSE（m/s）",
    "n": "評価件数", "n_evaluated": "評価件数", "n_speed": "風速の評価件数",
    "n_excluded": "除外件数", "n_direction": "風向の評価件数",
    "n_rows": "対象行数", "n_vector": "風ベクトルの評価件数",
    "n_missing_observation": "観測欠測", "n_missing_prediction": "予測欠測",
    "n_calm": "静穏の観測", "n_undefined_direction": "予測風向が未定義",
    "issue_time": "予測の基準時刻（JST）", "target_time": "対象時刻（JST）",
    "predicted_speed_ms": "予測風速（m/s）", "observed_speed_ms": "観測風速（m/s）",
    "skill_pct": "持続予報からの改善率（%）",
    "speed_skill_pct": "持続予報からの改善率（%）",
    "ci_low_pct": "改善率95%区間の下端", "ci_high_pct": "改善率95%区間の上端",
    "baseline": "比較の基準", "model_mae_ms": "同じ組でのMAE（m/s）",
    "baseline_mae_ms": "基準のMAE（m/s）", "n_pairs": "比較した組数",
    "n_days": "比較した日数", "n_bootstrap": "再抽出回数", "status": "判定状況",
    "month": "対象月", "hour": "対象時刻（時）", "direction": "観測風向",
    "speed_band": "観測風速帯（m/s）",
    "predicted_direction_deg": "予測風向（°）", "observed_direction_deg": "観測風向（°）",
    "excluded": "除外の理由",
}

MODEL_LABELS = {"persistence": "持続予報", "persistence_24h": "前日同時刻の風",
                "climatology": "季節・時刻の平均の風", "linear": "線形モデル",
                "boosting_shallow": "勾配ブースティング", "boosting": "勾配ブースティング",
                "jma_msm": "JMA MSM", "ecmwf_ifs025": "ECMWF IFS 0.25°"}
FEATURE_LABELS = {"calendar": "季節・時刻", "recent": "過去の風", "calendar+recent": "季節・時刻＋過去の風"}


def model_name(value):
    method, separator, features = str(value).partition(":")
    label = MODEL_LABELS.get(method, method)
    return f"{label}（{FEATURE_LABELS.get(features, features)}）" if separator else label


def show_table(table, limit=30):
    if table is not None and hasattr(table, "empty") and not table.empty:
        shown = table.head(limit).copy()
        for column in ("model", "baseline"):
            if column in shown.columns:
                shown[column] = shown[column].map(model_name)
        if "status" in shown.columns:
            labels = {"ok": "比較可能", "no_paired_data": "照合できる組がありません",
                      "zero_baseline_error": "基準の誤差が0のため比率は未定義", "too_few_days": "比較日数が不足"}
            shown["status"] = shown["status"].map(lambda value: labels.get(value, value))
        display(shown.rename(columns=TABLE_LABELS))


def render_result(result):
    metadata = result.get("metadata", {})
    display(Markdown("### 解析結果"))
    for message in metadata.get("messages", []):
        display(HTML(f"<p>{html.escape(str(message))}</p>"))
    if mode.value == "demo":
        display(HTML("<p><b>仮想観測点の合成データによる結果です。</b>実際の地点の精度ではありません。</p>"))
    show_table(result.get("summary"))
    summary = result.get("summary")
    no_observations = summary is None or getattr(summary, "empty", False)
    if summary is not None and not getattr(summary, "empty", True):
        counts = [name for name in ("n_speed", "n_evaluated", "n") if name in summary.columns]
        if counts:
            no_observations = summary[counts[0]].fillna(0).sum() == 0
    if no_observations:
        display(Markdown("まだ照合できる観測値がありません。予報は保存できますが、未来の精度は未評価です。"))
    show_table(result.get("skill"))
    predictions = result.get("predictions")
    if predictions is not None and not predictions.empty:
        shown = [name for name in ("station", "model", "issue_time", "target_time", "horizon_h",
                 "predicted_speed_ms", "observed_speed_ms", "predicted_direction_deg", "observed_direction_deg",
                 "excluded") if name in predictions.columns]
        display(Markdown("**予測の一部（先頭12行）**"))
        show_table(predictions[shown], limit=12)
    details = widgets.Output()
    with details:
        display(Markdown("**解析条件・データの出所**"))
        print(json.dumps(metadata, ensure_ascii=False, indent=2, default=str))
        grouped = result.get("grouped", {})
        if isinstance(grouped, dict):
            for name, table in grouped.items():
                display(Markdown(f"**条件別の誤差：{name}**"))
                show_table(table)
    accordion = widgets.Accordion(children=[details])
    accordion.set_title(0, "解析条件と、条件別の誤差表を開く")
    accordion.selected_index = None
    display(accordion)
    for figure in result.get("figures", []):
        path = Path(figure)
        if path.is_file():
            display(Image(filename=str(path)))


def run_clicked(_=None):
    if STATE["busy"]:
        return
    STATE["busy"] = True
    STATE["result"] = None
    run_button.disabled = True
    download_button.disabled = True
    status.value = "解析しています。完了するまでお待ちください。"
    stamp = datetime.now(ZoneInfo("Asia/Tokyo")).strftime("%Y%m%d-%H%M%S-%f")
    output_dir = RESULTS_ROOT / f"{mode.value}-{stamp}"
    try:
        with results:
            clear_output(wait=True)
            result = run_analysis(mode=mode.value, observation_paths=list(STATE["paths"]),
                                  options=selected_options(), output_dir=output_dir)
            render_result(result)
        STATE["result"] = result
        bundle = Path(result["zip_path"])
        download_button.disabled = not bundle.is_file()
        if STATE.get("drive_dir") and bundle.is_file():
            shutil.copy2(bundle, STATE["drive_dir"] / f"{stamp}-{bundle.name}")
        status.value = "完了しました。グラフを確認し、結果ZIPを保存してください。"
    except Exception as error:
        status.value = "解析が完了していません。入力と日時を確認して、もう一度実行してください。"
        with results:
            clear_output(wait=True)
            display(HTML(f"<p><b>確認が必要です：</b>{html.escape(str(error))}</p>"))
            display(Markdown("CSVで過去検証する場合は、同じ観測所の**時別値**を選び、学習・調整・評価の順序を確認してください。"
                             " 通信に失敗した場合は、しばらくしてから再実行できます。"))
    finally:
        STATE["busy"] = False
        run_button.disabled = False


def download_clicked(_):
    result = STATE.get("result")
    if not result:
        return
    path = Path(result["zip_path"])
    if IN_COLAB:
        from google.colab import files
        files.download(str(path))
    else:
        from IPython.display import FileLink
        with messages:
            clear_output()
            display(FileLink(str(path)))


mode.observe(update_mode, names="value")
location.observe(update_location, names="value")
recent.observe(update_mode, names="value")
learning_curve.observe(update_mode, names="value")
for control in (station, latitude, longitude, station_id, train_start, validation_start, test_start, end,
                cutoff, run_time_utc, horizons, feature_set, include_optional, candidates, future_method, learning_months, models,
                forecast_hours, cell_selection, seed):
    control.observe(invalidate_result, names="value")
upload_button.on_click(choose_files)
local_upload.observe(receive_local_upload, names="value")
date_reset.on_click(reset_dates)
reset_button.on_click(reset_settings)
drive_button.on_click(connect_drive)
run_button.on_click(run_clicked)
download_button.on_click(download_clicked)
update_location()
update_mode()

header = widgets.HTML("<div style='padding:16px;border-left:5px solid #2563eb;background:#eff6ff;color:#15324f'>"
                      "<b style='font-size:20px'>風の予測を、確かめよう。</b><br>"
                      "まずはデモで、観測と予測がどのくらい違うか見てみましょう。</div>")
settings_panel = widgets.Accordion(children=[
    widgets.VBox([location_box, observation_box]),
    widgets.VBox([dates_box, cutoff, run_time_utc, date_reset]),
    widgets.VBox([learning_box, nwp_box]),
    widgets.VBox([drive_button, drive_status, reset_button]),
])
for number, title in enumerate(("地点と入力データ", "使う期間と予測の基準時刻", "予測方法と時間先", "保存と設定の初期化")):
    settings_panel.set_title(number, title)
settings_panel.selected_index = None
display(widgets.VBox([header, mode, mode_help, settings_panel, run_button, status,
                      download_button, messages, results], layout=widgets.Layout(width="100%")))
''')

    md("""
## 結果の読み方：誤差を一つの数字で終わらせない

| 指標・図 | 読み方 |
| --- | --- |
| 風速MAE（平均絶対誤差） | 風速が平均して何 m/s ずれたか。小さいほどよい値です。例えば1 m/sなら平均的なずれの大きさが1 m/sです。 |
| 風速RMSE | 大きな外れをより強く反映します。MAEよりかなり大きければ、一部の大きな失敗にも目を向けます。 |
| 風速の偏り（予測−観測） | 正なら強く予測する傾向、負なら弱く予測する傾向。正負が打ち消し合うので、0に近くてもMAEが小さいとは限りません。 |
| 風向MAE | 北359°と北1°の違いは2°として数えます。静穏で向きが定まらない観測は、風向の採点から除外します。 |
| 持続予報からの改善率 | 「今と同じ風が続く」予測と、同じ時刻の組で比べます。正なら改善、負なら悪化です。基準の誤差が0なら比率は定義できません。 |
| 改善率の95%区間 | 日ごとのまとまりを保った再抽出で、結果のばらつきを見ます。区間が0をまたぐ場合は、改善が安定しているとは言い切れません。 |
| 時系列と散布図 | 風が強まる時刻がずれたか、強風を弱めに予測していないかを確かめます。 |
| 時間先・月・時刻・風向・風速帯別の誤差 | 「夏の昼だけ得意」「強風で外れる」など、全体平均に隠れた違いを調べます。必ず評価件数も見ます。 |

72時間先まで計算できても、実用的な精度があるとは限りません。単純な基準予報との比較がものさしです。
誤差が大きくなったことだけでは、カオスによる物理的な予測限界を測ったことにはなりません。
""")

    md("""
## 自分の地域の観測データで使う

1. [気象庁「過去の気象データ・ダウンロード」](https://www.data.jma.go.jp/risk/obsdl/)を開きます。
2. **1つの観測所**を選び、**時別値**の風速・風向を選びます。品質情報・均質番号も付けて保存してください。
3. 標準は3年分です。最初の1年で学習、次の1年で設定を調整、最後の1年で評価します。
   5年分なら、最初の3年・次の1年・最後の1年になるよう、調整開始・最終評価開始を指定できます。
4. 長い期間は年ごとに分けてダウンロードし、**同じ地点のCSVをまとめて選択**します。
5. 「CSVで過去検証」を選び、日時の空欄は自動のまま実行します。短期間なら各期間を自分で設定してください。

気温・気圧・日照を追加するときは、観測所や年代によって利用できる項目が違う点に注意します。
品質の悪い値や欠測を無理に埋めず、使えなかった件数を記録します。観測所の移転や測器の変更も、
長期間の傾向を解釈するときに確認してください。

学習に使ったデータを、そのまま最終評価に使うと実力を高く見積もります。
設定を変えたときは調整期間で比べ、最終評価期間は設定を選び終えた後の確認に残します。
""")

    md("""
## 「いつの予報か」を確かめる

**予測の基準時刻**と**予測対象の時刻**を分けます。観測からの予測で、10時までの風を入力して
13時の風を予測するなら、3時間先の予測です。将来の13時の観測は答え合わせにだけ使います。
CSVに新しい観測が入っていなければ、予測の基準も古い時刻になります。「今の予測」とは呼びません。

既存の気象予報では、次の3つの時刻が異なることがあります。

- **初期時刻**：気象モデルが計算の出発点とする時刻。
- **公開・利用可能時刻**：計算が終わり、その予報を実際に使えるようになった時刻。
- **取得時刻**：このColabがデータを受け取った時刻。

「過去の気象予報の検証」は個々の計算回を使います。利用できる過去の範囲はモデルによって違い、
すべてのモデルで何年分も同じように取得できるわけではありません。
初期時刻から3時間先の精度と、「その時点で実際に入手できた情報による3時間先予測」は別の評価です。
再解析データや、異なる計算回をつないだ系列を、当時の短時間先予報として扱いません。

最新予報の初回取得では、未来の観測がないため照合0件でも正常です。
予報を保存して対象時刻後の観測と比べて初めて、その予報を評価できます。
""")

    md("""
## 保存・再開と、次の実験

解析が終わったら**「結果ZIPをダウンロード」**を押してください。予測・誤差の表、図、解析条件を
まとめて保存します。保存データを読み直す際は「CSV・保存データを選ぶ」を使います。
Driveを接続した場合は `MyDrive/CoastalWindLab` にも結果ZIPを保存します。
Driveへの接続を途中でやめても、手元にZIPを保存して続けられます。

一度に変える条件は1つにすると、違いの理由を考えやすくなります。

- 予測する時間先を延ばすと、持続予報と学習モデルの差はどう変わりますか。
- 「過去の風だけ」と「季節・時刻だけ」では、どの時間先で得意不得意が違いますか。
- 気温・気圧・日照を追加すると、どの月や時刻で改善しますか。
- 同じ最終評価期間を使い、学習期間を延ばすと改善しますか。
- 少数の強風だけで結論を決めず、件数と日ごとのばらつきも確かめてください。

以下は任意のPython練習です。解析後に `STATE["result"]` の表を取り出し、
`horizon_h`（何時間先）で行を絞り込みます。操作パネルの結果も、同じPythonの表から作っています。
""")

    code(r'''
#@title 任意のPython練習：3時間先の予測を取り出す
if STATE.get("result") is not None:
    predictions = STATE["result"]["predictions"]
    three_hours = predictions[predictions["horizon_h"] == 3]
    display(three_hours.head())
else:
    print("操作パネルで解析すると、ここから表を取り出せます。")
''')

    md("""
## データの出所

- 観測：気象庁の[過去の気象データ](https://www.data.jma.go.jp/risk/obsdl/)・[アメダス](https://www.jma.go.jp/bosai/amedas/)。
- 既存の気象予報：[Open-Meteo](https://open-meteo.com/)経由のJMA・ECMWFモデル。
  予報の系列や条件を出力に記録します。
- デモ：この教材が生成した仮想データ。現地観測でも、気象庁の予報でもありません。

風向の変換、機械学習、予測可能性をさらに学ぶ場合は、同じプロジェクトの
`coastal_wind_hands_on.ipynb` にある発展教材も使えます。
""")

    notebook = {
        "cells": cells,
        "metadata": {
            "colab": {"name": "海岸の風速・風向予報ラボ.ipynb", "provenance": []},
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3.11"},
            "coastal_wind_lab": {"version": LAB_VERSION, "source_ref": source_ref},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(notebook, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--ref", default=SOURCE_REF, help="Notebookと取得コードが参照するGitのブランチ")
    arguments = parser.parse_args()
    print(build(arguments.output, source_ref=arguments.ref))
