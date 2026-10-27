# 設定ファイル

| ファイル | 内容 |
| --- | --- |
| [analysis_default.toml](analysis_default.toml) | コード認識の既定の設定（`ChordSettings` の既定値と同じ）。各項目の意味をコメントで説明しています |
| [experiment_demo.toml](experiment_demo.toml) | 合成デモ2本と合成ドラムによる小規模な比較実験の設定例（動作確認用） |

使い方（作品フォルダで実行）:

```bash
guitar-chord-lab analyse 録音.wav --config configs/analysis_default.toml --set segment_seconds=0.25
guitar-chord-lab make-demo
guitar-chord-lab experiment configs/experiment_demo.toml
```

- 実験設定の相対パスは、**設定ファイルのあるフォルダ**を基準にします。
- 実験設定には、元素材ID（`source_id`）、正解注釈、伴奏ID、伴奏の音量（`accompaniment_db`）、乱数シード、調整用／評価用の区分（`split`）、分離モデルと実行デバイスを書きます。項目の説明は [docs/research-guide.md](../docs/research-guide.md) にあります。
- 伴奏の音量は「伴奏のRMS − ギターのRMS」[dB]（RMS は無音を含む切り出し全体）です。音割れを防ぐときは混合音全体に同じ倍率を掛けるので、音量比は変わりません。
- GuitarSet を使う実験設定は `guitar-chord-lab guitarset` で `data/raw/guitarset/experiment_guitarset.toml` に作ります（Git の管理外）。
- 配布する設定例に、実在する個人のパスや個人情報を書かないでください。
- 正解注釈は評価の処理だけに渡し、推定の処理には渡しません。
