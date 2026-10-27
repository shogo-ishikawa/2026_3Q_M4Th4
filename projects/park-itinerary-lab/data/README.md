# データ

この作品で使うデータは、すべて**計算例のための架空の値**です。実在のテーマパークの施設・待ち時間・料金・制度を再現したものではなく、実測値や公式値ではありません。実データの自動収集は行いません。

## ファイルの案内

| 場所 | 内容 |
| --- | --- |
| [`../configs/demo_park.json`](../configs/demo_park.json) | 02 のデモ用の架空パーク（8施設・2ショー・食事1、季節・混雑の待ち時間表3種類） |
| [`../configs/tiny_check_park.json`](../configs/tiny_check_park.json) | 独立な正解器と照合するための極小パーク（3施設・ショー1、90分） |
| [`../configs/intro_activities.json`](../configs/intro_activities.json) | 01 の入門用の架空の活動（7件） |
| [`templates/csv/`](templates/csv/) | CSVで入力するためのテンプレート（記入例つき） |
| [`templates/scenario_template.json`](templates/scenario_template.json) | JSONで入力するためのテンプレート（記入例つき） |

テンプレートの記入例も架空の値です。テンプレートはそのまま読み込めるので、値を書き換えて使えます。

## 出典・確認日・仮定の記録

シナリオ（パークのデータ）の `meta` に、次の項目を書きます。

| 項目 | 内容 |
| --- | --- |
| `source_type` | `fictional`（架空）、`own_observation`（自分で調べた）、`published_information`（公開情報）、`other` のどれか |
| `checked_on` | 値を確認した日（`"YYYY-MM-DD"`）。架空なら `null` |
| `assumptions` | 仮定の説明（文字列のリスト） |
| `title`・`notes` | 名前とメモ |

公開情報を使う場合は、利用条件を確認し、出典と確認日を記録してください。施設IDは英数字・ハイフン・下線で書き、表示名とは分けます。施設の数は自由に変えられます。

## JSON の形式

`configs/demo_park.json` と同じ形式です。主な項目:

- `gates`: 入口と出口の名前と座標（m）
- `walking`: 分速（`metres_per_minute`）と距離の測り方（`manhattan` または `euclidean`）。`walk_minutes` に `{出発ID: {到着ID: 分}}` の表を入れると、座標の代わりに使います（入口は `entrance`、出口は `exit`）。
- `attractions`: 施設（ID・名前・座標・体験時間・希望度・通常の案内時間 [`queue_open`, `queue_close`)・完了期限 `finish_by`（なければ `null`））
- `wait_tables`: 季節・混雑ごとの待ち時間表。`bands` は並び始める時間帯 `"HH:MM-HH:MM"`（[開始, 終了)）、`wait_min` は施設ごとの待ち時間（分）。`null` はその時間帯に通常利用できないこと
- `shortcut_offers`: 短縮利用の仮定枠（施設・枠の時間帯・料金・残る待ち時間）
- `shows`: ショー（場所・公演時間・開演の何分前までに到着するか・希望度・公演回の一覧）
- `meals`: 食事・休憩（場所・所要時間・開始できる時間帯・希望度）

## CSV の形式

`templates/csv/` のように、1つのフォルダに次のファイルを置きます（`load_scenario_csv(フォルダ)` で読み込み、JSON と同じ確認を行います）。

| ファイル | 列 |
| --- | --- |
| `scenario.json` | `meta`・`cost_basis`・`gates`・`walking`（CSV にしにくい項目） |
| `attractions.csv` | `id,name,x,y,duration_min,preference,queue_open,queue_close,finish_by` |
| `wait_times.csv` | `season,season_label,attraction_id` の後に、時間帯の列（`09:00-10:00` など）。空欄は通常利用できない時間帯 |
| `shortcut_offers.csv`（任意） | `id,attraction_id,window_start,window_end,price_yen,residual_wait_min` |
| `shows.csv`（任意） | `show_id,show_name,x,y,duration_min,arrive_before_min,preference,performance_id,start`（公演回ごとに1行） |
| `meals.csv`（任意） | `id,name,x,y,duration_min,window_start,window_end,preference` |
| `walk_minutes.csv`（任意） | `from_id,to_id,minutes`（座標の代わりに使う徒歩時間の表） |

表計算ソフトで編集した場合は、UTF-8（BOM付きでも可）のCSVで保存してください。

## 手入力データへの差し替え

1. `templates/csv/` をコピーし、値を書き換えます（または `scenario_template.json` をコピーして書き換えます）。
2. 02 の Notebook で `load_scenario_csv(フォルダ)`（JSON なら `load_scenario(ファイル)`）を使って読み込みます。
3. 誤りがあれば、日本語の説明を並べたエラーが表示されます。

利用者ごとの条件（入退園時刻、予算、必須項目、取得済み枠など）はデータではなく、Notebook の設定セル（`CONDITIONS`）で指定します。
