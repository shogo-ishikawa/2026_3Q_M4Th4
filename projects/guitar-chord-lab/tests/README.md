# 検証コード

```bash
pip install -e ".[dev]"     # 作品フォルダで実行
python -m pytest
```

| ファイル | 確かめる内容 |
| --- | --- |
| `test_chords.py` | 24種類のテンプレート、構成音、コード名の正規化、対応外のコードの検出 |
| `test_audio.py` | 切り出し、範囲外の指定、MP3 の読み込み、モノラル化とリサンプリング、保存 |
| `test_recognition.py` | 正弦波の三和音24種類の判定、無音→N、境界の時刻、全体が無音・短すぎる入力、判定保留、元ファイルの時刻への変換、設定の検証、合成デモ |
| `test_evaluation.py` | 完全一致・不一致・部分的な時間の一致・判定保留・予測なし・注釈の欠損の評価、mir_eval との照合、不正な注釈の検出 |
| `test_separation.py` | Demucs 未導入・モデル取得失敗・guitar を出力しないモデル・メモリ不足の説明、キャッシュ、時間軸 |
| `test_experiment.py` | 音量比を保った混合、時間ずれの推定、元素材単位の分割、比較実験の実行と分離前後の対応付け、設定の誤りの検出 |
| `test_guitarset.py` | JAMS からの注釈の変換、対応外のコードの検出、3度の割合、実験設定の作成 |
| `test_cli_and_demo.py` | 合成デモの生成、`demo`・`analyse`・`evaluate` コマンド、エラーの表示 |

時間のかかる確認は、環境変数を付けたときだけ実行します。

```bash
RUN_DEMUCS_TESTS=1 python -m pytest -m demucs                 # Demucs のモデル取得と実分離
RUN_NETWORK_TESTS=1 python -m pytest tests/test_guitarset.py  # Zenodo からの取得
```

合成音でのテストは、プログラムの動作と音名の対応を確かめるものです。実際のギター録音での精度を示すものではありません。実施した確認と結果は [docs/verification.md](../docs/verification.md) にあります。
