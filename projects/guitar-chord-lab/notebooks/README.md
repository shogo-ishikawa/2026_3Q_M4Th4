# Notebook

Google Colab で上のセルから順に実行する教材です。処理の本体は `src/guitar_chord_lab/` の関数で、Notebook には重複して実装していません。

| Notebook | 内容 | 必要なもの |
| --- | --- | --- |
| [01_single_guitar_chords.ipynb](01_single_guitar_chords.ipynb) | 単独ギター音源：読み込み・再生 → クロマ → コード推定 → 評価 → 保存 → 設定を変える練習（解答例つき） | CPU のみ |
| [02_separate_and_recognise.ipynb](02_separate_and_recognise.ipynb) | 混合音から Demucs でギターを分離し、同じ設定で推定して聴き比べる | Demucs（GPU 推奨） |
| [03_comparison_experiment.ipynb](03_comparison_experiment.ipynb) | 単独・混合・分離の3条件の比較実験（件数、分割、分離前後の差） | Demucs（GPU 推奨） |
| [04_song_analysis.ipynb](04_song_analysis.ipynb) | YouTube URL または音声 → BPM の確認 → 伴奏ギターとコード変化の推定 → 拍表示・保存 | Demucs（GPU 推奨）。YouTube 取得には FFmpeg と対応する JavaScript ランタイム |

Colab で開くリンクは、作品の [README](../README.md) にあります。

- 最初のセルが、リポジトリの取得（`/content/2026_3Q_M4Th4`）、指定したブランチ（`BRANCH`）またはコミット（`COMMIT`）への切り替え、この作品だけのインストール、作業ディレクトリの設定（`/content/2026_3Q_M4Th4/projects/guitar-chord-lab`）、使用コミットの表示を行います。コードの版が変わったときは、セッションの再起動を求める表示が出ます。
- 結果は作業ディレクトリの `outputs/` に保存します。
- Notebook 1〜3 の既定の入力は GuitarSet の実ギター録音です（ネット接続が必要）。Notebook 1 は取得に失敗すると合成デモに切り替えます。Notebook 4 では自分で音源を指定し、BPM を確認します。
- リポジトリには実行結果を含めない状態で保存しています。Notebook 1〜3 をローカルで一括実行するときは `python scripts/run_notebooks.py notebooks/0[1-3]_*.ipynb` を使います（結果は `outputs/notebook_runs/`）。
