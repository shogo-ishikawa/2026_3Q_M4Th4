"""音源分離まわりの確認

Demucs を使わない確認（エラーの説明、キャッシュ、入力の整形）は常に実行します。
Demucs のモデル取得と実分離は時間がかかるため、RUN_DEMUCS_TESTS=1 のときだけ実行します。
"""

import os
import sys
from types import SimpleNamespace

import numpy as np
import pytest
from conftest import silence, sine_chord

from guitar_chord_lab import make_clip
from guitar_chord_lab import separation as sep


def test_missing_demucs_gives_install_instructions(monkeypatch):
    monkeypatch.setitem(sys.modules, "demucs", None)  # Demucs が入っていない状態をまねる
    monkeypatch.setitem(sys.modules, "demucs.api", None)
    with pytest.raises(sep.SeparationError, match=r'pip install -e "\.\[separation\]"'):
        sep.import_demucs()


@pytest.mark.parametrize(
    "error, expected",
    [
        (RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB"), True),
        (RuntimeError("DefaultCPUAllocator: can't allocate memory: you tried to allocate 1270080000 bytes"), True),
        (MemoryError(), True),
        (RuntimeError("Expected all tensors to be on the same device"), False),
        (OSError("Connection refused"), False),
    ],
)
def test_out_of_memory_is_recognised(error, expected):
    assert sep.is_out_of_memory(error) is expected


def test_error_messages_explain_what_to_do():
    model_text = sep.model_error_message("htdemucs_6s", OSError("Connection refused"))
    assert "Connection refused" in model_text and "インターネット" in model_text and "HF_HOME" in model_text
    memory_text = sep.memory_error_message("cuda", RuntimeError("CUDA out of memory"))
    assert "duration" in memory_text and "segment" in memory_text and 'device="cpu"' in memory_text


class FakeSeparator:
    """Demucs の代わりに、入力の半分を guitar として返す分離器です。"""

    def __init__(self, sources):
        self.model = SimpleNamespace(sources=sources)
        self.samplerate = 44100
        self.audio_channels = 2


def fake_api(sources):
    return SimpleNamespace(Separator=lambda **kwargs: FakeSeparator(sources))


def test_model_without_guitar_output_is_rejected(monkeypatch):
    monkeypatch.setattr(sep, "import_demucs", lambda: (None, fake_api(["drums", "bass", "other", "vocals"])))
    monkeypatch.setattr(sep, "_SEPARATORS", {})
    with pytest.raises(sep.SeparationError, match="guitar を出力しません"):
        sep.load_separator("htdemucs", "cpu", 0, 0.25, None)


def test_model_loading_failure_is_explained(monkeypatch):
    def broken_separator(**kwargs):
        raise OSError("Connection refused")

    monkeypatch.setattr(sep, "import_demucs", lambda: (None, SimpleNamespace(Separator=broken_separator)))
    monkeypatch.setattr(sep, "_SEPARATORS", {})
    with pytest.raises(sep.SeparationError, match="取得・読み込みできませんでした"):
        sep.load_separator("htdemucs_6s", "cpu", 0, 0.25, None)


def test_model_input_is_resampled_and_made_stereo():
    clip = make_clip(np.ones(22050), 22050)
    samples = sep.to_model_input(clip, 44100, 2)
    assert samples.shape == (2, 44100)
    assert samples.dtype == np.float32


def install_fake_separation(monkeypatch, calls):
    """separate_guitar の中の Demucs 呼び出しを、偽の分離器に置き換えます。"""
    monkeypatch.setattr(sep, "choose_device", lambda device: "cpu")
    monkeypatch.setattr(sep, "load_separator", lambda *args: FakeSeparator(["guitar", "other"]))

    def fake_run(separator, samples, device, seed):
        calls.append(samples.shape)
        return {"guitar": samples * 0.5, "other": samples * 0.5}

    monkeypatch.setattr(sep, "run_separator", fake_run)


def test_results_are_cached_by_input_and_settings(monkeypatch, tmp_path):
    calls = []
    install_fake_separation(monkeypatch, calls)
    clip = make_clip(np.concatenate([silence(0.5), sine_chord("C:maj", 2.0)]), 22050, "song.wav", 12.0)
    first = sep.separate_guitar(clip, cache_dir=tmp_path)
    second = sep.separate_guitar(clip, cache_dir=tmp_path)
    assert (first.from_cache, second.from_cache) == (False, True)
    assert len(calls) == 1
    assert np.allclose(first.guitar.samples, second.guitar.samples)
    assert second.guitar.offset_s == 12.0 and second.guitar.source_path == "song.wav"
    sep.separate_guitar(clip, shifts=1, cache_dir=tmp_path)  # 設定が違えば再計算する
    other_clip = make_clip(np.concatenate([silence(0.5), sine_chord("A:min", 2.0)]), 22050)
    sep.separate_guitar(other_clip, cache_dir=tmp_path)  # 入力が違えば再計算する
    assert len(calls) == 3


def test_separated_audio_keeps_the_time_axis(monkeypatch):
    install_fake_separation(monkeypatch, [])
    clip = make_clip(sine_chord("G:maj", 2.5), 22050, offset_s=3.0)
    result = sep.separate_guitar(clip)
    assert result.guitar.sample_rate == 44100
    assert result.guitar.samples.shape == (2, 110250)  # 2.5秒 × 44100 Hz、ステレオ
    assert result.guitar.offset_s == 3.0
    assert np.allclose(result.guitar.samples + result.rest.samples, sep.to_model_input(clip, 44100, 2), atol=1e-6)


@pytest.mark.demucs
@pytest.mark.skipif(os.environ.get("RUN_DEMUCS_TESTS") != "1", reason="RUN_DEMUCS_TESTS=1 のときだけ実行します")
def test_real_demucs_separation(tmp_path):
    pytest.importorskip("demucs")
    clip = make_clip(np.concatenate([silence(1.0), sine_chord("E:min", 4.0)]), 22050)
    result = sep.separate_guitar(clip, device="cpu", cache_dir=tmp_path)
    assert result.model_name == "htdemucs_6s"
    assert result.guitar.sample_rate == 44100
    assert result.guitar.duration_s == pytest.approx(clip.duration_s)
    again = sep.separate_guitar(clip, device="cpu", cache_dir=tmp_path)
    assert again.from_cache
