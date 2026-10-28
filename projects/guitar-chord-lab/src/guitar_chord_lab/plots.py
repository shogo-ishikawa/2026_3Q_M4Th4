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


def figure_text(text):
    """図に書く文字列を返します。既定のフォントには日本語がないため、ASCII 以外の文字は ? にします。

    ファイル名や設定の名前が日本語でも、文字化け（□）や警告が出ないようにするためです。
    """
    return str(text).encode("ascii", "replace").decode("ascii")


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
    figure.suptitle((figure_text(title) + "\n" if title else "") + settings_summary(analysis.settings), fontsize=9)
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
    labels = [figure_text(name) for name in names]
    if reference is not None:
        draw_timeline_row(ax, len(names), reference, lambda _: REFERENCE_COLOUR, lambda item: short_chord_name(item.chord))
        labels.append("reference")
    ax.set_yticks(range(len(labels)))
    ax.set_yticklabels(labels)
    ax.set_ylim(-0.6, len(labels) - 0.4)
    ax.set_xlabel("Time in clip [s]")
    first = analyses[names[0]]
    ax.set_xlim(0, first.clip.duration_s)
    ax.set_title((figure_text(title) + "\n" if title else "") + settings_summary(first.settings), fontsize=9)
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
LINE_STYLES = ["-", "--", ":", "-."]  # 伴奏・素材の組ごとに線の種類を変えます


def artificial_groups(rows):
    """人工混合の結果に含まれる (素材の種類, 伴奏ID) の組を、並べたリストで返します。"""
    return sorted({(row["material"], row["accompaniment_id"]) for row in rows if row["mixture_type"] == "artificial"})


def values_by_recording(rows, key, material, accompaniment_id, condition=None):
    """1つの組（素材・伴奏）の値を {録音ID: {伴奏の音量: 値}} の形にまとめます。"""
    table = {}
    for row in rows:
        if row["mixture_type"] != "artificial" or row["material"] != material:
            continue
        if row["accompaniment_id"] != accompaniment_id or (condition and row["condition"] != condition):
            continue
        table.setdefault(row["recording_id"], {})[row["accompaniment_db"]] = row[key]
    return table


def mean_values(summary, key, levels, material, accompaniment_id, condition=None):
    """集計表（元素材ごとの平均から計算した値）から、伴奏の音量の順に平均を取り出します。"""
    values = {}
    for line in summary:
        if line["mixture_type"] != "artificial" or line["material"] != material:
            continue
        if line["accompaniment_id"] != accompaniment_id or (condition and line["condition"] != condition):
            continue
        values[line["accompaniment_db"]] = line[key]
    return [values.get(level, np.nan) for level in levels]


def plot_thin_lines(ax, table, levels, colour, style):
    """録音ごとの値を細い線で描きます。"""
    for values in table.values():
        ax.plot(levels, [values.get(level, np.nan) for level in levels], color=colour, linestyle=style,
                alpha=0.3, linewidth=0.8)


def plot_processing_times(ax, rows):
    """コード認識（条件ごと）と分離の、1回あたりの平均の処理時間を棒グラフで描きます。"""
    labels, values = [], []
    for condition in ["solo", "mixture", "separated"]:
        times = [row["analysis_s"] for row in rows if row["condition"] == condition]
        if times:
            labels.append(f"recognition\n({condition})")
            values.append(float(np.mean(times)))
    separation = [row for row in rows if row.get("separation_s", "") != ""]
    if separation:
        devices = sorted({str(row.get("separation_device", "")) for row in separation})
        labels.append(f"separation\n({', '.join(devices)})")
        values.append(float(np.mean([row["separation_s"] for row in separation])))
    ax.bar(range(len(values)), values, color="#888888")
    for index, value in enumerate(values):
        ax.text(index, value, f"{value:.2f}", ha="center", va="bottom", fontsize=8)
    ax.set_xticks(range(len(values)))
    ax.set_xticklabels(labels, fontsize=8)
    ax.set_ylabel("Mean time per run [s]")
    ax.set_title("Processing time", loc="left", fontsize=10)
    if separation:
        ax.set_xlabel("Cached separations show the time of the first run", fontsize=7)


def plot_artificial_results(axes, result, levels):
    """人工混合の結果を、伴奏の音量ごとに描きます（左: 条件別の正解率、右: 分離後−分離前の差）。

    伴奏や素材の種類（合成音・実録音）が違う結果は、線の種類を変えて別々に描きます。
    太線は集計表（summary_by_condition.csv など）と同じ、元素材ごとの平均から計算した平均です。
    """
    rows = result["rows"]
    groups = artificial_groups(rows)
    materials = sorted({material for material, _ in groups})
    for index, material in enumerate(materials):
        solo = [line["accuracy_mean"] for line in result["summary"]
                if line["condition"] == "solo" and line["material"] == material]
        if solo:
            axes[0].axhline(solo[0], color=CONDITION_COLOURS["solo"], linewidth=2.2,
                            linestyle=LINE_STYLES[index % len(LINE_STYLES)],
                            label=figure_text(f"solo guitar ({material})"))
    for index, (material, accompaniment_id) in enumerate(groups):
        style = LINE_STYLES[index % len(LINE_STYLES)]
        tag = figure_text(f"{accompaniment_id}, {material}")
        for condition in ["mixture", "separated"]:
            table = values_by_recording(rows, "accuracy", material, accompaniment_id, condition)
            if not table:
                continue
            plot_thin_lines(axes[0], table, levels, CONDITION_COLOURS[condition], style)
            means = mean_values(result["summary"], "accuracy_mean", levels, material, accompaniment_id, condition)
            axes[0].plot(levels, means, color=CONDITION_COLOURS[condition], linestyle=style, linewidth=2.2,
                         marker="o", label=f"{condition} ({tag})")
        table = values_by_recording(result["pairs"], "difference", material, accompaniment_id)
        if table:
            plot_thin_lines(axes[1], table, levels, "#333333", style)
            means = mean_values(result["difference_summary"], "difference_mean", levels, material, accompaniment_id)
            axes[1].plot(levels, means, color="#333333", linestyle=style, linewidth=2.2, marker="o",
                         label=f"separated - mixture ({tag})")
    axes[0].set_ylim(0, 1.02)
    axes[0].set_xlabel("Accompaniment level relative to guitar [dB RMS]")
    axes[0].set_ylabel("Accuracy (correct time / evaluated time)")
    axes[0].set_title("Accuracy by condition (thick: mean over sources, thin: recordings)", loc="left", fontsize=10)
    axes[0].legend(fontsize=7)
    axes[1].axhline(0, color="grey", linewidth=0.8, linestyle="--")
    axes[1].set_xlabel("Accompaniment level relative to guitar [dB RMS]")
    axes[1].set_ylabel("Accuracy difference")
    axes[1].set_title("Paired difference: separated - mixture", loc="left", fontsize=10)
    if result["pairs"]:
        axes[1].legend(fontsize=7)


def plot_recorded_results(axes, result):
    """実際の合奏録音（recorded）の結果を描きます（左: 録音ごとの正解率、右: 録音ごとの分離後−分離前の差）。"""
    rows = result["rows"]
    conditions = ["solo", "mixture", "separated"]
    recorded = sorted({row["recording_id"] for row in rows if row["mixture_type"] == "recorded"})
    for recording_id in recorded:
        values = {row["condition"]: row["accuracy"] for row in rows
                  if row["recording_id"] == recording_id and row["mixture_type"] in ("recorded", "none")}
        axes[0].plot(range(len(conditions)), [values.get(name, np.nan) for name in conditions],
                     color="#888888", marker="o", linewidth=0.8)
    axes[0].set_xticks(range(len(conditions)))
    axes[0].set_xticklabels(conditions)
    axes[0].set_ylim(0, 1.02)
    axes[0].set_ylabel("Accuracy (correct time / evaluated time)")
    axes[0].set_title("Recorded mixtures: accuracy per recording", loc="left", fontsize=10)
    pairs = [pair for pair in result["pairs"] if pair["mixture_type"] == "recorded"]
    axes[1].bar(range(len(pairs)), [pair["difference"] for pair in pairs], color="#333333")
    axes[1].set_xticks(range(len(pairs)))
    axes[1].set_xticklabels([figure_text(pair["recording_id"]) for pair in pairs], rotation=30, ha="right", fontsize=7)
    axes[1].axhline(0, color="grey", linewidth=0.8, linestyle="--")
    axes[1].set_ylabel("Accuracy difference")
    axes[1].set_title("Recorded mixtures: separated - mixture", loc="left", fontsize=10)


def plot_experiment_summary(result, title="", settings=None):
    """比較実験の結果（条件別の正解率、分離後−分離前の差、処理時間）を1枚の図にまとめます。

    人工混合の結果があれば伴奏の音量ごとに、なければ実際の合奏録音の結果を録音ごとに描きます。
    settings（ChordSettings）を渡すと、解析条件を題名に入れます。
    """
    rows = result["rows"]
    levels = sorted({row["accompaniment_db"] for row in rows if row["mixture_type"] == "artificial"})
    has_recorded = any(row["mixture_type"] == "recorded" for row in rows)
    figure, axes = plt.subplots(1, 3, figsize=(15, 4.6), width_ratios=[2, 2, 1.2], layout="constrained")
    plot_processing_times(axes[2], rows)
    if levels:
        plot_artificial_results(axes, result, levels)
    elif has_recorded:
        plot_recorded_results(axes, result)
    else:
        for ax in axes[:2]:
            ax.text(0.5, 0.5, "No mixtures (see items.csv)", ha="center", va="center")
    counts = result["counts"]
    parts = [f"{counts['source_recordings']} source recordings"]
    if counts["artificial_mixture_conditions"]:
        parts.append(f"{counts['artificial_mixture_conditions']} artificial mixture conditions")
    if counts["recorded_mixtures"]:
        note = " (not drawn here; see the CSV files)" if levels else ""
        parts.append(f"{counts['recorded_mixtures']} recorded mixtures{note}")
    parts.append(f"material: {', '.join(counts['materials'])}")
    text = f"{title}: " + ", ".join(parts)
    if settings is not None:
        text += "\n" + settings_summary(settings)
    figure.suptitle(figure_text(text), fontsize=10)
    return figure
    groups = artificial_groups(rows)
    materials = sorted({material for material, _ in groups})
    for index, material in enumerate(materials):
        solo = [line["accuracy_mean"] for line in result["summary"]
                if line["condition"] == "solo" and line["material"] == material]
        if solo:
            axes[0].axhline(solo[0], color=CONDITION_COLOURS["solo"], linewidth=2.2,
                            linestyle=LINE_STYLES[index % len(LINE_STYLES)],
                            label=figure_text(f"solo guitar ({material})"))
    for index, (material, accompaniment_id) in enumerate(groups):
        style = LINE_STYLES[index % len(LINE_STYLES)]
        tag = figure_text(f"{accompaniment_id}, {material}")
        for condition in ["mixture", "separated"]:
            table = values_by_recording(rows, "accuracy", material, accompaniment_id, condition)
            if not table:
                continue
            plot_thin_lines(axes[0], table, levels, CONDITION_COLOURS[condition], style)
            means = mean_values(result["summary"], "accuracy_mean", levels, material, accompaniment_id, condition)
            axes[0].plot(levels, means, color=CONDITION_COLOURS[condition], linestyle=style, linewidth=2.2,
                         marker="o", label=f"{condition} ({tag})")
        table = values_by_recording(result["pairs"], "difference", material, accompaniment_id)
        if table:
            plot_thin_lines(axes[1], table, levels, "#333333", style)
            means = mean_values(result["difference_summary"], "difference_mean", levels, material, accompaniment_id)
            axes[1].plot(levels, means, color="#333333", linestyle=style, linewidth=2.2, marker="o",
                         label=f"separated - mixture ({tag})")
    axes[0].set_ylim(0, 1.02)
    axes[0].set_xlabel("Accompaniment level relative to guitar [dB RMS]")
    axes[0].set_ylabel("Accuracy (correct time / evaluated time)")
    axes[0].set_title("Accuracy by condition (thick: mean over sources, thin: recordings)", loc="left", fontsize=10)
    axes[0].legend(fontsize=7)
    axes[1].axhline(0, color="grey", linewidth=0.8, linestyle="--")
    axes[1].set_xlabel("Accompaniment level relative to guitar [dB RMS]")
    axes[1].set_ylabel("Accuracy difference")
    axes[1].set_title("Paired difference: separated - mixture", loc="left", fontsize=10)
    if result["pairs"]:
        axes[1].legend(fontsize=7)
    counts = result["counts"]
    figure.suptitle(
        figure_text(
            f"{title}: {counts['source_recordings']} source recordings, "
            f"{counts['artificial_mixture_conditions']} artificial mixture conditions, "
            f"material: {', '.join(counts['materials'])}"
        ),
        fontsize=10,
    )
    return figure
