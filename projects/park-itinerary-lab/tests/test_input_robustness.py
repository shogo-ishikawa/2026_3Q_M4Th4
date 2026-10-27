"""形の誤った入力でも、Python の例外ではなく日本語の入力エラーとして伝えることを確かめるテスト。"""

import copy
import json
from pathlib import Path

import pytest

from park_itinerary_lab import report
from park_itinerary_lab.data import InputError, load_scenario, prepare_problem, scenario_from_dict
from park_itinerary_lab.experiment import comparison_cases, run_comparison
from park_itinerary_lab.model import PlanResult, SolverSettings, solve_day_plan
from park_itinerary_lab.validate import validate_plan

DEMO = Path(__file__).resolve().parents[1] / "configs" / "demo_park.json"
BASE = {"entry_time": "09:00", "exit_time": "18:00", "season": "busy"}
FAST = SolverSettings(time_limit_s=20, num_workers=4)


@pytest.fixture(scope="module")
def demo():
    return load_scenario(DEMO)


@pytest.fixture(scope="module")
def demo_raw():
    return json.loads(DEMO.read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "extra, expected",
    [
        ({"acquired_shortcuts": {"id": "x"}}, "acquired_shortcuts はリスト"),
        ({"acquired_shortcuts": ["x"]}, "acquired_shortcuts[0] は辞書"),
        ({"season": ["busy"]}, "season（季節・混雑）"),
        ({"purchase_rules": "rule"}, "purchase_rules はリスト"),
    ],
)
def test_wrongly_shaped_conditions_give_input_errors(demo, extra, expected):
    result = solve_day_plan(demo, {**BASE, **extra}, FAST)
    assert result.status == "error"
    assert any(expected in message for message in result.messages)


def test_conditions_that_are_not_a_dict_give_an_input_error(demo):
    result = solve_day_plan(demo, ["09:00", "18:00"], FAST)
    assert result.status == "error"
    assert result.messages == ["条件（conditions）は辞書にしてください"]


@pytest.mark.parametrize(
    "mutate, expected",
    [
        (lambda raw: raw.update(walk_minutes=[1, 2]), "walk_minutes は null か"),
        (lambda raw: raw["attractions"].append("A9"), "attractions[8] は辞書"),
        (lambda raw: raw.update(walking="fast"), "walking は"),
        (lambda raw: raw["wait_tables"].update(extra=[1]), "wait_tables.extra は"),
        (lambda raw: raw["shows"][0].update(performances=["11:00"]), "performances[0] は辞書"),
    ],
)
def test_wrongly_shaped_scenarios_give_input_errors(demo_raw, mutate, expected):
    raw = copy.deepcopy(demo_raw)
    mutate(raw)
    with pytest.raises(InputError) as caught:
        scenario_from_dict(raw)
    assert any(expected in problem for problem in caught.value.problems)


def test_scenario_that_is_not_a_dict_gives_an_input_error():
    with pytest.raises(InputError):
        scenario_from_dict(["not", "a", "dict"])


def test_acquired_slot_outside_the_stay_is_warned(demo):
    slot = {"id": "OWN", "attraction": "A8", "window": "19:00-20:00", "residual_wait_min": 5, "paid_yen": 0,
            "must_use": False}
    problem = prepare_problem(demo, {**BASE, "acquired_shortcuts": [slot]})
    assert any("OWN" in warning and "入園から退園までの間にありません" in warning for warning in problem.warnings)


def test_validator_reports_a_step_without_queue_time(demo):
    problem = prepare_problem(demo, BASE)
    check = validate_plan(problem, [{"activity_id": "A1", "mode": "normal"}])
    assert not check.ok
    assert any("queue_time" in error for error in check.errors)


def test_comparison_keeps_error_rows_for_badly_written_variants(demo):
    variants = [
        {"label": "starts-is-a-number", "show_id": "S1", "starts": 780},
        {"label": "no-show-id", "starts": ["13:00"]},
    ]
    base = {**BASE, "allow_new_shortcuts": True, "required_shows": ["S1"], "required_meals": ["M1"]}
    table, _details = run_comparison(demo, base, comparison_cases([0], variants), FAST)
    assert list(table["status"]) == ["error"] * 4
    assert table["message"].str.contains("show_").all()


def test_comparison_without_entry_time_keeps_error_rows(demo):
    base = {"exit_time": "18:00", "season": "busy"}
    table, _details = run_comparison(demo, base, comparison_cases([0], [{"label": "x", "show_id": "S1"}]), FAST)
    assert list(table["status"]) == ["error", "error"]


def test_metrics_row_hides_values_of_results_without_a_plan(demo):
    """検証で不一致が見つかり「エラー」になった結果は、予定の値を比較表に出さない。"""
    solved = solve_day_plan(demo, {**BASE, "required_shows": ["S1"], "required_meals": ["M1"]}, FAST)
    assert solved.has_plan
    broken = PlanResult("error", "none", validation=solved.validation, problem=solved.problem)
    row = report.metrics_row("broken", broken)
    assert row["希望度の合計"] is None and row["出口への到着"] == ""
