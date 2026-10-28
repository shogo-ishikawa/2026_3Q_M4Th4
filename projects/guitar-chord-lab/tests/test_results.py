"""保存と記録（JSON、図の文字、コードの版、配布ZIPの版情報）の確認"""

import datetime
import importlib.util
import json
import warnings
import zipfile
from pathlib import Path

import matplotlib
import numpy as np
from conftest import SAMPLE_RATE, sine_chord

from guitar_chord_lab import ChordSettings, make_clip, recognise_chords
from guitar_chord_lab import results
from guitar_chord_lab.plots import figure_text, plot_analysis

matplotlib.use("Agg")
PROJECT_DIR = Path(__file__).resolve().parents[1]


def test_release_info_is_preferred_over_an_enclosing_git_repository(tmp_path, monkeypatch):
    """配布ZIPを別のGitリポジトリの中に展開しても、ZIPを作ったときのコミットを記録します。"""
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'x'\n", encoding="utf-8")
    (tmp_path / "release_info.json").write_text(json.dumps({"git_commit": "abc123"}), encoding="utf-8")
    monkeypatch.setattr(results, "PROJECT_DIR", tmp_path)
    info = results.code_version()
    assert info["release"]["git_commit"] == "abc123" and "git" not in info


def test_commit_is_unknown_outside_the_project_folder(tmp_path, monkeypatch):
    """pip install . で入れたコードのように、作品フォルダの外にあるコードではコミットを推測しません。"""
    monkeypatch.setattr(results, "PROJECT_DIR", tmp_path)
    info = results.code_version()
    assert info["git"] == "unknown" and info["code_location"]


def test_json_can_store_dates_from_settings_files(tmp_path):
    path = results.save_json(tmp_path / "info.json", {"date": datetime.date(2026, 10, 27)})
    assert json.loads(path.read_text(encoding="utf-8")) == {"date": "2026-10-27"}


def test_japanese_titles_do_not_break_the_figure(tmp_path):
    assert figure_text("録音_take2.wav") == "??_take2.wav"
    analysis = recognise_chords(make_clip(sine_chord("C:maj", 3.0), SAMPLE_RATE), ChordSettings())
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        figure = plot_analysis(analysis, "録音.wav")
        figure.savefig(tmp_path / "figure.png")
    assert not [item for item in caught if "Glyph" in str(item.message)]  # フォントにない文字の警告が出ない


def load_release_script():
    spec = importlib.util.spec_from_file_location("make_release_zip", PROJECT_DIR / "scripts" / "make_release_zip.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_release_zip_records_uncommitted_changes(tmp_path):
    script = load_release_script()
    path = script.make_zip(tmp_path / "x.zip", "0.1.0", [Path("pyproject.toml")], "abc123", True)
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        info = json.loads(archive.read("v0.1.0/release_info.json"))
    assert names == ["v0.1.0/pyproject.toml", "v0.1.0/release_info.json"]
    assert info["git_commit"] == "abc123" and info["uncommitted_changes"] is True


def test_chroma_frame_of_silence_is_shown_without_dividing_by_zero():
    lines = results.chroma_frame_lines(np.zeros(12))
    assert "無音" in lines[0]
    assert len(lines) == 13 and all(line.endswith("0.00") for line in lines[1:])


def test_chroma_frame_display_keeps_the_usual_bars():
    values = np.zeros(12)
    values[0], values[4], values[7] = 2.0, 1.0, 0.5  # C、E、G
    lines = results.chroma_frame_lines(values)
    assert len(lines) == 12  # 説明の行はない
    assert lines[0] == "   C: " + "#" * 30 + " 1.00"
    assert lines[4] == "   E: " + "#" * 15 + " " * 15 + " 0.50"
    assert lines[7].endswith("0.25") and lines[1].endswith("0.00")
