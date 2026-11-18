# 施設データと距離の読み方

確認日：2026年11月17日

`data/parks.json` にはランドとシーの施設情報、徒歩通路、計画に使う初期値をまとめています。施設名・公式ページ・運営予定と、待ち時間などの計画値は区別して記録しています。

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

ランドもOpenStreetMapの徒歩通路・水域・建物から地理地図を作っています。2026年11月18日に標準のOSM Map APIから取得しました。施設は付近の公開徒歩通路上の点です。入口や待ち列を測量した位置ではありません。距離は道の曲線に沿って計算し、同じ経路を描画します。建物内と待ち列の移動は含みません。入退園の基準点はメインエントランス付近の通路です。個別の施設が未登録の場合は周辺の名前付き施設を基準にしています。

[ランドの地理データ](data/land-geography.json)と[地図データの利用条件](data/land-geography-LICENCE.md)を確認できます。© OpenStreetMap contributors / ODbL 1.0。旧版の概略経路は新しい地理地図に重ねません。

シーは [OpenStreetMap](https://www.openstreetmap.org/copyright) の徒歩通路・水域・建物から地理地図を作っています。2026年11月17日に公開 [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) から取得しました。緯度経度を同じ縮尺で投影し、ルートを通路の曲線に沿って描画します。`edges[].metres` は通路の各頂点の緯度経度から求めた距離の合計です。水路・船・鉄道は徒歩の接続に使いません。分離した通路を推測でつなぐこともありません。橋・桟橋・岸沿いのデッキも元データの徒歩通路を使います。水域の輪郭と重なる通路があり、すべてに橋の属性が付いているわけではありません。

シーの施設は付近の公開徒歩通路上の点で表します。施設の入口や待ち列を正確に測った座標ではありません。個別の位置が登録されていない店舗や期間限定のショーは付近のランドマークを基準にしています。待ち列・建物内の移動距離は含みません。入退園の基準点はプラザ付近です。ファンタジースプリングス西端など詳細が不足する箇所もあります。地点の由来と基準のランドマークは各ノードに記録しています。

地図データと出典の地物IDは [sea-geography.json](data/sea-geography.json) に保存しています。© OpenStreetMap contributors / ODbL 1.0。[地図データの利用条件](data/sea-geography-LICENCE.md)はこの地図データに適用され、アプリのコードのライセンスは変更しません。

シーのエレクトリックレールウェイは片道の移動として扱い、降車後の地点を `endNode` に記録しています。ランドのトムソーヤ島いかだは往復と短い島内散策を一つの予定として計画します。実際の入口や通行状況は公式マップと現地の案内で確認できます。

## 更新する場所

- 施設の追加・名称・営業時間・休止・公演時刻：各パークの施設一覧と当日のパーク情報。
- DPAの料金と利用条件：DPAの公式案内。
- 新しい施設の位置や通路：施設ページの地図と公式ガイドマップ。シーの地理データは新しい OSM 抽出から `scripts/build_sea_geography.py` で再作成。

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
- 天気：[Open-Meteo](https://open-meteo.com/) のパーク周辺の1時間予報を優先します。無料APIの非商用・教育利用の条件で使用し、[CC BY 4.0](https://open-meteo.com/en/license)の出典を表示します。取得できない場合は[気象庁の千葉県予報](https://www.jma.go.jp/bosai/forecast/#area_type=class20s&area_code=1222700)へ切り替えます。気象庁の天気は千葉県北西部の3時間または日予報、降水確率は6時間または日予報、気温は千葉または銚子地点です。降水量はこの気象庁JSONには含まれません。未提供と0を区別し、発表・取得日時と時間の区切りを保持します。Open-Meteoの範囲は今日から15日先です。予報の範囲を超える日付では手動の天気を使います。
- 予報キャッシュ：日中は約1時間ごと、夜間は3時間ごとにサーバーで取得します。ブラウザは30分以内の予報を再利用し、通信失敗時も取得から12時間を超えた予報は使いません。更新失敗で前回の予報を使う場合は経過時間を表示します。
- [混雑予想カレンダー](https://yosocal.com/)、[Queue-Timesのカレンダー](https://queue-times.com/ja/parks/274/calendar)、[ディズニーリアル](https://disneyreal.asumirai.info/realtime/disneyland-wait-today.html)は比較用のリンクです。公開ページの予測値や履歴を学習データへ取り込む機能はありません。

待ち時間と体験時間は別の値です。外部情報で更新するのは待ち時間と稼働状況です。乗車時間は公式の所要時間、食事・買い物などは自分で指定した滞在時間を使います。

## 過去履歴・気象・カレンダーによる学習

v1.3.0初期モデルはThemeParks.wikiの匿名で利用できる直近7日分の履歴から作成しました。公開するのは学習係数・検証誤差・十分な件数の集計です。元の履歴を再配布しません。[Powered by ThemeParks.wiki](https://www.themeparks.wiki/) ／ [API](https://www.themeparks.wiki/api) ／ [利用条件](https://www.themeparks.wiki/terms)。

過去の天気・気温・降水量は[Open-Meteo Historical Forecast API](https://open-meteo.com/en/docs/historical-forecast-api)の気象モデル予報です。予測時も並び始める時間帯の気象予報を使います。祝日・振替休日は[内閣府「国民の祝日」CSV](https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html)を加工したカレンダーです。

匿名の履歴取得は直近7日です。無料キーは30日、対応する契約済みキーは400日または全アーカイブを利用できます。取得コードは実際の権限とカバレッジを確認します。[取得期間の説明](https://www.themeparks.wiki/pricing)と[カバレッジ](https://www.themeparks.wiki/coverage)で現在の提供範囲を確認できます。手元の正規の過去記録や収集済みの月別記録は全期間を追加できます。サーバーでの再学習は全適格記録を使い、ブラウザ内では処理負荷を抑えて全期間から最大5万件を均等に選びます。

学習期間が7日間の初期段階では、別の季節や祝日・異なるイベントの比較には十分な記録がありません。曜日・天気・イベント別の件数と日数を表示し、比較できない条件は記録不足として扱います。

## 待ち時間の余裕

待ち列の見込みと計画用の余裕を分けて記録します。自動の余裕は、その予測に採用した学習モデルの検証MAEを5分単位に切り上げた値（最大30分）です。モデルが使えない場合は5分を仮定します。MAEは確率的な上限や信頼区間ではありません。追加の混雑想定も利用者が選んだ仮定です。公演とDPAの集合時刻には加えません。
