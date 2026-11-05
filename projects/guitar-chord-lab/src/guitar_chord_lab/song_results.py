"""楽曲解析のコード辞書・時刻・各出現の判定を別々に保存します。"""

import csv
import json
import math
import re
from bisect import bisect_right
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np


_QUALITY_DESCRIPTION = {
    "major": "根音・長3度・完全5度",
    "minor": "根音・短3度・完全5度",
    "dominant7": "メジャーの三和音に短7度を加えた和音",
    "major7": "メジャーの三和音に長7度を加えた和音",
    "minor7": "マイナーの三和音に短7度を加えた和音",
    "half_diminished7": "根音・短3度・減5度・短7度",
    "minor_major7": "マイナーの三和音に長7度を加えた和音",
    "diminished7": "根音・短3度・減5度・減7度",
    "power": "根音と完全5度。3度を含まない",
}


@dataclass
class SongAnalysis:
    metadata: dict
    chords: list[dict]
    timing: list[dict]
    judgements: list[dict]


def beat_grid(start_s, end_s, beats, bpm, *, use_detected):
    """検出ビートを優先し、手入力時は最初のビートを基準に等間隔にします。"""
    step = 60 / bpm
    observed = sorted({float(t) for t in beats if math.isfinite(t) and start_s <= t < end_s})
    anchor = observed[0] if observed else start_s
    median_step = float(np.median(np.diff(observed))) if len(observed) >= 2 else step
    if use_detected and len(observed) >= 2 and 0.55 * step <= median_step <= 1.8 * step:
        grid = [anchor]
        for time in observed[1:]:
            gap = time - grid[-1]
            if gap < 0.09:
                continue
            # ブレイクなどで大きく空いた区間だけ、周囲の間隔を使って補間します。
            count = round(gap / median_step) if gap > 2.5 * median_step else 1
            grid.extend(np.linspace(grid[-1], time, count + 1)[1:].tolist())
        first_step = grid[1] - grid[0] if len(grid) >= 2 else step
        last_step = grid[-1] - grid[-2] if len(grid) >= 2 else step
        before = math.ceil((anchor - start_s) / first_step)
        grid = [anchor - i * first_step for i in range(before, 0, -1)] + grid
        while grid[-1] < end_s - 1e-8:
            grid.append(grid[-1] + last_step)
        return grid, "detected_with_gap_interpolation"
    before = math.ceil((anchor - start_s) / step)
    first = anchor - before * step
    count = max(1, math.ceil((end_s - first) / step))
    return [first + i * step for i in range(count + 1)], "regular_from_anchor"


def beat_position(time_s, grid, meter):
    index = max(0, min(len(grid) - 2, bisect_right(grid, time_s + 1e-8) - 1))
    left, right = grid[index:index + 2]
    quarter = max(0, min(3, math.floor(4 * (time_s - left) / (right - left) + 1e-8)))
    return index // meter + 1, index % meter + 1, quarter, left + (right - left) * quarter / 4


def assemble_song(metadata, events):
    start = metadata["start_s"]
    end = metadata["end_s"]
    grid = metadata["beat_grid_s"]
    meter = metadata["beats_per_bar"]
    chords, timing, judgements = [], [], []
    ids = {}
    for event in events:
        left = max(start, start + event.start_s)
        right = min(end, start + event.end_s)
        if right <= left:
            continue
        chord_id = None
        if event.status == "confirmed":
            if event.chord not in ids:
                ids[event.chord] = f"C{len(ids) + 1:03d}"
                chords.append({
                    "chord_id": ids[event.chord], "name": event.chord, "root": event.root,
                    "notes": list(event.notes), "quality": event.quality,
                    "description": _QUALITY_DESCRIPTION.get(event.quality, ""),
                })
            chord_id = ids[event.chord]
        bar, beat, quarter, grid_s = beat_position(left, grid, meter)
        change_id = f"T{len(timing) + 1:04d}"
        timing.append({
            "change_id": change_id, "chord_id": chord_id, "bar": bar, "beat": beat,
            "quarter": quarter, "start_s": round(left, 6), "end_s": round(right, 6),
            "detected_s": round(left, 6), "grid_s": round(grid_s, 6),
        })
        judgements.append({
            "change_id": change_id, "status": event.status, "bass": event.bass,
            "candidates": list(event.candidates), "score": round(float(event.score), 5),
            "evidence": list(event.evidence), "separation_status": metadata["separation"]["status"],
            "reconstruction_error_db": metadata["separation"].get("reconstruction_error_db"),
        })
    return SongAnalysis(metadata, chords, timing, judgements)


def beat_rows(analysis):
    """実時刻を保ったまま、見やすい1拍ごとの表示行を作ります。"""
    by_id = {row["chord_id"]: row["name"] for row in analysis.chords}
    decisions = {row["change_id"]: row for row in analysis.judgements}
    grid = analysis.metadata["beat_grid_s"]
    meter = analysis.metadata["beats_per_bar"]
    events = analysis.timing
    rows = []
    event_index = 0

    def label(event):
        if event["chord_id"]:
            return by_id[event["chord_id"]]
        judgement = decisions[event["change_id"]]
        if judgement["status"] == "candidate" and judgement["candidates"]:
            return "候補 " + " / ".join(judgement["candidates"])
        return "N"

    for index, (left, right) in enumerate(zip(grid, grid[1:])):
        start = max(left, analysis.metadata["start_s"])
        end = min(right, analysis.metadata["end_s"])
        if end <= start + 1e-7:
            continue
        while event_index < len(events) and events[event_index]["end_s"] <= start + 1e-6:
            event_index += 1
        current = events[event_index] if event_index < len(events) else None
        name = label(current) if current and current["start_s"] <= start + 1e-6 else "N"
        changes = []
        for change_index in range(event_index, len(events)):
            event = events[change_index]
            if event["start_s"] >= end - 1e-6:
                break
            if event["start_s"] > start + 1e-6:
                changes.append(f"+{event['quarter']}/4拍（{event['start_s']:.3f}秒）→ {label(event)}")
        rows.append({
            "bar": index // meter + 1, "beat": index % meter + 1,
            "start_s": round(start, 6), "end_s": round(end, 6),
            "chord": name, "changes": "、".join(changes),
        })
    return rows


_TABLE_COLUMNS = {
    "chords": ("chord_id", "name", "root", "notes", "quality", "description"),
    "timing": ("change_id", "chord_id", "bar", "beat", "quarter", "start_s", "end_s", "detected_s", "grid_s"),
    "judgements": (
        "change_id", "status", "bass", "candidates", "score", "evidence",
        "separation_status", "reconstruction_error_db",
    ),
}


def save_song(analysis, folder):
    """今回の結果だけを、音源を含まない新しいフォルダへ保存します。"""
    root = Path(folder)
    analysis_id = analysis.metadata["analysis_id"]
    if not re.fullmatch(r"song-[0-9a-f]{12}", analysis_id):
        raise ValueError("解析IDの形式が正しくありません")
    root.mkdir(parents=True, exist_ok=True)
    target = root / analysis_id
    if target.exists():
        raise FileExistsError(f"同じ解析の保存先が既にあります: {target}")
    with TemporaryDirectory(prefix=".song-result-", dir=root) as temp:
        staged = Path(temp) / analysis_id
        staged.mkdir()
        documents = {"song": analysis.metadata}
        for name, columns in _TABLE_COLUMNS.items():
            rows = getattr(analysis, name)
            documents[name] = rows
            with (staged / f"{name}.csv").open("w", newline="", encoding="utf-8-sig") as handle:
                writer = csv.DictWriter(handle, fieldnames=columns)
                writer.writeheader()
                for row in rows:
                    writer.writerow({
                        key: json.dumps(value, ensure_ascii=False) if isinstance(value, list) else value
                        for key, value in row.items()
                    })
        for name, content in documents.items():
            (staged / f"{name}.json").write_text(
                json.dumps(content, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8",
            )
        staged.rename(target)
    return target


def load_song(folder):
    """保存したコード、時間、判定を読み戻して拍表示に利用します。"""
    root = Path(folder)
    metadata = json.loads((root / "song.json").read_text(encoding="utf-8"))
    if metadata.get("schema_version") != 1:
        raise ValueError("この解析結果の保存形式には対応していません")
    tables = {
        name: json.loads((root / f"{name}.json").read_text(encoding="utf-8"))
        for name in _TABLE_COLUMNS
    }
    return SongAnalysis(metadata, **tables)
