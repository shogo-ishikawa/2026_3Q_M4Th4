"""楽曲解析の入口から、停止条件・判定・保存まで確認します。"""

import csv
from dataclasses import replace

import numpy as np
import pytest
from conftest import silence, sine_chord

from guitar_chord_lab import song, song_harmony
from guitar_chord_lab.audio import make_clip, save_audio
from guitar_chord_lab.cli import main
from guitar_chord_lab.separation import SeparationError, StemSeparation
from guitar_chord_lab.synth import midi_to_hz, synthesise_drums

RATE = 22050


@pytest.fixture
def recording(tmp_path):
    guitar = np.concatenate([
        silence(0.4), sine_chord("C:maj", 3.29, amplitude=0.10),
        sine_chord("D:min", 2.35, amplitude=0.10),
        sine_chord("C:maj", 3.36, amplitude=0.10), silence(0.6),
    ])
    drums = np.concatenate([silence(0.4), synthesise_drums(9, RATE, 120) * 0.13, silence(0.6)])
    path = save_audio(tmp_path / "known-progression.wav", make_clip(guitar + drums, RATE))
    return path, guitar, drums


def install_separator(monkeypatch, recording, guitar, *, weak=False):
    _, _, drums = recording

    def separate(clip, *, device):
        first = round(clip.offset_s * RATE)
        last = first + clip.samples.shape[-1]
        stems = {
            "guitar": make_clip(guitar[first:last], RATE),
            "drums": make_clip(drums[first:last], RATE),
            "bass": make_clip(np.zeros(last - first), RATE),
        }
        if weak:
            remaining = recording[1][first:last] - guitar[first:last]
            stems["other"] = make_clip(remaining, RATE)
        return StemSeparation(clip, stems, device, 0.05)

    monkeypatch.setattr(song, "separate_stems", separate)


def test_saved_progression_keeps_chords_and_change_times_separate(monkeypatch, recording, tmp_path):
    path, guitar, _ = recording
    install_separator(monkeypatch, recording, guitar)
    session = song.prepare_song(path)
    assert session.report.bpm == pytest.approx(120, abs=2)
    inputs = iter(["C", "nan", "C", "120.0"])
    choice = song.confirm_bpm(session, read=lambda _: next(inputs), emit=lambda _: None)
    assert choice == song.TempoChoice(120.0, "manual")

    analysis = song.analyse_song(session, choice, device="cpu")
    assert analysis.metadata["separation"]["backing"]["present"] is True
    assert analysis.metadata["separation"]["drum_tempo"]["bpm"] == pytest.approx(120, abs=2)
    assert [chord["name"] for chord in analysis.chords] == ["C", "Dm"]
    timed_chords = [row for row in analysis.timing if row["chord_id"]]
    assert timed_chords[0]["chord_id"] == timed_chords[-1]["chord_id"]
    assert len({row["change_id"] for row in timed_chords}) == len(timed_chords)
    for expected in (3.69, 6.04):
        assert min(abs(row["detected_s"] - expected) for row in timed_chords) <= 0.125
    assert any("→ Dm" in row["changes"] for row in song.beat_rows(analysis))

    folder = song.save_song(analysis, tmp_path / "results")
    assert sorted(path.name for path in folder.iterdir()) == [
        "chords.csv", "chords.json", "judgements.csv", "judgements.json",
        "song.json", "timing.csv", "timing.json",
    ]
    restored = song.load_song(folder)
    assert restored.chords == analysis.chords
    assert restored.timing == analysis.timing
    assert restored.judgements == analysis.judgements
    assert song.beat_rows(restored) == song.beat_rows(analysis)
    with (folder / "timing.csv").open(encoding="utf-8-sig", newline="") as handle:
        assert len(list(csv.DictReader(handle))) == len(analysis.timing)
    assert not list(folder.parent.glob(".song-result-*"))
    assert path.is_file()


@pytest.mark.parametrize("guitar_track", ["silent", "lead", "chromatic_riff"])
def test_no_backing_stops_cli_before_harmony_or_saving(monkeypatch, recording, tmp_path, capsys, guitar_track):
    path, guitar, _ = recording
    t = np.arange(len(guitar)) / RATE
    # 倍音を含むリードの単音。和音には数えません。
    if guitar_track == "lead":
        stem = 0.1 * np.sin(2 * np.pi * 329.63 * t) + 0.05 * np.sin(2 * np.pi * 659.26 * t)
    elif guitar_track == "chromatic_riff":
        frequency = 261.63 * 2 ** ((np.floor(t / 0.35) % 3) / 12)
        stem = 0.1 * np.sin(2 * np.pi * np.cumsum(frequency) / RATE)
    else:
        stem = np.zeros_like(guitar)
    install_separator(monkeypatch, recording, stem)
    monkeypatch.setattr(song, "confirm_bpm", lambda _: song.TempoChoice(120, "manual"))

    def unexpected(*args, **kwargs):
        pytest.fail("伴奏なしと判定した後にコード解析へ進みました")

    monkeypatch.setattr(song_harmony, "analyse_harmony", unexpected)
    output = tmp_path / "results"
    assert main(["song", str(path), "--output-dir", str(output)]) == 1
    assert "コード解析を停止しました" in capsys.readouterr().err
    assert not output.exists()


def arpeggiated_waveform(patterns, duration_s, gap_s):
    times = np.arange(round(duration_s * RATE)) / RATE
    envelope = np.sin(np.pi * times / duration_s) ** 0.4
    notes = []
    for pattern in patterns:
        for midi in pattern:
            notes.append(0.1 * envelope * np.sin(2 * np.pi * midi_to_hz(midi) * times))
            notes.append(silence(gap_s))
    return np.concatenate(notes)


def test_unrepeated_arpeggio_progression_is_saved_as_candidates(monkeypatch, tmp_path):
    patterns = [(60, 64, 67, 72), (57, 60, 64, 69), (53, 57, 60, 65), (55, 59, 62, 67)]
    guitar = arpeggiated_waveform(patterns, 0.20, 0.09)
    path = save_audio(tmp_path / "arp.wav", make_clip(guitar, RATE))
    install_separator(monkeypatch, (path, guitar, np.zeros_like(guitar)), guitar)

    analysis = song.analyse_song(song.prepare_song(path), song.TempoChoice(120, "manual"))
    backing = analysis.metadata["separation"]["backing"]
    assert backing["arpeggio_progression"] is True
    assert backing["polyphonic_s"] == 0
    assert analysis.chords == []
    candidates = [item["candidates"][0] for item in analysis.judgements if item["status"] == "candidate"]
    assert candidates == ["C", "Am", "F", "G"]
    assert song.save_song(analysis, tmp_path / "results").is_dir()

    short_phrase = arpeggiated_waveform(patterns[:1], 0.20, 0.09)
    assert not song.detect_backing(short_phrase, short_phrase, RATE, 120).present


def test_backing_and_harmony_both_use_confirmed_bpm(monkeypatch, tmp_path):
    guitar = arpeggiated_waveform([(60, 64, 67)] * 3, 0.43, 0.08)
    path = save_audio(tmp_path / "slow-arp.wav", make_clip(guitar, RATE))
    install_separator(monkeypatch, (path, guitar, np.zeros_like(guitar)), guitar)
    session = song.prepare_song(path)

    analysis = song.analyse_song(session, song.TempoChoice(120, "manual"))
    assert [chord["name"] for chord in analysis.chords] == ["C"]
    with pytest.raises(song.NoBackingGuitar):
        song.analyse_song(session, song.TempoChoice(180, "manual"))


def test_fallback_only_proposes_candidates_from_the_mix(monkeypatch, recording, tmp_path):
    path, _, _ = recording

    def failed(*args, **kwargs):
        raise SeparationError("モデルを取得できません")

    classify = song_harmony.analyse_harmony

    def check_inputs(guitar, bass, sample_rate, bpm, *, mixture):
        assert bass is None
        assert mixture is guitar
        return classify(guitar, bass, sample_rate, bpm, mixture=mixture)

    monkeypatch.setattr(song, "separate_stems", failed)
    monkeypatch.setattr(song_harmony, "analyse_harmony", check_inputs)
    analysis = song.analyse_song(song.prepare_song(path), song.TempoChoice(120, "manual"))
    separation = analysis.metadata["separation"]
    assert separation["status"] == "fallback"
    assert separation["reason"] == "モデルを取得できません"
    assert separation["harmony_input"] == "mixture"
    assert analysis.chords == []
    assert any(record["status"] == "candidate" for record in analysis.judgements)
    assert all(row["chord_id"] is None for row in analysis.timing)
    assert any("候補 " in row["chord"] for row in song.beat_rows(analysis))
    assert song.save_song(analysis, tmp_path / "results").is_dir()


def test_weak_guitar_stem_uses_other_harmonic_evidence_only_for_candidates(monkeypatch, recording):
    path, guitar, _ = recording
    install_separator(monkeypatch, recording, guitar * 0.04, weak=True)
    analysis = song.analyse_song(song.prepare_song(path), song.TempoChoice(120, "manual"))
    separation = analysis.metadata["separation"]
    assert separation["status"] == "separated"
    assert separation["backing"]["present"] is True
    assert separation["harmony_input"] == "mixture_minus_stems"
    assert analysis.chords == []
    assert any(record["candidates"][:1] == ["Dm"] for record in analysis.judgements)


def test_bpm_retry_requires_a_new_choice(monkeypatch, recording):
    session = song.prepare_song(recording[0])
    report = session.report
    calls = []

    def retried(samples, rate, *, retry):
        calls.append(retry)
        return replace(report, bpm=119.25)

    monkeypatch.setattr(song, "estimate_tempo", retried)
    replies = iter(["B", "Q"])
    with pytest.raises(song.SongCancelled):
        song.confirm_bpm(session, read=lambda _: next(replies), emit=lambda _: None)
    assert calls == [True]
    assert session.report.bpm == 119.25
