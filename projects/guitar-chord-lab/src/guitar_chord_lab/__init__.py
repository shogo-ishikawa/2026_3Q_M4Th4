"""Guitar Chord Lab: ギター音源から時刻付きのコード候補を推定する学習用パッケージです。

よく使う関数はこのパッケージから直接読み込めます。
    from guitar_chord_lab import ChordSettings, analyse_file

音源分離（Demucs）を使う関数は guitar_chord_lab.separation にあります。
Demucs を導入していなくても、このパッケージの読み込みと単独音源の解析はできます。
"""

__version__ = "0.1.0"

from .audio import AudioClip, load_audio, make_clip, save_audio
from .chords import CHORD_LABELS, NO_CHORD, UNDECIDED, make_chord_templates, short_chord_name
from .evaluation import crop_intervals, evaluate_segments, read_annotation_csv
from .recognition import ChordSettings, analyse_file, load_settings, recognise_chords
