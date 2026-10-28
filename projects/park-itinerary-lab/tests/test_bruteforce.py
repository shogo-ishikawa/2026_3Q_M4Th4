"""独立な正解器（park_itinerary_lab.bruteforce）そのものの確認。

前半は、手で計算できる極小の例で、最適値（希望度合計, 追加費用, 移動時間）と予定の例が
手計算どおりになるかを調べます。特に、時刻の境界（時間帯・枠は [開始, 終了)、退園時刻・
完了期限・開演前の到着は「以下」）と、「待ち時間が下がるまでわざと待つ」ことが最適になる例です。
時刻はすべて 0:00 からの分です（540 = 09:00）。徒歩は特に断らない限り分速 60 m の縦横の距離で、
入口と出口は原点 (0, 0) にあります。

後半は、乱数で作った極小問題（tiny_instances.py）で、次の性質を確かめます。
- 予定の例を計算し直すと、報告した最適値になる。
- メモ化をしない素朴な全探索と、最適値が一致する。
- 条件を緩める（退園を遅らせる・予算を増やす・必須を外す・短縮利用を許す）と、最適値は悪くならない。
"""

import pytest

from park_itinerary_lab.bruteforce import (
    direct_walk_minutes,
    evaluate_plan,
    prepare_instance,
    preference_values,
    solve_by_enumeration,
    to_minutes,
    travel_minutes,
)
from tiny_instances import (
    acquired_slot,
    add_attraction,
    add_meal,
    add_offer,
    add_show,
    earliest_join_best,
    hhmm,
    make_tiny_instance,
    new_conditions,
    new_scenario,
    search_without_memo,
)

SEEDS = range(150)


def triple(result):
    """結果から (希望度合計, 追加費用, 移動時間) の組を取り出す。"""
    return (result["score"], result["extra_cost"], result["travel"])


def step(activity_id, mode, queue_time, slot_id=None, performance_id=None):
    """予定の項目 1 つ（正解器の plan と同じ形の辞書）。"""
    return {"activity_id": activity_id, "mode": mode, "slot_id": slot_id,
            "performance_id": performance_id, "queue_time": queue_time}


# ------------------------------------------------------------------ 待ってから並ぶ


def test_waiting_for_a_cheaper_band_before_a_show_is_optimal():
    """A は 9:00〜9:30 に並ぶと待ち 40 分、9:30〜は 0 分。9:40 開演のショー S にも行きたい。

    9:00 に並ぶと A の終了は 9:45 で S に間に合わない。9:30 まで待って並べば 9:35 に終わり、
    S にも間に合う。A は 9:45 に列が閉まるので、S の後に回すこともできない。
    """
    scenario = new_scenario([(540, 570), (570, 660)])
    add_attraction(scenario, "A", [40, 0], duration=5, preference=5, queue=(540, 585))
    add_show(scenario, "S", [580], duration=10, preference=3)
    conditions = new_conditions(540, 600)
    result = solve_by_enumeration(scenario, conditions)
    assert triple(result) == (8, 0, 0)
    assert result["plan"] == [step("A", "normal", 570),
                              step("S", "show", 580, performance_id="S-1")]
    # 到着後すぐ（間に合う最初の分）に並ぶだけでは、A か S の片方しか回れない。
    assert earliest_join_best(prepare_instance(scenario, conditions)) == (5, 0, 0)


def test_waiting_between_two_attractions():
    """B に 9:00 に乗り、A は待ち時間が 0 分になる 9:30 まで待つと、9:40 の退園までに両方乗れる。"""
    scenario = new_scenario([(540, 570), (570, 600)])
    add_attraction(scenario, "A", [40, 0], duration=5, preference=5)
    add_attraction(scenario, "B", [0, 40], duration=5, preference=3)
    result = solve_by_enumeration(scenario, new_conditions(540, 580))
    assert triple(result) == (8, 0, 0)
    assert result["plan"] == [step("B", "normal", 540), step("A", "normal", 570)]


# ------------------------------------------------------------------ 時刻の境界


@pytest.mark.parametrize("start, feasible", [(553, True), (552, False)])
def test_show_meeting_time_is_inclusive(start, feasible):
    """入口から 3 分で 9:03 に着く。集合時刻（開演 − 10 分）が 9:03 なら間に合い、9:02 なら遅れる。"""
    scenario = new_scenario([(540, 660)])
    add_show(scenario, "S", [start], x=180, duration=20, arrive_before=10, preference=4)
    result = solve_by_enumeration(scenario, new_conditions(540, 600, required_shows=["S"]))
    assert result["feasible"] is feasible
    if feasible:
        assert triple(result) == (4, 0, 6)
        assert result["plan"] == [step("S", "show", 543, performance_id="S-1")]


@pytest.mark.parametrize("window_end, feasible", [(543, True), (542, False)])
def test_acquired_slot_join_at_window_end_minus_one(window_end, feasible):
    """9:02 着。必ず使う取得済み枠が [9:00, 9:03) なら 9:02 に入れ、[9:00, 9:02) なら入れない。"""
    scenario = new_scenario([(540, 660)])
    add_attraction(scenario, "A", [None], x=120, duration=5, preference=6)
    slot = acquired_slot("G-A", "A", (540, window_end), must_use=True)
    result = solve_by_enumeration(scenario, new_conditions(540, 600, acquired_shortcuts=[slot]))
    assert result["feasible"] is feasible
    if feasible:
        assert triple(result) == (6, 0, 4)
        assert result["plan"] == [step("A", "shortcut", 542, slot_id="G-A")]


@pytest.mark.parametrize("window_end, expected", [(543, (6, 500, 4)), (542, (0, 0, 0))])
def test_offer_window_end_and_budget_equal_to_price(window_end, expected):
    """料金 500 円・予算 500 円の新規枠（予算「以下」なので使える）。枠の終了ちょうどには入れない。

    通常利用はできない（待ち時間 null）ので、枠に入れなければ何もしない予定が最善になる。
    """
    scenario = new_scenario([(540, 660)])
    add_attraction(scenario, "A", [None], x=120, duration=5, preference=6)
    add_offer(scenario, "P-A", "A", (540, window_end), price=500)
    conditions = new_conditions(540, 600, allow_new_shortcuts=True, budget_yen=500)
    assert triple(solve_by_enumeration(scenario, conditions)) == expected


@pytest.mark.parametrize("exit_time, feasible", [(549, True), (548, False)])
def test_exit_deadline_is_inclusive(exit_time, feasible):
    """9:02 着・9:07 終了・9:09 に出口。退園時刻が 9:09 なら間に合い、9:08 なら間に合わない。"""
    scenario = new_scenario([(540, 660)])
    add_attraction(scenario, "A", [0], x=120, duration=5, preference=6)
    result = solve_by_enumeration(scenario,
                                  new_conditions(540, exit_time, required_attractions=["A"]))
    assert result["feasible"] is feasible
    if feasible:
        assert triple(result) == (6, 0, 4)
        assert result["plan"] == [step("A", "normal", 542)]


@pytest.mark.parametrize("finish_by, feasible", [(547, True), (546, False)])
def test_finish_by_is_inclusive(finish_by, feasible):
    """9:02 に並び、待ち 0 分・体験 5 分で 9:07 に終わる。完了期限 9:07 なら可、9:06 なら不可。"""
    scenario = new_scenario([(540, 660)])
    add_attraction(scenario, "A", [0], x=120, duration=5, preference=6, finish_by=finish_by)
    result = solve_by_enumeration(scenario, new_conditions(540, 600, required_attractions=["A"]))
    assert result["feasible"] is feasible


@pytest.mark.parametrize("queue_close, feasible", [(543, True), (542, False)])
def test_queue_close_is_exclusive(queue_close, feasible):
    """9:02 着。列が 9:03 に閉まるなら 9:02 に並べ、9:02 に閉まるなら並べない。"""
    scenario = new_scenario([(540, 660)])
    add_attraction(scenario, "A", [0], x=120, duration=5, preference=6, queue=(540, queue_close))
    result = solve_by_enumeration(scenario, new_conditions(540, 600, required_attractions=["A"]))
    assert result["feasible"] is feasible


@pytest.mark.parametrize("band_end, feasible", [(543, True), (542, False)])
def test_wait_band_end_is_exclusive(band_end, feasible):
    """待ち 0 分の時間帯 [9:00, band_end) の後は通常利用なし（null）。9:02 着。"""
    scenario = new_scenario([(540, band_end), (band_end, 660)])
    add_attraction(scenario, "A", [0, None], x=120, duration=5, preference=6)
    result = solve_by_enumeration(scenario, new_conditions(540, 600, required_attractions=["A"]))
    assert result["feasible"] is feasible


@pytest.mark.parametrize("window_end, feasible", [(543, True), (542, False)])
def test_meal_window_end_is_exclusive(window_end, feasible):
    """9:02 着。食事を始めてよい時間帯が [9:00, 9:03) なら 9:02 に始められ、[9:00, 9:02) なら不可。"""
    scenario = new_scenario([(540, 660)])
    add_meal(scenario, "M", (540, window_end), x=120, duration=10)
    result = solve_by_enumeration(scenario, new_conditions(540, 600, required_meals=["M"]))
    assert result["feasible"] is feasible
    if feasible:
        assert triple(result) == (0, 0, 4)
        assert result["plan"] == [step("M", "meal", 542)]


def test_zero_duration_activity_at_the_exit_time():
    """所要時間 0 分・待ち 0 分なら、入園時刻 = 退園時刻 でも 1 つ回れる。"""
    scenario = new_scenario([(540, 660)])
    add_attraction(scenario, "A", [0], duration=0, preference=3)
    result = solve_by_enumeration(scenario, new_conditions(540, 540))
    assert triple(result) == (3, 0, 0)
    assert result["plan"] == [step("A", "normal", 540)]


# ------------------------------------------------------------------ 移動時間


def non_metric_walk_table():
    """三角不等式を満たさない徒歩時間の表（分）。入口→A は直接だと 20 分、B 経由なら 4 分。"""
    return {
        "entrance": {"exit": 1, "A": 20, "B": 2},
        "exit": {"entrance": 10, "A": 10, "B": 10},
        "A": {"entrance": 1, "exit": 30, "B": 10},
        "B": {"entrance": 10, "exit": 10, "A": 2},
    }


def test_travel_uses_shortest_paths_through_other_places():
    """移動時間は、他の施設や入口を通り抜ける最短経路の値（Floyd–Warshall 法）になる。"""
    scenario = new_scenario([(540, 660)])
    add_attraction(scenario, "A", [0], duration=5, preference=5)
    add_attraction(scenario, "B", [0], duration=5, preference=0)
    scenario["walk_minutes"] = non_metric_walk_table()
    travel = travel_minutes(scenario)
    assert travel["entrance"]["A"] == 4  # 入口 → B → A
    assert travel["A"]["exit"] == 2  # A → 入口 → 出口
    assert travel["exit"]["entrance"] == 10
    result = solve_by_enumeration(scenario, new_conditions(540, 600))
    assert triple(result) == (5, 0, 6)
    assert result["plan"] == [step("A", "normal", 544)]


@pytest.mark.parametrize("distance, to_a, to_b", [("manhattan", 4, 1), ("euclidean", 3, 1)])
def test_walking_minutes_are_rounded_up(distance, to_a, to_b):
    """A は (90, 120)（縦横 210 m・直線 150 m）、B は (60, 0)（60 m）。分速 60 m で 1 分未満を切り上げ。"""
    scenario = new_scenario([(540, 660)])
    add_attraction(scenario, "A", [0], x=90, y=120)
    add_attraction(scenario, "B", [0], x=60, y=0)
    scenario["walking"]["distance"] = distance
    direct = direct_walk_minutes(scenario)
    assert (direct["entrance"]["A"], direct["entrance"]["B"]) == (to_a, to_b)
    assert direct["entrance"]["exit"] == 0


@pytest.mark.parametrize("exit_time, expected", [(600, (0, 0, 2)), (541, None)])
def test_empty_plan_still_walks_from_entrance_to_exit(exit_time, expected):
    """出口が入口から 120 m（2 分）。何も回らなくても移動は 2 分で、退園まで 1 分しかなければ不可能。"""
    scenario = new_scenario([(540, 660)])
    scenario["gates"]["exit"].update({"x": 120, "y": 0})
    add_attraction(scenario, "A", [None])
    result = solve_by_enumeration(scenario, new_conditions(540, exit_time))
    if expected is None:
        assert not result["feasible"]
    else:
        assert (triple(result), result["plan"]) == (expected, [])


# ------------------------------------------------------------------ 優先順位（希望度 → 費用 → 移動）


def test_same_score_prefers_no_extra_cost():
    """通常利用でも有料枠でも同じ A に乗れるなら、追加費用 0 円の通常利用を選ぶ。"""
    scenario = new_scenario([(540, 560), (560, 660)])
    add_attraction(scenario, "A", [30, 0], duration=5, preference=5)
    add_offer(scenario, "P-A", "A", (540, 560), price=500)
    conditions = new_conditions(540, 600, allow_new_shortcuts=True, budget_yen=1000)
    result = solve_by_enumeration(scenario, conditions)
    assert triple(result) == (5, 0, 0)
    assert result["plan"][0]["mode"] == "normal"


def test_lower_extra_cost_comes_before_shorter_travel():
    """近い A1 は有料枠（500 円）でしか乗れず、遠い A2 は無料。どちらか 1 つしか回れない。

    希望度が同じなら、移動が 2 分 → 8 分に増えても、追加費用 0 円の A2 を選ぶ。
    """
    scenario = new_scenario([(540, 660)])
    add_attraction(scenario, "A1", [None], x=60, duration=30, preference=5)
    add_attraction(scenario, "A2", [0], x=240, duration=30, preference=5)
    add_offer(scenario, "P-A1", "A1", (540, 600), price=500)
    conditions = new_conditions(540, 600, allow_new_shortcuts=True, budget_yen=1000)
    result = solve_by_enumeration(scenario, conditions)
    assert triple(result) == (5, 0, 8)
    assert result["plan"] == [step("A2", "normal", 544)]


def test_same_score_and_cost_prefers_shorter_travel():
    """希望度が同じ A（2 分先）と B（1 分先）のどちらか 1 つしか回れないなら、近い B を選ぶ。"""
    scenario = new_scenario([(540, 660)])
    add_attraction(scenario, "A", [0], x=120, duration=20, preference=5)
    add_attraction(scenario, "B", [0], x=60, duration=20, preference=5)
    result = solve_by_enumeration(scenario, new_conditions(540, 570))
    assert triple(result) == (5, 0, 2)
    assert result["plan"] == [step("B", "normal", 541)]


# ------------------------------------------------------------------ 短縮枠・予算・必須・希望度


@pytest.mark.parametrize("changes, expected", [
    ({"budget_yen": 500}, (0, 0, 0)),
    ({"budget_yen": 800}, (5, 800, 0)),
    ({"budget_yen": 1000}, (5, 800, 0)),
    ({"budget_yen": 1000, "allow_new_shortcuts": False}, (0, 0, 0)),
    ({"budget_yen": 1000, "shortcut_candidates": []}, (0, 0, 0)),
    ({"budget_yen": 1000, "shortcut_candidates": ["A"]}, (5, 800, 0)),
    ({"budget_yen": 1000, "shortcut_candidates": ["B"]}, (0, 0, 0)),
])
def test_new_shortcut_rules(changes, expected):
    """A は通常利用だと待ち 60 分で 9:30 の退園に間に合わない。800 円の新規枠なら間に合う。

    予算が料金より少ない・新規の短縮利用を許さない・候補に A がない、のどれでも枠は使えない。
    """
    scenario = new_scenario([(540, 660)])
    add_attraction(scenario, "A", [60], duration=5, preference=5)
    add_attraction(scenario, "B", [None], duration=5, preference=1)
    add_offer(scenario, "P-A", "A", (540, 550), price=800)
    conditions = new_conditions(540, 570, **{"allow_new_shortcuts": True, **changes})
    assert triple(solve_by_enumeration(scenario, conditions)) == expected


@pytest.mark.parametrize("budget, expected", [
    (600, (8, 600, 0)),
    (599, (5, 300, 0)),
    (300, (5, 300, 0)),
    (299, (0, 0, 0)),
])
def test_budget_limits_the_total_extra_cost(budget, expected):
    """A・B とも通常利用では待ち 60 分で間に合わず、300 円の新規枠なら乗れる。

    予算は 1 回ごとではなく追加費用の合計に対する上限なので、600 円未満なら 1 つしか買えない。
    """
    scenario = new_scenario([(540, 660)])
    add_attraction(scenario, "A", [60], duration=5, preference=5)
    add_attraction(scenario, "B", [60], duration=5, preference=3)
    add_offer(scenario, "P-A", "A", (540, 560), price=300)
    add_offer(scenario, "P-B", "B", (540, 560), price=300)
    conditions = new_conditions(540, 570, allow_new_shortcuts=True, budget_yen=budget)
    assert triple(solve_by_enumeration(scenario, conditions)) == expected


@pytest.mark.parametrize("must_use, window, expected_plan", [
    (True, (580, 590), [step("A", "shortcut", 580, slot_id="G-A")]),
    (False, (580, 590), [step("A", "normal", 540)]),
    (True, (595, 600), None),
])
def test_acquired_slot_must_use(must_use, window, expected_plan):
    """取得済み枠（既払い 2000 円・予算 0 円・残りの待ち 3 分）。新規の短縮利用は許していない。

    must_use なら A は必須になり、待ち 0 分の通常利用ではなくその枠で乗る。既払い額は追加費用に
    数えない。枠が遅すぎて退園に間に合わなければ、A を外さず「実行不可能」になる。
    """
    scenario = new_scenario([(540, 660)])
    add_attraction(scenario, "A", [0], duration=5, preference=5)
    slot = acquired_slot("G-A", "A", window, residual=3, paid=2000, must_use=must_use)
    result = solve_by_enumeration(scenario, new_conditions(540, 600, acquired_shortcuts=[slot]))
    if expected_plan is None:
        assert not result["feasible"]
    else:
        assert triple(result) == (5, 0, 0)
        assert result["plan"] == expected_plan


def test_slot_window_is_not_limited_by_queue_hours():
    """A は 9:05 に列が閉まるが、9:20〜9:30 の取得済み枠なら入れる（枠は入列可能時間と重ねない）。"""
    scenario = new_scenario([(540, 660)])
    add_attraction(scenario, "A", [0], x=600, duration=5, preference=5, queue=(540, 545))
    slot = acquired_slot("G-A", "A", (560, 570))
    conditions = new_conditions(540, 600, required_attractions=["A"], acquired_shortcuts=[slot])
    result = solve_by_enumeration(scenario, conditions)
    assert triple(result) == (5, 0, 20)
    assert result["plan"] == [step("A", "shortcut", 560, slot_id="G-A")]


def test_show_with_two_performances_uses_the_later_one():
    """9:03 着なので 9:02 の公演には遅れ、9:20 の公演（S-2）を選ぶ。"""
    scenario = new_scenario([(540, 660)])
    add_show(scenario, "S", [542, 560], x=180, duration=10, preference=4)
    result = solve_by_enumeration(scenario, new_conditions(540, 600))
    assert triple(result) == (4, 0, 6)
    assert result["plan"] == [step("S", "show", 560, performance_id="S-2")]


@pytest.mark.parametrize("exit_time, feasible", [(600, True), (590, False)])
def test_required_activities_are_never_dropped(exit_time, feasible):
    """30 分ずつの必須 A・B。50 分しかなければ、片方を外すのではなく「実行不可能」になる。"""
    scenario = new_scenario([(540, 660)])
    add_attraction(scenario, "A", [0], duration=30, preference=0)
    add_attraction(scenario, "B", [0], duration=30, preference=0)
    conditions = new_conditions(540, exit_time, required_attractions=["A", "B"])
    result = solve_by_enumeration(scenario, conditions)
    assert result["feasible"] is feasible
    if feasible:
        assert {item["activity_id"] for item in result["plan"]} == {"A", "B"}


@pytest.mark.parametrize("changes, expected_values, expected_ids", [
    ({}, {"A": 1, "B": 2, "C": 3}, {"B", "C"}),
    ({"preference_rank": ["A", "B"]}, {"A": 2, "B": 1, "C": 0}, {"A", "B"}),
    ({"preference_rank": []}, {"A": 1, "B": 2, "C": 3}, {"B", "C"}),
    ({"preferences": {"A": 10}}, {"A": 10, "B": 2, "C": 3}, {"A", "C"}),
])
def test_preferences_and_rank(changes, expected_values, expected_ids):
    """A・B・C（希望度 1・2・3、各 5 分）のうち、10 分で回れるのは 2 つまで。

    希望順位 [A, B] なら A = 2 点・B = 1 点・C = 0 点。空の順位は「指定なし」と同じ。
    """
    scenario = new_scenario([(540, 660)])
    for activity_id, preference in (("A", 1), ("B", 2), ("C", 3)):
        add_attraction(scenario, activity_id, [0], duration=5, preference=preference)
    conditions = new_conditions(540, 550, **changes)
    assert preference_values(scenario, conditions) == expected_values
    result = solve_by_enumeration(scenario, conditions)
    assert result["score"] == sum(expected_values[item] for item in expected_ids)
    assert {item["activity_id"] for item in result["plan"]} == expected_ids


# ------------------------------------------------------------------ 大きさの制限と入力の誤り


def test_too_big_instances_raise_value_error():
    """活動が 7 個（上限 6）や、入園から退園まで 241 分（上限 240）は全列挙しない。"""
    many = new_scenario([(540, 660)])
    for number in range(7):
        add_attraction(many, f"A{number}", [0])
    with pytest.raises(ValueError):
        solve_by_enumeration(many, new_conditions(540, 600))
    small = new_scenario([(540, 900)])
    add_attraction(small, "A", [0])
    assert solve_by_enumeration(small, new_conditions(540, 780))["feasible"]
    with pytest.raises(ValueError):
        solve_by_enumeration(small, new_conditions(540, 781))
    with pytest.raises(ValueError):
        solve_by_enumeration(small, new_conditions(540, 600), max_activities=0)


def test_unknown_required_id_raises_value_error():
    """シナリオにない ID を必須にしたら、黙って無視せず ValueError にする。"""
    scenario = new_scenario([(540, 660)])
    add_attraction(scenario, "A", [0])
    with pytest.raises(ValueError):
        solve_by_enumeration(scenario, new_conditions(540, 600, required_attractions=["Z"]))


def test_duplicate_slot_ids_raise_value_error():
    """取得済み枠と新規枠の ID が同じだと、予定の slot_id がどちらか決まらないので ValueError。"""
    scenario = new_scenario([(540, 660)])
    add_attraction(scenario, "A", [0])
    add_offer(scenario, "X", "A", (540, 550), price=100)
    slot = acquired_slot("X", "A", (560, 570))
    with pytest.raises(ValueError):
        solve_by_enumeration(scenario, new_conditions(540, 600, acquired_shortcuts=[slot]))


# ------------------------------------------------------------------ 予定の計算し直し（evaluate_plan）


def test_evaluate_plan_reproduces_a_valid_plan():
    """9:02 着の A に 9:05 まで待ってから並ぶ予定（待ちは自由）。値は (6, 0, 4)。"""
    scenario = new_scenario([(540, 660)])
    add_attraction(scenario, "A", [0], x=120, duration=5, preference=6)
    check = evaluate_plan(scenario, new_conditions(540, 600), [step("A", "normal", 545)])
    assert (check["feasible"], triple(check), check["reason"]) == (True, (6, 0, 4), None)


@pytest.mark.parametrize("plan, changes, words", [
    ([step("A", "normal", 541)], {}, "before arriving"),
    ([step("A", "normal", 542), step("A", "normal", 560)], {}, "visited twice"),
    ([step("A", "shortcut", 542, slot_id="P-A")], {"budget_yen": 400}, "over the budget"),
    ([step("A", "shortcut", 543, slot_id="P-A")], {"budget_yen": 500}, "cannot join"),
    ([step("A", "shortcut", 542, slot_id="P-X")], {"budget_yen": 500}, "not allowed"),
    ([], {"required_attractions": ["A"]}, "required"),
    ([], {"exit_time": hhmm(541)}, "exit"),
])
def test_evaluate_plan_rejects_broken_plans(plan, changes, words):
    """到着前の入列・二重訪問・予算超過・枠の終了ちょうど・未知の枠・必須の欠け・退園の遅れを見つける。"""
    scenario = new_scenario([(540, 660)])
    scenario["gates"]["exit"].update({"x": 120, "y": 0})
    add_attraction(scenario, "A", [0], x=120, duration=5, preference=6)
    add_offer(scenario, "P-A", "A", (540, 543), price=500)
    conditions = new_conditions(540, 600, allow_new_shortcuts=True)
    conditions.update(changes)
    check = evaluate_plan(scenario, conditions, plan)
    assert not check["feasible"]
    assert words in check["reason"]


# ------------------------------------------------------------------ 乱数で作った極小問題での性質


def optimum_key(result):
    """最適値を比べやすい形にする。実行不可能は、どの実行可能な結果よりも小さい。"""
    if not result["feasible"]:
        return (0,)
    return (1, result["score"], -result["extra_cost"], -result["travel"])


def test_witness_plans_reproduce_the_reported_optimum():
    """正解器が返す予定の例を計算し直すと、報告した最適値と同じになる。"""
    for seed in SEEDS:
        scenario, conditions = make_tiny_instance(seed)
        result = solve_by_enumeration(scenario, conditions)
        if result["feasible"]:
            check = evaluate_plan(scenario, conditions, result["plan"])
            assert (check["feasible"], triple(check)) == (True, triple(result)), (seed, check)


def test_memoised_search_matches_plain_search():
    """メモ化した探索の最適値が、メモ化をしない素朴な全探索の最適値と一致する。"""
    for seed in SEEDS:
        scenario, conditions = make_tiny_instance(seed)
        result = solve_by_enumeration(scenario, conditions)
        plain = search_without_memo(prepare_instance(scenario, conditions), earliest_only=False)
        expected = None
        if result["feasible"]:
            expected = (result["score"], -result["extra_cost"], -result["travel"])
        assert plain == expected, seed


RELAXATIONS = {
    "later_exit": lambda c: {"exit_time": hhmm(to_minutes(c["exit_time"]) + 7)},
    "bigger_budget": lambda c: {"budget_yen": c["budget_yen"] + 500},
    "nothing_required": lambda c: {"required_attractions": [], "required_shows": [],
                                   "required_meals": []},
    "new_shortcuts_allowed": lambda c: {"allow_new_shortcuts": True, "shortcut_candidates": None},
}


@pytest.mark.parametrize("name", sorted(RELAXATIONS))
def test_relaxing_a_condition_never_makes_the_optimum_worse(name):
    """退園を遅らせる・予算を増やす・必須を外す・短縮利用を許すと、最適値は同じか良くなる。"""
    for seed in SEEDS:
        scenario, conditions = make_tiny_instance(seed)
        relaxed = dict(conditions, **RELAXATIONS[name](conditions))
        before = solve_by_enumeration(scenario, conditions)
        after = solve_by_enumeration(scenario, relaxed)
        assert optimum_key(after) >= optimum_key(before), seed
