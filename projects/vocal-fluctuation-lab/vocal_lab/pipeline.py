"""Notebookとコマンドで共用する、読み込みから解析までの手順です。"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tempfile

import soundfile as sf

from .audio import (AudioInputError, download_youtube_section, extract_clip, load_audio,
                    probe_duration, separate_vocals, validate_interval)
from .silence import (combined_analysis_signature, normalise_silence_config,
                      preprocessing_signature, process_silence)


def run_analysis(source, start_seconds=0.0, end_seconds=None, output_dir="outputs", source_kind="file",
                 already_vocals=False, config=None, progress=None, device="auto", silence_config=None):
    """入力を変更せず解析し、再現用の数値と歌声音源を一つの専用フォルダへ保存します。"""
    from .analysis import analyse_samples

    if source_kind not in {"file", "youtube"}:
        raise AudioInputError("音源の種類はfileまたはyoutubeを指定してください。")
    if not isinstance(already_vocals, bool):
        raise AudioInputError("歌声分離の省略にはTrueまたはFalseを指定してください。")
    silence_config = normalise_silence_config(silence_config)
    selection_mode = "to-end" if end_seconds is None else "interval"
    start, end = validate_interval(start_seconds, end_seconds)
    output = Path(output_dir).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="analysis-", dir=output))

    def report(message):
        if progress:
            progress(message)

    if source_kind == "youtube":
        report("YouTubeの選択区間を取得しています。")
        downloaded = download_youtube_section(source, start, end, work / "download")
        start, end = downloaded["start_seconds"], downloaded["end_seconds"]
        source_path = downloaded["path"]
        context_start = downloaded["context_start_seconds"]
        context_end = downloaded["context_end_seconds"]
        # ダウンロードしたファイルは選択区間の少し前から始まっています。
        context = extract_clip(source_path, work / "context.wav", 0, context_end - context_start)
        source_url = downloaded["source_url"]
        source_duration = downloaded["source_duration_seconds"]
    else:
        source_path = Path(source).expanduser().resolve()
        source_duration = probe_duration(source_path)
        start, end = validate_interval(start, end, source_duration)
        context_start = max(0.0, start - 2.0)
        context_end = min(source_duration, end + 2.0)
        report("選択区間を切り出しています。")
        context = extract_clip(source_path, work / "context.wav", context_start, context_end)
        source_url = None

    offset = start - context_start
    clip = extract_clip(context, work / "input-clip.wav", offset, offset + end - start)
    source_hash = hashlib.sha256(clip.read_bytes()).hexdigest()
    if already_vocals:
        report("歌声のみの入力として、分離を省略します。")
        extracted_vocals = extract_clip(clip, work / "extracted-vocals.wav", 0, end - start)
        model_version = ""
        separation_method = "already-vocals"
    else:
        estimated, model_version = separate_vocals(context, work / "separated", device=device, progress=progress)
        extracted_vocals = extract_clip(estimated, work / "extracted-vocals.wav", offset, offset + end - start)
        separation_method = "demucs:htdemucs"

    report("抽出した歌声の無音を確認しています。")
    samples, sample_rate = load_audio(extracted_vocals)
    samples, preprocessing = process_silence(samples, sample_rate, silence_config)
    vocals = work / "vocals.wav"
    sf.write(vocals, samples, sample_rate, subtype="FLOAT")
    report("歌声の音量変動を解析しています。")
    analysis = analyse_samples(samples, sample_rate, config=config)
    analysis["analysis_signature"] = combined_analysis_signature(analysis["analysis_signature"], silence_config)
    if preprocessing["timeline_modified"]:
        warning = "途中の無音を取り除いて時間を詰めた音源の結果です。元の歌唱時間に対する1/fの判定ではありません。"
        analysis.setdefault("quality", {}).setdefault("reasons", []).append(warning)
        analysis["summary"] += " 途中の無音を除いた時間軸での結果です。"
    metadata = {"source_kind": source_kind, "source_sha256": source_hash,
                "source_hash_scope": "selected-clip",
                "start_seconds": start, "end_seconds": end,
                "selection_mode": selection_mode,
                "source_duration_seconds": source_duration,
                "separation_method": separation_method, "model_version": model_version,
                "preprocessing": preprocessing,
                "preprocessing_signature": preprocessing_signature(silence_config),
                "created_at": datetime.now(timezone.utc).isoformat(),
                "sample_rate_hz": sample_rate,
                "vocal_extraction_note": ("入力を歌声のみとして解析しました。歌声分離は実行していません。" if already_vocals else
                                          "歌声の推定結果です。伴奏の残留や歌声の欠落は試聴して確認してください。")}
    if source_url:
        metadata["source_url"] = source_url
    analysis["metadata"] = metadata
    result_path = work / "result.json"
    result_path.write_text(json.dumps(analysis, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    report("解析が終わりました。歌声を試聴し、グラフと判定条件を確認してください。")
    return {"analysis": analysis, "result_path": str(result_path), "vocals_path": str(vocals),
            "extracted_vocals_path": str(extracted_vocals), "clip_path": str(clip), "metadata": metadata}
