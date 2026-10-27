"""比較実験（混合、時間ずれ、元素材単位の分割、結果の集計）の確認"""

import csv
import json

import numpy as np
import pytest
import soundfile as sf
from conftest import silence, sine_chord

from guitar_chord_lab import experiment as exp
from guitar_chord_lab import make_clip
from guitar_chord_lab import separation as sep
from guitar_chord_lab.evaluation import ChordInterval, write_annotation_csv


def test_mixing_keeps_the_requested_level_even_with_clip_guard():
    rng = np.random.default_rng(0)
    guitar = 0.3 * np.sin(np.linspace(0, 400 * np.pi, 44100))
    drums = rng.uniform(-1, 1, 44100)
    for level in [-6.0, 0.0, 6.0, 12.0]:
        mix = exp.mix_at_level(guitar, drums, level, peak_limit=0.99)
        assert mix.measured_db == pytest.approx(level, abs=1e-6)
        assert np.max(np.abs(mix.mixture)) <= 0.99 + 1e-9
        rebuilt = mix.guitar_gain * guitar + mix.accompaniment_gain * drums
        assert np.allclose(rebuilt, mix.mixture)  # ギターと伴奏に同じ倍率が掛かっている
        assert 20 * np.log10(exp.rms(mix.accompaniment_gain * drums) / exp.rms(mix.guitar_gain * guitar)) == pytest.approx(level)
    assert exp.mix_at_level(guitar, drums, 12.0).clip_guard_gain < 1.0


def test_mixing_errors():
    with pytest.raises(ValueError, match="無音"):
        exp.mix_at_level(np.zeros(100), np.ones(100), 0.0)
    with pytest.raises(ValueError, match="無音"):
        exp.mix_at_level(np.ones(100), np.zeros(100), 0.0)
    with pytest.raises(ValueError, match="長さ"):
        exp.mix_at_level(np.ones(100), np.ones(90), 0.0)


def test_lag_estimation_finds_a_known_delay():
    rng = np.random.default_rng(1)
    reference = rng.standard_normal(22050)
    delayed = np.concatenate([np.zeros(110), reference[:-110]])
    assert exp.estimate_lag_seconds(reference, delayed, 22050) == pytest.approx(110 / 22050)
    assert exp.estimate_lag_seconds(reference, reference, 22050) == 0.0


def test_splits_are_made_per_source_recording():
    sources = [f"rec{i:02d}" for i in range(10)]
    clips = [(source, cut) for source in sources for cut in range(3)]  # 1録音から3つの切り出し
    splits = exp.assign_splits_by_source([source for source, _ in clips], tuning_fraction=0.3, seed=0)
    assert sorted(splits.values()).count("tuning") == 3
    recordings = [{"id": f"{s}_{c}", "source_id": s, "split": splits[s]} for s, c in clips]
    assert exp.check_source_split(recordings) == []
    recordings[0]["split"] = "tuning" if recordings[0]["split"] == "evaluation" else "evaluation"
    assert "両方" in exp.check_source_split(recordings)[0]


def make_small_study(tmp_path, recording_split=("tuning", "evaluation")):
    """2録音・1伴奏の小さな実験設定を作ります（合成音、各4秒）。"""
    rate = 22050
    progressions = [[("C:maj", 2.0), ("G:maj", 2.0)], [("A:min", 2.0), ("F:maj", 2.0)]]
    lines = [
        "[experiment]", 'name = "small"', 'output_dir = "out"', "accompaniment_db = [0.0, 10.0]",
        "mix_sample_rate = 22050", 'conditions = ["solo", "mixture"]', "",
        "[analysis]", "smoothing_segments = 1", "",
    ]
    for index, progression in enumerate(progressions):
        samples = np.concatenate([sine_chord(label, length) for label, length in progression])
        sf.write(tmp_path / f"g{index}.wav", samples, rate)
        intervals, start = [], 0.0
        for label, length in progression:
            intervals.append(ChordInterval(start, start + length, label))
            start += length
        write_annotation_csv(tmp_path / f"g{index}.csv", intervals)
        lines += [
            "[[recordings]]", f'id = "g{index}"', f'split = "{recording_split[index]}"', 'material = "synthetic"',
            f'guitar = "g{index}.wav"', f'annotation = "g{index}.csv"', "",
        ]
    noise = np.random.default_rng(0).uniform(-0.5, 0.5, 5 * rate)
    sf.write(tmp_path / "noise.wav", noise, rate)
    lines += ["[[accompaniments]]", 'id = "noise"', 'path = "noise.wav"', 'material = "synthetic"', ""]
    config = tmp_path / "small.toml"
    config.write_text("\n".join(lines), encoding="utf-8")
    return config


def read_rows(path):
    with open(path, newline="", encoding="utf-8") as file:
        return list(csv.DictReader(file))


def test_experiment_without_separation_runs_and_counts_materials(tmp_path):
    config = make_small_study(tmp_path)
    result = exp.run_experiment(exp.load_experiment(config))
    out = tmp_path / "out"
    rows = read_rows(out / "items.csv")
    assert len(rows) == 2 + 2 * 2  # solo 2件 + mixture（2録音 × 2音量）
    solo = [row for row in rows if row["condition"] == "solo"]
    assert all(float(row["accuracy"]) == 1.0 for row in solo)
    for row in rows:
        if row["condition"] == "mixture":  # 指定した音量比で混ぜられていること
            assert float(row["measured_db"]) == pytest.approx(float(row["accompaniment_db"]), abs=1e-3)
    assert all(float(row["lag_vs_solo_ms"]) == 0.0 for row in rows if row["condition"] == "mixture")
    assert result["counts"]["source_recordings"] == 2
    assert result["counts"]["artificial_mixture_conditions"] == 4
    info = json.loads((out / "experiment.json").read_text(encoding="utf-8"))
    assert info["counts"]["clips"] == 2
    assert (out / "summary.png").exists()
    assert (out / "items" / "g0" / "noise_+10.0dB" / "mixture.wav").exists()


def test_split_filter_only_runs_that_split(tmp_path):
    config = make_small_study(tmp_path)
    result = exp.run_experiment(exp.load_experiment(config), split="evaluation")
    assert {row["recording_id"] for row in result["rows"]} == {"g1"}


def test_experiment_with_fake_separation_pairs_before_and_after(tmp_path, monkeypatch):
    config = make_small_study(tmp_path)

    def fake_separate(clip, *args):
        guitar = make_clip(np.repeat(clip.samples, 2, axis=0) * 0.5, clip.sample_rate, clip.source_path, clip.offset_s)
        return sep.SeparationResult(guitar, guitar, "fake", "cpu", False, 0.0, {})

    monkeypatch.setattr(sep, "separate_guitar", fake_separate)
    experiment = exp.load_experiment(config)
    result = exp.run_experiment(experiment, conditions=["solo", "mixture", "separated"])
    pairs = read_rows(tmp_path / "out" / "paired_differences.csv")
    assert len(pairs) == 4
    for pair in pairs:
        difference = float(pair["separated_accuracy"]) - float(pair["mixture_accuracy"])
        assert float(pair["difference"]) == pytest.approx(difference, abs=1e-4)
    assert result["difference_summary"]


def test_invalid_experiment_settings_are_reported(tmp_path):
    config = make_small_study(tmp_path)  # g0 は調整用、g1 は評価用
    text = config.read_text(encoding="utf-8")
    text = text.replace('id = "g1"', 'id = "g1"\nsource_id = "g0"')  # g0 と同じ元素材なのに評価用にする
    text = text.replace('annotation = "g0.csv"', 'annotation = "missing.csv"')
    config.write_text(text, encoding="utf-8")
    with pytest.raises(ValueError) as caught:
        exp.load_experiment(config)
    message = str(caught.value)
    assert "見つかりません" in message
    assert "両方" in message


def test_short_accompaniment_is_rejected(tmp_path):
    config = make_small_study(tmp_path)
    sf.write(tmp_path / "noise.wav", silence(1.0) + 0.1, 22050)
    with pytest.raises(ValueError, match="伴奏 noise が短すぎます"):
        exp.run_experiment(exp.load_experiment(config))


def test_recorded_mixture_is_compared_without_artificial_mixing(tmp_path, monkeypatch):
    """実際の合奏録音（mixture）だけがある場合は、混合を行わず mixture と separated を比べます。"""
    rate = 22050
    sf.write(tmp_path / "band.wav", np.concatenate([sine_chord("D:maj", 2.0), sine_chord("B:min", 2.0)]), rate)
    write_annotation_csv(tmp_path / "band.csv", [ChordInterval(0.0, 2.0, "D:maj"), ChordInterval(2.0, 4.0, "B:min")])
    config = tmp_path / "band.toml"
    config.write_text(
        "\n".join([
            "[experiment]", 'output_dir = "out"', "mix_sample_rate = 22050", "",
            "[[recordings]]", 'id = "band"', 'split = "evaluation"', 'mixture = "band.wav"', 'annotation = "band.csv"', "",
        ]),
        encoding="utf-8",
    )

    def fake_separate(clip, *args):
        return sep.SeparationResult(clip, clip, "fake", "cpu", False, 0.0, {})

    monkeypatch.setattr(sep, "separate_guitar", fake_separate)
    result = exp.run_experiment(exp.load_experiment(config))
    assert [(row["condition"], row["mixture_type"]) for row in result["rows"]] == [
        ("mixture", "recorded"), ("separated", "recorded"),
    ]
    assert result["counts"]["recorded_mixtures"] == 1
    assert result["counts"]["artificial_mixture_conditions"] == 0
    assert result["pairs"][0]["difference"] == 0.0
