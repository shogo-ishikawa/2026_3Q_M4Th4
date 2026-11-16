# SwingMotionCore

依存のないJavaScriptです。ブラウザでは `motion-core.js` を読み込み、`window.SwingMotionCore` を使います。Nodeでは `require('./web/motion-core.js')` で同じ関数を使えます。

## 入力

```js
const frames = [{
  time: 1.25,            // 動画のタイムライン上の秒
  frame: 38,             // 任意。なければ配列の添字
  points: {
    leftShoulder: {x: 120, y: 100, confidence: 0.9},
    rightShoulder: {x: 200, y: 80, confidence: 0.9},
    leftHip: {x: 125, y: 200, confidence: 0.9},
    rightHip: {x: 195, y: 190, confidence: 0.9}
  }
}];
const options = {
  confidenceThreshold: 0.5,
  minSpanPx: 12,
  smoothingWindow: 3,  // 1・3・5・7
  timeScale: 1        // 動画内1秒が実時間で何秒か
};
const result = SwingMotionCore.analyse(frames, options);
```

座標は画像の左上を原点とし、xは右向き、yは下向きのピクセル値です。MediaPipeの左右肩は11・12、左右腰は23・24を対応させます。confidenceの省略値は1です。点がないときは `null`、時点全体で検出できないときは `points: {}` を渡せます。

角度は画面の右方向を0度とし、反時計回りを正にします。線は180度回すと同じ向きになるため、最初の値は−90度以上90度未満にまとめます。その後は隣り合う有効な時点の短い回転をつなぎます。隣接時点間で90度以上回ったかどうかは、この座標だけでは区別できません。ちょうど90度の変化は区間を分け、その時点の角速度を空欄にします。

角度と角速度は、画像の平面に投影された肩・腰の線についての値です。

## 出力

`result` は `{schemaVersion, options, inputFrames, frames, summary}` です。`inputFrames` は確認済みの座標で、元の入力オブジェクトと独立しています。

結果の各時点には次の列を含みます。

| 列 | 内容 |
| --- | --- |
| `frame`, `time` | フレーム番号、動画内の時刻（秒） |
| `timeSeconds`, `elapsedSeconds` | 換算後の時刻、最初からの経過秒 |
| `shoulderAngleRaw`, `hipAngleRaw` | 180度周期の元の角度（度） |
| `shoulderAngleUnwrapped`, `hipAngleUnwrapped` | 連続区間ごとにつないだ角度（度） |
| `shoulderAngle`, `hipAngle` | 平滑化後の角度（度） |
| `shoulderVelocityRaw`, `hipVelocityRaw` | 元の角度からの角速度（度/秒） |
| `shoulderVelocity`, `hipVelocity` | 平滑化後の角速度（度/秒） |
| `shoulderConfidence`, `hipConfidence` | 端点二つの信頼度の小さい方 |
| `shoulderSpanPx`, `hipSpanPx` | 線の長さ（ピクセル） |
| `shoulderValid`, `hipValid` | 角度を使えるかどうか |
| `shoulderReason`, `hipReason` | `missing` / `confidence` / `short-axis` / 空文字 |
| `shoulderAmbiguous`, `hipAmbiguous` | 前の時点からの90度変化で区間を分けたか |
| `shoulderSegment`, `hipSegment` | それぞれの連続区間番号 |
| `relativeAngle` | 肩−腰の向きの差（−90度以上90度未満） |

欠測は `null` です。角速度は同じ連続区間の隣接する二時点から、実際の時刻差で計算します。区間の最初の角速度も `null` です。角度の平滑化は、同じ区間の近隣時点に直線を当てはめる方法です。一定角速度の動きは、不等間隔の時刻でも保存されます。窓1は平滑化を行いません。

`timeScale` は時刻に掛ける係数です。例えば4倍スローの映像で実時間へ換算する場合は0.25とし、角速度は動画内の秒で計算した値の4倍になります。

`summary` は `frameCount`, `videoDurationSeconds`, `durationSeconds`, `shoulderValidCount`, `hipValidCount`, `pairedValidCount`, `shoulderValidRate`, `hipValidRate`, `shoulderVelocityCount`, `hipVelocityCount`, `shoulderPeakAbsVelocity`, `hipPeakAbsVelocity`, `relativePeakAbsAngle` を含みます。Rateは0〜1です。使える角速度がない場合、ピークは0ではなく `null` です。

## 保存と再解析

```js
const csvText = SwingMotionCore.exportCSV(result);
const jsonText = SwingMotionCore.exportJSON(result, {
  label: 'スイング1', sourceKind: 'manual', width: 960, height: 540
});
const saved = SwingMotionCore.readJSON(jsonText);
const recalculated = SwingMotionCore.analyse(saved.frames, saved.options);
```

CSVには角度・角速度・信頼度・元座標を収録します。UTF-8 BOMとCRLFを使い、欠測セルは空欄です。JSONは元座標と解析条件を保存するので、しきい値や窓を変えて計算し直せます。JSONの `schemaVersion` は `1.0.0`、`kind` は `swing-motion-points` です。sourceKindは `demo`, `video`, `manual`, `results`, `unknown` から選びます。`readJSON` はラベル・画像サイズも返します。

入力時刻は厳密な昇順です。20,000時点まで、動画内時刻は0〜86,400秒、画像座標の絶対値は1,000,000以下です。非数の座標・信頼度は欠測にし、範囲外の信頼度や文字列の座標などの形式誤りは拒否します。

## デモと確認

`demo-data.js` は `window.SWING_DEMO` として、960×540の座標121時点を用意します。ラベルは「デモ：肩と腰の向きの変化」です。デモの映像を描く際は、四つの座標とその中点から上半身を描けます。

```bash
node --test tests/motion-core.test.js
```
