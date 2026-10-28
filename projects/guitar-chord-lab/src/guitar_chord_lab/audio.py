"""音声の読み込み・切り出し・モノラル変換・リサンプリング・保存を扱います。

音声データは numpy 配列で扱い、形を (チャンネル数, サンプル数) にそろえます。
"""

import hashlib
import warnings
from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

# soundfile（libsndfile 1.1以降）が読める形式。M4A/AAC等は ffmpeg でWAVへ変換してください。
SUPPORTED_SUFFIXES = [".wav", ".flac", ".ogg", ".mp3"]

# RMSを dB にするときの下限（完全な無音でも -120 dB として扱う）
SILENCE_FLOOR_DB = -120.0


@dataclass
class AudioClip:
    """切り出した音声と、その出どころの情報をまとめたものです。"""

    samples: np.ndarray  # 形は (チャンネル数, サンプル数)
    sample_rate: int  # サンプリング周波数 [Hz]
    source_path: str = ""  # 元のファイル（プログラムで作った音なら空文字）
    offset_s: float = 0.0  # 元のファイルの何秒目から切り出したか

    @property
    def duration_s(self):
        """長さ [秒]"""
        return self.samples.shape[1] / self.sample_rate

    @property
    def channels(self):
        """チャンネル数（モノラルなら1、ステレオなら2）"""
        return self.samples.shape[0]


def make_clip(samples, sample_rate, source_path="", offset_s=0.0):
    """1次元または2次元の配列から AudioClip を作ります。"""
    samples = np.asarray(samples, dtype=np.float32)
    if samples.ndim == 1:
        samples = samples[np.newaxis, :]
    return AudioClip(samples, int(sample_rate), str(source_path), float(offset_s))


def check_audio_path(path):
    """ファイルの存在と拡張子を確認し、Path を返します。"""
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"音声ファイルが見つかりません: {path}")
    if path.suffix.lower() not in SUPPORTED_SUFFIXES:
        raise ValueError(
            f"{path.suffix} 形式は読み込めません。対応形式: {', '.join(SUPPORTED_SUFFIXES)}。"
            f"例えば ffmpeg -i '{path.name}' output.wav でWAVに変換してください"
        )
    return path


def unreadable_audio_error(path, error):
    """soundfile が音声を読めなかったときに、原因と対処を説明するエラーを作ります。"""
    return ValueError(
        f"音声ファイル {Path(path).name} を読み込めませんでした。ファイルが壊れているか、"
        "拡張子と中身の形式が違う可能性があります（例: AAC の音を .mp3 という名前で保存した）。"
        f"ffmpeg -i '{Path(path).name}' output.wav でWAVに変換してから試してください（詳細: {error}）"
    )


def read_info(path):
    """音声ファイルのサンプリング周波数や長さなどの情報を、中身を読み込まずに調べます。"""
    path = check_audio_path(path)
    try:
        return sf.info(str(path))
    except RuntimeError as error:  # soundfile の読み込みエラーは RuntimeError の一種です
        raise unreadable_audio_error(path, error) from error


def file_duration(path):
    """音声ファイル全体の長さ [秒] を返します。"""
    info = read_info(path)
    return info.frames / info.samplerate


def load_audio(path, start_s=0.0, duration_s=None):
    """音声ファイルの一部を読み込みます。

    start_s: 読み込みを始める時刻 [秒]（ファイルの先頭が0秒）
    duration_s: 読み込む長さ [秒]。None ならファイルの最後まで読みます。
    """
    path = check_audio_path(path)
    info = read_info(path)
    total_s = info.frames / info.samplerate
    if start_s < 0:
        raise ValueError(f"開始時刻は0秒以上にしてください（指定: {start_s}秒）")
    if start_s >= total_s:
        raise ValueError(f"開始時刻 {start_s}秒 が音源の長さ {total_s:.2f}秒 を超えています")
    start_frame = int(round(start_s * info.samplerate))
    frames = -1
    if duration_s is not None:
        if duration_s <= 0:
            raise ValueError(f"長さは0秒より大きくしてください（指定: {duration_s}秒）")
        frames = int(round(duration_s * info.samplerate))
        if start_s + duration_s > total_s + 1e-6:
            warnings.warn(
                f"指定範囲が音源の長さ {total_s:.2f}秒 を超えるため、最後までを読み込みます"
            )
    try:
        data, sample_rate = sf.read(
            str(path), start=start_frame, frames=frames, dtype="float32", always_2d=True
        )
    except RuntimeError as error:
        raise unreadable_audio_error(path, error) from error
    if data.shape[0] == 0:
        raise ValueError(f"読み込んだ音声が空です: {path}")
    return AudioClip(data.T.copy(), sample_rate, str(path), start_frame / sample_rate)


def to_mono(clip):
    """全チャンネルを平均して、モノラルの AudioClip を返します。"""
    mono = clip.samples.mean(axis=0, keepdims=True)
    return AudioClip(mono, clip.sample_rate, clip.source_path, clip.offset_s)


def resample_clip(clip, target_rate):
    """サンプリング周波数を target_rate [Hz] に変換した AudioClip を返します。"""
    if clip.sample_rate == target_rate:
        return clip
    samples = librosa.resample(clip.samples, orig_sr=clip.sample_rate, target_sr=target_rate)
    return AudioClip(samples.astype(np.float32), int(target_rate), clip.source_path, clip.offset_s)


def prepare_for_analysis(clip, sample_rate):
    """解析用に、モノラル化してから指定のサンプリング周波数へ変換します。"""
    return resample_clip(to_mono(clip), sample_rate)


def save_audio(path, clip):
    """AudioClip をWAV（32ビット浮動小数点）で保存します。振幅1.0を超えても切り詰めません。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), clip.samples.T, clip.sample_rate, subtype="FLOAT")
    return path


def rms_db(samples):
    """音量の目安として、RMS（二乗平均の平方根）を dBFS で返します。"""
    rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
    floor = 10 ** (SILENCE_FLOOR_DB / 20)
    return 20 * np.log10(max(rms, floor))


def describe_clip(clip):
    """保存用に、AudioClip の基本情報を辞書で返します。"""
    return {
        "source_path": clip.source_path,
        "offset_s": round(clip.offset_s, 6),
        "duration_s": round(clip.duration_s, 6),
        "sample_rate": clip.sample_rate,
        "channels": clip.channels,
        "peak": round(float(np.max(np.abs(clip.samples))), 6),
        "rms_db": round(rms_db(clip.samples), 3),
    }


def file_sha256(path):
    """ファイルの内容から SHA-256 の値を計算します（同じファイルかどうかの確認用）。"""
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()
