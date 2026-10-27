"""2つのCLIを、小さな設定で実際に実行して確かめる。"""

import json
import subprocess
import sys

from conftest import PROJECT_DIR

SCRIPTS = PROJECT_DIR / "scripts"


def run(arguments):
    result = subprocess.run([sys.executable, *map(str, arguments)], capture_output=True, text=True, cwd=PROJECT_DIR)
    assert result.returncode == 0, result.stderr
    return result.stdout


def test_generate_sample_csv_cli(tmp_path):
    output = tmp_path / "sample.csv"
    truth = tmp_path / "truth.csv"
    stdout = run([SCRIPTS / "generate_sample_jma_csv.py", "--output", output, "--years", "1", "--seed", "5",
                  "--preset", "periodic_ar", "--truth-output", truth, "--set", "ar_strength=1.5"])
    assert output.exists() and truth.exists()
    assert "気象庁の観測値ではありません" in stdout
    assert "ar_strength = 1.5" in stdout
    assert output.read_bytes().decode("cp932").startswith("合成データ")


def test_run_experiments_cli_with_a_small_config(tmp_path):
    data = tmp_path / "data" / "sample.csv"
    config = tmp_path / "small.toml"
    config.write_text(f"""
[sample_data]
preset = "default"
seed = 3
years = 1
output = "{data.as_posix()}"
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
    assert "平均絶対角度誤差" in stdout
