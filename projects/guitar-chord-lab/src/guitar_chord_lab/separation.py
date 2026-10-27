"""Demucs を使って、混合音からギターの音を取り出します。

既定のモデル htdemucs_6s は drums, bass, other, vocals, guitar, piano の6つの音を出力します
（Demucs公式のREADMEとリリースノートで guitar 出力を確認）。
htdemucs などの4音源モデルの other はギターではないため、ギターとして扱いません。

Demucs と PyTorch は、このモジュールの関数を呼んだときに初めて読み込みます。
Demucs を導入していなくても、単独音源のコード認識など他の機能は使えます。
導入方法（作品フォルダで実行）: pip install -e ".[separation]"
"""

import gc
import hashlib
import json
import math
import numbers
import random
import time
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path

import numpy as np

from .audio import AudioClip, load_audio, resample_clip, save_audio

DEFAULT_MODEL = "htdemucs_6s"
GUITAR_SOURCE = "guitar"
CACHE_FORMAT = 1  # キャッシュの保存形式を変えたら数を増やし、古い結果を使わないようにします


class SeparationError(RuntimeError):
    """分離できなかったときのエラーです。原因と対処を文章で示します。"""


@dataclass
class SeparationResult:
    """分離の結果です。時刻は入力した AudioClip と同じです。"""

    guitar: AudioClip  # 分離したギター（モデルのサンプリング周波数とチャンネル数）
    rest: AudioClip  # 入力からギターを引いた残り（聴き比べ用）
    model_name: str
    device: str
    from_cache: bool  # 保存済みの分離結果を再利用したか
    seconds: float  # 分離にかかった時間 [秒]（キャッシュを使ったときは、最初に分離したときの時間）
    options: dict  # 分離の設定（モデル名、shifts、overlap、segment、seed）


def import_demucs():
    """PyTorch と Demucs を読み込みます。見つからなければ対処を示します。"""
    try:
        import demucs.api
        import torch
    except ImportError as error:
        raise SeparationError(
            "Demucs または PyTorch が見つかりません。作品フォルダ（projects/guitar-chord-lab）で "
            "pip install -e \".[separation]\" を実行してください。"
            f"（原因: {error}）"
        ) from error
    return torch, demucs.api


def choose_device(device="auto"):
    """計算に使う装置を選びます。"auto" ならGPU（CUDA）が使えるときだけGPUにします。"""
    torch, _ = import_demucs()
    if device == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if device not in ["cpu", "cuda"]:
        raise SeparationError(f'device は "auto"、"cpu"、"cuda" のどれかにしてください（指定: {device}）')
    if device == "cuda" and not torch.cuda.is_available():
        raise SeparationError(
            "CUDA（GPU）が使えません。Colabでは「ランタイム」→「ランタイムのタイプを変更」でGPUを選ぶか、"
            'device="cpu" を指定してください（CPUでも時間をかければ分離できます）'
        )
    return device


def model_error_message(model_name, error):
    """モデルを取得・読み込めなかったときの説明を作ります。"""
    return (
        f"分離モデル {model_name} を取得・読み込みできませんでした。\n"
        f"原因: {type(error).__name__}: {error}\n"
        "対処:\n"
        "- インターネットに接続できるか確認してください（重みは Hugging Face Hub の adefossez から、"
        "失敗した場合は dl.fbaipublicfiles.com から取得されます）\n"
        "- モデル名の綴りを確認してください（ギターを出力するのは htdemucs_6s です）\n"
        "- 重みの保存先の空き容量を確認してください（Hugging Face Hub の重みは ~/.cache/huggingface、"
        "予備の取得先の重みは ~/.cache/torch に保存されます。環境変数 HF_HOME、TORCH_HOME で変更できます）"
    )


def describe_error(error):
    """エラーの種類と内容を1行の文章にします。"""
    return f"{type(error).__name__}: {error}"


def memory_error_message(device, cause):
    """メモリ不足で分離できなかったときの説明を、使った装置（cpu / cuda）に合わせて作ります。"""
    lines = [f"メモリが足りず分離できませんでした（装置: {device}）。", f"原因: {cause}", "対処:"]
    if device == "cuda":
        lines += [
            '- device="cpu" にして実行し直してください（CPU でも短い音源なら分離できます）',
            "- 他のNotebookを閉じ、「ランタイム」→「セッションを再起動」して GPU のメモリを空けてから実行し直してください",
            "- htdemucs 系のモデルは区切った音を7.8秒の長さに伸ばして処理するため、"
            "segment を小さくしても GPU のメモリは減りません",
        ]
    else:
        lines += [
            "- 切り出す長さ（duration）を短くしてください（まず10〜30秒）",
            "- 他のNotebookやプログラムを閉じ、「ランタイム」→「セッションを再起動」してから実行し直してください",
        ]
    return "\n".join(lines)


def is_out_of_memory(error):
    """エラーがメモリ不足によるものかどうかを判定します。"""
    text = str(error).lower()
    return (
        isinstance(error, MemoryError)
        or type(error).__name__ == "OutOfMemoryError"
        or "out of memory" in text
        or "can't allocate memory" in text
        or "cannot allocate memory" in text
    )


_SEPARATORS = {}  # 読み込んだモデルを使い回すための入れ物（同じ設定なら再読み込みしない）


def check_separation_options(shifts, overlap, segment):
    """分離の設定値を確かめ、問題があれば理由と使える範囲を示して SeparationError にします。"""
    problems = []
    if isinstance(shifts, bool) or not isinstance(shifts, numbers.Integral) or shifts < 0:
        problems.append(f"shifts は0以上の整数にしてください（指定: {shifts!r}）")
    if isinstance(overlap, bool) or not isinstance(overlap, numbers.Real) or not 0 <= overlap < 1:
        problems.append(f"overlap は0以上1未満の数にしてください（指定: {overlap!r}）")
    if segment is not None:
        if isinstance(segment, bool) or not isinstance(segment, numbers.Real) or not 0 < segment < math.inf:
            problems.append(f"segment は正の数 [秒] か None（指定しない）にしてください（指定: {segment!r}）")
    if problems:
        raise SeparationError("分離の設定に問題があります: " + "; ".join(problems))


def check_segment_limit(separator, model_name, segment):
    """segment がモデルの扱える長さを超えていないかを確かめます（htdemucs 系は7.8秒まで）。"""
    limit = float(getattr(separator.model, "max_allowed_segment", math.inf))
    if segment is not None and segment > limit:
        raise SeparationError(
            f"segment（{segment}秒）がモデル {model_name} の上限 {limit:.1f} 秒を超えています。"
            f"{limit:.1f} 以下にするか、指定しないでください（None）"
        )


def load_separator(model_name, device, shifts, overlap, segment):
    """Demucs の Separator（分離器）を読み込みます。guitar を出力しないモデルはエラーにします。"""
    key = (model_name, device, shifts, overlap, segment)
    if key in _SEPARATORS:
        return _SEPARATORS[key]
    _, api = import_demucs()
    try:
        separator = api.Separator(
            model=model_name, device=device, shifts=shifts, overlap=overlap, segment=segment, progress=False
        )
    except Exception as error:
        if is_out_of_memory(error):
            raise SeparationError(memory_error_message(device, describe_error(error))) from error
        raise SeparationError(model_error_message(model_name, error)) from error
    check_segment_limit(separator, model_name, segment)
    sources = list(separator.model.sources)
    if GUITAR_SOURCE not in sources:
        raise SeparationError(
            f"モデル {model_name} は guitar を出力しません（出力: {sources}）。"
            "htdemucs_6s など guitar を出力するモデルを指定してください。"
            "4音源モデルの other はギターとして扱いません"
        )
    _SEPARATORS[key] = separator
    return separator


def to_model_input(clip, sample_rate, channels):
    """モデルに合わせて、サンプリング周波数とチャンネル数をそろえた配列を返します。"""
    clip = resample_clip(clip, sample_rate)
    samples = clip.samples
    if samples.shape[0] != channels:
        mono = samples.mean(axis=0, keepdims=True)
        samples = np.repeat(mono, channels, axis=0)
    return np.ascontiguousarray(samples, dtype=np.float32)


def cache_key(clip, options):
    """入力音の内容と分離の設定から、キャッシュの名前（ハッシュ値）を作ります。"""
    digest = hashlib.sha256()
    digest.update(np.ascontiguousarray(clip.samples, dtype=np.float32).tobytes())
    description = {"sample_rate": clip.sample_rate, "shape": list(clip.samples.shape), "options": options}
    digest.update(json.dumps(description, sort_keys=True).encode("utf-8"))
    return digest.hexdigest()[:24]


def demucs_version():
    """導入されている Demucs の版を返します。"""
    try:
        return metadata.version("demucs")
    except metadata.PackageNotFoundError:
        return "not installed"


def load_cached(cache_dir, key, clip, options):
    """同じ入力・設定の分離結果が保存されていれば読み込み、なければ None を返します。"""
    folder = Path(cache_dir) / key
    meta_path = folder / "meta.json"
    if not meta_path.exists():
        return None
    with open(meta_path, encoding="utf-8") as file:
        meta = json.load(file)
    if meta.get("options") != options or meta.get("key") != key:
        return None
    guitar = load_audio(folder / "guitar.wav")
    rest = load_audio(folder / "rest.wav")
    for item in [guitar, rest]:
        item.source_path, item.offset_s = clip.source_path, clip.offset_s
    # seconds には、最初に分離したときにかかった時間を入れます（読み込みの時間ではありません）
    seconds = meta.get("seconds", float("nan"))
    return SeparationResult(guitar, rest, options["model"], meta["device"], True, seconds, options)


def save_cached(cache_dir, key, result, original_seconds):
    """分離結果をキャッシュとして保存します。"""
    folder = Path(cache_dir) / key
    save_audio(folder / "guitar.wav", result.guitar)
    save_audio(folder / "rest.wav", result.rest)
    meta = {"key": key, "options": result.options, "device": result.device, "seconds": original_seconds}
    with open(folder / "meta.json", "w", encoding="utf-8") as file:
        json.dump(meta, file, ensure_ascii=False, indent=2)


def release_memory(torch, separator, device):
    """メモリ不足のあとで、モデルを CPU に戻し、使っていない GPU のメモリを手放します。"""
    gc.collect()
    if device == "cuda":
        separator.model.to("cpu")
        torch.cuda.empty_cache()


def run_separator(separator, samples, device, seed):
    """Demucs で分離を実行し、{音源名: 配列} の辞書を返します。"""
    torch, _ = import_demucs()
    random.seed(seed)  # shifts > 0 のときのずらし量を再現できるようにする
    torch.manual_seed(seed)
    cause = None
    try:
        with torch.no_grad():
            _, stems = separator.separate_tensor(torch.from_numpy(samples), separator.samplerate)
    except Exception as error:
        if not is_out_of_memory(error):
            raise SeparationError(f"分離中にエラーが起きました: {describe_error(error)}") from error
        # エラーには途中の計算結果が残っているので、文章だけを取り出して手放します
        cause = describe_error(error)
    if cause is not None:
        release_memory(torch, separator, device)
        raise SeparationError(memory_error_message(device, cause))
    return {name: stem.cpu().numpy() for name, stem in stems.items()}


def separate_guitar(
    clip, model_name=DEFAULT_MODEL, device="auto", shifts=0, overlap=0.25, segment=None, seed=0, cache_dir=None
):
    """AudioClip からギターを分離し、SeparationResult を返します。

    shifts: 0なら1回だけ推定します（再現しやすい）。増やすと時間をずらした推定を平均します。
    cache_dir: 指定すると、同じ入力・設定の結果を保存して再利用します。
    """
    check_separation_options(shifts, overlap, segment)
    options = {
        "model": model_name, "shifts": shifts, "overlap": overlap, "segment": segment,
        "seed": seed, "demucs": demucs_version(), "cache_format": CACHE_FORMAT,
    }
    key = cache_key(clip, options)
    if cache_dir is not None:
        cached = load_cached(cache_dir, key, clip, options)
        if cached is not None:
            return cached

    device = choose_device(device)
    separator = load_separator(model_name, device, shifts, overlap, segment)
    samples = to_model_input(clip, separator.samplerate, separator.audio_channels)
    started = time.perf_counter()
    stems = run_separator(separator, samples, device, seed)
    seconds = time.perf_counter() - started

    guitar = stems[GUITAR_SOURCE]
    if guitar.shape != samples.shape:
        raise SeparationError(f"分離結果の長さが入力と違います（入力 {samples.shape}、出力 {guitar.shape}）")
    rate = separator.samplerate
    result = SeparationResult(
        AudioClip(guitar.astype(np.float32), rate, clip.source_path, clip.offset_s),
        AudioClip((samples - guitar).astype(np.float32), rate, clip.source_path, clip.offset_s),
        model_name, device, False, seconds, options,
    )
    if cache_dir is not None:
        save_cached(cache_dir, key, result, seconds)
    return result


def describe_separation(result):
    """保存用に、分離の条件を辞書で返します。"""
    return {
        "options": result.options,
        "device": result.device,
        "from_cache": result.from_cache,
        "seconds": round(result.seconds, 3),
        "output_sample_rate": result.guitar.sample_rate,
        "output_channels": result.guitar.channels,
    }
