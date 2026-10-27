"""結果の状態の表示のテスト（検証項目8）。

状態は「最適性確認済み」「実行可能な暫定案」「実行不可能と証明」「未判定」「モデルまたは入力のエラー」の5つです。
時間切れ・未判定を、最適解や「実行不可能」と誤って表示しないことを確かめます。
overall_status は各段階のソルバーの終了状態だけから決まるので、人工的な段階の結果で網羅的に調べます。
"""

from dataclasses import replace

import ortools
import pytest
from ortools.sat.python import cp_model

from park_itinerary_lab import model
from park_itinerary_lab.model import STAGES, STATUS_LABELS, TIE_BREAK_STAGE, PlanResult, StageResult, overall_status

# 優先順位の段階（希望度合計 → 追加費用 → 移動時間）の数。STAGES の最後にある補助の段階
# （出口への到着時刻）は、同点の予定を選ぶためのもので、状態の表示には影響しない約束です。
PRIORITY_COUNT = 3


def make_stage(index, cp_status, proven=None, objective=10, bound=None):
    """index 番目の段階の、人工的な結果を作る。"""
    name, sense, label = STAGES[index]
    if proven is None:
        proven = cp_status == "OPTIMAL"
    if cp_status not in ("OPTIMAL", "FEASIBLE"):
        objective = bound = None
    elif bound is None:
        bound = objective if proven else objective + 3
    return StageResult(name, label, sense, cp_status, objective, bound, 0.01, 1.0, proven)


def make_stages(*statuses):
    """段階の終了状態を順に並べて、段階の結果のリストを作る。"""
    return [make_stage(index, status) for index, status in enumerate(statuses)]


def test_stage_order_is_score_then_cost_then_travel():
    """優先順位: 希望度合計（最大化）→ 追加費用（最小化）→ 移動時間（最小化）。"""
    assert [(name, sense) for name, sense, _label in STAGES[:PRIORITY_COUNT]] == [
        ("score", "max"),
        ("extra_cost", "min"),
        ("travel", "min"),
    ]


BASIC_CASES = [
    pytest.param(("UNKNOWN",), ("unknown", "none"), id="unknown-first"),
    pytest.param(("INFEASIBLE",), ("infeasible", "none"), id="infeasible-first"),
    pytest.param(("MODEL_INVALID",), ("error", "none"), id="model-invalid-first"),
    pytest.param(("FEASIBLE",), ("feasible", "none"), id="feasible-first"),
    pytest.param(("OPTIMAL", "FEASIBLE"), ("feasible", "score"), id="cost-stage-feasible"),
    pytest.param(("OPTIMAL", "UNKNOWN"), ("feasible", "score"), id="cost-stage-unknown"),
    pytest.param(("OPTIMAL", "OPTIMAL", "FEASIBLE"), ("feasible", "score_cost"), id="travel-stage-feasible"),
    pytest.param(("OPTIMAL", "OPTIMAL", "UNKNOWN"), ("feasible", "score_cost"), id="travel-stage-unknown"),
    pytest.param(("OPTIMAL", "OPTIMAL", "OPTIMAL"), ("optimal", "lexicographic"), id="all-priority-optimal"),
    pytest.param(("OPTIMAL", "MODEL_INVALID"), ("error", "none"), id="model-invalid-second"),
    pytest.param(("OPTIMAL", "OPTIMAL", "MODEL_INVALID"), ("error", "none"), id="model-invalid-third"),
    pytest.param(("OPTIMAL", "INFEASIBLE"), ("error", "none"), id="infeasible-after-fixing-score"),
    pytest.param(("OPTIMAL", "OPTIMAL", "INFEASIBLE"), ("error", "none"), id="infeasible-after-fixing-cost"),
]


@pytest.mark.parametrize(("statuses", "expected"), BASIC_CASES)
def test_overall_status_for_each_combination(statuses, expected):
    """段階の終了状態の組合せごとに、全体の状態と最適性の確認範囲が決まる。"""
    assert overall_status(make_stages(*statuses)) == expected


def test_auxiliary_stage_comes_after_the_priority_stages():
    """4番目の段階は、同点の予定から出口に早く着く予定を選ぶ補助の段階（出口への到着時刻の最小化）。"""
    assert STAGES[PRIORITY_COUNT] == TIE_BREAK_STAGE
    assert TIE_BREAK_STAGE[:2] == ("exit_arrival", "min")
    assert len(STAGES) == PRIORITY_COUNT + 1


PROVEN = ("OPTIMAL",) * PRIORITY_COUNT
AUXILIARY_CASES = [
    pytest.param(PROVEN + ("OPTIMAL",), ("optimal", "lexicographic"), id="auxiliary-optimal"),
    pytest.param(PROVEN + ("FEASIBLE",), ("optimal", "lexicographic"), id="auxiliary-feasible"),
    pytest.param(PROVEN + ("UNKNOWN",), ("optimal", "lexicographic"), id="auxiliary-unknown"),
    pytest.param(PROVEN + ("MODEL_INVALID",), ("error", "none"), id="auxiliary-model-invalid"),
    pytest.param(PROVEN + ("INFEASIBLE",), ("error", "none"), id="auxiliary-infeasible"),
]


@pytest.mark.parametrize(("statuses", "expected"), AUXILIARY_CASES)
def test_auxiliary_stage_does_not_change_the_optimality_label(statuses, expected):
    """優先順位の3段階が確認済みなら、補助の段階が時間切れでも「最適性確認済み」のまま（矛盾はエラー）。"""
    assert overall_status(make_stages(*statuses)) == expected


def test_unknown_is_never_reported_as_infeasible():
    """UNKNOWN（時間内に解も証明もない）は、どの段階で起きても「実行不可能」にならない。"""
    for count in range(1, PRIORITY_COUNT + 1):
        statuses = ("OPTIMAL",) * (count - 1) + ("UNKNOWN",)
        status, _scope = overall_status(make_stages(*statuses))
        assert status != "infeasible"
    assert overall_status(make_stages("UNKNOWN"))[0] == "unknown"


def test_optimal_status_without_matching_bound_is_not_proven():
    """CP-SAT が OPTIMAL でも、目的値と限界値が一致しない（証明できていない）なら最適と表示しない。"""
    stage = make_stage(0, "OPTIMAL", proven=False, objective=10, bound=12)
    assert overall_status([stage]) == ("feasible", "none")


def test_optimal_requires_every_priority_stage():
    """優先順位の段階が足りない（途中で止まった）結果を「最適性確認済み」にしない。"""
    assert overall_status(make_stages("OPTIMAL", "OPTIMAL")) == ("feasible", "score_cost")
    assert overall_status(make_stages("OPTIMAL")) == ("feasible", "score")


def test_status_labels_are_the_five_japanese_labels():
    """5つの状態は、互いに区別できる日本語の表示を持つ。"""
    assert STATUS_LABELS == {
        "optimal": "最適性確認済み",
        "feasible": "実行可能な暫定案",
        "infeasible": "実行不可能と証明",
        "unknown": "未判定",
        "error": "モデルまたは入力のエラー",
    }


@pytest.mark.parametrize(
    ("status", "has_plan"),
    [("optimal", True), ("feasible", True), ("infeasible", False), ("unknown", False), ("error", False)],
)
def test_only_optimal_and_feasible_results_have_a_plan(status, has_plan):
    """予定を返すのは「最適性確認済み」と「実行可能な暫定案」だけ。"""
    assert PlanResult(status, "none").has_plan is has_plan


# ---------------------------------------------------------------------------
# 実際に解いたときの状態
# ---------------------------------------------------------------------------


def assert_proven_only_when_optimal_with_matching_bound(result):
    """各段階を「確認済み」とするのは、CP-SAT が OPTIMAL で、目的値と限界値が一致したときだけ。"""
    for stage in result.stages:
        assert stage.proven == (stage.cp_status == "OPTIMAL" and stage.objective == stage.bound), stage


def test_time_limit_zero_is_never_reported_as_infeasible(demo_scenario, demo_conditions, solve):
    """制限時間0秒: 解も証明もない「未判定」になる。十分な時間なら最適解がある条件なので、「実行不可能」とは表示しない。"""
    enough_time = solve(demo_scenario, demo_conditions)
    assert enough_time.status == "optimal"
    assert_proven_only_when_optimal_with_matching_bound(enough_time)
    result = solve(demo_scenario, demo_conditions, time_limit_s=0)
    assert (result.status, result.optimality_scope, result.proof) == ("unknown", "none", None)
    assert [(stage.cp_status, stage.time_limit_s, stage.proven) for stage in result.stages] == [("UNKNOWN", 0.0, False)]
    assert result.steps == [] and not result.has_plan
    assert any("実行不可能とは限りません" in message for message in result.messages)


def test_stage_stopped_at_its_first_solution_is_not_proven(monkeypatch, demo_scenario, demo_conditions, solve):
    """本物の FEASIBLE: 第1段階が最初の解で止まったら確認済みにせず、その値を固定して次の段階へ進まない。"""

    class FirstSolutionSolver(cp_model.CpSolver):
        """最初の解が見つかったら、最適性を証明する前に止める CpSolver。

        1スレッドにして、毎回同じ最初の解（最適値より小さい希望度合計）で止まるようにする。
        """

        def solve(self, model_to_solve, *args, **kwargs):
            self.parameters.stop_after_first_solution = True
            self.parameters.num_workers = 1
            return super().solve(model_to_solve, *args, **kwargs)

    monkeypatch.setattr(model.cp_model, "CpSolver", FirstSolutionSolver)
    result = solve(demo_scenario, demo_conditions)
    first = result.stages[0]
    assert (first.name, first.cp_status, first.proven) == ("score", "FEASIBLE", False)
    assert (result.status, result.optimality_scope) == ("feasible", "none")
    assert [stage.name for stage in result.stages] == ["score"]  # 確認していない値で先へ進まない
    assert_proven_only_when_optimal_with_matching_bound(result)
    assert result.has_plan and result.validation.ok


def _stop_at_stage(monkeypatch, stage_name, cp_status):
    """指定した段階だけ、本物の結果を「時間切れ（最適性未確認）」に置き換える。"""
    real_solve_stage = model._solve_stage

    def fake_solve_stage(built, name, sense, label, settings):
        stage, solution = real_solve_stage(built, name, sense, label, settings)
        if name == stage_name:
            stage = replace(stage, cp_status=cp_status, proven=False)
        return stage, solution

    monkeypatch.setattr(model, "_solve_stage", fake_solve_stage)


@pytest.mark.parametrize(
    ("stage_name", "expected_scope", "expected_stage_count"),
    [("score", "none", 1), ("extra_cost", "score", 2), ("travel", "score_cost", 3)],
)
def test_stage_timeout_gives_a_provisional_plan_with_the_proven_scope(
    monkeypatch, demo_scenario, demo_conditions, solve, stage_name, expected_scope, expected_stage_count
):
    """途中の段階が時間切れなら、そこで止め、「実行可能な暫定案」と確認済みの範囲を表示する。"""
    _stop_at_stage(monkeypatch, stage_name, "FEASIBLE")
    result = solve(demo_scenario, demo_conditions)
    assert (result.status, result.optimality_scope) == ("feasible", expected_scope)
    assert len(result.stages) == expected_stage_count
    assert result.has_plan and result.validation.ok
    assert "暫定案" in result.messages[0]


def test_auxiliary_stage_timeout_keeps_the_optimal_label(monkeypatch, demo_scenario, demo_conditions, solve):
    """補助の段階だけが時間切れなら、優先順位の3段階の最適性の表示は変わらない。"""
    _stop_at_stage(monkeypatch, TIE_BREAK_STAGE[0], "FEASIBLE")
    result = solve(demo_scenario, demo_conditions)
    assert (result.status, result.optimality_scope) == ("optimal", "lexicographic")
    assert result.validation.ok


def test_input_error_gives_error_status_with_japanese_messages(demo_scenario, demo_conditions, solve):
    """入力の誤り: 状態は「モデルまたは入力のエラー」で、予定も段階の結果もなく、理由を日本語で示す。"""
    result = solve(demo_scenario, dict(demo_conditions, exit_tme="17:00"))
    assert (result.status, result.optimality_scope) == ("error", "none")
    assert result.status_label == "モデルまたは入力のエラー"
    assert not result.has_plan and result.steps == [] and result.stages == []
    assert any("exit_tme" in message and "不明な設定項目" in message for message in result.messages)


def test_precheck_infeasible_has_precheck_proof(demo_scenario, demo_conditions, solve):
    """事前チェックで成立しないと分かった場合: 「実行不可能と証明」、根拠は precheck、ソルバーは実行しない。"""
    # 夜のショー S2（19:30 開演）は、退園 18:00 の条件では必須にできない
    result = solve(demo_scenario, dict(demo_conditions, required_shows=["S2"]))
    assert (result.status, result.proof) == ("infeasible", "precheck")
    assert result.status_label == "実行不可能と証明"
    assert result.stages == []
    assert any(issue.proves_infeasible and issue.activity_ids == ("S2",) for issue in result.precheck_issues)
    assert any("S2" in message for message in result.messages)


def test_solver_infeasible_has_solver_proof_and_does_not_guess_a_cause(demo_scenario, demo_conditions, solve):
    """事前チェックを使わずにソルバーが証明した場合: 根拠は solver で、原因を断定しない説明を出す。"""
    result = solve(demo_scenario, dict(demo_conditions, required_shows=["S2"]), run_prechecks=False)
    assert (result.status, result.proof) == ("infeasible", "solver")
    assert result.stages[0].cp_status == "INFEASIBLE"
    assert any("原因は特定できていません" in message for message in result.messages)


def test_solver_runs_with_zero_gap_limits_and_the_given_time_limit(monkeypatch, make_scenario, make_conditions, solve):
    """近似ギャップによる早期終了を無効にし（相対・絶対とも0）、各段階に指定の制限時間を使い、版を記録する。"""
    used = []

    class RecordingSolver(cp_model.CpSolver):
        """実際に solve を呼んだときのパラメータを記録する CpSolver。"""

        def solve(self, model_to_solve, *args, **kwargs):
            parameters = self.parameters
            used.append((parameters.relative_gap_limit, parameters.absolute_gap_limit,
                         parameters.max_time_in_seconds, parameters.num_workers))
            return super().solve(model_to_solve, *args, **kwargs)

    monkeypatch.setattr(cp_model, "CpSolver", RecordingSolver)
    raw = make_scenario(attractions=[{"id": "X", "duration_min": 10, "preference": 5}])
    result = solve(raw, make_conditions(), time_limit_s=7)
    assert result.status == "optimal"
    assert len(used) == len(result.stages) == len(STAGES)
    assert all(entry == (0.0, 0.0, 7.0, 4) for entry in used)  # CP-SAT の既定の絶対ギャップ 1e-4 は使わない
    assert all(stage.time_limit_s == 7.0 and stage.wall_time_s >= 0 for stage in result.stages)
    info = result.solver_info
    assert (info["relative_gap_limit"], info["absolute_gap_limit"], info["time_limit_s_per_stage"]) == (0.0, 0.0, 7.0)
    assert info["ortools_version"] == ortools.__version__
