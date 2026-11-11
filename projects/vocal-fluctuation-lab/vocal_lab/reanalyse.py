"""保存済みの完全なRMS包絡を、音源に触れず共通条件で再解析します。"""
from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

import numpy as np

from . import analysis
from .reference_db import _metadata
from .silence import (METHOD_ID as SILENCE_METHOD_ID, combined_analysis_signature,
                      normalise_silence_config, preprocessing_signature)

MAX_SECONDS = 600.0
MAX_POINTS = 120_000
MAX_RESULT_BYTES = 32 * 1024 * 1024


def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name}は有限の数値にしてください。")
    return float(value)


def _same_numbers(saved, calculated, name):
    if not isinstance(saved, dict):
        raise ValueError(f"保存された{name}を確認できません。")
    for key, expected in calculated.items():
        actual = saved.get(key)
        if expected is None:
            if actual is not None:
                raise ValueError(f"保存された{name}と包絡からの計算が一致しません。")
        elif not math.isclose(_number(actual, name), expected, rel_tol=1e-8, abs_tol=1e-10):
            raise ValueError(f"保存された{name}と包絡からの計算が一致しません。")


def _source_values(result):
    if (not isinstance(result, dict) or result.get("schema_version") != analysis.SCHEMA_VERSION
            or result.get("method_id") != analysis.METHOD_ID):
        raise ValueError("現行方式rms-welch-v2のresult.jsonを使ってください。旧方式の包絡からは復元できません。")
    details = result.get("envelope_processing", {})
    if not isinstance(details, dict) or details.get("method_id") != analysis.ENVELOPE_METHOD:
        raise ValueError("現行方式の包絡の作成記録がありません。歌声WAVから再解析してください。")
    rate = _number(result.get("envelope_sample_rate_hz"), "包絡のサンプリング周波数")
    recorded_rate = _number(details.get("sample_rate_hz"), "包絡の作成記録")
    if not math.isclose(rate, analysis.ENVELOPE_RATE, rel_tol=1e-9) or not math.isclose(rate, recorded_rate, rel_tol=1e-9):
        raise ValueError("毎秒200点の完全な包絡を含むresult.jsonを使ってください。")
    duration = _number(result.get("duration_seconds"), "解析時間")
    if not 0 < duration <= MAX_SECONDS:
        raise ValueError("解析時間は0秒を超え、600秒以内にしてください。")
    series = result.get("series")
    if not isinstance(series, dict):
        raise ValueError("再解析に必要な包絡がありません。")
    envelope, times = series.get("envelope"), series.get("time_seconds")
    if not isinstance(envelope, list) or not isinstance(times, list) or not 2 <= len(envelope) <= MAX_POINTS or len(times) != len(envelope):
        raise ValueError("省略されていない包絡と時刻が必要です（最大120,000点）。")
    envelope = analysis._vector(envelope, "保存された包絡")
    times = analysis._vector(times, "保存された時刻")
    if np.any(envelope < 0) or times[0] < 0:
        raise ValueError("包絡と開始時刻は0以上にしてください。")
    if not np.allclose(times, np.arange(len(times)) / rate + times[0], rtol=0, atol=1e-9):
        raise ValueError("包絡の時刻が毎秒200点で連続していません。省略されていない結果を使ってください。")
    # resample_polyによる末尾の切り上げは最大1点未満です。
    if not -1e-8 <= len(envelope) / rate - duration < 1 / rate + 1e-8:
        raise ValueError("包絡の点数と元の解析時間が一致しません。")
    metadata = result.get("metadata")
    _metadata(metadata)
    report = metadata.get("preprocessing")
    if not isinstance(report, dict) or report.get("method_id") != SILENCE_METHOD_ID or type(report.get("timeline_modified")) is not bool:
        raise ValueError("元の無音処理の記録がありません。")
    if not math.isclose(_number(report.get("output_duration_seconds"), "無音処理後の時間"), duration, abs_tol=1e-8):
        raise ValueError("無音処理の記録と解析時間が一致しません。")
    if not isinstance(report.get("settings"), dict):
        raise ValueError("元の無音処理の設定がありません。")
    silence = normalise_silence_config(report["settings"])
    if metadata.get("preprocessing_signature") != preprocessing_signature(silence):
        raise ValueError("無音処理の設定識別子が一致しません。")
    try:
        original_config = analysis.AnalysisConfig(**result["config"])
    except (KeyError, TypeError) as error:
        raise ValueError("元の解析設定を確認できません。") from error
    reconstructed = analysis._analyse(envelope, rate, duration, original_config, float(times[0]))
    if result.get("analysis_signature") != combined_analysis_signature(reconstructed["analysis_signature"], silence):
        raise ValueError("包絡と元の解析条件の識別子が一致しません。")
    expected_request = combined_analysis_signature(analysis.analysis_request_signature(original_config), silence)
    if metadata.get("analysis_request_signature") != expected_request:
        raise ValueError("元の解析要求の設定識別子が一致しません。")
    _same_numbers(result.get("fit"), reconstructed["fit"], "推定値")
    _same_numbers(result.get("features"), reconstructed["features"], "特徴量")
    return envelope, rate, duration, float(times[0]), silence


def reanalyse_result(result, config=None):
    """既存のv2結果から再計算した新しい辞書を返します。元の辞書は変更しません。

    歌声分離、無音除去、包絡の抽出は行いません。元WAVの作成前に失われた
    区間や分離履歴も復元せず、そのまま保持します。
    """
    if config is None:
        config = analysis.AnalysisConfig(low_hz=0.2, high_hz=20, segment_seconds=20, auto_band=False)
    config = analysis._config(config)
    envelope, rate, duration, offset, silence = _source_values(result)
    canonical = json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    derived = analysis._analyse(envelope, rate, duration, config, offset)
    derived["analysis_signature"] = combined_analysis_signature(derived["analysis_signature"], silence)
    derived["metadata"] = deepcopy(result["metadata"])
    derived["metadata"]["analysis_request_signature"] = combined_analysis_signature(analysis.analysis_request_signature(config), silence)
    derived["envelope_processing"] = deepcopy(result["envelope_processing"])
    if derived["metadata"]["preprocessing"]["timeline_modified"]:
        warning = "途中の無音を取り除いて時間を詰めた音源の結果です。元の歌唱時間に対する1/fの判定ではありません。"
        derived["quality"]["reasons"].append(warning)
        derived["summary"] += " 途中の無音を除いた時間軸での結果です。"
    derived["reanalysis"] = {
        "method_id": "stored-envelope-reanalysis-v1",
        "source_result_canonical_sha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        "source_config": deepcopy(result["config"]),
        "source_analysis_signature": result["analysis_signature"],
        "source_created_at": result["metadata"].get("created_at"),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    if "reanalysis" in result:
        derived["reanalysis"]["source_reanalysis"] = deepcopy(result["reanalysis"])
    return derived


def main(argv=None):
    parser = argparse.ArgumentParser(description="保存したv2結果の完全な包絡を固定条件で再解析します。")
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.input.resolve() == args.output.resolve():
            raise ValueError("入力とは別の出力ファイルを指定してください。")
        if args.input.stat().st_size > MAX_RESULT_BYTES:
            raise ValueError("入力JSONは32 MiB以内にしてください。")
        result = reanalyse_result(json.loads(args.input.read_text(encoding="utf-8")))
        content = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8") as stream:
            stream.write(content)
    except (OSError, ValueError, TypeError) as error:
        parser.error(str(error))
    print("保存済み包絡を0.2〜20 Hzの固定条件で再解析しました。元ファイルは変更していません。")


if __name__ == "__main__":
    main()
