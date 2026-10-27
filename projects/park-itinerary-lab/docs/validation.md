# 検証の記録（v0.1.0）

この文書は、実際に実行した確認と、その結果だけを記録します。**Google Colab 上での実行は、まだ確認していません**（「6. 未確認の事項」）。

## 1. 確認した環境

確認日: 2026-10-27。Linux x86_64 のコンテナ（CPU 4コア、メモリ 15 GiB）で実行しました。

| 環境 | 用途 | 主な版 |
| --- | --- | --- |
| Python 3.13.17 の新しい仮想環境（README の手順: `python -m venv` → `pip install -e "projects/park-itinerary-lab[dev]"`） | テスト・Notebook・配布zip | PuLP 4.2.0、cbcbox 2.929（CBC の実行ファイル）、OR-Tools 9.15.6755、pandas 3.1.0、numpy 2.5.4、matplotlib 3.11.2、matplotlib-fontja 1.1.0、protobuf 6.33.6、pytest 9.1.1、nbclient 0.11.0 |
| Python 3.12.3 の新しい仮想環境（同じ手順） | テスト | 上と同じ版 |
| Colab 相当の環境（Python 3.13.17。Colab に入っている版をそろえた新しい仮想環境で、作品は未導入） | セットアップセル・Notebook の通し実行 | pandas 2.2.3、numpy 2.1.3、matplotlib 3.10.0、protobuf 6.33.6、PuLP 4.2.0、ipykernel 6.17.1、setuptools 80.10.2、pip 26.2.2（OR-Tools と cbcbox は未導入の状態から開始） |

Colab に入っている版は、公開されている Colab の環境情報（googlecolab/backend-info の os-info.txt と pip-freeze.txt。2026-10-27 に取得。Python 3.13.16）を参照しました。これは Colab での実行の代わりではありません。

検証に使った依存の一覧は [`../requirements/verified-py313.txt`](../requirements/verified-py313.txt) にあります（`pip install -e "projects/park-itinerary-lab[dev]" -c projects/park-itinerary-lab/requirements/verified-py313.txt` で同じ版を入れられます）。

## 2. テスト

| 実行の仕方 | 結果 |
| --- | --- |
| repoルートで `python -m pytest projects/park-itinerary-lab/tests`（Python 3.13） | 547 passed（約20秒） |
| repoルートで同じコマンド（Python 3.12） | 547 passed（約20秒） |
| 作品フォルダで `python -m pytest`（Python 3.13） | 547 passed（約19秒） |
| 配布zipを展開した `v0.1.0/` で、通常のインストール（`pip install "./v0.1.0[dev]"`）の後に `python -m pytest` | 547 passed（約24秒） |

skip・xfail はありません。ソルバー（CBC・CP-SAT）がない場合、テストは skip せずに失敗します。

| ファイル | 件数 | 主に確かめること（指示【7】の番号） |
| --- | --- | --- |
| `test_intro.py` | 55 | 1: PuLP の答えと 0/1 の全列挙（40個の乱数の例とデモ）の最適値・実行可能性が一致。CBC（COIN_CMD）を使うこと |
| `test_model_vs_bruteforce.py` | 152 | 2: 本体（CP-SAT）と独立な正解器（全時刻の探索）を、乱数で作った150個の極小問題と、待たないと成立しない例で照合（状態・目的値の組・予定の再計算・事前チェックなしでも同じ状態） |
| `test_bruteforce.py` | 66 | 正解器そのものの手計算の例（境界、待つと得な例、費用・移動の優先順位など） |
| `test_independence.py` | 6 | 正解器が標準ライブラリだけを使い、作品の他のモジュールを読み込まないこと |
| `test_model_cases.py` | 29 | 3: 予算0円・短縮利用なし・必須施設あり／4: 出口までの移動、ショーの集合時刻ちょうど・1分遅れ、枠の終了時刻の扱い／5: 待ち時間が下がるまで待つのが最適な例／6: 必須条件の衝突・超過で必須を外さず実行不可能／7: 同点なら費用、同費用なら移動の優先順位、取得済み枠の費用 |
| `test_status.py` | 38 | 8: 各段階の終了状態から全体の状態への対応（未判定を実行不可能にしない、暫定案の確認範囲など）、制限時間0秒での実行、ギャップの許容値0 |
| `test_validate.py` | 27 | 検証関数: 正しい予定を通し、改ざんした予定（到着前に並ぶ、集合時刻の誤り、枠外、使えない枠、重複、必須の欠落、予算超過、退園後の到着など）を見つける |
| `test_precheck.py` | 14 | 事前チェック P1〜P4 と、その判定がソルバーの結果と矛盾しないこと |
| `test_experiment.py` | 27 | 方法Bの規則（並べ方・同点・飛ばして次へ・0分以下の除外）、差を計算する条件、エラーの行を残すこと、保存 |
| `test_timeutil_and_data.py` | 99 | 時刻と時間帯の変換・境界、JSON/CSV の読み込み、入力の誤りの日本語メッセージ、移動時間の最短経路への置き換え |
| `test_input_robustness.py` | 16 | 形の誤った入力（辞書とリストの取り違えなど）を日本語の入力エラーにすること |
| `test_report.py` | 9 | 表・図・保存（毎回新しいフォルダ、UTF-8 の JSON） |
| `test_notebooks_and_docs.py` | 9 | Notebook に出力が残っていない、2つのセットアップセルが同じ、REPO_REF と README のリンクの一致、古い PuLP の書き方を使っていない、検証関数がモデルを使っていない |

テストを作る過程で、次の追加の確認も行いました（テストスイートには含めていない一時的な確認です）。

- 正解器と本体の照合を、乱数の極小問題 2000 個で実行し、不一致は0件でした。
- 正解器に19種類、本体側に38種類のわざと誤りを入れた写しを作り、いずれもテストで検出されることを確かめました。

## 3. Notebook の実行

`scripts/run_notebooks.py`（nbclient で新しいカーネルを起動し、上から順に全セルを実行）を使いました。

| 確認 | 結果 |
| --- | --- |
| ローカルのチェックアウト、作業フォルダ `notebooks/` | 01 成功（約2秒）、02 成功（約33秒） |
| 作業フォルダが作品フォルダ | 01 成功、02 成功 |
| 作業フォルダが repoルート | 01 成功、02 成功 |
| Colab 相当の環境・空のフォルダから（セットアップセルが git で取得し、一時フォルダのコピーから pip install） | 01 成功（約18秒、インストールを含む。`[intro]` だけを導入し、OR-Tools なしで実行）、02 成功（約55秒、インストールを含む。前回取得したコミットを再利用） |
| 配布zipを展開した `v0.1.0/notebooks/` から | 01 成功、02 成功（セットアップセルが BUILD_INFO.json を表示） |
| 02 で `RUN_RANDOM_BATCH = True`（乱数のパーク3つ × 予算3通り × 方法2つ） | 成功（Notebook 全体で約76秒、18件すべて最適性確認済み） |

実行の中で確かめた内容: PuLP 入門の答えと全列挙の一致、本体のデモ（最適性確認済み、検証関数との一致）、条件を変えた再計算、実行不可能な条件と入力の誤りの説明、独立な正解器との照合（極小問題で (9, 0, 10) と (11, 500, 14) が一致。予算500円の予定は、9:02 に着いて 9:15 まで待ってから並ぶ）、CSV テンプレートの読み込み、比較実験と保存。

時間はこのコンテナ（4コア）での値で、Colab（通常2コア）では長くなる可能性があります。

## 4. Colab のセットアップセルの確認

開発中のブランチを GitHub へ push できなかったため（このセッションには書き込みの権限がありませんでした）、`REPO_URL` を**ローカルに作った同じ内容のミラー**（`file://`）に置き換えて、実際のセットアップセルのコードを Colab 相当の環境で実行しました。

| 確認 | 結果 |
| --- | --- |
| ブランチ名で取得 → インストール → 読み込み | 成功（取得したコミットを表示） |
| 同じ REPO_REF で再実行 | 取得し直さずに前回のコミットを使う |
| `UPDATE_CHECKOUT = True` | 取得し直す |
| 完全なSHA・短いSHA（8文字） | 成功 |
| 存在しない REPO_REF | main に切り替えず、理由を表示して停止 |
| 作品がまだない `main` | チェックアウトを動かさず、理由を表示して停止 |
| 保存されていない変更があるチェックアウトで別の版を指定 | 切り替えず、変更も残したまま停止 |
| セルが作っていない既存のフォルダ、別の origin、別のGitリポジトリの中 | いずれも書き換えずに停止 |
| チェックアウトの中に build/ や *.egg-info ができないこと | 確認（一時フォルダのコピーからインストール） |

GitHub への HTTPS の読み取りでは、`REPO_REF = "main"`（作品がまだない）と存在しないブランチの2通りで、取得とエラーの説明が正しく動くことを確かめました。

## 5. 配布zip

`python scripts/make_dist.py` で `dist/park-itinerary-lab-v0.1.0.zip` を作りました（50ファイル + BUILD_INFO.json）。

- 同じコミットから2回作ると、同じ SHA-256 になりました（再現できる）。
- 最上位のフォルダは `v0.1.0/` だけで、`.git`・キャッシュ・計算結果・他の作品は入っていません（スクリプトが確認します）。
- 展開したフォルダで、新しい仮想環境へのインストール・テスト・Notebook の実行ができました（2・3節）。

## 6. 未確認の事項

- **Google Colab 上での実行**（Colab の画面、フォーム表示、`files.download`、2コアでの計算時間）。Colab 相当の環境（同じ Python と主要ライブラリの版）での実行で代わりに確認しています。
- **GitHub から開発中のブランチ・SHA・`refs/pull/<番号>/head` を取得すること**（push できなかったため、ローカルのミラーで確認）。README の GitHub・Colab のリンクも、ブランチが GitHub にない間は開けません。
- Colab の GitHub URL（`colab.research.google.com/github/...`）で、`/` を含むブランチ名の Notebook を開けるか。
- Windows・macOS での実行。
- 実在のデータ（実際の待ち時間・料金）での計算。デモはすべて架空のデータです。
- 施設が多い場合（10を大きく超える場合など）の計算時間。時間切れの場合は「暫定案」や「未判定」と表示されます。

## 7. 再実行の方法

repoルートで:

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e "projects/park-itinerary-lab[dev]"
python -m pytest projects/park-itinerary-lab/tests
python projects/park-itinerary-lab/scripts/run_notebooks.py
python projects/park-itinerary-lab/scripts/run_notebooks.py --cwd repo-root
cd projects/park-itinerary-lab && python scripts/make_dist.py --force
```
