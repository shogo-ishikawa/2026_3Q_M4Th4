"""本体の CP-SAT モデル（model.py）と、全時刻を調べる独立な正解器（bruteforce.py）の照合。

乱数の seed から作った極小問題（tiny_instances.py）ごとに、次を確かめます。

1. 正解器が実行可能なら、本体は「優先順位まで最適性確認済み」（status "optimal"・
   optimality_scope "lexicographic"）で、目的値の組（希望度合計, 追加費用, 移動時間）が一致する。
   正解器が実行不可能なら、本体は「実行不可能と証明」（"infeasible"）になる。
   この大きさで未判定（"unknown"）や暫定案（"feasible"）になるのは失敗として扱う。
2. 本体の予定を正解器の決まりで計算し直す（bruteforce.evaluate_plan）と、実行可能で同じ値になる。
3. 正解器の予定を検証関数（validate.validate_plan）にかけると、違反がなく同じ値になる。
4. 事前チェックを止めても（run_prechecks=False）同じ状態・同じ値になる。
   事前チェックが、成立する問題を「成立しない」と誤って判定していないことの確認です。

最後に、使った seed の集まりが、必要な特徴（わざと待つと得になる例、枠や時間帯の終わり
ぎりぎりの入列、実行不可能な条件など）を本当に含んでいることを数えて確かめます。
"""

import collections

import pytest

from park_itinerary_lab import data, model, validate
from park_itinerary_lab.bruteforce import evaluate_plan, prepare_instance, solve_by_enumeration
from tiny_instances import (
    add_attraction,
    add_show,
    earliest_join_best,
    instance_features,
    make_tiny_instance,
    new_conditions,
    new_scenario,
)

SEEDS = range(150)
TIME_LIMIT_S = 20


def run_model(scenario, conditions, run_prechecks=True):
    """本体のモデルを、制限時間を明示して解く。シナリオは毎回辞書から読み直す。"""
    settings = model.SolverSettings(time_limit_s=TIME_LIMIT_S, run_prechecks=run_prechecks)
    return model.solve_day_plan(data.scenario_from_dict(scenario), conditions, settings)


def oracle_triple(result):
    """正解器（または evaluate_plan）の結果の (希望度合計, 追加費用, 移動時間)。"""
    return (result["score"], result["extra_cost"], result["travel"])


def model_triple(result):
    """本体の結果の (希望度合計, 追加費用, 移動時間)。"""
    values = result.objective_values
    return (values.get("score"), values.get("extra_cost"), values.get("travel"))


def report_triple(report):
    """検証関数の結果の (希望度合計, 追加費用, 移動時間)。"""
    metrics = report.metrics
    return (metrics.get("score"), metrics.get("extra_cost_yen"), metrics.get("travel_min"))


def model_plan(result):
    """本体の予定（PlanStep のリスト）を、正解器の plan と同じ形の辞書のリストにする。"""
    return [{"activity_id": step.activity_id, "mode": step.mode, "slot_id": step.slot_id,
             "performance_id": step.performance_id, "queue_time": step.queue_time}
            for step in result.steps]


def describe(oracle, result):
    """失敗したときに表示する、正解器と本体の結果の要約。"""
    return (f"oracle feasible={oracle['feasible']} triple={oracle_triple(oracle)} "
            f"plan={oracle['plan']}; model status={result.status} "
            f"scope={result.optimality_scope} triple={model_triple(result)} "
            f"plan={model_plan(result)} messages={result.messages}")


def check_optimal_result(scenario, conditions, oracle, result):
    """正解器が実行可能なときの確認（上の 1〜3）。"""
    message = describe(oracle, result)
    assert (result.status, result.optimality_scope) == ("optimal", "lexicographic"), message
    assert model_triple(result) == oracle_triple(oracle), message
    replay = evaluate_plan(scenario, conditions, model_plan(result))
    assert replay["feasible"], f"model plan rejected by the oracle: {replay['reason']}; {message}"
    assert oracle_triple(replay) == oracle_triple(oracle), message
    report = validate.validate_plan(result.problem, oracle["plan"])
    assert report.ok, f"validate_plan errors {report.errors}; {message}"
    assert report_triple(report) == oracle_triple(oracle), message


def check_model_against_oracle(scenario, conditions):
    """1 つの問題で、本体と正解器を照合する（上の 1〜4）。両方の結果を返す。"""
    oracle = solve_by_enumeration(scenario, conditions)
    result = run_model(scenario, conditions)
    if oracle["feasible"]:
        check_optimal_result(scenario, conditions, oracle, result)
    else:
        assert result.status == "infeasible", describe(oracle, result)
    without_prechecks = run_model(scenario, conditions, run_prechecks=False)
    assert without_prechecks.status == result.status, describe(oracle, without_prechecks)
    assert model_triple(without_prechecks) == model_triple(result), describe(oracle, without_prechecks)
    return oracle, result


@pytest.mark.parametrize("seed", SEEDS)
def test_model_matches_oracle(seed):
    """seed ごとの極小問題で、本体と正解器の結論・最適値・予定の正しさが一致する。"""
    scenario, conditions = make_tiny_instance(seed)
    check_model_against_oracle(scenario, conditions)


# ------------------------------------------------------------------ 回帰用の例


def idle_until_cheaper_band():
    """9:30 まで何もせずに待たないと成立しない問題（回帰用）。

    入園 9:00・退園 10:20。入口と A の間は 0 分、それ以外の徒歩はすべて 5 分（walk_minutes）。
    必須の A は体験 5 分、列は 9:00〜10:00、待ち時間は 9:00〜9:30 が 60 分・9:30〜10:00 が 0 分。
    必須のショー S は 9:40 開演、事前到着 0 分、30 分。
    A に 9:30 に並ぶと 9:35 に終わり、5 分歩いて 9:40 の S に間に合う。9:30 より前に並ぶと
    A の終了が 10:00 以降になり、S の後に回すと A の列が閉まっている。
    """
    scenario = new_scenario([(540, 570), (570, 600)])
    add_attraction(scenario, "A", [60, 0], duration=5, preference=5, queue=(540, 600))
    add_show(scenario, "S", [580], duration=30, arrive_before=0, preference=3)
    nodes = ["entrance", "exit", "A", "S"]
    walk = {from_id: {to_id: 5 for to_id in nodes if to_id != from_id} for from_id in nodes}
    walk["entrance"]["A"] = 0
    walk["A"]["entrance"] = 0
    scenario["walk_minutes"] = walk
    conditions = new_conditions(540, 620, required_attractions=["A"], required_shows=["S"])
    return scenario, conditions


def test_regression_idle_until_cheaper_band():
    """正解器も本体も「実行可能」と判定し、A に 9:30 に並ぶ予定（値 (8, 0, 10)）になる。"""
    scenario, conditions = idle_until_cheaper_band()
    oracle, _result = check_model_against_oracle(scenario, conditions)
    assert oracle_triple(oracle) == (8, 0, 10)
    assert [(item["activity_id"], item["queue_time"]) for item in oracle["plan"]] == [
        ("A", 570), ("S", 580)]
    # 到着後すぐ（間に合う最初の分）に並ぶだけの方法では、成立する予定が見つからない。
    assert earliest_join_best(prepare_instance(scenario, conditions)) is None


# ------------------------------------------------------------------ seed の集まりの網羅性


MINIMUM_SEEDS_WITH_FEATURE = {
    # 移動
    "walk_table_non_metric": 10, "exit_to_entrance_walk": 10, "gates_apart": 10,
    "manhattan": 10, "euclidean": 10,
    # 時刻（わざと待つ・境界ぎりぎり）
    "waiting_pays_off": 3, "idle_before_join": 10, "forced_join_at_normal_end": 3,
    "forced_join_at_shortcut_end": 3, "forced_join_at_meal_end": 3,
    "arrives_exactly_at_meeting_time": 2, "exit_exactly_on_time": 3,
    # 活動
    "finish_by": 10, "show_arrive_before": 10, "show_one_performance": 10,
    "show_two_performances": 10, "meal_window": 10, "zero_duration": 10,
    # 短縮枠と予算
    "offer_above_budget": 10, "offer_within_budget": 10, "budget_exactly_used": 3,
    "budget_limits_purchases": 3, "two_paid_slots_used": 1, "uses_shortcut": 10,
    "shortcut_outside_queue_hours": 2, "must_use_true": 5, "must_use_false": 5,
    "new_shortcuts_not_allowed": 10, "candidates_null": 10, "candidates_empty": 10,
    "candidates_list": 10,
    # 希望度・必須・成立するかどうか
    "zero_preference": 10, "preference_rank": 10, "preference_override": 10, "required": 10,
    "feasible": 50, "infeasible": 5,
}


def test_seeds_cover_the_required_mix_of_features():
    """照合に使う seed の中に、確かめたい特徴を持つ問題が十分な数だけある。"""
    counts = collections.Counter()
    for seed in SEEDS:
        scenario, conditions = make_tiny_instance(seed)
        oracle = solve_by_enumeration(scenario, conditions)
        counts.update(instance_features(scenario, conditions, oracle))
    too_few = {name: counts[name] for name, minimum in MINIMUM_SEEDS_WITH_FEATURE.items()
               if counts[name] < minimum}
    assert not too_few, f"too few seeds with these features: {too_few}"
