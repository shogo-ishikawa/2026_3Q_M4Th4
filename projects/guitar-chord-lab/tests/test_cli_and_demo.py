"""合成デモの生成とコマンドラインの確認"""

import json
from pathlib import Path

from guitar_chord_lab.cli import main
from guitar_chord_lab.evaluation import read_annotation_csv
from guitar_chord_lab.synth import write_demo_dataset

PROJECT_DIR = Path(__file__).resolve().parents[1]


def test_demo_dataset_matches_the_committed_example(tmp_path):
    manifest = write_demo_dataset(tmp_path / "demo")
    generated = read_annotation_csv(tmp_path / "demo" / "demo_a_annotation.csv")
    example = read_annotation_csv(PROJECT_DIR / "data" / "examples" / "demo_a_annotation.csv")
    assert generated == example
    assert [item["id"] for item in manifest["recordings"]] == ["demo_a", "demo_b"]
    assert manifest["accompaniments"][0]["id"] == "drums_120bpm_seed0"
    assert (tmp_path / "demo" / "drums_120bpm_seed0.wav").exists()


def test_demo_command_saves_csv_json_and_figure(tmp_path, capsys):
    data_dir = tmp_path / "demo_data"
    output_dir = tmp_path / "demo_out"
    code = main(["demo", "--data-dir", str(data_dir), "--output-dir", str(output_dir), "--pdf"])
    assert code == 0
    for name in ["chords.csv", "chord_scores.csv", "analysis.json", "analysis.png", "analysis.pdf", "evaluation.json"]:
        assert (output_dir / name).exists(), name
    info = json.loads((output_dir / "analysis.json").read_text(encoding="utf-8"))
    assert info["settings"]["segment_seconds"] == 0.5
    assert "librosa" in info["libraries"]
    assert "正解率" in capsys.readouterr().out


def test_analyse_with_settings_override_and_evaluate(tmp_path, capsys):
    data_dir = tmp_path / "demo_data"
    write_demo_dataset(data_dir)
    output_dir = tmp_path / "analyse"
    code = main([
        "analyse", str(data_dir / "demo_b_guitar.wav"), "--start", "3", "--duration", "8",
        "--set", "segment_seconds=0.25", "--set", "smoothing_segments=1",
        "--output-dir", str(output_dir),
    ])
    assert code == 0
    info = json.loads((output_dir / "analysis.json").read_text(encoding="utf-8"))
    assert info["settings"]["segment_seconds"] == 0.25
    assert info["input"]["offset_s"] == 3.0
    code = main([
        "evaluate", str(output_dir / "chords.csv"), str(data_dir / "demo_b_annotation.csv"), "--offset", "3",
    ])
    assert code == 0
    assert "accuracy" in capsys.readouterr().out


def test_cli_reports_clear_errors(tmp_path, capsys):
    assert main(["analyse", str(tmp_path / "missing.wav")]) == 1
    assert "見つかりません" in capsys.readouterr().err
    assert main(["demo", "--data-dir", str(tmp_path / "d"), "--output-dir", str(tmp_path / "o"), "--set", "min_score=2"]) == 1
    assert "min_score" in capsys.readouterr().err


def test_analyse_with_separation_keeps_source_times(tmp_path, monkeypatch, capsys):
    """--separate と --start を使っても、分離音の結果が元ファイルの時刻で記録・評価されることを確かめます。"""
    import csv

    import numpy as np

    from guitar_chord_lab import make_clip
    from guitar_chord_lab import separation as sep

    def fake_separate(clip, *args, **kwargs):
        guitar = make_clip(np.repeat(clip.samples, 2, axis=0), 44100, clip.source_path, clip.offset_s)
        return sep.SeparationResult(guitar, guitar, "fake", "cpu", False, 0.0, {"model": "fake"})

    monkeypatch.setattr(sep, "separate_guitar", fake_separate)
    data_dir = tmp_path / "demo_data"
    write_demo_dataset(data_dir)
    output_dir = tmp_path / "separate"
    code = main([
        "analyse", str(data_dir / "demo_a_guitar.wav"), "--start", "4", "--duration", "6", "--separate",
        "--annotation", str(data_dir / "demo_a_annotation.csv"), "--output-dir", str(output_dir),
    ])
    assert code == 0
    with open(output_dir / "separated" / "chords.csv", newline="", encoding="utf-8") as file:
        rows = list(csv.DictReader(file))
    assert float(rows[0]["start_s"]) == 0.0 and float(rows[0]["source_start_s"]) == 4.0
    info = json.loads((output_dir / "separated" / "analysis.json").read_text(encoding="utf-8"))
    assert info["evaluation"]["evaluated_s"] == 6.0
    assert info["separation"]["options"]["model"] == "fake"
    assert (output_dir / "input" / "evaluation.json").exists()
