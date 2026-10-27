# Park Itinerary Lab

テーマパークでの一日の回り方を、数理最適化で計算する Python 学習プロジェクトです。「ディズニーでの一日の回り方を提案したい」という希望を出発点に、特定のパークに依存しない**架空のパーク**のデータで、次の3段階を学びます。

1. **入門（01）**: PuLP で「どの活動を選ぶか」を決める小さな問題を解く。
2. **本体（02）**: OR-Tools CP-SAT で、訪問先・順序・並び始める時刻・有料の時間短縮の利用・ショーの公演回を同時に決める。
3. **研究へ向けた比較実験（02 の後半）**: 「固定時刻の予定があると、どの施設の時間短縮に費用を配分するべきかは、どのように変わるか」を調べる土台。

新しい問題やアルゴリズムを考案したものではなく、既存の手法で、問題設定・検証・比較・考察を経験するための教材です。

## 実装状況（v0.1.0 初版）

| 内容 | 状態 |
| --- | --- |
| 01 PuLP 入門（活動の選択、全列挙との照合、演習3問と解答例） | 実装済み・ローカルで実行確認 |
| 02 本体モデル（CP-SAT、優先順位つき最適化、5つの状態の表示、事前チェック、検証関数、表・図・保存） | 実装済み・ローカルで実行確認 |
| 独立な正解器（全時刻の探索）との照合 | 実装済み・テストと Notebook で確認 |
| 比較実験（方法A/B、予算とショーの条件・すべてのショーを除く基準、CSV保存、乱数の一括実験） | 実装済み（一括実験は任意） |
| Google Colab 上での実行 | **未確認**（Colab と同じ Python 3.13 と主要ライブラリの版をそろえた環境で、セットアップセルによる GitHub からの取得を含めて、Notebook を上から実行して確認） |

確認した内容と結果は [docs/validation.md](docs/validation.md) にあります。Webサイト・アプリ・API・クラウド公開、実際の購入や公式アプリとの連携は扱いません。

## Google Colab での始め方

1. 下の表のリンク、または Colab の「ファイル → ノートブックを開く → GitHub」で、Notebook の GitHub の URL を指定して開きます。
2. 最初のセル（セットアップ）を実行します。リポジトリを HTTPS で取得し、この作品をインストールし、デモ設定を読み込みます（1〜2分）。Google Drive や認証情報は不要です。
3. その後は上から順に実行します（「ランタイム → すべてのセルを実行」でも構いません）。GPU は不要です。

| Notebook | 内容 | 開発中のブランチ（`claude/new-session-cc8kr0`） |
| --- | --- | --- |
| `notebooks/01_pulp_intro.ipynb` | PuLP 入門 | [GitHub](https://github.com/shogo-ishikawa/2026_3Q_M4Th4/blob/claude/new-session-cc8kr0/projects/park-itinerary-lab/notebooks/01_pulp_intro.ipynb) |
| `notebooks/02_day_plan_optimisation.ipynb` | 日程最適化と比較実験 | [GitHub](https://github.com/shogo-ishikawa/2026_3Q_M4Th4/blob/claude/new-session-cc8kr0/projects/park-itinerary-lab/notebooks/02_day_plan_optimisation.ipynb) |

Colab で開くURLは `https://colab.research.google.com/github/shogo-ishikawa/2026_3Q_M4Th4/blob/<ブランチ>/projects/park-itinerary-lab/notebooks/<ファイル名>` の形です。ブランチ名に `/` を含む開発中のブランチでは、この形のURLが使えない可能性があるため、上の GitHub のリンクから Colab の「GitHub」タブで開いてください。**Colab で開いて動かすことは、まだ確認していません。**

### コードの版（`REPO_REF`）について

- セットアップセルの `REPO_REF` が、取得するコードの版です（ブランチ名・タグ名・コミットSHA・`refs/pull/<番号>/head` のどれでも指定できます）。Colab ではセルのコードが折りたたまれ、`REPO_REF`・`UPDATE_CHECKOUT`・`PROJECT_DIR_OVERRIDE` の入力欄だけが表示されます（コードを見るには、セルをダブルクリックします）。
- **開発中**は、作業ブランチ `claude/new-session-cc8kr0` を指定しています。main へ反映した後は、別の変更（プルリクエスト）で `REPO_REF = "main"`（または `park-itinerary-lab-v0.1.0` のような作品名付きのタグ）と、この README のリンクを一緒に更新します。
- Colab で PR や別のブランチの Notebook を開いても、セットアップが自動的にその PR のコードを取得するわけではありません。取得するのは `REPO_REF` の版です。PR の内容を試す場合は、`REPO_REF` に `refs/pull/<番号>/head` を指定します。
- 指定した版を取得できない場合や、その版にこの作品がない場合（例: main へ反映する前に `"main"` を指定した）は、main に切り替えずに理由を表示して止まります。
- 2回目以降の実行では、前回取得したコミットをそのまま使います。最新にしたいときは `UPDATE_CHECKOUT` にチェックを入れます。セットアップセルが作ったチェックアウト以外のフォルダや、保存されていない変更があるチェックアウトは、書き換えません（保存されていない変更があるまま使う場合は、注意を表示し、保存する結果にも記録します）。
- セットアップセルは、そのランタイムで読み込んだ作品のコードが変わったこと（`REPO_REF` の変更、作品のコードの編集・追加・削除）を見つけると、古い関数のまま計算しないように `RestartRequired` で止まります。そのときは「ランタイム → セッションを再起動する」の後、セットアップセルから実行し直します。
- 配布 zip を Colab で展開して使う場合は、セットアップセルの `PROJECT_DIR_OVERRIDE` に展開したフォルダ（例: `/content/v0.1.0`）を指定します。自分で `git clone` したチェックアウトを使う場合も、その中の作品フォルダ（例: `/content/2026_3Q_M4Th4/projects/park-itinerary-lab`）を指定します。指定すると `REPO_REF` は使いません。

## ローカルでの実行

Python 3.12 以上が必要です（PuLP 4 の要件）。CBC を含む cbcbox 2.929 の配布物（wheel）は Linux・Windows・macOS 15 以降向けで、macOS 14 以前には用意されていません（確認したのは Linux だけです）。リポジトリのルートで:

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e "projects/park-itinerary-lab[dev]"   # 入門だけなら [intro]、本体だけなら [main]
python -m pytest projects/park-itinerary-lab/tests  # テスト
python projects/park-itinerary-lab/scripts/run_notebooks.py   # Notebook を新しいカーネルで上から実行
```

ローカルのチェックアウトから Notebook を開いた場合、セットアップセルはそのチェックアウトのコードを使います（`REPO_REF` は取得しません）。repoルート・作品フォルダ・`notebooks/` のどこを作業フォルダにしても、作品フォルダを見つけます。

| 依存の追加分 | 内容 | 主な用途 |
| --- | --- | --- |
| （基本） | pandas | 表の表示 |
| `intro` | PuLP 4.2.0 と CBC（cbcbox 2.929） | 01 |
| `main` | OR-Tools 9.15.6755（CP-SAT）、matplotlib、matplotlib-fontja（図の日本語表示） | 02 |
| `dev` | 上の両方と pytest、nbclient など | テスト・Notebook の自動実行 |

01 は OR-Tools なしで動きます。確認した版は [docs/validation.md](docs/validation.md) と `requirements/` に記録しています。

## 学習の順序

1. `01_pulp_intro.ipynb`: 入力・決定変数・制約条件・目的関数の対応、ソルバーの役割、全列挙による確認、演習。
2. `02_day_plan_optimisation.ipynb` の前半: 本体モデルで一日の予定を計算し、検証関数と独立な正解器で確かめ、条件を変えて試す。
3. `02_day_plan_optimisation.ipynb` の後半: 研究へ向けた比較実験（[docs/research-plan.md](docs/research-plan.md)）。

## 設定の変え方

学生が変更する値は、各 Notebook の**設定セル**にまとめています。

- 01: 時間の上限、予算、必須の活動、活動の希望度など
- 02: 入退園時刻、季節・混雑（`quiet`/`normal`/`busy`）、予算（1人分）、有料の時間短縮を検討するか、取得済み枠、必須の施設・ショー・食事、希望度や希望順位、ソルバーの制限時間、比較実験の条件

時刻は `"09:30"` のように書き、計算では 0:00 からの分に直します。時間帯 `"10:00-11:00"` は 10:00 を含み 11:00 を含みません。

## 入力と出力

- 入力: パークのデータ（JSON、または CSV を集めたフォルダ。[data/README.md](data/README.md)）と、設定セルの条件。デモは `configs/demo_park.json`（架空）。テンプレートは `data/templates/`。
- 出力: 状態（最適性確認済み・実行可能な暫定案・実行不可能と証明・未判定・モデルまたは入力のエラー）、各段階の目的値と限界値、予定表（移動・待機・待ち時間・体験・鑑賞・食事、入場枠、各時刻）、合計（希望度・費用・移動・待ち時間・出口への到着・必須条件）、タイムライン図。CSV と JSON を `outputs/` の新しいフォルダに保存します（[outputs/README.md](outputs/README.md)）。

## モデルの仮定と制約

- パーク・施設・待ち時間・料金は架空の値です。実測値・公式値ではありません。
- 待ち時間は「並び始めた時刻の時間帯」の値を使う決定論的なモデルです。結果はこのモデル（1分単位）での厳密解で、実際の待ち時間を保証しません。
- スコアは入力した希望度の合計で、実際の満足度を測った値ではありません。
- 有料の時間短縮は「入力した枠を取得できる、または取得済み」という仮定で計算します。実際の購入・抽選・在庫確認・公式アプリの操作は行わず、現在の制度（次に購入できる時刻、売り切れ等）を完全には再現しません。
- 1グループ・1日・1経路で、各施設・ショーは最大1回です。

詳しくは [docs/model.md](docs/model.md) を参照してください。

## ファイルの案内

| 場所 | 役割 |
| --- | --- |
| [notebooks/](notebooks/) | Colab 教材（01, 02） |
| [src/park_itinerary_lab/](src/park_itinerary_lab/) | Notebook から呼ぶコードの正本（`intro`・`data`・`options`・`model`・`precheck`・`validate`・`bruteforce`・`report`・`experiment`） |
| [tests/](tests/) | テスト（全列挙・独立な正解器との照合、境界、状態の表示など） |
| [configs/](configs/) | デモ設定（架空） |
| [data/](data/) | 入力テンプレートとデータの説明 |
| [docs/](docs/) | モデル（model.md）、研究計画（research-plan.md）、検証の記録（validation.md） |
| [scripts/](scripts/) | Notebook の自動実行、配布 zip の作成 |
| [outputs/](outputs/) | 計算結果の保存先（Git の管理対象外） |
| [AGENTS.md](AGENTS.md)・[CLAUDE.md](CLAUDE.md) | この作品の開発ルール |

## 配布用 zip

作品フォルダで `python scripts/make_dist.py` を実行すると、`dist/park-itinerary-lab-v0.1.0.zip` を作ります。展開すると `v0.1.0/` フォルダになり、Git で管理しているこの作品のファイルだけが入ります（`dist/` は Git の管理対象外）。

## 参考資料

- PuLP: https://github.com/coin-or/pulp
- OR-Tools CP-SAT: https://developers.google.com/optimization/cp/cp_solver
- OR-Tools のスケジューリングの例: https://github.com/google/or-tools/blob/stable/ortools/sat/docs/scheduling.md
