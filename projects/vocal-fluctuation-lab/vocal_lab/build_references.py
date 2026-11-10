"""候補一覧の音源を実際に解析し、利用できた特徴量だけをDBへ登録します。

このモジュールを読み込むだけでは、音源取得やモデルの実行は始まりません。
Notebookで明示的に実行するか、末尾のコマンド入口から利用します。
"""

import argparse
import importlib.metadata
import json
from pathlib import Path
import sys
import tempfile

from .reference_db import add_reference, empty_database, load_database, save_database


CATALOGUE_SCHEMA = "vocal-fluctuation-reference-catalogue-v1"


def _run_analysis(*args, **kwargs):
    # 取得・歌声分離に必要なライブラリは、解析を始めるときに読み込みます。
    from .pipeline import run_analysis
    return run_analysis(*args, **kwargs)


def _interval(start, end):
    # 通常の解析と同じ上限・下限を使い、片方だけ古い制限が残るのを防ぎます。
    from .audio import validate_interval
    return validate_interval(start, end)


def _requested_signature(silence_config):
    from .analysis import AnalysisConfig, analysis_signature
    from .silence import combined_analysis_signature
    config = AnalysisConfig()
    # 比較可能な長さ（60秒以上）と既定設定では、解析帯域は0.2〜5 Hzです。
    # configも含めた署名にして、別の解析条件で登録した値を省略対象にしません。
    base = analysis_signature(config, config.low_hz, config.high_hz)
    return combined_analysis_signature(base, silence_config)


def _model_version():
    try:
        return importlib.metadata.version("demucs")
    except importlib.metadata.PackageNotFoundError:
        # モデルの版が確認できないとき、古い結果を現在の条件で測ったことにしません。
        return None


def _load_catalogue(catalogue, start, end):
    if isinstance(catalogue, (str, Path)):
        path = Path(catalogue)
        if path.stat().st_size > 1_000_000:
            raise ValueError("候補一覧は1 MB以内のJSONを使ってください。")
        try:
            catalogue = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError("候補一覧のJSONを読み取れません。") from error
    if not isinstance(catalogue, dict) or catalogue.get("schema_version") != CATALOGUE_SCHEMA:
        raise ValueError("再解析候補一覧の形式が違います。reference_catalogue.jsonを使ってください。")
    candidates = catalogue.get("candidates")
    if not isinstance(candidates, list) or not 1 <= len(candidates) <= 100:
        raise ValueError("候補一覧には1〜100件の音源を指定してください。")
    checked = []
    for index, candidate in enumerate(candidates, 1):
        if not isinstance(candidate, dict):
            raise ValueError(f"候補{index}の情報を読み取れません。")
        row = {}
        for key, value, maximum in [
                ("artist", candidate.get("artist"), 150),
                ("track", candidate.get("reported_track", candidate.get("track")), 200),
                ("url", candidate.get("url"), 2000)]:
            if not isinstance(value, str) or not value.strip() or len(value) > maximum:
                raise ValueError(f"候補{index}の{key}を確認してください。")
            row[key] = value.strip()
        row_start = start if candidate.get("start_seconds") is None else candidate["start_seconds"]
        row_end = end if candidate.get("end_seconds") is None else candidate["end_seconds"]
        row["start_seconds"], row["end_seconds"] = _interval(row_start, row_end)
        checked.append(row)
    return checked


def _write_report(report, path):
    content = {"schema_version": "vocal-fluctuation-reference-build-report-v1", "report": report}
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                     prefix=path.name + ".", suffix=".tmp", delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(content, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _already_registered(database, row, requested_signature, model_version):
    if model_version is None:
        return False
    for saved in database["references"]:
        metadata = saved["metadata"]
        if (saved["artist"].casefold() == row["artist"].casefold()
                and saved["track"].casefold() == row["track"].casefold()
                and saved["source"] == row["url"]
                and metadata["start_seconds"] == row["start_seconds"]
                and metadata["end_seconds"] == row["end_seconds"]
                and metadata["separation_method"] == "demucs:htdemucs"
                and metadata["model_version"] == model_version
                and saved["analysis_signature"] == requested_signature):
            return True
    return False


def build_reference_catalogue(catalogue, output_dir, start_seconds=40, end_seconds=130,
                              device="auto", progress=None, silence_config=None):
    """候補を順に解析し、成功分を一曲ずつ保存して返します。

    候補一覧で秒数が空欄なら start_seconds / end_seconds を使います。
    同じ出力フォルダで再実行すると、同じ曲・出典・区間・解析設定・
    無音処理の方針・モデルの版がそろった登録済み項目は取得し直しません。
    古い版や異なる無音設定の結果は残し、新しい条件でもう一度測ります。
    取得失敗や品質不足は report に残り、既に保存した成功分は保持します。
    """
    start, end = _interval(start_seconds, end_seconds)
    if device not in {"auto", "cpu", "cuda", "mps"}:
        raise ValueError("計算に使う装置はauto、cpu、cuda、mpsから指定してください。")
    if progress is not None and not callable(progress):
        raise ValueError("進み具合を表示するprogressには関数を指定してください。")
    rows = _load_catalogue(catalogue, start, end)
    requested_signature = _requested_signature(silence_config)
    model_version = _model_version()
    output = Path(output_dir).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    database_path = output / "artist_references.json"
    report_path = output / "reference_build_report.json"
    if isinstance(catalogue, (str, Path)) and Path(catalogue).expanduser().resolve() in {database_path, report_path}:
        raise ValueError("候補一覧の入力ファイルと、DB・実行記録の出力先は分けてください。")
    database = load_database(database_path) if database_path.exists() else empty_database()
    if not database_path.exists():
        save_database(database, database_path)
    report = []

    def inform(message):
        if progress is not None:
            progress(message)

    for index, row in enumerate(rows, 1):
        item = {"catalogue_index": index, **row}
        inform(f"[{index}/{len(rows)}] {row['artist']} / {row['track']}")
        if _already_registered(database, row, requested_signature, model_version):
            item.update(status="skipped", message="同じ曲・出典・区間・前処理・モデルの実測値は登録済みです。")
        else:
            try:
                result = _run_analysis(
                    row["url"], row["start_seconds"], row["end_seconds"],
                    output / "analyses" / f"candidate-{index:03d}",
                    source_kind="youtube", already_vocals=False, device=device, progress=progress,
                    silence_config=silence_config)
            except (ValueError, OSError, RuntimeError, ImportError) as error:
                item.update(status="failed", message=(
                    f"音源取得または解析に失敗しました。{str(error)[:1500]} "
                    "動画が取得できない場合は、利用できる音源を通常の解析画面でアップロードし、比較用に登録してください。"))
            else:
                try:
                    updated = add_reference(database, result["analysis"],
                                            artist=row["artist"], track=row["track"], source=row["url"],
                                            notes="候補一覧から実測。曲名は資料の表記であり動画内容との一致を保証しません。")
                except ValueError as error:
                    item.update(status="rejected", message=str(error))
                else:
                    # 保存できてから成功扱いにします。保存先の障害は呼び出し側へ伝えます。
                    save_database(updated, database_path)
                    database = updated
                    item.update(status="added", message="歌声を実測し、比較用の特徴量を登録しました。")
        report.append(item)
        _write_report(report, report_path)
        inform(item["message"])
    return {"database": database, "database_path": str(database_path),
            "report": report, "report_path": str(report_path)}


def main(argv=None):
    parser = argparse.ArgumentParser(description="音源候補を実測し、歌声の特徴量DBを作ります。")
    parser.add_argument("--catalogue", default="data/reference_catalogue.json", help="再解析候補のJSON")
    parser.add_argument("--output", default="outputs/reference-build", help="DBと解析結果の保存先")
    parser.add_argument("--start", type=float, default=40, help="開始秒。候補の区間が空欄の場合に使用")
    parser.add_argument("--end", type=float, default=130, help="終了秒。候補の区間が空欄の場合に使用")
    parser.add_argument("--device", choices=["auto", "cpu", "cuda", "mps"], default="auto")
    parser.add_argument("--no-trim-edges", action="store_true", help="歌声の前後の無音を残す")
    parser.add_argument("--remove-internal-silence", action="store_true", help="途中の長い無音も除去する（時間軸が変わります）")
    parser.add_argument("--silence-threshold-db", type=float, default=None, help="無音とみなす相対レベルのしきい値")
    args = parser.parse_args(argv)
    try:
        silence_config = {"trim_edges": not args.no_trim_edges,
                          "remove_internal": args.remove_internal_silence}
        if args.silence_threshold_db is not None:
            silence_config["threshold_db"] = args.silence_threshold_db
        result = build_reference_catalogue(args.catalogue, args.output, args.start, args.end,
                                          device=args.device, progress=print, silence_config=silence_config)
    except (ValueError, OSError, ImportError, RuntimeError) as error:
        print(f"比較データを作れませんでした。{error}", file=sys.stderr)
        return 2
    added = sum(row["status"] == "added" for row in result["report"])
    skipped = sum(row["status"] == "skipped" for row in result["report"])
    print(f"今回登録: {added}件 / 登録済み: {skipped}件 / DB内の実測値: {len(result['database']['references'])}件")
    print(f"比較DB: {result['database_path']}\n実行記録: {result['report_path']}")
    return 0 if added or skipped else 1


if __name__ == "__main__":
    raise SystemExit(main())
