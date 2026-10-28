# Python ソース

`guitar_chord_lab` パッケージです。Notebook と CLI（`guitar-chord-lab` コマンド）は、ここにある同じ関数を呼び出します。

| モジュール | 役割 | 主な関数 |
| --- | --- | --- |
| `chords.py` | コード名、構成音、24種類のテンプレート | `make_chord_template`、`normalise_chord_label` |
| `audio.py` | 読み込み・切り出し・モノラル化・リサンプリング・保存 | `load_audio`、`prepare_for_analysis`、`save_audio` |
| `recognition.py` | クロマ特徴量、区間の平均、類似度、平滑化、判定、区間のまとめ | `ChordSettings`、`recognise_chords`、`analyse_file`、`decide_label` |
| `plots.py` | クロマグラムとコード推移の図、比較実験の図 | `plot_analysis`、`plot_comparison`、`plot_experiment_summary` |
| `results.py` | CSV・JSON の保存、ライブラリの版とコミットの記録、表示 | `save_analysis`、`print_segments`、`chroma_frame_lines` |
| `evaluation.py` | 正解注釈 CSV の検証と、重なり時間に基づく評価 | `read_annotation_csv`、`reference_for_clip`、`evaluate_segments` |
| `synth.py` | 合成デモ（ギター風の音、ドラム）と正解注釈の生成 | `write_demo_dataset` |
| `separation.py` | Demucs（htdemucs_6s）によるギター分離（必要なときだけ Demucs を読み込む） | `separate_guitar` |
| `experiment.py` | 混合、時間ずれの確認、元素材単位の分割、比較実験の実行と集計、聴き比べ用の音の読み込み | `load_experiment`、`run_experiment`、`mix_at_level`、`load_listening_clips` |
| `guitarset.py` | GuitarSet から必要な録音・注釈だけを取り出す | `prepare_track`、`prepare_guitarset_experiment` |
| `cli.py` | コマンドラインの入口 | `main` |

依存定義は作品フォルダの `pyproject.toml` にあります。Demucs を導入していなくても、`separation.py` 以外の機能は使えます。
