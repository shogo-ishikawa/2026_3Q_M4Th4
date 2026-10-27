"""PuLP による入門: 「どの活動を選ぶか」だけを決める小さな問題。

入力パラメータ: 時間の上限、予算、各活動の所要時間・希望度・費用、必須の活動
決定変数      : choose[活動] = 1（選ぶ）または 0（選ばない）
制約条件      : 所要時間の合計 ≤ 時間の上限、費用の合計 ≤ 予算、必須の活動は choose = 1
目的関数      : 選んだ活動の希望度の合計を最大にする

この入門モデルは、移動時間・時間帯による待ち時間の変化・ショーの開演時刻を扱いません。
所要時間の合計が上限以下でも、実際の一日の予定が成立するとは限りません。
経路と時刻まで決める本体モデル（02 の Notebook, model.py）とは別の問題です。

PuLP 4 では、変数を problem.add_variable(...) で作り、solve() は LpSolveStats を返します。
古い例にある LpVariable(..., cat=...) や PULP_CBC_CMD は PuLP 4 では使えません。
"""

from dataclasses import dataclass
from itertools import product


@dataclass
class SelectionResult:
    status: str
    selected: list
    total_preference: int | None
    total_minutes: int | None
    total_cost: int | None
    solver_name: str
    solver_version: str


def check_activities(activities, required_ids=()):
    """入力の形を確認する。誤りがあれば ValueError（日本語の説明つき）。"""
    ids = [activity.get("id") for activity in activities]
    if len(set(ids)) != len(ids):
        raise ValueError("活動のIDが重複しています")
    for activity in activities:
        for key in ("minutes", "preference", "cost_yen"):
            value = activity.get(key)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"活動 {activity.get('id')} の {key} は0以上の整数にしてください（{value!r}）")
    for activity_id in required_ids:
        if activity_id not in ids:
            raise ValueError(f"必須の活動 '{activity_id}' がありません")


def solve_selection(activities, time_limit_min, budget_yen, required_ids=(), solver=None):
    """PuLP で活動を選ぶ。solver を省略すると CBC（pulp.COIN_CMD）を使う。"""
    import pulp

    check_activities(activities, required_ids)
    problem = pulp.LpProblem("activity_selection", pulp.LpMaximize)

    # 決定変数: choose[ID] は 0 か 1
    choose = {}
    for activity in activities:
        choose[activity["id"]] = problem.add_variable(f"choose_{activity['id']}", cat="Binary")

    # 目的関数: 希望度の合計
    problem += pulp.lpSum(a["preference"] * choose[a["id"]] for a in activities), "total_preference"
    # 制約条件
    problem += pulp.lpSum(a["minutes"] * choose[a["id"]] for a in activities) <= time_limit_min, "time_limit"
    problem += pulp.lpSum(a["cost_yen"] * choose[a["id"]] for a in activities) <= budget_yen, "budget"
    for activity_id in required_ids:
        problem += choose[activity_id] == 1, f"required_{activity_id}"

    solver = solver or pulp.COIN_CMD(msg=False)
    stats = problem.solve(solver)
    status = stats.status_str
    if status != "Optimal":
        return SelectionResult(status, [], None, None, None, solver.name, str(stats.solver_version))
    selected = [a["id"] for a in activities if pulp.value(choose[a["id"]]) > 0.5]
    return SelectionResult(
        status=status,
        selected=selected,
        **_totals(activities, selected),
        solver_name=solver.name,
        solver_version=str(stats.solver_version),
    )


def _totals(activities, selected):
    chosen = [a for a in activities if a["id"] in selected]
    return {
        "total_preference": sum(a["preference"] for a in chosen),
        "total_minutes": sum(a["minutes"] for a in chosen),
        "total_cost": sum(a["cost_yen"] for a in chosen),
    }


def enumerate_selections(activities, time_limit_min, budget_yen, required_ids=()):
    """2^n 通りの選び方をすべて調べる（PuLP を使わない、独立な確認方法）。"""
    check_activities(activities, required_ids)
    rows = []
    for pattern in product((0, 1), repeat=len(activities)):
        selected = [a["id"] for a, flag in zip(activities, pattern) if flag == 1]
        totals = _totals(activities, selected)
        feasible = (
            totals["total_minutes"] <= time_limit_min
            and totals["total_cost"] <= budget_yen
            and all(activity_id in selected for activity_id in required_ids)
        )
        rows.append({"selected": selected, **totals, "feasible": feasible})
    feasible_rows = [row for row in rows if row["feasible"]]
    best = max((row["total_preference"] for row in feasible_rows), default=None)
    best_sets = [row["selected"] for row in feasible_rows if row["total_preference"] == best]
    return {
        "n_total": len(rows),
        "n_feasible": len(feasible_rows),
        "best_value": best,
        "best_sets": best_sets,
        "rows": rows,
    }


def compare_with_enumeration(result, enumeration):
    """PuLP の結果と全列挙を照合する。同点の最適解が複数あれば、選んだ集合は違ってもよい。"""
    pulp_feasible = result.status == "Optimal"
    enum_feasible = enumeration["best_value"] is not None
    same_feasibility = pulp_feasible == enum_feasible
    same_value = (not pulp_feasible and not enum_feasible) or (
        pulp_feasible and enum_feasible and result.total_preference == enumeration["best_value"]
    )
    selected_is_best = pulp_feasible and sorted(result.selected) in [sorted(s) for s in enumeration["best_sets"]]
    return {
        "same_feasibility": same_feasibility,
        "same_best_value": same_value,
        "selected_is_one_of_best": selected_is_best,
        "number_of_best_sets": len(enumeration["best_sets"]),
        "ok": same_feasibility and same_value,
    }
