"""クロマ特徴量とコードのテンプレートを比べて、時刻付きのコード候補を推定します。

処理の流れ（recognise_chords 関数）:
1. 音声をモノラルにして、解析用のサンプリング周波数に変換する
2. クロマ特徴量（12音それぞれの強さ）を短い時間ごとに計算する
3. segment_seconds 秒ごとの区間に分け、区間内のクロマを平均する
4. 区間ごとに24種類のテンプレートとの類似度を計算する（必要なら前後の区間と平均する）
5. 無音なら N、候補を決めきれなければ判定保留（X）、それ以外は第1候補を選ぶ
6. 同じ判定が続く区間を1つにまとめる

正解のコードや区間の境界は、この処理には一切渡しません。
"""

import tomllib
import warnings
from dataclasses import asdict, dataclass, field, fields

import librosa
import numpy as np

from .audio import AudioClip, describe_clip, load_audio, prepare_for_analysis, rms_db
from .chords import CHORD_LABELS, NO_CHORD, UNDECIDED, make_chord_templates

# 解析できる最短の長さ [秒]。これより短いとクロマ特徴量の低音域が正しく計算できません。
MIN_DURATION_S = 2.0

# CQTクロマで調べる音域（C2から6オクターブ = C2〜B7）。ギターの最低音E2を含みます。
CQT_LOWEST_NOTE = "C2"
CQT_OCTAVES = 6

# STFTクロマで使う分析窓の長さ [サンプル]
STFT_WINDOW = 4096

STATUS_CHORD = "chord"  # コードを判定した
STATUS_NO_CHORD = "no_chord"  # 無音なので N（コードなし）
STATUS_UNDECIDED = "undecided"  # 判定保留（候補を決めきれない）


@dataclass
class ChordSettings:
    """コード認識の設定です。値を変えて結果を比べてみましょう。"""

    sample_rate: int = 22050  # 解析に使うサンプリング周波数 [Hz]
    hop_length: int = 512  # クロマ特徴量を計算する間隔 [サンプル]
    chroma_method: str = "cqt"  # クロマ特徴量の計算方法: "cqt" または "stft"
    segment_seconds: float = 0.5  # 特徴量をまとめる時間幅 [秒]
    silence_db: float = -50.0  # 区間のRMSがこの値 [dBFS] 未満なら N（コードなし）
    min_score: float = 0.5  # 第1候補の類似度がこの値未満なら判定保留
    min_margin: float = 0.01  # 第1候補と第2候補の類似度の差がこの値未満なら判定保留
    smoothing_segments: int = 3  # 類似度を平均する区間の数（奇数。1なら平滑化しない）


def check_settings(settings):
    """設定値の範囲を確認し、問題があれば理由を示して ValueError にします。"""
    problems = []
    if settings.sample_rate < 8000:
        problems.append("sample_rate は8000 Hz以上にしてください")
    if settings.hop_length <= 0:
        problems.append("hop_length は1以上にしてください")
    if settings.chroma_method not in ["cqt", "stft"]:
        problems.append('chroma_method は "cqt" か "stft" にしてください')
    hop_seconds = settings.hop_length / max(settings.sample_rate, 1)
    if settings.segment_seconds < 2 * hop_seconds:
        problems.append(
            f"segment_seconds は {2 * hop_seconds:.3f} 秒（hop_length の2倍）以上にしてください"
        )
    if not 0 <= settings.min_score <= 1:
        problems.append("min_score は0〜1の範囲にしてください")
    if not 0 <= settings.min_margin <= 1:
        problems.append("min_margin は0〜1の範囲にしてください")
    if settings.smoothing_segments < 1 or settings.smoothing_segments % 2 == 0:
        problems.append("smoothing_segments は1以上の奇数にしてください")
    if problems:
        raise ValueError("設定に問題があります: " + "; ".join(problems))


def load_settings(path):
    """TOMLファイルの [analysis] 表から ChordSettings を読み込みます。"""
    with open(path, "rb") as file:
        data = tomllib.load(file)
    return settings_from_dict(data.get("analysis", {}))


def settings_from_dict(values):
    """辞書から ChordSettings を作ります。知らない名前があればエラーにします。"""
    known = [item.name for item in fields(ChordSettings)]
    unknown = [name for name in values if name not in known]
    if unknown:
        raise ValueError(f"設定に知らない項目があります: {unknown}。使える項目: {known}")
    settings = ChordSettings(**values)
    check_settings(settings)
    return settings


@dataclass
class ChordSegment:
    """同じ判定が続いた1つの時間区間です。時刻は解析した音声の先頭を0秒とします。"""

    start_s: float
    end_s: float
    status: str  # "chord"（判定）/ "no_chord"（N）/ "undecided"（判定保留）
    chord: str  # 判定結果。no_chord なら "N"、undecided なら "X"
    candidate_1: str  # 類似度が最も高いコード（無音区間では空文字）
    score_1: float  # 第1候補の類似度（0〜1。正解する確率ではありません）
    candidate_2: str  # 類似度が2番目に高いコード
    score_2: float  # 第2候補の類似度
    rms_db: float  # 区間の音量 [dBFS]

    @property
    def margin(self):
        """第1候補と第2候補の類似度の差"""
        return self.score_1 - self.score_2


@dataclass
class ChordAnalysis:
    """コード認識の途中経過と結果をまとめたものです。"""

    settings: ChordSettings
    input_info: dict  # 入力音声の情報（元ファイル、切り出し位置、長さなど）
    clip: AudioClip  # 解析に使ったモノラル音声
    chroma: np.ndarray  # クロマ特徴量（12行×フレーム数）
    frame_times: np.ndarray  # 各フレームの中心時刻 [秒]
    segment_edges: list  # 区間の (開始, 終了) [秒] のリスト
    segment_chroma: np.ndarray  # 区間ごとに平均したクロマ（区間数×12）
    segment_rms_db: np.ndarray  # 区間ごとの音量 [dBFS]
    scores: np.ndarray  # 区間ごとの24コードとの類似度（区間数×24、平滑化後）
    segment_labels: list  # 区間ごとの判定（コード名、"N"、"X"）
    segments: list  # 同じ判定をまとめた ChordSegment のリスト
    messages: list = field(default_factory=list)  # 注意事項


def compute_chroma(samples, sample_rate, settings):
    """クロマ特徴量（12行×フレーム数）と、各フレームの中心時刻 [秒] を返します。"""
    tuning = None  # None ならチューニングのずれ（A=440Hzからのずれ）を音から推定します
    if rms_db(samples) < settings.silence_db:
        tuning = 0.0  # 全体が無音に近いと、ずれを推定できないため0とします
    if settings.chroma_method == "cqt":
        chroma = librosa.feature.chroma_cqt(
            y=samples,
            sr=sample_rate,
            hop_length=settings.hop_length,
            fmin=librosa.note_to_hz(CQT_LOWEST_NOTE),
            n_octaves=CQT_OCTAVES,
            norm=None,
            tuning=tuning,
        )
    else:
        chroma = librosa.feature.chroma_stft(
            y=samples,
            sr=sample_rate,
            hop_length=settings.hop_length,
            n_fft=STFT_WINDOW,
            norm=None,
            tuning=tuning,
        )
    frame_times = librosa.frames_to_time(
        np.arange(chroma.shape[1]), sr=sample_rate, hop_length=settings.hop_length
    )
    return chroma, frame_times


def make_segment_edges(duration_s, segment_seconds):
    """解析区間の (開始, 終了) のリストを作ります。

    最後に残った端数が区間幅の半分未満なら、1つ前の区間に含めます。
    """
    count = int(np.floor(duration_s / segment_seconds + 1e-9))
    edges = []
    for index in range(count):
        edges.append((round(index * segment_seconds, 6), round((index + 1) * segment_seconds, 6)))
    rest_start = round(count * segment_seconds, 6)
    if duration_s - rest_start > 1e-6:
        if not edges or duration_s - rest_start >= segment_seconds / 2:
            edges.append((rest_start, duration_s))
        else:
            edges[-1] = (edges[-1][0], duration_s)
    else:
        edges[-1] = (edges[-1][0], duration_s)
    return edges


def average_chroma_in_segments(chroma, frame_times, edges):
    """各区間に中心時刻が入るフレームのクロマを平均します（区間数×12）。"""
    result = np.zeros((len(edges), 12))
    for index, (start, end) in enumerate(edges):
        in_segment = (frame_times >= start) & (frame_times < end)
        if index == len(edges) - 1:
            in_segment = in_segment | (frame_times >= end)  # 最後の端のフレームも含める
        if np.any(in_segment):
            result[index] = chroma[:, in_segment].mean(axis=1)
    return result


def segment_loudness_db(samples, sample_rate, edges):
    """区間ごとの音量（RMS [dBFS]）を返します。"""
    values = []
    for start, end in edges:
        first = int(round(start * sample_rate))
        last = max(int(round(end * sample_rate)), first + 1)
        values.append(rms_db(samples[first:last]))
    return np.array(values)


def cosine_similarity(vector_a, vector_b):
    """2つのベクトルの向きの近さ（コサイン類似度）。クロマとテンプレートでは0〜1になります。"""
    length = np.linalg.norm(vector_a) * np.linalg.norm(vector_b)
    if length == 0:
        return 0.0
    return float(np.dot(vector_a, vector_b) / length)


def similarity_scores(segment_chroma, templates):
    """各区間のクロマと各テンプレートの類似度を並べた表（区間数×24）を作ります。"""
    scores = np.zeros((len(segment_chroma), len(templates)))
    for row, chroma_vector in enumerate(segment_chroma):
        for column, template in enumerate(templates):
            scores[row, column] = cosine_similarity(chroma_vector, template)
    return scores


def smooth_scores(scores, is_silent, window):
    """前後 window 個の区間の類似度を平均します。無音の区間は平均に使いません。"""
    if window <= 1:
        return scores.copy()
    half = window // 2
    smoothed = np.zeros_like(scores)
    for index in range(len(scores)):
        first = max(0, index - half)
        last = min(len(scores), index + half + 1)
        neighbours = [j for j in range(first, last) if not is_silent[j]]
        if neighbours:
            smoothed[index] = scores[neighbours].mean(axis=0)
    return smoothed


def choose_top_two(score_row):
    """類似度が高い順に (第1候補, 類似度, 第2候補, 類似度) を返します。"""
    order = np.argsort(-score_row, kind="stable")  # 同点ならコード名の並び順で選ぶ
    first, second = order[0], order[1]
    return CHORD_LABELS[first], float(score_row[first]), CHORD_LABELS[second], float(score_row[second])


def decide_label(segment_db, score_1, score_2, candidate_1, settings):
    """1つの区間の判定結果を、コード名・"N"（コードなし）・"X"（判定保留）から選びます。"""
    if segment_db < settings.silence_db:
        return NO_CHORD
    if score_1 < settings.min_score:
        return UNDECIDED
    if score_1 - score_2 < settings.min_margin:
        return UNDECIDED
    return candidate_1


def status_of_label(label):
    """判定結果のラベルから判定状態の名前を返します。"""
    if label == NO_CHORD:
        return STATUS_NO_CHORD
    if label == UNDECIDED:
        return STATUS_UNDECIDED
    return STATUS_CHORD


def make_merged_segment(first, stop, labels, edges, scores, clip):
    """区間 first〜stop-1 を1つにまとめた ChordSegment を作ります。"""
    start_s = edges[first][0]
    end_s = edges[stop - 1][1]
    label = labels[first]
    sample_first = int(round(start_s * clip.sample_rate))
    sample_last = max(int(round(end_s * clip.sample_rate)), sample_first + 1)
    loudness = rms_db(clip.samples[0, sample_first:sample_last])
    if label == NO_CHORD:
        return ChordSegment(start_s, end_s, STATUS_NO_CHORD, NO_CHORD, "", np.nan, "", np.nan, loudness)
    mean_scores = scores[first:stop].mean(axis=0)
    candidate_1, score_1, candidate_2, score_2 = choose_top_two(mean_scores)
    return ChordSegment(
        start_s, end_s, status_of_label(label), label, candidate_1, score_1, candidate_2, score_2, loudness
    )


def merge_segments(labels, edges, scores, clip):
    """同じ判定が続く区間を1つにまとめ、ChordSegment のリストを返します。"""
    merged = []
    first = 0
    for index in range(1, len(labels) + 1):
        if index == len(labels) or labels[index] != labels[first]:
            merged.append(make_merged_segment(first, index, labels, edges, scores, clip))
            first = index
    return merged


def check_duration(clip, settings):
    """解析できる長さかどうかを確認します。"""
    shortest = max(MIN_DURATION_S, settings.segment_seconds)
    if clip.duration_s < shortest:
        raise ValueError(
            f"音源が短すぎます（{clip.duration_s:.2f}秒）。{shortest}秒以上の音源を使うか、"
            "切り出す長さを伸ばしてください"
        )


def recognise_chords(clip, settings=None):
    """AudioClip からコード候補を推定し、ChordAnalysis を返します。"""
    if settings is None:
        settings = ChordSettings()
    check_settings(settings)
    check_duration(clip, settings)
    input_info = describe_clip(clip)
    mono = prepare_for_analysis(clip, settings.sample_rate)
    samples = mono.samples[0]

    chroma, frame_times = compute_chroma(samples, settings.sample_rate, settings)
    edges = make_segment_edges(mono.duration_s, settings.segment_seconds)
    segment_chroma = average_chroma_in_segments(chroma, frame_times, edges)
    loudness = segment_loudness_db(samples, settings.sample_rate, edges)
    is_silent = loudness < settings.silence_db

    raw_scores = similarity_scores(segment_chroma, make_chord_templates())
    scores = smooth_scores(raw_scores, is_silent, settings.smoothing_segments)

    labels = []
    for index in range(len(edges)):
        candidate_1, score_1, _, score_2 = choose_top_two(scores[index])
        labels.append(decide_label(loudness[index], score_1, score_2, candidate_1, settings))
    segments = merge_segments(labels, edges, scores, mono)

    messages = []
    if np.all(is_silent):
        messages.append(
            f"入力全体の音量が無音しきい値（{settings.silence_db} dBFS）未満のため、すべて N になりました。"
            "ファイルや切り出し位置、silence_db を確認してください"
        )
    if input_info["peak"] >= 0.999:
        messages.append("振幅が1.0に達している箇所があり、音が割れている（クリッピング）可能性があります")
    for message in messages:
        warnings.warn(message)

    return ChordAnalysis(
        settings, input_info, mono, chroma, frame_times, edges, segment_chroma,
        loudness, scores, labels, segments, messages,
    )


def analyse_file(path, start_s=0.0, duration_s=None, settings=None):
    """音声ファイルの一部を読み込み、コード候補を推定します。"""
    clip = load_audio(path, start_s, duration_s)
    return recognise_chords(clip, settings)


def settings_to_dict(settings):
    """ChordSettings を保存用の辞書にします。"""
    return asdict(settings)


def segment_rows(analysis):
    """まとめた区間を、CSVや表示に使う辞書のリストにします。"""
    offset = analysis.clip.offset_s
    rows = []
    for segment in analysis.segments:
        rows.append({
            "start_s": round(segment.start_s, 3),
            "end_s": round(segment.end_s, 3),
            "source_start_s": round(segment.start_s + offset, 3),
            "source_end_s": round(segment.end_s + offset, 3),
            "status": segment.status,
            "chord": segment.chord,
            "candidate_1": segment.candidate_1,
            "score_1": round(segment.score_1, 4),
            "candidate_2": segment.candidate_2,
            "score_2": round(segment.score_2, 4),
            "margin": round(segment.margin, 4),
            "rms_db": round(segment.rms_db, 2),
        })
    return rows
