# Park Itinerary Lab — パークの一日をデザイン

ブラウザ版 v1.0.0。東京ディズニーランドと東京ディズニーシーの希望を、時間・歩く距離・重要度・予算に合わせて組み立てます。

[アプリを開く](https://shogo-ishikawa.github.io/2026_3Q_M4Th4/park-itinerary-lab/) ／ [使い方と計画の仕組み](web/guide.html)

## 最初の計画

1. パークと訪問日、入退園時刻を選びます。
2. 行きたい施設を追加し、重要度を付けます。
3. 食事や公演の時間帯、DPAの取得枠を確認します。
4. 予算・歩く速さ・休憩・探索時間を指定します。
5. 予定と未採用の理由を見比べ、条件を調整します。

アトラクション・ショー・パレード・レストラン・カフェ・スナック・ポップコーン・グリーティング・お土産を選べます。シーはジュビリーブルーをイメージした背景です。

## 地図・待ち時間・購入条件

- 徒歩ルートは公式地図を参照した通路グラフを使います。各施設の入口と通路を結び、橋や回り道を通る距離を計算します。距離は概算です。
- 待ち時間は手動指定か履歴CSVからの類似日推定です。初期データに実績履歴は含めません。記録がないときは曜日・時間帯・天気・期間イベントを使う傾向モデルとして表示します。
- DPAは利用者が公式アプリで確認した購入可能枠・取得済み枠を条件にします。購入時刻と区分別の購入間隔も考慮します。公演参加や予約が必要な体験は取得状況を確認します。
- 日付付きの公演時刻は確認日の値です。別日の計画では当日の時刻を入力します。
- 当日の再計画では済んだ予定を保ち、現在地・支出・残り時間・購入できる枠から先を組み替えます。

出典とデータの前提は [データの出典](web/data-sources.md) にあります。

## 保存して持ち歩く

端末内保存・JSONの読み込み・条件の共有リンク・CSV・JSTのカレンダーICS・オフラインで読める予定表HTMLを使えます。共有リンクは条件を開く用途、JSONとHTMLは完成済みの予定を持ち歩く用途です。

## ブラウザ版をパソコンで起動

配布ZIPを展開すると `v1.0.0` フォルダになります。そのフォルダでWindowsは `py run.py`、macOS・Linuxは `python3 run.py` を実行します。Python標準ライブラリだけで起動します。終了は `Ctrl+C` です。

配置例：`/Users/shogo/Dropbox/share_data/open_material/misc/apps/ParkItineraryLab/v1.0.0`

`bash sync_to_github.sh` で既存のクラスリポジトリへHTTPSでアップロードできます。確認後はPagesへ反映します。

## 施設データを更新

`web/data/parks.json` に出典・確認日・施設・イベント・通路をまとめています。画面からJSONを読み込んで差し替えられます。

```sh
python3 scripts/update_park_data.py --date 2026-11-17
```

公式の一覧と照合した候補を `outputs/catalogue-update.json` に出力します。新施設やDPAの変更は差分レポートで確認します。位置・料金を確認したら画面でJSONを読み込みます。サイトへ反映するときは `web/data/parks.json` を更新してアップロードします。`--apply` を付けた場合だけ元データを書き換えます。GitHub Actionsの「Check park catalogue」から手動実行することもできます。

## ブラウザ版の探索

通路上の最短距離を計算し、時間窓と費用を守る候補順序を複数残しながら探索します。有望な候補を比較し、指定時間に達した時点の実行可能な案を返します。必須項目は制約として扱い、採用した希望度の合計を優先します。探索結果を厳密な最適解と表示しません。

```sh
node --test tests-web/*.test.mjs
python -m unittest discover -s tests-web -p 'test_*.py'
```

| ファイル | 役割 |
| --- | --- |
| `web/planner.js`・`planner-worker.js` | 時間制限付き探索と制約検証 |
| `web/data/parks.json` | 実在施設・公演・イベント・通路 |
| `web/app.js` | 条件編集、当日の組み替え、結果表示 |
| `web/map-view.js` | 通路と予定を結ぶ概略地図 |
| `web/storage.js` | 保存・共有・CSV・ICS・予定表HTML |
| `scripts/update_park_data.py` | 公式一覧の照合と更新候補 |

## Pythonで最適化を学ぶ

併設するPython教材 v0.1.0 は架空の小さなパークを使います。PuLPで活動の選択、OR-Tools CP-SATで順序・時刻・費用の同時最適化を学び、独立な全探索と照合します。ブラウザ版とは別のモデルです。

## Python教材をColabで使う

| Notebook | 内容 | 開く |
| --- | --- | --- |
| `01_pulp_intro.ipynb` | PuLPで活動を選ぶ。全列挙と比べる。 | [GitHub](https://github.com/shogo-ishikawa/2026_3Q_M4Th4/blob/main/projects/park-itinerary-lab/notebooks/01_pulp_intro.ipynb) ／ [Colab](https://colab.research.google.com/github/shogo-ishikawa/2026_3Q_M4Th4/blob/main/projects/park-itinerary-lab/notebooks/01_pulp_intro.ipynb) |
| `02_day_plan_optimisation.ipynb` | CP-SATで順序・時刻・費用を最適化する。 | [GitHub](https://github.com/shogo-ishikawa/2026_3Q_M4Th4/blob/main/projects/park-itinerary-lab/notebooks/02_day_plan_optimisation.ipynb) ／ [Colab](https://colab.research.google.com/github/shogo-ishikawa/2026_3Q_M4Th4/blob/main/projects/park-itinerary-lab/notebooks/02_day_plan_optimisation.ipynb) |

セットアップから上のセル順に実行します。CPUで使えます。`REPO_REF = "main"` がGitHubから取得するコードです。再取得するときは `UPDATE_CHECKOUT` を選びます。読み込み済みコードと取得したコードが違う場合はセッションを再起動してから実行します。

自分のチェックアウトや展開したPython教材を使う場合は `PROJECT_DIR_OVERRIDE` に作品フォルダを指定できます。取得元の変更時に保存されていない編集を上書きしません。

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
