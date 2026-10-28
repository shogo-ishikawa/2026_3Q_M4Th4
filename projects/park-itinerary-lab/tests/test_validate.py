"""検証関数（validate.py）のテスト。

本物の最適な予定（デモ）を検証関数に通すと問題なしになり、ソルバーの値とも一致することを確かめます。
次に、その予定の写しを1か所ずつ壊し、壊した点を検証関数が必ず見つけることを確かめます。
（元の予定はモジュールの中で共有するので、書き換えずに写しを作ります。）
"""

import copy
from collections import defaultdict
from dataclasses import replace

import pytest

from park_itinerary_lab.data import load_scenario, prepare_problem, scenario_from_dict
from park_itinerary_lab.timeutil import format_time, format_window, in_window
from park_itinerary_lab.timeutil import parse_time as hhmm
from park_itinerary_lab.validate import compare_with_solver, normal_wait_at, validate_plan

# デモの標準条件（ショー S1 と昼食 M1 が必須）
FULL_DAY = {
    "entry_time": "09:00",
    "exit_time": "18:00",
    "season": "normal",
    "budget_yen": 2000,
    "allow_new_shortcuts": True,
    "required_shows": ["S1"],
    "required_meals": ["M1"],
}
# 午前だけの条件（予算 2000 円）。最適な予定は有料の短縮利用を使う。
MORNING = {"entry_time": "09:00", "exit_time": "13:00", "season": "normal", "budget_yen": 2000, "allow_new_shortcuts": True}


@pytest.fixture(scope="module")
def scenario(demo_scenario_path):
    return load_scenario(demo_scenario_path)


@pytest.fixture(scope="module")
def full_day(scenario, solve):
    """デモの標準条件で解いた、最適な予定。"""
    result = solve(scenario, FULL_DAY)
    assert result.status == "optimal"
    return result


@pytest.fixture(scope="module")
def morning(scenario, solve):
    """午前だけの条件で解いた、最適な予定（短縮利用を含む）。"""
    result = solve(scenario, MORNING)
    assert result.status == "optimal"
    assert any(step.mode == "shortcut" for step in result.steps)
    return result


def changed(steps, index, **changes):
    """index 番目の項目だけを変えた、予定の写しを作る。"""
    copied = list(steps)
    copied[index] = replace(copied[index], **changes)
    return copied


def index_of(steps, condition):
    """condition を満たす最初の項目の番号。"""
    return next(index for index, step in enumerate(steps) if condition(step))


def errors_after(problem, steps):
    """検証関数を通し、誤りがあることを確かめてから、その説明のリストを返す。"""
    report = validate_plan(problem, steps)
    assert not report.ok
    return report.errors


# ---------------------------------------------------------------------------
# 本物の予定
# ---------------------------------------------------------------------------


def test_real_optimal_plan_passes_validation_and_matches_the_solver(full_day):
    """最適な予定は検証関数で問題なしになり、希望度・費用・移動時間がソルバーの値と一致する。"""
    report = validate_plan(full_day.problem, full_day.steps)
    assert report.ok and report.errors == []
    assert compare_with_solver(full_day, report) == []
    assert report.metrics["score"] == full_day.objective_values["score"]
    assert report.metrics["extra_cost_yen"] == full_day.objective_values["extra_cost"]
    assert report.metrics["travel_min"] == full_day.objective_values["travel"]
    assert report.required_status == {"M1": True, "S1": True}


@pytest.mark.parametrize("fixture_name", ["full_day", "morning"])
def test_stage_objectives_agree_with_the_recomputed_plan(request, fixture_name):
    """各段階の目的値（希望度・追加費用・移動時間・補助の出口への到着時刻）は、計算し直した値と一致する。"""
    result = request.getfixturevalue(fixture_name)
    metrics = validate_plan(result.problem, result.steps).metrics
    recomputed = {
        "score": metrics["score"],
        "extra_cost": metrics["extra_cost_yen"],
        "travel": metrics["travel_min"],
        "exit_arrival": metrics["exit_arrival"],
    }
    assert [stage.name for stage in result.stages] == list(recomputed)
    for stage in result.stages:
        assert stage.proven, stage.name
        assert stage.objective == stage.bound == recomputed[stage.name], stage.name


def test_plan_with_shortcuts_passes_validation(morning):
    """短縮利用を使う予定も問題なし。枠の時間帯に入場し、料金を追加費用に数え、予算内に収まる。"""
    report = validate_plan(morning.problem, morning.steps)
    assert report.ok, report.errors
    assert compare_with_solver(morning, report) == []
    shortcut_rows = [row for row in report.rows if row["mode_key"] == "shortcut_offer"]
    assert shortcut_rows
    for row in shortcut_rows:
        slot = morning.problem.slots[row["slot_id"]]
        assert in_window(row["queue_time"], slot.window)
        assert row["cost_yen"] == slot.price
    assert report.metrics["extra_cost_yen"] == sum(row["cost_yen"] for row in report.rows)
    assert 0 < report.metrics["extra_cost_yen"] <= morning.problem.budget


def test_rows_are_recomputed_from_order_mode_and_queue_time(full_day):
    """各行の時刻は、訪問順・利用方法・並び始めの時刻だけから計算し直した値になっている。"""
    problem = full_day.problem
    report = validate_plan(problem, full_day.steps)
    clock, place = problem.entry, "entrance"
    for row in report.rows:
        activity = problem.activity(row["activity_id"])
        assert row["depart"] == clock
        assert row["travel_min"] == problem.travel[place][row["activity_id"]]
        assert row["arrival"] == clock + row["travel_min"]
        assert row["idle_min"] == row["queue_time"] - row["arrival"] >= 0
        if row["mode_key"] == "normal":
            assert row["wait_min"] == normal_wait_at(problem.wait_table, row["activity_id"], row["queue_time"])
        if row["kind"] == "show":
            start = next(p.start for p in activity.performances if p.id == row["performance_id"])
            assert row["queue_time"] == start - activity.arrive_before
            assert row["start"] == start
        else:
            assert row["start"] == row["queue_time"] + row["wait_min"]
        assert row["end"] == row["start"] + activity.duration
        clock, place = row["end"], row["activity_id"]
    assert report.metrics["exit_arrival"] == clock + problem.travel[place]["exit"]


def test_segments_are_contiguous_from_entry_to_exit_arrival(full_day):
    """時間の流れ（移動・待機・待ち・体験…）は、入園から出口への到着まで切れ目なくつながる。"""
    report = validate_plan(full_day.problem, full_day.steps)
    segments = report.segments
    assert segments[0]["start"] == report.metrics["entry_time"] == full_day.problem.entry
    assert segments[-1]["end"] == report.metrics["exit_arrival"]
    assert segments[-1]["activity_id"] == "exit"
    for before, after in zip(segments, segments[1:]):
        assert before["end"] == after["start"]
    for segment in segments:
        assert segment["minutes"] == segment["end"] - segment["start"] >= 0
    total = sum(segment["minutes"] for segment in segments)
    assert total == report.metrics["exit_arrival"] - report.metrics["entry_time"]


def test_metrics_add_up(full_day):
    """合計の値は、行と時間の流れを足し合わせた値と一致する。"""
    report = validate_plan(full_day.problem, full_day.steps)
    minutes = defaultdict(int)
    for segment in report.segments:
        minutes[segment["kind"]] += segment["minutes"]
    metrics = report.metrics
    assert metrics["travel_min"] == minutes["travel"]
    assert metrics["idle_min"] == minutes["idle"]
    assert metrics["queue_wait_min"] == minutes["queue"]
    assert metrics["preshow_wait_min"] == minutes["preshow"]
    assert metrics["score"] == sum(row["preference"] for row in report.rows)
    assert metrics["extra_cost_yen"] == sum(row["cost_yen"] for row in report.rows)
    assert metrics["total_cost_yen"] == metrics["already_paid_yen"] + metrics["extra_cost_yen"]
    assert metrics["n_activities"] == len(report.rows)
    busy = minutes["ride"] + minutes["show"] + minutes["meal"]
    used = metrics["travel_min"] + metrics["idle_min"] + metrics["queue_wait_min"] + metrics["preshow_wait_min"] + busy
    assert used == metrics["exit_arrival"] - metrics["entry_time"]


def test_empty_plan_is_valid_only_without_requirements(scenario):
    """何も訪れない予定は、必須項目がなければ成立し、必須項目があれば誤りになる。"""
    free = prepare_problem(scenario, {"entry_time": "09:00", "exit_time": "18:00", "season": "normal"})
    report = validate_plan(free, [])
    assert report.ok
    assert report.metrics["exit_arrival"] == free.entry + free.travel["entrance"]["exit"]
    assert report.metrics["score"] == 0
    strict = validate_plan(prepare_problem(scenario, FULL_DAY), [])
    assert not strict.ok
    assert strict.required_status == {"M1": False, "S1": False}


def test_normal_wait_at_uses_half_open_bands(scenario):
    """通常の待ち時間は、並び始めた時刻を含む時間帯 [開始, 終了) の値。値がなければ None。"""
    table = scenario.wait_tables["normal"]
    assert normal_wait_at(table, "A1", hhmm("09:59")) == 30
    assert normal_wait_at(table, "A1", hhmm("10:00")) == 60
    assert normal_wait_at(table, "A8", hhmm("18:00")) is None  # 表の値が null
    assert normal_wait_at(table, "A1", hhmm("21:00")) is None  # 表の時間帯の外
    assert normal_wait_at(table, "Z9", hhmm("10:00")) is None  # 表にない施設


# ---------------------------------------------------------------------------
# 壊した予定（写し）を検証関数が見つける
# ---------------------------------------------------------------------------


def test_detects_joining_the_queue_before_arrival(full_day):
    """到着より前に並び始めることはできない。"""
    arrival = validate_plan(full_day.problem, full_day.steps).rows[0]["arrival"]
    errors = errors_after(full_day.problem, changed(full_day.steps, 0, queue_time=arrival - 1))
    assert any(f"到着 {format_time(arrival)} より前の" in error for error in errors)


def test_detects_a_wrong_show_meeting_time(full_day):
    """ショーの集合時刻（開演の arrive_before 分前）からずれた予定は誤り。"""
    index = index_of(full_day.steps, lambda step: step.kind == "show")
    late_meeting = full_day.steps[index].queue_time + 1
    errors = errors_after(full_day.problem, changed(full_day.steps, index, queue_time=late_meeting))
    assert any("集合時刻" in error for error in errors)


def test_detects_an_unknown_performance(full_day):
    """存在しない公演回は誤り。"""
    index = index_of(full_day.steps, lambda step: step.kind == "show")
    errors = errors_after(full_day.problem, changed(full_day.steps, index, performance_id="S1-0000"))
    assert any("公演回 S1-0000 がありません" in error for error in errors)


def test_detects_a_slot_used_outside_its_window(morning):
    """短縮利用の枠の時間帯の外に入場する予定は誤り。"""
    problem = morning.problem
    index = index_of(morning.steps, lambda step: step.mode == "shortcut")
    step = morning.steps[index]
    other = next(
        slot for slot in problem.slots.values()
        if slot.attraction_id == step.activity_id and not in_window(step.queue_time, slot.window)
    )
    errors = errors_after(problem, changed(morning.steps, index, slot_id=other.id))
    assert any(f"枠 {format_window(other.window)} の外" in error for error in errors)


def test_detects_a_slot_of_another_attraction(morning):
    """別の施設の枠で入場する予定は誤り。"""
    problem = morning.problem
    index = index_of(morning.steps, lambda step: step.mode == "shortcut")
    step = morning.steps[index]
    other = next(slot for slot in problem.slots.values() if slot.attraction_id != step.activity_id)
    errors = errors_after(problem, changed(morning.steps, index, slot_id=other.id))
    assert any("別の施設" in error for error in errors)


@pytest.mark.parametrize("changes", [{"allow_new_shortcuts": False}, {"shortcut_candidates": []}])
def test_detects_a_slot_that_the_conditions_do_not_allow(scenario, morning, changes):
    """短縮利用を検討しない設定や、候補から外した施設の枠を使う予定は誤り。"""
    problem = prepare_problem(scenario, dict(MORNING, **changes))
    errors = errors_after(problem, morning.steps)
    assert any("この条件では使えません" in error for error in errors)


def test_detects_a_duplicate_activity(full_day):
    """同じ活動を2回予定に入れることはできない。"""
    errors = errors_after(full_day.problem, list(full_day.steps) + [full_day.steps[0]])
    assert any("2回以上" in error for error in errors)


def test_detects_a_missing_required_item(full_day):
    """必須のショーを外した予定は誤り（必須の充足状況にも表示する）。"""
    steps = [step for step in full_day.steps if step.activity_id != "S1"]
    report = validate_plan(full_day.problem, steps)
    assert not report.ok
    assert report.required_status["S1"] is False
    assert any("必須の「昼のパレード」（S1）" in error for error in report.errors)


def test_detects_the_budget_being_exceeded(scenario, morning):
    """同じ予定でも、予算が追加費用より1円でも少なければ誤り。"""
    cost = morning.objective_values["extra_cost"]
    problem = prepare_problem(scenario, dict(MORNING, budget_yen=cost - 1))
    errors = errors_after(problem, morning.steps)
    assert any(f"追加費用 {cost} 円が予算 {cost - 1} 円を超えています" in error for error in errors)


def test_detects_a_late_exit(scenario, full_day):
    """出口への到着が退園時刻を1分でも過ぎる予定は誤り。"""
    exit_arrival = validate_plan(full_day.problem, full_day.steps).metrics["exit_arrival"]
    problem = prepare_problem(scenario, dict(FULL_DAY, exit_time=format_time(exit_arrival - 1)))
    errors = errors_after(problem, full_day.steps)
    assert any(f"出口への到着 {format_time(exit_arrival)}" in error and "過ぎています" in error for error in errors)


def test_detects_a_normal_join_outside_the_queue_window(full_day):
    """通常利用で、案内時間（並べる時間帯）の終了時刻ちょうどに並ぶ予定は誤り。"""
    problem = full_day.problem
    index = index_of(full_day.steps, lambda step: step.mode == "normal")
    attraction = problem.activity(full_day.steps[index].activity_id)
    errors = errors_after(problem, changed(full_day.steps, index, queue_time=attraction.queue_close))
    assert any("案内時間" in error and "の外" in error for error in errors)


def test_detects_a_meal_started_outside_its_window(full_day):
    """食事・休憩を、開始できる時間帯の終了時刻ちょうどに始める予定は誤り。"""
    problem = full_day.problem
    index = index_of(full_day.steps, lambda step: step.kind == "meal")
    meal = problem.activity(full_day.steps[index].activity_id)
    errors = errors_after(problem, changed(full_day.steps, index, queue_time=meal.window[1]))
    assert any(f"時間帯 {format_window(meal.window)} の外" in error for error in errors)


def test_detects_a_mode_that_does_not_fit_the_activity(full_day):
    """施設を「食事」として使うような、種類に合わない利用方法は誤り。"""
    index = index_of(full_day.steps, lambda step: step.mode == "normal")
    errors = errors_after(full_day.problem, changed(full_day.steps, index, mode="meal"))
    assert any("利用方法 'meal' はこの種類の活動には使えません" in error for error in errors)


def test_detects_an_unknown_activity(full_day):
    """存在しない活動IDは誤り。"""
    errors = errors_after(full_day.problem, changed(full_day.steps, 0, activity_id="Z9"))
    assert any("'Z9' という活動はありません" in error for error in errors)


def test_detects_an_unused_must_use_slot(scenario, full_day):
    """必ず使う取得済み枠を使っていない予定は誤り。"""
    own = {"id": "OWN1", "attraction": "A2", "window": "13:00-14:00", "residual_wait_min": 5, "paid_yen": 1000,
           "must_use": True}
    problem = prepare_problem(scenario, dict(FULL_DAY, acquired_shortcuts=[own]))
    report = validate_plan(problem, full_day.steps)
    assert not report.ok
    assert report.must_use_status == {"OWN1": False}
    assert any("必ず使う取得済み枠 OWN1 が使われていません" in error for error in report.errors)


def test_detects_a_finish_by_deadline(make_scenario, make_conditions):
    """完了期限（finish_by）: 終了がちょうど期限なら可、1分でも過ぎれば誤り。"""
    raw = make_scenario(
        attractions=[{"id": "X", "duration_min": 10, "preference": 1, "finish_by": "09:30"}],
        default_walk=5,
    )
    problem = prepare_problem(scenario_from_dict(raw), make_conditions())
    on_time = validate_plan(problem, [{"activity_id": "X", "mode": "normal", "queue_time": hhmm("09:20")}])
    assert on_time.ok, on_time.errors
    late = validate_plan(problem, [{"activity_id": "X", "mode": "normal", "queue_time": hhmm("09:21")}])
    assert any("完了期限 09:30" in error for error in late.errors)


def test_detects_a_shortcut_finishing_after_finish_by(make_scenario, make_conditions):
    """完了期限（finish_by）は短縮利用でも確かめる: ちょうど期限に終われば可、1分でも過ぎれば誤り。

    枠 P-X に 09:15 に入場すると、残る待ち 5 分 + 体験 10 分で 09:30 ちょうどに終わる。09:16 の入場は 09:31 に終わる。
    """
    raw = make_scenario(
        attractions=[{"id": "X", "duration_min": 10, "preference": 1, "finish_by": "09:30"}],
        waits={"X": [None]},
        offers=[{"id": "P-X", "attraction": "X", "window": "09:10-09:40", "price_yen": 300, "residual_wait_min": 5}],
        default_walk=5,
    )
    problem = prepare_problem(scenario_from_dict(raw), make_conditions(allow_new_shortcuts=True, budget_yen=300))

    def shortcut_at(minute):
        return [{"activity_id": "X", "mode": "shortcut", "slot_id": "P-X", "queue_time": hhmm(minute)}]

    on_time = validate_plan(problem, shortcut_at("09:15"))
    assert on_time.ok, on_time.errors
    assert on_time.rows[0]["end"] == hhmm("09:30")
    errors = errors_after(problem, shortcut_at("09:16"))
    assert len(errors) == 1 and "完了期限 09:30" in errors[0]


@pytest.mark.parametrize("join", ["10:15", "11:10"], ids=["null-band", "outside-every-band"])
def test_detects_a_normal_join_without_a_wait_value(make_scenario, make_conditions, join):
    """通常利用で、並び始めの時刻の待ち時間が表にない予定は誤り（値が null の時間帯、どの時間帯にも入らない時刻）。

    X の案内時間は 09:00-12:00、待ち時間表は 09:00-10:00 が0分、10:00-11:00 が null、11:30-12:00 が0分。
    同じ予定でも、値のある 09:30 に並ぶなら問題はない。
    """
    raw = make_scenario(
        attractions=[{"id": "X", "duration_min": 5, "preference": 1}],
        bands=("09:00-10:00", "10:00-11:00", "11:30-12:00"),
        waits={"X": [0, None, 0]},
        default_walk=5,
    )
    problem = prepare_problem(scenario_from_dict(raw), make_conditions(exit="13:00"))

    def normal_at(minute):
        return [{"activity_id": "X", "mode": "normal", "queue_time": hhmm(minute)}]

    assert validate_plan(problem, normal_at("09:30")).ok
    errors = errors_after(problem, normal_at(join))
    assert len(errors) == 1 and f"{join} の待ち時間が表にない" in errors[0]


def test_compare_with_solver_detects_inconsistent_solver_values(full_day):
    """ソルバーの値と検証関数の値が食い違えば、その点を一覧にする。"""
    report = validate_plan(full_day.problem, full_day.steps)
    wrong_score = copy.copy(full_day)
    wrong_score.objective_values = dict(full_day.objective_values, score=full_day.objective_values["score"] + 1)
    assert any(message.startswith("score:") for message in compare_with_solver(wrong_score, report))
    wrong_end = copy.copy(full_day)
    wrong_end.steps = changed(full_day.steps, 0, end=full_day.steps[0].end + 1)
    assert any(" の end:" in message for message in compare_with_solver(wrong_end, report))
    fewer = copy.copy(full_day)
    fewer.steps = full_day.steps[:-1]
    assert "予定の項目数が一致しません" in compare_with_solver(fewer, report)
