"""クロマグラムとコード推移の図を作ります。

図の文字は、日本語フォントがない環境でも表示できるように英語（英国式の綴り）にしています。
"""

import librosa
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Patch

from .chords import CHORD_LABELS, PITCH_NAMES, short_chord_name
from .recognition import STATUS_CHORD, STATUS_NO_CHORD, STATUS_UNDECIDED

STATUS_COLOURS = {
    STATUS_CHORD: "#4878d0",  # 判定したコード（青）
    STATUS_NO_CHORD: "#bbbbbb",  # N: コードなし（灰）
    STATUS_UNDECIDED: "#ee854a",  # X: 判定保留（橙）
}
REFERENCE_COLOUR = "#6acc64"  # 正解注釈（緑）


def frame_loudness_db(analysis):
    """クロマと同じ間隔で、各フレームの音量（RMS [dBFS]）を計算します。"""
    rms = librosa.feature.rms(y=analysis.clip.samples[0], frame_length=2048, hop_length=analysis.settings.hop_length)[0]
    return 20 * np.log10(np.maximum(rms, 1e-6))


def chroma_for_display(analysis):
    """表示用に、各フレームのクロマを最大値で割って0〜1にそろえます。

    無音しきい値より小さいフレームは、雑音が目立たないように0にします。
    """
    chroma = analysis.chroma
    peak = chroma.max(axis=0, keepdims=True)
    scaled = np.divide(chroma, peak, out=np.zeros_like(chroma), where=peak > 0)
    loudness = frame_loudness_db(analysis)
    count = min(len(loudness), scaled.shape[1])
    quiet = np.zeros(scaled.shape[1], dtype=bool)
    quiet[:count] = loudness[:count] < analysis.settings.silence_db
    scaled[:, quiet] = 0
    return scaled


def settings_summary(settings):
    """図の題名に入れる、主な解析条件の短い説明を返します。"""
    return (
        f"{settings.chroma_method.upper()} chroma, segment {settings.segment_seconds} s, "
        f"silence < {settings.silence_db} dBFS, min score {settings.min_score}, "
        f"min margin {settings.min_margin}, smoothing {settings.smoothing_segments}"
    )


def plot_chromagram(ax, analysis):
    """クロマグラム（横軸: 時刻、縦軸: 12音）を描きます。"""
    hop_s = analysis.settings.hop_length / analysis.clip.sample_rate
    times = analysis.frame_times
    time_edges = np.concatenate([times - hop_s / 2, [times[-1] + hop_s / 2]])
    image = ax.pcolormesh(time_edges, np.arange(13), chroma_for_display(analysis), cmap="magma", vmin=0, vmax=1)
    ax.set_yticks(np.arange(12) + 0.5)
    ax.set_yticklabels(PITCH_NAMES)
    ax.set_ylabel("Pitch class")
    ax.set_title("Chromagram (each frame scaled to its maximum; silent frames in black)", loc="left")
    return image


def draw_timeline_row(ax, y, segments, colour_of, label_of):
    """1行分のコード区間を横棒で描きます。"""
    for segment in segments:
        width = segment.end_s - segment.start_s
        ax.barh(y, width, left=segment.start_s, height=0.8, color=colour_of(segment), edgecolor="white")
        if width >= 0.4:
            ax.text(segment.start_s + width / 2, y, label_of(segment), ha="center", va="center", fontsize=8)


def plot_chord_timeline(ax, analysis, reference=None):
    """推定したコード区間（と、あれば正解注釈）を描きます。"""
    rows = ["Estimate"]
    draw_timeline_row(
        ax, 0, analysis.segments,
        lambda segment: STATUS_COLOURS[segment.status],
        lambda segment: short_chord_name(segment.chord),
    )
    if reference is not None:
        rows.append("Reference")
        draw_timeline_row(ax, 1, reference, lambda _: REFERENCE_COLOUR, lambda item: short_chord_name(item.chord))
    ax.set_yticks(range(len(rows)))
    ax.set_yticklabels(rows)
    ax.set_ylim(-0.6, len(rows) - 0.4)
    ax.set_title("Chord estimate", loc="left")
    handles = [
        Patch(color=STATUS_COLOURS[STATUS_CHORD], label="chord"),
        Patch(color=STATUS_COLOURS[STATUS_NO_CHORD], label="N (no chord)"),
        Patch(color=STATUS_COLOURS[STATUS_UNDECIDED], label="? (undecided)"),
    ]
    if reference is not None:
        handles.append(Patch(color=REFERENCE_COLOUR, label="reference"))
    ax.legend(handles=handles, loc="lower right", bbox_to_anchor=(1, 1), fontsize=7, ncol=len(handles), frameon=False)


def segment_score_lines(analysis):
    """固定幅の区間ごとに、第1候補の類似度と第1・第2候補の差を返します（無音区間は NaN）。"""
    top_scores, margins = [], []
    for index in range(len(analysis.segment_edges)):
        ordered = np.sort(analysis.scores[index])[::-1]
        if analysis.segment_labels[index] == "N":
            top_scores.append(np.nan)
            margins.append(np.nan)
        else:
            top_scores.append(ordered[0])
            margins.append(ordered[0] - ordered[1])
    return np.array(top_scores), np.array(margins)


def plot_scores(ax, analysis):
    """類似度と、判定に使うしきい値を描きます。"""
    starts = [start for start, _ in analysis.segment_edges]
    end = analysis.segment_edges[-1][1]
    top_scores, margins = segment_score_lines(analysis)
    ax.step(starts + [end], list(top_scores) + [top_scores[-1]], where="post", label="best score")
    ax.step(starts + [end], list(margins) + [margins[-1]], where="post", label="best - second")
    ax.axhline(analysis.settings.min_score, linestyle="--", color="C0", linewidth=0.8, label="min score")
    ax.axhline(analysis.settings.min_margin, linestyle=":", color="C1", linewidth=0.8, label="min margin")
    ax.set_ylim(0, 1.05)
    ax.set_ylabel("Cosine similarity")
    ax.set_title("Template similarity (not a probability)", loc="left")
    ax.legend(loc="lower right", bbox_to_anchor=(1, 1), fontsize=7, ncol=4, frameon=False)


def plot_analysis(analysis, title="", reference=None):
    """クロマグラム・コード推移・類似度を、同じ時間軸の3段の図にまとめます。"""
    figure, axes = plt.subplots(
        3, 1, figsize=(11, 7.5), sharex=True, height_ratios=[3, 1.4, 1.6], layout="constrained"
    )
    image = plot_chromagram(axes[0], analysis)
    figure.colorbar(image, ax=list(axes), location="right", fraction=0.02, pad=0.01, label="Relative strength")
    plot_chord_timeline(axes[1], analysis, reference)
    plot_scores(axes[2], analysis)
    offset = analysis.clip.offset_s
    axes[2].set_xlabel(f"Time in clip [s] (clip starts at {offset:.2f} s of the source file)")
    axes[2].set_xlim(0, analysis.clip.duration_s)
    figure.suptitle((title + "\n" if title else "") + settings_summary(analysis.settings), fontsize=9)
    return figure


def plot_comparison(analyses, reference=None, title=""):
    """複数の条件（例: 混合音と分離音）のコード推移を、同じ時間軸に並べて描きます。

    analyses は {"条件名": ChordAnalysis} の辞書です。
    """
    names = list(analyses)
    figure, ax = plt.subplots(figsize=(11, 1.2 + 0.7 * (len(names) + 1)), layout="constrained")
    for row, name in enumerate(names):
        draw_timeline_row(
            ax, row, analyses[name].segments,
            lambda segment: STATUS_COLOURS[segment.status],
            lambda segment: short_chord_name(segment.chord),
        )
    labels = list(names)
    if reference is not None:
        draw_timeline_row(ax, len(names), reference, lambda _: REFERENCE_COLOUR, lambda item: short_chord_name(item.chord))
        labels.append("reference")
    ax.set_yticks(range(len(labels)))
    ax.set_yticklabels(labels)
    ax.set_ylim(-0.6, len(labels) - 0.4)
    ax.set_xlabel("Time in clip [s]")
    first = analyses[names[0]]
    ax.set_xlim(0, first.clip.duration_s)
    ax.set_title((title + "\n" if title else "") + settings_summary(first.settings), fontsize=9)
    return figure


def plot_templates():
    """24種類のコードのテンプレート（構成音が1の表）を描きます。"""
    from .chords import make_chord_templates

    figure, ax = plt.subplots(figsize=(9, 4), layout="constrained")
    ax.imshow(make_chord_templates().T, aspect="auto", origin="lower", cmap="Greys", vmin=0, vmax=1.4)
    ax.set_xticks(range(len(CHORD_LABELS)))
    ax.set_xticklabels([short_chord_name(label) for label in CHORD_LABELS], rotation=90)
    ax.set_yticks(range(12))
    ax.set_yticklabels(PITCH_NAMES)
    ax.set_xlabel("Chord template")
    ax.set_ylabel("Pitch class")
    ax.set_title("Major/minor triad templates (black = note in the chord)")
    return figure


CONDITION_COLOURS = {"solo": "#6acc64", "mixture": "#d65f5f", "separated": "#4878d0"}


def rows_by_recording(rows, condition):
    """人工混合の結果を {録音ID: {伴奏の音量: 正解率}} の形にまとめます。"""
    table = {}
    for row in rows:
        if row["condition"] == condition and row["mixture_type"] == "artificial":
            table.setdefault(row["recording_id"], {})[row["accompaniment_db"]] = row["accuracy"]
    return table


def plot_level_lines(ax, table, levels, colour, label):
    """録音ごとの細い線と、平均の太い線を描きます。"""
    for values in table.values():
        ax.plot(levels, [values.get(level, np.nan) for level in levels], color=colour, alpha=0.3, linewidth=0.8)
    means = [np.nanmean([values.get(level, np.nan) for values in table.values()]) for level in levels]
    ax.plot(levels, means, color=colour, linewidth=2.2, marker="o", label=f"{label} (mean)")


def plot_experiment_summary(result, title=""):
    """条件別の正解率と、分離後−分離前の差を、伴奏の音量ごとに描きます（人工混合のみ）。"""
    rows = result["rows"]
    levels = sorted({row["accompaniment_db"] for row in rows if row["mixture_type"] == "artificial"})
    figure, axes = plt.subplots(1, 2, figsize=(11, 4.2), layout="constrained")
    if not levels:
        for ax in axes:
            ax.text(0.5, 0.5, "No artificial mixtures (see items.csv)", ha="center", va="center")
        return figure
    solo = [row["accuracy"] for row in rows if row["condition"] == "solo"]
    if solo:
        axes[0].axhline(np.mean(solo), color=CONDITION_COLOURS["solo"], linewidth=2.2, label="solo guitar (mean)")
    for condition in ["mixture", "separated"]:
        table = rows_by_recording(rows, condition)
        if table:
            plot_level_lines(axes[0], table, levels, CONDITION_COLOURS[condition], condition)
    axes[0].set_ylim(0, 1.02)
    axes[0].set_xlabel("Accompaniment level relative to guitar [dB RMS]")
    axes[0].set_ylabel("Accuracy (correct time / evaluated time)")
    axes[0].set_title("Accuracy by condition (thin lines: recordings)", loc="left", fontsize=10)
    axes[0].legend(fontsize=8)
    differences = {}
    for pair in result["pairs"]:
        if pair["mixture_type"] == "artificial":
            differences.setdefault(pair["recording_id"], {})[pair["accompaniment_db"]] = pair["difference"]
    if differences:
        plot_level_lines(axes[1], differences, levels, "#333333", "separated - mixture")
        axes[1].legend(fontsize=8)
    axes[1].axhline(0, color="grey", linewidth=0.8, linestyle="--")
    axes[1].set_xlabel("Accompaniment level relative to guitar [dB RMS]")
    axes[1].set_ylabel("Accuracy difference")
    axes[1].set_title("Paired difference: separated - mixture", loc="left", fontsize=10)
    counts = result["counts"]
    figure.suptitle(
        f"{title}: {counts['source_recordings']} source recordings, "
        f"{counts['artificial_mixture_conditions']} artificial mixture conditions, "
        f"material: {', '.join(counts['materials'])}",
        fontsize=10,
    )
    return figure
