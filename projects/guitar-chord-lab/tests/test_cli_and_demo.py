"""合成デモの生成とコマンドラインの確認"""

import json
from pathlib import Path

from guitar_chord_lab.cli import evaluate_saved_prediction, main
from guitar_chord_lab.evaluation import ChordInterval, read_annotation_csv, write_annotation_csv
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
    assert main([
        "evaluate", str(output_dir / "chords.csv"), str(data_dir / "demo_a_annotation.csv"), "--duration", "8",
    ]) == 0
    assert "確かめていません" in capsys.readouterr().out


def write_evaluation_case(folder, predictions, annotation, offset_s=0.0, duration_s=4.0, audio_s=4.0,
                          metadata=True, source_columns=True):
    """evaluate の確認用に、元の音声ファイル・正解注釈・chords.csv・analysis.json を作ります。"""
    import numpy as np
    import soundfile as sf

    sf.write(folder / "take.wav", np.zeros(int(audio_s * 8000)), 8000)
    write_annotation_csv(folder / "annotation.csv", [ChordInterval(*row) for row in annotation])
    out = folder / "out"
    out.mkdir()
    lines = ["start_s,end_s,source_start_s,source_end_s,status,chord" if source_columns else "start_s,end_s,status,chord"]
    for start, end, chord in predictions:
        source = f"{start + offset_s},{end + offset_s}," if source_columns else ""
        lines.append(f"{start},{end},{source}chord,{chord}")
    (out / "chords.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")
    if metadata:  # analyse が保存する analysis.json と同じく、解析した範囲（切り出し位置と長さ）を記録する
        info = {"input": {"source_path": str(folder / "take.wav"), "offset_s": offset_s, "duration_s": duration_s}}
        (out / "analysis.json").write_text(json.dumps(info), encoding="utf-8")
    return out / "chords.csv", folder / "annotation.csv"


def test_evaluate_counts_a_missing_tail_of_the_predictions(tmp_path, capsys):
    """解析した4秒のうち予測が0〜2秒しかなければ、残りの2秒は「予測なし」として不正解に数えます。"""
    prediction, annotation = write_evaluation_case(tmp_path, [(0.0, 2.0, "C:maj")], [(0.0, 4.0, "C:maj")])
    metrics, start_s, length_s, total_s, unchecked = evaluate_saved_prediction(prediction, annotation)
    assert (start_s, length_s, total_s, unchecked) == (0.0, 4.0, 4.0, "")
    assert (metrics["evaluated_s"], metrics["correct_s"], metrics["missing_s"]) == (4.0, 2.0, 2.0)
    assert metrics["accuracy"] == 0.5 and metrics["decided_ratio"] == 0.5
    assert main(["evaluate", str(prediction), str(annotation)]) == 0
    printed = capsys.readouterr().out
    assert "accuracy = 0.500" in printed and "予測なし 2.00秒" in printed and "解析した長さ 4.00 秒" in printed


def test_evaluate_counts_a_missing_part_in_the_middle(tmp_path):
    prediction, annotation = write_evaluation_case(
        tmp_path, [(0.0, 1.0, "C:maj"), (3.0, 4.0, "C:maj")], [(0.0, 4.0, "C:maj")],
    )
    metrics = evaluate_saved_prediction(prediction, annotation)[0]
    assert (metrics["evaluated_s"], metrics["correct_s"], metrics["missing_s"], metrics["accuracy"]) == (4.0, 2.0, 2.0, 0.5)


def test_evaluate_uses_the_analysed_clip_not_the_whole_file(tmp_path, capsys):
    """10秒のファイルの3秒目から4秒間を解析した場合、評価するのは元ファイルの3〜7秒（4秒間）です。"""
    prediction, annotation = write_evaluation_case(
        tmp_path, [(0.0, 2.0, "C:maj")], [(0.0, 5.0, "C:maj"), (5.0, 10.0, "G:maj")], offset_s=3.0, audio_s=10.0,
    )
    metrics, start_s, length_s, total_s, unchecked = evaluate_saved_prediction(prediction, annotation)
    assert (start_s, length_s, total_s, unchecked) == (3.0, 4.0, 10.0, "")
    assert (metrics["evaluated_s"], metrics["correct_s"], metrics["missing_s"]) == (4.0, 2.0, 2.0)
    same = evaluate_saved_prediction(prediction, annotation, offset_s=3.0)  # 記録と同じ位置なら、元ファイルの長さも確かめる
    assert same[3:] == (10.0, "")
    shifted = evaluate_saved_prediction(prediction, annotation, offset_s=5.0)[0]  # --offset は今までどおり上書きする
    assert (shifted["evaluated_s"], shifted["wrong_s"], shifted["missing_s"]) == (4.0, 2.0, 2.0)
    assert main(["evaluate", str(prediction), str(annotation), "--offset", "5"]) == 0
    printed = capsys.readouterr().out
    assert "元ファイルの 5.00〜9.00 秒" in printed
    assert "--offset で指定した切り出し位置が analysis.json の記録と違うため" in printed  # 確かめない本当の理由を表示する


def test_evaluate_without_analysis_metadata_needs_an_explicit_range(tmp_path, capsys):
    prediction, annotation = write_evaluation_case(tmp_path, [(0.0, 2.0, "C:maj")], [(0.0, 4.0, "C:maj")],
                                                   metadata=False)
    assert main(["evaluate", str(prediction), str(annotation)]) == 1  # 予測の最後の時刻からは決めない
    error = capsys.readouterr().err
    assert "--duration" in error and "analysis.json" in error
    assert main(["evaluate", str(prediction), str(annotation), "--duration", "4"]) == 0
    printed = capsys.readouterr().out
    assert "予測なし 2.00秒" in printed and "元の音声ファイルが見つからないため" in printed and "確かめていません" in printed


def test_evaluate_without_source_times_needs_the_offset_too(tmp_path, capsys):
    prediction, annotation = write_evaluation_case(tmp_path, [(0.0, 2.0, "C:maj")], [(0.0, 4.0, "C:maj")],
                                                   metadata=False, source_columns=False)
    assert main(["evaluate", str(prediction), str(annotation), "--duration", "4"]) == 1
    assert "--offset" in capsys.readouterr().err
    metrics = evaluate_saved_prediction(prediction, annotation, offset_s=0.0, duration_s=4.0)[0]
    assert metrics["missing_s"] == 2.0 and metrics["accuracy"] == 0.5


def test_evaluate_rejects_ranges_that_do_not_match_the_files(tmp_path):
    import pytest

    prediction, annotation = write_evaluation_case(tmp_path, [(0.0, 2.0, "C:maj")], [(0.0, 10.0, "C:maj")],
                                                   offset_s=3.0, audio_s=10.0)
    with pytest.raises(ValueError, match="評価する区間の長さ 1.00 秒を超えています"):
        evaluate_saved_prediction(prediction, annotation, duration_s=1.0)
    with pytest.raises(ValueError, match="元の音声ファイル全体の長さ 10.00 秒を超えています"):
        evaluate_saved_prediction(prediction, annotation, duration_s=8.0)  # 記録した切り出し位置3秒から8秒間
    for value in ["nan", "inf"]:
        with pytest.raises(ValueError, match="有限の数"):
            evaluate_saved_prediction(prediction, annotation, duration_s=float(value))
    info = json.loads((prediction.parent / "analysis.json").read_text(encoding="utf-8"))
    info["input"]["offset_s"] = 0.0  # chords.csv（3秒）と食い違う記録
    (prediction.parent / "analysis.json").write_text(json.dumps(info), encoding="utf-8")
    with pytest.raises(ValueError, match="一致しません"):
        evaluate_saved_prediction(prediction, annotation)


def test_evaluate_offset_for_a_file_cut_before_analysis(tmp_path, capsys):
    """元のファイルの5秒目から切り出して保存した4秒のファイルを解析した場合も、--offset 5 で元の時刻の注釈と比べられます。"""
    prediction, annotation = write_evaluation_case(
        tmp_path, [(0.0, 2.0, "C:maj")], [(0.0, 5.0, "G:maj"), (5.0, 9.0, "C:maj")], audio_s=4.0,
    )  # analysis.json には、切り出したファイル（4秒、切り出し位置0秒）が記録されている
    assert main(["evaluate", str(prediction), str(annotation), "--offset", "5"]) == 0
    printed = capsys.readouterr().out
    assert "元ファイルの 5.00〜9.00 秒" in printed and "予測なし 2.00秒" in printed
    assert "analysis.json の記録と違うため" in printed and "確かめていません" in printed


def test_evaluate_reads_analysis_json_with_a_bom_and_reports_missing_ranges(tmp_path, capsys):
    import pytest

    prediction, annotation = write_evaluation_case(tmp_path, [(0.0, 2.0, "C:maj")], [(0.0, 4.0, "C:maj")],
                                                   source_columns=False)  # 切り出し位置は analysis.json から読む
    info_path = prediction.parent / "analysis.json"
    info_path.write_bytes(b"\xef\xbb\xbf" + info_path.read_bytes())  # 先頭に BOM を付けて保存した analysis.json
    metrics, start_s, length_s = evaluate_saved_prediction(prediction, annotation)[:3]
    assert (start_s, length_s, metrics["missing_s"]) == (0.0, 4.0, 2.0)
    info_path.write_text(json.dumps({"input": {"source_path": ""}}), encoding="utf-8")
    with pytest.raises(ValueError, match="analysis.json に、解析した範囲"):
        evaluate_saved_prediction(prediction, annotation)
    info_path.write_text("{ not json", encoding="utf-8")
    with pytest.raises(ValueError, match="読み込めませんでした"):
        evaluate_saved_prediction(prediction, annotation)
    metrics = evaluate_saved_prediction(prediction, annotation, offset_s=0.0, duration_s=4.0)[0]  # 区間を両方指定すれば評価できる
    assert metrics["missing_s"] == 2.0


def test_evaluate_matches_analyse_for_a_clip_that_does_not_resample_exactly(tmp_path, capsys):
    """7.25秒（44.1 kHz）の切り出しは 22.05 kHz に変換すると1サンプル長くなりますが、analyse と evaluate は同じ区間で評価します。"""
    data_dir = tmp_path / "demo_data"
    write_demo_dataset(data_dir)
    output_dir = tmp_path / "clip"
    annotation = str(data_dir / "demo_b_annotation.csv")
    assert main([
        "analyse", str(data_dir / "demo_b_guitar.wav"), "--start", "2.5", "--duration", "7.25",
        "--annotation", annotation, "--output-dir", str(output_dir),
    ]) == 0
    expected = json.loads((output_dir / "evaluation.json").read_text(encoding="utf-8"))
    metrics = evaluate_saved_prediction(output_dir / "chords.csv", annotation)[0]
    assert metrics == expected and metrics["evaluated_s"] == 7.25
