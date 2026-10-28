"""コマンドラインから使うための入口です。Notebook と同じ関数を呼び出します。

例（作品フォルダ projects/guitar-chord-lab で実行）:
    guitar-chord-lab demo
    guitar-chord-lab analyse data/generated/demo/demo_a_guitar.wav --start 0 --duration 18
    guitar-chord-lab analyse song.wav --separate --device auto
    guitar-chord-lab evaluate outputs/demo/chords.csv data/generated/demo/demo_a_annotation.csv
    guitar-chord-lab evaluate 予測.csv 正解.csv --offset 30 --duration 20   # analysis.json のない CSV
    guitar-chord-lab experiment configs/experiment_demo.toml
    guitar-chord-lab guitarset   # GuitarSet の実録音を取り出して実験設定を作る
"""

import argparse
import json
import math
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
        try:
            values[name] = types[name](text)
        except ValueError:
            kind = "整数" if types[name] is int else "数"
            raise ValueError(f"--set {name}={text}: {name} は{kind}で指定してください") from None
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

    from .evaluation import evaluate_segments, reference_for_range
    from .plots import plot_analysis
    from .results import print_segments, save_analysis, save_json

    reference = None
    extra = dict(extra or {})
    if annotation_path:
        # 解析した入力の範囲（analysis.json に記録する値）で切り取り、evaluate コマンドと同じ区間で評価します
        info = analysis.input_info
        reference = reference_for_range(annotation_path, info["source_path"], info["offset_s"], info["duration_s"])
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
    from .evaluation import reference_for_clip
    from .separation import describe_separation, separate_guitar

    if args.annotation:
        reference_for_clip(args.annotation, clip)  # 時間のかかる分離の前に、注釈の誤りを見つけます
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
    """音源からギターを分離して保存します。元ファイルでの位置と分離の条件は separation.json に記録します。"""
    from .audio import describe_clip, file_sha256, load_audio, save_audio
    from .results import code_version, library_versions, now_utc, save_json
    from .separation import describe_separation, separate_guitar

    clip = load_audio(args.input, args.start, args.duration)
    result = separate_guitar(clip, args.model, args.device, cache_dir=args.cache_dir)
    output_dir = Path(args.output_dir or Path("outputs") / "separate" / Path(args.input).stem)
    guitar_path = save_audio(output_dir / "guitar.wav", result.guitar)
    rest_path = save_audio(output_dir / "without_guitar.wav", result.rest)
    info_path = save_json(output_dir / "separation.json", {
        "created_utc": now_utc(),
        "input": dict(describe_clip(clip), sha256=file_sha256(args.input)),
        "outputs": {"guitar": guitar_path.name, "without_guitar": rest_path.name},
        "time_axis": "0 s of the saved WAV files = input.offset_s of the source file",
        "model": result.model_name,
        "separation": describe_separation(result),
        "libraries": library_versions(),
        "code": code_version(),
    })
    print(f"モデル: {result.model_name}、デバイス: {result.device}、処理時間: {result.seconds:.1f}秒、キャッシュ利用: {result.from_cache}")
    print(f"保存しました: {guitar_path.resolve()}\n            {rest_path.resolve()}\n            {info_path.resolve()}")
    print(
        f"保存した音の0秒は、元ファイルの {clip.offset_s:.2f} 秒です。元ファイルの時刻でコードを推定するときは、"
        "analyse に元の音源と --start・--duration・--separate を指定します（分離結果はキャッシュから再利用します）"
    )


def read_analysis_input(prediction_path):
    """chords.csv と同じフォルダの analysis.json から、解析した範囲の記録（input）を返します。なければ空の辞書です。"""
    info_path = Path(prediction_path).with_name("analysis.json")
    if not info_path.exists():
        return {}
    try:
        with open(info_path, encoding="utf-8-sig") as file:  # 先頭に BOM が付いたファイルも読めるようにします
            info = json.load(file)
    except ValueError:  # JSON として読めないファイル
        raise ValueError(
            f"{info_path} を読み込めませんでした（JSON の形式ではありません）。analyse で解析し直すか、"
            "このファイルを別の場所に移してから --offset と --duration で評価する区間を指定してください"
        ) from None
    if not isinstance(info, dict) or not isinstance(info.get("input"), dict):
        return {}
    return info["input"]


def recorded_start(csv_offset_s, recorded_offset_s):
    """保存した記録から、評価する区間の開始 [秒] を返します（analysis.json → chords.csv の順。分からなければ None）。"""
    from .evaluation import TIME_TOLERANCE_S

    if recorded_offset_s is None:
        return csv_offset_s
    if csv_offset_s is not None and abs(csv_offset_s - float(recorded_offset_s)) > TIME_TOLERANCE_S:
        raise ValueError(
            f"chords.csv の切り出し位置（{csv_offset_s} 秒）と analysis.json の切り出し位置（{recorded_offset_s} 秒）が"
            "一致しません。別の解析のファイルが混ざっていないか確かめ、--offset で開始時刻を指定してください"
        )
    return recorded_offset_s  # analysis.json の方が細かい値


def checked_range(prediction_path, start_s, length_s):
    """区間の開始と長さ [秒] が分かっていて正しい値かを確かめ、float にして返します。

    分からないときは、--offset・--duration での指定方法を示すエラーにします。
    """
    missing = []
    if start_s is None:
        missing.append("開始時刻を --offset（切り出さずに解析したときは --offset 0）")
    if length_s is None:
        missing.append("解析した長さを --duration（例: --duration 20）")
    if missing:
        if Path(prediction_path).with_name("analysis.json").exists():
            reason = "analysis.json に、解析した範囲（offset_s・duration_s）の記録がありません"
        else:
            reason = "chords.csv と同じフォルダに、解析した範囲を記録した analysis.json がありません"
        raise ValueError(f"評価する区間が分かりません（{reason}）。" + "、".join(missing) + "で指定してください")
    start_s, length_s = float(start_s), float(length_s)
    if not (math.isfinite(start_s) and math.isfinite(length_s)) or start_s < 0 or length_s <= 0:
        raise ValueError(
            f"評価する区間が正しくありません（開始 {start_s} 秒、長さ {length_s} 秒）。"
            "--offset には0以上、--duration には0より大きい有限の数（秒）を指定してください"
        )
    return start_s, length_s


def source_length(source_path, start_s, length_s):
    """元の音声ファイル全体の長さ [秒] と、長さを確かめないときの理由を返します。

    ファイルが見つからなければ (None, 理由) を返します。区間がファイルの長さを超えるときはエラーにします。
    """
    from .audio import file_duration
    from .evaluation import TIME_TOLERANCE_S

    if not source_path or not Path(source_path).exists():
        return None, "元の音声ファイルが見つからないため"
    total_s = file_duration(source_path)
    if start_s + length_s > total_s + TIME_TOLERANCE_S:
        raise ValueError(
            f"評価する区間（{start_s:.2f}〜{start_s + length_s:.2f} 秒）が、"
            f"元の音声ファイル全体の長さ {total_s:.2f} 秒を超えています"
        )
    return total_s, ""


def evaluation_range(prediction_path, csv_offset_s, offset_s=None, duration_s=None):
    """評価する区間（元ファイルでの開始 [秒]、解析した長さ [秒]）と、元の音声ファイル全体の長さ [秒] を返します。

    - 開始：--offset の指定 → analysis.json の切り出し位置 → chords.csv の source_start_s の順に使います。
    - 長さ：--duration の指定 → analysis.json に記録した「解析した範囲の長さ」（元ファイル全体の長さではありません）。
    区間を決められないときはエラーにします。予測の最後の時刻から決めると、末尾の予測欠落が評価から消えるためです。
    元ファイル全体の長さは、注釈が音源より長くないかの確認だけに使います。
    --offset で記録と違う位置を指定したときは、解析したファイルが注釈の元ファイルとは別の（切り出し済みの）
    ファイルだと考え、元ファイルの長さは確かめません。
    戻り値は (開始, 長さ, 元ファイル全体の長さ, 理由) です。元ファイルの長さを確かめないときは、長さを None にし、
    確かめない理由を返します（確かめたときの理由は空の文字列です）。
    """
    from .evaluation import TIME_TOLERANCE_S

    try:
        saved = read_analysis_input(prediction_path)
    except ValueError:
        if offset_s is None or duration_s is None:
            raise
        saved = {}  # 区間は両方とも指定されているので、読めない analysis.json は使いません
    recorded_offset_s = saved.get("offset_s")
    if offset_s is None:
        offset_s, overridden = recorded_start(csv_offset_s, recorded_offset_s), False
    else:
        overridden = recorded_offset_s is None or abs(offset_s - float(recorded_offset_s)) > TIME_TOLERANCE_S
    if duration_s is None:
        duration_s = saved.get("duration_s")
    offset_s, duration_s = checked_range(prediction_path, offset_s, duration_s)
    source = saved.get("source_path") or ""
    if overridden and source:
        reason = "--offset で指定した切り出し位置が analysis.json の記録と違うため（解析したファイルを、注釈を付けた元のファイルとは見なしません）"
        return offset_s, duration_s, None, reason
    total_s, reason = source_length(source, offset_s, duration_s)
    return offset_s, duration_s, total_s, reason


def evaluate_saved_prediction(prediction_path, annotation_path, offset_s=None, duration_s=None):
    """保存した chords.csv を正解注釈と比べます。

    戻り値は (評価結果の辞書, 区間の開始 [秒], 解析した長さ [秒], 元の音声ファイル全体の長さ [秒] または None,
    元ファイルの長さを確かめなかった理由) です。
    予測のない時間（末尾や途中の欠落）も、評価する区間の中なら「予測なし」として不正解に数えます。
    """
    from .evaluation import TIME_TOLERANCE_S, crop_intervals, evaluate_segments, read_annotation_csv, read_prediction_csv

    segments, csv_offset_s = read_prediction_csv(prediction_path)
    start_s, length_s, total_s, unchecked = evaluation_range(prediction_path, csv_offset_s, offset_s, duration_s)
    if segments[-1].end_s > length_s + TIME_TOLERANCE_S:
        raise ValueError(
            f"予測（0〜{segments[-1].end_s:.2f} 秒）が、評価する区間の長さ {length_s:.2f} 秒を超えています。"
            "--duration や analysis.json が、この chords.csv の解析と合っているか確かめてください"
        )
    reference = crop_intervals(read_annotation_csv(annotation_path, total_s), start_s, start_s + length_s)
    return evaluate_segments(reference, segments), start_s, length_s, total_s, unchecked


def run_evaluate(args):
    """保存した推定結果CSVを正解注釈CSVと比べます。注釈は、解析した範囲（切り出し位置と長さ）の分だけを使います。"""
    metrics, start_s, length_s, _, unchecked = evaluate_saved_prediction(
        args.prediction, args.annotation, args.offset, args.duration
    )
    if unchecked:
        print(f"注意: {unchecked}、注釈が音源より長くないかは確かめていません")
    print(f"元ファイルの {start_s:.2f}〜{start_s + length_s:.2f} 秒（解析した長さ {length_s:.2f} 秒）の注釈と比べます")
    print_evaluation(metrics)


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
        "--offset", type=float, default=None,
        help="推定に使った音源が元ファイルの何秒目から始まるか（省略時は analysis.json か chords.csv の source_start_s から求める）",
    )
    evaluate.add_argument(
        "--duration", type=float, default=None,
        help="解析した長さ [秒]（評価する区間の長さ。省略時は chords.csv と同じフォルダの analysis.json から読む）",
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
    except (OSError, ValueError, SeparationError) as error:  # OSError はファイルや通信のエラーです
        print(f"エラー: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
