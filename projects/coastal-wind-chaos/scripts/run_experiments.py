"""風向き予測の実験と、ローレンツ系の実験を、設定ファイルに従って実行するCLI。

作品フォルダ（projects/coastal-wind-chaos/）で実行する例：
    python scripts/run_experiments.py                              # configs/fast.toml
    python scripts/run_experiments.py --config configs/full.toml
    python scripts/run_experiments.py --data data/raw/my_station.csv --skip-scenarios

データファイルがなければ、設定の [sample_data] に従って合成データを作ります。
結果の表は results/、図は figures/ に保存します（どちらもGitの管理対象外）。
"""

import argparse
import hashlib
import json
import sys
import time
import tomllib
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # 画面のない環境でも図を保存できるようにする

import matplotlib.pyplot as plt  # noqa: E402
import pandas as pd  # noqa: E402

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "src"))  # インストールしていなくても読み込めるようにする

from coastal_wind_chaos import (  # noqa: E402
    environment_info,
    lorenz_demo,
    plotting,
    sample_data,
    wind_pipeline,
)


def parse_args():
    parser = argparse.ArgumentParser(description="風向き予測の実験とローレンツ系の実験を実行します。")
    parser.add_argument("--config", type=Path, default=PROJECT_DIR / "configs" / "fast.toml",
                        help="設定ファイル（既定：configs/fast.toml）")
    parser.add_argument("--data", type=Path, nargs="+",
                        help="気象庁形式の時別値CSV（複数可）。省略すると設定の合成データを使う")
    parser.add_argument("--regenerate", action="store_true", help="合成データがあっても作り直す")
    parser.add_argument("--results-dir", type=Path, default=PROJECT_DIR / "results",
                        help="結果の表を保存するフォルダ（既定：results/）")
    parser.add_argument("--figures-dir", type=Path, default=PROJECT_DIR / "figures",
                        help="図を保存するフォルダ（既定：figures/）")
    parser.add_argument("--skip-wind", action="store_true", help="風向き予測の実験をしない")
    parser.add_argument("--skip-scenarios", action="store_true", help="合成データのシナリオ比較をしない")
    parser.add_argument("--skip-lorenz", action="store_true", help="ローレンツ系の実験をしない")
    return parser.parse_args()


def load_config(path):
    with open(path, "rb") as file:
        return tomllib.load(file)


def project_path(path):
    """設定ファイルの相対パスを、作品フォルダを基準にした絶対パスにする。"""
    path = Path(path)
    return path if path.is_absolute() else PROJECT_DIR / path


def file_sha256(path):
    """ファイルの内容から作る識別用の値（同じデータを使ったか確かめるため）。"""
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def prepare_data_paths(args, config):
    """使うデータファイルの一覧。指定がなければ合成データを（なければ作って）使う。"""
    if args.data:
        return list(args.data)
    settings = config["sample_data"]
    output = project_path(settings["output"])
    if args.regenerate or not output.exists():
        print(f"合成データを作ります: {output}")
        sample_data.generate_sample_csv(
            output, settings["preset"], project_path(settings["truth_output"]),
            seed=settings["seed"], years=settings["years"],
        )
    else:
        print(f"既存の合成データを使います: {output}（設定を変えたときは --regenerate で作り直す）")
    return [output]


def run_wind(config, data_paths, results_dir, figures_dir):
    """風向き予測の実験：予測時間ごとの誤差、時刻別の誤差、データの図。"""
    wind = config["wind"]
    weather = wind_pipeline.load_weather(data_paths, min_quality=wind["min_quality"])
    print(wind_pipeline.summarise_weather(weather).to_string(index=False))
    test_start = wind_pipeline.default_test_start(weather, wind["test_days"])
    print(f"テスト期間：{test_start} から {weather.index.max()} まで（それより前で学習）")

    scores = wind_pipeline.run_horizon_experiment(
        weather, wind["horizons"], wind["models"], test_start, wind["lags"], wind["seed"])
    scores.to_csv(results_dir / "wind_scores.csv", index=False)
    plotting.save_figure(plotting.plot_error_vs_horizon(scores), figures_dir / "wind_error_vs_horizon.png")

    horizon = wind["hourly_error_horizon"]
    forecasts = wind_pipeline.forecast_one_horizon(
        weather, horizon, wind["models"], test_start, wind["lags"], wind["seed"])
    hourly = wind_pipeline.error_by_hour(forecasts, wind["models"])
    hourly.to_csv(results_dir / f"wind_error_by_hour_h{horizon}.csv")
    plotting.save_figure(
        plotting.plot_error_by_hour(hourly, f"Error by hour of day, {horizon} hours ahead (test period)"),
        figures_dir / f"wind_error_by_hour_h{horizon}.png")
    plotting.save_figure(plotting.plot_direction_by_hour(weather), figures_dir / "wind_direction_by_hour.png")
    week_start = min(test_start + pd.Timedelta(days=181), weather.index.max() - pd.Timedelta(days=7))
    plotting.save_figure(plotting.plot_direction_timeseries(weather, week_start.normalize()),
                         figures_dir / "wind_timeseries_week.png")
    plt.close("all")

    table = scores.pivot(index="model", columns="horizon_h", values="mae_deg").loc[wind["models"]]
    print("\n平均絶対角度誤差（度）：行が手法、列が何時間先か")
    print(table.round(1).to_string())
    return {"test_start": str(test_start), "n_hours": len(weather)}


def run_scenarios(config, results_dir, figures_dir):
    """合成データの成分を変え、同じ手法の誤差を比べる（原因を区別するための実験）。"""
    scenarios = config["scenarios"]
    settings = config["sample_data"]
    weather_by_scenario = {
        name: sample_data.generate_weather(name, seed=settings["seed"], years=settings["years"])
        for name in scenarios["names"]
    }
    scores = wind_pipeline.run_scenario_experiment(
        weather_by_scenario, scenarios["horizons"], scenarios["models"],
        config["wind"]["test_days"], config["wind"]["lags"], config["wind"]["seed"])
    scores.to_csv(results_dir / "scenario_scores.csv", index=False)
    plotting.save_figure(plotting.plot_scenario_comparison(scores, scenarios["models"]),
                         figures_dir / "scenario_comparison.png")
    plt.close("all")
    print("\nシナリオ別の平均絶対角度誤差（度）")
    for name in scenarios["names"]:
        part = scores[scores["scenario"] == name]
        print(f"[{name}] {sample_data.PRESET_LABELS[name]}")
        print(part.pivot(index="model", columns="horizon_h", values="mae_deg")
              .loc[scenarios["models"]].round(1).to_string())


def run_lorenz(config, results_dir, figures_dir):
    """ローレンツ系の双子実験と、安定なAR(1)の対照実験。"""
    lorenz = config["lorenz"]
    points = lorenz_demo.attractor_points(lorenz["n_start_points"], seed=lorenz["seed"], dt=lorenz["dt"])
    table = lorenz_demo.predictability_table(
        points, lorenz["perturbation_sizes"], lorenz["tolerance"], lorenz["n_steps"], lorenz["dt"], lorenz["seed"])
    table.to_csv(results_dir / "lorenz_predictability.csv", index=False)

    smallest = min(lorenz["perturbation_sizes"])
    times, distances = lorenz_demo.twin_distances(points, smallest, lorenz["n_steps"], lorenz["dt"], lorenz["seed"])
    growth_rate = lorenz_demo.fit_growth_rate(times, distances, smallest * 100, lorenz["tolerance"] / 10)
    benettin = lorenz_demo.estimate_lyapunov_benettin(points[0], lorenz["benettin_steps"], lorenz["dt"])
    summary = {
        "fitted_growth_rate": growth_rate,
        "benettin_lyapunov_exponent": benettin,
        "reference_lyapunov_exponent": lorenz_demo.REFERENCE_LYAPUNOV_EXPONENT,
        "time_unit": "dimensionless Lorenz time (not hours)",
    }
    (results_dir / "lorenz_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    runs = lorenz_demo.twin_runs(points[0], 1e-6, lorenz["n_steps"], lorenz["dt"], lorenz["seed"])
    plotting.save_figure(plotting.plot_twin_runs(runs), figures_dir / "lorenz_twin_runs.png")
    plotting.save_figure(plotting.plot_separation_growth(times, distances, lorenz["tolerance"], growth_rate),
                         figures_dir / "lorenz_separation_growth.png")
    plotting.save_figure(plotting.plot_predictability_times(table, lorenz["tolerance"]),
                         figures_dir / "lorenz_predictability_times.png")
    ar_twin = lorenz_demo.ar1_twin(seed=lorenz["seed"])
    ar_error = lorenz_demo.ar1_forecast_error_std()
    plotting.save_figure(plotting.plot_ar1_vs_lorenz(ar_twin, ar_error, times, distances),
                         figures_dir / "ar1_vs_lorenz.png")
    plt.close("all")

    print("\nローレンツ系：距離が許容誤差に達するまでの時間（無次元の時間）")
    print(table.to_string(index=False, float_format="{:.2f}".format,
                          formatters={"initial_error": "{:.0e}".format}))
    print(f"距離の対数の傾き（成長率）: {growth_rate:.3f}")
    print(f"Benettin法による最大リアプノフ指数: {benettin:.3f}（文献値 約{lorenz_demo.REFERENCE_LYAPUNOV_EXPONENT}）")
    return summary


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # 出力をファイルに書き出しても、日本語で失敗しないようにする
    args = parse_args()
    config = load_config(args.config)
    args.results_dir.mkdir(parents=True, exist_ok=True)
    args.figures_dir.mkdir(parents=True, exist_ok=True)
    plotting.apply_style()
    info = {"config_file": str(args.config), "config": config, "environment": environment_info(PROJECT_DIR)}
    started = time.perf_counter()

    if not args.skip_wind:
        data_paths = prepare_data_paths(args, config)
        # 1行目には、気象庁のファイルなら「ダウンロードした時刻」が書かれている（データは後で修正されることがある）
        info["data_files"] = [
            {"path": str(path), "sha256": file_sha256(path),
             "first_line": wind_pipeline.read_text(path).splitlines()[0][:200]}
            for path in data_paths
        ]
        # 合成データのCSVは1行目が「合成データ」で始まる（--data で渡したときも同じ）
        info["data_is_synthetic"] = all(entry["first_line"].startswith("合成データ") for entry in info["data_files"])
        info["wind"] = run_wind(config, data_paths, args.results_dir, args.figures_dir)
    if not args.skip_scenarios and config["scenarios"]["enabled"]:
        run_scenarios(config, args.results_dir, args.figures_dir)
    if not args.skip_lorenz:
        info["lorenz"] = run_lorenz(config, args.results_dir, args.figures_dir)

    info["elapsed_seconds"] = round(time.perf_counter() - started, 1)
    (args.results_dir / "run_info.json").write_text(
        json.dumps(info, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    print(f"\n完了（{info['elapsed_seconds']} 秒）。結果: {args.results_dir}  図: {args.figures_dir}")


if __name__ == "__main__":
    main()
