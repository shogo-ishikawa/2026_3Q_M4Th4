# 計算結果の保存先

Notebook やスクリプトの結果は、このフォルダの中に保存します。このフォルダの中身（この README を除く）は Git の管理対象外です（リポジトリ共通の `.gitignore` で除外しています）。

## 保存のしかた

実行のたびに `日時_ラベル` という新しいフォルダを作り、前回の結果を上書きしません（同じ秒に保存した場合は `-2` などを付けます）。

| 作られるもの | 作る関数・スクリプト | 中身 |
| --- | --- | --- |
| `YYYYmmdd-HHMMSS_day_plan/` | `report.save_run()`（02 の「結果を保存する」） | `plan.csv`（予定表）、`segments.csv`（移動・待機・待ち時間・体験などの時間の流れ）、`summary.json`（状態、各段階の目的値と限界値、条件、データの出典、ソフトウェアの版、使ったコードの版（`REPO_REF`・コミット・コミットしていない変更の有無）、検証結果）、`timeline.png`（タイムライン図） |
| `YYYYmmdd-HHMMSS_day_plan.zip` | 02 の Notebook | 上のフォルダを zip にしたもの（Colab でのダウンロード用） |
| `YYYYmmdd-HHMMSS_comparison/` | `experiment.save_comparison()`（02 の比較実験） | `comparison.csv`（ケース・方法ごとの結果）、`settings.json`（実験の設定、方法Bの規則、ソフトウェアの版） |
| `YYYYmmdd-HHMMSS_random_batch/` | 一括実験（`RUN_RANDOM_BATCH = True` のとき） | 上と同じ形式 |
| `executed_notebooks/` | `scripts/run_notebooks.py` | 上から実行した Notebook のコピー |

CSV は表計算ソフトで開けるよう、UTF-8（BOM付き）で保存します。時刻は `HH:MM`、費用は円です。

## 注意

- 保存先はこの作品の `outputs/` に限ります（Notebook では `OUTPUT_DIR = PROJECT_DIR / "outputs"`）。
- 結果を論文や発表で使う場合は、`summary.json`・`settings.json` に記録された条件とソフトウェアの版も一緒に示してください。
- Colab の `/content/` に保存した結果は、ランタイムが終了すると消えます。必要なものはダウンロードしてください。
