"""GuitarSet の注釈変換と素材確認の確認（小さな JAMS を作って確かめます）"""

import json
import os
import tomllib

import numpy as np
import pytest
import soundfile as sf

from guitar_chord_lab import guitarset as gs
from guitar_chord_lab.evaluation import AnnotationError, read_annotation_csv


def write_jams(path, chords, notes):
    """GuitarSet と同じ形の、最小限の JAMS ファイルを作ります。"""
    annotations = [
        {"namespace": "note_midi", "annotation_metadata": {"data_source": "0"},
         "data": [{"time": s, "duration": e - s, "value": midi, "confidence": None} for s, e, midi in notes]},
        {"namespace": "chord", "annotation_metadata": {"data_source": ""},
         "data": [{"time": s, "duration": e - s, "value": label, "confidence": None} for s, e, label in chords]},
        {"namespace": "chord", "annotation_metadata": {"data_source": "Semi-automatic chord transcription"},
         "data": [{"time": 0.0, "duration": 4.0, "value": "C:maj/5", "confidence": None}]},
    ]
    path.write_text(json.dumps({"annotations": annotations, "file_metadata": {}, "sandbox": {}}), encoding="utf-8")
    return path


def test_instructed_chords_are_converted_and_cut_to_the_audio_length(tmp_path):
    jams = write_jams(tmp_path / "t.jams", [(0.0, 2.0, "C:maj"), (2.0, 4.2, "A:min"), (4.2, 5.0, "F:maj")], [])
    intervals = gs.jams_to_intervals(jams, duration_s=4.0)
    assert [(i.start_s, i.end_s, i.chord) for i in intervals] == [(0.0, 2.0, "C:maj"), (2.0, 4.0, "A:min")]
    csv_path = gs.jams_to_annotation_csv(jams, tmp_path / "t.csv", duration_s=4.0)
    assert read_annotation_csv(csv_path) == intervals


def test_tiny_pieces_after_cutting_are_dropped(tmp_path):
    jams = write_jams(tmp_path / "t.jams", [(0.0, 3.9996, "C:maj"), (3.9996, 6.0, "G:maj")], [])
    intervals = gs.jams_to_intervals(jams, duration_s=4.0)
    assert [i.chord for i in intervals] == ["C:maj"]  # 0.4ミリ秒だけ残る G:maj は使わない


def test_unsupported_instructed_chords_are_not_replaced(tmp_path):
    jams = write_jams(tmp_path / "t.jams", [(0.0, 2.0, "C:maj"), (2.0, 4.0, "G:7")], [])
    with pytest.raises(AnnotationError, match="G:7"):
        gs.jams_to_intervals(jams)


def test_third_played_ratio_uses_the_note_annotations(tmp_path):
    chords = [(0.0, 2.0, "C:maj"), (2.0, 4.0, "A:min")]
    full = [(0.0, 2.0, 48), (0.0, 2.0, 52), (0.0, 2.0, 55), (2.0, 4.0, 57), (2.0, 4.0, 60)]  # C-E-G、A-C
    roots_only = [(0.0, 2.0, 48), (2.0, 4.0, 57)]  # 根音だけ
    assert gs.third_played_ratio(write_jams(tmp_path / "a.jams", chords, full)) == pytest.approx(1.0)
    assert gs.third_played_ratio(write_jams(tmp_path / "b.jams", chords, roots_only)) == pytest.approx(0.0)
    half = [(0.0, 2.0, 52), (2.0, 4.0, 57)]  # Cの区間だけ3度（E）がある
    assert gs.third_played_ratio(write_jams(tmp_path / "c.jams", chords, half)) == pytest.approx(0.5)


def test_prepared_config_can_be_loaded(tmp_path, monkeypatch):
    """取り出し処理をまねて、作った実験設定がそのまま読み込めることを確かめます。"""
    def fake_download(track_id, folder):
        sf.write(folder / f"{track_id}_mic.wav", 0.1 * np.ones(44100 * 5), 44100)
        jams = write_jams(folder / f"{track_id}.jams", [(0.0, 5.0, "E:min")], [(0.0, 5.0, 55)])
        return folder / f"{track_id}_mic.wav", jams

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setattr(gs, "download_track", fake_download)
    config = gs.prepare_guitarset_experiment(
        ["00_X1-100-E_comp", "01_X1-100-E_comp"], data_dir, tmp_path / "cfg" / "exp.toml", duration_s=3.0,
        output_dir=tmp_path / "out", cache_dir=tmp_path / "cache",
    )
    with open(config, "rb") as file:
        raw = tomllib.load(file)
    assert [item["split"] for item in raw["recordings"]] == ["tuning", "evaluation"]
    assert raw["recordings"][0]["third_played_ratio"] == 1.0

    from guitar_chord_lab.experiment import load_experiment

    experiment = load_experiment(config)
    assert experiment.recordings[1]["duration_s"] == 3.0
    assert experiment.accompaniments[0]["material"] == "synthetic"


@pytest.mark.skipif(os.environ.get("RUN_NETWORK_TESTS") != "1", reason="RUN_NETWORK_TESTS=1 のときだけ実行します")
def test_download_one_track_from_zenodo(tmp_path):
    audio, annotation = gs.prepare_track(gs.EXAMPLE_TRACKS[0], tmp_path)
    assert sf.info(str(audio)).samplerate == 44100
    assert read_annotation_csv(annotation)
    assert gs.third_played_ratio(tmp_path / f"{gs.EXAMPLE_TRACKS[0]}.jams") >= gs.MIN_THIRD_RATIO


def test_interrupted_download_is_not_used_as_a_finished_file(tmp_path, monkeypatch):
    import io
    import zipfile

    archive_path = tmp_path / "remote.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("a_mic.wav", b"x" * 5000)
    monkeypatch.setattr(gs, "HttpRangeFile", lambda url: io.FileIO(archive_path))
    destination = tmp_path / "data" / "a_mic.wav"

    def broken_copy(source, target):
        target.write(source.read(100))
        raise OSError("connection reset")

    monkeypatch.setattr(gs.shutil, "copyfileobj", broken_copy)
    with pytest.raises(OSError):
        gs.fetch_zip_member("remote.zip", "a_mic.wav", destination)
    assert not destination.exists()  # 途中までのファイルは .part のまま残り、完成品として使われない
    monkeypatch.undo()
    monkeypatch.setattr(gs, "HttpRangeFile", lambda url: io.FileIO(archive_path))
    gs.fetch_zip_member("remote.zip", "a_mic.wav", destination)
    assert destination.read_bytes() == b"x" * 5000


def test_unknown_recording_id_gives_a_clear_error(tmp_path, monkeypatch, capsys):
    import io
    import zipfile

    from guitar_chord_lab.cli import main

    archive_path = tmp_path / "remote.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("01_Rock3-117-Bb_comp_mic.wav", b"x" * 100)
    monkeypatch.setattr(gs, "HttpRangeFile", lambda url: io.FileIO(archive_path))
    with pytest.raises(ValueError, match="録音IDを確かめてください"):
        gs.fetch_zip_member("remote.zip", "01_Rock3-117-Bb_mic.wav", tmp_path / "x.wav")  # 末尾の _comp がない
    code = main(["guitarset", "--tracks", "01_Rock3-117-Bb", "--data-dir", str(tmp_path / "gs"),
                 "--config", str(tmp_path / "gs" / "exp.toml")])
    assert code == 1 and "_comp" in capsys.readouterr().err


def test_network_failure_is_explained_without_a_traceback(tmp_path, monkeypatch, capsys):
    import urllib.error

    from guitar_chord_lab.cli import main

    def offline(url):
        raise urllib.error.URLError("Temporary failure in name resolution")

    monkeypatch.setattr(gs, "HttpRangeFile", offline)
    with pytest.raises(ConnectionError, match="インターネット"):
        gs.fetch_zip_member("remote.zip", "a_mic.wav", tmp_path / "a_mic.wav")
    code = main(["guitarset", "--data-dir", str(tmp_path / "gs"), "--config", str(tmp_path / "gs" / "exp.toml")])
    assert code == 1 and "インターネット" in capsys.readouterr().err


def test_third_played_ratio_is_not_pushed_below_a_boundary_by_rounding_errors(monkeypatch):
    """計算の誤差で、ちょうど半分（0.5）が 0.4999… にならないことを確かめます（しきい値と比べるため）。"""
    edges = [0.0, 0.1, 0.1 + 0.2, 0.75, 1.1]
    chords = [(start, end, "C:maj") for start, end in zip(edges, edges[1:])]
    third_notes = [(edges[0], edges[1], 4), (edges[2], edges[3], 4)]  # 1つ目と3つ目の区間だけ E（3度）を弾く
    monkeypatch.setattr(gs, "read_instructed_chords", lambda path: chords)
    monkeypatch.setattr(gs, "read_played_notes", lambda path: third_notes)
    assert gs.third_played_ratio("unused.jams") == 0.5
