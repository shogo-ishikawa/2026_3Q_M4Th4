"""単独ギター・混合音・分離したギターの3条件を、同じ認識器と設定で比べる実験を行います。

- solo: 正解注釈の付いた単独ギター（比較の基準。正解ラベルとしては使いません）
- mixture: ギターに伴奏を混ぜた音（または実際に合奏を録音した音）
- separated: mixture から Demucs で取り出したギター

伴奏の音量は「伴奏のRMS − ギターのRMS」[dB] で指定します（RMSは無音を含む切り出し全体で計算）。
音割れを防ぐときは、混合音全体に同じ倍率を掛けるので、指定した音量比は変わりません。
"""

import random
import time
import tomllib
from dataclasses import asdict, dataclass, field
from pathlib import Path

import librosa
import numpy as np
from scipy.signal import correlate, correlation_lags

from .audio import AudioClip, file_sha256, load_audio, make_clip, prepare_for_analysis, save_audio
from .evaluation import evaluate_segments, find_gaps, reference_for_clip
from .recognition import MIN_DURATION_S, ChordSettings, recognise_chords, segment_rows, settings_from_dict
from .results import analysis_info, code_version, library_versions, now_utc, save_json, write_rows_csv

CONDITIONS = ["solo", "mixture", "separated"]
SPLITS = ["tuning", "evaluation"]

# 設定ファイルの表ごとに使える項目名（綴りの誤りを見つけるため、ほかの名前はエラーにします）
ALLOWED_KEYS = {
    "設定ファイル": ["experiment", "separation", "analysis", "recordings", "accompaniments"],
    "experiment": [
        "name", "output_dir", "seed", "conditions", "accompaniment_db", "mix_sample_rate",
        "peak_limit", "save_audio", "save_figures",
    ],
    "separation": ["model", "device", "shifts", "overlap", "segment", "cache_dir"],
    "recordings": [
        "id", "source_id", "split", "material", "guitar", "mixture", "annotation",
        "start_s", "duration_s", "third_played_ratio", "note",
    ],
    "accompaniments": ["id", "path", "material", "offset_s", "note"],
}

# 聴き比べで、条件どうしの長さ・開始位置の比較に許すずれ [秒]（分離のリサンプリングで1〜2サンプルずれるため）
LENGTH_TOLERANCE_S = 0.01

# 集計表が空のときにも書き出す列（前の実行の結果が残らないように、毎回ファイルを作り直します）
PAIR_COLUMNS = [
    "recording_id", "source_id", "split", "material", "mixture_type", "accompaniment_id", "accompaniment_db",
    "solo_accuracy", "mixture_accuracy", "separated_accuracy", "difference",
    "mixture_decided_ratio", "separated_decided_ratio",
]
DIFFERENCE_COLUMNS = [
    "material", "mixture_type", "accompaniment_id", "accompaniment_db", "n_sources", "n_clips",
    "difference_n", "difference_mean", "difference_std", "difference_min", "difference_max",
]


@dataclass
class Experiment:
    """実験設定ファイルの内容です。パスは絶対パスに直してあります。"""

    name: str
    config_path: Path
    output_dir: Path
    seed: int
    conditions: list
    accompaniment_db: list
    mix_sample_rate: int
    peak_limit: float
    save_audio: bool
    save_figures: bool
    separation: dict
    settings: ChordSettings
    recordings: list
    accompaniments: list
    raw: dict = field(default_factory=dict)  # 読み込んだ設定（記録用）


def resolve(base_dir, value):
    """設定ファイルのあるフォルダを基準に、相対パスを絶対パスに直します。"""
    if value in (None, ""):
        return None
    path = Path(value)
    return path if path.is_absolute() else (base_dir / path).resolve()


def unknown_keys(table_name, values):
    """設定の表 table_name に知らない項目名があれば、その説明のリストを返します。"""
    allowed = ALLOWED_KEYS[table_name]
    return [f"[{table_name}] の知らない項目 {name}（使える項目: {allowed}）" for name in values if name not in allowed]


def audio_file_of(item):
    """録音の設定から、使う音声ファイル（単独ギターまたは合奏録音）のパスを返します。なければ None です。"""
    path = item.get("guitar") or item.get("mixture")
    return str(path) if path else None


def check_recordings(recordings):
    """録音の設定（ID、元素材ID、区分、ファイル）を確かめ、問題を文字列のリストで返します。"""
    problems = []
    seen = set()
    for item in recordings:
        name = item.get("id", "?")
        if name in seen:
            problems.append(f"録音ID {name} が重複しています")
        seen.add(name)
        if item.get("split") not in SPLITS:
            problems.append(f"{name}: split は {SPLITS} のどちらかにしてください")
        if not item.get("source_id"):
            problems.append(f"{name}: source_id（元素材ID）がありません")
        if not item.get("annotation"):
            problems.append(f"{name}: annotation（正解注釈CSV）がありません")
        if not item.get("guitar") and not item.get("mixture"):
            problems.append(f"{name}: guitar（単独ギター）か mixture（合奏録音）が必要です")
        for key in ["guitar", "mixture", "annotation"]:
            if item.get(key) and not Path(item[key]).exists():
                problems.append(f"{name}: {key} のファイルが見つかりません: {item[key]}")
    return problems + check_source_split(recordings)


def check_source_split(recordings):
    """同じ元素材（source_id）や同じ音声ファイルが、調整用と評価用の両方に入っていないかを確かめます。"""
    splits_of_source = {}
    splits_of_file = {}
    for item in recordings:
        splits_of_source.setdefault(item.get("source_id"), set()).add(item.get("split"))
        if audio_file_of(item):
            splits_of_file.setdefault(audio_file_of(item), set()).add(item.get("split"))
    problems = []
    for source_id, splits in splits_of_source.items():
        if len(splits) > 1:
            problems.append(f"元素材 {source_id} が調整用と評価用の両方に入っています。元素材単位で分けてください")
    for audio_file, splits in splits_of_file.items():
        if len(splits) > 1:
            problems.append(f"同じ音声ファイル {Path(audio_file).name} が調整用と評価用の両方に入っています")
    return problems


def check_accompaniments(accompaniments, levels):
    """伴奏の設定（ID の重複、ファイル）と伴奏の音量の重複を確かめ、問題のリストを返します。"""
    problems = []
    seen = set()
    for item in accompaniments:
        if not item.get("id") or item.get("path") is None or not Path(item["path"]).exists():
            problems.append(f"伴奏 {item.get('id', '?')}: id と存在する path が必要です")
        if item.get("id") in seen:
            problems.append(f"伴奏ID {item['id']} が重複しています（分離前後の対応付けができなくなります）")
        seen.add(item.get("id"))
    names = [f"{float(level):+.1f}" for level in levels]
    if len(set(names)) != len(names):
        problems.append(f"accompaniment_db {levels} に、0.1 dB 単位で同じになる値があります")
    return problems


def assign_splits_by_source(source_ids, tuning_fraction=0.2, seed=0):
    """元素材IDを、調整用（tuning）と評価用（evaluation）に分けた辞書を返します。

    同じ元素材の切り出しや加工物は、必ず同じ側に入ります。
    """
    unique = sorted(set(source_ids))
    random.Random(seed).shuffle(unique)
    tuning_count = int(round(len(unique) * tuning_fraction))
    return {source_id: ("tuning" if index < tuning_count else "evaluation") for index, source_id in enumerate(unique)}


def load_experiment(path):
    """実験設定のTOMLファイルを読み込み、内容を確かめて Experiment を返します。"""
    path = Path(path).resolve()
    with open(path, "rb") as file:
        raw = tomllib.load(file)
    base = path.parent
    main = raw.get("experiment", {})
    problems = unknown_keys("設定ファイル", raw) + unknown_keys("experiment", main)
    problems += unknown_keys("separation", raw.get("separation", {}))
    recordings = []
    for item in raw.get("recordings", []):
        problems += unknown_keys("recordings", item)
        item = dict(item)
        for key in ["guitar", "mixture", "annotation"]:
            item[key] = resolve(base, item.get(key))
        # 元素材IDを省略したときは、音声ファイルを元素材とみなします（同じファイルの切り出しは同じ元素材）
        item.setdefault("source_id", audio_file_of(item) or item.get("id"))
        item.setdefault("material", "real")
        item.setdefault("start_s", 0.0)
        item.setdefault("duration_s", None)
        recordings.append(item)
    accompaniments = []
    for item in raw.get("accompaniments", []):
        problems += unknown_keys("accompaniments", item)
        item = dict(item)
        item["path"] = resolve(base, item.get("path"))
        item.setdefault("offset_s", 0.0)
        item.setdefault("material", "real")
        accompaniments.append(item)
    problems += check_recordings(recordings)
    conditions = main.get("conditions", CONDITIONS)
    problems += [f"知らない条件です: {name}（使える条件: {CONDITIONS}）" for name in conditions if name not in CONDITIONS]
    if any(item.get("guitar") and not item.get("mixture") for item in recordings) and not accompaniments:
        problems.append("単独ギターから混合音を作るには [[accompaniments]] が必要です")
    problems += check_accompaniments(accompaniments, main.get("accompaniment_db", [0.0]))
    if problems:
        raise ValueError(f"実験設定 {path.name} に問題があります:\n- " + "\n- ".join(problems))
    separation = {"model": "htdemucs_6s", "device": "auto", "shifts": 0, "overlap": 0.25, "segment": None}
    separation.update(raw.get("separation", {}))
    separation["cache_dir"] = resolve(base, separation.get("cache_dir", "../outputs/cache/separation"))
    return Experiment(
        name=main.get("name", path.stem),
        config_path=path,
        output_dir=resolve(base, main.get("output_dir", f"../outputs/{path.stem}")),
        seed=int(main.get("seed", 0)),
        conditions=list(conditions),
        accompaniment_db=[float(value) for value in main.get("accompaniment_db", [0.0])],
        mix_sample_rate=int(main.get("mix_sample_rate", 44100)),
        peak_limit=float(main.get("peak_limit", 0.99)),
        save_audio=bool(main.get("save_audio", True)),
        save_figures=bool(main.get("save_figures", False)),
        separation=separation,
        settings=settings_from_dict(raw.get("analysis", {})),
        recordings=recordings,
        accompaniments=accompaniments,
        raw=raw,
    )


def rms(samples):
    """RMS（二乗平均の平方根）を返します。"""
    return float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))


@dataclass
class MixResult:
    """ギターと伴奏を混ぜた結果と、そのときの倍率です。"""

    mixture: np.ndarray
    accompaniment_db: float  # 指定した音量比 [dB]
    measured_db: float  # 混ぜた後に測った音量比 [dB]（確認用）
    guitar_gain: float  # ギターに掛けた倍率（音割れ防止の倍率と同じ）
    accompaniment_gain: float  # 伴奏に掛けた倍率
    clip_guard_gain: float  # 音割れ防止のために混合音全体に掛けた倍率（1.0なら何もしていない）


def mix_at_level(guitar, accompaniment, accompaniment_db, peak_limit=0.99):
    """伴奏の音量を「伴奏のRMS − ギターのRMS = accompaniment_db [dB]」にして混ぜます。"""
    if len(guitar) != len(accompaniment):
        raise ValueError(f"ギター（{len(guitar)}サンプル）と伴奏（{len(accompaniment)}サンプル）の長さが違います")
    guitar_rms = rms(guitar)
    accompaniment_rms = rms(accompaniment)
    if guitar_rms == 0:
        raise ValueError("ギターが無音のため、音量比を決められません")
    if accompaniment_rms == 0:
        raise ValueError("伴奏が無音のため、音量比を決められません")
    accompaniment_gain = guitar_rms / accompaniment_rms * 10 ** (accompaniment_db / 20)
    mixture = guitar + accompaniment_gain * accompaniment
    peak = float(np.max(np.abs(mixture)))
    clip_guard_gain = 1.0 if peak <= peak_limit else peak_limit / peak
    measured_db = 20 * np.log10(rms(accompaniment_gain * accompaniment) / guitar_rms)
    return MixResult(
        mixture * clip_guard_gain, accompaniment_db, measured_db,
        clip_guard_gain, accompaniment_gain * clip_guard_gain, clip_guard_gain,
    )


def load_mono(path, start_s, duration_s, sample_rate):
    """音源を切り出し、モノラル・指定のサンプリング周波数の AudioClip にします。"""
    return prepare_for_analysis(load_audio(path, start_s, duration_s), sample_rate)


def load_accompaniment(item, length, sample_rate):
    """伴奏を読み込み、ギターと同じ長さ（サンプル数）に切り出します。"""
    clip = load_mono(item["path"], item["offset_s"], None, sample_rate)
    if clip.samples.shape[1] < length:
        raise ValueError(
            f"伴奏 {item['id']} が短すぎます（{clip.duration_s:.2f}秒）。"
            f"{length / sample_rate:.2f}秒以上の伴奏を用意してください"
        )
    return clip.samples[0, :length]


def estimate_lag_seconds(reference, other, sample_rate, max_lag_s=0.1):
    """other が reference に対して何秒遅れているかを、相互相関で推定します（進んでいれば負）。"""
    correlation = correlate(other, reference, mode="full", method="fft")
    lags = correlation_lags(len(other), len(reference), mode="full")
    window = np.abs(lags) <= int(round(max_lag_s * sample_rate))
    best = lags[window][np.argmax(correlation[window])]
    return float(best / sample_rate)


def fit_length(clip, length):
    """分離して元のサンプリング周波数に戻した音の長さを、混合音と同じサンプル数にそろえます。

    リサンプリングの丸めで1〜2サンプルずれることがあるためです。大きくずれていればエラーにします。
    """
    difference = clip.samples.shape[1] - length
    if abs(difference) > 0.01 * clip.sample_rate:
        raise ValueError(f"分離音の長さ（{clip.samples.shape[1]}サンプル）が混合音（{length}サンプル）と大きく違います")
    samples = librosa.util.fix_length(clip.samples, size=length, axis=-1)
    return AudioClip(samples, clip.sample_rate, clip.source_path, clip.offset_s)


def warm_up(settings):
    """最初の1回の解析は準備に時間がかかるので、時間を測る前に短い音で一度だけ解析しておきます。"""
    duration_s = max(MIN_DURATION_S, settings.segment_seconds) + 0.5
    t = np.arange(int(duration_s * settings.sample_rate)) / settings.sample_rate
    recognise_chords(make_clip(0.1 * np.sin(2 * np.pi * 440 * t), settings.sample_rate), settings)


def analyse_condition(clip, reference, settings, labels, output_dir, save_figure, extra=None):
    """1つの条件の音を解析・評価し、結果の行（辞書）を返します。extra は analysis.json に加える情報です。"""
    started = time.perf_counter()
    analysis = recognise_chords(clip, settings)
    seconds = time.perf_counter() - started
    metrics = evaluate_segments(reference, analysis.segments)
    row = dict(labels)
    row.update(metrics)
    row["analysis_s"] = round(seconds, 3)
    row["duration_s"] = round(clip.duration_s, 4)
    row["sample_rate"] = clip.sample_rate
    unannotated = find_gaps(reference, 0.0, clip.duration_s)
    row["unannotated_s"] = round(sum(end - start for start, end in unannotated), 4)
    write_rows_csv(output_dir / "chords.csv", segment_rows(analysis))
    info_extra = {"condition": labels, "evaluation": metrics}
    if extra:
        info_extra.update(extra)
    save_json(output_dir / "analysis.json", analysis_info(analysis, info_extra))
    if save_figure:
        from .plots import plot_analysis
        import matplotlib.pyplot as plt

        figure = plot_analysis(analysis, f"{labels['recording_id']} / {labels['condition']}", reference)
        figure.savefig(output_dir / "analysis.png", dpi=120)
        plt.close(figure)
    return row


def item_labels(recording, condition, mixture_type, accompaniment_id="", accompaniment_db=None):
    """結果の表に入れる、条件を表す列を作ります。"""
    return {
        "recording_id": recording["id"],
        "source_id": recording["source_id"],
        "split": recording["split"],
        "material": recording["material"],
        "mixture_type": mixture_type,
        "condition": condition,
        "accompaniment_id": accompaniment_id,
        "accompaniment_db": "" if accompaniment_db is None else accompaniment_db,
        "start_s": round(float(recording["start_s"]), 4),
    }


def separate_for_experiment(experiment, mixture_clip):
    """実験の設定で混合音からギターを分離します。"""
    from .separation import separate_guitar

    options = experiment.separation
    return separate_guitar(
        mixture_clip, options["model"], options["device"], options["shifts"], options["overlap"],
        options["segment"], experiment.seed, options["cache_dir"],
    )


def lag_ms(reference_clip, other_clip):
    """other_clip が reference_clip に対して何ミリ秒ずれているかを返します（0なら時刻がそろっている）。"""
    seconds = estimate_lag_seconds(reference_clip.samples[0], other_clip.samples[0], other_clip.sample_rate)
    return round(1000 * seconds, 3)


def saved_audio_info(output_dir, path):
    """今回の実行で保存した音のファイル（出力先からの相対パス）と、内容の SHA-256 を返します。

    結果の行（items.csv）に記録し、後で聴き比べるときに、前の実行で残ったファイルと取り違えないようにします。
    """
    return {"audio_file": Path(path).relative_to(output_dir).as_posix(), "audio_sha256": file_sha256(path)}


def run_mixture_conditions(experiment, recording, mixture_clip, guitar_clip, reference, labels, folder,
                           mixture_audio=None):
    """混合音と、そこから分離したギターを解析し、結果の行のリストを返します。

    mixture_audio は、今回の実行で保存した混合音の記録（saved_audio_info の戻り値）です。
    """
    rows = []
    settings = experiment.settings
    if "mixture" in experiment.conditions:
        row = analyse_condition(mixture_clip, reference, settings, dict(labels, condition="mixture"),
                                folder / "mixture", experiment.save_figures)
        if mixture_audio:
            row.update(mixture_audio)
        if guitar_clip is not None:
            row["lag_vs_solo_ms"] = lag_ms(guitar_clip, mixture_clip)
        rows.append(row)
    if "separated" in experiment.conditions:
        from .separation import describe_separation

        result = separate_for_experiment(experiment, mixture_clip)
        separated = prepare_for_analysis(result.guitar, experiment.mix_sample_rate)
        separated = fit_length(separated, mixture_clip.samples.shape[1])
        separated_audio = None
        if experiment.save_audio:
            path = save_audio(folder / "separated" / "separated_guitar.wav", result.guitar)
            separated_audio = saved_audio_info(experiment.output_dir, path)
        row = analyse_condition(separated, reference, settings, dict(labels, condition="separated"),
                                folder / "separated", experiment.save_figures,
                                {"separation": describe_separation(result)})
        if separated_audio:
            row.update(separated_audio)
        row["separation_model"] = result.model_name
        row["separation_s"] = round(result.seconds, 3)
        row["separation_from_cache"] = result.from_cache
        row["separation_device"] = result.device
        if guitar_clip is not None:
            row["lag_vs_solo_ms"] = lag_ms(guitar_clip, separated)
        else:
            row["lag_vs_mixture_ms"] = lag_ms(mixture_clip, separated)
        rows.append(row)
    return rows


def run_recording(experiment, recording):
    """1つの録音について、指定された条件をすべて実行し、結果の行のリストを返します。"""
    rate = experiment.mix_sample_rate
    folder = experiment.output_dir / "items" / recording["id"]
    rows = []
    guitar_clip = None
    if recording.get("guitar"):
        guitar_clip = load_mono(recording["guitar"], recording["start_s"], recording["duration_s"], rate)
        reference = reference_for_clip(recording["annotation"], guitar_clip)
        if "solo" in experiment.conditions:
            labels = item_labels(recording, "solo", "none")
            rows.append(analyse_condition(guitar_clip, reference, experiment.settings, labels,
                                          folder / "solo", experiment.save_figures))
    if recording.get("mixture"):
        mixture_clip = load_mono(recording["mixture"], recording["start_s"], recording["duration_s"], rate)
        reference = reference_for_clip(recording["annotation"], mixture_clip)
        if guitar_clip is not None and guitar_clip.samples.shape != mixture_clip.samples.shape:
            raise ValueError(f"{recording['id']}: 単独ギターと合奏録音の長さが違います")
        labels = item_labels(recording, "", "recorded", "recorded")
        rows += run_mixture_conditions(experiment, recording, mixture_clip, guitar_clip, reference, labels,
                                       folder / "recorded")
        return rows
    guitar = guitar_clip.samples[0]
    for accompaniment in experiment.accompaniments:
        backing = load_accompaniment(accompaniment, len(guitar), rate)
        for level in experiment.accompaniment_db:
            mix = mix_at_level(guitar, backing, level, experiment.peak_limit)
            # 混合音はメモリ上で作った音なので元ファイル名は空にし、切り出し位置だけを引き継ぎます
            mixture_clip = make_clip(mix.mixture, rate, "", guitar_clip.offset_s)
            labels = item_labels(recording, "", "artificial", accompaniment["id"], level)
            labels["accompaniment_material"] = accompaniment["material"]
            labels["accompaniment_offset_s"] = accompaniment["offset_s"]
            labels["measured_db"] = round(mix.measured_db, 3)
            labels["clip_guard_gain"] = round(mix.clip_guard_gain, 5)
            sub_folder = folder / f"{accompaniment['id']}_{level:+.1f}dB"
            mixture_audio = None
            if experiment.save_audio:
                path = save_audio(sub_folder / "mixture.wav", mixture_clip)
                mixture_audio = saved_audio_info(experiment.output_dir, path)
            rows += run_mixture_conditions(experiment, recording, mixture_clip, guitar_clip, reference, labels,
                                           sub_folder, mixture_audio)
    return rows


@dataclass
class ListeningClips:
    """聴き比べに使う、今回の実行結果にある条件の音です（Notebook 3 で使います）。"""

    clips: dict  # 条件名（solo / mixture / separated）→ AudioClip。今回の実行で使える条件だけ
    reference: list  # 正解注釈（切り出した範囲の先頭を0秒とする時刻）
    notes: list  # 聴けない条件と、その理由
    description: str = ""  # 図の題名に使う、選んだ条件の説明（英語）


def find_condition_row(rows, condition, accompaniment_id, level_db):
    """1つの録音の結果の行から、条件と伴奏・音量が一致する行を探します。なければ None を返します。"""
    for row in rows:
        if row["condition"] != condition:
            continue
        if condition == "solo" or row["mixture_type"] == "recorded":
            return row  # 単独ギターと合奏録音には、伴奏と音量の区別がありません
        same_level = level_db is not None and abs(float(row["accompaniment_db"]) - float(level_db)) < 0.05
        if row["accompaniment_id"] == accompaniment_id and same_level:
            return row
    return None


def missing_condition_reason(conditions, rows, condition, accompaniment_id, level_db):
    """今回の結果に、その条件の行がない理由を説明します。conditions は今回の実行の条件です。"""
    if condition not in conditions:
        return f"今回の実行の条件に含まれていません（実行した条件: {', '.join(conditions)}）"
    if any(row["condition"] == condition for row in rows):
        return f"伴奏 {accompaniment_id}・音量 {level_db} dB の結果は、今回の実行にありません"
    return "今回の実行結果にありません"


def load_saved_audio(output_dir, row):
    """結果の行に記録された、今回の実行で保存した音を読み込みます。(AudioClip, None) か (None, 理由) を返します。

    output_dir は、その実行の保存先です（記録したファイルは、保存先からの相対パスです）。
    """
    if not row.get("audio_file"):
        return None, "今回の実行では音を保存していません（実験の設定で save_audio = true にすると保存します）"
    path = Path(output_dir) / row["audio_file"]
    if not path.exists():
        return None, f"今回の実行で保存した {row['audio_file']} が見つかりません"
    if file_sha256(path) != row["audio_sha256"]:
        return None, f"{row['audio_file']} は今回の実行の後で書き換えられています（別の実行で上書きされた可能性があります）"
    return load_audio(path), None


def check_listening_range(clip, row, source):
    """読み込んだ音の長さと時間範囲が、今回の解析と合っているかを確かめます。合わなければ理由を返します。"""
    analysed_s, start_s = float(row["duration_s"]), float(row["start_s"])
    if abs(clip.duration_s - analysed_s) > LENGTH_TOLERANCE_S:
        return f"音の長さ（{clip.duration_s:.2f} 秒）が、今回解析した長さ（{analysed_s:.2f} 秒）と合いません"
    same_length = abs(source.duration_s - analysed_s) <= LENGTH_TOLERANCE_S
    same_start = abs(source.offset_s - start_s) <= LENGTH_TOLERANCE_S
    if not (same_length and same_start):
        return (
            f"今回解析した範囲（{start_s:.2f} 秒から {analysed_s:.2f} 秒間）が、"
            f"実験の設定の範囲（{source.offset_s:.2f} 秒から {source.duration_s:.2f} 秒間）と合いません"
        )
    return None


def load_listening_clips(experiment, result, recording_id, accompaniment_id, level_db):
    """今回の実行結果（result）にある条件の音だけを読み込み、ListeningClips を返します。

    items/ に前の実行のファイルが残っていても使いません。今回の結果の行に記録されたファイルのうち、
    内容（SHA-256）が一致し、長さと時間範囲が今回の解析と合うものだけを使います。
    単独ギターと合奏録音（mixture）は元の音源から切り出し直します（合奏録音では accompaniment_id と level_db は使いません）。
    分離したギターは、どの場合も今回の実行で保存したファイルを使います。
    """
    rows = [row for row in result["rows"] if row["recording_id"] == recording_id]
    if not rows:
        available = sorted({row["recording_id"] for row in result["rows"]})
        raise ValueError(f"今回の実行結果に録音 {recording_id} がありません（結果にある録音: {available}）")
    recording = next((item for item in experiment.recordings if item["id"] == recording_id), None)
    if recording is None:
        raise ValueError(
            f"実験の設定に録音 {recording_id} がありません。実行の後で設定を読み込み直した可能性があります。"
            "実験を実行し直してから聴き比べてください"
        )
    output_dir = result.get("output_dir", experiment.output_dir)  # その実行の保存先
    conditions = result.get("conditions", experiment.conditions)  # その実行の条件
    recorded = any(row["mixture_type"] == "recorded" for row in rows)
    rate = experiment.mix_sample_rate
    start_s, duration_s = recording["start_s"], recording["duration_s"]
    source = load_mono(recording.get("guitar") or recording["mixture"], start_s, duration_s, rate)
    clips, notes = {}, []
    for condition in CONDITIONS:
        row = find_condition_row(rows, condition, accompaniment_id, level_db)
        if row is None:
            reason = missing_condition_reason(conditions, rows, condition, accompaniment_id, level_db)
            notes.append(f"{condition}: {reason}")
            continue
        if condition == "solo":
            clip, reason = source, None
        elif condition == "mixture" and row["mixture_type"] == "recorded":
            clip, reason = load_mono(recording["mixture"], start_s, duration_s, rate), None
        else:  # 人工の混合音と、分離したギター（合奏録音から分離した場合も）
            clip, reason = load_saved_audio(output_dir, row)
            if clip is not None:  # 保存した WAV には切り出し位置がないので、元の音源の位置を付けます
                clip.source_path, clip.offset_s = source.source_path, source.offset_s
        if clip is not None:
            reason = check_listening_range(clip, row, source)
        if reason:
            notes.append(f"{condition}: {reason}")
            continue
        clips[condition] = clip
    if recorded:
        description = "recorded mixture"
    else:
        level = "" if level_db is None else f" {float(level_db):+.1f} dB"
        description = f"accompaniment {accompaniment_id}{level}"
    return ListeningClips(clips, reference_for_clip(recording["annotation"], source), notes, description)


def paired_differences(rows):
    """同じ録音・伴奏・音量の「分離後 − 分離前」の正解率の差を計算します。"""
    solo = {row["recording_id"]: row for row in rows if row["condition"] == "solo"}
    mixtures = {}
    for row in rows:
        if row["condition"] == "mixture":
            mixtures[(row["recording_id"], row["accompaniment_id"], row["accompaniment_db"])] = row
    pairs = []
    for row in rows:
        key = (row["recording_id"], row["accompaniment_id"], row["accompaniment_db"])
        if row["condition"] != "separated" or key not in mixtures:
            continue
        before = mixtures[key]
        pairs.append({
            "recording_id": row["recording_id"],
            "source_id": row["source_id"],
            "split": row["split"],
            "material": row["material"],
            "mixture_type": row["mixture_type"],
            "accompaniment_id": row["accompaniment_id"],
            "accompaniment_db": row["accompaniment_db"],
            "solo_accuracy": solo[row["recording_id"]]["accuracy"] if row["recording_id"] in solo else "",
            "mixture_accuracy": before["accuracy"],
            "separated_accuracy": row["accuracy"],
            "difference": round(row["accuracy"] - before["accuracy"], 4),
            "mixture_decided_ratio": before["decided_ratio"],
            "separated_decided_ratio": row["decided_ratio"],
        })
    return pairs


def describe_values(values):
    """数値のリストの件数・平均・標準偏差・最小・最大を返します。"""
    values = np.array(values, dtype=float)
    return {
        "n": len(values),
        "mean": round(float(values.mean()), 4),
        "std": round(float(values.std(ddof=1)), 4) if len(values) > 1 else "",
        "min": round(float(values.min()), 4),
        "max": round(float(values.max()), 4),
    }


def source_means(members, value_key):
    """元素材ごとに value_key の平均をとったリストを返します。"""
    per_source = {}
    for member in members:
        per_source.setdefault(member["source_id"], []).append(member[value_key])
    return [float(np.mean(values)) for values in per_source.values()]


def summarise(rows, group_keys, value_key):
    """group_keys が同じ行をまとめ、value_key の平均やばらつきを計算します。

    同じ元素材から複数の切り出しがあるときは、まず元素材ごとに平均してから集計します
    （同じ録音の加工物を独立した曲として数えないためです）。value_key_n は元素材の数です。
    """
    groups = {}
    for row in rows:
        groups.setdefault(tuple(row[key] for key in group_keys), []).append(row)
    summary = []
    for key, members in groups.items():
        line = dict(zip(group_keys, key))
        line["n_sources"] = len({member["source_id"] for member in members})
        line["n_clips"] = len({member["recording_id"] for member in members})
        statistics = describe_values(source_means(members, value_key))
        line.update({f"{value_key}_{name}": value for name, value in statistics.items()})
        if "decided_ratio" in members[0]:
            line["decided_ratio_mean"] = round(float(np.mean(source_means(members, "decided_ratio"))), 4)
        for time_key in ["analysis_s", "separation_s"]:  # 処理時間は1回ごとの平均
            times = [member[time_key] for member in members if member.get(time_key, "") != ""]
            if times:
                line[f"{time_key}_mean"] = round(float(np.mean(times)), 3)
        summary.append(line)
    return summary


def count_materials(experiment, recordings):
    """元録音数・切り出し数・混合条件数を数えます（同じ録音の加工物を別の曲として数えないため）。"""
    artificial = [item for item in recordings if not item.get("mixture")]
    return {
        "source_recordings": len({item["source_id"] for item in recordings}),
        "clips": len(recordings),
        "artificial_mixture_conditions": len(artificial) * len(experiment.accompaniments) * len(experiment.accompaniment_db),
        "recorded_mixtures": len(recordings) - len(artificial),
        "accompaniments": len(experiment.accompaniments),
        "accompaniment_levels_db": experiment.accompaniment_db,
        "materials": sorted({item["material"] for item in recordings}),
    }


def run_experiment(experiment, split="all", conditions=None, output_dir=None):
    """比較実験を実行し、結果をCSV・JSON・図に保存して、結果の辞書を返します。"""
    if conditions:
        unknown = [name for name in conditions if name not in CONDITIONS]
        if unknown:
            raise ValueError(f"知らない条件です: {unknown}（使える条件: {CONDITIONS}）")
        experiment.conditions = list(conditions)
    if output_dir:
        experiment.output_dir = Path(output_dir).resolve()
    if split not in SPLITS + ["all"]:
        raise ValueError(f"split は {SPLITS + ['all']} のどれかにしてください")
    recordings = [item for item in experiment.recordings if split == "all" or item["split"] == split]
    if not recordings:
        raise ValueError(f"split={split} の録音がありません")
    started = now_utc()
    warm_up(experiment.settings)
    rows = []
    for recording in recordings:
        print(f"録音 {recording['id']} を処理しています（条件: {', '.join(experiment.conditions)}）")
        rows += run_recording(experiment, recording)
    pairs = paired_differences(rows)
    result = {
        "output_dir": str(experiment.output_dir),  # この実行の保存先（聴き比べで、保存した音を探すときに使う）
        "conditions": list(experiment.conditions),  # この実行の条件
        "rows": rows,
        "pairs": pairs,
        "summary": summarise(rows, ["material", "mixture_type", "condition", "accompaniment_id", "accompaniment_db"], "accuracy"),
        "difference_summary": summarise(pairs, ["material", "mixture_type", "accompaniment_id", "accompaniment_db"], "difference"),
        "counts": count_materials(experiment, recordings),
    }
    save_experiment(experiment, result, split, started)
    print_experiment_summary(result)
    return result


def save_experiment(experiment, result, split, started):
    """実験結果をCSV・JSON・図に保存します。"""
    folder = experiment.output_dir
    columns = []
    for row in result["rows"]:
        for key in row:
            if key not in columns:
                columns.append(key)
    write_rows_csv(folder / "items.csv", result["rows"], columns)
    # 分離の結果がなくても（ヘッダーだけの）ファイルを書き直し、前の実行の集計が残らないようにします
    write_rows_csv(folder / "paired_differences.csv", result["pairs"], None if result["pairs"] else PAIR_COLUMNS)
    write_rows_csv(
        folder / "summary_differences.csv", result["difference_summary"],
        None if result["difference_summary"] else DIFFERENCE_COLUMNS,
    )
    write_rows_csv(folder / "summary_by_condition.csv", result["summary"])
    info = {
        "name": experiment.name,
        "config_file": str(experiment.config_path),
        "config": experiment.raw,
        "effective_settings": effective_settings(experiment),
        "split": split,
        "conditions": experiment.conditions,
        "seed": experiment.seed,
        "counts": result["counts"],
        "mixing": {
            "level_definition": "accompaniment_db = 20*log10(RMS(accompaniment) / RMS(guitar)), RMS over the whole clip including silence",
            "mix_sample_rate": experiment.mix_sample_rate,
            "peak_limit": experiment.peak_limit,
            "clip_guard": "one common gain for the whole mixture; the level ratio is kept",
        },
        "started_utc": started,
        "finished_utc": now_utc(),
        "libraries": library_versions(),
        "code": code_version(),
    }
    save_json(folder / "experiment.json", info)
    from .plots import plot_experiment_summary
    import matplotlib.pyplot as plt

    if "separated" in experiment.conditions:
        model = f"separation model: {experiment.separation['model']}"
    else:
        model = "no separation"
    figure = plot_experiment_summary(result, f"{experiment.name} (split: {split}, {model})", experiment.settings)
    figure.savefig(folder / "summary.png", dpi=150)
    plt.close(figure)


def plain(item):
    """保存できるように、Path を文字列に直した辞書を返します。"""
    return {key: (str(value) if isinstance(value, Path) else value) for key, value in item.items()}


def effective_settings(experiment):
    """実際に使った設定（省略した項目には既定値を入れたもの）を返します。"""
    return {
        "output_dir": str(experiment.output_dir),
        "conditions": experiment.conditions,
        "accompaniment_db": experiment.accompaniment_db,
        "mix_sample_rate": experiment.mix_sample_rate,
        "peak_limit": experiment.peak_limit,
        "separation": plain(experiment.separation),
        "analysis": asdict(experiment.settings),
        "recordings": [plain(item) for item in experiment.recordings],
        "accompaniments": [plain(item) for item in experiment.accompaniments],
    }


def print_experiment_summary(result):
    """件数と条件別の平均正解率を表示します。"""
    counts = result["counts"]
    detail = ""
    if counts["artificial_mixture_conditions"]:
        detail = f"（伴奏 {counts['accompaniments']} 種 × 音量 {len(counts['accompaniment_levels_db'])} 段階）"
    print(
        f"元録音数 {counts['source_recordings']}、切り出し数 {counts['clips']}、"
        f"人工混合の条件数 {counts['artificial_mixture_conditions']}{detail}、"
        f"合奏録音 {counts['recorded_mixtures']}、素材の種類 {counts['materials']}"
    )
    for line in result["summary"]:
        std = line["accuracy_std"]
        std_text = "" if std == "" else f" ± {std:.3f}"
        print(
            f"  [{line['material']}] {line['condition']:<9} {condition_text(line):<26} "
            f"正解率 平均 {line['accuracy_mean']:.3f}{std_text}"
            f"（{line['n_sources']}素材・{line['n_clips']}切り出し、判定率 {line['decided_ratio_mean']:.3f}）"
        )
    for line in result["difference_summary"]:
        print(
            f"  [{line['material']}] 分離後 − 分離前 {condition_text(line):<26} 平均 {line['difference_mean']:+.3f}"
            f"（最小 {line['difference_min']:+.3f}、最大 {line['difference_max']:+.3f}、"
            f"{line['n_sources']}素材・{line['n_clips']}切り出し）"
        )


def condition_text(line):
    """集計の1行が、どの伴奏・音量の結果かを表す短い文字列を返します。"""
    if line["mixture_type"] == "recorded":
        return "合奏録音"
    if line["accompaniment_db"] == "":
        return ""
    return f"伴奏 {line['accompaniment_id']} {line['accompaniment_db']:+.1f} dB"
