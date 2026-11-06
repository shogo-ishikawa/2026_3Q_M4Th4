"""楽曲向けコード解析と独立ベース推定を合成波形で確認します。"""

import numpy as np
import pytest

from guitar_chord_lab.song_bass import analyse_bass, stable_bass
from guitar_chord_lab.song_harmony import analyse_harmony, find_arpeggios, guitar_note_evidence
from guitar_chord_lab.synth import midi_to_hz, synthesise_progression

RATE = 22050
BPM = 120


def tone(midi, seconds, *, harmonics=(1.0,), fade_s=0.01):
    times = np.arange(round(seconds * RATE)) / RATE
    phase = 2 * np.pi * midi_to_hz(midi) * times
    signal = sum(level * np.sin(order * phase) for order, level in enumerate(harmonics, start=1))
    envelope = np.minimum(1, np.minimum(times, times[-1] - times) / fade_s)
    return 0.2 * envelope * signal


def chord(root, intervals, seconds=1.2):
    return sum(tone(root + interval, seconds) for interval in intervals)


@pytest.mark.parametrize(
    "root,intervals,name,quality",
    [
        (48, (0, 4, 7), "C", "major"),
        (45, (0, 3, 7), "Am", "minor"),
        (43, (0, 4, 7, 10), "G7", "dominant7"),
        (48, (0, 4, 7, 11), "Cmaj7", "major7"),
        (48, (0, 3, 7, 10), "Cm7", "minor7"),
        (48, (0, 3, 6, 10), "Cm7b5", "half_diminished7"),
        (48, (0, 3, 7, 11), "CmMaj7", "minor_major7"),
        (50, (0, 7), "D5", "power"),
    ],
)
def test_recognises_supported_chord_families(root, intervals, name, quality):
    [event] = analyse_harmony(chord(root, intervals), None, RATE, BPM)
    assert (event.chord, event.status, event.quality) == (name, "confirmed", quality)
    assert (event.start_s, event.end_s) == (0.0, 1.2)
    assert len(event.notes) == len(intervals)


def test_changes_are_detected_between_beats_and_do_not_split_sustained_chords():
    guitar = np.r_[
        chord(48, (0, 4, 7), 0.87),
        chord(45, (0, 3, 7), 1.23),
        chord(43, (0, 4, 7, 10), 0.96),
    ]
    events = analyse_harmony(guitar, None, RATE, BPM)
    assert [event.chord for event in events] == ["C", "Am", "G7"]
    assert [event.start_s for event in events] == pytest.approx([0, 0.87, 2.10], abs=0.07)
    assert [event.end_s for event in events[:-1]] == [event.start_s for event in events[1:]]
    assert events[-1].end_s == len(guitar) / RATE


@pytest.mark.parametrize(
    "root,intervals,bass_midi,slash",
    [
        (48, (0, 4, 7), 28, "C/E"),
        (48, (0, 4, 7), 31, "C/G"),
        (43, (0, 4, 7), 35, "G/B"),
        (45, (0, 3, 7), 36, "Am/C"),
        (53, (0, 4, 7), 31, "F/G"),
    ],
)
def test_stable_bass_can_produce_an_inversion_or_pedal(root, intervals, bass_midi, slash):
    guitar = chord(root, intervals)
    bass = tone(bass_midi, 1.2, harmonics=(0.32, 1.0, 0.72))
    [event] = analyse_harmony(guitar, bass, RATE, BPM, mixture=guitar + bass)
    assert (event.chord, event.status, event.bass) == (slash, "confirmed", slash.split("/")[1])


def test_bass_only_change_is_retained_but_brief_passing_note_is_not():
    guitar = chord(48, (0, 4, 7), 2.4)
    bass = np.r_[tone(36, 0.6), tone(38, 0.08), tone(36, 0.55), tone(28, 1.17)]
    events = analyse_harmony(guitar, bass, RATE, BPM)
    assert [event.chord for event in events] == ["C", "C/E"]
    assert events[1].start_s == pytest.approx(1.23, abs=0.1)


def test_bass_fundamental_is_recovered_despite_stronger_overtones():
    bass = tone(28, 1.2, harmonics=(0.28, 1.0, 0.86))
    track = analyse_bass(bass, RATE)
    name, fraction = stable_bass(track, 0.0, 1.2)
    assert name == "E"
    assert fraction > 0.9


@pytest.mark.parametrize(
    "intervals,candidate",
    [
        ((0, 4, 7, 10, 14), "C9"),
        ((0, 4, 7, 10, 14, 17), "C11"),
        ((0, 4, 7, 10, 14, 17, 21), "C13"),
        ((0, 4, 7, 11, 14), "Cmaj9"),
        ((0, 3, 7, 10, 14), "Cm9"),
    ],
)
def test_extensions_are_exposed_as_candidates(intervals, candidate):
    [event] = analyse_harmony(chord(48, intervals), None, RATE, BPM)
    assert (event.chord, event.status, event.notes) == ("N", "candidate", ())
    assert candidate in event.candidates
    assert len(event.candidates) <= 3


def test_brief_high_note_does_not_change_backing_chord():
    guitar = chord(48, (0, 4, 7), 2.2)
    lead = tone(70, 0.12)
    guitar[RATE:RATE + len(lead)] += lead
    [event] = analyse_harmony(guitar, None, RATE, BPM)
    assert event.chord == "C"


def test_short_added_note_between_identical_triads_remains_uncertain():
    guitar = chord(48, (0, 4, 7), 2.2)
    lead = tone(70, 0.17)
    guitar[RATE:RATE + len(lead)] += lead
    events = analyse_harmony(guitar, None, RATE, BPM)
    assert [event.chord for event in events if event.status == "confirmed"] == ["C", "C"]
    assert events[1].status == "candidate"
    assert "C7" in events[1].candidates


def test_one_harmonic_rich_string_does_not_become_a_power_chord():
    rich_note = (0.26, 0.59, 1.0, 0.43, 0.27, 0.29)
    single = tone(48, 1.2, harmonics=rich_note)
    double = single + tone(55, 1.2, harmonics=rich_note)
    for samples, pitch_count in ((single, 1), (double, 2)):
        evidence = guitar_note_evidence(samples, RATE)
        centre = (evidence.times_s > 0.2) & (evidence.times_s < 1.0)
        assert np.all(np.count_nonzero(evidence.strengths[centre] >= 0.18, axis=1) == pitch_count)
    [single_event] = analyse_harmony(single, None, RATE, BPM)
    [double_event] = analyse_harmony(double, None, RATE, BPM)
    assert (single_event.chord, single_event.status) == ("N", "unknown")
    assert (double_event.chord, double_event.status) == ("C5", "confirmed")


@pytest.mark.parametrize("third,expected", [(62, "A#"), (61, "A#m")])
def test_persistent_quiet_third_distinguishes_triads_from_power_chords(third, expected):
    guitar = 0.9 * tone(46, 1.2) + tone(53, 1.2) + 0.17 * tone(third, 1.2)
    [event] = analyse_harmony(guitar, None, RATE, BPM)
    assert (event.chord, event.status) == (expected, "confirmed")


def test_repeated_arpeggios_hold_the_chord_without_hiding_real_changes():
    guitar = np.concatenate([tone(note, 0.35) for note in [60, 64, 67] * 2 + [57, 60, 64] * 2])
    spans = find_arpeggios(guitar_note_evidence(guitar, RATE), bpm=BPM)
    assert np.asarray(spans) == pytest.approx(np.array([[0, 2.1], [2.1, 4.2]]), abs=0.04)
    events = analyse_harmony(guitar, None, RATE, BPM)
    assert [event.chord for event in events] == ["C", "Am"]
    assert events[1].start_s == pytest.approx(2.1, abs=0.04)
    assert all(any("繰り返されています" in text for text in event.evidence) for event in events)


@pytest.mark.parametrize("notes,scale", [([72, 76, 79], 1), ([60, 62, 64, 65], 1), ([60, 64, 67], 0.00005)])
def test_high_lead_unrelated_scale_and_inaudible_patterns_are_not_arpeggios(notes, scale):
    guitar = scale * np.concatenate([tone(note, 0.35) for note in notes * 3])
    assert find_arpeggios(guitar_note_evidence(guitar, RATE)) == []
    assert all(event.chord == "N" for event in analyse_harmony(guitar, None, RATE, BPM))


def test_plucked_demo_can_recognise_uneven_harmonic_timbres():
    guitar = synthesise_progression([("C:maj", 2), ("G:maj", 2), ("A:min", 2)], RATE)
    events = analyse_harmony(guitar, None, RATE, BPM)
    for time, expected in ((1.0, "C"), (3.0, "G"), (5.0, "Am")):
        assert next(event.chord for event in events if event.start_s <= time < event.end_s) == expected


def test_silence_is_unknown_over_the_entire_input():
    [event] = analyse_harmony(np.zeros(RATE), None, RATE, BPM)
    assert (event.start_s, event.end_s, event.chord, event.status, event.candidates) == (0, 1, "N", "unknown", ())
