"""コードの名前とテンプレート（12音のどれを鳴らすか）を扱います。

初版は12種類の根音それぞれのメジャー／マイナー、合わせて24種類のコードを扱います。
コード名は「根音:種類」の形で表します。例えば C:maj は Cメジャー、A:min は Aマイナーです。

- N は「コードなし」（無音の区間）を表します。
- X は「判定保留」（候補を決めきれない区間）を表します。正解注釈には使えません。
"""

import numpy as np

# 12音の名前。異名同音（D♭とC#など）はシャープ側の名前にそろえます。
PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# フラットやE#などの別名を、PITCH_NAMESの名前へ置き換える表
ROOT_ALIASES = {
    "Db": "C#",
    "Eb": "D#",
    "Gb": "F#",
    "Ab": "G#",
    "Bb": "A#",
    "Cb": "B",
    "Fb": "E",
    "E#": "F",
    "B#": "C",
}

# 根音から数えた構成音の位置（半音の数）
CHORD_INTERVALS = {
    "maj": [0, 4, 7],  # 根音・長3度・完全5度
    "min": [0, 3, 7],  # 根音・短3度・完全5度
}

NO_CHORD = "N"
UNDECIDED = "X"


def make_chord_labels():
    """24種類のコード名のリストを返します（C:maj … B:maj、C:min … B:min の順）。"""
    labels = []
    for quality in ["maj", "min"]:
        for root in PITCH_NAMES:
            labels.append(f"{root}:{quality}")
    return labels


CHORD_LABELS = make_chord_labels()


def chord_notes(label):
    """コード名から構成音の名前のリストを返します。例: "A:min" → ["A", "C", "E"]"""
    root, quality = label.split(":")
    root_index = PITCH_NAMES.index(root)
    notes = []
    for interval in CHORD_INTERVALS[quality]:
        notes.append(PITCH_NAMES[(root_index + interval) % 12])
    return notes


def make_chord_template(label):
    """1つのコードのテンプレート（構成音を1、それ以外を0にした12個の値）を返します。"""
    template = np.zeros(12)
    for note in chord_notes(label):
        template[PITCH_NAMES.index(note)] = 1.0
    return template


def make_chord_templates():
    """24種類のテンプレートを縦に並べた配列（24行×12列）を返します。"""
    rows = []
    for label in CHORD_LABELS:
        rows.append(make_chord_template(label))
    return np.array(rows)


def normalise_root(text):
    """根音の表記をPITCH_NAMESの名前にそろえます。対応しない表記ならNoneを返します。"""
    if text in PITCH_NAMES:
        return text
    return ROOT_ALIASES.get(text)


def normalise_chord_label(text):
    """コード表記を "C:maj" / "A:min" / "N" の形にそろえます。

    受け付ける例: "C", "C:maj", "Cmaj", "Am", "A:min", "Amin", "Bb", "Bbm", "N"
    対応外のコード（C:7、C:maj7、C/E、C:sus4 など）は ValueError にします。
    三和音やNへ勝手に置き換えないためです。
    """
    text = str(text).strip()
    if text == "":
        raise ValueError("コード名が空です")
    if text == NO_CHORD:
        return NO_CHORD
    if ":" in text:
        root_text, quality = text.split(":", 1)
    elif len(text) >= 2 and text[1] in "#b":
        root_text, quality = text[:2], text[2:]
    else:
        root_text, quality = text[:1], text[1:]
    quality_names = {"": "maj", "maj": "maj", "m": "min", "min": "min"}
    root = normalise_root(root_text)
    if root is None or quality not in quality_names:
        raise ValueError(
            f"対応外のコード '{text}' です。"
            "初版はメジャー／マイナーの24種類と N（コードなし）だけを扱います"
        )
    return f"{root}:{quality_names[quality]}"


def short_chord_name(label):
    """図や表に使う短い名前を返します。例: "C:maj" → "C"、"A:min" → "Am"、"X" → "?" """
    if label == NO_CHORD:
        return "N"
    if label == UNDECIDED:
        return "?"
    root, quality = label.split(":")
    if quality == "min":
        return root + "m"
    return root
