"""Notebookとコマンドで共用する、読み込みから解析までの手順です。"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tempfile

from .audio import (AudioInputError, download_youtube_section, extract_clip, load_audio,
                    probe_duration, separate_vocals, validate_interval)


def run_analysis(source, start_seconds, end_seconds, output_dir, source_kind="file",
                 already_vocals=False, config=None, progress=None, device="auto"):
    """入力を変更せず解析し、再現用の数値と歌声音源を一つの専用フォルダへ保存します。"""
    from .analysis import analyse_samples

    if source_kind not in {"file", "youtube"}:
        raise AudioInputError("音源の種類はfileまたはyoutubeを指定してください。")
    if not isinstance(already_vocals, bool):
        raise AudioInputError("歌声分離の省略にはTrueまたはFalseを指定してください。")
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
        validate_interval(start, end, source_duration)
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
        vocals = extract_clip(clip, work / "vocals.wav", 0, end - start)
        model_version = ""
        separation_method = "already-vocals"
    else:
        estimated, model_version = separate_vocals(context, work / "separated", device=device, progress=progress)
        vocals = extract_clip(estimated, work / "vocals.wav", offset, offset + end - start)
        separation_method = "demucs:htdemucs"

    report("歌声の音量変動を解析しています。")
    samples, sample_rate = load_audio(vocals)
    analysis = analyse_samples(samples, sample_rate, config=config)
    metadata = {"source_kind": source_kind, "source_sha256": source_hash,
                "source_hash_scope": "selected-clip",
                "start_seconds": start, "end_seconds": end,
                "source_duration_seconds": source_duration,
                "separation_method": separation_method, "model_version": model_version,
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
            "clip_path": str(clip), "metadata": metadata}
