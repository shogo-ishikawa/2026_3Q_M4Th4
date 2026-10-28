"""Park Itinerary Lab: パークでの一日の予定を、数理最適化で計算する教材用パッケージ。

入門（PuLP）と本体（OR-Tools CP-SAT）で必要なライブラリが違うため、
このファイルでは重いライブラリを読み込みません。使うモジュールを個別に import してください。

- park_itinerary_lab.intro      : PuLP による活動選択の入門モデル
- park_itinerary_lab.data       : 入力データの読み込みと確認
- park_itinerary_lab.model      : CP-SAT による日程最適化（本体）
- park_itinerary_lab.validate   : 計算結果を独立に再計算する検証関数
- park_itinerary_lab.bruteforce : 極小問題を全時刻で調べる独立な正解器
- park_itinerary_lab.report     : 表・図・保存
- park_itinerary_lab.experiment : 研究へ向けた比較実験
"""

__version__ = "0.1.0"
