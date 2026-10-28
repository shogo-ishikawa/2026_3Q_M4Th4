# Park Itinerary Labの編集ルール

リポジトリルートの [AGENTS.md](../../AGENTS.md)（配布zipには含まれないため、https://github.com/shogo-ishikawa/2026_3Q_M4Th4/blob/main/AGENTS.md も参照）と、このファイルの両方に従ってください。モデルの詳細は [docs/model.md](docs/model.md)、検証の記録は [docs/validation.md](docs/validation.md) にあります。

## 編集範囲と構成

- 主な編集範囲は `projects/park-itinerary-lab/` です。他の作品（例: `projects/guitar-chord-lab/`）のコード・依存・データは変更・流用しません。
- 最適化・検証・データ読込の正本は `src/park_itinerary_lab/` に置きます。Notebook と比較実験は、その関数を呼び出し、処理をコピーしません。
- 依存は `pyproject.toml` の追加分（`intro`: PuLP と CBC、`main`: OR-Tools など、`dev`: テスト）で分けます。`__init__.py` ではソルバーを読み込みません（01 は OR-Tools なしで動く必要があります）。
- PuLP は 4.2 の書き方だけを使います（`problem.add_variable(...)`、`stats.status_str`、`pulp.COIN_CMD`）。古い `LpVariable(..., cat=...)`・`LpStatus`・`PULP_CBC_CMD` は使えません。ソルバーの版は `pyproject.toml` で固定し、変えるときは検証をやり直します。
- 初学者が追える短い関数と明確な名前を使い、深い継承や巨大なクラスで中身を隠しません。説明は日本語、英語は英国式の綴りにします。

## モデルの約束

- 時刻は 0:00 からの整数分、費用は整数円（初版の標準は1人分）、希望度は整数です。時間帯は [開始, 終了) で、退園時刻・完了期限・開演前の到着は「以下」で判定します。
- 本体は OR-Tools CP-SAT を直接使います。RoutingModel などの近似解を厳密解として返しません。ギャップの許容値は0にします。
- 優先順位は「希望度合計 → 追加費用 → 移動時間」です。前の段階で最適性を確認できたときだけ値を固定して次へ進みます。補助の段階（出口への到着時刻）は、状態の表示に影響させません。
- 状態は「最適性確認済み」「実行可能な暫定案」「実行不可能と証明」「未判定」「モデルまたは入力のエラー」の5つです。未判定を実行不可能と表示しません。
- 必須項目は制約で守り、得点で誘導したり、成立しないときに勝手に外したりしません。
- 短縮利用は「入力した枠を取得できる／取得済み」という仮定で扱います。実際の購入・抽選・在庫確認・非公開API・アプリの自動操作は実装しません。未実装の購入ルール（`purchase_rules`）を指定したら入力エラーにします。取得済み枠の `must_use` は利用者が明示します。

## 検証

- `validate.py`（検証関数）は `model.py`・`options.py` を使わずに予定を計算し直します。`bruteforce.py`（独立な正解器）は標準ライブラリだけを使い、作品の他のモジュールを読み込みません。この独立性はテストで確認しています。
- 変更したら `python -m pytest projects/park-itinerary-lab/tests`（repoルートから）を実行します。ソルバーがない場合に skip するテストは書きません。
- Notebook は出力を消した状態でコミットします。実行の確認は `python scripts/run_notebooks.py` で行い、実行済みのコピーは `outputs/` に保存されます（Git の対象外）。
- Colab で実行できない確認は「未確認」と記録し、架空の実行結果やURLを書きません。

## データ・出力・配布

- デモのデータは架空です。実測値・公式値に見える書き方をしません。データには `source_type`・`checked_on`・`assumptions` を記録します。
- 計算結果・実験結果・実行済み Notebook・配布zipは `outputs/` と `dist/` に保存し、コミットしません。
- 配布zipは `python scripts/make_dist.py` で作り、展開すると `v0.1.0/` になる構成にします。リポジトリ内に版ごとのフォルダを複製しません。
- Notebook の `REPO_REF` は、実在するブランチ・タグ・コミットを指すようにします。main へ反映した後は `"main"`（またはタグ）に更新します。
