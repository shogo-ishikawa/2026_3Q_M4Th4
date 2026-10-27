"""正解注釈CSVの読み込み・検証と、時間の重なりに基づく評価を行います。

正解注釈は start_s, end_s, chord の3列を持つCSVです。
- 時刻 [秒] は注釈したファイルの先頭を0秒とし、区間は「開始を含み、終了を含まない」とします。
- chord は C:maj、A:min、N（コードなし）などで書きます。フラットはシャープ側の名前にそろえます。
- 対応外のコード（C:7 など）はエラーにします。勝手に三和音や N へ置き換えません。
- 注釈のない時間（区間と区間の間）は評価しません。N と同じ意味にはしません。

主な指標:
- accuracy（正解率）= 正解コードと一致した時間 ÷ 評価対象の時間
- decided_ratio（判定率）= 判定保留でも予測欠落でもなかった時間 ÷ 評価対象の時間
判定保留（X）と予測のない時間は、評価対象の時間に含めたまま不正解として数えます。
"""

import csv
import math
from dataclasses import dataclass
from pathlib import Path

from .chords import UNDECIDED, normalise_chord_label

REQUIRED_COLUMNS = ["start_s", "end_s", "chord"]
TIME_TOLERANCE_S = 1e-3  # 時刻の比較で許す誤差 [秒]


class AnnotationError(ValueError):
    """正解注釈の内容に問題があるときのエラーです。"""


@dataclass
class ChordInterval:
    """正解注釈の1行（開始・終了 [秒] とコード名）です。"""

    start_s: float
    end_s: float
    chord: str


def parse_time(text, column, row_number, problems):
    """時刻の文字列を数値に変換します。変換できなければ problems に理由を追加します。"""
    try:
        value = float(text)
    except (TypeError, ValueError):
        problems.append(f"{row_number}行目: {column} が数値ではありません（{text!r}）")
        return None
    if not math.isfinite(value):
        problems.append(f"{row_number}行目: {column} が有限の数値ではありません（{text!r}）")
        return None
    return value


def check_annotation_rows(rows, duration_s=None):
    """CSVの各行（辞書）を確かめ、(ChordInterval のリスト, 問題のリスト) を返します。

    行番号はヘッダーを1行目とした、表計算ソフトと同じ番号です。
    時刻の確認（順序・重なり・範囲）は、コード名に問題がある行も含めて行います。
    """
    intervals = []
    problems = []
    previous_end = None
    for index, row in enumerate(rows):
        row_number = index + 2
        start_s = parse_time(row.get("start_s"), "start_s", row_number, problems)
        end_s = parse_time(row.get("end_s"), "end_s", row_number, problems)
        chord = parse_chord(row.get("chord"), row_number, problems)
        if start_s is None or end_s is None:
            continue
        if start_s < 0:
            problems.append(f"{row_number}行目: start_s が負の値です（{start_s}）")
        if end_s <= start_s:
            problems.append(f"{row_number}行目: end_s（{end_s}）が start_s（{start_s}）以下です")
        if duration_s is not None and end_s > duration_s + TIME_TOLERANCE_S:
            problems.append(f"{row_number}行目: end_s（{end_s}）が音源の長さ {duration_s:.3f}秒 を超えています")
        if previous_end is not None and start_s < previous_end - TIME_TOLERANCE_S:
            problems.append(
                f"{row_number}行目: 前の行の区間（〜{previous_end}秒）と重なっているか、"
                "開始時刻の順に並んでいません"
            )
        previous_end = end_s
        if chord is not None:
            intervals.append(ChordInterval(start_s, end_s, chord))
    if not rows:
        problems.append("注釈の行がありません")
    return intervals, problems


def parse_chord(text, row_number, problems):
    """コード名をそろえた形にします。空欄や対応外なら problems に理由を追加し、None を返します。"""
    text = (text or "").strip()
    if text == "":
        problems.append(f"{row_number}行目: chord が空です（コードがない区間は N と書きます）")
        return None
    try:
        return normalise_chord_label(text)
    except ValueError as error:
        problems.append(f"{row_number}行目: {error}")
        return None


def read_annotation_csv(path, duration_s=None):
    """正解注釈CSVを読み込み、検証してから ChordInterval のリストを返します。

    duration_s を指定すると、音源の長さを超える区間をエラーにします。
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"正解注釈ファイルが見つかりません: {path}")
    with open(path, newline="", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        columns = reader.fieldnames or []
        missing = [name for name in REQUIRED_COLUMNS if name not in columns]
        if missing:
            raise AnnotationError(f"{path.name}: 必要な列 {missing} がありません（必要な列: {REQUIRED_COLUMNS}）")
        rows = list(reader)
    intervals, problems = check_annotation_rows(rows, duration_s)
    if problems:
        raise AnnotationError(f"{path.name} に問題があります:\n- " + "\n- ".join(problems))
    return intervals


def write_annotation_csv(path, intervals):
    """ChordInterval のリストを正解注釈CSVとして保存します。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file)
        writer.writerow(REQUIRED_COLUMNS)
        for interval in intervals:
            writer.writerow([f"{interval.start_s:.3f}", f"{interval.end_s:.3f}", interval.chord])
    return path


def crop_intervals(intervals, start_s, end_s):
    """注釈を [start_s, end_s) の範囲に切り取り、start_s を0秒とする時刻に直します。

    音源を切り出して解析したときに、注釈の時刻を切り出した音源に合わせるために使います。
    """
    cropped = []
    for interval in intervals:
        new_start = max(interval.start_s, start_s)
        new_end = min(interval.end_s, end_s)
        if new_end - new_start > 1e-9:
            cropped.append(ChordInterval(round(new_start - start_s, 6), round(new_end - start_s, 6), interval.chord))
    return cropped


def find_gaps(intervals, start_s, end_s):
    """[start_s, end_s) のうち、注釈のない時間の (開始, 終了) のリストを返します。"""
    gaps = []
    time_s = start_s
    for interval in intervals:
        if interval.start_s - time_s > TIME_TOLERANCE_S:
            gaps.append((time_s, min(interval.start_s, end_s)))
        time_s = max(time_s, interval.end_s)
    if end_s - time_s > TIME_TOLERANCE_S:
        gaps.append((time_s, end_s))
    return gaps


def overlap_seconds(start_a, end_a, start_b, end_b):
    """2つの区間が重なっている時間 [秒] を返します。重ならなければ0です。"""
    return max(0.0, min(end_a, end_b) - max(start_a, start_b))


def check_prediction_order(segments):
    """予測区間が時刻順に並び、互いに重なっていないことを確認します。"""
    for previous, current in zip(segments, segments[1:]):
        if current.start_s < previous.end_s - TIME_TOLERANCE_S:
            raise ValueError(
                f"予測区間が重なっているか、時刻順ではありません（{previous.end_s}秒 と {current.start_s}秒）"
            )


def evaluate_segments(reference, segments):
    """正解注釈 reference と予測区間 segments を、重なった時間で比べます。

    segments の各要素には start_s, end_s, status, chord が必要です（ChordSegment など）。
    戻り値は秒数と割合をまとめた辞書です。
    """
    check_prediction_order(segments)
    evaluated_s = correct_s = wrong_s = undecided_s = covered_s = 0.0
    for interval in reference:
        evaluated_s += interval.end_s - interval.start_s
        for segment in segments:
            overlap = overlap_seconds(interval.start_s, interval.end_s, segment.start_s, segment.end_s)
            if overlap == 0:
                continue
            covered_s += overlap
            if segment.status == "undecided" or segment.chord == UNDECIDED:
                undecided_s += overlap
            elif segment.chord == interval.chord:
                correct_s += overlap
            else:
                wrong_s += overlap
    if evaluated_s <= 0:
        raise ValueError("評価対象の時間が0秒です。正解注釈と解析範囲を確認してください")
    missing_s = max(0.0, evaluated_s - covered_s)
    return {
        "evaluated_s": round(evaluated_s, 4),
        "correct_s": round(correct_s, 4),
        "wrong_s": round(wrong_s, 4),
        "undecided_s": round(undecided_s, 4),
        "missing_s": round(missing_s, 4),
        "accuracy": round(correct_s / evaluated_s, 4),
        "decided_ratio": round((correct_s + wrong_s) / evaluated_s, 4),
    }


@dataclass
class PredictedSegment:
    """保存したCSVから読み戻した予測区間です。"""

    start_s: float
    end_s: float
    status: str
    chord: str


def read_prediction_csv(path):
    """推定結果CSV（chords.csv）から予測区間を読み込みます。"""
    segments = []
    with open(path, newline="", encoding="utf-8") as file:
        for row in csv.DictReader(file):
            segments.append(PredictedSegment(float(row["start_s"]), float(row["end_s"]), row["status"], row["chord"]))
    return segments
