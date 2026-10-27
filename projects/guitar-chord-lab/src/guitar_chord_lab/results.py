"""推定結果のCSV・解析設定のJSONを保存し、実行環境とコードの版を記録します。"""

import csv
import json
import math
import platform
import subprocess
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path

from . import __version__
from .audio import file_sha256
from .chords import CHORD_LABELS
from .recognition import CQT_LOWEST_NOTE, CQT_OCTAVES, STFT_WINDOW, segment_rows, settings_to_dict

PROJECT_DIR = Path(__file__).resolve().parents[2]  # projects/guitar-chord-lab
LIBRARIES = ["numpy", "scipy", "librosa", "soundfile", "matplotlib", "torch", "demucs"]


def format_value(value):
    """CSVに書く値を文字列にします。NaN（値なし）は空欄にします。"""
    if isinstance(value, float) and math.isnan(value):
        return ""
    return value


def write_rows_csv(path, rows, columns=None):
    """辞書のリストをCSVに保存します。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if columns is None:
        columns = list(rows[0].keys()) if rows else []
    with open(path, "w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            writer.writerow({name: format_value(row.get(name, "")) for name in columns})
    return path


def save_chords_csv(analysis, path):
    """まとめたコード区間（開始・終了、判定状態、候補、類似度）をCSVに保存します。"""
    return write_rows_csv(path, segment_rows(analysis))


def save_scores_csv(analysis, path):
    """固定幅の区間ごとに、24種類のコードとの類似度をCSVに保存します。"""
    rows = []
    for index, (start_s, end_s) in enumerate(analysis.segment_edges):
        row = {
            "start_s": round(start_s, 3),
            "end_s": round(end_s, 3),
            "rms_db": round(float(analysis.segment_rms_db[index]), 2),
            "label": analysis.segment_labels[index],
        }
        for column, label in enumerate(CHORD_LABELS):
            row[label] = round(float(analysis.scores[index, column]), 4)
        rows.append(row)
    return write_rows_csv(path, rows)


def library_versions():
    """主要ライブラリの版を辞書で返します（入っていないものは "not installed"）。"""
    versions = {"python": platform.python_version()}
    for name in LIBRARIES:
        try:
            versions[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            versions[name] = "not installed"
    return versions


def git_commit(folder=PROJECT_DIR):
    """Gitのコミットと、未コミットの変更の有無を返します。Gitで管理していなければ None です。"""
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=folder, capture_output=True, text=True, check=True
        ).stdout.strip()
        changes = subprocess.run(
            ["git", "status", "--porcelain", "--", "."], cwd=folder, capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    return {"commit": commit, "uncommitted_changes": changes != ""}


def code_version():
    """使ったコードの版（パッケージの版とGitのコミット）を返します。

    配布ZIPから実行した場合は、ZIPに含まれる release_info.json のコミットを使います。
    """
    info = {"package_version": __version__, "git": git_commit()}
    release_file = PROJECT_DIR / "release_info.json"
    if info["git"] is None and release_file.exists():
        with open(release_file, encoding="utf-8") as file:
            info["release"] = json.load(file)
    return info


def now_utc():
    """現在時刻（協定世界時）を文字列で返します。"""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def analysis_info(analysis, extra=None):
    """解析の条件（入力、設定、ライブラリの版、コードの版）をまとめた辞書を返します。"""
    input_info = dict(analysis.input_info)
    source = input_info.get("source_path", "")
    if source and Path(source).exists():
        input_info["sha256"] = file_sha256(source)
    info = {
        "created_utc": now_utc(),
        "input": input_info,
        "analysis_audio": {"sample_rate": analysis.clip.sample_rate, "channels": 1},
        "settings": settings_to_dict(analysis.settings),
        "fixed_parameters": {
            "cqt_lowest_note": CQT_LOWEST_NOTE,
            "cqt_octaves": CQT_OCTAVES,
            "stft_window": STFT_WINDOW,
            "templates": "binary major/minor triads (24)",
            "score": "cosine similarity between segment chroma and template (not a probability)",
        },
        "time_axis": "start_s/end_s are seconds from the analysed clip; source_* add the clip offset",
        "messages": analysis.messages,
        "libraries": library_versions(),
        "code": code_version(),
    }
    if extra:
        info.update(extra)
    return info


def save_json(path, data):
    """辞書をJSONファイルに保存します。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)
    return path


def save_analysis(analysis, output_dir, extra_info=None, figure=None, pdf=False):
    """推定結果をまとめて保存し、保存したファイルの辞書を返します。

    - chords.csv: まとめたコード区間
    - chord_scores.csv: 固定幅の区間ごとの24コードの類似度
    - analysis.json: 解析設定・入力情報・ライブラリの版
    - analysis.png（pdf=True なら analysis.pdf も）: figure を渡したときの図
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    saved = {
        "chords_csv": save_chords_csv(analysis, output_dir / "chords.csv"),
        "scores_csv": save_scores_csv(analysis, output_dir / "chord_scores.csv"),
        "info_json": save_json(output_dir / "analysis.json", analysis_info(analysis, extra_info)),
    }
    if figure is not None:
        saved["figure_png"] = output_dir / "analysis.png"
        figure.savefig(saved["figure_png"], dpi=150)
        if pdf:
            saved["figure_pdf"] = output_dir / "analysis.pdf"
            figure.savefig(saved["figure_pdf"])
    return saved


def print_segments(analysis):
    """まとめたコード区間を表の形で表示します。"""
    header = f"{'開始[s]':>8} {'終了[s]':>8}  {'判定':<10} {'コード':<7} {'第1候補':<7} {'類似度':>6}  {'第2候補':<7} {'類似度':>6}"
    print(header)
    for row in segment_rows(analysis):
        score_1 = "" if math.isnan(row["score_1"]) else f"{row['score_1']:.3f}"
        score_2 = "" if math.isnan(row["score_2"]) else f"{row['score_2']:.3f}"
        print(
            f"{row['start_s']:>8.2f} {row['end_s']:>8.2f}  {row['status']:<10} {row['chord']:<7} "
            f"{row['candidate_1']:<7} {score_1:>6}  {row['candidate_2']:<7} {score_2:>6}"
        )
