"""教材の Notebook（notebooks/coastal_wind_hands_on.ipynb）を作り直すスクリプト（作る人・直す人向け）。

Notebook を直すときは、このファイルを直してから実行します。セルのIDを固定しているので、
同じ内容なら同じファイルになります（tests/test_notebook.py で確かめます）。

作品フォルダで実行する例：
    python scripts/build_notebook.py
    python scripts/build_notebook.py --output /tmp/check.ipynb

nbformat が必要です（pip install -e ".[notebook]"）。
"""

import argparse
from pathlib import Path

import nbformat

PROJECT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = PROJECT_DIR / "notebooks" / "coastal_wind_hands_on.ipynb"

# main に取り込んだ後は、BRANCH を "main" に変える（Colab のリンクと、Notebook の中の取得先が変わる）
REPOSITORY = "shogo-ishikawa/2026_3Q_M4Th4"
BRANCH = "claude/ecstatic-dirac-af710c"
NOTEBOOK_IN_REPOSITORY = "projects/coastal-wind-chaos/notebooks/coastal_wind_hands_on.ipynb"
COLAB_URL = f"https://colab.research.google.com/github/{REPOSITORY}/blob/{BRANCH}/{NOTEBOOK_IN_REPOSITORY}"

CELLS = []


def md(text):
    CELLS.append(nbformat.v4.new_markdown_cell(text.strip("\n")))


def code(text):
    CELLS.append(nbformat.v4.new_code_cell(text.strip("\n")))


def answer(question, hint, solution):
    """問い・ヒント・解答例のセル（ヒントと解答例は折りたたむ）。"""
    md(f"""
**問い**　{question}

<details><summary>ヒント</summary>

{hint}

</details>

<details><summary>解答例</summary>

{solution}

</details>
""")


md("""
# 海辺の風は何時間先まで予測できるか
## ――機械学習とカオスから考える予測可能性（ハンズオン）

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](COLAB_URL)

このリンクと、下の「0. 準備」の `BRANCH` は、どちらも作業ブランチ `BRANCH_NAME` の同じ版を指しています。作品が main に取り込まれた後は、どちらも main に変えます。

### この教材で学ぶこと

1. 風向きには0°と360°の境目があり、ふつうの数とは扱いが違うこと
2. 単純な予報（基準予報）を「ものさし」にして、機械学習の効果を評価すること
3. 季節・日周期の情報と、過去・直近の観測情報の役割の違い
4. 予測時間を延ばすと、精度がどう変わるか
5. 予測が外れる原因（入力の不足、モデルの不足、観測誤差、カオス）を区別する考え方
6. 合成データで学んだ方法を、自分の地元の気象庁データに使う方法

### 実験は2種類で、別のもの

- **実験1〜3：風向きの予測**　合成データ（またはあなたの地点の観測データ）で、与えた入力・モデル・学習期間・評価指標のもとでの**実用的な予測性能**を調べます。
- **実験4：ローレンツ系の初期値鋭敏性（カオス）**　簡単な方程式で、初期値のわずかな違いが広がる様子を調べます。

実験1〜3で誤差が増えることを見ても、それだけで「カオスの壁を見つけた」「この地点の物理的な予測限界は何時間だ」とは言えません。2種類の実験は、考え方を比べるために並べています。

### 進め方

「データを見る → 持続予報 → 角度の罠 → 3時間先を一度学習 → 特徴量の比較 → 予測時間の比較 → 地元の実データ → ローレンツ実験」の順に進みます。各節には次のものがあります。

- **予想**：実行する前に、結果を予想してメモする
- **短いコード**：大事な処理を数行で確かめる
- **1か所の改造**：設定を1つだけ変えて、もう一度実行する
- **問い**：結果を説明する（ヒントと解答例は折りたたみの中）

データは、南側に海がある**仮想観測点の合成データ**です。気象庁の観測値ではありません。
""".replace("COLAB_URL", COLAB_URL).replace("BRANCH_NAME", BRANCH))

md("""
## 0. 準備

Google Colab では、次のセルがリポジトリを `/content/2026_3Q_M4Th4-（ブランチ名の / を - にした名前）/` に取得し、この作品のフォルダ `projects/coastal-wind-chaos/` を作業ディレクトリにします。ブランチごとに別のフォルダに取得するので、`BRANCH` を変えて実行し直しても、前に取得した内容と混ざりません。手元のパソコンでリポジトリの中から開いた場合は、取得せずにそのフォルダを使います。このNotebookの中の相対パス（`data/…` など）は、すべて作品フォルダが基準です。
""")

code("""
import os
import subprocess
import sys
from pathlib import Path

REPOSITORY_URL = "https://github.com/shogo-ishikawa/2026_3Q_M4Th4.git"
BRANCH = "BRANCH_NAME"  # 作品が main に取り込まれた後は "main" に変える
PROJECT = Path("projects/coastal-wind-chaos")
IN_COLAB = "google.colab" in sys.modules


def clone_in_colab():
    \"\"\"Colab で BRANCH のリポジトリを取得し、作品フォルダを返す（ブランチごとに別のフォルダ）。\"\"\"
    clone = Path("/content") / ("2026_3Q_M4Th4-" + BRANCH.replace("/", "-"))
    if not clone.exists():  # 取得済みなら取得し直さない（書き換えたファイルを残すため）
        subprocess.run(["git", "clone", "--depth", "1", "--branch", BRANCH, REPOSITORY_URL, str(clone)],
                       check=True)
    if not (clone / PROJECT).exists():
        raise FileNotFoundError(f"{BRANCH} ブランチに {PROJECT} がありません。"
                                "BRANCH を作品のあるブランチ名に変えて、このセルを実行し直してください。")
    return clone / PROJECT


def find_project_dir():
    \"\"\"作品フォルダを探す。手元では、今のフォルダとその上のフォルダから探す。\"\"\"
    if IN_COLAB:
        return clone_in_colab()
    here = Path.cwd().resolve()
    for folder in [here, *here.parents]:
        if (folder / "src" / "coastal_wind_chaos").exists():
            return folder
        if (folder / PROJECT / "src" / "coastal_wind_chaos").exists():
            return folder / PROJECT
    raise FileNotFoundError("作品フォルダが見つかりません。リポジトリの中でこのNotebookを開いてください。")


PROJECT_DIR = find_project_dir()
os.chdir(PROJECT_DIR)
print("作業ディレクトリ:", Path.cwd())
""".replace("BRANCH_NAME", BRANCH))

code("""
# Colab では、この作品のパッケージ（と足りない依存ライブラリ）を入れる。
# 手元では、README の手順（pip install -e .）で入れておく。
if IN_COLAB:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-e", "."], check=True)
sys.path.insert(0, str(PROJECT_DIR / "src"))  # インストール直後でも読み込めるようにする

from coastal_wind_chaos import environment_info

environment_info(PROJECT_DIR)  # 使ったPython・ライブラリの版とコミットを記録しておく
""")

code("""
import math

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from coastal_wind_chaos import experiments as ex
from coastal_wind_chaos import lorenz_demo, plotting, sample_data
from coastal_wind_chaos import wind_pipeline as wp

LANGUAGE = plotting.apply_style()  # 日本語フォントがあれば図を日本語に、なければ理由を表示して英語にする
pd.set_option("display.precision", 1)
SCORE_COLUMNS = ["model", "mae_deg", "within_45_pct", "vector_rmse_ms", "n_test", "n_undefined", "undefined_pct"]
""")

md("""
図の文字は、日本語フォントが見つかれば日本語、見つからなければ英語になります（上のセルの表示を見てください）。Colab の最初の状態には日本語フォントがない（Google が公開している環境情報による）ので、英語になります。日本語にしたいときは、次のセルの `#` を外して実行してください（フォントの取得に数十秒かかります）。
""")

code("""
# 図を日本語にしたいときだけ、次の2行の先頭の # を外して実行する（Colab 用）
# subprocess.run(["apt-get", "-qq", "install", "-y", "fonts-noto-cjk"], check=True)
# LANGUAGE = plotting.apply_style()
""")

md("""
## 1. データを見る

仮想観測点は「南側に海、北側に陸」という設定です。日中は南の海から吹く**海風**、夜は北の陸から吹く**陸風**になるようにしています。実際の海岸では、海の向きや地形によって風向が変わるので、どこでも同じ向きになるわけではありません。

合成データは、次の成分を**風の東向き成分 u と北向き成分 v ごとに足し合わせて**作ります（角度どうしは足しません）。

| 成分 | 内容 |
| --- | --- |
| 周期成分 | 季節風（冬は北西寄り、夏は南東寄り）、海風・陸風（日周期）、気温・気圧の季節変化と日変化 |
| 背景成分 | 数日かけてゆっくり変わる確率的な変動（高気圧・低気圧の通過の代わり） |
| 不規則成分 | 1時間前の状態と相関する確率的な変動（AR(1)過程） |
| 前線通過 | ランダムな時刻に来て、風向の急変・気温の低下を起こす（既定では、通過の12時間前から南西寄りの風が強まり、気圧が下がる「予兆」つき） |
| 観測 | 観測誤差、16方位への丸め、静穏（0.2 m/s以下）、まれな欠測 |

これは簡単な式と乱数で作った「現象のモデル」で、大気の流れを物理法則で計算する数値予報ではありません。乱数の種（`seed`）が同じなら、同じデータになります。
""")

code("""
DATA_PATH = Path("data/sample_coastal_amedas.csv")
TRUTH_PATH = Path("data/sample_coastal_truth.csv")  # 観測誤差のない「真の状態」（教材用）

settings = sample_data.generate_sample_csv(DATA_PATH, preset="default", truth_path=TRUTH_PATH, seed=2026)
settings
""")

md("""
保存したCSVは、気象庁「過去の気象データ・ダウンロード」のファイルと同じ見出しの構造です（文字コードは Shift_JIS）。先頭の数行を見てみましょう。
""")

code("""
lines = DATA_PATH.read_bytes().decode("cp932").splitlines()
for line in lines[:8]:
    print(line[:110])
""")

md("""
- 1行目：本物では「ダウンロードした時刻」です。合成データでは、合成データであることと、作ったときの設定を書いています。
- 3行目：地点名、4行目：要素名、5行目：「風速(m/s)」の下にある「風向」、6行目：品質情報・均質番号・現象なし情報
- 7行目から：1時間ごとのデータ

**時刻の意味**：日本標準時です。各行の時刻は、その行の値が表す1時間の終わりの時刻です。例えば「2023/1/1 1:00:00」の行の日照時間は、0時から1時までの合計です。風向・風速は時刻の直前10分間の平均、気温と気圧はその時刻の値です。1日は1時から始まり、24時は翌日の「00:00:00」と書かれます。

**品質情報**：既定では正常値（品質情報8）だけを使います。準正常値（5）も使うときは、`MIN_QUALITY = 5` のように明示します。
""")

code("""
MIN_QUALITY = 8  # 8 = 正常値だけ（既定）。準正常値も使うなら 5
raw = wp.read_jma_csv(DATA_PATH)
weather = wp.prepare_weather(raw, min_quality=MIN_QUALITY)  # 品質の確認、16方位→角度、静穏、u と v、1時間刻みへの整列
wp.summarise_weather(weather)
""")

md("""
**予想**　この地点（南が海、北が陸）では、昼と夜で風向はどう違うと思いますか？　メモしてから、次の2つのセルを実行しましょう。
""")

code("""
plotting.plot_direction_timeseries(weather, "2024-07-01", days=7)
plt.show()
plotting.plot_direction_timeseries(weather, "2024-01-08", days=7)
plt.show()
""")

code("""
plotting.plot_direction_by_hour(weather)  # 3年分をまとめた「時刻ごとの風向の割合」
plt.show()
""")

md("""
風向は点で描いています。線で結ぶと、北風のたびに0°と360°の間を縦に飛ぶ線になってしまうからです。下の図の北（N）は、一番下と一番上の両方に近い位置です（N と NNW は隣どうし）。
""")

answer(
    "昼と夜の風向の違いと、夕方の向きの変わり方を、図から説明してください。",
    "時刻ごとの図で、12〜16時ごろと夜中に色が濃い方位を探しましょう。夕方（16〜20時）に、濃い所がどの順に動くかも見ます。",
    "昼（12〜16時ごろ）は南〜南南東から、夜は北西〜北から吹くことが多く、夕方には西寄りを経て向きが時計回りに変わります。"
    "この仮想地点に与えた設定どおりの海風・陸風です。季節風や数日規模の変動、前線が重なるため、毎日同じになるわけではありません。",
)

md("""
**1か所の改造**　上の `plot_direction_timeseries` の日付 `"2024-07-01"` を、春の `"2024-04-01"` や秋の `"2024-10-01"` に変えて、もう一度実行してみましょう。季節風の向きと、海風・陸風の入れ替わりの見え方は、夏・冬とどう違うでしょうか。
""")

md("""
## 2. 持続予報：予報の「ものさし」と時間の分け方

ある時刻 t（**予測起点**：予報を出す時刻）までの観測だけを使って、h 時間後の**対象時刻** t + h の風向を予報します。毎時、新しい観測を受け取って予報を出し直す場面を考えます。t から t + h までの途中の観測は、その予報には使いません（まだ観測されていないからです）。

機械学習が役に立つかどうかは、単純な予報（**基準予報**）と比べないと分かりません。この教材では3つの基準予報を使います。

- **持続予報**：「t の風がそのまま続く」と予報する
- **気候値予報**：学習期間の「同じ月・同じ時刻の平均の風」を予報にする
- **24時間周期の持続予報**：t 以前で対象時刻と同じ時刻の観測（t + h − 24 × ⌈h/24⌉）をそのまま予報にする（「直近の観測済みの24時間が繰り返す」と考える）

**時間の分け方**：3年分のデータを、**1年目＝学習、2年目＝検証、3年目＝最終テスト**に分けます。ランダムには分けません。手法や設定を選ぶのは検証期間の成績で行い、最終テスト期間は最後の成績表にだけ使います。対象時刻が次の期間に入る行（例：学習期間の終わり近くの予測起点で、答えが検証期間にある行）は使いません。また、どの予測時間でも同じ予測起点で比べるため、72時間先まで同じ期間に収まる予測起点だけを評価します。
""")

code("""
split = wp.make_split(weather)  # "years"：1年目学習・2年目検証・3年目最終テスト
print(split)
plotting.plot_time_split(weather, split, max_horizon=wp.COMMON_MAX_HORIZON)  # 濃い部分は評価に使わない最後の72時間
plt.show()
""")

md("""
**短いコード：持続予報を手で確かめる**　3時間先の持続予報は「予測起点 t の風向」です。対象時刻の観測と比べてみましょう。
""")

code("""
h = 3
t = pd.Timestamp("2024-03-01 09:00")  # 予測起点（検証期間の中）
print("予測起点 t の観測（＝持続予報）:", t, weather.loc[t, "wind_direction"])
print("対象時刻 t + 3時間の観測      :", t + pd.Timedelta(hours=h), weather.loc[t + pd.Timedelta(hours=h), "wind_direction"])
""")

md("""
**短いコード：24時間周期の持続予報が使う観測**　t + h − 24 × ⌈h/24⌉ は、いつも t 以前になります（未来の観測は使いません）。
""")

code("""
for h in [1, 3, 23, 24, 25, 48, 72]:
    lag = 24 * math.ceil(h / 24) - h  # wp.cycle_lag(h) と同じ
    print(f"{h:2d}時間先 → 予測起点の {lag:2d} 時間前の観測を使う（対象時刻と同じ時刻）")
""")

md("""
**予想**　3時間先では、3つの基準予報のどれの誤差が一番小さいと思いますか？　理由もメモしてから実行しましょう（検証期間で比べます）。
""")

code("""
BASELINES = wp.BASELINE_MODELS  # ["persistence", "climatology", "persistence_24h"]
baseline_forecasts = wp.forecast_stage(weather, 3, BASELINES, split, "validation")
baseline_scores = wp.score_forecasts(baseline_forecasts, BASELINES)
baseline_scores
""")

md("""
表の列の意味：

| 列 | 意味 |
| --- | --- |
| `mae_deg` | 平均絶対角度誤差（度）。角度の差（最大180°）で測る |
| `within_45_pct` | 誤差が45°以内だった割合（%） |
| `vector_rmse_ms` | 予測した風ベクトル（u, v）と観測の差の大きさの二乗平均平方根（m/s）。静穏（u = v = 0）も含める |
| `n_test` | 角度を評価した件数（対象時刻が静穏・欠測の行は除く。どの手法も同じ行） |
| `n_undefined`, `undefined_pct` | 予測の向きが決まらなかった件数と割合。例えば予測起点が静穏だと、持続予報は風ベクトル0（向きなし）になる。向きが決まらない予測は、角度の誤差を90°（向きを一様ランダムに選んだときの期待誤差）として数える |
| `n_calm_target`, `n_missing_target` | 対象時刻が静穏・欠測で角度の評価から外した件数 |
| `n_missing_input`, `n_issue` | 予測起点までの入力が欠けていた件数と、予測起点の数 |

もう1つの目安として、**正解と無関係に0〜360°から一様ランダムに方向を選ぶ予測**の誤差を計算してみます。
""")

code("""
angle_rows = wp.angle_rows(baseline_forecasts)
random_errors = wp.random_direction_errors(baseline_forecasts.loc[angle_rows, "target_direction_deg"].to_numpy(), seed=0)
print(f"独立な一様ランダム方向予測の平均誤差: {random_errors.mean():.1f}°（期待値 {wp.RANDOM_DIRECTION_EXPECTED_ERROR_DEG:.0f}°）")
""")

md("""
この90°は「**独立な一様ランダム方向予測の期待誤差**」です。あらゆる予測の限界値ではありません。風向に偏りがあれば、気候値予報のように90°より小さくできることが多く、逆に、海風と陸風が入れ替わる時間差では、持続予報が90°より大きく外れることもあります。

**1か所の改造**　上の基準予報のセルの `3` を `12` に変えて、もう一度実行してみましょう。
""")

answer(
    "3時間先と12時間先で、持続予報と24時間周期の持続予報の順位はどう変わりましたか？　理由も説明してください。",
    "12時間たつと、昼と夜が入れ替わります。24時間周期の持続予報は、どの予測時間でも「同じ時刻」の観測を使います。",
    "このデータの検証期間では、3時間先は持続予報（約34°）が最もよく、24時間周期（約43°）、気候値予報（約49°）の順です。"
    "12時間先では、持続予報は海風と陸風が入れ替わるため大きく外れ（約74.5°）、24時間周期の持続予報（約43.5°）や気候値予報（約49.5°）の方がよくなります。"
    "ただし、どの手法が勝つかはデータと予測時間によって変わります。",
)

md("""
## 3. 角度の罠（実験1）

風向は、風が**吹いてくる**方位を北から時計回りに測った角度です（北 = 0°、東 = 90°、南 = 180°、西 = 270°）。北は0°でもあり360°でもあります。

**予想**　337.5°（北北西）と22.5°（北北東）の平均は、何°になるべきでしょうか？
""")

code("""
print("ふつうの平均（算術平均）:", np.mean([337.5, 22.5]), "度（南になってしまう）")
print("風向の平均（ベクトル平均）:", wp.circular_mean_deg([337.5, 22.5]), "度（北）")
print("ふつうの差              :", abs(337.5 - 22.5), "度")
print("角度としての差          :", wp.angular_error(337.5, 22.5), "度")
""")

md("""
そこで、風を東向きの成分 u と北向きの成分 v に分けて扱います。風向 θ、風速 S のとき

- u = −S × sin θ（西風なら u > 0）
- v = −S × cos θ（南風なら v > 0）

です（風は「吹いてくる向き」で表すので、向かう先はその反対になり、マイナスが付きます）。予測も u と v で行い、最後に角度に戻します。
""")

code("""
for label in ["北", "東", "南", "西", "北北西"]:
    degrees = wp.direction_label_to_degrees(label)
    u, v = wp.wind_to_uv(3.0, degrees)
    print(f"{label:>3}の風（{degrees:5.1f}°, 3 m/s） → u = {u:+.2f}, v = {v:+.2f} → 角度に戻すと {wp.uv_to_direction(u, v):5.1f}°")
""")

md("""
**練習**　340°・10°・20° の3つの風向の平均を、ふつうの平均と `wp.circular_mean_deg` で比べてみましょう。

<details><summary>解答例</summary>

ふつうの平均は約123°（東南東）ですが、風向の平均は約3°（ほぼ北）です。3つとも北寄りなので、北が正しい答えです。

</details>
""")

code("""
# 練習：ここに書いて実行してみよう

""")

md("""
**実験1：同じ条件で、u, v を回帰するか、角度を直接回帰するか**

同じ入力（季節・日周期＋過去・直近の観測）、同じ期間、同じモデル・同じ設定で、目的変数だけを変えて比べます。

- u, v の回帰：対象時刻の u と v を予測し、角度に戻す（例：`linear:calendar+recent`）
- 角度の直接回帰：対象時刻の風向（0〜360の数）をそのまま予測する（例：`linear_angle:calendar+recent`）

予測の表し方を決めるための比較なので、**検証期間**で比べます。参考に、入力もモデルも違う「悪い例」（予測起点の風向と時刻を数のまま使う線形回帰）も載せますが、表し方の良し悪しの結論には使いません。

**予想**　北寄りの風のとき、角度を直接回帰した予測はどのあたりの向きになりそうですか？
""")

code("""
exp1 = ex.experiment_angle(weather, split, methods=("linear", "boosting"), horizon=3)
exp1["scores"][SCORE_COLUMNS]
""")

code("""
plotting.plot_angle_trap(exp1["by_direction"], exp1["forecasts"], exp1["pairs"][0])
plt.show()
exp1["north"]  # 観測した風向が北から22.5°以内の時刻での誤差と、予測が南半分に入った割合
""")

md("""
左の図は、観測した風向（16方位）ごとの平均誤差です。中央と右は、観測（横軸）と予測（縦軸）の散布図です。u, v の回帰では、北の風（横軸0°付近）の予測が縦軸の0°付近か360°付近（どちらも北）に集まります。角度の直接回帰では、北の風の予測が南寄りの中ほどに集まります。

**1か所の改造**　`methods=("linear", "boosting")` を `methods=("boosting_deep",)` に変えて、より複雑な木でも同じことが起きるか確かめましょう。
""")

answer(
    "同じ入力・同じモデルなのに、角度の直接回帰が北の風で大きく外れるのはなぜですか？",
    "北の風の正解は 350° のときも 10° のときもあります。数として誤差を小さくしようとすると、どんな予測になりますか？",
    "北寄りの風の正解は 0° 付近と 360° 付近の両方にあるので、数としての二乗誤差を小さくしようとすると、その間の約180°（南）寄りの値を予測してしまいます。"
    "このデータの検証期間（3時間先）では、u, v の回帰の平均誤差が約24°なのに、同じ設定の角度の直接回帰は線形回帰で約68°、勾配ブースティングで約48°でした。"
    "北から22.5°以内の時刻では、線形回帰の角度の直接回帰は約94%の予測が南半分に入りました。風向は円の上の量なので、u, v（または sin・cos）で表して予測します。",
)

md("""
## 4. 3時間先を一度学習する

ここでは、統合モデル（季節・日周期＋過去・直近の観測）を、**学習期間（1年目）で学習し、検証期間（2年目）で評価**する流れを、短いコードで1つずつ確かめます。

**予想**　3時間先の誤差は、2節の持続予報（約34°）よりどのくらい小さくなると思いますか？
""")

code("""
stage = wp.prepare_stage(weather, 3, split, "validation")  # 学習用と評価用の行を作る
train = stage["train"]                                      # 予測起点も対象時刻も学習期間の中の行
rows = stage["evaluation"][stage["evaluation"]["excluded"] == ""]  # 評価に使える行
columns = wp.feature_columns("calendar+recent", stage["recent"])
print("学習の行数:", len(train), " 評価の行数:", len(rows), " 入力の数:", len(columns))
print(columns)
""")

md("""
入力（特徴量）は2つのまとまりです。

- **季節・日周期**（calendar）：対象時刻 t + 3 の時刻と季節を sin・cos で表したもの（23時と0時が近いことを表せる）と、**学習期間だけから計算した**月×時刻の平均の風（`clim_u`, `clim_v`）。暦は前もって分かるので、使ってもリークにはなりません。**リーク**とは、予測する時点ではまだ分からない未来の情報が、入力や学習に紛れ込むことです。月×時刻の平均の風は、基準予報の気候値予報と同じ値ですが、ここでは入力として使います。
- **過去・直近の観測**（recent）：t とその1, 2, 3, 6, 12, 24時間前の u, v、t までの24時間の平均の u, v、t の気温と1, 2, 3, 6時間前の気温、気温の3時間・24時間の変化、気圧と1時間・3時間の変化、その1時間の日照時間（`sunshine_now`）と、その日の t までの日照時間の合計（`sunshine_today`）。t より後の観測は使いません。
""")

code("""
model = wp.make_regressor("linear")                        # 標準化＋リッジ回帰（重みを少し抑えた線形回帰）
model.fit(train[columns], train[["target_u", "target_v"]])  # 学習期間だけで学習する
predicted = model.predict(rows[columns])                    # 検証期間の各予測起点で、3時間後の u, v を予測
direction = wp.uv_to_direction(predicted[:, 0], predicted[:, 1])
errors = wp.angular_error(rows["target_direction_deg"], direction)
print(f"平均絶対角度誤差: {np.nanmean(errors):.1f}°（対象時刻が静穏の行は除く）")
""")

md("""
同じことを、ライブラリの関数でも確かめます（同じ値になるはずです）。
""")

code("""
check = wp.forecast_stage(weather, 3, ["linear:calendar+recent"], split, "validation")
wp.score_forecasts(check, ["linear:calendar+recent"])[SCORE_COLUMNS]
""")

md("""
**検証期間で設定を選ぶ**　統合モデルには、線形回帰と、深さの違う勾配ブースティング（「入力がある値より大きいか」という質問を重ねる**決定木**を、それまでの誤差を小さくするように少しずつ足していく方法）の候補があります。検証期間の成績で1つ選び、それを最終テスト期間の実験2・3で使います。最終テスト期間の成績を見て選び直すことはしません。
""")

code("""
selection, INTEGRATED = ex.select_integrated(weather, split)  # 検証期間の3時間先の誤差で選ぶ
print("選んだ統合モデルの設定:", INTEGRATED)
selection[["candidate", "mae_deg", "within_45_pct", "vector_rmse_ms", "n_test", "selected"]]
""")

md("""
**1か所の改造**　学習のセルの `wp.make_regressor("linear")` を `wp.make_regressor("boosting")` に変えて、もう一度実行してみましょう。
""")

answer(
    "このデータで、統合モデルの設定として線形回帰が選ばれたのはなぜだと考えられますか？　複雑なモデルがいつもよいとは限らないのはなぜですか？",
    "選択の表の `mae_deg` の差の大きさを見ましょう。入力の多くは u, v の過去の値で、目的変数（3時間後の u, v）とおおむね直線的な関係があります。",
    "このデータの検証期間では、線形回帰（約24.2°）と勾配ブースティング（約24.5〜24.7°）の差は小さく、線形回帰が最も小さかったので選ばれました。"
    "3時間先の u, v は、今の u, v などとほぼ直線的な関係なので、柔軟なモデルの利点が小さいと考えられます。"
    "柔軟なモデルは学習期間だけの偶然の変動まで覚えることがあり（過学習）、検証期間では悪くなることもあります。差は小さいので、データや乱数の種が変われば選ばれる設定も変わりえます。",
)

md("""
## 5. 特徴量の比較（実験2）

3時間先について、統合モデルと同じ設定で、入力だけを変えた3つと、3つの基準予報を、**最終テスト期間（3年目）**の同じ行で比べます。

| この教材の名前 | 元の仕様の名前 | 入力 |
| --- | --- | --- |
| `calendar`（季節・日周期） | global_only | 対象時刻の周期特徴量、学習期間の月×時刻の平均の風 |
| `recent`（過去・直近の観測） | local_only | 予測起点までの観測（風・気温・気圧・日照） |
| `calendar+recent`（統合） | combined | 両方 |

どれも1地点の時間的な情報の区分です。「global」と呼んでも、広い範囲の大気の状態を観測しているわけではありません。

**予想**　季節・日周期だけ、過去・直近の観測だけ、統合の3つの誤差は、どんな順になると思いますか？
""")

code("""
exp2 = ex.experiment_features(weather, split, INTEGRATED, horizon=3)
exp2["scores"][SCORE_COLUMNS + ["n_calm_target", "n_missing_target", "n_missing_input"]]
""")

md("""
次に、全体の平均だけでは分からない様子を、48時間の例で見ます。例の期間は、**どの手法が当たるかを見る前に決めた規則**で、観測値だけから選びます。

- **急な変化のない穏やかな期間**：風の欠測も静穏もなく、平均風速が中央値以上の48時間のうち、3時間の風ベクトルの変化の最大値が最も小さい期間
- **急変を含む期間**：3時間の風ベクトルの変化が最も大きい時刻を真ん中に含む48時間

図の横軸は**対象時刻**です。3時間先の予報は、予報を出した時刻の3時間後の位置に描いています。灰色が観測、色が予報です。
""")

code("""
print(exp2["windows"])
plotting.plot_example_window(exp2["examples"]["calm"], exp2["models"], "calm_window")
plt.show()
""")

code("""
plotting.plot_example_window(exp2["examples"]["abrupt"], exp2["models"], "abrupt_window")
plt.show()
""")

md("""
**1か所の改造**　`horizon=3` を `horizon=12` に変えて、表の順位がどう変わるか見てみましょう。
""")

answer(
    "3時間先の表で、季節・日周期だけの予測が気候値予報とほぼ同じになるのはなぜですか？　また、穏やかな期間と急変を含む期間で、手法の得意・不得意はどう違いましたか？",
    "季節・日周期の入力には、気候値予報と同じ「月×時刻の平均の風」が入っています。急変を含む期間では、持続予報が使う「今の風」が急に変わります。",
    "季節・日周期だけでは「その時刻のいつもの風」しか分からないので、気候値予報（約50°）とほぼ同じになります。"
    "過去・直近の観測を使うと約25°、統合で約23°と小さくなり、このデータでは季節・日周期の情報を加えた上乗せは約1°でした。"
    "穏やかな期間では、風があまり変わらないので持続予報（約11°）も過去・直近の観測を使う予測（約11°）もよく当たります。"
    "急変を含む期間では、季節・日周期だけの予測と気候値予報は50°以上外れ、24時間周期の持続予報（約46°）も外れます。"
    "どちらの期間でも、統合モデルが必ず一番よいわけではありません（穏やかな期間では持続予報とほぼ同じ）。",
)

md("""
## 6. 予測時間の比較（実験3）

統合モデルと3つの基準予報を、予測時間を変えながら最終テスト期間で比べます。どの予測時間でも同じ予測起点を使います。ここでは授業用に9通りの予測時間にしています。1〜72時間のすべての整数時間は、CLI（`python scripts/run_experiments.py --config configs/full.toml`）で走査できます。

**予想**　予測時間を延ばすと、統合モデルの誤差はどこまで大きくなると思いますか？　持続予報は、24時間先と48時間先でどうなりそうですか？
""")

code("""
HORIZONS = [1, 3, 6, 12, 18, 24, 36, 48, 72]
exp3 = ex.experiment_horizons(weather, split, INTEGRATED, HORIZONS)
exp3["scores"].pivot(index="model", columns="horizon_h", values="mae_deg").loc[exp3["models"]].round(1)
""")

code("""
plotting.plot_error_vs_horizon(exp3["scores"], exp3["models"])
plt.show()
plotting.plot_vector_rmse_vs_horizon(exp3["scores"], exp3["models"])
plt.show()
""")

code("""
exp3["counts"]  # 予測時間ごとの評価件数と、外した件数（予測起点の数はどの予測時間でも同じ）
""")

md("""
**読み取り**

- 統合モデルの誤差は、予測時間が延びるほど大きくなり、気候値予報の誤差（約50°）に近づいていきます（72時間先でもまだ少し小さい）。誤差が90°まで増えるわけではありません。
- 持続予報は12時間先・36時間先で大きく外れ（海風と陸風が入れ替わる）、24時間先・48時間先では小さくなります。これは**日周期**のためで、同じ時刻には似た風が吹きやすいからです。カオス的な細かい情報が回復したわけではありません。24時間・48時間・72時間ちょうどでは、24時間周期の持続予報と持続予報は同じ観測（t の値）を使います。
- 角度を評価した件数は、予測時間によって少し違います。対象時刻が静穏・欠測になるかどうかが、予測時間によって変わるからです（表の `n_calm_target`, `n_missing_target`）。予測起点の数は同じです。
- ここで分かるのは、「この入力・このモデル・この学習期間・この評価指標」での**実用的な予測性能**です。この結果から、この地点の物理的な予測限界が何時間かを決めることはできません。

**1か所の改造**　`HORIZONS` に `30` と `60` を加えてみましょう。
""")

answer(
    "持続予報の誤差が24時間先で小さくなることは、「24時間後には大気の状態が元に戻る」ことを意味しますか？",
    "持続予報は「今の風」をそのまま使います。24時間後の同じ時刻には、何が同じでしょうか？",
    "意味しません。24時間後は同じ時刻なので、海風・陸風の日周期による風向が似ているだけです。"
    "数日規模の変動や前線は24時間で元に戻るわけではないので、24時間先の持続予報の誤差（約43°）は1時間先（約18°）よりずっと大きいままです。"
    "誤差の谷が24時間ごとに必ずできるとも限りません。日周期が弱い地点や季節では、谷は浅くなります。",
)

md("""
## 7. 自分の地元の気象庁データで試す

1. 気象庁「[過去の気象データ・ダウンロード](https://www.data.jma.go.jp/risk/obsdl/index.php)」で、風向・風速を観測している地点を1つ選びます（気圧は気象台などでだけ観測しています）。
2. 「時別値」を選び、項目は「気温」「風向・風速」「日照時間」（気象台などなら「海面気圧」も）を選びます。
3. 期間は3年を目安にします（年ごとの分割には3年分ほど必要。それより短いときは下の `SPLIT_MODE = "last_days"`）。一度にダウンロードできる量には上限があるので、多いときは1年ずつに分けます。
4. 表示オプションは既定のまま（「すべて数値で格納」「日付リテラルで格納」、品質情報・均質番号を含める）でCSVをダウンロードします。
5. 下のセルを一度実行すると、アップロード先のフォルダ `data/raw/` ができ、その場所が表示されます（Colab では `/content/2026_3Q_M4Th4-（ブランチ名）/projects/coastal-wind-chaos/data/raw/`）。Colab では、左の「ファイル」でそのフォルダを開き、ファイルをアップロードします。
6. アップロードしたファイルを `MY_FILES` に書いて、もう一度実行します。

詳しくは作品の `data/README.md` を見てください。自動でダウンロードするプログラムは使わず、手作業でダウンロードしてください（気象庁は自動化ツールによる過度のアクセスを控えるよう求めています）。ダウンロードしたデータはGitに追加しないでください。
""")

code("""
RAW_DIR = Path("data/raw")
RAW_DIR.mkdir(parents=True, exist_ok=True)  # アップロード先のフォルダを作る
print("アップロード先:", RAW_DIR.resolve())

MY_FILES = []           # 例：[RAW_DIR / "station_2023.csv", RAW_DIR / "station_2024.csv", RAW_DIR / "station_2025.csv"]
MY_MIN_QUALITY = 8      # 準正常値も使うなら 5
SPLIT_MODE = "years"    # 3年分ほどないときは "last_days"
TEST_DAYS, VALIDATION_DAYS = 180, 180  # "last_days" のときの最終テスト期間と検証期間（日）

if MY_FILES:
    my_weather = wp.load_weather(MY_FILES, min_quality=MY_MIN_QUALITY)
    display(wp.summarise_weather(my_weather))
    my_split = wp.make_split(my_weather, SPLIT_MODE, TEST_DAYS, VALIDATION_DAYS)
    my_selection, my_integrated = ex.select_integrated(my_weather, my_split)
    print("検証期間で選んだ統合モデルの設定:", my_integrated)
    my_exp2 = ex.experiment_features(my_weather, my_split, my_integrated, horizon=3)
    display(my_exp2["scores"][SCORE_COLUMNS + ["n_calm_target", "n_missing_target", "n_missing_input"]])
    my_columns = wp.input_column_table(wp.prepare_stage(my_weather, 3, my_split))
    print("使わない入力の列:", my_columns.loc[~my_columns["used"], "column"].tolist())
    print("欠けている数（n_missing）が多い入力の列:")
    display(my_columns[my_columns["used"]].sort_values("n_missing", ascending=False).head(8))
    my_exp3 = ex.experiment_horizons(my_weather, my_split, my_integrated, HORIZONS)
    plotting.plot_direction_by_hour(my_weather)
    plt.show()
    plotting.plot_error_vs_horizon(my_exp3["scores"], my_exp3["models"])
    plt.show()
else:
    print("MY_FILES にファイルを書くと、同じ実験ができます。")
""")

md("""
**実データで気をつけること**

- 結果は「その地点・その期間・その入力・そのモデル」での実用的な予測性能です。物理的な予測限界ではありません。
- 海風・陸風の向きは、海岸の向きや地形によって地点ごとに違います。風向計の高さや周りの建物も影響します。
- 気圧や日照のない地点でも実験できます。観測が途中で止まった要素があると、評価する予測起点が減ります（減った数は表の `n_missing_input` と、列ごとの欠測の数で確かめられます）。
- `summarise_weather` の「均質番号が変わった時刻」は、観測場所の移転や測器の変更の目安です。前後で値を単純に比べられないことがあります。
- アメダスの日照時間は、2021年3月2日から気象衛星のデータによる推計値です。
- 気象庁のデータは、後から修正されることがあります。ダウンロードした日を記録しておきましょう。
- 図や表に使うときは「出典：気象庁ホームページ（https://www.data.jma.go.jp/risk/obsdl/index.php）」のように出典を書き、加工した場合はそのことと加工した人を書きます。
- 自分で作った将来の予報を、他の人に向けて繰り返し公表すると、気象業務法の予報業務の許可が必要になることがあります。この教材では、過去のデータで学習と評価をするだけにしてください。
""")

md("""
## 8. ローレンツ系の初期値鋭敏性（実験4）

ローレンツ（1963）の方程式は、対流を大きく単純化した3変数の方程式です。

dx/dt = σ(y − x),　dy/dt = x(ρ − z) − y,　dz/dt = xy − βz　（σ = 10, ρ = 28, β = 8/3）

乱数は使わず、初期値が決まれば未来は1通りに決まります（決定論的）。それでも、初期値のわずかな違いが指数関数的に広がります。ここで使う時間は**ローレンツ系の無次元の時間**で、時間（hour）や日には換算しません。この実験は、実験1〜3の風向きの予測とは独立しています。

**予想**　初期値を 0.000001 だけずらした2本の軌道は、どのくらいの時間で別々の動きになると思いますか？
""")

code("""
start_points = lorenz_demo.attractor_points(20, seed=0)
runs = lorenz_demo.twin_runs(start_points[0], perturbation_size=1e-6, n_steps=3000)
plotting.plot_twin_runs(runs)
plt.show()
""")

md("""
始めは2本の軌道が重なっていますが、距離（下の図、対数目盛）はほぼ直線的に、つまり指数関数的に増え、やがて別々の動きになります。

距離がおよそ e<sup>λt</sup>（t は時間、λ は定数）のように広がるとき、λ を**最大リアプノフ指数**と呼びます。λ が正なら、小さな違いが指数関数的に広がります。次のセルでは、20個の出発点で距離の対数の傾き（成長率）を求めます。また、**Benettin法**（2本の軌道の距離を一定時間ごとに小さく戻しながら、広がる割合を平均する計算方法）でも λ を求めます。
""")

code("""
TOLERANCE = 1.0
times, distances = lorenz_demo.twin_distances(start_points, 1e-10, 3500)
growth_rate = lorenz_demo.fit_growth_rate(times, distances, 1e-8, 1e-1)
lyapunov = lorenz_demo.estimate_lyapunov_benettin(start_points[0], n_steps=20000)
print(f"距離の対数の傾き（成長率）       : {growth_rate:.2f}")
print(f"Benettin法による最大リアプノフ指数: {lyapunov:.2f}（文献値 約{lorenz_demo.REFERENCE_LYAPUNOV_EXPONENT}）")
plotting.plot_separation_growth(times, distances, TOLERANCE, growth_rate)
plt.show()
""")

code("""
predictability = lorenz_demo.predictability_table(start_points, [1e-10, 1e-8, 1e-6, 1e-4, 1e-2], TOLERANCE, n_steps=3500)
plotting.plot_predictability_times(predictability, TOLERANCE)
plt.show()
predictability
""")

md("""
**読み取り**：初期誤差 δ が許容誤差 Δ に達するまでの時間は、およそ ln(Δ/δ) ÷ λ です。そのため、初期誤差を10分の1にしても、時間は ln(10) ÷ λ ≈ 2.3 ÷ 0.91 ≈ 2.5（無次元の時間）しか延びません。初期誤差を小さくする努力に比べて、延びる時間はわずかです。これがカオスによる予測の難しさです。

**数値計算の確認**：計算の刻み dt を半分にしても、結果がほぼ同じかを確かめます（刻みが粗すぎると、計算の誤差で結果が変わってしまうため）。
""")

code("""
time_steps = lorenz_demo.time_step_check(start_points, dts=(0.01, 0.005), perturbation_sizes=(1e-8, 1e-4),
                                         tolerance=TOLERANCE, total_time=35.0)
plotting.plot_time_step_check(time_steps)
plt.show()
time_steps[["dt", "initial_error", "median_time", "n_reached", "benettin_lyapunov"]]
""")

md("""
最後に、安定なAR(1)過程と比べます。同じ乱数を与えて初期値だけ変えた2本のAR(1)は、差がどんどん**縮み**ます。AR(1)の予測が外れるのは、これから加わる新しい乱数のためです。
""")

code("""
ar_twin = lorenz_demo.ar1_twin(phi=0.85, n_steps=48)
ar_error = lorenz_demo.ar1_forecast_error_std(phi=0.85, noise_std=1.0, n_steps=48)
plotting.plot_ar1_vs_lorenz(ar_twin, ar_error, times, distances)
plt.show()
""")

md("""
**注意**

- ローレンツ系は大気そのものではありません。時間の単位も無次元です。「何時間で外れる」という数字は、時間の換算の仕方を決めればいくらでも作れてしまいます。
- この3変数のローレンツ系では、初期誤差を小さくすれば、予測できる時間は（ゆっくりとですが）いくらでも延ばせます。大気のように大小さまざまな規模の運動がある系では、初期誤差を小さくしても延ばせない限界があると考えられています（Lorenz, 1969）。
- 実験1〜3で誤差が増えたのは、この合成データでは主に確率的な成分（AR変動・背景成分・前線）と入力の不足のためです。実験1〜3はカオスを示していません。
- 実際の大気の予測可能性は、数値予報モデルのアンサンブル実験などで研究されています。1地点の機械学習の誤差曲線から、その限界を決めることはできません。

**1か所の改造**　`TOLERANCE = 1.0` を `5.0` に変えて、予測できる時間の表を比べましょう。
""")

answer(
    "許容誤差を大きくすると、表の時間はどう変わりましたか？　初期誤差を10分の1にしたときに延びる時間は変わりましたか？",
    "時間はおよそ ln(Δ/δ) ÷ λ でした。Δ を変えると、どの部分が変わりますか？",
    "許容誤差を大きくすると、どの初期誤差でも時間が少し延びます。一方、初期誤差を10分の1にしたときに延びる時間（約2.5）は、λ だけで決まるのでほぼ変わりません。",
)

md("""
## 9. （発展）予測が外れる原因を区別する

予測が外れる原因には、例えば次のようなものがあります。「1つの要因だけを変えて、誤差が変わるかを見る」のが基本です。合成データでは成分を自由に切り替えられ、真の状態も分かるので、この練習ができます。この節のセルは、前のセルで作った変数を使うので、9.1から順に実行してください。

| 原因 | 確かめ方の例 |
| --- | --- |
| 入力の不足 | 入力を足したり減らしたりして、誤差が変わるか |
| モデルの不足 | 同じ入力のまま、モデルだけを変えて誤差が変わるか |
| 観測誤差 | 観測誤差のない「真の値」と比べたり、観測誤差の大きさを変えたりする |
| 確率的な変動 | 確率的な成分を入れたデータと入れないデータで比べる |
| カオス | 決定論的な系で初期値をわずかに変える（8節のローレンツ系） |

### 9.1 入力の不足：気圧を入力から外す
""")

code("""
no_pressure = weather.drop(columns=["sea_level_pressure_hpa"])
FRONT_MODELS = ["persistence", f"{INTEGRATED}:calendar+recent", "boosting:calendar+recent"]
pressure_scores = pd.concat({
    "気圧あり": wp.run_horizon_experiment(weather, [6, 12, 24], FRONT_MODELS[1:], split),
    "気圧なし": wp.run_horizon_experiment(no_pressure, [6, 12, 24], FRONT_MODELS[1:], split),
}, names=["inputs"]).reset_index(level=0)
pressure_scores.pivot_table(index=["inputs", "model"], columns="horizon_h", values="mae_deg").round(1)
""")

md("""
全体の平均では差は小さくなります。前線が来るのは数日に1回で、ほとんどの時間には気圧の情報が効かないからです。そこで、前線の前後だけで比べます。真の状態のファイルには、前線の通過時刻が入っています（予測の入力には使わず、評価の分類だけに使います）。行の `[0, 3)` は「対象時刻が前線通過から3時間未満」、`[-3, 0)` は「通過の3時間前から直前」、列の `n` はその区間の件数です。
""")

code("""
truth = sample_data.read_truth_csv(TRUTH_PATH)
with_pressure = wp.forecast_stage(weather, 6, FRONT_MODELS, split)
without_pressure = wp.forecast_stage(no_pressure, 6, FRONT_MODELS, split)
fronts_with_pressure = sample_data.error_around_fronts(with_pressure, FRONT_MODELS, truth)
fronts_without_pressure = sample_data.error_around_fronts(without_pressure, FRONT_MODELS, truth)
pd.concat({"気圧あり": fronts_with_pressure, "気圧なし": fronts_without_pressure}, axis=1).round(0)
""")

md("""
**読み取り**：気圧を外すと、前線通過の直後（`[0, 3)`、`[3, 6)`）で機械学習の誤差が大きくなります。持続予報は気圧を使わないので変わりません。全体の平均では小さな差でも、**どんなときに外れるか**に分けて調べると、入力の不足が見つかることがあります。

### 9.2 前線の予兆：単地点の過去の情報で急変を当てられるか

同じ乱数の種で、予兆だけをなくしたデータ（前線の時刻と強さは同じ）と比べます。
""")

code("""
settings_no_precursor = sample_data.make_settings("no_precursor", seed=2026)
truth_no_precursor = sample_data.simulate_truth(settings_no_precursor)
weather_no_precursor = wp.prepare_weather(sample_data.observe(truth_no_precursor, settings_no_precursor))
without_precursor = wp.forecast_stage(weather_no_precursor, 6, FRONT_MODELS, split)
fronts_without_precursor = sample_data.error_around_fronts(without_precursor, FRONT_MODELS, truth_no_precursor)
pd.concat({"予兆あり": fronts_with_pressure, "予兆なし": fronts_without_precursor}, axis=1).round(0)
""")

md("""
**読み取り**：予兆があるデータでは、前線通過の直後（`[0, 3)`、`[3, 6)`）の機械学習の6時間先予報の誤差が、予兆がないデータより小さくなります。一方、通過前（`[-12, -6)` から `[-3, 0)`）の誤差は、予兆があるデータの方が大きくなります。予兆そのものも風を南西寄りに変えるので、予兆が始まる前に出した予報は外れやすくなるからです。持続予報は、予兆があっても通過の直後に大きく外れたままです。予兆のない外からのランダムな到来は、**その地点の過去の情報だけでは当てられません**。その場合は、ほかの地点の観測や数値予報など、別の入力が必要です。

### 9.3 モデルの不足と過学習：同じ入力でモデルだけを変える

季節・日周期だけを入力にした勾配ブースティング（`boosting:calendar`）を、学習期間と検証期間の両方で評価してみます。`wp.forecast_training_period` は、学習に使った時刻を、そのモデル自身で予測します（学習に使った時刻なので、ふつうの評価には使いません）。
""")

code("""
OVERFIT_MODELS = ["climatology", "linear:calendar", "boosting:calendar"]
in_training = wp.forecast_training_period(weather, 3, OVERFIT_MODELS, split, "validation")
in_validation = wp.forecast_stage(weather, 3, OVERFIT_MODELS, split, "validation")
pd.DataFrame({
    "学習期間の誤差": wp.score_forecasts(in_training, OVERFIT_MODELS).set_index("model")["mae_deg"],
    "検証期間の誤差": wp.score_forecasts(in_validation, OVERFIT_MODELS).set_index("model")["mae_deg"],
})
""")

md("""
**読み取り**：学習期間では勾配ブースティングの誤差がずっと小さいのに、検証期間では気候値予報より大きくなります。柔軟なモデルが、学習期間（1年分）だけにあった偶然の変動まで覚えてしまった（**過学習**）と考えられます。気候値予報や線形回帰も学習期間の方が誤差が小さいのは、学習期間の平均や傾向そのものを使っているからです。

### 9.4 観測誤差：観測値と「真の風向」

観測値は16方位（22.5°刻み）に丸められ、観測誤差も含みます。丸め前の連続的な真の風向（観測誤差なし）と、丸めた観測の差は、真の風向が各方位の幅（22.5°）の中で一様に散らばっていると仮定すると、平均 22.5 ÷ 4 ≈ 5.6° です。
""")

code("""
print(f"観測した風向と真の風向の差（平均）: {sample_data.observation_error_summary(weather, truth):.1f}°")
forecasts6 = wp.forecast_stage(weather, 6, ["persistence", f"{INTEGRATED}:calendar+recent"], split)
sample_data.errors_against_truth(forecasts6, ["persistence", f"{INTEGRATED}:calendar+recent"], truth)
""")

code("""
rows_noise = []
for noise in [0.0, 0.3, 1.0]:
    noisy_settings = sample_data.make_settings("default", seed=2026, observation_noise_ms=noise)
    noisy_truth = sample_data.simulate_truth(noisy_settings)
    noisy_weather = wp.prepare_weather(sample_data.observe(noisy_truth, noisy_settings))
    noisy_forecasts = wp.forecast_stage(noisy_weather, 1, [f"{INTEGRATED}:calendar+recent"], split)
    row = sample_data.errors_against_truth(noisy_forecasts, [f"{INTEGRATED}:calendar+recent"], noisy_truth)
    row.insert(0, "observation_noise_ms", noise)
    row["observation_vs_truth_deg"] = sample_data.observation_error_summary(noisy_weather, noisy_truth)
    rows_noise.append(row)
pd.concat(rows_noise, ignore_index=True)
""")

md("""
**読み取り**：観測誤差が0でも、16方位に丸めるだけで、真の風向と観測の差は平均約5.7°になります（一様の仮定から求めた5.6°に近い値）。連続的な角度で予測する機械学習は、予測が真の風向と完全に一致しても、丸めた観測値とは平均5〜6°ずれます。一方、持続予報は16方位の観測をそのまま予報にするので、風向が変わらなければ観測値に対する誤差が0°になり、その分だけ有利です。観測誤差を大きくすると、観測値に対する誤差（`mae_vs_observation_deg`）は大きく増えますが、真の風向に対する誤差（`mae_vs_truth_deg`）の増え方はそれより小さくなります。「外れた」と見える誤差の一部は、観測そのものの誤差です。

### 9.5 確率的な変動：周期成分だけ と 周期成分＋AR変動
""")

code("""
scenario_weather = {name: sample_data.generate_weather(name, seed=2026)
                    for name in ["periodic_only", "periodic_ar", "default"]}
SCENARIO_MODELS = ["persistence", "climatology", "persistence_24h", "linear:calendar+recent"]
scenario_scores = wp.run_scenario_experiment(scenario_weather, HORIZONS, SCENARIO_MODELS)
plotting.plot_scenario_comparison(scenario_scores, ["persistence", "linear:calendar+recent"])
plt.show()
scenario_scores.pivot_table(index=["scenario", "model"], columns="horizon_h", values="mae_deg").round(1)
""")

md("""
**読み取り**

- **周期成分だけ**：気候値予報と機械学習の誤差は、どの予測時間でもほぼ同じ小ささ（約11°）で、残る誤差は主に観測誤差と16方位の丸めです。24時間周期の持続予報も約13°です。持続予報は12時間先で大きく外れますが（海風と陸風が入れ替わる）、24・48・72時間先ではほとんど外れません。
- **周期成分＋AR変動**：予測時間が延びると誤差が増え、半日ほどで気候値予報と同じくらいになって頭打ちになります。AR変動は「1時間前と相関する乱数」で、これから加わる新しい乱数は誰にも予測できないからです。これは**確率的な変動による予測の難しさで、カオスとは別のもの**です（AR(1)は安定な確率過程です）。
- 頭打ちになるまでの時間（ここでは半日ほど）は、データを作るときに選んだ `ar_phi`（1時間前との相関の強さ）や `ar_strength`（周期成分と比べた強さ）で決まります（改造課題2で確かめられます）。設定で変えられる値なので、実際の大気の予測限界を表すものではありません。
""")

md("""
## 10. （選択）改造課題

### コードを書き換えるときの注意

- この作品のコードは、0節のセルが表示した作業ディレクトリの `src/coastal_wind_chaos/` にあります（Colab では `/content/2026_3Q_M4Th4-（ブランチ名）/projects/coastal-wind-chaos/src/coastal_wind_chaos/`）。Colab では、左の「ファイル」から `.py` ファイルを開いて書き換えられます。
- `.py` ファイルを書き換えても、実行中のカーネル（Pythonを実行している仕組み）は、前に読み込んだ内容を使い続けます。書き換えたら、Colab では「ランタイム → セッションを再起動」、手元の Jupyter では「Kernel → Restart」を選び、0節のセルから実行し直してください。
- Colab のランタイムを削除したり、しばらく使わずに接続が切れたりすると、`/content` のファイルは消えます。書き換えたファイルは、ダウンロードして保存しておきましょう。
- Notebookのセルに新しい関数を書いたり、`wp.MODEL_SETTINGS` に設定を足したりする方法なら、再起動は要りません。

### 課題

どれか1つを選び、**変える前の結果・変えたこと・変えた後の結果・理由**の順に説明してみましょう。手法や設定の良し悪しを決める比較は検証期間（`"validation"`）で行い、最終テスト期間は最後に1回だけ使いましょう。

1. **直近の観測の時間**：`wp.forecast_stage(weather, 3, [f"{INTEGRATED}:calendar+recent"], split, "validation", lags=(0,))` のように、使う「何時間前」を減らす。
2. **不規則成分の強さ**：`sample_data.generate_weather("periodic_ar", seed=2026, ar_strength=2.0)` で、AR変動を強くする・弱くする。
3. **前線の予兆の長さ**：`front_precursor_hours` を 0, 6, 12, 24 に変えて、9.2の表を比べる。
4. **海風の強さ**：`breeze_strength` を 0 や 2 にして、季節・日周期の情報の役割がどう変わるか調べる。
5. **悪い例を直す**：角度を数値のまま使う代わりに、sin・cos で表して予測する方法を考える（`wind_pipeline.py` の `fit_predict_degrees_as_numbers` を参考に。Notebookのセルに新しい関数を書いて試せます）。
6. **モデルの候補を足す**：`wp.MODEL_SETTINGS["boosting_free"] = {"kind": "boosting", "max_depth": None, "min_samples_leaf": 20}` のように候補を足し、`wp.select_on_validation(weather, split, wp.INTEGRATED_CANDIDATES + ["boosting_free"])` で選び直す。9.3と同じ方法で、季節・日周期だけの場合の学習期間と検証期間の誤差も比べる。
7. **評価の仕方**：`within_45_pct`（45°以内の割合）や `vector_rmse_ms` で比べると、手法の順位は変わるか。
8. **ローレンツ系**：`TOLERANCE` を変える。また、`lorenz_demo.RHO = 20.0` にしてから8節の `start_points` を作り直し、`lorenz_demo.estimate_lyapunov_benettin` と `lorenz_demo.predictability_table` を実行する（`lorenz_demo.fit_growth_rate` はエラーになります。なぜかも考えましょう。終わったら `lorenz_demo.RHO = 28.0` に戻す）。
9. **地元のデータ**：分け方（`SPLIT_MODE`, `TEST_DAYS`）や季節を変えて評価する。

<details><summary>期待される観察と解答例</summary>

数値は、この教材の既定の合成データ（`seed=2026`）で確かめた例です。評価する時刻の選び方やライブラリの版で、少し変わることがあります。

1. 検証期間の3時間先では、統合モデルの誤差は約24.2°から約24.4°へ、過去・直近の観測だけの予測では約25.1°から約25.7°へ、少し大きくなります。1時間前の値などから「風向が変わりつつあるか」が分かると、少し先の予測に役立つからです。入力の欠測で外す予測起点は、過去24時間の平均がそろっているかで決まるので、評価する行の数は変わりません。
2. AR変動を強くすると、短い予測時間でも誤差が大きくなり、頭打ちになる誤差も大きくなります（`ar_strength=0.5` で約20°、`2.0` で約52°）。頭打ちになるまでの時間も延びます（0.5 では6〜12時間先ごろ、1.0 では12時間先ごろ、2.0 では12〜24時間先ごろ）。頭打ちまでの時間は、`ar_phi` だけでなく、周期成分と比べたAR変動の強さでも変わります。
3. 予兆が0だと、前線通過の直後（`[0, 3)`）の6時間先予報の誤差は約45°以上と大きいままです。6時間や12時間の予兆があると小さくなります（6時間の予兆で約16〜21°）。ただし「長いほどよい」とは限らず、24時間のようにゆっくり変わる予兆では、いつ通過するかを見分けにくく、効果が小さくなります。予兆があると、通過前の誤差は逆に大きくなることにも注意しましょう（9.2）。
4. 海風を0にすると昼夜の差がなくなり、季節・日周期だけの予測は気候値予報と同じ約65°になり、統合しても過去・直近の観測だけとほぼ同じです。2にすると、季節・日周期だけの予測でも約33°まで小さくなり、統合の上乗せ（3時間先で約1.4°）も少し大きくなります。
5. 例えば目的変数を (sin θ, cos θ) にして線形回帰し、`np.arctan2` で角度に戻します。検証期間の3時間先では、悪い例（全体約48°、夜約60°、昼約31°）に対して、目的変数だけを sin・cos にすると夜は約47°に減りますが、時刻（0〜23）をふつうの数のまま使うので昼は約79°に増えます。時刻も sin・cos で表すと全体で約46°、さらに予測起点の風向も sin・cos で表すと約30°になります。
6. 制限のない深い木（`boosting_free`）は、季節・日周期だけの場合、学習期間の誤差が約20°と小さいのに、検証期間では約58°と気候値予報（約50°）より大きくなります。学習期間には合うのに検証期間には合わない、過学習の例です。統合モデルの候補に加えても、検証期間の成績で選ばれるのは線形回帰のままでした（約24.9°対約24.2°）。
7. 例えば最終テスト期間の6時間先では、平均誤差では気候値予報（約50°）が持続予報（約56°）より良いのに、45°以内の割合では持続予報（約61%）が気候値予報（約56%）より高く、順位が入れ替わります。持続予報は、風向が変わらなければ誤差0°になる一方、海風と陸風が入れ替わると大きく外れるからです。ベクトルRMSEでは、風速の違いも誤差に入るので、また別の見え方になります。指標を決めてから比べること、弱い風の風向はもともと定まりにくいことに注意しましょう。
8. 許容誤差を大きくすると時間は延びますが、初期誤差を10分の1にしたときに延びる時間（約2.5）はほぼ変わりません。ρ = 20 では、軌道はやがて2つの固定点（動きが止まる点）のどちらかに近づいて落ち着きます。Benettin法の値は約 −0.15 と負になり、`start_points` を作り直すと、2本の距離は時間とともに縮みます（`n_reached` はすべて0）。距離が指数関数的に増えないので、成長率を求める `fit_growth_rate` はエラーになります。なお、`start_points` を作り直さずに ρ = 28 のときの点から始めると、落ち着くまでの間は一時的にカオスのようにふるまう（過渡的カオス）ため、初期誤差が大きい組の一部は別々の固定点に行き着き、離れたままになります。
9. 地点や季節によって、どの情報が効くかが変わります。結果は、その地点・期間・入力・モデルでの性能として説明しましょう。

</details>
""")

md("""
## 11. まとめ

- 風向は円の上の量です。u・v で扱い、角度の差で評価します。同じ入力・同じモデルでも、角度を直接回帰すると北の風で大きく外れます。
- 単純な基準予報（持続予報・気候値予報・24時間周期の持続予報）と比べることで、機械学習の効果を正しく評価できます。手法や設定は検証期間で選び、最終テスト期間は最後の成績表にだけ使います。
- 過去・直近の観測は、予測時間が短いほどよく効きます。季節・日周期の情報は、それを補う形で効きます。どの組み合わせがよいかは、データと予測時間によって変わります。
- 予測が外れる原因は1つではありません。1つの要因だけを変えて比べると、入力の不足・モデルの不足・観測誤差・確率的な変動を区別できます。
- カオス（ローレンツ系）は、決定論的な系でも初期値のわずかな違いが広がる現象です。確率的な変動（AR過程）とは別のものです。
- 風向き予測の誤差曲線は、その条件での実用的な予測性能を表します。カオスの壁や物理的な予測限界を表すものではありません。
""")


def build(output=DEFAULT_OUTPUT):
    """Notebook を組み立てて output に保存する。"""
    for number, cell in enumerate(CELLS, start=1):
        cell.id = f"cell-{number:02d}"  # 作り直しても差分が出ないよう、セルのIDを固定する
    notebook = nbformat.v4.new_notebook(cells=CELLS)
    notebook.metadata["kernelspec"] = {"display_name": "Python 3", "language": "python", "name": "python3"}
    notebook.metadata["language_info"] = {"name": "python"}
    notebook.metadata["colab"] = {"provenance": [], "toc_visible": True}
    nbformat.validate(notebook)
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    nbformat.write(notebook, output)
    return output


def main():
    parser = argparse.ArgumentParser(description="教材の Notebook を作り直します。")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="保存先（既定：notebooks/coastal_wind_hands_on.ipynb）")
    path = build(parser.parse_args().output)
    print("wrote", path, len(CELLS), "cells")


if __name__ == "__main__":
    main()
