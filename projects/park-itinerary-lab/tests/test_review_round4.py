"""4回目の確認で見つかった問題が再び起きないことを確かめるテスト。"""

import json
import subprocess
import sys

import pytest

from park_itinerary_lab import experiment
from park_itinerary_lab.data import InputError, prepare_problem

DEMO_BUSY = {"entry_time": "09:00", "exit_time": "18:00", "season": "busy", "budget_yen": 2000,
             "allow_new_shortcuts": True, "required_shows": ["S1"], "required_meals": ["M1"]}

# OR-Tools 9.15 の CP-SAT が、前処理（presolve の probing）の内部チェックで Python ごと停止した極小の例。
# 入口・施設A・ショーSが同じ場所、出口は 600 m 先（10分）。独立な正解器の最適値は (希望度 8, 追加費用 0, 移動 10)。
ABORT_SCENARIO = {
    "format_version": 1,
    "meta": {"title": "前処理の停止を再現した極小例（架空）", "source_type": "fictional", "checked_on": None,
             "assumptions": [], "notes": ""},
    "cost_basis": "per_person",
    "gates": {"entrance": {"name": "入口", "x": 0, "y": 0}, "exit": {"name": "出口", "x": 600, "y": 0}},
    "walking": {"metres_per_minute": 60, "distance": "manhattan"},
    "walk_minutes": None,
    "attractions": [{"id": "A", "name": "施設A", "x": 0, "y": 0, "duration_min": 5, "preference": 1,
                     "queue_open": "08:30", "queue_close": "11:30", "finish_by": None}],
    "wait_tables": {"test": {"label": "t", "bands": ["09:00-09:15", "09:15-09:30", "10:00-10:15"],
                             "wait_min": {"A": [0, 45, 45]}}},
    "shortcut_offers": [],
    "shows": [{"id": "S", "name": "ショーS", "x": 0, "y": 0, "duration_min": 10, "arrive_before_min": 5,
               "preference": 7, "performances": [{"id": "S-1025", "start": "10:25"}]}],
    "meals": [],
}
ABORT_CONDITIONS = {"entry_time": "09:00", "exit_time": "11:00", "season": "test", "budget_yen": 0}

SOLVE_IN_CHILD = """
import json, sys
from park_itinerary_lab.data import scenario_from_dict
from park_itinerary_lab.model import SolverSettings, solve_day_plan
raw, conditions, workers = json.loads(sys.argv[1]), json.loads(sys.argv[2]), int(sys.argv[3])
result = solve_day_plan(scenario_from_dict(raw), conditions, SolverSettings(num_workers=workers))
print(json.dumps([result.status, [result.objective_values.get(k) for k in ("score", "extra_cost", "travel")]]))
"""


@pytest.mark.parametrize("workers", [1, 8])
def test_solver_does_not_abort_on_the_presolve_crash_example(project_dir, workers):
    """CP-SAT が Python ごと停止した例を、別のプロセスで解く（停止すれば、このテストが失敗する）。"""
    done = subprocess.run(
        [sys.executable, "-c", SOLVE_IN_CHILD, json.dumps(ABORT_SCENARIO), json.dumps(ABORT_CONDITIONS), str(workers)],
        capture_output=True, text=True, timeout=300, env={"PYTHONPATH": str(project_dir / "src"), "PATH": "/usr/bin:/bin"},
    )
    assert done.returncode == 0, done.stderr[-1500:]
    assert json.loads(done.stdout.strip().splitlines()[-1]) == ["optimal", [8, 0, 10]]


def test_must_use_slot_with_a_list_as_attraction_gives_a_japanese_error(demo_scenario):
    slot = {"id": "OWN1", "attraction": ["A2"], "window": "13:00-14:00", "residual_wait_min": 5, "paid_yen": 1500,
            "must_use": True}
    with pytest.raises(InputError) as caught:
        prepare_problem(demo_scenario, dict(DEMO_BUSY, acquired_shortcuts=[slot]))
    assert any("施設ID" in problem for problem in caught.value.problems)


def test_exclude_together_with_required_true_is_an_error_row(demo_scenario, solver_settings):
    variant = {"label": "外して必須", "show_id": "S1", "exclude": True, "required": True}
    table, _details = experiment.run_comparison(
        demo_scenario, DEMO_BUSY, experiment.comparison_cases([0], [variant]), solver_settings)
    assert list(table["status"]) == ["error", "error"]
    assert all("required: True" in reason for reason in table["reason"])


def test_preferences_and_rank_together_are_an_error_for_every_case(demo_scenario, solver_settings):
    """希望度の上書きと希望順位の両方を指定した誤りは、ショーなしの基準のケースでも、ほかのケースと同じくエラーにする。"""
    conditions = dict(DEMO_BUSY, preferences={"S1": 8}, preference_rank=["A1", "S1"])
    variants = [{"label": "ショーなし", "show_id": "S1", "exclude": True}, {"label": "元", "show_id": "S1"}]
    table, _details = experiment.run_comparison(
        demo_scenario, conditions, experiment.comparison_cases([0], variants), solver_settings)
    assert set(table["status"]) == {"error"}


def test_comparison_rows_record_visited_and_skipped_attractions(demo_scenario, solver_settings):
    """各ケースで予定に入らなかった施設を記録する（研究計画 7 節の比較に使う）。"""
    variants = [{"label": "ショーなし", "show_id": "S1", "exclude": True}, {"label": "元", "show_id": "S1"}]
    table, _details = experiment.run_comparison(
        demo_scenario, DEMO_BUSY, experiment.comparison_cases([0], variants), solver_settings)
    without_show, with_show = table.iloc[0], table.iloc[2]
    assert without_show["skipped_attractions"] == ""  # 希望度合計 50 は、8施設すべての希望度の合計
    skipped = with_show["skipped_attractions"].split(", ")
    visited = with_show["visited_activities"].split(", ")
    assert skipped and not set(skipped) & set(visited) and "S1" in visited
    preferences = {a.id: a.preference for a in demo_scenario.attractions.values()}
    assert with_show["score"] == 50 - sum(preferences[a] for a in skipped) + demo_scenario.shows["S1"].preference
    view = experiment.comparison_view(table)
    assert view.iloc[2]["予定に入らなかった施設"] == with_show["skipped_attractions"]
