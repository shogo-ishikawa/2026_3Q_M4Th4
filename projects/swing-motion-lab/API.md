# Motion Analysis Core

画像上の関節座標から、線の向き・関節の内角・体幹の傾きを計算します。JavaScriptの追加ライブラリなしで使えます。

ブラウザでは `web/motion-core.js` を読み込むと `window.MotionAnalysisCore` を使えます。`window.SwingMotionCore` でも同じ関数を呼べます。Nodeでは `require('./web/motion-core.js')` を使います。

## 入力する座標

```js
const frames = [{
  time: 1.25,
  frame: 38,
  points: {
    leftShoulder: {x: 120, y: 100, confidence: 0.9},
    leftElbow: {x: 120, y: 180, confidence: 0.9},
    leftWrist: {x: 190, y: 180, confidence: 0.9}
  }
}];
const options = {
  confidenceThreshold: 0.5,
  minSpanPx: 12,
  smoothingWindow: 3,
  timeScale: 1
};
const result = MotionAnalysisCore.analyse(frames, options);
```

`time` は動画内の秒数です。時刻は重複しない昇順で指定します。`frame` は任意の0以上の整数で、省略すると一覧内の添字になります。

座標の原点は画像の左上です。xは右向き、yは下向きのピクセル値です。`confidence` は0〜1で、省略すると1になります。欠測の点は `null`、検出できない時点は `points: {}` とします。

`POINT_NAMES` は次の12点です。

| 位置 | 左 | 右 |
| --- | --- | --- |
| 肩 | `leftShoulder` | `rightShoulder` |
| 肘 | `leftElbow` | `rightElbow` |
| 手首 | `leftWrist` | `rightWrist` |
| 腰 | `leftHip` | `rightHip` |
| 膝 | `leftKnee` | `rightKnee` |
| 足首 | `leftAnkle` | `rightAnkle` |

必要な部位の座標だけでも解析できます。他の部位は欠測になります。

## 測る量

`METRIC_GROUPS` から表示する部位を選べます。

| グループ | metricのid | 角度の意味 |
| --- | --- | --- |
| `axes` | `shoulder`, `hip` | 左右を結ぶ線の向き。右向きが0度、反時計回りが正 |
| `elbows` | `leftElbow`, `rightElbow` | 肩・肘・手首の内角。伸びるほど180度に近づく |
| `knees` | `leftKnee`, `rightKnee` | 腰・膝・足首の内角。伸びるほど180度に近づく |
| `trunk` | `trunkTilt` | 腰の中心から肩の中心へ引いた線の傾き。直立が0度、画面の右への傾きが正 |

角度と角速度は、画像の平面に投影された関節の位置についての値です。角速度の単位は度/秒です。

肩と腰の線は180度で同じ向きに戻ります。隣接時点の短い回転をつなぎ、ちょうど90度変化した場所では回転方向を決められないため区間を分けます。

肘と膝の内角は0〜180度です。例えば30度から150度へ0.1秒で伸びた場合、角速度は1200度/秒です。体幹の線は腰から肩へ向かう向きを持ち、360度周期でつなぎます。体幹がちょうど180度変化した場所では区間を分けます。

信頼度は必要な点のうち最小の値を使います。肘と膝では関節をはさむ2本の線、体幹では腰の中心から肩の中心への線の長さを確認します。必要な点がない場合、信頼度がしきい値より低い場合、線が短すぎる場合は欠測です。

平滑化は同じ連続区間の近隣時点へ直線を当てはめます。窓は1・3・5・7点です。窓1は平滑化を行いません。肘と膝の平滑化後の値も0〜180度に収めます。欠測の前後はつながず、区間の最初の角速度は欠測です。

`timeScale` は動画内の秒数に掛ける係数です。4倍スローを実時間へ換算する場合は0.25とし、角速度は動画内の秒数で計算した値の4倍になります。

## 結果を読む

`result` は `{schemaVersion, options, inputFrames, frames, summary}` です。`inputFrames` は入力座標のコピーで、保存と再解析に使えます。欠測は `null` です。

`result.frames` では各metricのidに次の接尾辞を付けて値を読みます。例えば `leftKneeAngle` が左膝の角度、`leftKneeVelocity` が左膝の角速度です。

| 接尾辞 | 内容 |
| --- | --- |
| `AngleRaw` | 座標から求めた角度 |
| `AngleUnwrapped` | 連続区間ごとにつないだ角度 |
| `Angle` | 平滑化後の角度 |
| `VelocityRaw`, `Velocity` | 平滑化前・後の角速度 |
| `Confidence` | 必要な点の最小信頼度 |
| `SpanPx` | 確認に使った線の長さの最小値 |
| `Valid`, `Reason` | 有効かどうか。理由は `missing`, `confidence`, `short-axis`, 空文字 |
| `Ambiguous`, `Segment` | 周期の半分の変化で区切ったか、連続区間番号 |

共通の列は `frame`, `time`, `timeSeconds`, `elapsedSeconds` です。`relativeAngle` は肩−腰の線の向きの差を−90度以上90度未満へまとめた値です。

`summary.metrics[id]` には `validCount`, `validRate`, `velocityCount`, `peakAbsVelocity`, `minAngle`, `maxAngle` が入ります。角速度が一つも得られなかった場合、`peakAbsVelocity` は `null` です。

肩と腰を扱うコードでは `summary.shoulderValidCount`, `hipValidCount`, `pairedValidCount`, `shoulderPeakAbsVelocity`, `hipPeakAbsVelocity`, `relativePeakAbsAngle` も使えます。時間の列は `frameCount`, `videoDurationSeconds`, `durationSeconds` です。

表示情報は `METRIC_GROUPS[group]` の `id`, `label`, `description`, `pointNames`, `metrics` から取得します。`metrics` 内の要素には `id`, `label`, `colour`, `angleKey`, `velocityKey`, `validKey`, `segmentKey` があります。

## 保存と再解析

```js
const csvText = MotionAnalysisCore.exportCSV(result);
const jsonText = MotionAnalysisCore.exportJSON(result, {
  label: 'スクワット1', sourceKind: 'manual', metricGroup: 'knees', width: 960, height: 540
});
const saved = MotionAnalysisCore.readJSON(jsonText);
const recalculated = MotionAnalysisCore.analyse(saved.frames, saved.options);
```

CSVには全ての測定量、元座標、信頼度を収録します。UTF-8 BOMとCRLFを使い、欠測セルは空欄です。

JSONはschema `2.0.0`、kind `motion-analysis-points` です。12点の元座標、解析条件、表示する部位、画像サイズを保存します。`sourceKind` は `demo`, `video`, `manual`, `results`, `unknown` から選びます。

v1.0.0の `swing-motion-points` 形式も読み込めます。肩と腰の座標を引き継ぎ、表示する部位を `axes` として再計算します。

入力は20,000時点まで、動画内の時刻は0〜86,400秒、座標の絶対値は1,000,000以下、JSONは64,000,000文字までです。非数の座標は欠測とし、文字列の座標や範囲外の信頼度などの形式誤りは拒否します。

## デモを使う

`web/demo-data.js` の `window.MOTION_DEMOS` から、`swing`, `squat`, `arm` を選べます。各デモは960×540の画像座標121時点、4秒分です。スイングは肩と腰の向き、スクワットは180〜90度の膝の曲がり、腕の曲げ伸ばしは180〜45度の左肘の内角を試せます。`window.SWING_DEMO` はスイングのデモです。

Nodeでは `require('./web/demo-data.js').demos` から3種類を取得できます。

```bash
node --test tests/motion-core.test.js
```
