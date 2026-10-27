# Guitar Chord Lab

ギターの音源から、**時刻付きのコード候補**を表示する Python 学習プロジェクトです。混合音（ギターと伴奏）からギターを分離してから推定する経路と、分離の前後や単独ギターを比べる小規模な実験の道具を含みます。

推定の対象は「ギターが演奏しているコード」です。曲全体の和声とは区別します。推定は誤ることがあるため、結果を聴いて確かめながら使う**耳コピ支援ツール**として作っています。

## 現在の状態（v0.1.0）

初版を実装し、Colab と同じ版にそろえたローカル環境で確認しました。**実際の Google Colab と GPU では未確認**です。確認の内容と結果は [docs/verification.md](docs/verification.md) にあります。

| 機能 | 状態 |
| --- | --- |
| 単独ギター音源のコード認識（librosa のクロマ特徴量と、メジャー／マイナー24種類のテンプレート） | 実装・確認済み |
| N（コードなし＝無音）と判定保留の区別、第1・第2候補と類似度の表示 | 実装・確認済み |
| クロマグラムとコード推移の図、CSV・JSON・PNG/PDF の保存 | 実装・確認済み |
| 合成デモ（ギター風の和音とドラム）と、既知の正解注釈の生成 | 実装・確認済み |
| Demucs（htdemucs_6s）によるギター分離（CPU／CUDA、結果のキャッシュ、エラーの説明） | 実装済み。CPU で実分離まで確認。GPU は未確認 |
| 正解注釈 CSV の検証と、区間の重なり時間に基づく評価 | 実装・確認済み |
| 単独・混合・分離の3条件の比較実験（音量比、分離前後の差、元素材単位の分割） | 実装済み。合成デモと GuitarSet 5録音で実行を確認 |
| GuitarSet（実ギター録音のデータセット）から必要な録音だけを取り出す機能 | 実装・確認済み |

メロディ採譜、MIDI・TAB譜の出力、新しいモデルの学習、Webアプリは初版の対象外です。

## Notebook（Google Colab）

上のセルから順に実行します。Colab のリンクは `main` ブランチのファイルを開きます。

| Notebook | 内容 | GitHub | Colab |
| --- | --- | --- | --- |
| 1：単独ギター | 読み込み・再生 → クロマ → コード推定 → 保存 → 設定を変える練習 | [開く](https://github.com/shogo-ishikawa/2026_3Q_M4Th4/blob/main/projects/guitar-chord-lab/notebooks/01_single_guitar_chords.ipynb) | [Open in Colab](https://colab.research.google.com/github/shogo-ishikawa/2026_3Q_M4Th4/blob/main/projects/guitar-chord-lab/notebooks/01_single_guitar_chords.ipynb) |
| 2：分離して推定 | 混合音 → Demucs でギターを分離 → 同じ設定で推定 → 聴き比べ | [開く](https://github.com/shogo-ishikawa/2026_3Q_M4Th4/blob/main/projects/guitar-chord-lab/notebooks/02_separate_and_recognise.ipynb) | [Open in Colab](https://colab.research.google.com/github/shogo-ishikawa/2026_3Q_M4Th4/blob/main/projects/guitar-chord-lab/notebooks/02_separate_and_recognise.ipynb) |
| 3：比較実験 | 単独・混合・分離の3条件、分離前後の差、件数と分割の確認 | [開く](https://github.com/shogo-ishikawa/2026_3Q_M4Th4/blob/main/projects/guitar-chord-lab/notebooks/03_comparison_experiment.ipynb) | [Open in Colab](https://colab.research.google.com/github/shogo-ishikawa/2026_3Q_M4Th4/blob/main/projects/guitar-chord-lab/notebooks/03_comparison_experiment.ipynb) |

各 Notebook の最初のセルが、次の準備を行います。

- リポジトリを HTTPS で `/content/2026_3Q_M4Th4` に取得し、この作品だけをインストールします（Notebook 2・3 は分離用の追加機能も入れます）。
- 作業ディレクトリを `/content/2026_3Q_M4Th4/projects/guitar-chord-lab` にします。Notebook の相対パスはここが基準です。
- 使ったコミットを表示します。実験を再現するときは、セル内の `COMMIT` に記録したコミットを入れて実行します。作業ブランチを試すときは `BRANCH` を変えます。
- 結果は作業ディレクトリの `outputs/` に保存します。Colab のファイルはランタイムの終了で消えるため、必要な結果はダウンロードしてください。

Notebook 1 は CPU だけで動きます。Notebook 2・3 は GPU があると速くなります（「ランタイム」→「ランタイムのタイプを変更」）。

## ローカルでの最短の実行手順

Python 3.12 以上が必要です（確認したのは 3.13）。

```bash
git clone https://github.com/shogo-ishikawa/2026_3Q_M4Th4.git
cd 2026_3Q_M4Th4/projects/guitar-chord-lab
python3 -m venv .venv
source .venv/bin/activate            # Windows は .venv\Scripts\activate
pip install -e .                     # 分離も使うなら pip install -e ".[separation]"
guitar-chord-lab demo                # 合成デモを作り、推定・評価・保存まで行う（CPUのみ）
```

`guitar-chord-lab demo` は `data/generated/demo/` に合成デモを作り、`outputs/demo/` に結果を保存します。合成音での結果は動作確認用で、実際のギター録音での精度を示すものではありません。

よく使うコマンド（作品フォルダで実行）:

```bash
guitar-chord-lab analyse 録音.wav --start 30 --duration 20            # 30秒目から20秒を解析
guitar-chord-lab analyse 録音.wav --set segment_seconds=0.25          # 設定を1つ変える
guitar-chord-lab analyse 録音.wav --annotation 正解.csv --pdf         # 評価も行い、PDFも保存
guitar-chord-lab analyse 合奏.wav --separate --device auto            # ギターを分離してから解析
guitar-chord-lab separate 合奏.wav --duration 20                      # 分離した音だけを保存
guitar-chord-lab evaluate outputs/demo/chords.csv 正解.csv            # 保存した結果を評価
guitar-chord-lab guitarset                                            # GuitarSet の録音5本を取り出し、実験設定を作る
guitar-chord-lab experiment configs/experiment_demo.toml              # 比較実験
guitar-chord-lab --help
```

`python -m guitar_chord_lab ...` でも同じように実行できます。

### 配布 ZIP から使う

`guitar-chord-lab-v0.1.0.zip` を展開すると `v0.1.0/` フォルダができます。そのフォルダで上と同じく `pip install -e .` を実行してください。ZIP に含まれる `release_info.json` に、作成したときのコミットが記録されています。

## 入力と出力

**入力**
- 音声：WAV、FLAC、OGG、MP3（M4A・AAC は `ffmpeg` で WAV に変換）。開始時刻と長さを指定して切り出せます。最初は10〜30秒程度がおすすめです。
- 正解注釈（任意）：`start_s,end_s,chord` の3列の CSV。詳しくは [data/README.md](data/README.md)。
- 解析設定（任意）：[configs/analysis_default.toml](configs/analysis_default.toml) と同じ形の TOML。

**出力**（`outputs/` の下。Git の管理外）

| ファイル | 内容 |
| --- | --- |
| `chords.csv` | コード区間：開始・終了 [秒]、元ファイルでの時刻、判定状態、コード、第1・第2候補と類似度、音量 |
| `chord_scores.csv` | 固定幅の区間ごとの、24コードとの類似度 |
| `analysis.json` | 解析設定、入力の情報（ファイル、切り出し位置、SHA-256）、ライブラリの版、コミット |
| `analysis.png`（`.pdf`） | クロマグラム・コード推移・類似度の図 |
| `evaluation.json` | 正解注釈がある場合の評価結果 |
| 分離した音 | `separated_guitar.wav`（Demucs の guitar 出力）、`without_guitar.wav`（入力 − guitar） |

判定状態は `chord`（判定）、`no_chord`（N＝無音）、`undecided`（判定保留。`chord` 列は `X`）の3つです。類似度はテンプレートとの形の近さを表すコサイン類似度（0〜1）で、**正解する確率ではありません**。

## 学生が最初に変えるとよい設定と関数

| 対象 | 場所 | 試すこと |
| --- | --- | --- |
| `segment_seconds`（時間幅） | `ChordSettings`／`configs/analysis_default.toml` | 0.25・0.5・1.0・2.0 秒で、区間の数と正解率を比べる |
| `min_margin`・`min_score`（判定のしきい値） | 同上 | 判定保留・誤り・正解率・判定率の関係を見る |
| `smoothing_segments`（平滑化） | 同上 | コードが変わる位置の付近の結果を見る |
| `silence_db`（無音しきい値） | 同上 | 小さな音の録音で N の区間を確かめる |
| `make_chord_template` | `src/guitar_chord_lab/chords.py` | テンプレートの重みを変える（例：根音を重くする） |
| `decide_label` | `src/guitar_chord_lab/recognition.py` | N・判定保留・コードを決める条件を読む・変える |

Notebook 1 の練習に、期待される観察と解答例があります。

## 処理の流れ

1. 音声を読み込み、切り出し、モノラル化して 22050 Hz に変換する（`audio.py`）
2. CQT（または STFT）でクロマ特徴量を約0.023秒ごとに計算する（`recognition.py`）
3. 0.5秒ごとの区間でクロマを平均し、24種類のテンプレートとのコサイン類似度を計算して、前後の区間と平均する
4. 無音なら N、第1候補の類似度や第1・第2候補の差が小さければ判定保留、それ以外は第1候補とし、同じ判定が続く区間をまとめる
5. 分離する場合は、Demucs の htdemucs_6s で guitar を取り出してから、同じ処理を行う（`separation.py`）
6. 正解注釈と、区間の重なり時間で比べる（`evaluation.py`）。比較実験は `experiment.py`

正解のコードや区間の境界は、推定には使いません。既定の設定値の選び方は [docs/research-guide.md](docs/research-guide.md) にあります。

## 制約と注意

- 対象は12音のメジャー／マイナー（24種類）と N です。7th、sus、転回形などは推定せず、正解注釈に含まれる場合はエラーにします。
- N は「無音の区間」だけです。音が鳴っていればコードか判定保留になります。そのため、伴奏が鳴っている混合音では N を検出できません。
- テンプレートは構成音を同じ重みにした単純なものです。根音の倍音（5倍音は長3度）の影響で、マイナーコードが同主調のメジャーと紛らわしくなることがあります。
- 合成デモのギター風の音は、Demucs ではギターとして分離されにくいことを確認しています。分離の確認には実際のギター録音を使ってください。
- 比較実験の例の伴奏は、プログラムで作ったドラムです。人工的な混合音の結果を、実際の合奏録音の結果として述べないでください。
- 分離にはメモリと時間が必要です。確認した環境（CPU 4コア、GPU なし）では、20秒の音源の分離に約13〜20秒かかりました。Colab の CPU ランタイムでの時間は未確認です。

## データ・モデルの利用条件

- **GuitarSet**：Q. Xi ほか "GuitarSet: A Dataset for Guitar Transcription"（ISMIR 2018）、[Zenodo](https://zenodo.org/records/3371780)、CC BY 4.0。このリポジトリには含めず、必要なときに取得します。使うときは出典を明記してください。
- **Demucs**：コードは MIT ライセンスです。README によると、htdemucs_6s の重みは Meta の社内データで学習されており、利用条件は明確でない（非商用の CC BY-NC が当てはまる可能性が高い）とされています。授業・研究の範囲で使い、分離した音を配布しないでください。
- **合成デモ**：この作品のコードで生成する音と注釈です。`data/examples/demo_a_annotation.csv` は、生成される正解注釈の例です。
- このリポジトリ自体のライセンスは、まだ指定されていません。

## ファイルの案内

| 場所 | 役割 |
| --- | --- |
| [src/guitar_chord_lab/](src/guitar_chord_lab/) | Python パッケージ（Notebook と CLI が同じ関数を使います） |
| [notebooks/](notebooks/) | Colab 教材（1：単独ギター、2：分離、3：比較実験） |
| [configs/](configs/) | 解析設定と比較実験の設定例 |
| [data/](data/) | 正解注釈の形式、例、データの取得方法 |
| [tests/](tests/) | 自動テスト（`pytest`） |
| [scripts/](scripts/) | 配布 ZIP の作成、Notebook の一括実行 |
| [docs/environment.md](docs/environment.md) | 検証した Python・ライブラリの版と、確認した公式情報 |
| [docs/research-guide.md](docs/research-guide.md) | 比較実験の手順、素材の追加方法、解釈の注意 |
| [docs/verification.md](docs/verification.md) | 実施した確認と結果、未確認の事項 |
| [docs/research-plan.md](docs/research-plan.md) | 研究の問いと実験計画 |
| [DEVELOPMENT.md](DEVELOPMENT.md)・[AGENTS.md](AGENTS.md) | 開発仕様と、この作品を編集するときのルール |

## テスト

```bash
pip install -e ".[dev]"
python -m pytest                                  # 通常のテスト（Demucs の実分離とネットワークを使うものは省略）
RUN_DEMUCS_TESTS=1 python -m pytest -m demucs     # Demucs のモデル取得と実分離（要 .[separation]、ネット接続）
RUN_NETWORK_TESTS=1 python -m pytest tests/test_guitarset.py   # GuitarSet からの取得
```

## 参考資料

- [Demucs](https://github.com/adefossez/demucs)（Rouard, Massa, Défossez, "Hybrid Transformers for Music Source Separation", ICASSP 2023）
- [librosa](https://librosa.org/)
- [mir_eval](https://mir-eval.readthedocs.io/)（評価の計算の照合に使用）
- [GuitarSet](https://guitarset.weebly.com/)
