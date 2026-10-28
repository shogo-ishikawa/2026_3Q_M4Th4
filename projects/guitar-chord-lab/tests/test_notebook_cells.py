"""Notebook のセルをそのまま実行し、つまずきやすい入力（無音、前の実行のファイルが残った状態）でも止まらないことを確かめます

Notebook 全体は scripts/run_notebooks.py で実行して確かめます。ここでは、問題が起きた箇所のセルだけを、
前のセルで作られる変数を用意して実行します（データの取得や Demucs は使いません）。
"""

import json
import warnings
from pathlib import Path

import matplotlib
import numpy as np
import pytest
import soundfile as sf
from conftest import SAMPLE_RATE, silence, sine_chord

from guitar_chord_lab import make_clip

matplotlib.use("Agg")
NOTEBOOKS = Path(__file__).resolve().parents[1] / "notebooks"


def notebook_cell(name, marker):
    """Notebook から、marker を含むコードセルのソースを1つ返します。"""
    notebook = json.loads((NOTEBOOKS / name).read_text(encoding="utf-8"))
    cells = ["".join(cell["source"]) for cell in notebook["cells"] if cell["cell_type"] == "code"]
    matches = [code for code in cells if marker in code]
    assert len(matches) == 1, f"{name}: 「{marker}」を含むセルが {len(matches)} 個あります"
    return matches[0]


class FakeDisplay:
    """IPython の display の代わりに、表示しようとしたものを記録します。"""

    def __init__(self):
        self.items = []

    def __call__(self, item):
        self.items.append(item)


@pytest.mark.parametrize("silent", [True, False])
def test_notebook1_chroma_cell_handles_silent_and_normal_input(silent, capsys):
    from guitar_chord_lab.audio import prepare_for_analysis
    from guitar_chord_lab.chords import PITCH_NAMES
    from guitar_chord_lab.recognition import ChordSettings, compute_chroma
    from guitar_chord_lab.results import chroma_frame_lines

    samples = silence(2.0) if silent else sine_chord("C:maj", 2.0)
    namespace = {
        "clip": make_clip(samples, SAMPLE_RATE), "ChordSettings": ChordSettings, "PITCH_NAMES": PITCH_NAMES,
        "prepare_for_analysis": prepare_for_analysis, "compute_chroma": compute_chroma,
        "chroma_frame_lines": chroma_frame_lines,
    }
    exec(notebook_cell("01_single_guitar_chords.ipynb", "compute_chroma(mono.samples[0]"), namespace)
    printed = capsys.readouterr().out
    assert ("このフレームは無音です" in printed) == silent
    if not silent:  # 通常の音では、今までどおり最大の音が30個の # になる
        assert "#" * 30 + " 1.00" in printed


@pytest.mark.parametrize("silent", [True, False])
def test_notebook1_playback_cell_does_not_divide_by_zero(silent, tmp_path, capsys):
    pytest.importorskip("IPython")
    import matplotlib.pyplot as plt
    from IPython.display import Audio

    from guitar_chord_lab.audio import load_audio

    path = tmp_path / "input.wav"
    sf.write(path, silence(2.0) if silent else sine_chord("A:min", 2.0), SAMPLE_RATE)
    display = FakeDisplay()
    namespace = {"INPUT_PATH": str(path), "START_S": 0.0, "DURATION_S": 2.0, "load_audio": load_audio,
                 "np": np, "plt": plt, "Audio": Audio, "display": display}
    with warnings.catch_warnings():
        warnings.simplefilter("error", RuntimeWarning)  # 0で割る計算があれば失敗にする
        exec(notebook_cell("01_single_guitar_chords.ipynb", "clip = load_audio(INPUT_PATH"), namespace)
    plt.close("all")
    assert len(display.items) == 1
    assert ("完全な無音" in capsys.readouterr().out) == silent


def test_notebook3_listening_cells_use_only_conditions_of_this_run(tmp_path, monkeypatch, capsys):
    """4秒・分離ありで実行した後、2秒・分離なしで実行し直しても、聴き比べに前の分離音が混ざらないことを確かめます。"""
    import matplotlib.pyplot as plt
    from test_experiment import configure_small_study, install_identity_separation, make_small_study

    from guitar_chord_lab import experiment as exp
    from guitar_chord_lab.plots import plot_analysis, plot_comparison
    from guitar_chord_lab.recognition import recognise_chords

    install_identity_separation(monkeypatch)  # Demucs の代わりに、入力をそのまま返す分離
    config = make_small_study(tmp_path)
    exp.run_experiment(exp.load_experiment(config), conditions=["solo", "mixture", "separated"])
    experiment = exp.load_experiment(configure_small_study(config, duration_s=2.0))
    result = exp.run_experiment(experiment, conditions=["solo", "mixture"])
    capsys.readouterr()

    imports = notebook_cell("03_comparison_experiment.ipynb", "import guitar_chord_lab as gcl")
    assert "load_listening_clips" in imports
    display = FakeDisplay()
    namespace = {
        "result": result, "experiment": experiment, "LEVELS_DB": [0.0, 10.0], "np": np, "plt": plt,
        "Audio": lambda samples, **kwargs: samples, "display": display,
        "load_listening_clips": exp.load_listening_clips, "recognise_chords": recognise_chords,
        "plot_comparison": plot_comparison, "plot_analysis": plot_analysis,
    }
    exec(notebook_cell("03_comparison_experiment.ipynb", "RECORDING_ID ="), namespace)
    exec(notebook_cell("03_comparison_experiment.ipynb", "listening.reference"), namespace)
    plt.close("all")
    printed = capsys.readouterr().out
    assert list(namespace["analyses"]) == ["solo", "mixture"] and namespace["CONDITION"] == "mixture"
    assert all(samples.shape[-1] == 2 * 22050 for samples in display.items)  # 再生したのは今回の2秒の音だけ
    assert "separated: 今回の実行の条件に含まれていません" in printed
    assert "solo（2.00 秒）" in printed and "mixture（2.00 秒）" in printed


def test_notebook3_listening_cells_work_for_recorded_mixtures_without_accompaniments(tmp_path, monkeypatch, capsys):
    """伴奏の設定がない（合奏録音だけの）実験でも、聴き比べのセルが止まらないことを確かめます。"""
    import matplotlib.pyplot as plt
    from test_experiment import install_identity_separation, make_recorded_study

    from guitar_chord_lab import experiment as exp
    from guitar_chord_lab.plots import plot_analysis, plot_comparison
    from guitar_chord_lab.recognition import recognise_chords

    install_identity_separation(monkeypatch, scale=0.25)
    experiment = exp.load_experiment(make_recorded_study(tmp_path))
    result = exp.run_experiment(experiment, conditions=["solo", "mixture", "separated"])
    capsys.readouterr()
    namespace = {
        "result": result, "experiment": experiment, "LEVELS_DB": [0.0], "np": np, "plt": plt,
        "Audio": lambda samples, **kwargs: samples, "display": FakeDisplay(),
        "load_listening_clips": exp.load_listening_clips, "recognise_chords": recognise_chords,
        "plot_comparison": plot_comparison, "plot_analysis": plot_analysis,
    }
    exec(notebook_cell("03_comparison_experiment.ipynb", "RECORDING_ID ="), namespace)
    exec(notebook_cell("03_comparison_experiment.ipynb", "listening.reference"), namespace)
    plt.close("all")
    assert namespace["ACCOMPANIMENT_ID"] is None
    assert list(namespace["analyses"]) == ["solo", "mixture", "separated"] and namespace["CONDITION"] == "separated"
    assert "聴けない条件" not in capsys.readouterr().out
