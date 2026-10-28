"""比較実験（混合、時間ずれ、元素材単位の分割、結果の集計）の確認"""

import csv
import json

import numpy as np
import pytest
import soundfile as sf
from conftest import silence, sine_chord

from guitar_chord_lab import experiment as exp
from guitar_chord_lab import make_clip
from guitar_chord_lab.audio import load_audio
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
    text = text.replace('id = "g0"', 'id = "g0"\nsource_id = "piece"')
    text = text.replace('id = "g1"', 'id = "g1"\nsource_id = "piece"')  # g0 と同じ元素材なのに評価用にする
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

    from guitar_chord_lab.plots import plot_experiment_summary

    figure = plot_experiment_summary(result, "band", exp.load_experiment(config).settings)
    assert [label.get_text() for label in figure.axes[0].get_xticklabels()] == ["solo", "mixture", "separated"]
    assert "1 recorded mixtures" in figure._suptitle.get_text() and "CQT chroma" in figure._suptitle.get_text()


def test_unknown_keys_in_the_experiment_file_are_reported(tmp_path):
    config = make_small_study(tmp_path)
    text = config.read_text(encoding="utf-8")
    text = text.replace("accompaniment_db = [0.0, 10.0]", "accompaniment_dB = [0.0, 10.0]")
    text = text.replace('material = "synthetic"\nguitar = "g0.wav"', 'materal = "synthetic"\nguitar = "g0.wav"')
    config.write_text(text + '\n[separaton]\nmodel = "htdemucs_6s"\n', encoding="utf-8")
    with pytest.raises(ValueError) as caught:
        exp.load_experiment(config)
    message = str(caught.value)
    assert "accompaniment_dB" in message and "materal" in message and "separaton" in message


def test_duplicate_accompaniment_ids_and_levels_are_rejected(tmp_path):
    config = make_small_study(tmp_path)
    text = config.read_text(encoding="utf-8")
    text = text.replace("accompaniment_db = [0.0, 10.0]", "accompaniment_db = [6.0, 6.04]")
    text += '\n[[accompaniments]]\nid = "noise"\npath = "noise.wav"\n'
    config.write_text(text, encoding="utf-8")
    with pytest.raises(ValueError) as caught:
        exp.load_experiment(config)
    assert "伴奏ID noise が重複" in str(caught.value) and "0.1 dB" in str(caught.value)


def test_cuts_of_one_file_count_as_one_source_and_cannot_be_split(tmp_path):
    config = make_small_study(tmp_path)
    text = config.read_text(encoding="utf-8").replace('guitar = "g1.wav"', 'guitar = "g0.wav"')
    text = text.replace('annotation = "g1.csv"', 'annotation = "g0.csv"')
    config.write_text(text, encoding="utf-8")
    with pytest.raises(ValueError, match="同じ音声ファイル g0.wav"):
        exp.load_experiment(config)  # g0.wav の切り出しが調整用と評価用の両方にある
    config.write_text(text.replace('split = "evaluation"', 'split = "tuning"'), encoding="utf-8")
    experiment = exp.load_experiment(config)
    assert exp.count_materials(experiment, experiment.recordings)["source_recordings"] == 1


def test_summary_averages_each_source_first():
    rows = [
        {"recording_id": "a1", "source_id": "A", "material": "real", "mixture_type": "none", "condition": "solo",
         "accompaniment_id": "", "accompaniment_db": "", "accuracy": 1.0, "decided_ratio": 1.0},
        {"recording_id": "a2", "source_id": "A", "material": "real", "mixture_type": "none", "condition": "solo",
         "accompaniment_id": "", "accompaniment_db": "", "accuracy": 0.8, "decided_ratio": 1.0},
        {"recording_id": "b1", "source_id": "B", "material": "real", "mixture_type": "none", "condition": "solo",
         "accompaniment_id": "", "accompaniment_db": "", "accuracy": 0.2, "decided_ratio": 1.0},
    ]
    line = exp.summarise(rows, ["material", "mixture_type", "condition", "accompaniment_id", "accompaniment_db"], "accuracy")[0]
    assert (line["n_sources"], line["n_clips"], line["accuracy_n"]) == (2, 3, 2)
    assert line["accuracy_mean"] == pytest.approx((0.9 + 0.2) / 2)


def install_identity_separation(monkeypatch, scale=1.0):
    """Demucs の代わりに、入力に scale を掛けて guitar として返す（44.1 kHz・ステレオで処理する）仕組みです。"""
    from types import SimpleNamespace

    separator = SimpleNamespace(model=SimpleNamespace(sources=["guitar"]), samplerate=44100, audio_channels=2)
    monkeypatch.setattr(sep, "choose_device", lambda device: "cpu")
    monkeypatch.setattr(sep, "load_separator", lambda *args: separator)
    monkeypatch.setattr(sep, "run_separator", lambda separator, samples, device, seed: {"guitar": samples * scale})


def test_other_mix_sample_rates_keep_the_separated_length(tmp_path, monkeypatch):
    """48 kHz で混ぜると、44.1 kHz との往復で長さが1サンプルずれることがありますが、そろえて比べます。"""
    install_identity_separation(monkeypatch)
    rate = 48000
    samples = np.concatenate([sine_chord("C:maj", 2.0005, rate), sine_chord("G:maj", 2.0, rate)])
    sf.write(tmp_path / "g.wav", samples, rate)
    write_annotation_csv(tmp_path / "g.csv", [ChordInterval(0.0, 2.0, "C:maj"), ChordInterval(2.0, 4.0, "G:maj")])
    sf.write(tmp_path / "noise.wav", np.random.default_rng(0).uniform(-0.5, 0.5, 5 * rate), rate)
    config = tmp_path / "rate.toml"
    config.write_text(
        "\n".join([
            "[experiment]", 'output_dir = "out"', "mix_sample_rate = 48000", "accompaniment_db = [0.0]", "",
            "[[recordings]]", 'id = "g"', 'split = "evaluation"', 'guitar = "g.wav"', 'annotation = "g.csv"', "",
            "[[accompaniments]]", 'id = "noise"', 'path = "noise.wav"', "",
        ]),
        encoding="utf-8",
    )
    result = exp.run_experiment(exp.load_experiment(config))
    separated = [row for row in result["rows"] if row["condition"] == "separated"]
    assert len(separated) == 1 and separated[0]["lag_vs_solo_ms"] == 0.0
    info = json.loads((tmp_path / "out" / "experiment.json").read_text(encoding="utf-8"))
    assert info["effective_settings"]["separation"]["model"] == "htdemucs_6s"  # 省略した設定も記録する
    item_info = json.loads((tmp_path / "out" / "items" / "g" / "noise_+0.0dB" / "separated" / "analysis.json").read_text(encoding="utf-8"))
    assert "separation" in item_info and separated[0]["separation_model"] == "htdemucs_6s"


def test_summary_files_are_rewritten_by_every_run(tmp_path, monkeypatch):
    install_identity_separation(monkeypatch)
    config = make_small_study(tmp_path)
    exp.run_experiment(exp.load_experiment(config), conditions=["solo", "mixture", "separated"])
    assert len(read_rows(tmp_path / "out" / "paired_differences.csv")) == 4
    exp.run_experiment(exp.load_experiment(config), conditions=["solo", "mixture"])
    assert read_rows(tmp_path / "out" / "paired_differences.csv") == []  # 前の実行の結果を残さない


def test_summary_figure_keeps_each_accompaniment(tmp_path):
    from guitar_chord_lab.plots import plot_experiment_summary

    config = make_small_study(tmp_path)
    sf.write(tmp_path / "noise2.wav", np.random.default_rng(1).uniform(-0.5, 0.5, 5 * 22050), 22050)
    text = config.read_text(encoding="utf-8") + '\n[[accompaniments]]\nid = "noise2"\npath = "noise2.wav"\n'
    config.write_text(text, encoding="utf-8")
    result = exp.run_experiment(exp.load_experiment(config))
    labels = plot_experiment_summary(result, "two accompaniments").axes[0].get_legend_handles_labels()[1]
    assert "mixture (noise, synthetic)" in labels and "mixture (noise2, synthetic)" in labels


def test_summary_figure_shows_processing_times(tmp_path, monkeypatch):
    """図にも処理時間（コード認識は条件ごと、分離は使ったデバイスと一緒に）を示します。"""
    from guitar_chord_lab.plots import plot_experiment_summary

    install_identity_separation(monkeypatch)
    config = make_small_study(tmp_path)
    result = exp.run_experiment(exp.load_experiment(config), conditions=["solo", "mixture", "separated"])
    figure = plot_experiment_summary(result, "times")
    labels = [label.get_text() for label in figure.axes[2].get_xticklabels()]
    assert labels == ["recognition\n(solo)", "recognition\n(mixture)", "recognition\n(separated)", "separation\n(cpu)"]


def configure_small_study(config, duration_s=None, save_audio=True):
    """同じ録音ID・同じ保存先のまま、切り出す長さと音の保存の有無だけを変えます（実行し直しの確認用）。"""
    text = config.read_text(encoding="utf-8")
    if duration_s is not None:
        for index in range(2):
            text = text.replace(f'annotation = "g{index}.csv"', f'annotation = "g{index}.csv"\nduration_s = {duration_s}')
    if not save_audio:
        text = text.replace('name = "small"', 'name = "small"\nsave_audio = false')
    config.write_text(text, encoding="utf-8")
    return config


def test_listening_uses_this_runs_audio_for_every_condition(tmp_path, monkeypatch):
    install_identity_separation(monkeypatch)
    experiment = exp.load_experiment(make_small_study(tmp_path))
    result = exp.run_experiment(experiment, conditions=["solo", "mixture", "separated"])
    listening = exp.load_listening_clips(experiment, result, "g0", "noise", 10.0)
    assert list(listening.clips) == ["solo", "mixture", "separated"] and listening.notes == []
    assert all(clip.duration_s == pytest.approx(4.0, abs=0.01) for clip in listening.clips.values())
    assert [interval.chord for interval in listening.reference] == ["C:maj", "G:maj"]
    rows = read_rows(tmp_path / "out" / "items.csv")
    assert all(row["audio_sha256"] for row in rows if row["condition"] in ("mixture", "separated"))


def test_listening_ignores_separated_audio_left_by_an_earlier_run(tmp_path, monkeypatch):
    """4秒・分離ありで実行した後、同じ録音ID・保存先で2秒・分離なしで実行し直しても、今回の音だけを使います。"""
    install_identity_separation(monkeypatch)
    config = make_small_study(tmp_path)
    exp.run_experiment(exp.load_experiment(config), conditions=["solo", "mixture", "separated"])
    old_file = tmp_path / "out" / "items" / "g0" / "noise_+10.0dB" / "separated" / "separated_guitar.wav"
    assert sf.info(str(old_file)).duration == pytest.approx(4.0)
    experiment = exp.load_experiment(configure_small_study(config, duration_s=2.0))
    result = exp.run_experiment(experiment, conditions=["solo", "mixture"])
    listening = exp.load_listening_clips(experiment, result, "g0", "noise", 10.0)
    assert old_file.exists()  # 前の実行の分離音は残っているが、使わない
    assert list(listening.clips) == ["solo", "mixture"]
    assert all(clip.duration_s == pytest.approx(2.0) for clip in listening.clips.values())
    assert listening.notes == ["separated: 今回の実行の条件に含まれていません（実行した条件: solo, mixture）"]
    assert listening.reference[-1].end_s == pytest.approx(2.0)


def test_listening_does_not_load_old_files_when_audio_is_not_saved(tmp_path, monkeypatch):
    install_identity_separation(monkeypatch)
    config = make_small_study(tmp_path)
    exp.run_experiment(exp.load_experiment(config), conditions=["solo", "mixture", "separated"])
    experiment = exp.load_experiment(configure_small_study(config, save_audio=False))
    result = exp.run_experiment(experiment, conditions=["solo", "mixture", "separated"])
    listening = exp.load_listening_clips(experiment, result, "g0", "noise", 10.0)
    assert list(listening.clips) == ["solo"]  # 前の実行の mixture.wav と分離音は、長さが同じでも使わない
    assert [note.split(":")[0] for note in listening.notes] == ["mixture", "separated"]
    assert all("save_audio" in note for note in listening.notes)


def test_listening_rejects_audio_overwritten_after_the_run(tmp_path, monkeypatch):
    install_identity_separation(monkeypatch)
    experiment = exp.load_experiment(make_small_study(tmp_path))
    result = exp.run_experiment(experiment, conditions=["solo", "mixture", "separated"])
    mixture_file = tmp_path / "out" / "items" / "g0" / "noise_+10.0dB" / "mixture.wav"
    sf.write(mixture_file, np.zeros(4 * 22050), 22050)  # 別の実行で上書きされた状態をまねる
    listening = exp.load_listening_clips(experiment, result, "g0", "noise", 10.0)
    assert list(listening.clips) == ["solo", "separated"]
    assert len(listening.notes) == 1 and "書き換えられています" in listening.notes[0]


def test_listening_checks_lengths_and_the_selected_level(tmp_path, monkeypatch):
    install_identity_separation(monkeypatch)
    experiment = exp.load_experiment(make_small_study(tmp_path))
    result = exp.run_experiment(experiment, conditions=["solo", "mixture"])
    other_level = exp.load_listening_clips(experiment, result, "g0", "noise", 6.0)
    assert list(other_level.clips) == ["solo"]
    assert "音量 6.0 dB の結果は、今回の実行にありません" in other_level.notes[0]
    experiment.recordings[0]["duration_s"] = 2.0  # 実行の後で切り出しの設定を変えると、結果と範囲が合わない
    changed = exp.load_listening_clips(experiment, result, "g0", "noise", 10.0)
    assert changed.clips == {}
    assert all("合いません" in note for note in changed.notes[:2])
    with pytest.raises(ValueError, match="録音 g9 がありません"):
        exp.load_listening_clips(experiment, result, "g9", "noise", 10.0)
    experiment.recordings = experiment.recordings[1:]  # 実行の後で、g0 のない設定を読み込み直した
    with pytest.raises(ValueError, match="実験の設定に録音 g0 がありません"):
        exp.load_listening_clips(experiment, result, "g0", "noise", 10.0)


def make_recorded_study(tmp_path, save_audio=True):
    """単独ギターのトラックと合奏録音（mixture）がある、人工の混合をしない実験設定を作ります（伴奏の設定なし）。"""
    rate = 22050
    guitar = np.concatenate([sine_chord("D:maj", 2.0), sine_chord("B:min", 2.0)])
    band = guitar + 0.3 * np.random.default_rng(1).uniform(-0.5, 0.5, guitar.size)
    sf.write(tmp_path / "guitar.wav", guitar, rate)
    sf.write(tmp_path / "band.wav", band, rate)
    write_annotation_csv(tmp_path / "band.csv", [ChordInterval(0.0, 2.0, "D:maj"), ChordInterval(2.0, 4.0, "B:min")])
    lines = ["[experiment]", 'output_dir = "out"', "mix_sample_rate = 22050", f"save_audio = {str(save_audio).lower()}", "",
             "[separation]", 'cache_dir = "cache"', "",  # 模擬の分離の結果を、ほかのテストと共有しない
             "[[recordings]]", 'id = "band"', 'split = "evaluation"', 'guitar = "guitar.wav"', 'mixture = "band.wav"',
             'annotation = "band.csv"', ""]
    config = tmp_path / "band.toml"
    config.write_text("\n".join(lines), encoding="utf-8")
    return config


def test_listening_uses_the_separated_audio_of_a_recorded_mixture(tmp_path, monkeypatch):
    """合奏録音から分離した場合も、separated として合奏録音そのものではなく、今回保存した分離音を使います。"""
    install_identity_separation(monkeypatch, scale=0.25)  # 分離音を混合音と区別できるように、0.25倍にする
    experiment = exp.load_experiment(make_recorded_study(tmp_path))
    result = exp.run_experiment(experiment, conditions=["solo", "mixture", "separated"])
    listening = exp.load_listening_clips(experiment, result, "band", None, None)
    assert list(listening.clips) == ["solo", "mixture", "separated"] and listening.notes == []
    assert listening.description == "recorded mixture"
    saved = load_audio(tmp_path / "out" / "items" / "band" / "recorded" / "separated" / "separated_guitar.wav")
    assert np.array_equal(listening.clips["separated"].samples, saved.samples)
    mixture_rms = np.sqrt(np.mean(np.square(listening.clips["mixture"].samples)))
    separated_rms = np.sqrt(np.mean(np.square(saved.samples)))
    assert separated_rms == pytest.approx(0.25 * mixture_rms, rel=0.05)  # 合奏録音そのもの（1倍）ではない


def test_listening_reports_unsaved_separated_audio_of_a_recorded_mixture(tmp_path, monkeypatch):
    install_identity_separation(monkeypatch, scale=0.25)
    experiment = exp.load_experiment(make_recorded_study(tmp_path, save_audio=False))
    result = exp.run_experiment(experiment, conditions=["solo", "mixture", "separated"])
    listening = exp.load_listening_clips(experiment, result, "band", None, None)
    assert list(listening.clips) == ["solo", "mixture"]  # 合奏録音は元の音源から読み直せる
    assert len(listening.notes) == 1 and listening.notes[0].startswith("separated:") and "save_audio" in listening.notes[0]


def test_listening_picks_the_selected_accompaniment(tmp_path, monkeypatch):
    install_identity_separation(monkeypatch)
    config = make_small_study(tmp_path)
    sf.write(tmp_path / "noise2.wav", 0.2 * np.random.default_rng(1).uniform(-0.5, 0.5, 5 * 22050), 22050)
    config.write_text(config.read_text(encoding="utf-8") + '\n[[accompaniments]]\nid = "noise2"\npath = "noise2.wav"\n',
                      encoding="utf-8")
    experiment = exp.load_experiment(config)
    result = exp.run_experiment(experiment, conditions=["solo", "mixture", "separated"])
    listening = exp.load_listening_clips(experiment, result, "g0", "noise2", 10.0)
    assert list(listening.clips) == ["solo", "mixture", "separated"]
    assert listening.description == "accompaniment noise2 +10.0 dB"
    folder = tmp_path / "out" / "items" / "g0"
    assert np.array_equal(listening.clips["mixture"].samples, load_audio(folder / "noise2_+10.0dB" / "mixture.wav").samples)
    assert not np.array_equal(listening.clips["mixture"].samples, load_audio(folder / "noise_+10.0dB" / "mixture.wav").samples)
    unknown = exp.load_listening_clips(experiment, result, "g0", "drums", 10.0)
    assert list(unknown.clips) == ["solo"]
    assert all("伴奏 drums・音量 10.0 dB の結果は、今回の実行にありません" in note for note in unknown.notes)


def test_listening_checks_the_start_of_the_clip(tmp_path, monkeypatch):
    install_identity_separation(monkeypatch)
    config = make_small_study(tmp_path)
    text = config.read_text(encoding="utf-8").replace('annotation = "g0.csv"', 'annotation = "g0.csv"\nstart_s = 1.0\nduration_s = 2.0')
    config.write_text(text, encoding="utf-8")
    experiment = exp.load_experiment(config)
    result = exp.run_experiment(experiment, conditions=["solo", "mixture", "separated"])
    listening = exp.load_listening_clips(experiment, result, "g0", "noise", 10.0)
    assert list(listening.clips) == ["solo", "mixture", "separated"]
    assert all(clip.offset_s == pytest.approx(1.0) for clip in listening.clips.values())
    assert [(i.start_s, i.end_s, i.chord) for i in listening.reference] == [(0.0, 1.0, "C:maj"), (1.0, 2.0, "G:maj")]
    experiment.recordings[0]["start_s"] = 0.0  # 長さは同じまま、開始位置だけを実行の後で変えた
    shifted = exp.load_listening_clips(experiment, result, "g0", "noise", 10.0)
    assert shifted.clips == {} and all("合いません" in note for note in shifted.notes)


def test_listening_finds_an_earlier_results_files_after_saving_elsewhere(tmp_path, monkeypatch):
    """別の保存先で実行し直した後でも、前の結果（result）は、その実行の保存先のファイルを使います。"""
    install_identity_separation(monkeypatch)
    experiment = exp.load_experiment(make_small_study(tmp_path))
    first = exp.run_experiment(experiment, conditions=["solo", "mixture", "separated"])
    exp.run_experiment(experiment, conditions=["solo", "mixture"], output_dir=tmp_path / "out_level18")
    listening = exp.load_listening_clips(experiment, first, "g0", "noise", 10.0)
    assert list(listening.clips) == ["solo", "mixture", "separated"] and listening.notes == []
