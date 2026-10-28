"""PuLP による入門（活動の選択）のテスト（検証項目1）。

PuLP（CBC）の解を、PuLP を使わない 2^n 通りの全列挙と照らし合わせます。
同点の最適解が複数ある場合は、選んだ集合が違っても、希望度の合計（最適値）が同じなら正しいとします。
CBC がない環境では、テストを飛ばさずに失敗させます（pip install "pulp[cbc]" が必要）。
"""

import random

import pulp
import pytest

from park_itinerary_lab.intro import (
    SelectionResult,
    check_activities,
    compare_with_enumeration,
    enumerate_selections,
    solve_selection,
)
from park_itinerary_lab.timeutil import format_time, parse_time

# 手計算で答えを確かめた固定の例（架空の値）。時間の上限 240 分、予算 1500 円、パレードは必須。
# パレード（60分）を除く 180 分・1500 円で選ぶと、コースター＋ボート＋メリーゴーラウンド
# （170 分・1000 円・希望度 18）が最良で、合計は 18 + 7 = 25 になる（最適な集合はこの1つだけ）。
DEMO_ACTIVITIES = [
    {"id": "coaster", "name": "コースター", "minutes": 90, "preference": 9, "cost_yen": 1000},
    {"id": "boat", "name": "ボート", "minutes": 60, "preference": 6, "cost_yen": 0},
    {"id": "theatre", "name": "シアター", "minutes": 45, "preference": 3, "cost_yen": 0},
    {"id": "parade", "name": "パレード", "minutes": 60, "preference": 7, "cost_yen": 0},
    {"id": "haunted", "name": "おばけ屋敷", "minutes": 50, "preference": 5, "cost_yen": 800},
    {"id": "carousel", "name": "メリーゴーラウンド", "minutes": 20, "preference": 3, "cost_yen": 0},
]


def random_instance(seed):
    """seed から、活動 5〜7 個の小さな問題 (活動, 時間の上限, 予算, 必須) を作る。"""
    rng = random.Random(seed)
    count = rng.randint(5, 7)
    activities = [
        {
            "id": f"act{number}",
            "minutes": rng.randint(15, 120),
            "preference": rng.randint(0, 10),
            "cost_yen": rng.choice([0, 0, 500, 800, 1200]),
        }
        for number in range(count)
    ]
    time_limit = rng.randint(60, 300)
    budget = rng.choice([0, 1000, 2000])
    required = sorted(rng.sample([a["id"] for a in activities], k=rng.randint(0, 2)))
    return activities, time_limit, budget, required


def assert_selection_is_valid(result, activities, time_limit, budget, required):
    """PuLP が選んだ集合が、時間・予算・必須の条件を守り、合計の値も正しいことを確かめる。"""
    chosen = [a for a in activities if a["id"] in result.selected]
    assert sum(a["minutes"] for a in chosen) <= time_limit
    assert sum(a["cost_yen"] for a in chosen) <= budget
    assert set(required) <= set(result.selected)
    assert result.total_preference == sum(a["preference"] for a in chosen)
    assert result.total_minutes == sum(a["minutes"] for a in chosen)
    assert result.total_cost == sum(a["cost_yen"] for a in chosen)


def test_cbc_solver_is_available_and_used():
    """PuLP が呼ぶ実際のソルバー CBC（COIN_CMD）が使える状態で、入門ではそれを使う。"""
    solver = pulp.COIN_CMD(msg=False)
    assert solver.available(), "CBC が見つかりません。pip install 'pulp[cbc]' で導入してください。"
    assert "COIN_CMD" in pulp.listSolvers(onlyAvailable=True)
    result = solve_selection(DEMO_ACTIVITIES, 240, 1500, required_ids=["parade"])
    assert result.solver_name == "COIN_CMD"
    assert result.status == "Optimal"


def test_fixed_demo_list_matches_hand_calculation_and_enumeration():
    """固定の例: PuLP の最適値は手計算（25）と全列挙の両方に一致する。"""
    result = solve_selection(DEMO_ACTIVITIES, 240, 1500, required_ids=["parade"])
    enumeration = enumerate_selections(DEMO_ACTIVITIES, 240, 1500, required_ids=["parade"])
    assert enumeration["n_total"] == 2 ** len(DEMO_ACTIVITIES)
    assert enumeration["best_value"] == 25
    assert enumeration["best_sets"] == [["coaster", "boat", "parade", "carousel"]]
    assert result.total_preference == 25
    assert sorted(result.selected) == sorted(["coaster", "boat", "parade", "carousel"])
    assert_selection_is_valid(result, DEMO_ACTIVITIES, 240, 1500, ["parade"])
    check = compare_with_enumeration(result, enumeration)
    assert check["ok"] and check["selected_is_one_of_best"]


@pytest.mark.parametrize("seed", range(40))
def test_pulp_matches_enumeration_on_random_instances(seed):
    """乱数で作った 5〜7 活動の問題で、実行可能性と最適値が全列挙と一致する（同点の集合の違いは許す）。"""
    activities, time_limit, budget, required = random_instance(seed)
    result = solve_selection(activities, time_limit, budget, required_ids=required)
    enumeration = enumerate_selections(activities, time_limit, budget, required_ids=required)
    check = compare_with_enumeration(result, enumeration)
    assert check["same_feasibility"], (result.status, enumeration["best_value"])
    assert check["same_best_value"], (result.total_preference, enumeration["best_value"])
    assert check["ok"]
    if enumeration["best_value"] is None:
        assert result.status != "Optimal"
        assert result.selected == []
    else:
        assert result.status == "Optimal"
        assert_selection_is_valid(result, activities, time_limit, budget, required)
        assert check["selected_is_one_of_best"]


def test_random_instances_cover_feasible_infeasible_and_tied_cases():
    """上の乱数の問題には、実行可能・実行不可能・同点の最適解が複数ある場合がすべて含まれる。"""
    kinds = {"feasible": 0, "infeasible": 0, "tied": 0}
    for seed in range(40):
        enumeration = enumerate_selections(*random_instance(seed))
        if enumeration["best_value"] is None:
            kinds["infeasible"] += 1
        else:
            kinds["feasible"] += 1
            kinds["tied"] += len(enumeration["best_sets"]) > 1
    assert all(count > 0 for count in kinds.values()), kinds


def test_required_activities_over_the_time_limit_are_infeasible():
    """必須の活動だけで時間の上限を超えると、PuLP は Optimal を返さず、全列挙でも実行可能な選び方がない。"""
    required = ["coaster", "parade"]  # 90 + 60 = 150 分 > 120 分
    result = solve_selection(DEMO_ACTIVITIES, 120, 5000, required_ids=required)
    enumeration = enumerate_selections(DEMO_ACTIVITIES, 120, 5000, required_ids=required)
    assert result.status != "Optimal"
    assert result.selected == [] and result.total_preference is None
    assert enumeration["best_value"] is None
    assert enumeration["n_feasible"] == 0
    assert compare_with_enumeration(result, enumeration)["ok"]


def test_required_activity_over_the_budget_is_infeasible():
    """必須の活動の費用が予算を超える場合も、実行不可能と判定される。"""
    result = solve_selection(DEMO_ACTIVITIES, 480, 500, required_ids=["coaster"])
    enumeration = enumerate_selections(DEMO_ACTIVITIES, 480, 500, required_ids=["coaster"])
    assert result.status != "Optimal"
    assert enumeration["best_value"] is None


def test_ties_accept_any_optimal_set():
    """同点の最適解が2つある場合、どちらを選んでも正しいと判定する。"""
    activities = [
        {"id": "a", "minutes": 60, "preference": 5, "cost_yen": 0},
        {"id": "b", "minutes": 60, "preference": 5, "cost_yen": 0},
        {"id": "c", "minutes": 30, "preference": 1, "cost_yen": 0},
    ]
    result = solve_selection(activities, 90, 0)
    enumeration = enumerate_selections(activities, 90, 0)
    check = compare_with_enumeration(result, enumeration)
    assert enumeration["best_value"] == 6
    assert check["number_of_best_sets"] == 2
    assert check["ok"] and check["selected_is_one_of_best"]


def test_comparison_detects_wrong_answers():
    """照合の関数そのものが、誤った答えを「一致しない」と判定できることを確かめる。"""
    enumeration = enumerate_selections(DEMO_ACTIVITIES, 240, 1500, required_ids=["parade"])
    wrong_value = SelectionResult("Optimal", ["parade", "boat"], 13, 120, 0, "fake", "0")
    assert not compare_with_enumeration(wrong_value, enumeration)["ok"]
    wrong_feasibility = SelectionResult("Infeasible", [], None, None, None, "fake", "0")
    assert not compare_with_enumeration(wrong_feasibility, enumeration)["ok"]


@pytest.mark.parametrize(
    ("activities", "required"),
    [
        pytest.param([{"id": "a", "minutes": 10, "preference": 1, "cost_yen": 0}] * 2, [], id="duplicate-id"),
        pytest.param([{"id": "a", "minutes": -10, "preference": 1, "cost_yen": 0}], [], id="negative-minutes"),
        pytest.param([{"id": "a", "minutes": 10, "preference": 1.5, "cost_yen": 0}], [], id="non-integer-preference"),
        pytest.param([{"id": "a", "minutes": 10, "preference": 1}], [], id="missing-cost"),
        pytest.param([{"id": "a", "minutes": 10, "preference": 1, "cost_yen": 0}], ["b"], id="unknown-required"),
    ],
)
def test_invalid_activity_lists_raise_value_error_in_japanese(activities, required):
    """入力の形の誤りは、計算の前に ValueError（日本語の説明つき）になる。"""
    with pytest.raises(ValueError) as info:
        check_activities(activities, required)
    assert any("぀" <= character <= "ヿ" for character in str(info.value))


@pytest.mark.parametrize("seed", [3, 11, 25])
def test_degenerate_day_plan_gives_the_same_optimal_score_as_pulp(seed, make_scenario, make_conditions, solve):
    """移動0分・待ち0分・時間帯の制限なし・費用0円に縮退させた場合に限り、本体（CP-SAT）の最適値は入門と一致する。

    一般には、入門は移動・待ち時間・時刻を考えないので、両者の解は一致しません。
    """
    rng = random.Random(seed)
    activities = [
        {"id": f"act{number}", "minutes": rng.randint(10, 60), "preference": rng.randint(1, 10), "cost_yen": 0}
        for number in range(rng.randint(5, 7))
    ]
    time_limit = rng.randint(60, 180)
    required = [activities[0]["id"]] if seed % 2 else []
    pulp_result = solve_selection(activities, time_limit, 0, required_ids=required)
    raw = make_scenario(
        attractions=[{"id": a["id"], "duration_min": a["minutes"], "preference": a["preference"]} for a in activities],
        bands=("09:00-21:00",),
        default_walk=0,
    )
    exit_time = format_time(parse_time("09:00") + time_limit)
    result = solve(raw, make_conditions(entry="09:00", exit=exit_time, required_attractions=required))
    assert pulp_result.status == "Optimal"
    assert result.status == "optimal"
    assert result.objective_values["score"] == pulp_result.total_preference
