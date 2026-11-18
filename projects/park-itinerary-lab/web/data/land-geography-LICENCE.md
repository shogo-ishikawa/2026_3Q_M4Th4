# ランドの地図データの出典と利用条件

`land-geography.json` と `../assets/land-geographic-map.svg` は OpenStreetMap のデータを加工したものです。
このデータに由来する `parks.json` のランドの座標・徒歩通路・距離にも同じ条件が適用されます。

© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)

データベースのライセンスは [Open Database Licence 1.0](https://opendatacommons.org/licenses/odbl/1-0/) です。
この条件は地図データに適用されます。アプリのソースコードのライセンスは変更しません。

2026年11月18日に標準の OSM Map API から取得しました。
取得URL：`https://api.openstreetmap.org/api/0.6/map?bbox=139.870,35.628,139.885,35.641`
パーク境界は OSM way 1282875870 です。出典の地物IDと緯度経度は JSON に保存しています。

公開の徒歩通路・歩行者用道路・階段・小道・廊下の主連結成分を使います。
待ち列、立入禁止・私有通路、車道、水路、船、鉄道は徒歩通路に使いません。
分離した通路を推測でつなぎません。距離は道の頂点間の測地距離の合計です。
施設と通路ノードを重ねた接続には丸めの余裕として1mを加えています。

施設のピンは付近の公開通路上の点です。入口や待ち列を測量した位置ではありません。
個別の施設が登録されていない場合は名前付きの周辺施設を基準にしています。
各地点の `osmLandmark`、`coordinateAccuracy`、`landmarkOffsetMetres` に由来を記録しています。
建物内・待ち列・乗り場までの歩行距離は含みません。
入退園の基準点はメインエントランス付近の通路です。
パレードの通行規制や工事は現地の案内に従ってください。

再作成：`python scripts/build_sea_geography.py /path/to/osm-map.xml --park land`
既存のシー用スクリプトを共通化しており、シーは従来どおり `--park sea` または指定なしで作成できます。
