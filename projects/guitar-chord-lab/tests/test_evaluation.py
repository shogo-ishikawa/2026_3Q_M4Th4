"""正解注釈の検証と、時間の重なりに基づく評価の確認"""

import numpy as np
import pytest

from guitar_chord_lab.evaluation import (
    AnnotationError,
    ChordInterval,
    PredictedSegment,
    crop_intervals,
    evaluate_segments,
    find_gaps,
    read_annotation_csv,
    write_annotation_csv,
)


def pred(start_s, end_s, chord):
    """予測区間を作ります。X は判定保留、N はコードなしです。"""
    status = {"X": "undecided", "N": "no_chord"}.get(chord, "chord")
    return PredictedSegment(start_s, end_s, status, chord)


REFERENCE = [ChordInterval(0.0, 2.0, "C:maj"), ChordInterval(2.0, 4.0, "G:maj")]


def test_exact_match():
    metrics = evaluate_segments(REFERENCE, [pred(0, 2, "C:maj"), pred(2, 4, "G:maj")])
    assert metrics["accuracy"] == 1.0
    assert metrics["decided_ratio"] == 1.0
    assert metrics["evaluated_s"] == 4.0


def test_complete_mismatch():
    metrics = evaluate_segments(REFERENCE, [pred(0, 2, "A:min"), pred(2, 4, "C:maj")])
    assert metrics["accuracy"] == 0.0
    assert metrics["wrong_s"] == 4.0
    assert metrics["decided_ratio"] == 1.0


def test_partial_time_overlap():
    """予測の境界が0.5秒ずれた場合: 正解 3.5秒 / 4.0秒"""
    metrics = evaluate_segments(REFERENCE, [pred(0, 2.5, "C:maj"), pred(2.5, 4, "G:maj")])
    assert metrics["correct_s"] == pytest.approx(3.5)
    metrics = evaluate_segments(REFERENCE, [pred(0, 1.5, "C:maj"), pred(1.5, 4, "G:maj")])
    assert metrics["correct_s"] == pytest.approx(3.5)
    assert metrics["accuracy"] == pytest.approx(0.875)
    metrics = evaluate_segments(REFERENCE, [pred(0, 3.0, "C:maj"), pred(3.0, 4, "G:maj")])
    assert metrics["accuracy"] == pytest.approx(0.75)
    assert metrics["wrong_s"] == pytest.approx(1.0)


def test_undecided_counts_as_incorrect_and_lowers_decided_ratio():
    metrics = evaluate_segments(REFERENCE, [pred(0, 2, "C:maj"), pred(2, 4, "X")])
    assert metrics["accuracy"] == pytest.approx(0.5)
    assert metrics["undecided_s"] == pytest.approx(2.0)
    assert metrics["decided_ratio"] == pytest.approx(0.5)
    assert metrics["evaluated_s"] == 4.0  # 判定保留の時間を評価から除外しない


def test_undecided_is_not_correct_even_for_n():
    reference = [ChordInterval(0.0, 1.0, "N"), ChordInterval(1.0, 3.0, "D:min")]
    metrics = evaluate_segments(reference, [pred(0, 1, "X"), pred(1, 3, "D:min")])
    assert metrics["accuracy"] == pytest.approx(2 / 3, abs=1e-4)
    metrics = evaluate_segments(reference, [pred(0, 1, "N"), pred(1, 3, "D:min")])
    assert metrics["accuracy"] == 1.0


def test_missing_prediction_counts_as_incorrect():
    metrics = evaluate_segments(REFERENCE, [pred(0, 2, "C:maj")])
    assert metrics["missing_s"] == pytest.approx(2.0)
    assert metrics["accuracy"] == pytest.approx(0.5)
    assert metrics["decided_ratio"] == pytest.approx(0.5)


def test_gaps_in_the_annotation_are_not_evaluated():
    reference = [ChordInterval(0.0, 1.0, "C:maj"), ChordInterval(2.0, 3.0, "G:maj")]
    metrics = evaluate_segments(reference, [pred(0, 3, "C:maj")])
    assert metrics["evaluated_s"] == 2.0
    assert metrics["accuracy"] == pytest.approx(0.5)
    assert find_gaps(reference, 0.0, 4.0) == [(1.0, 2.0), (3.0, 4.0)]


def test_overlapping_predictions_are_rejected():
    with pytest.raises(ValueError, match="重なって"):
        evaluate_segments(REFERENCE, [pred(0, 3, "C:maj"), pred(2, 4, "G:maj")])


def test_crop_shifts_to_clip_time():
    reference = [ChordInterval(0.0, 5.0, "C:maj"), ChordInterval(5.0, 10.0, "A:min")]
    assert crop_intervals(reference, 4.0, 8.0) == [
        ChordInterval(0.0, 1.0, "C:maj"),
        ChordInterval(1.0, 4.0, "A:min"),
    ]


def test_matches_mir_eval_majmin_for_fully_covered_predictions():
    """mir_eval（公開されている評価ライブラリ）の majmin 評価と同じ値になることを確かめます。"""
    mir_eval = pytest.importorskip("mir_eval")
    rng = np.random.default_rng(0)
    labels = ["C:maj", "A:min", "F:maj", "G:maj", "N", "E:min"]
    for _ in range(20):
        ref_bounds = np.concatenate([[0.0], np.sort(rng.uniform(0.1, 9.9, 5)), [10.0]])
        est_bounds = np.concatenate([[0.0], np.sort(rng.uniform(0.1, 9.9, 7)), [10.0]])
        reference = [ChordInterval(a, b, str(rng.choice(labels))) for a, b in zip(ref_bounds, ref_bounds[1:])]
        estimate = [pred(a, b, str(rng.choice(labels))) for a, b in zip(est_bounds, est_bounds[1:])]
        ours = evaluate_segments(reference, estimate)["accuracy"]

        ref_intervals = np.array([[i.start_s, i.end_s] for i in reference])
        est_intervals = np.array([[s.start_s, s.end_s] for s in estimate])
        intervals, ref_labels, est_labels = mir_eval.util.merge_labeled_intervals(
            ref_intervals, [i.chord for i in reference], est_intervals, [s.chord for s in estimate]
        )
        durations = mir_eval.util.intervals_to_durations(intervals)
        theirs = mir_eval.chord.weighted_accuracy(mir_eval.chord.majmin(ref_labels, est_labels), durations)
        assert ours == pytest.approx(theirs, abs=1e-4)


def write_csv(path, text):
    path.write_text(text, encoding="utf-8")
    return path


def test_valid_annotation_is_read_and_normalised(tmp_path):
    path = write_csv(tmp_path / "a.csv", "start_s,end_s,chord,note\n0,1.5,N,intro\n1.5,3,Db,\n3,4.5,Am,\n")
    intervals = read_annotation_csv(path, duration_s=4.5)
    assert [i.chord for i in intervals] == ["N", "C#:maj", "A:min"]
    again = write_annotation_csv(tmp_path / "b.csv", intervals)
    assert read_annotation_csv(again) == intervals


@pytest.mark.parametrize(
    "text, message",
    [
        ("start,end,chord\n0,1,C\n", "必要な列"),
        ("start_s,end_s,chord\n", "行がありません"),
        ("start_s,end_s,chord\n0,abc,C\n", "数値ではありません"),
        ("start_s,end_s,chord\n2,1,C\n", "start_s（2.0）以下"),
        ("start_s,end_s,chord\n0,2,C\n1.5,3,G\n", "重なって"),
        ("start_s,end_s,chord\n0,2,C:7\n", "対応外のコード"),
        ("start_s,end_s,chord\n0,2,\n", "chord が空"),
        ("start_s,end_s,chord\n-1,2,C\n", "負の値"),
        ("start_s,end_s,chord\n0,12,C\n", "音源の長さ"),
    ],
)
def test_invalid_annotations_are_reported(tmp_path, text, message):
    path = write_csv(tmp_path / "bad.csv", text)
    with pytest.raises(AnnotationError, match=message):
        read_annotation_csv(path, duration_s=10.0)


def test_all_problems_are_listed_together(tmp_path):
    path = write_csv(tmp_path / "bad.csv", "start_s,end_s,chord\n0,1,C:7\n1,x,G\n2,3,\n")
    with pytest.raises(AnnotationError) as caught:
        read_annotation_csv(path)
    text = str(caught.value)
    assert "2行目" in text and "3行目" in text and "4行目" in text


def test_overlap_is_found_even_after_an_unsupported_chord(tmp_path):
    path = write_csv(tmp_path / "bad.csv", "start_s,end_s,chord\n0,2,C:7\n1.5,3,G\n")
    with pytest.raises(AnnotationError) as caught:
        read_annotation_csv(path)
    text = str(caught.value)
    assert "2行目: 対応外のコード" in text and "3行目: 前の行の区間" in text


def test_spaces_in_the_header_are_accepted(tmp_path):
    path = write_csv(tmp_path / "a.csv", "start_s, end_s, chord\n0, 1, C\n1, 2, Am\n")
    assert [i.chord for i in read_annotation_csv(path)] == ["C:maj", "A:min"]


def test_non_utf8_annotation_gives_a_hint(tmp_path):
    path = tmp_path / "excel.csv"
    path.write_bytes("start_s,end_s,chord,note\n0,1,C,イントロ\n".encode("cp932"))
    with pytest.raises(AnnotationError, match="UTF-8"):
        read_annotation_csv(path)


def test_row_numbers_count_blank_lines(tmp_path):
    path = write_csv(tmp_path / "a.csv", "start_s,end_s,chord\n0,1,C\n\n1,2,C:7\n")
    with pytest.raises(AnnotationError, match="4行目: 対応外のコード"):
        read_annotation_csv(path)


def test_overlaps_within_the_tolerance_are_not_counted_twice():
    reference = [ChordInterval(0.0, 4.0, "C:maj")]
    metrics = evaluate_segments(reference, [pred(0.0, 2.0009, "C:maj"), pred(2.0, 4.0, "C:maj")])
    assert metrics["accuracy"] == pytest.approx(1.0)
    assert metrics["correct_s"] == pytest.approx(4.0)
    total = metrics["correct_s"] + metrics["wrong_s"] + metrics["undecided_s"] + metrics["missing_s"]
    assert total == pytest.approx(metrics["evaluated_s"])


def test_find_gaps_ignores_intervals_beyond_the_range():
    reference = [ChordInterval(0.0, 1.0, "C:maj"), ChordInterval(5.0, 6.0, "G:maj"), ChordInterval(8.0, 9.0, "A:min")]
    assert find_gaps(reference, 0.0, 4.0) == [(1.0, 4.0)]
    assert find_gaps([ChordInterval(0.0, 6.0, "C:maj")], 0.0, 4.0) == []


def test_prediction_csv_with_bom_and_missing_columns(tmp_path):
    from guitar_chord_lab.evaluation import read_prediction_csv

    good = tmp_path / "chords.csv"
    good.write_text(
        "﻿start_s,end_s,source_start_s,source_end_s,status,chord\n0,2,3,5,chord,C:maj\n2,4,5,7,undecided,X\n",
        encoding="utf-8",
    )
    segments, offset_s = read_prediction_csv(good)
    assert offset_s == 3.0 and [s.chord for s in segments] == ["C:maj", "X"]
    bad = tmp_path / "bad.csv"
    bad.write_text("start_s,end_s,chord\n0,2,C:maj\n", encoding="utf-8")
    with pytest.raises(ValueError, match="status"):
        read_prediction_csv(bad)


def test_reference_for_clip_rejects_annotations_longer_than_the_source(tmp_path):
    import soundfile as sf

    from guitar_chord_lab.audio import load_audio
    from guitar_chord_lab.evaluation import reference_for_clip

    audio = tmp_path / "short.wav"
    sf.write(audio, np.zeros(22050 * 4), 22050)
    clip = load_audio(audio, start_s=1.0, duration_s=2.0)
    good = write_csv(tmp_path / "good.csv", "start_s,end_s,chord\n0,2,C\n2,4,G\n")
    assert reference_for_clip(good, clip) == [ChordInterval(0.0, 1.0, "C:maj"), ChordInterval(1.0, 2.0, "G:maj")]
    too_long = write_csv(tmp_path / "long.csv", "start_s,end_s,chord\n0,4,C\n4,8,G\n")
    with pytest.raises(AnnotationError, match="音源の長さ"):
        reference_for_clip(too_long, clip)
