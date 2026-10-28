"""2つのCLIを、小さな設定で実際に実行して確かめる。"""

import json
import os
import subprocess
import sys

import pandas as pd

from conftest import PROJECT_DIR, write_text

SCRIPTS = PROJECT_DIR / "scripts"


def run(arguments):
    """CLIを実行して標準出力を返す。出力は UTF-8 で受け取る（Windowsの日本語以外の環境でも同じ）。"""
    environment = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    result = subprocess.run([sys.executable, *map(str, arguments)], capture_output=True, encoding="utf-8",
                            errors="replace", cwd=PROJECT_DIR, env=environment)
    assert result.returncode == 0, result.stderr
    return result.stdout


def write_small_config(tmp_path):
    """短時間で終わる設定ファイルを作る。"""
    config = tmp_path / "small.toml"
    config.write_text(f"""
[sample_data]
preset = "default"
seed = 3
years = 1
output = "{(tmp_path / 'data' / 'sample.csv').as_posix()}"
truth_output = "{(tmp_path / 'data' / 'truth.csv').as_posix()}"

[wind]
horizons = [1, 6]
lags = [0, 1, 3]
models = ["persistence", "climatology", "linear:calendar+recent", "degrees_as_numbers"]
test_days = 90
min_quality = 5
seed = 0
hourly_error_horizon = 6

[scenarios]
enabled = true
names = ["periodic_only"]
horizons = [1, 6]
models = ["persistence", "climatology"]

[lorenz]
n_start_points = 3
perturbation_sizes = [1e-6, 1e-3]
n_steps = 1500
dt = 0.01
tolerance = 1.0
benettin_steps = 2000
seed = 0
""", encoding="utf-8")
    return config


def test_generate_sample_csv_cli(tmp_path):
    output = tmp_path / "sample.csv"
    truth = tmp_path / "truth.csv"
    stdout = run([SCRIPTS / "generate_sample_jma_csv.py", "--output", output, "--years", "1", "--seed", "5",
                  "--preset", "periodic_ar", "--truth-output", truth, "--set", "ar_strength=1.5"])
    assert output.exists() and truth.exists()
    assert "気象庁の観測値ではありません" in stdout
    assert "ar_strength = 1.5" in stdout
    first_line = output.read_bytes().decode("cp932").splitlines()[0]
    assert first_line.startswith("合成データ") and "ar_strength=1.5" in first_line


def test_run_experiments_cli_with_a_small_config(tmp_path):
    config = write_small_config(tmp_path)
    data = tmp_path / "data" / "sample.csv"
    results = tmp_path / "results"
    figures = tmp_path / "figures"
    stdout = run([SCRIPTS / "run_experiments.py", "--config", config, "--results-dir", results,
                  "--figures-dir", figures])
    assert data.exists()
    for name in ["wind_scores.csv", "wind_error_by_hour_h6.csv", "scenario_scores.csv",
                 "lorenz_predictability.csv", "lorenz_summary.json", "run_info.json"]:
        assert (results / name).exists(), name
    for name in ["wind_error_vs_horizon.png", "wind_direction_by_hour.png", "scenario_comparison.png",
                 "lorenz_separation_growth.png", "ar1_vs_lorenz.png"]:
        assert (figures / name).stat().st_size > 10_000, name
    info = json.loads((results / "run_info.json").read_text(encoding="utf-8"))
    assert info["data_is_synthetic"] is True
    assert len(info["data_files"][0]["sha256"]) == 64
    assert info["data_files"][0]["first_line"].startswith("合成データ")
    assert info["environment"]["numpy"]
    assert "git_has_uncommitted_changes" in info["environment"]
    assert "平均絶対角度誤差" in stdout
    summary = json.loads((results / "lorenz_summary.json").read_text(encoding="utf-8"))
    assert "not hours" in summary["time_unit"]

    # 2回目は、作ってある合成データをそのまま使うことを知らせる
    stdout = run([SCRIPTS / "run_experiments.py", "--config", config, "--results-dir", results,
                  "--figures-dir", figures, "--skip-scenarios", "--skip-lorenz"])
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
    """--data で気象庁形式のファイルを複数渡す使い方（自分のデータを使うときと同じ手順）。"""
    config = write_small_config(tmp_path)
    source = tmp_path / "source.csv"
    run([SCRIPTS / "generate_sample_jma_csv.py", "--output", source, "--years", "1", "--seed", "8"])
    first, second = tmp_path / "part1.csv", tmp_path / "part2.csv"
    split_into_two_files(source, first, second)
    results = tmp_path / "results"
    run([SCRIPTS / "run_experiments.py", "--config", config, "--data", first, second,
         "--results-dir", results, "--figures-dir", tmp_path / "figures", "--skip-scenarios", "--skip-lorenz"])
    info = json.loads((results / "run_info.json").read_text(encoding="utf-8"))
    assert info["data_is_synthetic"] is False  # 1行目で判断する（渡し方では判断しない）
    assert [entry["first_line"] for entry in info["data_files"]] == ["ダウンロードした時刻：2000/1/1 00:00:00"] * 2
    assert info["wind"]["n_hours"] == 365 * 24  # 重なった1行は1回だけ数える
    scores = pd.read_csv(results / "wind_scores.csv")
    assert sorted(scores["horizon_h"].unique()) == [1, 6]
    assert scores.groupby("horizon_h")["n_test"].nunique().eq(1).all()
    assert not (tmp_path / "data" / "sample.csv").exists()  # 合成データは作らない
