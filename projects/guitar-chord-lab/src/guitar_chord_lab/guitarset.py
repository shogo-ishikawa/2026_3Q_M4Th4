"""GuitarSet（実際のギター録音と注釈のデータセット）から、必要な録音だけを取り出します。

GuitarSet: Q. Xi, R. Bittner, J. Pauwels, X. Ye, J. P. Bello,
"GuitarSet: A Dataset for Guitar Transcription", ISMIR 2018.
配布元: Zenodo https://zenodo.org/records/3371780 （ライセンス: CC BY 4.0）

配布ZIPは大きい（音源だけで約650 MB）ので、HTTPの Range 要求でZIPの中の必要なファイルだけを
読み出します。取り出した音源と注釈はGitに追加せず、data/raw/ 等に置いてください。

正解コードには、JAMS ファイルの「指示されたコード」（リードシートのコード、data_source が空の
chord 注釈）を使います。演奏から推定したコード（performed）は転回形や7th等を含むため使いません。
24種類とN以外のコードを含む録音は、置き換えずにエラーにします。
"""

import io
import json
import os
import shutil
import urllib.request
import zipfile
from pathlib import Path

import soundfile as sf

from .audio import make_clip, save_audio
from .chords import PITCH_NAMES, chord_notes, normalise_chord_label
from .evaluation import AnnotationError, ChordInterval, write_annotation_csv
from .synth import normalise_peak, synthesise_drums

ZENODO_RECORD = "https://zenodo.org/records/3371780"
AUDIO_ZIP = "audio_mono-mic.zip"  # マイク収録のモノラル音源（44.1 kHz）
ANNOTATION_ZIP = "annotation.zip"
LICENCE = "CC BY 4.0"
CITATION = (
    'Q. Xi, R. Bittner, J. Pauwels, X. Ye, J. P. Bello, "GuitarSet: A Dataset for Guitar '
    'Transcription", Proc. ISMIR 2018. https://zenodo.org/records/3371780'
)

# 例として使う伴奏（comp）録音。次の規則で、推定結果を見ずに注釈だけから選びました。
# - 奏者00は既定値の調整に使ったため除き、奏者01〜05に1つずつスタイルを割り当てる
#   （01: Rock、02: SS、03: BN、04: Funk、05: Jazz）
# - そのスタイルでマイナーコードを含む2曲のうち、録音IDの順で最初に
#   「3度の音が弾かれている時間の割合（third_played_ratio）が0.9以上」を満たすものを選ぶ
EXAMPLE_TRACKS = [
    "01_Rock3-117-Bb_comp",
    "02_SS3-98-C_comp",
    "03_BN3-119-G_comp",
    "04_Funk3-112-C#_comp",
    "05_Jazz3-137-Eb_comp",
]
MIN_THIRD_RATIO = 0.9  # これより小さい録音は、メジャー／マイナーの評価に向かない可能性が高い


def zip_url(name):
    """Zenodo 上のZIPファイルのURLを返します。"""
    return f"{ZENODO_RECORD}/files/{name}?download=1"


class HttpRangeFile(io.RawIOBase):
    """ネット上のファイルを、必要な部分だけ HTTP の Range 要求で読むためのファイルオブジェクトです。"""

    def __init__(self, url, timeout=60):
        self.url = url
        self.timeout = timeout
        self.position = 0
        self.size = self.fetch_size()

    def fetch_size(self):
        """ファイル全体の大きさ [バイト] を調べます。"""
        request = urllib.request.Request(self.url, headers={"Range": "bytes=0-0"})
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            content_range = response.headers.get("Content-Range", "")
            if response.status != 206 or "/" not in content_range:
                raise OSError(f"サーバーが部分的な取得（Range 要求）に対応していません: {self.url}")
        return int(content_range.split("/")[1])

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=io.SEEK_SET):
        if whence == io.SEEK_SET:
            self.position = offset
        elif whence == io.SEEK_CUR:
            self.position += offset
        else:
            self.position = self.size + offset
        return self.position

    def readinto(self, buffer):
        if self.position >= self.size:
            return 0
        last = min(self.position + len(buffer), self.size) - 1
        request = urllib.request.Request(self.url, headers={"Range": f"bytes={self.position}-{last}"})
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            if response.status != 206:
                raise OSError(f"部分的な取得ができませんでした（HTTP {response.status}）: {self.url}")
            data = response.read()
        buffer[: len(data)] = data
        self.position += len(data)
        return len(data)


def fetch_zip_member(zip_name, member, destination):
    """Zenodo 上のZIPから、member（ZIPの中のファイル名）だけを destination に保存します。"""
    destination = Path(destination)
    if destination.exists():
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    remote = io.BufferedReader(HttpRangeFile(zip_url(zip_name)), buffer_size=1024 * 1024)
    with zipfile.ZipFile(remote) as archive:
        with archive.open(member) as source, open(destination, "wb") as target:
            shutil.copyfileobj(source, target)
    return destination


def download_track(track_id, folder):
    """1つの録音の音源（WAV）と注釈（JAMS）を取り出し、(音源のパス, JAMSのパス) を返します。"""
    folder = Path(folder)
    audio = fetch_zip_member(AUDIO_ZIP, f"{track_id}_mic.wav", folder / f"{track_id}_mic.wav")
    jams = fetch_zip_member(ANNOTATION_ZIP, f"{track_id}.jams", folder / f"{track_id}.jams")
    return audio, jams


def read_instructed_chords(jams_path):
    """JAMS ファイルから、指示されたコード（リードシートのコード）を (開始, 終了, ラベル) で返します。"""
    with open(jams_path, encoding="utf-8") as file:
        data = json.load(file)
    chord_annotations = [item for item in data["annotations"] if item["namespace"] == "chord"]
    instructed = [item for item in chord_annotations if not item["annotation_metadata"].get("data_source")]
    if len(instructed) != 1:
        raise AnnotationError(f"{Path(jams_path).name}: 指示されたコードの注釈が見つかりません")
    return [(obs["time"], obs["time"] + obs["duration"], obs["value"]) for obs in instructed[0]["data"]]


def jams_to_intervals(jams_path, duration_s=None):
    """指示されたコードを ChordInterval のリストにします。対応外のコードがあればエラーにします。"""
    intervals = []
    unsupported = set()
    for start_s, end_s, label in read_instructed_chords(jams_path):
        if duration_s is not None:
            end_s = min(end_s, duration_s)  # 音源の最後を少し超える注釈は音源の長さで切る
            if end_s - start_s < 0.001:
                continue  # 切った結果、1ミリ秒未満になった区間は使わない
        try:
            intervals.append(ChordInterval(round(start_s, 6), round(end_s, 6), normalise_chord_label(label)))
        except ValueError:
            unsupported.add(label)
    if unsupported:
        raise AnnotationError(
            f"{Path(jams_path).name} は対応外のコード {sorted(unsupported)} を含みます。"
            "初版はメジャー／マイナーとNだけを扱うため、この録音は使えません"
        )
    return intervals


def read_played_notes(jams_path):
    """JAMS の音符注釈（6本の弦の note_midi）を (開始, 終了, 音名の番号0〜11) のリストで返します。"""
    with open(jams_path, encoding="utf-8") as file:
        data = json.load(file)
    notes = []
    for item in data["annotations"]:
        if item["namespace"] == "note_midi":
            for obs in item["data"]:
                notes.append((obs["time"], obs["time"] + obs["duration"], int(round(obs["value"])) % 12))
    return notes


def third_played_ratio(jams_path, min_overlap_s=0.05):
    """指示されたコードの区間のうち、そのコードの3度の音が実際に弾かれている時間の割合を返します。

    3度（Cメジャーなら E、Aマイナーなら C）が鳴っていないと、ギターの音だけからは
    メジャーとマイナーを区別できません。素材を選ぶ目安に使います（推定結果は使いません）。
    """
    notes = read_played_notes(jams_path)
    total_s = played_s = 0.0
    for start_s, end_s, label in read_instructed_chords(jams_path):
        third = PITCH_NAMES.index(chord_notes(normalise_chord_label(label))[1])
        total_s += end_s - start_s
        for note_start, note_end, pitch_class in notes:
            overlap = min(note_end, end_s) - max(note_start, start_s)
            if pitch_class == third and overlap > min_overlap_s:
                played_s += end_s - start_s
                break
    return played_s / total_s


def prepare_track(track_id, folder):
    """録音を取り出し、正解注釈CSVを作って (音源のパス, 注釈CSVのパス) を返します。"""
    audio_path, jams_path = download_track(track_id, folder)
    duration_s = sf.info(str(audio_path)).duration
    annotation_path = jams_to_annotation_csv(jams_path, Path(folder) / f"{track_id}_annotation.csv", duration_s)
    return audio_path, annotation_path


def jams_to_annotation_csv(jams_path, csv_path, duration_s=None):
    """JAMS の指示されたコードを、この作品の正解注釈CSV（start_s, end_s, chord）に変換します。"""
    return write_annotation_csv(csv_path, jams_to_intervals(jams_path, duration_s))


def player_of(track_id):
    """録音IDの先頭2桁（奏者番号）を返します。例: "01_Rock1-90-C#_comp" → "01" """
    return track_id.split("_", 1)[0]


def toml_value(value):
    """Pythonの値を、TOMLファイルに書く文字列にします（文字列・数・真偽値・リストのみ）。"""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(toml_value(item) for item in value) + "]"
    return json.dumps(str(value), ensure_ascii=False)


def relative_to(path, folder):
    """folder から見た path の相対パスを、/ 区切りで返します。"""
    return Path(os.path.relpath(Path(path).resolve(), Path(folder).resolve())).as_posix()


def prepare_guitarset_experiment(
    track_ids, data_dir, config_path, duration_s=20.0, levels_db=(0.0, 6.0, 12.0),
    tuning_players=("00",), seed=0, conditions=("solo", "mixture", "separated"),
    output_dir="outputs/experiment_guitarset", cache_dir="outputs/cache/separation",
):
    """GuitarSet の録音を取り出し、正解注釈CSV・ドラム伴奏・実験設定TOMLを作ります。

    奏者が tuning_players に含まれる録音は調整用、それ以外は評価用にします（元素材単位の分割）。
    伴奏は合成ドラムです（実際の合奏録音ではありません）。作成した設定ファイルのパスを返します。
    """
    data_dir = Path(data_dir)
    config_path = Path(config_path)
    config_dir = config_path.parent
    config_dir.mkdir(parents=True, exist_ok=True)
    recordings = []
    longest_s = 0.0
    for track_id in track_ids:
        audio_path, annotation_path = prepare_track(track_id, data_dir)
        ratio = third_played_ratio(data_dir / f"{track_id}.jams")
        if ratio < MIN_THIRD_RATIO:
            print(f"注意: {track_id} は3度の音が弾かれている時間が {ratio:.0%} しかありません（メジャー／マイナーの評価に不向き）")
        total_s = sf.info(str(audio_path)).duration
        clip_s = total_s if duration_s is None else min(duration_s, total_s)
        longest_s = max(longest_s, clip_s)
        recordings.append({
            "id": track_id,
            "source_id": track_id,
            "split": "tuning" if player_of(track_id) in tuning_players else "evaluation",
            "material": "real",
            "guitar": relative_to(audio_path, config_dir),
            "annotation": relative_to(annotation_path, config_dir),
            "start_s": 0.0,
            "duration_s": round(clip_s, 3),
            "third_played_ratio": round(ratio, 3),
        })
    drums_id = f"synth_drums_120bpm_seed{seed}"
    drums = normalise_peak(synthesise_drums(longest_s + 1.0, 44100, 120, seed), 0.5)
    drums_path = save_audio(data_dir / f"{drums_id}.wav", make_clip(drums, 44100))
    lines = [
        "# GuitarSet の実ギター録音に合成ドラムを混ぜる比較実験（prepare_guitarset_experiment で作成）",
        f"# 出典: {CITATION}（{LICENCE}）",
        "# 相対パスはこの設定ファイルのあるフォルダが基準です。",
        "",
        "[experiment]",
        f"name = {toml_value('guitarset_synth_drums')}",
        f"output_dir = {toml_value(relative_to(output_dir, config_dir))}",
        f"seed = {seed}",
        f"conditions = {toml_value(list(conditions))}",
        f"accompaniment_db = {toml_value([float(level) for level in levels_db])}",
        "mix_sample_rate = 44100",
        "peak_limit = 0.99",
        "save_audio = true",
        "save_figures = false",
        "",
        "[separation]",
        'model = "htdemucs_6s"',
        'device = "auto"',
        "shifts = 0",
        "overlap = 0.25",
        f"cache_dir = {toml_value(relative_to(cache_dir, config_dir))}",
        "",
        "[analysis]",
        "",
    ]
    for item in recordings:
        lines.append("[[recordings]]")
        lines += [f"{key} = {toml_value(value)}" for key, value in item.items()]
        lines.append("")
    lines += [
        "[[accompaniments]]",
        f"id = {toml_value(drums_id)}",
        f"path = {toml_value(relative_to(drums_path, config_dir))}",
        'material = "synthetic"',
        "offset_s = 0.0",
        "",
    ]
    config_path.write_text("\n".join(lines), encoding="utf-8")
    return config_path
