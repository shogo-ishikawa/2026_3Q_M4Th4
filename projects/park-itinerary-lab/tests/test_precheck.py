"""事前チェック（precheck.py）のテスト。

事前チェックは「必要条件」だけを調べます。実行不可能と判定したなら、事前チェックを使わずに解いても
ソルバーが実行不可能を証明するはずです（健全性）。逆に、待ち時間が下がるのを待てば成立する予定を、
誤って「実行不可能」と判定してはいけません。

P1: 入口から出口まで歩くだけで退園に間に合わない
P2: 必須の活動が、それだけを予定に入れても成立しない
P3: 必須の活動の組が、どちらの順番でも両方は入らない
P4: 必須の活動の待ち時間と所要時間の合計が、滞在時間を超える
"""

import random
import re

import pytest

from park_itinerary_lab.data import prepare_problem, scenario_from_dict
from park_itinerary_lab.precheck import run_prechecks

_JAPANESE = re.compile(r"[぀-ヿ㐀-鿿]")


def proving_issues(raw, conditions):
    """事前チェックのうち、実行不可能を証明する項目だけを返す。"""
    problem = prepare_problem(scenario_from_dict(raw), conditions)
    return [issue for issue in run_prechecks(problem) if issue.proves_infeasible]


def assert_single_proof(issues, code, activity_ids, expected_text):
    """code の項目が1件以上あり、日本語の説明に expected_text と活動IDを含むことを確かめる。"""
    matching = [issue for issue in issues if issue.code == code]
    assert matching, [issue.code for issue in issues]
    issue = matching[0]
    assert issue.proves_infeasible
    assert set(issue.activity_ids) == set(activity_ids)
    assert _JAPANESE.search(issue.message)
    assert expected_text in issue.message, issue.message
    for activity_id in activity_ids:
        assert f"（{activity_id}）" in issue.message


def assert_solver_also_proves_infeasible(solve, raw, conditions):
    """健全性: 事前チェックを使わずに解いても、ソルバーが実行不可能を証明する。"""
    result = solve(raw, conditions, run_prechecks=False)
    assert result.status == "infeasible"
    assert result.proof == "solver"
    assert result.steps == []


# ---------------------------------------------------------------------------
# P1〜P4 がそれぞれ働く例
# ---------------------------------------------------------------------------


def test_p1_gates_are_too_far_apart(make_scenario, make_conditions, solve):
    """P1: 入口から出口まで 30 分かかるのに、滞在が 20 分しかない。"""
    raw = make_scenario(
        attractions=[{"id": "X", "duration_min": 5, "preference": 3}],
        positions={"entrance": 0, "X": 15, "exit": 30},
    )
    conditions = make_conditions(exit="09:20")
    issues = proving_issues(raw, conditions)
    assert [issue.code for issue in issues] == ["P1-gates"]
    assert "最短でも 30 分" in issues[0].message
    assert_solver_also_proves_infeasible(solve, raw, conditions)


def p2_cases():
    """P2 の例: (名前, シナリオの引数, 条件の引数, 必須の活動, 説明に含まれる言葉)。"""
    show = {"id": "SH", "duration_min": 20, "arrive_before_min": 10, "preference": 5,
            "performances": [{"id": "SH-0910", "start": "09:10"}]}
    return [
        (
            "show-meeting-before-arrival",
            {"shows": [show], "default_walk": 5},
            {"exit": "11:00", "required_shows": ["SH"]},
            "SH",
            "どの公演回も",
        ),
        (
            "attraction-too-far",
            {"attractions": [{"id": "X", "duration_min": 10, "preference": 3}],
             "positions": {"entrance": 0, "exit": 0, "X": 30}},
            {"exit": "10:00", "required_attractions": ["X"]},
            "X",
            "どの時間帯・利用方法でも",
        ),
        (
            "only-slot-over-budget",
            {"attractions": [{"id": "X", "duration_min": 10, "preference": 3}], "waits": {"X": [None]},
             "offers": [{"id": "P-X", "attraction": "X", "window": "09:00-12:00", "price_yen": 1000,
                         "residual_wait_min": 0}]},
            {"exit": "11:00", "required_attractions": ["X"], "allow_new_shortcuts": True, "budget_yen": 500},
            "X",
            "予算内で使える利用方法がありません",
        ),
        (
            "no-wait-values-and-no-slots",
            {"attractions": [{"id": "X", "duration_min": 10, "preference": 3}], "waits": {"X": [None]}},
            {"exit": "11:00", "required_attractions": ["X"]},
            "X",
            "利用できる時間帯がありません",
        ),
        (
            "must-use-slot-after-exit",
            {"attractions": [{"id": "X", "duration_min": 10, "preference": 3}]},
            {"exit": "10:00", "acquired_shortcuts": [{"id": "OWN", "attraction": "X", "window": "10:30-11:00",
                                                      "residual_wait_min": 0, "paid_yen": 0, "must_use": True}]},
            "X",
            "必ず使う取得済み枠 OWN",
        ),
        (
            "meal-window-before-arrival",
            {"meals": [{"id": "M", "duration_min": 30, "window": "09:00-09:03", "preference": 0}], "default_walk": 5},
            {"exit": "11:00", "required_meals": ["M"]},
            "M",
            "開始できる時間帯",
        ),
    ]


@pytest.mark.parametrize(
    ("scenario_args", "condition_args", "activity_id", "expected_text"),
    [pytest.param(*case[1:], id=case[0]) for case in p2_cases()],
)
def test_p2_required_activity_cannot_fit_even_alone(
    make_scenario, make_conditions, solve, scenario_args, condition_args, activity_id, expected_text
):
    """P2: 必須の活動が、それだけを予定に入れても成立しない（理由を日本語で示す）。"""
    raw = make_scenario(**scenario_args)
    conditions = make_conditions(**condition_args)
    issues = proving_issues(raw, conditions)
    assert_single_proof(issues, "P2-single", [activity_id], expected_text)
    assert_solver_also_proves_infeasible(solve, raw, conditions)


def test_p3_required_pair_cannot_fit_in_either_order(make_scenario, make_conditions, solve):
    """P3: 必須のショー2つの公演が重なり、どちらの順番でも両方は入らない（それぞれ単独なら入る）。"""
    raw = make_scenario(
        shows=[
            {"id": "SA", "duration_min": 30, "arrive_before_min": 10, "preference": 5,
             "performances": [{"id": "SA-1000", "start": "10:00"}]},
            {"id": "SB", "duration_min": 30, "arrive_before_min": 10, "preference": 5,
             "performances": [{"id": "SB-1015", "start": "10:15"}]},
        ],
        default_walk=5,
    )
    conditions = make_conditions(exit="12:00", required_shows=["SA", "SB"])
    issues = proving_issues(raw, conditions)
    assert [issue.code for issue in issues] == ["P3-pair"]
    assert_single_proof(issues, "P3-pair", ["SA", "SB"], "どちらの順番")
    assert_solver_also_proves_infeasible(solve, raw, conditions)


def test_p3_attraction_and_show_compete_for_the_same_time(make_scenario, make_conditions, solve):
    """P3: 短縮枠でしか使えない施設と、同じ時間帯のショー。予算の枠も含めて、組として成立しない。"""
    raw = make_scenario(
        attractions=[{"id": "X", "duration_min": 20, "preference": 3}],
        waits={"X": [None]},
        offers=[{"id": "P-X", "attraction": "X", "window": "10:00-10:10", "price_yen": 0, "residual_wait_min": 0}],
        shows=[{"id": "SH", "duration_min": 30, "arrive_before_min": 0, "preference": 5,
                "performances": [{"id": "SH-1015", "start": "10:15"}]}],
        default_walk=5,
    )
    conditions = make_conditions(exit="12:00", required_attractions=["X"], required_shows=["SH"], allow_new_shortcuts=True)
    issues = proving_issues(raw, conditions)
    assert_single_proof(issues, "P3-pair", ["X", "SH"], "両方を予定に入れられません")
    assert_solver_also_proves_infeasible(solve, raw, conditions)


def test_p4_required_items_exceed_the_stay(make_scenario, make_conditions, solve):
    """P4: 必須の3施設（各 40 分、移動 0 分）は、2つずつなら入るが、合計 120 分が滞在 100 分を超える。"""
    raw = make_scenario(
        attractions=[{"id": f"R{number}", "duration_min": 40, "preference": 1} for number in (1, 2, 3)],
        default_walk=0,
    )
    conditions = make_conditions(exit="10:40", required_attractions=["R1", "R2", "R3"])
    issues = proving_issues(raw, conditions)
    assert [issue.code for issue in issues] == ["P4-total"]
    assert set(issues[0].activity_ids) == {"R1", "R2", "R3"}
    assert "最小でも 120 分" in issues[0].message and "滞在時間 100 分" in issues[0].message
    assert_solver_also_proves_infeasible(solve, raw, conditions)


# ---------------------------------------------------------------------------
# 誤って「実行不可能」と判定しない
# ---------------------------------------------------------------------------


def test_waiting_for_a_lower_wait_is_not_flagged(make_scenario, make_conditions, solve):
    """回帰テスト: A は 09:00-09:30 の待ち 60 分、09:30-10:00 の待ち 0 分。必須ショーは 09:40（集合も 09:40）。

    09:30 まで待ってから A に並べば、09:35 に終わり、5 分歩いて 09:40 のショーに間に合う（退園 10:20）。
    すぐ並ぶ場合だけを考えて「成立しない」と判定してはいけない。
    """
    raw = make_scenario(
        attractions=[{"id": "A", "duration_min": 5, "preference": 3, "queue_open": "09:00", "queue_close": "10:00"}],
        shows=[{"id": "S", "duration_min": 30, "arrive_before_min": 0, "preference": 2,
                "performances": [{"id": "S-0940", "start": "09:40"}]}],
        bands=("09:00-09:30", "09:30-10:00"),
        waits={"A": [60, 0]},
        positions={"entrance": 0, "exit": 0, "A": 0, "S": 5},
    )
    conditions = make_conditions(exit="10:20", required_attractions=["A"], required_shows=["S"])
    assert proving_issues(raw, conditions) == []
    result = solve(raw, conditions)
    assert result.status == "optimal"
    assert [step.activity_id for step in result.steps] == ["A", "S"]
    assert result.validation.ok
    assert result.validation.rows[0]["idle_min"] > 0


def test_demo_conditions_raise_no_proof(demo_scenario, demo_conditions):
    """デモの標準条件では、実行不可能を示す項目は出ない。"""
    problem = prepare_problem(demo_scenario, demo_conditions)
    assert [issue for issue in run_prechecks(problem) if issue.proves_infeasible] == []


def test_data_warnings_are_reported_but_do_not_prove_infeasibility(make_scenario, make_conditions, solve):
    """データの注意点（W-data）は表示するが、実行不可能の根拠にはしない。"""
    raw = make_scenario(
        attractions=[{"id": "X", "duration_min": 5, "preference": 3}],
        bands=("09:00-10:00", "10:00-11:00"),
        waits={"X": [0, None]},
    )
    conditions = make_conditions(exit="11:00", required_attractions=["X"])
    problem = prepare_problem(scenario_from_dict(raw), conditions)
    issues = run_prechecks(problem)
    warnings = [issue for issue in issues if issue.code == "W-data"]
    assert warnings and not any(issue.proves_infeasible for issue in warnings)
    assert solve(raw, conditions).status == "optimal"


# ---------------------------------------------------------------------------
# 健全性: 乱数で作った小さな問題
# ---------------------------------------------------------------------------


def random_instance(seed, make_scenario, make_conditions):
    """seed から、施設 1〜3・ショー 0〜2 の小さな問題を作る（必須の活動を1つ以上含む）。"""
    rng = random.Random(seed)
    bands = ("09:00-10:00", "10:00-11:00", "11:00-12:00")
    attractions = [
        {"id": f"A{number}", "duration_min": rng.randint(5, 30), "preference": rng.randint(0, 5)}
        for number in range(rng.randint(1, 3))
    ]
    shows = []
    for number in range(rng.randint(0, 2)):
        starts = sorted(rng.sample(range(555, 720, 15), k=rng.randint(1, 2)))
        shows.append({
            "id": f"S{number}",
            "duration_min": rng.randint(10, 40),
            "arrive_before_min": rng.choice([0, 5, 15]),
            "preference": rng.randint(0, 5),
            "performances": [{"id": f"S{number}-{start}", "start": f"{start // 60:02d}:{start % 60:02d}"}
                             for start in starts],
        })
    waits = {item["id"]: [rng.choice([None, 0, 10, 30, 60]) for _ in bands] for item in attractions}
    offers = []
    if rng.random() < 0.5:
        hour = rng.choice([9, 10, 11])
        offers.append({"id": "P-A0", "attraction": "A0", "window": f"{hour:02d}:00-{hour:02d}:30",
                       "price_yen": rng.choice([0, 500, 1500]), "residual_wait_min": rng.choice([0, 5])})
    ids = [item["id"] for item in attractions + shows]
    positions = {"entrance": 0, "exit": rng.choice([0, 5])}
    positions.update({activity_id: rng.randint(0, 20) for activity_id in ids})
    raw = make_scenario(attractions=attractions, shows=shows, bands=bands, waits=waits, offers=offers, positions=positions)
    exit_minute = rng.randint(570, 720)
    required = rng.sample(ids, k=rng.randint(1, len(ids)))
    conditions = make_conditions(
        exit=f"{exit_minute // 60:02d}:{exit_minute % 60:02d}",
        budget_yen=rng.choice([0, 1000]),
        allow_new_shortcuts=True,
        required_attractions=[activity_id for activity_id in required if activity_id.startswith("A")],
        required_shows=[activity_id for activity_id in required if activity_id.startswith("S")],
    )
    return raw, conditions


def test_prechecks_are_sound_on_random_tiny_instances(make_scenario, make_conditions, solve):
    """事前チェックが実行不可能と判定した問題は、ソルバーでも必ず実行不可能（seed 0〜79）。

    事前チェックは必要条件だけなので、判定されなくても実行不可能な問題はあってよい。
    """
    counts = {"flagged": 0, "not_flagged_feasible": 0}
    for seed in range(80):
        raw, conditions = random_instance(seed, make_scenario, make_conditions)
        flagged = bool(proving_issues(raw, conditions))
        result = solve(raw, conditions, run_prechecks=False, time_limit_s=10)
        assert result.status in ("optimal", "infeasible"), (seed, result.status)
        if flagged:
            assert result.status == "infeasible", f"seed {seed}: 事前チェックが成立する問題を実行不可能と判定"
            counts["flagged"] += 1
        elif result.status == "optimal":
            counts["not_flagged_feasible"] += 1
    # 乱数の問題が、判定される場合とされない場合の両方を含むことを確かめる
    assert counts["flagged"] >= 10 and counts["not_flagged_feasible"] >= 10, counts
