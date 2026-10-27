# 実行・配布用スクリプト

| スクリプト | 内容 |
| --- | --- |
| [make_release_zip.py](make_release_zip.py) | 配布用 ZIP `dist/guitar-chord-lab-v0.1.0.zip` を作ります。Git で管理しているこの作品のファイルだけを集め、展開後の最上位フォルダを `v0.1.0/` にします。使ったコミットを `release_info.json` に書き込みます |
| [run_notebooks.py](run_notebooks.py) | Notebook を上から順に実行し、最後まで動くかを確かめます（ローカルでの確認用。Colab での確認の代わりにはなりません） |

```bash
# 作品フォルダ projects/guitar-chord-lab で実行
python scripts/make_release_zip.py              # 未コミットの変更があると作りません
python scripts/run_notebooks.py notebooks/01_single_guitar_chords.ipynb
```

合成デモの生成、解析、比較実験などの処理は `guitar-chord-lab` コマンド（`src/guitar_chord_lab/cli.py`）から実行します。処理の本体は `src/` にあり、Notebook と CLI で同じ関数を使います。

配布 ZIP には、仮想環境、キャッシュ、モデルの重み、音源、実験の出力を含めません（Git で管理していないファイルは入りません。念のため音声やモデルの拡張子も除外します）。
