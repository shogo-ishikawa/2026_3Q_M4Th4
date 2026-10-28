"""4つの実験を、設定ファイルに従って実行するCLI。

実験1：角度の罠（検証期間）　実験2：3時間先の特徴量の比較（最終テスト期間）
実験3：予測時間の比較（最終テスト期間）　実験4：ローレンツ系（風向きの予測とは独立）

作品フォルダ（projects/coastal-wind-chaos/）で実行する例：
    python scripts/run_experiments.py                                   # configs/fast.toml
    python scripts/run_experiments.py --config configs/full.toml        # 1〜72時間のすべて
    python scripts/run_experiments.py --experiments 1 2                 # 実験1と2だけ
    python scripts/run_experiments.py --data data/raw/a_2023.csv data/raw/a_2024.csv --split last_days --test-days 180 --validation-days 180

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
    experiments,
    lorenz_demo,
    plotting,
    sample_data,
    wind_pipeline,
)


def parse_args():
    parser = argparse.ArgumentParser(description="風向き予測の実験1〜3と、ローレンツ系の実験4を実行します。")
    parser.add_argument("--config", type=Path, default=PROJECT_DIR / "configs" / "fast.toml",
                        help="設定ファイル（既定：configs/fast.toml）")
    parser.add_argument("--data", type=Path, nargs="+",
                        help="気象庁形式の時別値CSV（複数可、読むだけで書き換えない）。省略すると設定の合成データを使う")
    parser.add_argument("--regenerate", action="store_true", help="合成データがあっても作り直す")
    parser.add_argument("--experiments", type=int, nargs="+", choices=[1, 2, 3, 4], default=[1, 2, 3, 4],
                        help="実行する実験の番号（既定：1 2 3 4）")
    parser.add_argument("--split", choices=["years", "last_days"],
                        help="時間の分け方（設定の [split] mode を上書き）")
    parser.add_argument("--test-days", type=int, help="last_days のときの最終テスト期間の日数")
    parser.add_argument("--validation-days", type=int, help="last_days のときの検証期間の日数（0 なら検証なし）")
    parser.add_argument("--min-quality", type=int, choices=[8, 5, 4],
                        help="使う品質情報の下限（既定は設定の値。8 = 正常値だけ、5 = 準正常値も使う）")
    parser.add_argument("--language", choices=["auto", "ja", "en"], default="auto",
                        help="図の文字（auto：日本語フォントがあれば日本語、なければ英語）")
    parser.add_argument("--results-dir", type=Path, default=PROJECT_DIR / "results",
                        help="結果の表を保存するフォルダ（既定：results/）")
    parser.add_argument("--figures-dir", type=Path, default=PROJECT_DIR / "figures",
                        help="図を保存するフォルダ（既定：figures/）")
    parser.add_argument("--skip-scenarios", action="store_true", help="合成データの成分を変えた補足の比較をしない")
    parser.add_argument("--skip-wind", action="store_true", help="実験1〜3（風向き予測）をしない")
    parser.add_argument("--skip-lorenz", action="store_true", help="実験4（ローレンツ系）をしない")
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


def horizons_from(settings):
    """horizons（一覧）か horizon_range（[最初, 最後]、両端を含むすべての整数）から予測時間の一覧を作る。"""
    if "horizon_range" in settings:
        first, last = settings["horizon_range"]
        return list(range(first, last + 1))
    return list(settings["horizons"])


def check_settings(config, args):
    """計算を始める前に、設定の矛盾を調べる。矛盾があれば、何も計算せずに理由を示して止める。

    例えば、予測時間が [split] max_horizon（共通の予測起点を決める最長の予測時間）より長い設定。
    """
    max_horizon = config["split"]["max_horizon"]
    lags = config["models"]["lags"]
    problems = []
    if not isinstance(max_horizon, int) or max_horizon < 1:
        problems.append(f"[split] max_horizon は1以上の整数にしてください（今は {max_horizon!r}）")
        max_horizon = None
    if not lags or not all(isinstance(lag, int) and lag >= 0 for lag in lags):
        problems.append(f"[models] lags は0以上の整数の一覧にしてください（今は {lags!r}）")
    horizons = {}
    if any(number in (1, 2, 3) for number in args.experiments) and not args.skip_wind:
        horizons["[models] selection_horizon"] = [config["models"]["selection_horizon"]]
        if 1 in args.experiments:
            horizons["[experiment1] horizon"] = [config["experiment1"]["horizon"]]
        if 2 in args.experiments:
            horizons["[experiment2] horizon"] = [config["experiment2"]["horizon"]]
        if 3 in args.experiments:
            horizons["[experiment3]"] = horizons_from(config["experiment3"])
        if config["scenarios"]["enabled"] and not args.skip_scenarios and not args.data:
            horizons["[scenarios]"] = horizons_from(config["scenarios"])
    for name, values in horizons.items():
        if not all(isinstance(value, int) and value >= 1 for value in values):
            problems.append(f"{name} の予測時間は1以上の整数にしてください（今は {values}）")
        elif max_horizon is not None and max(values) > max_horizon:
            problems.append(f"{name} の予測時間 {max(values)} が [split] max_horizon（{max_horizon}）より長いです")
    if problems:
        raise SystemExit("設定に矛盾があるので、計算を始めずに止めます（" + str(args.config) + "）：\n- "
                         + "\n- ".join(problems))


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


def make_split(weather, args, config):
    """設定とコマンドラインの指定から、時間の分け方を決める。"""
    settings = dict(config["split"])
    for name, value in [("mode", args.split), ("test_days", args.test_days), ("validation_days", args.validation_days)]:
        if value is not None:
            settings[name] = value
    return wind_pipeline.make_split(weather, settings["mode"], settings["test_days"], settings["validation_days"])


def print_table(title, table, columns=None):
    print(f"\n{title}")
    print((table if columns is None else table[columns]).round(2).to_string(index=False))


def save(fig, figures_dir, name, saved):
    saved.append(str(plotting.save_figure(fig, figures_dir / name)))
    plt.close(fig)


def run_data_overview(weather, split, max_horizon, results_dir, figures_dir, saved):
    """データの要約と、時間の分け方の図。"""
    summary = wind_pipeline.summarise_weather(weather)
    summary.to_csv(results_dir / "data_summary.csv", index=False)
    print(summary.to_string(index=False))
    save(plotting.plot_direction_by_hour(weather), figures_dir, "data_direction_by_hour.png", saved)
    save(plotting.plot_time_split(weather, split, max_horizon), figures_dir, "time_split.png", saved)


def model_options(config):
    """どの実験にも同じ値を渡す設定：u, v の「何時間前」（[models] lags）と、共通の予測起点を決める
    最長の予測時間（[split] max_horizon）。"""
    return {"lags": tuple(config["models"]["lags"]), "max_horizon": config["split"]["max_horizon"]}


def run_input_check(weather, split, horizon, config, results_dir):
    """最終テストの段階で使う入力の列と、欠けている入力で評価から外す予測起点の数。"""
    options = model_options(config)
    stage = wind_pipeline.prepare_stage(weather, horizon, split, "test", options["lags"], options["max_horizon"])
    columns = wind_pipeline.input_column_table(stage)
    columns.to_csv(results_dir / "input_columns.csv", index=False)
    unused = columns.loc[~columns["used"], "column"].tolist()
    missing = columns[columns["used"] & (columns["n_missing"] > 0)].sort_values("n_missing", ascending=False)
    largest = ", ".join(f"{name} {count}" for name, count in zip(missing["column"][:5], missing["n_missing"][:5]))
    n_excluded = int((stage["evaluation"]["excluded"] == wind_pipeline.EXCLUDED_INPUT).sum())
    print(f"\n入力の列（最終テストの段階、{horizon}時間先）：{int(columns['used'].sum())} 列を使う。"
          f"使わない気温・気圧・日照の列：{unused or 'なし'}（データにない、または学習期間に値が半分未満）")
    print(f"入力が欠けていて評価から外す予測起点：{n_excluded} / {len(stage['evaluation'])} 件"
          f"（欠けている数が多い列：{largest or 'なし'}。すべての列は input_columns.csv）")


SCORE_COLUMNS = ["model", "mae_deg", "within_45_pct", "vector_rmse_ms", "n_test", "n_undefined", "undefined_pct"]


def run_experiment1(weather, split, config, results_dir, figures_dir, saved):
    settings = config["experiment1"]
    stage = "validation" if split.get("validation_start") is not None else "test"
    result = experiments.experiment_angle(weather, split, settings["methods"], settings["horizon"], stage,
                                          config["models"]["seed"], **model_options(config))
    for name in ["means", "scores", "north"]:
        result[name].to_csv(results_dir / f"exp1_{name}.csv", index=False)
    result["by_direction"].to_csv(results_dir / "exp1_by_direction.csv")
    save(plotting.plot_angle_trap(result["by_direction"], result["forecasts"], result["pairs"][0]),
         figures_dir, "exp1_angle_trap.png", saved)
    print_table("実験1：337.5度と22.5度の平均", result["means"])
    print_table(f"実験1：同じ入力・同じ設定での u, v 回帰と角度の直接回帰（{settings['horizon']}時間先、{stage}期間）",
                result["scores"], SCORE_COLUMNS)
    print(f"学習に使った行：{result['n_train']} 行（u, v の回帰と角度の回帰で同じ。"
          f"対象時刻が静穏の {result['n_calm_train']} 行は、角度が決まらないので両方とも除く）")
    print_table("実験1：観測した風向が北から22.5度以内の時刻", result["north"])
    return {"stage": stage, "n_train": result["n_train"], "n_calm_train": result["n_calm_train"]}


def run_experiment2(weather, split, integrated, config, results_dir, figures_dir, saved):
    settings = config["experiment2"]
    result = experiments.experiment_features(weather, split, integrated, settings["horizon"],
                                             config["models"]["seed"], settings["window_hours"],
                                             **model_options(config))
    result["scores"].to_csv(results_dir / "exp2_scores.csv", index=False)
    windows = []
    for name, window in result["windows"].items():
        fig = plotting.plot_example(result, name)  # 規則どおりに選べなかった期間は、図を作らずに理由を表示する
        if fig is None:  # 成績の表は保存し、省略した図と理由を記録する（条件を緩めて別の期間を選ばない）
            windows.append({"window": name, "first_target_time": None, "last_target_time": None,
                            "note": result["window_notes"][name]})
            continue
        result["examples"][name].to_csv(results_dir / f"exp2_{name}_48h.csv", index=False)
        windows.append({"window": name, "first_target_time": window[0], "last_target_time": window[1], "note": ""})
        save(fig, figures_dir, f"exp2_{name}_48h.png", saved)
    hourly = wind_pipeline.error_by_hour(result["forecasts"], result["models"])
    save(plotting.plot_error_by_hour(hourly), figures_dir, "exp2_error_by_hour.png", saved)
    pd.DataFrame(windows).to_csv(results_dir / "exp2_windows.csv", index=False)
    print_table(f"実験2：{settings['horizon']}時間先、最終テスト期間（統合モデルの設定：{integrated}）",
                result["scores"], SCORE_COLUMNS + ["n_calm_target", "n_missing_target", "n_missing_input"])
    chosen = {name: [str(window[0]), str(window[1])] if window else None for name, window in result["windows"].items()}
    print(f"例の{settings['window_hours']}時間（観測値だけから選んだ期間、対象時刻）:", chosen)
    return {"windows": chosen, "window_notes": result["window_notes"]}


def run_experiment3(weather, split, integrated, horizons, config, results_dir, figures_dir, saved):
    settings = config["experiment3"]
    result = experiments.experiment_horizons(weather, split, integrated, horizons, config["models"]["seed"],
                                             settings.get("extra_models", []), **model_options(config))
    result["scores"].to_csv(results_dir / "exp3_scores.csv", index=False)
    result["counts"].to_csv(results_dir / "exp3_counts.csv", index=False)
    save(plotting.plot_error_vs_horizon(result["scores"], result["models"]), figures_dir,
         "exp3_error_vs_horizon.png", saved)
    save(plotting.plot_vector_rmse_vs_horizon(result["scores"], result["models"]), figures_dir,
         "exp3_vector_rmse_vs_horizon.png", saved)
    table = result["scores"].pivot(index="model", columns="horizon_h", values="mae_deg").loc[result["models"]]
    shown = shown_horizons(horizons)
    print(f"\n実験3：平均絶対角度誤差（度）、最終テスト期間（{len(horizons)}通りの予測時間のうち一部を表示）")
    print(table[shown].round(1).to_string())
    print("\n予測時間ごとの評価件数と、外した件数")
    print(result["counts"][result["counts"]["horizon_h"].isin(shown)].to_string(index=False))
    return {"horizons": horizons}


def shown_horizons(horizons):
    """画面に表示する予測時間（多いときは代表的なものだけ。保存する表にはすべて入れる）。"""
    return horizons if len(horizons) <= 12 else [h for h in horizons if h in (1, 3, 6, 12, 18, 24, 36, 48, 72)]


def run_scenarios(config, results_dir, figures_dir, saved):
    """補足：合成データの成分を変え、同じ手法の誤差を比べる（原因を区別するため）。"""
    scenarios = config["scenarios"]
    settings = config["sample_data"]
    weather_by_scenario = {
        name: sample_data.generate_weather(name, seed=settings["seed"], years=settings["years"])
        for name in scenarios["names"]
    }
    options = model_options(config)
    scores = wind_pipeline.run_scenario_experiment(weather_by_scenario, horizons_from(scenarios), scenarios["models"],
                                                   lags=options["lags"], seed=config["models"]["seed"],
                                                   max_horizon=options["max_horizon"])
    scores.to_csv(results_dir / "scenario_scores.csv", index=False)
    save(plotting.plot_scenario_comparison(scores, scenarios["models"]), figures_dir, "scenario_comparison.png", saved)
    print("\n補足：シナリオ別の平均絶対角度誤差（度）、最終テスト期間（一部の予測時間を表示）")
    for name in scenarios["names"]:
        part = scores[scores["scenario"] == name]
        print(f"[{name}] {sample_data.PRESET_LABELS[name]}")
        table = part.pivot(index="model", columns="horizon_h", values="mae_deg").loc[scenarios["models"]]
        print(table[shown_horizons(horizons_from(scenarios))].round(1).to_string())


def run_experiment4(config, results_dir, figures_dir, saved):
    lorenz = config["lorenz"]
    result = experiments.experiment_lorenz(
        lorenz["n_start_points"], lorenz["perturbation_sizes"], lorenz["tolerance"], lorenz["n_steps"],
        lorenz["dt"], lorenz["benettin_steps"], lorenz["check_dts"], lorenz["seed"])
    result["predictability"].to_csv(results_dir / "exp4_predictability.csv", index=False)
    result["time_steps"].to_csv(results_dir / "exp4_time_steps.csv", index=False)
    (results_dir / "exp4_summary.json").write_text(json.dumps(result["summary"], indent=2), encoding="utf-8")
    save(plotting.plot_twin_runs(result["twin_runs"]), figures_dir, "exp4_twin_runs.png", saved)
    save(plotting.plot_separation_growth(result["times"], result["distances"], lorenz["tolerance"],
                                         result["growth_rate"]), figures_dir, "exp4_separation_growth.png", saved)
    save(plotting.plot_predictability_times(result["predictability"], lorenz["tolerance"]), figures_dir,
         "exp4_predictability_times.png", saved)
    save(plotting.plot_time_step_check(result["time_steps"]), figures_dir, "exp4_time_step_check.png", saved)
    save(plotting.plot_ar1_vs_lorenz(result["ar_twin"], result["ar_error"], result["times"], result["distances"]),
         figures_dir, "exp4_ar1_vs_lorenz.png", saved)
    print("\n実験4：ローレンツ系、距離が許容誤差に達するまでの時間（無次元の時間）")
    print(result["predictability"].to_string(index=False, float_format="{:.2f}".format,
                                             formatters={"initial_error": "{:.0e}".format}))
    print(f"距離の対数の傾き（成長率）: {result['growth_rate']:.3f}")
    print(f"Benettin法による最大リアプノフ指数: {result['benettin']:.3f}（文献値 約{lorenz_demo.REFERENCE_LYAPUNOV_EXPONENT}）")
    print("積分の刻み dt を変えた確認（時間の中央値と、Benettin法の指数）")
    print(result["time_steps"][["dt", "initial_error", "median_time", "n_reached", "benettin_lyapunov"]]
          .to_string(index=False, float_format="{:.3f}".format,
                     formatters={"dt": "{:g}".format, "initial_error": "{:.0e}".format}))
    return result["summary"]


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # 出力をファイルに書き出しても、日本語で失敗しないようにする
    args = parse_args()
    config = load_config(args.config)
    check_settings(config, args)
    args.results_dir.mkdir(parents=True, exist_ok=True)
    args.figures_dir.mkdir(parents=True, exist_ok=True)
    language = plotting.apply_style(args.language)
    info = {"config_file": str(args.config), "config": config, "experiments": args.experiments,
            "figure_language": language, "figure_font": plotting.FONT_NAME,
            "environment": environment_info(PROJECT_DIR)}
    saved = []
    started = time.perf_counter()
    wind_experiments = [number for number in args.experiments if number in (1, 2, 3)]

    if wind_experiments and not args.skip_wind:
        data_paths = prepare_data_paths(args, config)
        # 1行目には、気象庁のファイルなら「ダウンロードした時刻」が書かれている（データは後で修正されることがある）
        info["data_files"] = [
            {"path": str(path), "sha256": file_sha256(path),
             "first_line": wind_pipeline.read_text(path).splitlines()[0][:200]}
            for path in data_paths
        ]
        # 合成データのCSVは1行目が「合成データ」で始まる（--data で渡したときも同じ）
        info["data_is_synthetic"] = all(entry["first_line"].startswith("合成データ") for entry in info["data_files"])
        min_quality = args.min_quality or config["data"]["min_quality"]
        info["min_quality"] = min_quality
        weather = wind_pipeline.load_weather(data_paths, min_quality=min_quality)
        split = make_split(weather, args, config)
        info["split"] = {name: str(value) for name, value in split.items()}
        info["model_options"] = model_options(config)  # 選択と実験1〜3に渡した lags と max_horizon
        run_data_overview(weather, split, config["split"]["max_horizon"], args.results_dir, args.figures_dir, saved)
        print(f"時間の分け方：{info['split']}")
        print(f"u, v の「何時間前」（lags）：{info['model_options']['lags']}　"
              f"共通の予測起点を決める最長の予測時間（max_horizon）：{info['model_options']['max_horizon']}")
        run_input_check(weather, split, config["experiment2"]["horizon"], config, args.results_dir)

        models = config["models"]
        selection, integrated = experiments.select_integrated(weather, split, models["selection_horizon"],
                                                             models["candidates"], models["seed"],
                                                             **model_options(config))
        info["integrated_model"] = integrated
        if selection is None:
            print(f"\n検証期間がないので、統合モデルの設定は既定の {integrated} を使います。")
        else:
            selection.to_csv(args.results_dir / "selection_validation.csv", index=False)
            print_table(f"検証期間で統合モデルの設定を選ぶ（{models['selection_horizon']}時間先）→ {integrated}",
                        selection, ["candidate", "mae_deg", "within_45_pct", "vector_rmse_ms", "n_test", "selected"])
        if 1 in wind_experiments:
            info["experiment1"] = run_experiment1(weather, split, config, args.results_dir, args.figures_dir, saved)
        if 2 in wind_experiments:
            info["experiment2"] = run_experiment2(weather, split, integrated, config, args.results_dir,
                                                  args.figures_dir, saved)
        if 3 in wind_experiments:
            horizons = horizons_from(config["experiment3"])
            info["experiment3"] = run_experiment3(weather, split, integrated, horizons, config, args.results_dir,
                                                  args.figures_dir, saved)
        if not args.skip_scenarios and not args.data and config["scenarios"]["enabled"]:
            run_scenarios(config, args.results_dir, args.figures_dir, saved)
    if 4 in args.experiments and not args.skip_lorenz:
        info["experiment4"] = run_experiment4(config, args.results_dir, args.figures_dir, saved)

    info["figures"] = saved
    info["elapsed_seconds"] = round(time.perf_counter() - started, 1)
    (args.results_dir / "run_info.json").write_text(
        json.dumps(info, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    print(f"\n完了（{info['elapsed_seconds']} 秒）。結果: {args.results_dir}  図: {args.figures_dir}")


if __name__ == "__main__":
    main()
