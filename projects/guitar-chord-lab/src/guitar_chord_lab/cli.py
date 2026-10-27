"""コマンドラインから使うための入口です。Notebook と同じ関数を呼び出します。

例（作品フォルダ projects/guitar-chord-lab で実行）:
    guitar-chord-lab demo
    guitar-chord-lab analyse data/generated/demo/demo_a_guitar.wav --start 0 --duration 18
    guitar-chord-lab analyse song.wav --separate --device auto
    guitar-chord-lab evaluate outputs/demo/chords.csv data/generated/demo/demo_a_annotation.csv
    guitar-chord-lab experiment configs/experiment_demo.toml
    guitar-chord-lab guitarset   # GuitarSet の実録音を取り出して実験設定を作る
"""

import argparse
import sys
from dataclasses import fields, replace
from pathlib import Path

import matplotlib

from .recognition import ChordSettings, check_settings, load_settings
from .separation import SeparationError

DEFAULT_DEMO_DIR = Path("data/generated/demo")


def parse_overrides(pairs):
    """--set name=value の指定を、ChordSettings の型に合わせた辞書にします。"""
    types = {item.name: type(item.default) for item in fields(ChordSettings)}
    values = {}
    for pair in pairs or []:
        if "=" not in pair:
            raise ValueError(f"--set は name=value の形で指定してください: {pair}")
        name, text = pair.split("=", 1)
        if name not in types:
            raise ValueError(f"知らない設定名です: {name}。使える名前: {list(types)}")
        values[name] = types[name](text)
    return values


def settings_from_args(args):
    """--config と --set から ChordSettings を作ります。"""
    settings = load_settings(args.config) if args.config else ChordSettings()
    settings = replace(settings, **parse_overrides(args.set))
    check_settings(settings)
    return settings


def add_settings_options(parser):
    """解析設定に関するオプションを追加します。"""
    parser.add_argument("--config", help="解析設定のTOMLファイル（[analysis] 表）")
    parser.add_argument(
        "--set", action="append", metavar="NAME=VALUE",
        help="設定を1つ上書きします（例: --set segment_seconds=0.25）。複数回指定できます",
    )


def run_demo(args):
    """合成デモを作り、解析・評価・保存まで行います。"""
    from .recognition import analyse_file
    from .synth import write_demo_dataset

    write_demo_dataset(args.data_dir, seed=args.seed)
    audio_path = Path(args.data_dir) / "demo_a_guitar.wav"
    annotation_path = Path(args.data_dir) / "demo_a_annotation.csv"
    print(f"合成デモを作成しました: {Path(args.data_dir).resolve()}")
    analysis = analyse_file(audio_path, settings=settings_from_args(args))
    report_analysis(analysis, Path(args.output_dir), annotation_path, args.pdf, audio_path.name)
    print("注意: 合成音での結果は動作確認用です。実際のギター録音での精度を示すものではありません。")
    return analysis


def report_analysis(analysis, output_dir, annotation_path=None, pdf=False, title="", extra=None):
    """解析結果を表示して保存します。正解注釈があれば、切り出し位置に合わせて評価もします。"""
    import matplotlib.pyplot as plt

    from .evaluation import crop_intervals, evaluate_segments, read_annotation_csv
    from .plots import plot_analysis
    from .results import print_segments, save_analysis, save_json

    reference = None
    extra = dict(extra or {})
    if annotation_path:
        clip_start = analysis.clip.offset_s
        clip_end = clip_start + analysis.clip.duration_s
        reference = crop_intervals(read_annotation_csv(annotation_path), clip_start, clip_end)
        extra["evaluation"] = evaluate_segments(reference, analysis.segments)
        extra["annotation"] = str(annotation_path)
    figure = plot_analysis(analysis, title, reference)
    saved = save_analysis(analysis, output_dir, extra, figure, pdf)
    plt.close(figure)
    print_segments(analysis)
    if "evaluation" in extra:
        print_evaluation(extra["evaluation"])
        save_json(Path(output_dir) / "evaluation.json", extra["evaluation"])
    print("保存したファイル:")
    for path in saved.values():
        print(f"  {Path(path).resolve()}")


def print_evaluation(metrics):
    """評価結果を表示します。"""
    print(
        f"正解率 accuracy = {metrics['accuracy']:.3f}"
        f"（正解 {metrics['correct_s']:.2f}秒 / 評価対象 {metrics['evaluated_s']:.2f}秒）"
    )
    print(
        f"判定率 decided_ratio = {metrics['decided_ratio']:.3f}"
        f"（誤り {metrics['wrong_s']:.2f}秒、判定保留 {metrics['undecided_s']:.2f}秒、予測なし {metrics['missing_s']:.2f}秒）"
    )


def run_analyse(args):
    """音源を解析します。--separate なら Demucs でギターを分離し、分離前後の両方を解析します。"""
    from .audio import load_audio, save_audio
    from .recognition import recognise_chords

    settings = settings_from_args(args)
    output_dir = Path(args.output_dir or Path("outputs") / "analyse" / Path(args.input).stem)
    clip = load_audio(args.input, args.start, args.duration)
    name = Path(args.input).name
    if not args.separate:
        report_analysis(recognise_chords(clip, settings), output_dir, args.annotation, args.pdf, name)
        return
    from .separation import describe_separation, separate_guitar

    result = separate_guitar(clip, args.model, args.device, cache_dir=args.cache_dir)
    guitar_path = save_audio(output_dir / "separated_guitar.wav", result.guitar)
    print(f"分離したギター: {guitar_path.resolve()}（{result.model_name}, {result.device}, キャッシュ利用: {result.from_cache}）")
    print("=== 入力音（分離前） ===")
    report_analysis(recognise_chords(clip, settings), output_dir / "input", args.annotation, args.pdf, name)
    print("=== 分離したギター ===")
    # 分離した音は入力と同じ時間軸（切り出し位置）を持つので、同じ注釈で評価できます
    extra = {"analysed_audio": "separated guitar", "separation": describe_separation(result)}
    report_analysis(
        recognise_chords(result.guitar, settings), output_dir / "separated", args.annotation, args.pdf,
        f"{name} (separated guitar)", extra,
    )


def run_separate(args):
    """音源からギターを分離して保存します。"""
    from .audio import load_audio, save_audio
    from .separation import separate_guitar

    clip = load_audio(args.input, args.start, args.duration)
    result = separate_guitar(clip, args.model, args.device, cache_dir=args.cache_dir)
    output_dir = Path(args.output_dir or Path("outputs") / "separate" / Path(args.input).stem)
    guitar_path = save_audio(output_dir / "guitar.wav", result.guitar)
    rest_path = save_audio(output_dir / "without_guitar.wav", result.rest)
    print(f"モデル: {result.model_name}、デバイス: {result.device}、処理時間: {result.seconds:.1f}秒、キャッシュ利用: {result.from_cache}")
    print(f"保存しました: {guitar_path.resolve()}\n            {rest_path.resolve()}")


def run_evaluate(args):
    """保存した推定結果CSVを正解注釈CSVと比べます。"""
    from .evaluation import crop_intervals, evaluate_segments, read_annotation_csv, read_prediction_csv

    reference = read_annotation_csv(args.annotation)
    if args.offset:
        reference = crop_intervals(reference, args.offset, float("inf"))
    print_evaluation(evaluate_segments(reference, read_prediction_csv(args.prediction)))


def run_make_demo(args):
    """合成デモの音源と正解注釈だけを作ります。"""
    from .synth import write_demo_dataset

    manifest = write_demo_dataset(args.output_dir, seed=args.seed)
    print(f"作成しました: {Path(args.output_dir).resolve()}")
    for item in manifest["recordings"] + manifest["accompaniments"]:
        print(f"  {item['id']}: {item['audio']}（{item['duration_s']}秒）")


def run_experiment(args):
    """設定ファイルに従って比較実験を行います。"""
    from .experiment import load_experiment, run_experiment as run

    experiment = load_experiment(args.config)
    conditions = args.conditions.split(",") if args.conditions else None
    run(experiment, split=args.split, conditions=conditions, output_dir=args.output_dir)


def run_guitarset(args):
    """GuitarSet の録音を取り出し、比較実験の設定ファイルを作ります。"""
    from .guitarset import CITATION, EXAMPLE_TRACKS, LICENCE, prepare_guitarset_experiment

    tracks = args.tracks or EXAMPLE_TRACKS
    print(f"GuitarSet から {len(tracks)} 録音を取り出します（{LICENCE}）。出典: {CITATION}")
    config = prepare_guitarset_experiment(
        tracks, args.data_dir, args.config, args.duration, args.levels, output_dir=args.output_dir,
    )
    print(f"実験設定を作りました: {Path(config).resolve()}")
    print(f"実行例: guitar-chord-lab experiment {config}")


def build_parser():
    """コマンドの引数の定義を作ります。"""
    parser = argparse.ArgumentParser(prog="guitar-chord-lab", description="ギター音源のコード候補推定と比較実験")
    commands = parser.add_subparsers(dest="command", required=True)

    demo = commands.add_parser("demo", help="合成デモを作って解析・評価する（CPUのみ）")
    demo.add_argument("--data-dir", default=str(DEFAULT_DEMO_DIR), help="合成デモの保存先")
    demo.add_argument("--output-dir", default="outputs/demo", help="解析結果の保存先")
    demo.add_argument("--seed", type=int, default=0, help="合成音の乱数シード")
    demo.add_argument("--pdf", action="store_true", help="図をPDFでも保存する")
    add_settings_options(demo)
    demo.set_defaults(handler=run_demo)

    analyse = commands.add_parser("analyse", help="音源のコード候補を推定する")
    analyse.add_argument("input", help="音声ファイル（WAV/FLAC/OGG/MP3）")
    analyse.add_argument("--start", type=float, default=0.0, help="切り出し開始 [秒]")
    analyse.add_argument("--duration", type=float, default=None, help="切り出す長さ [秒]（省略時は最後まで）")
    analyse.add_argument("--annotation", help="正解注釈CSV（元ファイルの時刻）。指定すると評価も行う")
    analyse.add_argument("--output-dir", help="保存先（省略時は outputs/analyse/<ファイル名>）")
    analyse.add_argument("--pdf", action="store_true", help="図をPDFでも保存する")
    analyse.add_argument("--separate", action="store_true", help="Demucsでギターを分離してから解析する")
    analyse.add_argument("--model", default="htdemucs_6s", help="分離モデル（guitar を出力するもの）")
    analyse.add_argument("--device", default="auto", help="auto / cpu / cuda")
    analyse.add_argument("--cache-dir", default="outputs/cache/separation", help="分離結果のキャッシュ")
    add_settings_options(analyse)
    analyse.set_defaults(handler=run_analyse)

    separate = commands.add_parser("separate", help="Demucsでギターを分離して保存する")
    separate.add_argument("input", help="音声ファイル")
    separate.add_argument("--start", type=float, default=0.0, help="切り出し開始 [秒]")
    separate.add_argument("--duration", type=float, default=None, help="切り出す長さ [秒]")
    separate.add_argument("--model", default="htdemucs_6s", help="分離モデル（guitar を出力するもの）")
    separate.add_argument("--device", default="auto", help="auto / cpu / cuda")
    separate.add_argument("--output-dir", help="保存先（省略時は outputs/separate/<ファイル名>）")
    separate.add_argument("--cache-dir", default="outputs/cache/separation", help="分離結果のキャッシュ")
    separate.set_defaults(handler=run_separate)

    evaluate = commands.add_parser("evaluate", help="推定結果CSVを正解注釈CSVと比べる")
    evaluate.add_argument("prediction", help="推定結果（chords.csv）")
    evaluate.add_argument("annotation", help="正解注釈CSV")
    evaluate.add_argument(
        "--offset", type=float, default=0.0,
        help="推定に使った音源が元ファイルの何秒目から始まるか（注釈の時刻をずらす）",
    )
    evaluate.set_defaults(handler=run_evaluate)

    make_demo = commands.add_parser("make-demo", help="合成デモの音源と正解注釈を作る")
    make_demo.add_argument("--output-dir", default=str(DEFAULT_DEMO_DIR), help="保存先")
    make_demo.add_argument("--seed", type=int, default=0, help="乱数シード")
    make_demo.set_defaults(handler=run_make_demo)

    experiment = commands.add_parser("experiment", help="単独音・混合音・分離音の比較実験")
    experiment.add_argument("config", help="実験設定のTOMLファイル")
    experiment.add_argument("--split", default="all", help="tuning / evaluation / all（元素材単位の区分）")
    experiment.add_argument("--conditions", help="実行する条件をカンマ区切りで指定（例: solo,mixture）")
    experiment.add_argument("--output-dir", help="保存先（省略時は設定ファイルの値）")
    experiment.set_defaults(handler=run_experiment)

    guitarset = commands.add_parser("guitarset", help="GuitarSet の録音を取り出して実験設定を作る")
    guitarset.add_argument("--tracks", nargs="+", help="録音ID（省略時は奏者01〜05の5録音）")
    guitarset.add_argument("--data-dir", default="data/raw/guitarset", help="音源と注釈の保存先")
    guitarset.add_argument("--config", default="data/raw/guitarset/experiment_guitarset.toml", help="作る設定ファイル")
    guitarset.add_argument("--duration", type=float, default=20.0, help="各録音の先頭から使う長さ [秒]")
    guitarset.add_argument("--levels", type=float, nargs="+", default=[0.0, 6.0, 12.0], help="伴奏の音量 [dB]")
    guitarset.add_argument("--output-dir", default="outputs/experiment_guitarset", help="実験結果の保存先")
    guitarset.set_defaults(handler=run_guitarset)
    return parser


def main(argv=None):
    """コマンドを実行します。分かりやすいエラーは、Pythonの詳しい履歴を出さずに表示します。"""
    matplotlib.use("Agg")  # 画面のない環境でも図を保存できるようにする
    args = build_parser().parse_args(argv)
    try:
        args.handler(args)
    except (FileNotFoundError, ValueError, SeparationError) as error:
        print(f"エラー: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
