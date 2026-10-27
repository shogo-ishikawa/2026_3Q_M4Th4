"""時刻の変換と、入力データの読み込み・確認のテスト。

時刻は、入力では "HH:MM"、計算では 0:00 からの分（整数）を使います（例: 09:30 → 570）。
時間帯 "10:00-11:00" は [開始, 終了) の意味で、開始ちょうどは含み、終了ちょうどは含みません。
入力の誤りは、日本語の説明を並べた InputError になることを確かめます。
"""

import copy
import json
import re

import pytest

from park_itinerary_lab.data import (
    InputError,
    load_scenario,
    load_scenario_csv,
    prepare_problem,
    scenario_dict_from_csv,
    scenario_from_dict,
    travel_matrix,
)
from park_itinerary_lab.timeutil import format_time, format_window, in_window, parse_time, parse_window
from park_itinerary_lab.validate import validate_plan

_JAPANESE = re.compile(r"[぀-ヿ㐀-鿿]")


def has_japanese(text):
    """ひらがな・カタカナ・漢字を1文字以上含むか。"""
    return bool(_JAPANESE.search(text))


# ---------------------------------------------------------------------------
# 時刻と時間帯
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "minutes"),
    [("09:30", 570), ("9:05", 545), ("00:00", 0), ("24:00", 1440), (" 10:15 ", 615), ("47:59", 2879)],
)
def test_parse_time_converts_hh_mm_to_minutes(text, minutes):
    """'HH:MM' を 0:00 からの分に変換する（24:00 以降も終了時刻として使える）。"""
    assert parse_time(text) == minutes


def test_parse_time_accepts_integer_minutes():
    """整数は、すでに分で書かれた時刻としてそのまま使う。"""
    assert parse_time(600) == 600
    assert parse_time(0) == 0


@pytest.mark.parametrize("value", ["9:5", "09-30", "10:60", "48:00", "", "朝9時", "09:30:00", -1, True, 9.5, None])
def test_parse_time_rejects_invalid_values_with_japanese_message(value):
    """形式や範囲の誤りは ValueError（日本語の説明つき）。"""
    with pytest.raises(ValueError) as info:
        parse_time(value)
    assert has_japanese(str(info.value))


def test_format_time_is_the_inverse_of_parse_time():
    """分 → 'HH:MM' → 分 で元に戻る。None は空文字列で表示する。"""
    for minutes in range(0, 48 * 60, 7):
        assert parse_time(format_time(minutes)) == minutes
    assert format_time(570) == "09:30"
    assert format_time(None) == ""


@pytest.mark.parametrize(
    "value",
    ["10:00-11:00", " 10:00 - 11:00 ", {"start": "10:00", "end": "11:00"}, ["10:00", "11:00"], (600, 660)],
)
def test_parse_window_accepts_text_dict_and_pairs(value):
    """時間帯は文字列・辞書・2要素の組のどれでも書ける。"""
    assert parse_window(value) == (600, 660)


@pytest.mark.parametrize("value", ["11:00-10:00", "10:00-10:00", "10:00", "10:00-11:00-12:00", 600, None, ["10:00"]])
def test_parse_window_rejects_empty_reversed_or_malformed(value):
    """開始 ≥ 終了（長さ0の時間帯）や形式の誤りは ValueError。"""
    with pytest.raises(ValueError) as info:
        parse_window(value)
    assert has_japanese(str(info.value))


def test_window_is_half_open_start_included_end_excluded():
    """[開始, 終了): 開始ちょうどと終了の1分前は入り、終了ちょうどは入らない。"""
    window = parse_window("10:00-11:00")
    assert not in_window(parse_time("09:59"), window)
    assert in_window(parse_time("10:00"), window)
    assert in_window(parse_time("10:59"), window)
    assert not in_window(parse_time("11:00"), window)
    assert format_window(window) == "10:00-11:00"
    assert format_window(None) == ""


# ---------------------------------------------------------------------------
# デモとテンプレートの読み込み
# ---------------------------------------------------------------------------


def test_demo_json_loads_with_separate_ids_and_display_names(demo_scenario):
    """デモ（configs/demo_park.json）を読み込める。IDと表示名は別の項目。"""
    scenario = demo_scenario
    assert scenario.meta["source_type"] == "fictional"
    assert scenario.cost_basis == "per_person"
    assert list(scenario.attractions) == [f"A{number}" for number in range(1, 9)]
    assert list(scenario.shows) == ["S1", "S2"]
    assert list(scenario.meals) == ["M1"]
    assert set(scenario.wait_tables) == {"quiet", "normal", "busy"}
    assert len(scenario.offers) == 8
    assert all(not offer.acquired for offer in scenario.offers.values())
    a1 = scenario.attractions["A1"]
    assert a1.name != a1.id
    assert (a1.queue_open, a1.queue_close) == (parse_time("09:00"), parse_time("20:30"))
    performances = [(p.id, p.start) for p in scenario.shows["S1"].performances]
    assert performances == [("S1-1100", parse_time("11:00")), ("S1-1500", parse_time("15:00"))]
    assert scenario.meals["M1"].window == parse_window("11:00-14:00")
    # A8 は 18:00 以降の通常利用の値が null（通常利用できない時間帯）
    assert scenario.wait_tables["normal"].waits["A8"][-3:] == (None, None, None)


def test_demo_travel_minutes_come_from_coordinates(demo_scenario):
    """徒歩の分数 = 縦横の道に沿った距離 ÷ 分速 60 m（1分未満は切り上げ）。"""
    travel = travel_matrix(demo_scenario)
    # A1 は (-360, 540)。入口 (0, 0) から 900 m なので 15 分。
    assert travel["entrance"]["A1"] == 15
    assert travel["A1"]["entrance"] == 15
    # A3 (-150, 240) と A5 (-300, 120): 150 + 120 = 270 m → 4.5 分 → 5 分
    assert travel["A3"]["A5"] == 5
    assert travel["A1"]["A1"] == 0


def test_demo_conditions_prepare_a_problem_without_warnings(demo_scenario, demo_conditions):
    """デモの標準条件から計算用の Problem を作れる（データの注意点もない）。"""
    problem = prepare_problem(demo_scenario, demo_conditions)
    assert (problem.entry, problem.exit) == (parse_time("09:00"), parse_time("18:00"))
    assert problem.required == frozenset({"S1", "M1"})
    assert problem.budget == 2000
    assert problem.wait_table.key == "normal"
    assert problem.warnings == []


def test_csv_template_folder_loads(project_dir):
    """data/templates/csv の CSV 一式を読み込める（空欄は「値なし」）。"""
    scenario = load_scenario_csv(project_dir / "data" / "templates" / "csv")
    assert scenario.meta["source_type"] == "fictional"
    assert list(scenario.attractions) == ["T1", "T2", "T3"]
    assert scenario.attractions["T1"].name == "記入例のコースター"
    assert set(scenario.wait_tables) == {"weekday", "holiday"}
    weekday = scenario.wait_tables["weekday"]
    assert len(weekday.bands) == 11
    assert weekday.bands[0] == parse_window("09:00-10:00")
    assert weekday.waits["T1"][0] == 20
    assert weekday.waits["T3"][-1] is None
    assert set(scenario.offers) == {"P-T1-11", "P-T1-15"}
    assert scenario.offers["P-T1-11"].window == parse_window("11:00-12:00")
    assert [p.id for p in scenario.shows["SH1"].performances] == ["SH1-1200", "SH1-1600"]
    assert scenario.meals["L1"].window == parse_window("11:00-14:00")


def test_csv_template_converts_to_the_same_dictionary_format_as_json(project_dir):
    """CSV フォルダは JSON と同じ形の辞書に変換され、JSON に書き出して読み直しても同じに使える。"""
    raw = scenario_dict_from_csv(project_dir / "data" / "templates" / "csv")
    with (project_dir / "data" / "templates" / "scenario_template.json").open(encoding="utf-8") as file:
        template = json.load(file)
    assert set(template) - {"walk_minutes"} <= set(raw)
    again = scenario_from_dict(json.loads(json.dumps(raw, ensure_ascii=False)))
    assert list(again.attractions) == ["T1", "T2", "T3"]


def test_json_template_loads_and_prepares(project_dir):
    """data/templates/scenario_template.json を読み込み、条件と組み合わせられる。"""
    scenario = load_scenario(project_dir / "data" / "templates" / "scenario_template.json")
    problem = prepare_problem(scenario, {"entry_time": "09:00", "exit_time": "20:00", "season": "weekday"})
    assert set(problem.activity_ids()) == {"T1", "T2", "SH1", "L1"}
    assert problem.travel["entrance"]["T1"] == 9  # (-200, 300) まで 500 m → 8.33 分 → 9 分


def test_csv_template_can_be_solved_end_to_end(project_dir, solve):
    """CSV で差し替えたデータでも、そのまま予定を計算できる。"""
    scenario = load_scenario_csv(project_dir / "data" / "templates" / "csv")
    conditions = {"entry_time": "09:00", "exit_time": "13:00", "season": "weekday", "required_shows": ["SH1"]}
    result = solve(scenario, conditions)
    assert result.status == "optimal"
    assert result.validation.ok
    assert "SH1" in [step.activity_id for step in result.steps]


# ---------------------------------------------------------------------------
# 条件の誤り（InputError）
# ---------------------------------------------------------------------------

OWN_SLOT = {"id": "OWN1", "attraction": "A2", "window": "13:00-14:00", "residual_wait_min": 5, "paid_yen": 1000}

CONDITION_ERRORS = [
    pytest.param({"budget": 1000}, "不明な設定項目です: 'budget'", id="unknown-key"),
    pytest.param({"entry_time": "9時"}, "entry_time", id="bad-entry-time"),
    pytest.param({"exit_time": "25:99"}, "exit_time", id="bad-exit-time"),
    pytest.param({"entry_time": "18:00", "exit_time": "18:00"}, "入園時刻は退園時刻より前", id="entry-equals-exit"),
    pytest.param({"entry_time": "19:00", "exit_time": "18:00"}, "入園時刻は退園時刻より前", id="entry-after-exit"),
    pytest.param({"season": "winter"}, "season", id="unknown-season"),
    pytest.param({"required_attractions": ["Z9"]}, "'Z9' は施設のIDではありません", id="unknown-attraction"),
    pytest.param({"required_attractions": ["S1"]}, "'S1' は施設のIDではありません", id="show-in-attraction-list"),
    pytest.param({"required_shows": ["A1"]}, "'A1' はショーのIDではありません", id="attraction-in-show-list"),
    pytest.param({"required_meals": ["S2"]}, "'S2' は食事・休憩のIDではありません", id="show-in-meal-list"),
    pytest.param({"required_attractions": ["A1", "A1"]}, "重複", id="duplicate-required"),
    pytest.param({"preferences": {"A1": 3}, "preference_rank": ["A1"]}, "どちらか一方だけ", id="preferences-and-rank"),
    pytest.param({"preferences": {"Z9": 3}}, "'Z9' という活動はありません", id="unknown-preference-id"),
    pytest.param({"preferences": {"A1": 2.5}}, "整数", id="non-integer-preference"),
    pytest.param({"preference_rank": ["A1", "A1"]}, "重複のない", id="duplicate-rank"),
    pytest.param({"preference_rank": ["Z9"]}, "'Z9' という活動はありません", id="unknown-rank-id"),
    pytest.param({"purchase_rules": ["next_purchase_after_120_min"]}, "未実装の購入ルール", id="purchase-rules"),
    pytest.param({"acquired_shortcuts": [OWN_SLOT]}, "must_use", id="missing-must-use"),
    pytest.param({"cost_basis": "group_total"}, "とデータの cost_basis", id="cost-basis-mismatch"),
    pytest.param(
        {"acquired_shortcuts": [dict(OWN_SLOT, must_use=True), dict(OWN_SLOT, id="OWN2", window="15:00-16:00", must_use=True)]},
        "同じ施設に「必ず使う」取得済み枠が複数",
        id="two-must-use-slots-on-one-attraction",
    ),
    pytest.param({"acquired_shortcuts": [dict(OWN_SLOT, id="P-A1-10", must_use=False)]}, "重複", id="slot-id-clash"),
    pytest.param(
        {"acquired_shortcuts": [dict(OWN_SLOT, attraction="Z9", must_use=False)]}, "'Z9' がありません", id="slot-unknown-attraction"
    ),
    pytest.param({"budget_yen": -100}, "budget_yen", id="negative-budget"),
    pytest.param({"budget_yen": 1000.5}, "整数", id="non-integer-budget"),
    pytest.param({"party_size": 0}, "party_size", id="party-size-zero"),
    pytest.param({"allow_new_shortcuts": "yes"}, "allow_new_shortcuts", id="non-bool-allow"),
    pytest.param({"shortcut_candidates": ["S1"]}, "施設のIDではありません", id="candidate-not-attraction"),
    pytest.param({"shortcut_candidates": "A1"}, "shortcut_candidates", id="candidates-not-a-list"),
]


@pytest.mark.parametrize(("changes", "expected"), CONDITION_ERRORS)
def test_condition_errors_raise_input_error_in_japanese(demo_scenario, demo_conditions, changes, expected):
    """条件の誤りは InputError になり、どこが誤りかを日本語で説明する。"""
    conditions = dict(demo_conditions, **changes)
    with pytest.raises(InputError) as info:
        prepare_problem(demo_scenario, conditions)
    problems = info.value.problems
    assert any(expected in problem for problem in problems), problems
    assert all(has_japanese(problem) for problem in problems)
    assert str(info.value).startswith("入力に問題があります")
    assert isinstance(info.value, ValueError)


def test_all_condition_errors_are_reported_together(demo_scenario):
    """誤りが複数あれば、1つ目で止まらずにまとめて知らせる。"""
    conditions = {"entry_time": "9時", "exit_time": "18:00", "season": "normal", "colour": "red", "required_shows": ["A1"]}
    with pytest.raises(InputError) as info:
        prepare_problem(demo_scenario, conditions)
    assert len(info.value.problems) == 3


def test_prepare_problem_does_not_change_the_inputs(demo_scenario, demo_conditions):
    """条件の辞書もシナリオも書き換えない（設定を変えて再実行しても前の値が混ざらない）。"""
    conditions = dict(demo_conditions, preferences={"A1": 1})
    before = copy.deepcopy(conditions)
    prepare_problem(demo_scenario, conditions)
    assert conditions == before
    assert demo_scenario.attractions["A1"].preference == 9


def test_condition_defaults(demo_scenario):
    """省略した条件の既定値: 予算0円、短縮利用は検討しない、必須なし、費用は1人分。"""
    problem = prepare_problem(demo_scenario, {"entry_time": "09:00", "exit_time": "18:00", "season": "quiet"})
    assert problem.budget == 0
    assert problem.allow_new_shortcuts is False
    assert problem.slots == {}
    assert problem.required == frozenset()
    assert problem.must_use_slots == frozenset()
    assert problem.cost_basis == "per_person"
    assert problem.party_size == 1
    assert problem.shortcut_candidates is None


def _scenario_error_cases():
    """シナリオ（パークのデータ）の誤り: (名前, 元の辞書を書き換える関数, 期待する説明の一部)。"""
    return [
        ("format-version", lambda raw: raw.update(format_version=2), "format_version"),
        ("duplicate-attraction-id", lambda raw: raw["attractions"][1].update(id="A1"), "重複"),
        ("show-id-equals-attraction-id", lambda raw: raw["shows"][0].update(id="A1"), "重複"),
        ("gate-name-as-id", lambda raw: raw["attractions"][0].update(id="exit"), "入口・出口用"),
        ("space-in-id", lambda raw: raw["attractions"][0].update(id="A 1"), "英数字"),
        ("queue-window-reversed", lambda raw: raw["attractions"][0].update(queue_open="21:00"), "queue_open"),
        ("negative-duration", lambda raw: raw["attractions"][0].update(duration_min=-3), "duration_min"),
        ("wait-count", lambda raw: raw["wait_tables"]["normal"]["wait_min"]["A1"].pop(), "時間帯と同じ数"),
        ("overlapping-bands", lambda raw: raw["wait_tables"]["normal"]["bands"].__setitem__(1, "09:30-11:00"), "重なっています"),
        ("offer-unknown-attraction", lambda raw: raw["shortcut_offers"][0].update(attraction="Z9"), "'Z9' がありません"),
        ("offer-window-reversed", lambda raw: raw["shortcut_offers"][0].update(window="11:00-10:00"), "開始は終了より前"),
        ("show-without-performances", lambda raw: raw["shows"][0].update(performances=[]), "performances"),
        ("source-type", lambda raw: raw["meta"].update(source_type="official"), "source_type"),
        ("cost-basis", lambda raw: raw.update(cost_basis="per_family"), "cost_basis"),
        ("distance-method", lambda raw: raw["walking"].update(distance="crow"), "walking.distance"),
    ]


@pytest.mark.parametrize(
    ("change", "expected"),
    [pytest.param(change, expected, id=name) for name, change, expected in _scenario_error_cases()],
)
def test_scenario_errors_raise_input_error_in_japanese(demo_raw, change, expected):
    """パークのデータの誤りも InputError（日本語の説明つき）になる。"""
    change(demo_raw)
    with pytest.raises(InputError) as info:
        scenario_from_dict(demo_raw)
    assert any(expected in problem for problem in info.value.problems), info.value.problems
    assert all(has_japanese(problem) for problem in info.value.problems)


def test_walk_minutes_must_cover_every_pair(make_scenario):
    """移動時間の表（walk_minutes）に抜けている組があれば InputError。"""
    raw = make_scenario(attractions=[{"id": "X", "duration_min": 5, "preference": 1}])
    del raw["walk_minutes"]["entrance"]["X"]
    with pytest.raises(InputError) as info:
        scenario_from_dict(raw)
    assert any("walk_minutes[entrance][X]" in problem for problem in info.value.problems)


# ---------------------------------------------------------------------------
# 希望度
# ---------------------------------------------------------------------------


def test_preference_rank_gives_n_points_to_first_and_zero_to_unlisted(demo_scenario, demo_conditions):
    """n 件の希望順位: 1位は n、2位は n−1 …、一覧にない活動は 0。"""
    problem = prepare_problem(demo_scenario, dict(demo_conditions, preference_rank=["A3", "S2", "A1"]))
    assert problem.preferences["A3"] == 3
    assert problem.preferences["S2"] == 2
    assert problem.preferences["A1"] == 1
    unlisted = set(problem.activity_ids()) - {"A3", "S2", "A1"}
    assert unlisted and all(problem.preferences[activity_id] == 0 for activity_id in unlisted)


def test_preferences_override_only_the_listed_activities(demo_scenario, demo_conditions):
    """preferences で書いた活動だけ希望度を変え、ほかはデータの値のまま。"""
    problem = prepare_problem(demo_scenario, dict(demo_conditions, preferences={"A1": 2, "M1": 4}))
    assert problem.preferences["A1"] == 2
    assert problem.preferences["M1"] == 4
    assert problem.preferences["A2"] == demo_scenario.attractions["A2"].preference
    assert problem.preferences["S1"] == demo_scenario.shows["S1"].preference


# ---------------------------------------------------------------------------
# 移動時間（最短経路）
# ---------------------------------------------------------------------------


def test_walk_minutes_are_replaced_by_shortest_paths_with_a_warning(make_scenario, make_conditions):
    """表の値より別の地点を通る道が短ければ、短い方を使い、そのことを注意として知らせる。"""
    raw = make_scenario(
        attractions=[{"id": "X", "duration_min": 5, "preference": 1}, {"id": "Y", "duration_min": 5, "preference": 1}],
        walk={
            ("entrance", "exit"): 0,
            ("entrance", "X"): 5,
            ("X", "exit"): 5,
            ("X", "Y"): 5,
            ("entrance", "Y"): 20,
            ("Y", "exit"): 20,
        },
    )
    scenario = scenario_from_dict(raw)
    assert travel_matrix(scenario)["entrance"]["Y"] == 20  # 入力した表の値
    problem = prepare_problem(scenario, make_conditions())
    assert problem.travel["entrance"]["Y"] == 10  # 入口 → X → Y
    assert problem.travel["Y"]["exit"] == 10
    assert problem.travel["entrance"]["X"] == 5  # 短い道がない組は変わらない
    assert any("entrance→Y" in warning and "10 分として計算" in warning for warning in problem.warnings)
    # 検証関数も同じ最短の移動時間を使う: 入口 → Y（10分）→ 出口（10分）
    report = validate_plan(problem, [{"activity_id": "Y", "mode": "normal", "queue_time": parse_time("09:10")}])
    assert report.ok, report.errors
    assert report.metrics["travel_min"] == 20


def test_missing_wait_values_give_a_warning_not_an_error(make_scenario, make_conditions):
    """待ち時間表に値がない（null）時間帯は、通常利用できない時間帯として注意を出す。"""
    raw = make_scenario(
        attractions=[{"id": "X", "duration_min": 5, "preference": 1}],
        bands=("09:00-10:00", "10:00-11:00"),
        waits={"X": [10, None]},
    )
    problem = prepare_problem(scenario_from_dict(raw), make_conditions(exit="11:00"))
    assert any("'X'" in warning and "60 分" in warning for warning in problem.warnings)


# ---------------------------------------------------------------------------
# 短縮利用の枠（仮定枠・取得済み枠）と候補の絞り込み
# ---------------------------------------------------------------------------

ALL_OFFERS = {"P-A1-10", "P-A1-13", "P-A1-16", "P-A4-11", "P-A4-14", "P-A4-17", "P-A6-12", "P-A6-15"}


@pytest.mark.parametrize(
    ("allow", "candidates", "expected"),
    [
        pytest.param(False, None, set(), id="not-allowed"),
        pytest.param(False, ["A1"], set(), id="not-allowed-even-with-candidates"),
        pytest.param(True, None, ALL_OFFERS, id="allowed-no-restriction"),
        pytest.param(True, [], set(), id="allowed-empty-candidates"),
        pytest.param(True, ["A4"], {"P-A4-11", "P-A4-14", "P-A4-17"}, id="allowed-one-candidate"),
        pytest.param(True, ["A4", "A6"], {"P-A4-11", "P-A4-14", "P-A4-17", "P-A6-12", "P-A6-15"}, id="two-candidates"),
        pytest.param(True, ["A2"], set(), id="candidate-without-offers"),
    ],
)
def test_offers_follow_allow_flag_and_shortcut_candidates(demo_scenario, demo_conditions, allow, candidates, expected):
    """仮定枠は allow_new_shortcuts=True のときだけ使え、候補（None は制限なし、[] は0件）で絞られる。"""
    conditions = dict(demo_conditions, allow_new_shortcuts=allow, shortcut_candidates=candidates)
    problem = prepare_problem(demo_scenario, conditions)
    assert set(problem.slots) == expected
    assert problem.shortcut_candidates == (None if candidates is None else tuple(candidates))


def test_acquired_slots_are_kept_without_new_shortcuts_and_must_use_makes_required(demo_scenario, demo_conditions):
    """取得済み枠は、短縮利用を検討しない設定や候補の絞り込みに関係なく使える。必ず使う枠の施設は必須になる。"""
    own = dict(OWN_SLOT, paid_yen=1500, must_use=True)
    conditions = dict(demo_conditions, allow_new_shortcuts=False, shortcut_candidates=[], acquired_shortcuts=[own])
    problem = prepare_problem(demo_scenario, conditions)
    assert set(problem.slots) == {"OWN1"}
    slot = problem.slots["OWN1"]
    assert slot.acquired and slot.must_use
    assert (slot.price, slot.paid) == (0, 1500)  # 今回の追加費用は0円、既払い額は別に持つ
    assert problem.must_use_slots == frozenset({"OWN1"})
    assert "A2" in problem.required
    assert problem.already_paid() == 1500


def test_optional_acquired_slot_does_not_make_the_attraction_required(demo_scenario, demo_conditions):
    """must_use=False の取得済み枠は、使うかどうかを最適化に任せる（施設を必須にしない）。"""
    problem = prepare_problem(demo_scenario, dict(demo_conditions, acquired_shortcuts=[dict(OWN_SLOT, must_use=False)]))
    assert "OWN1" in problem.slots
    assert problem.must_use_slots == frozenset()
    assert "A2" not in problem.required
