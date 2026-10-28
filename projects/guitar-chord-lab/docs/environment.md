# 実行環境と検証した版

この作品は Google Colab を主な実行環境としています。依存ライブラリは `pyproject.toml` に定義し、作品フォルダだけでインストールできます。

## 依存ライブラリ

| 用途 | ライブラリ | 指定 |
| --- | --- | --- |
| 必須 | numpy、scipy、librosa、soundfile、matplotlib | `pip install -e .` |
| ギター分離（第2段階以降） | demucs（torch を使用） | `pip install -e ".[separation]"` |
| テスト・Notebookの自動実行 | pytest、mir_eval、nbformat、nbclient、ipykernel | `pip install -e ".[dev]"` |

- Python 3.12 以上を指定しています（`requires-python = ">=3.12"`）。確認したのは Python 3.13（全機能）と Python 3.12（分離を除く）です。
- Demucs を導入しなくても、単独音源のコード認識、合成デモ、評価、分離を使わない比較実験は動きます。
- torch は指定していません。Demucs 4.1.0 の依存として `torch>=2.1` が入ります。Colab では導入済みの torch がそのまま使われます。

## 互換性の確認に使った公式情報（2026年10月27日に確認）

| 対象 | 確認した内容 | 出典 |
| --- | --- | --- |
| Google Colab | Python 3.13.16、torch 2.11.0、librosa 0.11.0、numpy 2.1.3、scipy 1.16.3、soundfile 0.14.0、matplotlib 3.10.0、pandas 2.2.3 | [googlecolab/backend-info](https://github.com/googlecolab/backend-info)（`os-info.txt`、`pip-freeze.txt`、`pip-freeze.gpu.txt`） |
| PyTorch | Demucs 4.1.0 の要件は torch 2.1 以上。Colab の CPU ランタイムは torch 2.11.0+cpu、GPU ランタイムは torch 2.11.0+cu130。torch 2.11.0 の Python 3.13 用 CPU 版を公式の配布元（download.pytorch.org）から導入して確認 | [googlecolab/backend-info](https://github.com/googlecolab/backend-info)、[PyTorch の配布元](https://download.pytorch.org/whl/cpu/torch/)、Demucs の依存定義 |
| Demucs 4.1.0（2026年7月11日公開） | Python 3.10以上・torch 2.1以上。推論に torchaudio は不要。重みは Hugging Face Hub から取得し、失敗時は従来の配布元を使う。torch 2.6 以降の `weights_only` に対応 | [Demucs README](https://github.com/adefossez/demucs)、[リリースノート](https://github.com/adefossez/demucs/blob/main/docs/release.md)、PyPI の依存定義 |
| htdemucs_6s | drums、bass、other、vocals、guitar、piano の6音源を出力する。piano は品質が低いと記載。重みの利用条件は明確でない（非商用の可能性が高い）と記載 | Demucs README |
| librosa 1.0.0（2026年8月11日公開） | Python 3.12以上。使っている `chroma_cqt`、`chroma_stft`、`resample`、`frames_to_time`、`feature.rms` の使い方は 0.11 と同じ。audioread による読み込みは廃止 | [librosa の変更履歴](https://github.com/librosa/librosa/blob/main/docs/changelog.rst) |
| soundfile 0.14.0 | 同梱の libsndfile 1.2.2 で MP3 を読み書きできることを実際に確認 | 手元での実行 |

古い手順（torchaudio を前提とする Demucs 4.0.1 の使い方など）は使っていません。音声の読み込みには soundfile を、分離には Demucs の Python API（`demucs.api.Separator.separate_tensor`）を使います。

## 検証した環境

この作品の動作確認は、Linux のクラウド環境（x86_64、4 CPU、GPU なし）で行いました。**実際の Google Colab では実行していません。**

### A：Colab と同じ版にそろえた環境（主な確認）

| ライブラリ | 版 |
| --- | --- |
| Python | 3.13.17 |
| numpy | 2.1.3 |
| scipy | 1.16.3 |
| librosa | 0.11.0 |
| numba | 0.61.2 |
| soundfile | 0.14.0（libsndfile 1.2.2） |
| matplotlib | 3.10.0 |
| torch | 2.11.0+cpu |
| demucs | 4.1.0 |
| huggingface_hub | 2.3.0 |
| sphn | 0.2.1 |
| julius | 0.2.8 |
| pytest / mir_eval / nbclient | 9.1.1 / 0.8.2 / 0.11.0 |

### B：2026年10月時点の最新版の環境（分離なし）

| ライブラリ | 版 |
| --- | --- |
| Python | 3.13.17 |
| numpy | 2.5.4 |
| scipy | 1.18.1 |
| librosa | 1.0.0 |
| numba | 0.68.0 |
| soundfile | 0.14.0（libsndfile 1.2.2） |
| matplotlib | 3.11.2 |

### C：Python 3.12 の環境（分離なし）

Python 3.12.13 に、B と同じ版のライブラリ（numpy 2.5.4、scipy 1.18.1、librosa 1.0.0、soundfile 0.14.0、matplotlib 3.11.2）を入れて、自動テストだけを実行しました。

実施した確認の内容と結果は [verification.md](verification.md) にまとめています。

## 音声ファイルの形式

| 形式 | 読み込み | 備考 |
| --- | --- | --- |
| WAV、FLAC、OGG | できる | soundfile（libsndfile）で読み込みます |
| MP3 | できる | libsndfile 1.1 以降が必要です。soundfile 0.12.1 以降の配布物に含まれています |
| M4A、AAC など | できない | `ffmpeg -i 入力.m4a 出力.wav` で WAV に変換してください |

ffmpeg はこの作品の必須要件ではありません。保存する音声は WAV（32ビット浮動小数点）です。

## 保存先

| 内容 | 場所 |
| --- | --- |
| 解析結果・実験結果・分離結果のキャッシュ | 作品フォルダの `outputs/`（Gitの管理外） |
| 合成デモの音源と正解注釈 | `data/generated/demo/`（Gitの管理外。`guitar-chord-lab make-demo` で作り直せます） |
| GuitarSet から取り出した録音・注釈 | `data/raw/guitarset/`（Gitの管理外） |
| Demucs の重み | Hugging Face のキャッシュ（既定は `~/.cache/huggingface`）。予備の配布元から取得した場合は `~/.cache/torch` |
