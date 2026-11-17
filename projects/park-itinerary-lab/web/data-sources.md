# 施設データと距離の読み方

確認日：2026年11月17日

`data/parks.json` にはランドとシーの施設情報、通路の概略図、計画に使う初期値をまとめています。施設名・公式ページ・運営予定と、待ち時間などの計画値は区別して記録しています。

## 公式情報を使っている項目

- 施設名と所属エリア、施設ごとの公式ページ。
- 確認日の営業時間と公演時刻。`operatingDate`、`windowsDate`、`showTimesDate` が対象日です。
- アトラクションの所要時間。公式ページに数値がある場合は分単位に切り上げ、`officialDuration` に元の表記を記録しています。
- DPAの対象施設・料金・対象期間。料金は1人・1回分です。
- 期間限定イベントの名称と開始・終了日。

2026年11月17日に運営予定があるアトラクションを中心に収録しています。シーのトランジットスチーマーラインは航路の変更先を一次資料で確定できないため、候補から外して `omittedFacilities` に記録しています。未開業のシュガー・ラッシュ、休止中のインディ・ジョーンズなどは候補に含めていません。別の日を計画するときは、その日の営業時間・休止・公演時刻を公式情報と合わせてください。

パレードの時刻は開始地点での公式開始時刻です。概略図ではファンタジーランド側の開始地点付近を鑑賞先にしています。取得したDPAの鑑賞エリアを使うときは、その場所と集合時刻を指定してください。

## 計画のための初期値

待ち時間の `baseWait` は実測履歴ではありません。施設の種類に合わせて置いた仮の値です。実測データを取り込むか、当日の待ち時間に置き換えて使います。イベントの `multiplier` も混雑への影響を試すための仮定です。

飲食と買い物の `cost` は1人分の予算目安です。料理、注文数、ポップコーンのバケット、購入するグッズによって変わります。必要額へ変更してから計画してください。ショー・食事・買い物・グリーティングの滞在時間は余裕を含む計画値です。`durationSource` と `costSource` で由来を確認できます。

## 地図と徒歩距離

公式のガイドマップを参照して独自の概略図を作りました。ランドとシーの背景には生成したイラストを使っています。施設の位置を見つけやすくするための概略図で、通路の厳密な形を表す画像ではありません。通路の交差点と施設の入口を分け、橋や回り道を経由するネットワークで距離を求めます。同じエリアにある施設にも専用の入口ノードがあります。

`edges[].metres` は地図を読んで置いた徒歩距離の概算です。現地での測量値やGPSの記録ではありません。シーの縮尺は、入口からファンタジースプリングスへ徒歩約15〜25分とする[公式の体験学習シート](https://www.tokyodisneyresort.jp/treasure/fantasy/learningfun/pdf/studysheet_teamwork_tds.pdf)とも比較して調整しています。シーのエレクトリックレールウェイは片道の移動として扱い、降車後の地点を `endNode` に記録しています。ランドのトムソーヤ島いかだは往復と短い島内散策を一つの予定として計画します。図の `x` と `y` は見やすい配置のための座標です。未確認の緯度経度は `null` にしています。実際の入口や通行状況は各施設の公式ページ内の地図で確認できます。

## 更新する場所

- 施設の追加・名称・営業時間・休止・公演時刻：各パークの施設一覧と当日のパーク情報。
- DPAの料金と利用条件：DPAの公式案内。
- 新しい施設の位置や通路：施設ページの地図と公式ガイドマップ。

JSONを入れ替えるとブラウザの候補一覧へ反映できます。新施設は入口ノードと接続する通路も追加します。時刻や対象期間を更新した際は、それぞれの確認日を一緒に変更してください。

## 一次資料

| 内容 | ランド | シー |
| --- | --- | --- |
| アトラクション | [一覧](https://www.tokyodisneyresort.jp/tdl/attraction/) | [一覧](https://www.tokyodisneyresort.jp/tds/attraction/) |
| パレード・ショー | [一覧](https://www.tokyodisneyresort.jp/tdl/show/) | [一覧](https://www.tokyodisneyresort.jp/tds/show/) |
| レストラン | [一覧](https://www.tokyodisneyresort.jp/tdl/restaurant/list/) | [一覧](https://www.tokyodisneyresort.jp/tds/restaurant/list/) |
| グリーティング | [一覧](https://www.tokyodisneyresort.jp/tdl/greeting/) | [一覧](https://www.tokyodisneyresort.jp/tds/greeting/) |
| ショップ | [一覧](https://www.tokyodisneyresort.jp/tdl/shop/list/) | [一覧](https://www.tokyodisneyresort.jp/tds/shop/list/) |
| 確認日の予定 | [11月17日](https://www.tokyodisneyresort.jp/tdl/daily/calendar/20261117/) | [11月17日](https://www.tokyodisneyresort.jp/tds/daily/calendar/20261117/) |
| 休止情報 | [一覧](https://www.tokyodisneyresort.jp/tdl/monthly/stop/) | [一覧](https://www.tokyodisneyresort.jp/tds/monthly/stop/) |
| 公式マップ | [地図](https://www.tokyodisneyresort.jp/tdl/map.html) | [地図](https://www.tokyodisneyresort.jp/tds/map.html) |

[DPAの対象・料金・購入ルール](https://www.tokyodisneyresort.jp/tdr/guide/app_service/disneypremieraccess) ／ [シー25周年の公式案内](https://www.tokyodisneyresort.jp/treasure/tds25th/)

## 待ち時間と天気

- 待ち時間・稼働状況：[Queue-Times Real Time API](https://queue-times.com/en-US/pages/api)。元データは約5分更新。アプリの収集は15分間隔です。出典リンク「Powered by Queue-Times.com」を取得画面に表示します。公開APIの現在値を蓄積し、過去のカレンダーページの複製は行いません。
- 天気：[Open-Meteo](https://open-meteo.com/)。無料APIの非商用・教育利用の条件で使用します。[CC BY 4.0](https://open-meteo.com/en/license)の出典を取得画面と学習データに記録します。予報の範囲を超える日付では手動の天気を使います。
- [混雑予想カレンダー](https://yosocal.com/)、[Queue-Timesのカレンダー](https://queue-times.com/ja/parks/274/calendar)、[ディズニーリアル](https://disneyreal.asumirai.info/realtime/disneyland-wait-today.html)は比較用のリンクです。公開ページの予測値や履歴を学習データへ取り込む機能はありません。

待ち時間と体験時間は別の値です。外部情報で更新するのは待ち時間と稼働状況です。乗車時間は公式の所要時間、食事・買い物などは自分で指定した滞在時間を使います。
