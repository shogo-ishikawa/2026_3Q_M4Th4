# 地図データの出典と利用条件

`sea-geography.json` と `../assets/sea-geographic-map.svg` は OpenStreetMap のデータを加工したものです。
このデータに由来する `parks.json` のシーの座標・徒歩通路・距離にも同じ条件が適用されます。

© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)

データベースのライセンスは [Open Database Licence 1.0](https://opendatacommons.org/licenses/odbl/1-0/) です。
この条件は地図データに適用されます。アプリのソースコードのライセンスは変更しません。

2026年11月17日に公開 Overpass API から取得しました。抽出範囲は北緯35.621–35.634度・東経139.878–139.895度です。
範囲に接する地物の全頂点を含むため一部はこの範囲の外にあります。
パーク境界は OSM way 203538370 です。出典の地物IDと緯度経度は JSON に保存しています。

徒歩通路・歩行者用道路・階段・小道・廊下のうち公開の主連結成分を使います。
徒歩で通れない道路や待ち列は使いません。水路・船・鉄道の線も徒歩通路として使いません。
施設は近くの公開徒歩通路上の点で表します。入口や待ち列を正確に測った座標ではありません。
地図に個別の施設がない場合は付近のランドマークを基準にします。
施設内や待ち列の歩行距離は加算しません。入退園の基準点はプラザ付近です。
ファンタジースプリングス西端を含め地図の詳細が不足する箇所があります。
独立した通路を推測でつなぐ処理は行いません。
水域ポリゴンと重なる橋・桟橋・岸沿いのデッキも元データの徒歩通路を使います。
これらすべてに橋や高低差の属性が付いているわけではありません。

主な水域のマルチポリゴンは標準の [OSM Map API](https://wiki.openstreetmap.org/wiki/API_v0.6) で補っています。
取得URLは `https://api.openstreetmap.org/api/0.6/map?bbox=139.883,35.623,139.889,35.628` です。
ハーバーの島など内側の陸地も別のリングとして保存しています。
OSM way 1323365214 は小さな水路を横切る徒歩通路です。橋の属性が未登録であることをデータの `uncertainCrossings` に記録しています。

再作成: `python scripts/build_sea_geography.py /path/to/overpass.json --water-map /path/to/osm-map.xml`
取得クエリは `way[highway]`・`way[natural=water]`・`way[waterway]`・`way[building]`・`nwr[tourism]`・`nwr[amenity]` を上記範囲でまとめて抽出し `out body; >; out skel qt;` で頂点を含めています。

## 表示の向きとランドマーク

入口が下になるように表示だけを回転し、全体を同じ縮尺で収めています。
水域・島・建物の輪郭と徒歩通路の頂点は元の地理データを保持します。距離の計算は変更しません。

`map-landmarks.json` のシーの緯度経度もOpenStreetMapを加工したもので、上記のODbL 1.0が適用されます。
2026年11月18日に標準のOSM Map APIから取得し、地物IDと取得URLをJSONに記録しています。
城・山・船などの絵は位置を示す独自の記号です。実際の建物の輪郭や大きさを表すものではありません。
公式ガイドマップの画像は使用していません。

表示だけの再作成：`python scripts/build_illustrated_maps.py`
