# Swing Motion Lab

動画の中の肩と腰に線を引き、スイング中の向きと変化をグラフで見比べるアプリです。

[アプリを開く](https://shogo-ishikawa.github.io/2026_3Q_M4Th4/swing-motion-lab/)

## はじめに

最初にデモを動かすと、映像上の線とグラフの関係を確認できます。自分の動画を使う場合は、動画を選び、打者を囲んでから解析します。点の位置は手動でも指定できます。

動画の表示時刻とグラフを合わせて、肩と腰がいつ、どのくらい変化したかを調べます。解析条件を変えると、保存した座標から計算し直せます。

## 測る量

| 表示 | 意味 | 単位 |
| --- | --- | --- |
| 肩・腰の角度 | 左右の肩、左右の腰を結ぶ線の向き | 度 |
| 角速度 | 線の角度が変わる速さ | 度/秒 |
| 肩と腰の角度差 | 同じ時刻の2本の線の向きの違い | 度 |
| 有効率 | 信頼度と線の長さの条件を満たした時点の割合 | % |

角度は画面の右を0度とし、上向きを正にします。線の向きは180度で同じ向きに戻ります。肩や腰が隠れた時点は空欄になり、その前後をつなげて角速度を計算しません。角度は画像の平面に投影された線の向きです。動画同士を比べるときは、撮影方向と時間倍率をそろえます。

平滑化は近くの時点に直線を当てはめ、細かい揺れを抑える処理です。窓を広げると短い変化も緩やかになります。同じ動画で窓を変えて比べると、結果への影響が分かります。

## 保存と再解析

CSVには時刻と解析値を保存します。JSONには入力した座標と解析条件を保存し、後から読み込んで再解析できます。動画はブラウザ内で処理します。

## ローカルで開く

配布ZIPを展開すると `v1.0.0` フォルダができます。`web/index.html` をブラウザで開くと、デモと座標データを利用できます。動画の自動推定では初回にMediaPipeのライブラリとモデルを取得します。

配置例：`/Users/shogo/Dropbox/share_data/open_material/misc/apps/SwingMotionLab/v1.0.0`

公開用のソースは、このクラスの[GitHubリポジトリ](https://github.com/shogo-ishikawa/2026_3Q_M4Th4)内の `projects/swing-motion-lab/` で管理します。Git通信にはHTTPSを使います。ローカルの変更を反映するときは、上のフォルダで `bash sync_to_github.sh` を実行します。GitHubへ書き込める認証を設定したGitを使用します。

## 開発と確認

```sh
node --test tests/motion-core.test.js
```

静的ファイルのみで動作します。配布ZIPとPagesはリポジトリ全体の `scripts/build_public_site.py` から生成します。

## 参照

- [MediaPipe Pose Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker?tab=Web)
- [MediaPipe JavaScript API](https://developers.google.com/edge/api/mediapipe/js/tasks-vision.poselandmarker)

自動推定は `@mediapipe/tasks-vision` 1.2.3 と Pose Landmarker Lite を使用します。WebGLを使えない環境では、TensorFlow.js 4.22.0 と MoveNet Lightning（pose-detection 2.1.3）によるCPU処理へ切り替えます。

- [TensorFlow.jsの姿勢推定](https://github.com/tensorflow/tfjs-models/tree/master/pose-detection)
