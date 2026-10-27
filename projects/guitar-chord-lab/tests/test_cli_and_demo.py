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


def test_evaluate_command_matches_the_analyse_result(tmp_path, capsys):
    """保存した chords.csv を evaluate で評価すると、analyse --annotation と同じ値になります。"""
    data_dir = tmp_path / "demo_data"
    write_demo_dataset(data_dir)
    output_dir = tmp_path / "clip"
    annotation = str(data_dir / "demo_b_annotation.csv")
    assert main([
        "analyse", str(data_dir / "demo_b_guitar.wav"), "--start", "3", "--duration", "8",
        "--annotation", annotation, "--output-dir", str(output_dir),
    ]) == 0
    expected = json.loads((output_dir / "evaluation.json").read_text(encoding="utf-8"))
    capsys.readouterr()
    assert main(["evaluate", str(output_dir / "chords.csv"), annotation]) == 0
    printed = capsys.readouterr().out
    assert "3.00〜11.00 秒" in printed
    assert f"accuracy = {expected['accuracy']:.3f}" in printed


def test_annotation_longer_than_the_audio_file_is_reported(tmp_path, capsys):
    import soundfile as sf

    data_dir = tmp_path / "demo_data"
    write_demo_dataset(data_dir)
    samples, rate = sf.read(data_dir / "demo_a_guitar.wav")
    sf.write(tmp_path / "trimmed.wav", samples[4 * rate: 12 * rate], rate)  # 4〜12秒だけを別のファイルにした
    code = main([
        "analyse", str(tmp_path / "trimmed.wav"), "--annotation", str(data_dir / "demo_a_annotation.csv"),
        "--output-dir", str(tmp_path / "out"),
    ])
    assert code == 1
    assert "音源の長さ" in capsys.readouterr().err


def test_set_option_names_the_setting_when_the_value_is_wrong(tmp_path, capsys):
    code = main(["demo", "--data-dir", str(tmp_path / "d"), "--output-dir", str(tmp_path / "o"),
                 "--set", "smoothing_segments=5.0"])
    assert code == 1
    assert "--set smoothing_segments=5.0" in capsys.readouterr().err


def fake_separation(monkeypatch, calls=None):
    """Demucs の代わりに、入力をそのまま guitar として返す分離をまねます。"""
    import numpy as np

    from guitar_chord_lab import make_clip
    from guitar_chord_lab import separation as sep

    def fake_separate(clip, *args, **kwargs):
        if calls is not None:
            calls.append(clip.offset_s)
        guitar = make_clip(np.repeat(clip.samples, 2, axis=0), 44100, clip.source_path, clip.offset_s)
        return sep.SeparationResult(guitar, guitar, "fake", "cpu", False, 0.0, {"model": "fake"})

    monkeypatch.setattr(sep, "separate_guitar", fake_separate)


def test_separate_command_records_the_source_position(tmp_path, monkeypatch, capsys):
    fake_separation(monkeypatch)
    data_dir = tmp_path / "demo_data"
    write_demo_dataset(data_dir)
    output_dir = tmp_path / "separated"
    code = main(["separate", str(data_dir / "demo_a_guitar.wav"), "--start", "4", "--duration", "6",
                 "--output-dir", str(output_dir)])
    assert code == 0
    info = json.loads((output_dir / "separation.json").read_text(encoding="utf-8"))
    assert info["input"]["offset_s"] == 4.0 and info["input"]["duration_s"] == 6.0
    assert info["input"]["sha256"] and info["model"] == "fake"
    assert "librosa" in info["libraries"] and "code" in info
    assert "元ファイルの 4.00 秒" in capsys.readouterr().out


def test_annotation_is_checked_before_the_slow_separation(tmp_path, monkeypatch, capsys):
    calls = []
    fake_separation(monkeypatch, calls)
    data_dir = tmp_path / "demo_data"
    write_demo_dataset(data_dir)
    broken = tmp_path / "broken.csv"
    broken.write_text("start_s,end_s,chord\n0,2,C:7\n", encoding="utf-8")
    code = main(["analyse", str(data_dir / "demo_a_guitar.wav"), "--separate", "--annotation", str(broken),
                 "--output-dir", str(tmp_path / "out")])
    assert code == 1 and calls == []  # 注釈の誤りを、分離を始める前に報告する
    assert "対応外のコード" in capsys.readouterr().err


def test_evaluate_checks_the_annotation_against_the_recorded_audio_file(tmp_path, capsys):
    data_dir = tmp_path / "demo_data"
    write_demo_dataset(data_dir)
    output_dir = tmp_path / "clip"
    assert main(["analyse", str(data_dir / "demo_a_guitar.wav"), "--duration", "8", "--output-dir", str(output_dir)]) == 0
    in_milliseconds = tmp_path / "ms.csv"
    in_milliseconds.write_text("start_s,end_s,chord\n0,1000,N\n1000,18000,C:maj\n", encoding="utf-8")
    capsys.readouterr()
    assert main(["evaluate", str(output_dir / "chords.csv"), str(in_milliseconds)]) == 1
    assert "音源の長さ" in capsys.readouterr().err
    (output_dir / "analysis.json").unlink()  # 元の音声ファイルが分からないときは、確かめられないことを表示する
    assert main(["evaluate", str(output_dir / "chords.csv"), str(data_dir / "demo_a_annotation.csv")]) == 0
    assert "確かめていません" in capsys.readouterr().out
