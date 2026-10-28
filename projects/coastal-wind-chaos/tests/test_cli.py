"""2つのCLIを、小さな設定で実際に実行して確かめる。"""

import json
import os
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
    """短時間で終わる設定ファイルを作る。"""
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
max_horizon = 72

[models]
candidates = ["linear", "boosting_shallow"]
selection_horizon = 3
lags = [0, 1, 2, 3, 6, 12, 24]
seed = 0

[experiment1]
horizon = 3
methods = ["linear"]

[experiment2]
horizon = 3
window_hours = 48

[experiment3]
horizons = [1, 25, 72]
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
    assert sorted(scores["horizon_h"].unique()) == [1, 25, 72]
    assert scores.groupby("horizon_h")["n_issue"].nunique().eq(1).all()
    assert scores["n_issue"].nunique() == 1  # どの予測時間でも同じ予測起点
    assert {"vector_rmse_ms", "n_undefined", "n_calm_target", "n_missing_input"} <= set(scores.columns)
    assert "検証期間で統合モデルの設定を選ぶ" in stdout
    assert "入力が欠けていて評価から外す予測起点" in stdout
    exp2 = pd.read_csv(results / "exp2_scores.csv")
    excluded = stdout.split("入力が欠けていて評価から外す予測起点：")[1].split(" /")[0]
    assert (exp2["n_missing_input"] == int(excluded)).all()  # 表示した数と実験2の表の数が同じ

    # 2回目は、作ってある合成データをそのまま使うことを知らせる
    stdout = run([SCRIPTS / "run_experiments.py", "--config", config, "--results-dir", results,
                  "--figures-dir", figures, "--experiments", "2", "--skip-scenarios", "--language", "en"]).stdout
    assert "既存の合成データを使います" in stdout


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
