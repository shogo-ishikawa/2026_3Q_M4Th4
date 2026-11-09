# 元のC++版の参照用ソース

学生制作のC++・raylib版を参照できるよう、ソース、CMake設定、参照用のタイル画像を保持しています。公開版のブラウザゲームとは別実装です。このフォルダは公開版の実行に必要ありません。

## 構成

- `src/GameWorld.*`：フィールド、物体、プレイヤーの状態と描画。
- `src/RuleEngine.*`：選ばれた対象と動作、ルールの検証。
- `src/OllamaClient.*`：ローカルOllamaとの通信。
- `src/main.cpp` / `src/JapaneseUI.h`：入力、画面、ゲーム全体の進行。
- `CMakeLists.txt`：提出版のビルド設定。
- `data/`：ルール例と提出版のタイル画像2種と利用条件（未使用の個別タイルやサンプルは省略）。

ビルド設定は提出時のものを保持しています。raylib 6.2、nlohmann/json 3.12.0を参照していますが、この参照用フォルダについて、依存先の取得、macOS・Windows・Linuxでのビルドや動作は確認していません。

## フォントを含めていません

提出版の `data/NotoSansJP.ttf` は、元の案内では **Zen Kaku Gothic New Bold** と説明されていました。フォント本体はこの参照用フォルダに含めていません。C++版を動かす場合は、[Zen Kaku Gothic Newの配布元](https://github.com/googlefonts/zen-kakugothic)から利用条件を確認して取得し、元コードが参照する `data/NotoSansJP.ttf` に配置する準備が必要です。

対応する `data/ZenKakuGothicNew-OFL.txt` は保持しています。公開版のブラウザゲームはOSの標準フォントを使います。

## 素材の利用条件

`data/tiny-dungeon/` はKenneyのTiny Dungeonで、同梱の `License.txt` にCC0の表記があります。元のライセンス表記をそのまま保持しています。この素材の利用条件を、ゲーム全体のライセンスとして扱うものではありません。

学生の氏名・学籍番号を含む資料、内部向けの案内、提出方法の説明、入れ子のZIPは含めていません。
