"""動作確認用の合成音（ギター風の和音とドラム）と、その正解注釈を作ります。

ギター風の音は Karplus-Strong 法（雑音を短い周期で繰り返しながら少しずつ平均して、
弦をはじいた音に近づける方法）で作ります。

合成音はプログラムの動作・音名の対応・評価計算を確かめるためのものです。
合成音でうまく認識できても、実際のギター録音や合奏音源での精度の根拠にはなりません。
"""

import json
from pathlib import Path

import numpy as np

from .audio import make_clip, save_audio
from .chords import NO_CHORD, PITCH_NAMES, normalise_chord_label
from .evaluation import ChordInterval, write_annotation_csv

# 合成デモのコード進行: (コード, 長さ[秒]) のリスト。N は無音の区間です。
DEMO_PROGRESSIONS = {
    "demo_a": [
        ("N", 1.0), ("C:maj", 2.0), ("G:maj", 2.0), ("A:min", 2.0), ("F:maj", 2.0),
        ("C:maj", 2.0), ("G:maj", 2.0), ("A:min", 2.0), ("F:maj", 2.0), ("N", 1.0),
    ],
    "demo_b": [
        ("N", 1.0), ("E:min", 2.0), ("C:maj", 2.0), ("G:maj", 2.0), ("D:maj", 2.0),
        ("B:min", 2.0), ("F#:min", 2.0), ("A:maj", 2.0), ("E:maj", 2.0), ("N", 1.0),
    ],
}

# 6本の弦で鳴らす音（根音からの半音数）。6弦ルートのバレーコードと同じ形です。
GUITAR_SHAPES = {
    "maj": [0, 7, 12, 16, 19, 24],
    "min": [0, 7, 12, 15, 19, 24],
}

LOWEST_ROOT_MIDI = 40  # 6弦の開放弦 E2 の MIDI ノート番号


def midi_to_hz(midi_note):
    """MIDIノート番号を周波数 [Hz] に変換します（A4 = 69 = 440 Hz）。"""
    return 440.0 * 2 ** ((midi_note - 69) / 12)


def pluck_string(frequency, duration_s, sample_rate, rng, decay_s=1.5):
    """1本の弦をはじいた音を Karplus-Strong 法で作ります。"""
    # 隣り合う値の平均で周期が平均0.5サンプル短くなるため、その分を足して周期を決めます
    period = max(2, int(round(sample_rate / frequency + 0.5)))
    length = int(round(duration_s * sample_rate))
    damping = np.exp(-period / (sample_rate * decay_s))  # 1周期ごとに音を小さくする割合
    buffer = rng.uniform(-1.0, 1.0, period)
    output = np.zeros(length)
    position = 0
    while position < length:
        stop = min(position + period, length)
        output[position:stop] = buffer[: stop - position]
        buffer = damping * 0.5 * (buffer + np.roll(buffer, -1))  # 隣の値と平均して丸い音にする
        position = stop
    return output


def guitar_notes(label):
    """コード名から、6本の弦で鳴らす音の MIDI ノート番号を返します。"""
    root, quality = normalise_chord_label(label).split(":")
    root_midi = LOWEST_ROOT_MIDI + (PITCH_NAMES.index(root) - PITCH_NAMES.index("E")) % 12
    return [root_midi + interval for interval in GUITAR_SHAPES[quality]]


def strum_chord(label, duration_s, sample_rate, rng, strum_gap_s=0.012):
    """低い弦から順に少しずつ遅らせて、和音をかき鳴らした音を作ります。"""
    output = np.zeros(int(round(duration_s * sample_rate)))
    for string_index, midi_note in enumerate(guitar_notes(label)):
        delay = int(round(string_index * strum_gap_s * sample_rate))
        if delay >= len(output):
            break
        tone = pluck_string(midi_to_hz(midi_note), duration_s - delay / sample_rate, sample_rate, rng)
        output[delay: delay + len(tone)] += 0.15 * tone[: len(output) - delay]
    return output


def fade_out(samples, sample_rate, fade_s=0.02):
    """最後の fade_s 秒を少しずつ小さくします（弦をミュートする代わり）。"""
    count = min(len(samples), int(round(fade_s * sample_rate)))
    if count > 0:
        samples[-count:] *= np.linspace(1.0, 0.0, count)
    return samples


def synthesise_progression(progression, sample_rate=44100, tempo_bpm=120, seed=0):
    """コード進行から、拍ごとにかき鳴らすギター風の音（1次元配列）を作ります。"""
    rng = np.random.default_rng(seed)
    beat_s = 60.0 / tempo_bpm
    pieces = []
    for label, duration_s in progression:
        piece = np.zeros(int(round(duration_s * sample_rate)))
        if label != NO_CHORD:
            beat_start = 0.0
            while beat_start < duration_s - 1e-9:
                first = int(round(beat_start * sample_rate))
                strum = strum_chord(label, duration_s - beat_start, sample_rate, rng)
                piece[first: first + len(strum)] = strum[: len(piece) - first]
                beat_start += beat_s
            piece = fade_out(piece, sample_rate)
        pieces.append(piece)
    return np.concatenate(pieces)


def progression_to_intervals(progression):
    """コード進行から正解注釈（ChordInterval のリスト）を作ります。"""
    intervals = []
    time_s = 0.0
    for label, duration_s in progression:
        intervals.append(ChordInterval(round(time_s, 6), round(time_s + duration_s, 6), normalise_chord_label(label)))
        time_s += duration_s
    return intervals


def kick(sample_rate):
    """バスドラム風の音（周波数が下がっていく正弦波）"""
    t = np.arange(int(0.25 * sample_rate)) / sample_rate
    frequency = 50 + 70 * np.exp(-t / 0.04)
    phase = 2 * np.pi * np.cumsum(frequency) / sample_rate
    return np.sin(phase) * np.exp(-t / 0.12)


def snare(sample_rate, rng):
    """スネアドラム風の音（雑音と短い低音）"""
    t = np.arange(int(0.2 * sample_rate)) / sample_rate
    noise = rng.uniform(-1.0, 1.0, len(t)) * np.exp(-t / 0.06)
    body = np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.05)
    return 0.6 * noise + 0.4 * body


def hihat(sample_rate, rng):
    """ハイハット風の音（高い周波数の雑音）"""
    t = np.arange(int(0.06 * sample_rate)) / sample_rate
    noise = np.diff(rng.uniform(-1.0, 1.0, len(t) + 1))  # 差分をとると高音が強くなる
    return 0.25 * noise * np.exp(-t / 0.015)


def add_sound(track, sound, start_index):
    """track の start_index から sound を足し込みます（はみ出す部分は捨てます）。"""
    if start_index >= len(track):
        return
    stop = min(len(track), start_index + len(sound))
    track[start_index:stop] += sound[: stop - start_index]


def synthesise_drums(duration_s, sample_rate=44100, tempo_bpm=120, seed=0):
    """8ビートのドラム風の伴奏（1次元配列）を作ります。"""
    rng = np.random.default_rng(seed)
    track = np.zeros(int(round(duration_s * sample_rate)))
    eighth_s = 30.0 / tempo_bpm
    step = 0
    while step * eighth_s < duration_s:
        start_index = int(round(step * eighth_s * sample_rate))
        add_sound(track, hihat(sample_rate, rng), start_index)
        if step % 8 in [0, 4]:
            add_sound(track, kick(sample_rate), start_index)
        if step % 8 in [2, 6]:
            add_sound(track, snare(sample_rate, rng), start_index)
        step += 1
    return track


def normalise_peak(samples, peak=0.8):
    """最大振幅が peak になるように全体の音量をそろえます。"""
    largest = np.max(np.abs(samples))
    if largest == 0:
        return samples
    return samples * (peak / largest)


def write_demo_dataset(output_dir, sample_rate=44100, tempo_bpm=120, seed=0):
    """合成デモ一式（ギター風の音、正解注釈CSV、ドラム伴奏、説明JSON）を保存します。"""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "description": "Guitar Chord Lab の合成デモ。プログラムの確認用で、実録音ではありません。",
        "sample_rate": sample_rate,
        "tempo_bpm": tempo_bpm,
        "seed": seed,
        "recordings": [],
        "accompaniments": [],
    }
    for index, (name, progression) in enumerate(DEMO_PROGRESSIONS.items()):
        guitar = normalise_peak(synthesise_progression(progression, sample_rate, tempo_bpm, seed + index))
        audio_path = save_audio(output_dir / f"{name}_guitar.wav", make_clip(guitar, sample_rate))
        annotation_path = output_dir / f"{name}_annotation.csv"
        write_annotation_csv(annotation_path, progression_to_intervals(progression))
        manifest["recordings"].append({
            "id": name,
            "audio": audio_path.name,
            "annotation": annotation_path.name,
            "duration_s": round(len(guitar) / sample_rate, 6),
            "seed": seed + index,
            "material": "synthetic",
        })
    longest_s = max(item["duration_s"] for item in manifest["recordings"])
    drums = normalise_peak(synthesise_drums(longest_s, sample_rate, tempo_bpm, seed), 0.5)
    drums_name = f"drums_{tempo_bpm}bpm_seed{seed}"
    save_audio(output_dir / f"{drums_name}.wav", make_clip(drums, sample_rate))
    manifest["accompaniments"].append({
        "id": drums_name,
        "audio": f"{drums_name}.wav",
        "duration_s": round(len(drums) / sample_rate, 6),
        "seed": seed,
        "material": "synthetic",
    })
    with open(output_dir / "manifest.json", "w", encoding="utf-8") as file:
        json.dump(manifest, file, ensure_ascii=False, indent=2)
    return manifest
