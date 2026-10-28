"""2つのCLIを、小さな設定で実際に実行して確かめる。"""

import json
import os
import shutil
import subprocess
import sys
import tomllib

import pandas as pd

from conftest import PROJECT_DIR, write_text

SCRIPTS = PROJECT_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS))
import run_experiments  # noqa: E402


def run(arguments, expect_success=True):
    """CLIを実行して結果を返す。出力は UTF-8 で受け取る（Windowsの日本語以外の環境でも同じ）。"""
    environment = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    result = subprocess.run([sys.executable, *map(str, arguments)], capture_output=True, encoding="utf-8",
                            errors="replace", cwd=PROJECT_DIR, env=environment)
    if expect_success:
        assert result.returncode == 0, result.stderr
    return result


def write_small_config(tmp_path, years=3):
    """短時間で終わる設定ファイルを作る。

    lags と max_horizon は、既定（[0, 1, 2, 3, 6, 12, 24] と 72）と違う値にして、設定が実験に届くことを確かめる。
    """
    config = tmp_path / "small.toml"
    config.write_text(f"""
[sample_data]
preset = "default"
seed = 3
years = {years}
output = "{(tmp_path / 'data' / 'sample.csv').as_posix()}"
truth_output = "{(tmp_path / 'data' / 'truth.csv').as_posix()}"

[data]
min_quality = 8

[split]
mode = "years"
test_days = 365
validation_days = 365
max_horizon = 48

[models]
candidates = ["linear", "boosting_shallow"]
selection_horizon = 3
lags = [0, 1, 3]
seed = 0

[experiment1]
horizon = 3
methods = ["linear"]

[experiment2]
horizon = 3
window_hours = 48

[experiment3]
horizons = [1, 25, 48]
extra_models = []

[scenarios]
enabled = true
names = ["periodic_only"]
horizons = [1, 6]
models = ["persistence", "persistence_24h"]

[lorenz]
n_start_points = 3
perturbation_sizes = [1e-6, 1e-3]
n_steps = 1500
dt = 0.01
tolerance = 1.0
benettin_steps = 2000
check_dts = [0.01, 0.005]
seed = 0
""", encoding="utf-8")
    return config


def test_fast_and_full_configs_have_the_required_lead_times():
    fast = tomllib.loads((PROJECT_DIR / "configs" / "fast.toml").read_text(encoding="utf-8"))
    full = tomllib.loads((PROJECT_DIR / "configs" / "full.toml").read_text(encoding="utf-8"))
    assert run_experiments.horizons_from(fast["experiment3"]) == [1, 3, 6, 12, 18, 24, 36, 48, 72]
    assert run_experiments.horizons_from(full["experiment3"]) == list(range(1, 73))
    for config in [fast, full]:
        assert config["split"]["mode"] == "years" and config["split"]["max_horizon"] == 72
        assert config["data"]["min_quality"] == 8


def test_generate_sample_csv_cli(tmp_path):
    output = tmp_path / "sample.csv"
    truth = tmp_path / "truth.csv"
    stdout = run([SCRIPTS / "generate_sample_jma_csv.py", "--output", output, "--years", "1", "--seed", "5",
                  "--preset", "periodic_ar", "--truth-output", truth, "--set", "ar_strength=1.5"]).stdout
    assert output.exists() and truth.exists()
    assert "気象庁の観測値ではありません" in stdout
    assert "ar_strength = 1.5" in stdout
    first_line = output.read_bytes().decode("cp932").splitlines()[0]
    assert first_line.startswith("合成データ") and "ar_strength=1.5" in first_line


def test_generate_cli_does_not_overwrite_a_downloaded_file(tmp_path):
    downloaded = write_text(tmp_path / "station.csv", ["ダウンロードした時刻：2000/1/1 00:00:00", "", ",テスト地点"])
    before = downloaded.read_bytes()
    result = run([SCRIPTS / "generate_sample_jma_csv.py", "--output", downloaded, "--years", "1"],
                 expect_success=False)
    assert result.returncode != 0 and "上書きしません" in result.stderr
    assert downloaded.read_bytes() == before


def test_run_experiments_cli_with_a_small_config(tmp_path):
    config = write_small_config(tmp_path)
    results = tmp_path / "results"
    figures = tmp_path / "figures"
    stdout = run([SCRIPTS / "run_experiments.py", "--config", config, "--results-dir", results,
                  "--figures-dir", figures, "--language", "en"]).stdout
    assert (tmp_path / "data" / "sample.csv").exists()
    for name in ["data_summary.csv", "input_columns.csv", "selection_validation.csv", "exp1_means.csv",
                 "exp1_scores.csv", "exp1_by_direction.csv", "exp1_north.csv", "exp2_scores.csv", "exp2_windows.csv",
                 "exp2_calm_48h.csv", "exp2_abrupt_48h.csv", "exp3_scores.csv", "exp3_counts.csv",
                 "scenario_scores.csv", "exp4_predictability.csv", "exp4_time_steps.csv", "exp4_summary.json",
                 "run_info.json"]:
        assert (results / name).exists(), name
    for name in ["time_split.png", "exp1_angle_trap.png", "exp2_calm_48h.png", "exp2_abrupt_48h.png",
                 "exp3_error_vs_horizon.png", "exp3_vector_rmse_vs_horizon.png", "exp4_time_step_check.png",
                 "exp4_ar1_vs_lorenz.png", "scenario_comparison.png"]:
        assert (figures / name).stat().st_size > 10_000, name
    info = json.loads((results / "run_info.json").read_text(encoding="utf-8"))
    assert info["data_is_synthetic"] is True and info["split"]["mode"] == "years"
    assert info["integrated_model"] in ["linear", "boosting_shallow"]
    assert info["experiment1"]["stage"] == "validation"  # 表し方の比較は検証期間で行う
    assert info["figure_language"] == "en" and info["min_quality"] == 8
    assert "git_has_uncommitted_changes" in info["environment"]
    scores = pd.read_csv(results / "exp3_scores.csv")
    assert sorted(scores["horizon_h"].unique()) == [1, 25, 48]
    assert scores.groupby("horizon_h")["n_issue"].nunique().eq(1).all()
    assert scores["n_issue"].nunique() == 1  # どの予測時間でも同じ予測起点
    assert {"vector_rmse_ms", "n_undefined", "n_calm_target", "n_missing_input"} <= set(scores.columns)
    assert "検証期間で統合モデルの設定を選ぶ" in stdout
    assert "入力が欠けていて評価から外す予測起点" in stdout
    # 設定の lags と max_horizon が、選択と実験1〜3に届いている
    assert info["model_options"] == {"lags": [0, 1, 3], "max_horizon": 48}
    columns = set(pd.read_csv(results / "input_columns.csv")["column"])
    assert {"u_lag3", "u_change_1h", "u_change_3h"} <= columns and not {"u_lag2", "u_lag24"} & columns
    split = {name: pd.Timestamp(value) for name, value in info["split"].items() if name != "mode"}
    hour = pd.Timedelta(hours=1)
    n_validation = (split["test_start"] - split["validation_start"]) // hour - 48   # 48時間先まで収まる予測起点
    n_test = (split["end"] - split["test_start"]) // hour + 1 - 48
    for name, expected in [("selection_validation", n_validation), ("exp1_scores", n_validation),
                           ("exp2_scores", n_test), ("exp3_scores", n_test)]:
        assert (pd.read_csv(results / f"{name}.csv")["n_issue"] == expected).all(), name
    assert info["experiment1"]["n_train"] > 0 and "学習に使った行" in stdout
    exp2 = pd.read_csv(results / "exp2_scores.csv")
    excluded = stdout.split("入力が欠けていて評価から外す予測起点：")[1].split(" /")[0]
    assert (exp2["n_missing_input"] == int(excluded)).all()  # 表示した数と実験2の表の数が同じ

    # 2回目は、作ってある合成データをそのまま使うことを知らせる
    stdout = run([SCRIPTS / "run_experiments.py", "--config", config, "--results-dir", results,
                  "--figures-dir", figures, "--experiments", "2", "--skip-scenarios", "--language", "en"]).stdout
    assert "既存の合成データを使います" in stdout


def test_inconsistent_settings_stop_before_any_computation(tmp_path):
    """予測時間が max_horizon より長い設定は、データを作ったり計算したりする前に、理由を示して止める。"""
    config = write_small_config(tmp_path)
    config.write_text(config.read_text(encoding="utf-8").replace("horizons = [1, 25, 48]", "horizons = [1, 25, 72]"),
                      encoding="utf-8")
    results = tmp_path / "results"
    result = run([SCRIPTS / "run_experiments.py", "--config", config, "--results-dir", results,
                  "--figures-dir", tmp_path / "figures"], expect_success=False)
    assert result.returncode != 0
    assert "計算を始めずに止めます" in result.stderr
    assert "[experiment3] の予測時間 72 が [split] max_horizon（48）より長い" in result.stderr
    assert not results.exists() and not (tmp_path / "data").exists()   # 何も作っていない


def blank_wind_every(path, every_hours):
    """気象庁形式のCSVで、every_hours 時間ごとに風速・風向を欠測（空欄、品質情報1）にする。"""
    lines = path.read_bytes().decode("cp932").split("\r\n")
    for number in range(6, len(lines), every_hours):  # 7行目からがデータ
        cells = lines[number].split(",")
        if len(cells) == 16:
            cells[8:12] = ["", "1", "", "1"]   # 風速, 品質情報, 風向, 品質情報
            lines[number] = ",".join(cells)
    path.write_bytes("\r\n".join(lines).encode("cp932"))


def test_experiment2_keeps_the_scores_when_an_example_window_cannot_be_chosen(tmp_path):
    """36時間ごとに風が欠測すると、欠測のない48時間がないので穏やかな期間を選べない。
    成績の表は保存し、その期間の図だけを理由を付けて省く。同じフォルダで前に実行したときの
    その期間の図と表は消す（別のデータの結果と取り違えないように）。"""
    config = write_small_config(tmp_path, years=1)
    complete, gappy = tmp_path / "complete.csv", tmp_path / "gappy.csv"
    run([SCRIPTS / "generate_sample_jma_csv.py", "--output", complete, "--years", "1", "--seed", "8"])
    shutil.copy(complete, gappy)
    blank_wind_every(gappy, 36)
    results, figures = tmp_path / "results", tmp_path / "figures"
    arguments = ["--split", "last_days", "--test-days", "90", "--validation-days", "60", "--experiments", "2",
                 "--results-dir", results, "--figures-dir", figures, "--language", "en"]
    # 1回目：欠測のないデータ。どちらの期間も選べる
    run([SCRIPTS / "run_experiments.py", "--config", config, "--data", complete, *arguments])
    assert (figures / "exp2_calm_48h.png").exists() and (results / "exp2_calm_48h.csv").exists()
    # 2回目：同じフォルダに、欠測の多いデータ
    stdout = run([SCRIPTS / "run_experiments.py", "--config", config, "--data", gappy, *arguments]).stdout
    assert "図を省略します" in stdout and "前の実行で作った exp2_calm_48h.png を削除しました" in stdout
    windows = pd.read_csv(results / "exp2_windows.csv").set_index("window")
    assert pd.isna(windows.loc["calm", "first_target_time"]) and "欠測" in windows.loc["calm", "note"]
    assert not (figures / "exp2_calm_48h.png").exists() and not (results / "exp2_calm_48h.csv").exists()
    assert (figures / "exp2_abrupt_48h.png").exists() and (results / "exp2_abrupt_48h.csv").exists()
    scores = pd.read_csv(results / "exp2_scores.csv")
    assert scores["mae_deg"].notna().all() and (scores["n_test"] > 0).all()
    info = json.loads((results / "run_info.json").read_text(encoding="utf-8"))
    assert info["experiment2"]["windows"]["calm"] is None
    assert [entry["path"] for entry in info["data_files"]] == [str(gappy)]


def test_only_experiment3_does_not_use_the_settings_of_experiment2(tmp_path):
    """実行しない実験の予測時間は使わない。実験2の既定（3時間先）が max_horizon = 1 より長くても、
    実験3だけなら、入力の確認も含めて1時間先で実行できる。"""
    config = write_small_config(tmp_path)
    text = config.read_text(encoding="utf-8")
    for old, new in [("max_horizon = 48", "max_horizon = 1"), ("selection_horizon = 3", "selection_horizon = 1"),
                     ("horizons = [1, 25, 48]", "horizons = [1]")]:
        assert text.count(old) == 1
        text = text.replace(old, new)
    config.write_text(text, encoding="utf-8")
    results = tmp_path / "results"
    stdout = run([SCRIPTS / "run_experiments.py", "--config", config, "--experiments", "3", "--skip-scenarios",
                  "--results-dir", results, "--figures-dir", tmp_path / "figures", "--language", "en"]).stdout
    assert "入力の列（最終テストの段階、1時間先）" in stdout
    info = json.loads((results / "run_info.json").read_text(encoding="utf-8"))
    assert info["input_check_horizon"] == 1 and info["model_options"]["max_horizon"] == 1
    scores = pd.read_csv(results / "exp3_scores.csv")
    split = {name: pd.Timestamp(value) for name, value in info["split"].items() if name != "mode"}
    n_test = (split["end"] - split["test_start"]) // pd.Timedelta(hours=1) + 1 - 1   # 1時間先まで収まる予測起点
    assert list(scores["horizon_h"].unique()) == [1] and (scores["n_issue"] == n_test).all()
    assert not (results / "exp2_scores.csv").exists()


def split_into_two_files(source, first, second):
    """1つのCSVを、1行だけ重なる2つのファイルに分ける。

    1行目は、気象庁のファイルと同じ「ダウンロードした時刻」の書き方にする（架空の時刻）。
    """
    lines = source.read_bytes().decode("cp932").split("\r\n")
    header = lines[1:6]  # 空行、地点名、要素名、補助見出し（風向）、情報の種類
    rows = [line for line in lines[6:] if line]
    middle = len(rows) // 2
    download_line = "ダウンロードした時刻：2000/1/1 00:00:00"
    write_text(first, [download_line] + header + rows[:middle + 1])
    write_text(second, [download_line] + header + rows[middle:])


def test_run_experiments_cli_with_own_files(tmp_path):
    """--data で気象庁形式のファイルを複数渡し、最後の日数で分ける使い方（自分のデータを使うときと同じ）。"""
    config = write_small_config(tmp_path, years=1)
    source = tmp_path / "source.csv"
    run([SCRIPTS / "generate_sample_jma_csv.py", "--output", source, "--years", "1", "--seed", "8"])
    first, second = tmp_path / "part1.csv", tmp_path / "part2.csv"
    split_into_two_files(source, first, second)
    before = first.read_bytes()
    results = tmp_path / "results"
    run([SCRIPTS / "run_experiments.py", "--config", config, "--data", first, second, "--split", "last_days",
         "--test-days", "90", "--validation-days", "60", "--experiments", "2", "3",
         "--results-dir", results, "--figures-dir", tmp_path / "figures", "--language", "en"])
    assert first.read_bytes() == before  # 入力のファイルは書き換えない
    info = json.loads((results / "run_info.json").read_text(encoding="utf-8"))
    assert info["data_is_synthetic"] is False  # 1行目で判断する（渡し方では判断しない）
    assert [entry["first_line"] for entry in info["data_files"]] == ["ダウンロードした時刻：2000/1/1 00:00:00"] * 2
    assert info["split"]["mode"] == "last_days"
    scores = pd.read_csv(results / "exp2_scores.csv")
    assert set(scores["model"]) >= {"persistence", "climatology", "persistence_24h"}
    assert not (tmp_path / "data" / "sample.csv").exists()  # 合成データは作らない
    assert not (results / "scenario_scores.csv").exists()  # 実データでは補足のシナリオ比較をしない
