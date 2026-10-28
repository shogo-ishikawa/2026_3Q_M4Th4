"""コード認識の確認（合成音を使います。実録音での精度の確認ではありません）"""

from dataclasses import replace

import numpy as np
import pytest
import soundfile as sf
from conftest import SAMPLE_RATE, silence, sine_chord

from guitar_chord_lab import CHORD_LABELS, ChordSettings, analyse_file, make_clip, recognise_chords
from guitar_chord_lab.evaluation import evaluate_segments
from guitar_chord_lab.recognition import (
    average_chroma_in_segments,
    load_settings,
    make_segment_edges,
    settings_from_dict,
    smooth_scores,
)
from guitar_chord_lab.synth import DEMO_PROGRESSIONS, progression_to_intervals, synthesise_progression


@pytest.mark.parametrize("label", CHORD_LABELS)
def test_sine_triads_are_named_correctly(label):
    """倍音のない三和音なら、24種類すべてで音名と長短が正しく対応することを確かめます。"""
    clip = make_clip(sine_chord(label, 3.0), SAMPLE_RATE)
    analysis = recognise_chords(clip, ChordSettings())
    assert analysis.segment_labels == [label] * len(analysis.segment_labels)
    assert analysis.segments[0].candidate_1 == label


def test_silence_becomes_n_and_chord_boundaries_stay_in_place():
    """無音→コード→無音の境界が、元の時刻（1.0秒と3.0秒）にそろうことを確かめます。"""
    samples = np.concatenate([silence(1.0), sine_chord("G:maj", 2.0), silence(1.0)])
    analysis = recognise_chords(make_clip(samples, SAMPLE_RATE), ChordSettings())
    summary = [(s.start_s, s.end_s, s.status, s.chord) for s in analysis.segments]
    assert summary == [
        (0.0, 1.0, "no_chord", "N"),
        (1.0, 3.0, "chord", "G:maj"),
        (3.0, 4.0, "no_chord", "N"),
    ]


def test_chord_change_time_is_not_shifted():
    samples = np.concatenate([sine_chord("C:maj", 2.0), sine_chord("E:min", 2.0)])
    settings = ChordSettings(smoothing_segments=1)
    analysis = recognise_chords(make_clip(samples, SAMPLE_RATE), settings)
    assert [(s.start_s, s.end_s, s.chord) for s in analysis.segments] == [
        (0.0, 2.0, "C:maj"),
        (2.0, 4.0, "E:min"),
    ]


def test_all_silent_input_gives_n_and_a_message():
    with pytest.warns(UserWarning, match="無音"):
        analysis = recognise_chords(make_clip(silence(3.0), SAMPLE_RATE), ChordSettings())
    assert [s.chord for s in analysis.segments] == ["N"]
    assert analysis.messages


def test_too_short_input_is_rejected():
    with pytest.raises(ValueError, match="短すぎ"):
        recognise_chords(make_clip(sine_chord("C:maj", 1.5), SAMPLE_RATE), ChordSettings())
    with pytest.raises(ValueError, match="短すぎ"):
        recognise_chords(make_clip(sine_chord("C:maj", 2.5), SAMPLE_RATE), ChordSettings(segment_seconds=3.0))


def test_high_thresholds_give_undecided_not_n():
    """しきい値を厳しくすると、無音ではない区間は N ではなく判定保留（X）になります。"""
    clip = make_clip(sine_chord("A:min", 3.0), SAMPLE_RATE)
    analysis = recognise_chords(clip, ChordSettings(min_score=1.0))
    assert {s.status for s in analysis.segments} == {"undecided"}
    assert {s.chord for s in analysis.segments} == {"X"}
    assert analysis.segments[0].candidate_1 == "A:min"  # 候補は残しておく


def test_stft_chroma_also_works():
    clip = make_clip(sine_chord("D:maj", 3.0), SAMPLE_RATE)
    analysis = recognise_chords(clip, ChordSettings(chroma_method="stft"))
    assert set(analysis.segment_labels) == {"D:maj"}


def test_offset_is_added_for_source_times(tmp_path):
    """切り出して解析した結果の時刻を、元ファイルの時刻に直せることを確かめます。"""
    samples = np.concatenate([silence(5.0), sine_chord("F:maj", 3.0)])
    path = tmp_path / "offset.wav"
    sf.write(path, samples, SAMPLE_RATE)
    analysis = analyse_file(path, start_s=4.0, duration_s=4.0, settings=ChordSettings())
    assert analysis.clip.offset_s == pytest.approx(4.0)
    first, second = analysis.segments
    assert (first.start_s, first.end_s, first.chord) == (0.0, 1.0, "N")
    assert (second.start_s + analysis.clip.offset_s, second.chord) == (5.0, "F:maj")


def test_segment_edges_merge_a_short_remainder():
    assert make_segment_edges(2.1, 0.5)[-1] == (1.5, 2.1)
    assert make_segment_edges(2.3, 0.5)[-1] == (2.0, 2.3)
    assert len(make_segment_edges(2.0, 0.5)) == 4


def test_frames_are_assigned_by_their_centre_time():
    chroma = np.arange(12 * 4, dtype=float).reshape(12, 4)
    frame_times = np.array([0.0, 0.4, 0.5, 1.0])
    averaged = average_chroma_in_segments(chroma, frame_times, [(0.0, 0.5), (0.5, 1.0)])
    assert np.allclose(averaged[0], chroma[:, :2].mean(axis=1))
    assert np.allclose(averaged[1], chroma[:, 2:].mean(axis=1))  # 最後の端（1.0秒）も含む


def test_smoothing_ignores_silent_segments():
    scores = np.array([[1.0, 0.0], [0.0, 1.0], [5.0, 5.0]])
    smoothed = smooth_scores(scores, is_silent=[False, False, True], window=3)
    assert np.allclose(smoothed[1], [0.5, 0.5])  # 無音の3行目は平均に入れない
    assert np.allclose(smooth_scores(scores, [False] * 3, 1), scores)


def test_settings_are_checked(tmp_path):
    with pytest.raises(ValueError, match="smoothing_segments"):
        settings_from_dict({"smoothing_segments": 2})
    with pytest.raises(ValueError, match="知らない項目"):
        settings_from_dict({"segment_length": 0.5})
    with pytest.raises(ValueError, match="chroma_method"):
        recognise_chords(make_clip(sine_chord("C:maj", 3.0), SAMPLE_RATE), replace(ChordSettings(), chroma_method="mfcc"))
    config = tmp_path / "analysis.toml"
    config.write_text("[analysis]\nsegment_seconds = 0.25\nmin_score = 0.7\n", encoding="utf-8")
    loaded = load_settings(config)
    assert loaded.segment_seconds == 0.25 and loaded.min_score == 0.7


def test_project_default_config_matches_code_defaults():
    from pathlib import Path

    config = Path(__file__).resolve().parents[1] / "configs" / "analysis_default.toml"
    assert load_settings(config) == ChordSettings()


def test_plucked_demo_is_mostly_recognised():
    """Karplus-Strong法の合成デモで、プログラム全体が動くことを確かめます（実録音の精度ではない）。"""
    for name, progression in DEMO_PROGRESSIONS.items():
        samples = synthesise_progression(progression, 44100, seed=0)
        analysis = recognise_chords(make_clip(samples, 44100), ChordSettings())
        metrics = evaluate_segments(progression_to_intervals(progression), analysis.segments)
        assert metrics["accuracy"] >= 0.9, (name, metrics)
        assert metrics["wrong_s"] == 0, (name, metrics)


def test_undecided_segments_are_not_merged_and_keep_their_own_scores():
    """判定保留の区間はまとめず、それぞれの区間で判定に使った候補と類似度を残します。"""
    from guitar_chord_lab.recognition import choose_top_two

    samples = np.concatenate([sine_chord("C:maj", 1.5), sine_chord("A:min", 1.5)])
    settings = ChordSettings(min_score=1.0, smoothing_segments=3)  # どの区間も判定保留になる
    analysis = recognise_chords(make_clip(samples, SAMPLE_RATE), settings)
    assert len(analysis.segments) == len(analysis.segment_edges)
    for index, segment in enumerate(analysis.segments):
        candidate_1, score_1, candidate_2, score_2 = choose_top_two(analysis.scores[index])
        assert segment.status == "undecided"
        assert (segment.candidate_1, segment.candidate_2) == (candidate_1, candidate_2)
        assert segment.score_1 == pytest.approx(score_1)
        assert segment.score_1 < settings.min_score or segment.margin < settings.min_margin


def test_silent_segments_have_no_similarity_values(tmp_path):
    from guitar_chord_lab.results import save_scores_csv

    samples = np.concatenate([silence(1.0), sine_chord("G:maj", 2.0), silence(1.0)])
    analysis = recognise_chords(make_clip(samples, SAMPLE_RATE), ChordSettings())
    for index, label in enumerate(analysis.segment_labels):
        assert np.isnan(analysis.scores[index]).all() == (label == "N")
    path = save_scores_csv(analysis, tmp_path / "scores.csv")
    first_row = path.read_text(encoding="utf-8").splitlines()[1].split(",")
    assert first_row[3] == "N" and first_row[4:] == [""] * 24  # N の区間の類似度は空欄


@pytest.mark.parametrize(
    "values, message",
    [
        ({"smoothing_segments": 3.0}, "整数"),
        ({"hop_length": True}, "整数"),
        ({"min_score": "0.6"}, "数で指定"),
        ({"silence_db": float("nan")}, "数で指定"),
        ({"segment_seconds": float("inf")}, "数で指定"),
        ({"silence_db": 10.0}, "silence_db"),
        ({"sample_rate": 8000}, "11025"),
    ],
)
def test_setting_types_and_ranges_are_checked(values, message):
    with pytest.raises(ValueError, match=message):
        settings_from_dict(values)


def test_settings_file_needs_an_analysis_table(tmp_path):
    config = tmp_path / "typo.toml"
    config.write_text("[analyse]\nsegment_seconds = 0.25\n", encoding="utf-8")
    with pytest.raises(ValueError, match=r"\[analysis\]"):
        load_settings(config)
