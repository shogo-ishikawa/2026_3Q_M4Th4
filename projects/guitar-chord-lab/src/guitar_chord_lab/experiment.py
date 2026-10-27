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
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import correlate, correlation_lags

from .audio import AudioClip, load_audio, make_clip, prepare_for_analysis, save_audio
from .evaluation import crop_intervals, evaluate_segments, find_gaps, read_annotation_csv
from .recognition import ChordSettings, recognise_chords, segment_rows, settings_from_dict
from .results import analysis_info, code_version, library_versions, now_utc, save_json, write_rows_csv

CONDITIONS = ["solo", "mixture", "separated"]
SPLITS = ["tuning", "evaluation"]


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
    """同じ元素材（source_id）が調整用と評価用の両方に入っていないかを確かめます。"""
    splits_of_source = {}
    for item in recordings:
        splits_of_source.setdefault(item.get("source_id"), set()).add(item.get("split"))
    problems = []
    for source_id, splits in splits_of_source.items():
        if len(splits) > 1:
            problems.append(f"元素材 {source_id} が調整用と評価用の両方に入っています。元素材単位で分けてください")
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
    recordings = []
    for item in raw.get("recordings", []):
        item = dict(item)
        for key in ["guitar", "mixture", "annotation"]:
            item[key] = resolve(base, item.get(key))
        item.setdefault("source_id", item.get("id"))
        item.setdefault("material", "real")
        item.setdefault("start_s", 0.0)
        item.setdefault("duration_s", None)
        recordings.append(item)
    accompaniments = []
    for item in raw.get("accompaniments", []):
        item = dict(item)
        item["path"] = resolve(base, item.get("path"))
        item.setdefault("offset_s", 0.0)
        item.setdefault("material", "real")
        accompaniments.append(item)
    problems = check_recordings(recordings)
    conditions = main.get("conditions", CONDITIONS)
    problems += [f"知らない条件です: {name}（使える条件: {CONDITIONS}）" for name in conditions if name not in CONDITIONS]
    if any(item.get("guitar") and not item.get("mixture") for item in recordings) and not accompaniments:
        problems.append("単独ギターから混合音を作るには [[accompaniments]] が必要です")
    for item in accompaniments:
        if not item.get("id") or item.get("path") is None or not Path(item["path"]).exists():
            problems.append(f"伴奏 {item.get('id', '?')}: id と存在する path が必要です")
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


def reference_for(recording, clip):
    """正解注釈を読み込み、解析する切り出し範囲の時刻に直します。"""
    audio_path = recording.get("guitar") or recording.get("mixture")
    total_s = sf.info(str(audio_path)).duration
    full = read_annotation_csv(recording["annotation"], duration_s=total_s)
    start = clip.offset_s
    return crop_intervals(full, start, start + clip.duration_s)


def analyse_condition(clip, reference, settings, labels, output_dir, save_figure):
    """1つの条件の音を解析・評価し、結果の行（辞書）を返します。"""
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
    save_json(output_dir / "analysis.json", analysis_info(analysis, {"condition": labels, "evaluation": metrics}))
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


def run_mixture_conditions(experiment, recording, mixture_clip, guitar_clip, reference, labels, folder):
    """混合音と、そこから分離したギターを解析し、結果の行のリストを返します。"""
    rows = []
    settings = experiment.settings
    if "mixture" in experiment.conditions:
        row = analyse_condition(mixture_clip, reference, settings, dict(labels, condition="mixture"),
                                folder / "mixture", experiment.save_figures)
        if guitar_clip is not None:
            row["lag_vs_solo_ms"] = lag_ms(guitar_clip, mixture_clip)
        rows.append(row)
    if "separated" in experiment.conditions:
        result = separate_for_experiment(experiment, mixture_clip)
        separated = prepare_for_analysis(result.guitar, experiment.mix_sample_rate)
        if separated.samples.shape != mixture_clip.samples.shape:
            raise ValueError(f"分離音の長さ {separated.samples.shape} が混合音 {mixture_clip.samples.shape} と違います")
        if experiment.save_audio:
            save_audio(folder / "separated" / "separated_guitar.wav", result.guitar)
        row = analyse_condition(separated, reference, settings, dict(labels, condition="separated"),
                                folder / "separated", experiment.save_figures)
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
        reference = reference_for(recording, guitar_clip)
        if "solo" in experiment.conditions:
            labels = item_labels(recording, "solo", "none")
            rows.append(analyse_condition(guitar_clip, reference, experiment.settings, labels,
                                          folder / "solo", experiment.save_figures))
    if recording.get("mixture"):
        mixture_clip = load_mono(recording["mixture"], recording["start_s"], recording["duration_s"], rate)
        reference = reference_for(recording, mixture_clip)
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
            if experiment.save_audio:
                save_audio(sub_folder / "mixture.wav", mixture_clip)
            rows += run_mixture_conditions(experiment, recording, mixture_clip, guitar_clip, reference, labels,
                                           sub_folder)
    return rows


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


def summarise(rows, group_keys, value_key):
    """group_keys が同じ行をまとめ、value_key の平均やばらつきを計算します。"""
    groups = {}
    for row in rows:
        groups.setdefault(tuple(row[key] for key in group_keys), []).append(row)
    summary = []
    for key, members in groups.items():
        line = dict(zip(group_keys, key))
        line["n_recordings"] = len({member["recording_id"] for member in members})
        line["n_sources"] = len({member["source_id"] for member in members})
        line.update({f"{value_key}_{name}": value for name, value in describe_values([m[value_key] for m in members]).items()})
        if "decided_ratio" in members[0]:
            line["decided_ratio_mean"] = round(float(np.mean([m["decided_ratio"] for m in members])), 4)
        if "analysis_s" in members[0]:
            line["analysis_s_mean"] = round(float(np.mean([m["analysis_s"] for m in members])), 3)
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
    rows = []
    for recording in recordings:
        print(f"録音 {recording['id']} を処理しています（条件: {', '.join(experiment.conditions)}）")
        rows += run_recording(experiment, recording)
    pairs = paired_differences(rows)
    result = {
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
    if result["pairs"]:
        write_rows_csv(folder / "paired_differences.csv", result["pairs"])
        write_rows_csv(folder / "summary_differences.csv", result["difference_summary"])
    write_rows_csv(folder / "summary_by_condition.csv", result["summary"])
    info = {
        "name": experiment.name,
        "config_file": str(experiment.config_path),
        "config": experiment.raw,
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

    figure = plot_experiment_summary(result, experiment.name)
    figure.savefig(folder / "summary.png", dpi=150)
    plt.close(figure)


def print_experiment_summary(result):
    """件数と条件別の平均正解率を表示します。"""
    counts = result["counts"]
    print(
        f"元録音数 {counts['source_recordings']}、切り出し数 {counts['clips']}、"
        f"人工混合の条件数 {counts['artificial_mixture_conditions']}"
        f"（伴奏 {counts['accompaniments']} 種 × 音量 {len(counts['accompaniment_levels_db'])} 段階）、"
        f"合奏録音 {counts['recorded_mixtures']}、素材の種類 {counts['materials']}"
    )
    for line in result["summary"]:
        level = line["accompaniment_db"]
        level_text = "" if level == "" else f" 伴奏 {level:+.1f} dB"
        std = line["accuracy_std"]
        std_text = "" if std == "" else f" ± {std:.3f}"
        print(
            f"  {line['condition']:<9}{level_text:<14} 正解率 平均 {line['accuracy_mean']:.3f}{std_text}"
            f"（{line['n_recordings']}録音、判定率 {line['decided_ratio_mean']:.3f}）"
        )
    for line in result["difference_summary"]:
        level = line["accompaniment_db"]
        level_text = "合奏録音" if level == "" else f"伴奏 {level:+.1f} dB"
        print(
            f"  分離後 − 分離前（{level_text}）: 平均 {line['difference_mean']:+.3f}"
            f"（最小 {line['difference_min']:+.3f}、最大 {line['difference_max']:+.3f}、{line['n_recordings']}録音）"
        )
