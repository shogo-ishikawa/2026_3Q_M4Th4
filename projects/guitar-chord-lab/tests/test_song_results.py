"""拍表と保存時刻の小節番号が、同じ拍を起点とすることを確かめます。"""

import pytest

from guitar_chord_lab.song_harmony import HarmonyEvent
from guitar_chord_lab.song_results import assemble_song, beat_grid, beat_rows, load_song, save_song


@pytest.mark.parametrize("use_detected", [True, False])
def test_pickup_does_not_shift_first_detected_beat(tmp_path, use_detected):
    grid, method, anchor_index = beat_grid(0, 1.2, (0.022, 0.522, 1.022), 120, use_detected=use_detected)
    metadata = {
        "analysis_id": "song-123456789abc", "schema_version": 1, "start_s": 0, "end_s": 1.2,
        "beat_grid_s": grid, "beat_grid_method": method, "beat_anchor_index": anchor_index,
        "beats_per_bar": 4, "separation": {"status": "separated"},
    }
    events = [HarmonyEvent(start, end, "C", "confirmed", "C", "major", ("C", "E", "G"), None, (), 1.0, ())
              for start, end in ((0, 0.022), (0.022, 1.2))]
    analysis = assemble_song(metadata, events)
    assert [(row["bar"], row["beat"]) for row in analysis.timing] == [(0, 4), (1, 1)]
    restored = load_song(save_song(analysis, tmp_path))
    rows = beat_rows(restored)
    assert [(row["bar"], row["beat"]) for row in rows] == [(0, 4), (1, 1), (1, 2), (1, 3)]
    assert rows[1]["start_s"] == pytest.approx(0.022)
