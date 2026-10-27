"""音声の読み込み・切り出し・変換の確認"""

import numpy as np
import pytest
import soundfile as sf

from guitar_chord_lab.audio import load_audio, make_clip, prepare_for_analysis, rms_db, save_audio


def write_ramp(path, sample_rate=8000, seconds=3.0, channels=2):
    """サンプル番号が分かる値（0, 1, 2, ...）を書いたWAVを作ります。"""
    frames = int(sample_rate * seconds)
    ramp = np.arange(frames, dtype=np.float64) / frames
    data = np.stack([ramp] * channels, axis=1)
    sf.write(path, data, sample_rate, subtype="FLOAT")
    return ramp


def test_load_with_start_and_duration(tmp_path):
    path = tmp_path / "ramp.wav"
    ramp = write_ramp(path)
    clip = load_audio(path, start_s=1.0, duration_s=0.5)
    assert clip.sample_rate == 8000
    assert clip.channels == 2
    assert clip.samples.shape[1] == 4000
    assert clip.offset_s == pytest.approx(1.0)
    assert clip.samples[0, 0] == pytest.approx(ramp[8000], abs=1e-6)


def test_load_errors(tmp_path):
    path = tmp_path / "ramp.wav"
    write_ramp(path)
    with pytest.raises(FileNotFoundError):
        load_audio(tmp_path / "missing.wav")
    with pytest.raises(ValueError, match="超えています"):
        load_audio(path, start_s=10.0)
    with pytest.raises(ValueError, match="0秒以上"):
        load_audio(path, start_s=-1.0)
    other = tmp_path / "song.m4a"
    other.write_bytes(b"not audio")
    with pytest.raises(ValueError, match="ffmpeg"):
        load_audio(other)


def test_duration_beyond_the_end_is_shortened_with_a_warning(tmp_path):
    path = tmp_path / "ramp.wav"
    write_ramp(path)
    with pytest.warns(UserWarning, match="最後まで"):
        clip = load_audio(path, start_s=2.0, duration_s=5.0)
    assert clip.duration_s == pytest.approx(1.0)


def test_mp3_can_be_read(tmp_path):
    path = tmp_path / "tone.mp3"
    t = np.arange(44100 * 2) / 44100
    try:
        sf.write(path, 0.3 * np.sin(2 * np.pi * 440 * t), 44100, format="MP3")
    except (sf.LibsndfileError, TypeError, ValueError):
        pytest.skip("この環境の libsndfile はMP3を書き出せません")
    clip = load_audio(path)
    assert clip.sample_rate == 44100
    assert clip.duration_s == pytest.approx(2.0, abs=0.1)


def test_prepare_for_analysis_makes_mono_at_target_rate():
    stereo = np.stack([np.ones(44100), -np.ones(44100) * 0.5])
    clip = make_clip(stereo, 44100, offset_s=3.0)
    mono = prepare_for_analysis(clip, 22050)
    assert mono.channels == 1
    assert mono.sample_rate == 22050
    assert mono.samples.shape[1] == 22050
    assert mono.offset_s == 3.0


def test_save_and_reload_keeps_values_above_one(tmp_path):
    clip = make_clip(np.array([0.0, 1.5, -2.0, 0.25]), 8000)
    path = save_audio(tmp_path / "loud.wav", clip)
    again = load_audio(path)
    assert np.allclose(again.samples[0], [0.0, 1.5, -2.0, 0.25])


def test_rms_db():
    assert rms_db(np.ones(100)) == pytest.approx(0.0)
    assert rms_db(np.zeros(100)) == pytest.approx(-120.0)
    assert rms_db(0.1 * np.ones(100)) == pytest.approx(-20.0)


@pytest.mark.parametrize("name", ["phone_recording.mp3", "broken.wav"])
def test_unreadable_audio_gives_a_clear_error(tmp_path, name):
    path = tmp_path / name
    path.write_bytes(b"this is not audio data " * 200)
    with pytest.raises(ValueError, match="読み込めませんでした") as caught:
        load_audio(path)
    assert "ffmpeg" in str(caught.value)
