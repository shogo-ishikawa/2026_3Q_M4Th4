"""コード名とテンプレートの確認"""

import numpy as np
import pytest

from guitar_chord_lab.chords import (
    CHORD_LABELS,
    chord_notes,
    make_chord_templates,
    normalise_chord_label,
    short_chord_name,
)


def test_there_are_24_chords_with_three_notes_each():
    templates = make_chord_templates()
    assert len(CHORD_LABELS) == 24
    assert templates.shape == (24, 12)
    assert np.all(templates.sum(axis=1) == 3)


def test_chord_notes_follow_major_and_minor_intervals():
    assert chord_notes("C:maj") == ["C", "E", "G"]
    assert chord_notes("A:min") == ["A", "C", "E"]
    assert chord_notes("B:maj") == ["B", "D#", "F#"]
    assert chord_notes("F#:min") == ["F#", "A", "C#"]


@pytest.mark.parametrize(
    "text, expected",
    [
        ("C", "C:maj"),
        ("C:maj", "C:maj"),
        ("Am", "A:min"),
        ("A:min", "A:min"),
        ("Bb", "A#:maj"),
        ("Ebm", "D#:min"),
        ("Db:maj", "C#:maj"),
        ("Cb:min", "B:min"),
        (" N ", "N"),
    ],
)
def test_labels_are_normalised(text, expected):
    assert normalise_chord_label(text) == expected


@pytest.mark.parametrize("text", ["C:7", "C:maj7", "C/E", "C:maj/5", "C:sus4", "H", "c", "X", ""])
def test_unsupported_labels_are_rejected(text):
    with pytest.raises(ValueError):
        normalise_chord_label(text)


def test_short_names():
    assert short_chord_name("C:maj") == "C"
    assert short_chord_name("A:min") == "Am"
    assert short_chord_name("N") == "N"
    assert short_chord_name("X") == "?"
