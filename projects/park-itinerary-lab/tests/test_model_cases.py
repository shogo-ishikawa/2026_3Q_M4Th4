"""本体モデル（CP-SAT）の具体的なケースのテスト（検証項目3〜7）。

小さな問題を手で作り、期待する結果を手計算で決めてから、ソルバーの結果と比べます。
ソルバーが返した予定は、別に作った検証関数（validate.py）でも計算し直して確かめます。
徒歩時間は positions（直線上の位置、分）または walk（組ごとの分）で指定します。
"""

from park_itinerary_lab.data import prepare_problem, scenario_from_dict
from park_itinerary_lab.timeutil import parse_time as hhmm
from park_itinerary_lab.validate import validate_plan


def visited(result):
    """予定に入った活動のIDを、訪れる順に並べる。"""
    return [step.activity_id for step in result.steps]


def recomputed_values(report):
    """検証関数で計算し直した、各段階の目的に当たる値。"""
    metrics = report.metrics
    return {
        "score": metrics["score"],
        "extra_cost": metrics["extra_cost_yen"],
        "travel": metrics["travel_min"],
        "exit_arrival": metrics["exit_arrival"],
    }


def assert_validated_optimum(result):
    """優先順位まで最適性を確認でき、検証関数でも問題がなく、各段階の目的値が計算し直した値と一致する。"""
    assert result.status == "optimal", result.messages
    assert result.optimality_scope == "lexicographic"
    assert result.validation is not None
    assert result.validation.ok, result.validation.errors
    recomputed = recomputed_values(result.validation)
    for stage in result.stages:
        if stage.proven:
            assert stage.objective == recomputed[stage.name], (stage.name, stage.objective, recomputed[stage.name])


def problem_for(raw, conditions):
    """シナリオの辞書と条件から、計算用の Problem を作る（検証関数を直接試すときに使う）。"""
    return prepare_problem(scenario_from_dict(raw), conditions)


# ---------------------------------------------------------------------------
# 検証項目3: 予算ゼロ・短縮利用なし・必須施設あり
# ---------------------------------------------------------------------------


def test_budget_zero_without_shortcuts_and_required_attraction_on_demo(demo_scenario, demo_conditions, solve):
    """予算0円・短縮利用を検討しない・必須施設ありでも、最適な予定を返し、必須を満たし、短縮利用は使わない。"""
    conditions = dict(
        demo_conditions,
        budget_yen=0,
        allow_new_shortcuts=False,
        required_attractions=["A1", "A8"],
        season="busy",
        exit_time="15:00",
    )
    result = solve(demo_scenario, conditions)
    assert_validated_optimum(result)
    assert result.problem.slots == {}
    assert {"A1", "A8", "S1", "M1"} <= set(visited(result))
    assert all(step.mode != "shortcut" for step in result.steps)
    assert result.objective_values["extra_cost"] == 0
    metrics = result.validation.metrics
    assert metrics["extra_cost_yen"] == 0 and metrics["total_cost_yen"] == 0
    assert result.validation.required_status == {"A1": True, "A8": True, "M1": True, "S1": True}


def test_budget_zero_keeps_paid_shortcuts_out_of_the_plan(make_scenario, make_conditions, solve):
    """短縮利用を検討しても、予算0円なら有料の枠は使わない（予算があれば使う）。"""
    raw = make_scenario(
        attractions=[{"id": "X", "duration_min": 10, "preference": 5}, {"id": "Y", "duration_min": 10, "preference": 4}],
        waits={"X": [40], "Y": [0]},
        offers=[{"id": "P-X", "attraction": "X", "window": "09:00-12:00", "price_yen": 500, "residual_wait_min": 0}],
        default_walk=5,
    )
    # 予算 500 円: X（短縮 09:05-09:15）→ Y（09:20-09:30）→ 出口 09:35 で両方入る
    with_budget = solve(raw, make_conditions(exit="09:45", allow_new_shortcuts=True, budget_yen=500))
    assert_validated_optimum(with_budget)
    assert with_budget.objective_values["score"] == 9
    assert with_budget.objective_values["extra_cost"] == 500
    assert [step.slot_id for step in with_budget.steps if step.mode == "shortcut"] == ["P-X"]
    # 予算 0 円: X の通常利用は待ち 40 分で間に合わないので、Y だけになる
    zero = solve(raw, make_conditions(exit="09:45", allow_new_shortcuts=True, budget_yen=0))
    assert_validated_optimum(zero)
    assert visited(zero) == ["Y"]
    assert zero.objective_values["extra_cost"] == 0


def test_required_attraction_is_a_constraint_not_a_bonus(make_scenario, make_conditions, solve):
    """必須施設は得点で誘導せず、制約として必ず入れる（希望度0でも入り、そのぶんスコアが下がってもよい）。"""
    raw = make_scenario(
        attractions=[
            {"id": "LOW", "duration_min": 20, "preference": 0},
            {"id": "HIGH", "duration_min": 20, "preference": 5},
        ],
        default_walk=5,
    )
    # 滞在 40 分には、どちらか1つしか入らない（5 + 20 + 5 = 30 分、2つなら 55 分）
    free = solve(raw, make_conditions(exit="09:40"))
    assert visited(free) == ["HIGH"]
    forced = solve(raw, make_conditions(exit="09:40", required_attractions=["LOW"]))
    assert_validated_optimum(forced)
    assert visited(forced) == ["LOW"]
    assert forced.objective_values["score"] == 0
    assert forced.validation.required_status == {"LOW": True}


# ---------------------------------------------------------------------------
# 検証項目4: 出口までの移動、ショーの事前到着、入場枠の境界
# ---------------------------------------------------------------------------


def exit_walk_scenario(make_scenario):
    """直線上に 入口 0 分、X 5 分、Y 10 分、出口 21 分。X・Y は体験 20 分、待ち 0 分。"""
    return make_scenario(
        attractions=[{"id": "X", "duration_min": 20, "preference": 5}, {"id": "Y", "duration_min": 20, "preference": 4}],
        positions={"entrance": 0, "X": 5, "Y": 10, "exit": 21},
    )


def test_walk_to_the_exit_alone_makes_the_longer_plan_infeasible(make_scenario, make_conditions, solve):
    """X → Y は 09:50 に終わるが、出口まで 11 分かかる。退園 10:01 なら入り、10:00 なら入らない。"""
    raw = exit_walk_scenario(make_scenario)
    loose = solve(raw, make_conditions(exit="10:01"))
    assert_validated_optimum(loose)
    assert visited(loose) == ["X", "Y"]
    assert loose.validation.metrics["exit_arrival"] == hhmm("10:01")  # 退園時刻ちょうどの到着は可
    tight = solve(raw, make_conditions(exit="10:00"))
    assert_validated_optimum(tight)
    assert visited(tight) == ["X"]
    assert tight.objective_values["score"] == 5
    assert tight.validation.metrics["exit_arrival"] <= hhmm("10:00")


def test_validator_counts_the_walk_to_the_exit(make_scenario, make_conditions):
    """検証関数も、最後の施設から出口までの移動を含めて退園時刻を確かめる。"""
    raw = exit_walk_scenario(make_scenario)
    plan = [
        {"activity_id": "X", "mode": "normal", "queue_time": hhmm("09:05")},
        {"activity_id": "Y", "mode": "normal", "queue_time": hhmm("09:30")},
    ]
    on_time = validate_plan(problem_for(raw, make_conditions(exit="10:01")), plan)
    assert on_time.ok, on_time.errors
    assert on_time.metrics["exit_arrival"] == hhmm("10:01")
    late = validate_plan(problem_for(raw, make_conditions(exit="10:00")), plan)
    assert not late.ok
    assert any("出口への到着 10:01" in error and "退園時刻 10:00" in error for error in late.errors)


def show_scenario(make_scenario):
    """ショー SH: 10:00 開演、30 分前までに集合（集合 09:30）、公演 20 分。入口・出口から 30 分。"""
    return make_scenario(
        shows=[{
            "id": "SH", "duration_min": 20, "arrive_before_min": 30, "preference": 6,
            "performances": [{"id": "SH-1000", "start": "10:00"}],
        }],
        positions={"entrance": 0, "exit": 0, "SH": 30},
    )


def test_show_meeting_time_reached_exactly_is_accepted_one_minute_late_is_rejected(make_scenario, make_conditions, solve):
    """入園 09:00 なら集合時刻 09:30 ちょうどに着いて鑑賞できる。入園 09:01 では1分遅れて成立しない。"""
    raw = show_scenario(make_scenario)
    on_time = solve(raw, make_conditions(entry="09:00", exit="11:00", required_shows=["SH"]))
    assert_validated_optimum(on_time)
    row = on_time.validation.rows[0]
    assert (row["arrival"], row["queue_time"], row["idle_min"]) == (hhmm("09:30"), hhmm("09:30"), 0)
    assert (row["wait_min"], row["start"], row["end"]) == (30, hhmm("10:00"), hhmm("10:20"))
    late = solve(raw, make_conditions(entry="09:01", exit="11:00", required_shows=["SH"]))
    assert late.status == "infeasible" and not late.has_plan
    late_solver = solve(raw, make_conditions(entry="09:01", exit="11:00", required_shows=["SH"]), run_prechecks=False)
    assert late_solver.status == "infeasible" and late_solver.proof == "solver"
    optional = solve(raw, make_conditions(entry="09:01", exit="11:00"))
    assert optional.status == "optimal" and optional.steps == []  # 必須でなければ、間に合わないショーは入らない


def test_validator_checks_show_arrival_and_meeting_time(make_scenario, make_conditions):
    """検証関数: 集合時刻ちょうどの到着は可。1分遅い到着や、集合時刻と違う時刻は誤りとして見つける。"""
    raw = show_scenario(make_scenario)
    plan = [{"activity_id": "SH", "mode": "show", "performance_id": "SH-1000", "queue_time": hhmm("09:30")}]
    on_time = validate_plan(problem_for(raw, make_conditions(entry="09:00", exit="11:00")), plan)
    assert on_time.ok, on_time.errors
    late = validate_plan(problem_for(raw, make_conditions(entry="09:01", exit="11:00")), plan)
    assert any("到着 09:31 より前の 09:30" in error for error in late.errors)
    wrong_time = [dict(plan[0], queue_time=hhmm("09:31"))]
    wrong = validate_plan(problem_for(raw, make_conditions(entry="09:00", exit="11:00")), wrong_time)
    assert any("集合時刻" in error for error in wrong.errors)


def shortcut_scenario(make_scenario):
    """X は通常利用の値がなく（null）、短縮利用の枠 P-X（10:00-10:30）だけで使える。入口・出口から 29 分。"""
    return make_scenario(
        attractions=[{"id": "X", "duration_min": 5, "preference": 5}],
        waits={"X": [None]},
        offers=[{"id": "P-X", "attraction": "X", "window": "10:00-10:30", "price_yen": 300, "residual_wait_min": 5}],
        positions={"entrance": 0, "exit": 0, "X": 29},
    )


def test_shortcut_join_in_the_last_minute_of_the_window_is_accepted_at_the_end_rejected(
    make_scenario, make_conditions, solve
):
    """枠 [10:00, 10:30): 10:29 の入場は可（入園 10:00 + 29 分）、10:30 ちょうどは不可（入園 10:01）。"""
    raw = shortcut_scenario(make_scenario)
    common = {"exit": "12:00", "allow_new_shortcuts": True, "budget_yen": 300, "required_attractions": ["X"]}
    last_minute = solve(raw, make_conditions(entry="10:00", **common))
    assert_validated_optimum(last_minute)
    step = last_minute.steps[0]
    assert (step.mode, step.slot_id, step.queue_time, step.cost) == ("shortcut", "P-X", hhmm("10:29"), 300)
    # 残る待ち 5 分 + 体験 5 分。枠は入場時刻だけに適用するので、体験が枠の後（10:39）に終わってもよい。
    assert (step.start, step.end) == (hhmm("10:34"), hhmm("10:39"))
    too_late = solve(raw, make_conditions(entry="10:01", **common))
    assert too_late.status == "infeasible"
    too_late_solver = solve(raw, make_conditions(entry="10:01", **common), run_prechecks=False)
    assert too_late_solver.status == "infeasible"


def test_validator_treats_the_slot_end_as_outside(make_scenario, make_conditions):
    """検証関数: 枠の終了時刻ちょうどの入場は枠の外。枠の料金は追加費用に数える。"""
    raw = shortcut_scenario(make_scenario)
    problem = problem_for(raw, make_conditions(entry="10:00", exit="12:00", allow_new_shortcuts=True, budget_yen=300))
    plan = [{"activity_id": "X", "mode": "shortcut", "slot_id": "P-X", "queue_time": hhmm("10:29")}]
    inside = validate_plan(problem, plan)
    assert inside.ok, inside.errors
    assert inside.rows[0]["cost_yen"] == 300
    at_end = validate_plan(problem, [dict(plan[0], queue_time=hhmm("10:30"))])
    assert any("枠 10:00-10:30 の外" in error for error in at_end.errors)


def test_normal_wait_uses_the_band_of_the_join_time_and_queue_close_is_excluded(make_scenario, make_conditions):
    """通常利用: 時間帯の境界ちょうどに並ぶと次の時間帯の待ち時間。案内終了時刻ちょうどには並べない。"""
    raw = make_scenario(
        attractions=[{"id": "X", "duration_min": 5, "preference": 5, "queue_open": "09:00", "queue_close": "10:30"}],
        bands=("09:00-10:00", "10:00-11:00"),
        waits={"X": [30, 0]},
        positions={"entrance": 0, "exit": 0, "X": 0},
    )
    problem = problem_for(raw, make_conditions(exit="12:00"))

    def check(minute):
        return validate_plan(problem, [{"activity_id": "X", "mode": "normal", "queue_time": minute}])

    assert check(hhmm("09:59")).rows[0]["wait_min"] == 30
    assert check(hhmm("10:00")).rows[0]["wait_min"] == 0
    assert check(hhmm("10:29")).ok
    closed = check(hhmm("10:30"))
    assert any("案内時間 09:00-10:30 の外" in error for error in closed.errors)


def test_model_uses_the_later_band_when_arriving_exactly_at_a_band_boundary(make_scenario, make_conditions, solve):
    """09:30 ちょうどに着くと、前の時間帯（待ち 0 分）ではなく、後の時間帯（待ち 60 分）の値になる。"""
    raw = make_scenario(
        attractions=[{"id": "X", "duration_min": 5, "preference": 5}],
        bands=("09:00-09:30", "09:30-11:00"),
        waits={"X": [0, 60]},
        positions={"entrance": 0, "exit": 0, "X": 30},
    )
    # 待ち 60 分なら 10:35 に終わり、出口は 11:05。退園 10:30 では X は入らない。
    tight = solve(raw, make_conditions(exit="10:30"))
    assert_validated_optimum(tight)
    assert tight.steps == []
    loose = solve(raw, make_conditions(exit="11:05"))
    assert_validated_optimum(loose)
    row = loose.validation.rows[0]
    assert (row["arrival"], row["queue_time"], row["wait_min"], row["end"]) == (
        hhmm("09:30"), hhmm("09:30"), 60, hhmm("10:35"))


def test_model_cannot_join_the_normal_queue_at_queue_close(make_scenario, make_conditions, solve):
    """案内時間 [09:00, 09:30) の施設に 09:30 ちょうどに着いても並べない。09:29 に着けば並べる。"""
    raw = make_scenario(
        attractions=[{"id": "X", "duration_min": 5, "preference": 5, "queue_open": "09:00", "queue_close": "09:30"}],
        bands=("09:00-12:00",),
        positions={"entrance": 0, "exit": 0, "X": 30},
    )
    at_close = solve(raw, make_conditions(entry="09:00", exit="11:00"))
    assert_validated_optimum(at_close)
    assert at_close.steps == []
    just_before = solve(raw, make_conditions(entry="08:59", exit="11:00"))
    assert_validated_optimum(just_before)
    assert [(step.activity_id, step.queue_time) for step in just_before.steps] == [("X", hhmm("09:29"))]


def test_model_accepts_finishing_exactly_at_finish_by(make_scenario, make_conditions, solve):
    """完了期限（finish_by 09:30）は「以下」: 09:30 ちょうどに終われば可、09:31 なら不可（入場枠とは別の項目）。"""
    raw = make_scenario(
        attractions=[{"id": "X", "duration_min": 10, "preference": 5, "finish_by": "09:30"}],
        positions={"entrance": 0, "exit": 0, "X": 5},
    )
    on_time = solve(raw, make_conditions(entry="09:15", exit="11:00"))  # 09:20 に着いて 09:30 に終わる
    assert_validated_optimum(on_time)
    assert [(step.queue_time, step.end) for step in on_time.steps] == [(hhmm("09:20"), hhmm("09:30"))]
    late = solve(raw, make_conditions(entry="09:16", exit="11:00"))  # 09:21 に着くと 09:31 に終わる
    assert_validated_optimum(late)
    assert late.steps == []


def test_model_chooses_the_performance_that_can_be_reached(make_scenario, make_conditions, solve):
    """公演回が2つあり、1回目（集合 09:20）には間に合わないとき、2回目（集合 10:50）を選ぶ。"""
    raw = make_scenario(
        shows=[{
            "id": "SH", "duration_min": 20, "arrive_before_min": 10, "preference": 6,
            "performances": [{"id": "SH-0930", "start": "09:30"}, {"id": "SH-1100", "start": "11:00"}],
        }],
        positions={"entrance": 0, "exit": 0, "SH": 10},
    )
    result = solve(raw, make_conditions(entry="09:15", exit="12:00", required_shows=["SH"]))
    assert_validated_optimum(result)
    step = result.steps[0]
    assert (step.performance_id, step.queue_time, step.start) == ("SH-1100", hhmm("10:50"), hhmm("11:00"))


def test_model_cannot_start_a_meal_at_the_end_of_its_window(make_scenario, make_conditions, solve):
    """食事の開始できる時間帯 [11:00, 11:30): 11:30 ちょうどには始められない。11:29 なら始められる。"""
    raw = make_scenario(
        meals=[{"id": "M", "duration_min": 30, "window": "11:00-11:30", "preference": 4}],
        bands=("09:00-14:00",),
        positions={"entrance": 0, "exit": 0, "M": 30},
    )
    at_end = solve(raw, make_conditions(entry="11:00", exit="13:00"))
    assert_validated_optimum(at_end)
    assert at_end.steps == []
    just_before = solve(raw, make_conditions(entry="10:59", exit="13:00"))
    assert_validated_optimum(just_before)
    assert [(step.activity_id, step.queue_time) for step in just_before.steps] == [("M", hhmm("11:29"))]


# ---------------------------------------------------------------------------
# 検証項目5: 待ち時間が下がるのを待ってから並ぶ
# ---------------------------------------------------------------------------


def test_waiting_for_the_lower_wait_band_is_the_only_way_to_fit(make_scenario, make_conditions, solve):
    """09:05 に着いてすぐ並ぶと待ち 60 分で退園に間に合わない。09:30 の待ち 0 分まで待てば入る。"""
    raw = make_scenario(
        attractions=[{"id": "A", "duration_min": 10, "preference": 5}],
        bands=("09:00-09:30", "09:30-10:00"),
        waits={"A": [60, 0]},
        default_walk=5,
    )
    result = solve(raw, make_conditions(exit="10:00"))
    assert_validated_optimum(result)
    assert visited(result) == ["A"]
    row = result.validation.rows[0]
    assert row["arrival"] == hhmm("09:05")
    assert row["queue_time"] >= hhmm("09:30")
    assert row["idle_min"] > 0  # 意図的な待機
    assert row["wait_min"] == 0


def test_waiting_between_two_activities_is_allowed(make_scenario, make_conditions, solve):
    """必須ショー S0（09:05-09:15）の後、A に 09:20 に着く。すぐ並ぶと待ち 60 分、09:30 まで待てば 0 分。

    途中の活動の後でも、待ち時間が下がるのを待ってから並べる（最初の活動だけの話ではない）。
    """
    raw = make_scenario(
        attractions=[{"id": "A", "duration_min": 10, "preference": 5}],
        shows=[{"id": "S0", "duration_min": 10, "arrive_before_min": 0, "preference": 1,
                "performances": [{"id": "S0-0905", "start": "09:05"}]}],
        bands=("09:00-09:30", "09:30-10:30"),
        waits={"A": [60, 0]},
        default_walk=5,
    )
    result = solve(raw, make_conditions(exit="10:00", required_shows=["S0"]))
    assert_validated_optimum(result)
    assert visited(result) == ["S0", "A"]
    row = result.validation.rows[1]
    assert (row["arrival"], row["wait_min"]) == (hhmm("09:20"), 0)
    assert row["queue_time"] >= hhmm("09:30") and row["idle_min"] >= 10


def test_waiting_lets_one_more_attraction_fit(make_scenario, make_conditions, solve):
    """すぐ並ぶと A だけ、09:30 まで待つと A と B の両方が入る。最適な予定には意図的な待機がある。"""
    raw = make_scenario(
        attractions=[{"id": "A", "duration_min": 10, "preference": 5}, {"id": "B", "duration_min": 10, "preference": 3}],
        bands=("09:00-09:30", "09:30-10:30"),
        waits={"A": [40, 0], "B": [0, 0]},
        default_walk=5,
    )
    result = solve(raw, make_conditions(exit="10:00"))
    assert_validated_optimum(result)
    assert sorted(visited(result)) == ["A", "B"]
    assert result.objective_values["score"] == 8
    rows = {row["activity_id"]: row for row in result.validation.rows}
    assert rows["A"]["queue_time"] >= hhmm("09:30")
    assert rows["A"]["idle_min"] > 0
    assert result.validation.metrics["idle_min"] > 0


# ---------------------------------------------------------------------------
# 検証項目6: 必須条件が衝突・超過する場合
# ---------------------------------------------------------------------------


def clashing_shows_scenario(make_scenario):
    """SA は 10:00 開演・SB は 10:15 開演（どちらも 10 分前集合・30 分）。1回ずつしか公演がない。"""
    return make_scenario(
        shows=[
            {"id": "SA", "duration_min": 30, "arrive_before_min": 10, "preference": 5,
             "performances": [{"id": "SA-1000", "start": "10:00"}]},
            {"id": "SB", "duration_min": 30, "arrive_before_min": 10, "preference": 5,
             "performances": [{"id": "SB-1015", "start": "10:15"}]},
        ],
        default_walk=5,
    )


def test_two_required_shows_that_clash_are_infeasible_and_not_dropped(make_scenario, make_conditions, solve):
    """公演が重なる2つの必須ショー: 片方を勝手に外さず、日本語の理由とともに「実行不可能」と返す。"""
    raw = clashing_shows_scenario(make_scenario)
    conditions = make_conditions(exit="12:00", required_shows=["SA", "SB"])
    result = solve(raw, conditions)
    assert result.status == "infeasible" and result.proof == "precheck"
    assert not result.has_plan and result.steps == []
    assert result.problem.required == frozenset({"SA", "SB"})
    pairs = [issue for issue in result.precheck_issues if issue.code == "P3-pair"]
    assert pairs and set(pairs[0].activity_ids) == {"SA", "SB"} and pairs[0].proves_infeasible
    assert any("「ショーSA」（SA）" in message and "「ショーSB」（SB）" in message for message in result.messages)
    # 事前チェックなしでも、ソルバーが実行不可能を証明する（片方だけの予定にはしない）
    solver_only = solve(raw, conditions, run_prechecks=False)
    assert solver_only.status == "infeasible" and solver_only.proof == "solver"
    assert solver_only.stages[0].cp_status == "INFEASIBLE"
    assert solver_only.steps == []
    # 片方だけが必須なら成立する
    one = solve(raw, make_conditions(exit="12:00", required_shows=["SA"]))
    assert_validated_optimum(one)
    assert visited(one) == ["SA"]


def test_required_items_longer_than_the_stay_are_infeasible_and_not_dropped(make_scenario, make_conditions, solve):
    """必須の3施設（各 40 分、移動 0 分）は滞在 100 分に入らない。2つずつなら入るが、勝手に1つ外したりしない。"""
    raw = make_scenario(
        attractions=[{"id": f"R{number}", "duration_min": 40, "preference": 1} for number in (1, 2, 3)],
        default_walk=0,
    )
    conditions = make_conditions(exit="10:40", required_attractions=["R1", "R2", "R3"])
    result = solve(raw, conditions)
    assert result.status == "infeasible" and result.proof == "precheck"
    assert result.steps == []
    assert {issue.code for issue in result.precheck_issues if issue.proves_infeasible} == {"P4-total"}
    assert any("120 分" in message and "滞在時間 100 分" in message for message in result.messages)
    solver_only = solve(raw, conditions, run_prechecks=False)
    assert solver_only.status == "infeasible" and solver_only.steps == []
    optional = solve(raw, make_conditions(exit="10:40"))
    assert_validated_optimum(optional)
    assert len(optional.steps) == 2


# ---------------------------------------------------------------------------
# 検証項目7: 同点なら費用、さらに同点なら移動時間
# ---------------------------------------------------------------------------


def test_equal_score_prefers_the_cheaper_plan_even_if_it_walks_more(make_scenario, make_conditions, solve):
    """X（短縮 1000 円、往復 10 分）と Y（通常 0 円、往復 30 分）は同じ希望度で、どちらか1つしか入らない → Y。"""
    raw = make_scenario(
        attractions=[{"id": "X", "duration_min": 20, "preference": 5}, {"id": "Y", "duration_min": 20, "preference": 5}],
        waits={"X": [None], "Y": [0]},
        offers=[{"id": "P-X", "attraction": "X", "window": "09:00-12:00", "price_yen": 1000, "residual_wait_min": 0}],
        positions={"entrance": 0, "exit": 0, "X": 5, "Y": 15},
    )
    result = solve(raw, make_conditions(exit="10:00", allow_new_shortcuts=True, budget_yen=2000))
    assert_validated_optimum(result)
    assert visited(result) == ["Y"]
    values = result.objective_values
    assert (values["score"], values["extra_cost"], values["travel"]) == (5, 0, 30)


def test_cheaper_of_two_slots_is_chosen(make_scenario, make_conditions, solve):
    """同じ施設の枠が2つあり、どちらでも同じ予定になるなら、安い枠を選ぶ。"""
    raw = make_scenario(
        attractions=[{"id": "X", "duration_min": 10, "preference": 5}],
        waits={"X": [None]},
        offers=[
            {"id": "P-EXPENSIVE", "attraction": "X", "window": "09:00-12:00", "price_yen": 1500, "residual_wait_min": 0},
            {"id": "P-CHEAP", "attraction": "X", "window": "09:00-12:00", "price_yen": 700, "residual_wait_min": 0},
        ],
        default_walk=5,
    )
    result = solve(raw, make_conditions(allow_new_shortcuts=True, budget_yen=2000))
    assert_validated_optimum(result)
    assert [(step.slot_id, step.cost) for step in result.steps] == [("P-CHEAP", 700)]


def test_equal_score_and_cost_prefers_shorter_travel(make_scenario, make_conditions, solve):
    """同じ希望度・費用0円の FAR（往復 30 分）と NEAR（往復 10 分）。どちらか1つしか入らない → NEAR。"""
    raw = make_scenario(
        attractions=[
            {"id": "FAR", "duration_min": 20, "preference": 5},
            {"id": "NEAR", "duration_min": 20, "preference": 5},
        ],
        positions={"entrance": 0, "exit": 0, "FAR": 15, "NEAR": 5},
    )
    result = solve(raw, make_conditions(exit="10:00"))
    assert_validated_optimum(result)
    assert visited(result) == ["NEAR"]
    values = result.objective_values
    assert (values["score"], values["extra_cost"], values["travel"]) == (5, 0, 10)


ACQUIRED = {"id": "OWN", "attraction": "X", "window": "09:00-09:30", "residual_wait_min": 5, "paid_yen": 1500}


def test_acquired_slot_costs_nothing_extra_and_its_paid_amount_is_reported_separately(
    make_scenario, make_conditions, solve
):
    """取得済み枠は今回の追加費用0円（予算0円でも使える）。既払い額は別に表示し、総額に含める。"""
    raw = make_scenario(
        attractions=[{"id": "X", "duration_min": 10, "preference": 5}, {"id": "Y", "duration_min": 10, "preference": 2}],
        waits={"X": [90], "Y": [0]},
        default_walk=5,
    )
    result = solve(raw, make_conditions(budget_yen=0, acquired_shortcuts=[dict(ACQUIRED, must_use=False)]))
    assert_validated_optimum(result)
    step = next(step for step in result.steps if step.activity_id == "X")
    assert (step.mode, step.slot_id, step.cost) == ("shortcut", "OWN", 0)
    assert result.objective_values["extra_cost"] == 0
    metrics = result.validation.metrics
    assert (metrics["extra_cost_yen"], metrics["already_paid_yen"], metrics["total_cost_yen"]) == (0, 1500, 1500)
    assert metrics["budget_yen"] == 0
    row = next(row for row in result.validation.rows if row["activity_id"] == "X")
    assert row["mode_key"] == "shortcut_acquired"


def test_must_use_slot_is_used_even_when_the_normal_queue_would_be_better(make_scenario, make_conditions, solve):
    """必ず使う取得済み枠: 通常利用ならすぐ乗れて、希望度0でも、その枠を使って予定に入れる。"""
    raw = make_scenario(attractions=[{"id": "X", "duration_min": 10, "preference": 0}], waits={"X": [0]}, default_walk=5)
    slot = dict(ACQUIRED, window="09:40-10:00", paid_yen=1000, must_use=True)
    result = solve(raw, make_conditions(exit="11:00", acquired_shortcuts=[slot]))
    assert_validated_optimum(result)
    assert visited(result) == ["X"]
    step = result.steps[0]
    assert (step.mode, step.slot_id) == ("shortcut", "OWN")
    assert hhmm("09:40") <= step.queue_time < hhmm("10:00")
    assert result.validation.must_use_status == {"OWN": True}
    assert "X" in result.problem.required


def test_must_use_slot_is_used_even_when_another_slot_would_score_more(make_scenario, make_conditions, solve):
    """必ず使う枠 OWN（10:00-10:10）があれば、無料の仮定枠 P-X（09:00-09:30）は使わない。

    P-X を使えば X を 09:05 に済ませて Y（09:50 から並べる）も入るが、必ず使う約束なので、
    X は OWN で 10:00 以降に使い、Y は入らない（スコアは下がってもよい）。
    """
    raw = make_scenario(
        attractions=[
            {"id": "X", "duration_min": 10, "preference": 0},
            {"id": "Y", "duration_min": 30, "preference": 5, "queue_open": "09:50", "queue_close": "10:30"},
        ],
        waits={"X": [None], "Y": [0]},
        offers=[{"id": "P-X", "attraction": "X", "window": "09:00-09:30", "price_yen": 0, "residual_wait_min": 0}],
        default_walk=5,
    )
    own = dict(ACQUIRED, window="10:00-10:10", residual_wait_min=0, paid_yen=500, must_use=True)
    forced = solve(raw, make_conditions(exit="10:30", allow_new_shortcuts=True, acquired_shortcuts=[own]))
    assert_validated_optimum(forced)
    assert [(step.activity_id, step.slot_id) for step in forced.steps] == [("X", "OWN")]
    assert forced.objective_values["score"] == 0
    # 必ず使う約束がなければ、P-X を使って Y も入る
    optional_own = [dict(own, must_use=False)]
    free = solve(
        raw,
        make_conditions(exit="10:30", allow_new_shortcuts=True, acquired_shortcuts=optional_own, required_attractions=["X"]),
    )
    assert_validated_optimum(free)
    assert [(step.activity_id, step.slot_id) for step in free.steps] == [("X", "P-X"), ("Y", None)]


def test_optional_acquired_slot_is_not_forced(make_scenario, make_conditions, solve):
    """任意の取得済み枠（must_use=False）は、使えない時間帯なら使わずに通常利用で計画する。必ず使うなら不可能。"""
    raw = make_scenario(attractions=[{"id": "X", "duration_min": 10, "preference": 5}], waits={"X": [0]}, default_walk=5)
    late_slot = dict(ACQUIRED, window="10:30-11:00", paid_yen=1000)
    optional = solve(raw, make_conditions(exit="10:20", acquired_shortcuts=[dict(late_slot, must_use=False)]))
    assert_validated_optimum(optional)
    assert [(step.activity_id, step.mode) for step in optional.steps] == [("X", "normal")]
    assert optional.validation.must_use_status == {}
    forced = solve(raw, make_conditions(exit="10:20", acquired_shortcuts=[dict(late_slot, must_use=True)]))
    assert forced.status == "infeasible" and forced.steps == []
    assert any("必ず使う取得済み枠 OWN" in message for message in forced.messages)


def test_optional_acquired_slot_for_an_unwanted_attraction_is_left_unused(make_scenario, make_conditions, solve):
    """任意の取得済み枠があっても、希望度0の施設を予定に入れたりしない（必須にならない）。"""
    raw = make_scenario(attractions=[{"id": "X", "duration_min": 10, "preference": 0}], waits={"X": [0]}, default_walk=5)
    slot = dict(ACQUIRED, window="09:40-10:00", paid_yen=1000, must_use=False)
    result = solve(raw, make_conditions(exit="11:00", acquired_shortcuts=[slot]))
    assert_validated_optimum(result)
    assert result.steps == []
    assert "X" not in result.problem.required


# ---------------------------------------------------------------------------
# 条件を変えて再実行しても、前の計算が混ざらない
# ---------------------------------------------------------------------------


def test_re_solving_with_changed_conditions_gives_independent_results(make_scenario, make_conditions, solve):
    """予算を変えて解き直し、元の条件に戻すと、最初と同じ結果になる（前のモデルや解を使い回さない）。"""
    raw = make_scenario(
        attractions=[
            {"id": "X", "duration_min": 10, "preference": 5},
            {"id": "Y", "duration_min": 10, "preference": 4},
        ],
        waits={"X": [40], "Y": [0]},
        offers=[{"id": "P-X", "attraction": "X", "window": "09:00-12:00", "price_yen": 500, "residual_wait_min": 0}],
        default_walk=5,
    )
    with_budget = make_conditions(exit="09:45", allow_new_shortcuts=True, budget_yen=500)
    first = solve(raw, with_budget)
    second = solve(raw, dict(with_budget, budget_yen=0))
    third = solve(raw, with_budget)
    assert first.objective_values["score"] == third.objective_values["score"] == 9
    assert second.objective_values["score"] == 4
    assert [(s.activity_id, s.mode) for s in first.steps] == [(s.activity_id, s.mode) for s in third.steps]
    assert first.problem is not third.problem
