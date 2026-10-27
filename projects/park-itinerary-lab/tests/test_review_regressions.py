"""見直しで見つかった問題が再び起きないことを確かめるテスト。"""

import json
from pathlib import Path

import pandas as pd

from park_itinerary_lab.data import load_scenario, prepare_problem
from park_itinerary_lab.experiment import METHOD_LABELS, representative_cases, shortlist_candidates
from park_itinerary_lab.model import SolverSettings, solve_day_plan

PROJECT_DIR = Path(__file__).resolve().parents[1]
FAST = SolverSettings(time_limit_s=20, num_workers=4)


def _messages(result):
    return " ".join(result.messages)


def test_precheck_blames_the_budget_when_a_slot_fits_in_time(make_scenario, make_conditions):
    """通常利用は間に合わないが、短縮利用の枠なら時間内に入る。予算0円なら「料金が予算を超える」と説明する。"""
    scenario = make_scenario(
        attractions=[{"id": "X", "duration_min": 5, "preference": 1, "queue_open": "09:00", "queue_close": "09:10"}],
        offers=[{"id": "PX", "attraction": "X", "window": "09:30-10:00", "price_yen": 500, "residual_wait_min": 0}],
        positions={"entrance": 0, "exit": 0, "X": 15},
    )
    conditions = make_conditions("09:00", "12:00", allow_new_shortcuts=True, required_attractions=["X"], budget_yen=0)
    blocked = solve_day_plan(load_scenario_from(scenario), conditions, FAST)
    assert blocked.status == "infeasible" and blocked.proof == "precheck"
    assert "予算を超えます" in _messages(blocked)
    allowed = solve_day_plan(load_scenario_from(scenario), {**conditions, "budget_yen": 500}, FAST)
    assert allowed.status == "optimal"


def test_precheck_does_not_blame_the_budget_when_the_slot_is_too_early(make_scenario, make_conditions):
    """唯一の枠が早すぎて間に合わない場合、予算の問題だとは説明しない（予算を増やしても成立しない）。"""
    scenario = make_scenario(
        attractions=[{"id": "X", "duration_min": 5, "preference": 1}],
        waits={"X": [None]},
        offers=[{"id": "PX", "attraction": "X", "window": "09:00-09:05", "price_yen": 500, "residual_wait_min": 0}],
        positions={"entrance": 0, "exit": 0, "X": 15},
    )
    for budget in (0, 100000):
        conditions = make_conditions("09:00", "12:00", allow_new_shortcuts=True, required_attractions=["X"],
                                     budget_yen=budget)
        result = solve_day_plan(load_scenario_from(scenario), conditions, FAST)
        assert result.status == "infeasible"
        assert "予算" not in _messages(result)


def test_pair_precheck_blames_the_combined_price(make_scenario, make_conditions):
    """2つの必須施設が、それぞれ500円の枠でしか使えない。予算500円なら、費用の合計が予算を超えると説明する。"""
    offers = [
        {"id": "PX", "attraction": "X", "window": "09:00-10:00", "price_yen": 500, "residual_wait_min": 0},
        {"id": "PY", "attraction": "Y", "window": "09:00-10:00", "price_yen": 500, "residual_wait_min": 0},
    ]
    scenario = make_scenario(
        attractions=[{"id": "X", "duration_min": 5, "preference": 1}, {"id": "Y", "duration_min": 5, "preference": 1}],
        waits={"X": [None], "Y": [None]},
        offers=offers,
        positions={"entrance": 0, "exit": 0, "X": 0, "Y": 0},
    )
    conditions = make_conditions("09:00", "12:00", allow_new_shortcuts=True, required_attractions=["X", "Y"],
                                 budget_yen=500)
    blocked = solve_day_plan(load_scenario_from(scenario), conditions, FAST)
    assert blocked.status == "infeasible" and blocked.proof == "precheck"
    assert "費用の合計が予算を超えます" in _messages(blocked)
    assert solve_day_plan(load_scenario_from(scenario), {**conditions, "budget_yen": 1000}, FAST).status == "optimal"


def test_precheck_names_the_completion_deadline(make_scenario, make_conditions):
    """完了期限（finish_by）に間に合わないことが原因なら、入退園時刻ではなく完了期限だと説明する。"""
    scenario = make_scenario(
        attractions=[{"id": "X", "duration_min": 5, "preference": 1, "finish_by": "09:05"}],
        positions={"entrance": 0, "exit": 0, "X": 5},
    )
    conditions = make_conditions("09:00", "12:00", required_attractions=["X"])
    result = solve_day_plan(load_scenario_from(scenario), conditions, FAST)
    assert result.status == "infeasible"
    assert "完了期限" in _messages(result)


def test_infeasible_message_says_when_prechecks_were_skipped(make_scenario, make_conditions):
    scenario = make_scenario(
        attractions=[{"id": "X", "duration_min": 5, "preference": 1, "finish_by": "09:05"}],
        positions={"entrance": 0, "exit": 0, "X": 5},
    )
    conditions = make_conditions("09:00", "12:00", required_attractions=["X"])
    settings = SolverSettings(time_limit_s=20, num_workers=4, run_prechecks=False)
    result = solve_day_plan(load_scenario_from(scenario), conditions, settings)
    assert result.status == "infeasible" and result.proof == "solver"
    assert "事前チェックは実行していない" in _messages(result)
    assert "事前チェックでは単純な衝突が見つからなかった" not in _messages(result)


def test_method_b_does_not_buy_for_attractions_with_an_acquired_slot():
    scenario = load_scenario(PROJECT_DIR / "configs" / "demo_park.json")
    own = {"id": "OWN6", "attraction": "A6", "window": "12:00-13:00", "residual_wait_min": 5, "paid_yen": 800,
           "must_use": True}
    conditions = {"entry_time": "09:00", "exit_time": "18:00", "season": "busy", "budget_yen": 1000,
                  "allow_new_shortcuts": True, "acquired_shortcuts": [own]}
    rows = {row["attraction_id"]: row for row in shortlist_candidates(prepare_problem(scenario, conditions), "09:00")}
    assert rows["A6"]["selected"] is False and rows["A6"]["reason"] == "取得済み枠あり"
    assert rows["A4"]["selected"] is True  # 予算は買える別の施設に回る


def test_representative_zero_difference_case_shows_different_choices():
    a, b = METHOD_LABELS["A"], METHOD_LABELS["B"]
    rows = [
        ("gap", a, None, None, "A4", 900), ("gap", b, 3, False, "A6", 800),
        ("same-problem", a, None, None, "", 0), ("same-problem", b, 0, True, "", 0),
        ("other-choice", a, None, None, "A4", 900), ("other-choice", b, 0, False, "A1", 1200),
    ]
    table = pd.DataFrame(rows, columns=["case_id", "method", "score_diff_A_minus_B", "b_same_options_as_a",
                                        "used_shortcut_attractions", "extra_cost_yen"])
    assert representative_cases(table) == ["gap", "other-choice"]


def test_notebook_01_shows_no_answer_for_infeasible_settings(run_notebook):
    """01 の手書きのモデル: 条件を満たせない設定では、目的関数の値や選んだ活動を表示しない。"""
    _notebook, text = run_notebook("01_pulp_intro", [("time_limit_min = 360", "time_limit_min = 120"),
                                                     ('required_ids = ["F"]', 'required_ids = ["A", "F"]')])
    assert "終了状態: Infeasible" in text
    assert "目的関数の値" not in text
    assert "条件を満たす選び方はありません" in text


def test_notebook_02_runs_through_with_an_input_error(run_notebook, tmp_path):
    """02: 設定セルの誤り（季節の綴り）があっても「すべて実行」が途中で止まらず、日本語で理由を表示する。

    結果のフォルダは、作品の outputs/ ではなく tmp_path の中に保存される。
    """
    _notebook, text = run_notebook("02_day_plan_optimisation", [('"season": "busy"', '"season": "Busy"')])
    assert "設定セルの入力に誤りがあります" in text
    assert "モデルまたは入力のエラー" in text
    assert "season（季節・混雑）" in text
    assert any((tmp_path / "outputs").iterdir())


def load_scenario_from(raw):
    """テスト用: 辞書のシナリオを、ファイルを使わずに読み込む。"""
    from park_itinerary_lab.data import scenario_from_dict

    return scenario_from_dict(json.loads(json.dumps(raw)))
