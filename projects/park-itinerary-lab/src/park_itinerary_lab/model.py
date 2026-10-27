"""OR-Tools CP-SAT による一日の予定の最適化（本体モデル）。

決めること（決定変数）
- どの活動を行うか、どの順に回るか（入口から出口までの1本の経路）
- 各活動の利用案（通常利用の時間帯・短縮利用の枠・ショーの公演回・食事の時間帯）
- 並び始める（集合する・開始する）時刻

守ること（制約）
- 経路は入口から出口までの1本で、同じ活動は1回まで（孤立した周回は作らない）
- 連続する活動の間には徒歩の移動時間を入れ、予定は重ならない
- 時間帯・枠・公演回の条件、退園時刻までに出口へ着くこと、追加費用の予算、必須項目

目的（優先順位つき）
1. 希望度合計を最大にする
2. 1 が同点なら、追加費用を最小にする
3. 2 も同点なら、移動時間の合計を最小にする
前の段階で最適性を確認できたときだけ、その値を固定して次の段階へ進みます。
3つとも確認できたら、補助の段階として「出口への到着時刻」を最小にし、同点の予定の中から
無駄な待機の少ない予定を選びます（この補助の段階は、最適性の表示には影響しません）。
"""

import time
from dataclasses import dataclass, field

import ortools
from ortools.sat.python import cp_model

from .data import InputError, prepare_problem, shortest_paths
from .options import build_options
from .precheck import run_prechecks
from .validate import compare_with_solver, validate_plan

STATUS_LABELS = {
    "optimal": "最適性確認済み",
    "feasible": "実行可能な暫定案",
    "infeasible": "実行不可能と証明",
    "unknown": "未判定",
    "error": "モデルまたは入力のエラー",
}

SCOPE_LABELS = {
    "lexicographic": "希望度合計 → 追加費用 → 移動時間 の優先順位まで最適性を確認",
    "score_cost": "希望度合計と追加費用まで最適性を確認（移動時間は未確認）",
    "score": "希望度合計のみ最適性を確認（追加費用・移動時間は未確認）",
    "none": "最適性は未確認",
}

# CP-SAT の前処理の probing を使わない（_solve_stage の説明を参照）
PRESOLVE_PROBING_LEVEL = 0

# (段階の名前, 向き, 表示名)。最初の3つが優先順位、最後は同点の予定を選ぶための補助の段階。
PRIORITY_STAGES = (
    ("score", "max", "希望度合計"),
    ("extra_cost", "min", "追加費用"),
    ("travel", "min", "移動時間"),
)
TIE_BREAK_STAGE = ("exit_arrival", "min", "出口への到着時刻（補助）")
STAGES = PRIORITY_STAGES + (TIE_BREAK_STAGE,)


@dataclass
class SolverSettings:
    """ソルバーの設定。time_limit_s は各段階の制限時間（秒）。"""

    time_limit_s: float = 20.0
    num_workers: int = 8
    random_seed: int = 0
    log_search_progress: bool = False
    run_prechecks: bool = True


@dataclass
class StageResult:
    name: str
    label: str
    sense: str
    cp_status: str
    objective: int | None
    bound: int | None
    wall_time_s: float
    time_limit_s: float
    proven: bool


@dataclass
class PlanStep:
    """予定の1項目（ソルバーが決めた値）。時刻は 0:00 からの分。"""

    activity_id: str
    kind: str
    mode: str
    slot_id: str | None
    performance_id: str | None
    queue_time: int
    start: int
    end: int
    cost: int


@dataclass
class PlanResult:
    status: str
    optimality_scope: str
    stages: list = field(default_factory=list)
    steps: list = field(default_factory=list)
    objective_values: dict = field(default_factory=dict)
    messages: list = field(default_factory=list)
    precheck_issues: list = field(default_factory=list)
    solver_info: dict = field(default_factory=dict)
    problem: object = None
    proof: str | None = None
    validation: object = None

    @property
    def status_label(self):
        return STATUS_LABELS[self.status]

    @property
    def scope_label(self):
        return SCOPE_LABELS[self.optimality_scope]

    @property
    def has_plan(self):
        """予定があるか。何も訪れない予定（空の予定）も、成立していれば True。"""
        return self.status in ("optimal", "feasible")


@dataclass
class _BuiltModel:
    model: cp_model.CpModel
    options: dict
    present: dict
    choose: dict
    queue: dict
    end: dict
    arcs: dict
    objectives: dict
    entry: int = 0
    travel_table: dict = field(default_factory=dict)
    busy: dict = field(default_factory=dict)
    exit_arrival: object = None


# ---------------------------------------------------------------------------
# モデルを作る（制約のまとまりごとに短い関数に分けています）
# ---------------------------------------------------------------------------


def build_model(problem, options):
    """CP-SAT のモデルを新しく作る（呼ぶたびに別のモデルになる）。"""
    built = _BuiltModel(cp_model.CpModel(), options, {}, {}, {}, {}, {}, {}, problem.entry, problem.travel)
    add_activity_variables(built, problem)
    travel_expr = add_route_constraints(built, problem)
    cost_expr = add_budget_and_required(built, problem)
    add_redundant_constraints(built, problem, travel_expr)
    built.objectives = objective_expressions(built, problem, travel_expr, cost_expr)
    return built


def add_activity_variables(built, problem):
    """決定変数: 各活動を行うか（present）、どの利用案か（choose）、並び始めの時刻（queue）。

    利用案を選んだら、並び始めの時刻はその利用案の範囲に入り、
    終了時刻 = 並び始め + 待ち時間 + 体験・鑑賞・食事の時間 になります。
    """
    model = built.model
    for activity_id in problem.activity_ids():
        options = built.options[activity_id]
        present = model.new_bool_var(f"present[{activity_id}]")
        queue = model.new_int_var(problem.entry, problem.exit, f"queue[{activity_id}]")
        chosen = []
        for index, option in enumerate(options):
            choose = model.new_bool_var(f"choose[{activity_id},{option.key}]")
            model.add(queue >= option.lo).only_enforce_if(choose)
            model.add(queue <= option.hi).only_enforce_if(choose)
            built.choose[activity_id, index] = choose
            chosen.append(choose)
        # 行う活動は、ちょうど1つの利用案を選ぶ（行わない活動は選ばない）
        model.add(cp_model.LinearExpr.sum(chosen) == present)
        model.add(queue == problem.entry).only_enforce_if(~present)
        longest = max((o.wait + o.duration for o in options), default=0)
        busy = model.new_int_var(0, longest, f"busy[{activity_id}]")
        model.add(busy == cp_model.LinearExpr.weighted_sum(chosen, [o.wait + o.duration for o in options]))
        end = model.new_int_var(problem.entry, problem.exit, f"end[{activity_id}]")
        model.add(end == queue + busy)
        built.present[activity_id] = present
        built.queue[activity_id] = queue
        built.busy[activity_id] = busy
        built.end[activity_id] = end


def add_route_constraints(built, problem):
    """制約: 入口 → 選んだ活動 → 出口 の1本の経路（AddCircuit）と、移動時間。戻り値は移動時間の合計の式。

    arc[a,b] = 1 なら、b に並び始める時刻 ≥ a の終了時刻 + a から b への徒歩の時間。
    最後の活動 a からは、出口への到着時刻 ≥ a の終了時刻 + a から出口への徒歩の時間（≤ 退園時刻）。
    行わない活動は自分自身への辺（self loop）で経路から外れます。孤立した周回は AddCircuit が許しません。
    """
    model = built.model
    ids = problem.activity_ids()
    index_of = {activity_id: number + 1 for number, activity_id in enumerate(ids)}
    exit_index = len(ids) + 1
    travel = problem.travel
    arcs = []
    travel_terms = []
    for activity_id in ids:
        arcs.append((index_of[activity_id], index_of[activity_id], ~built.present[activity_id]))
    earliest_end, latest_queue = _time_ranges(built.options)
    exit_arrival = model.new_int_var(problem.entry, problem.exit, "exit_arrival")
    built.exit_arrival = exit_arrival
    for b in ids:
        if not built.options[b]:
            continue
        literal = model.new_bool_var(f"arc[entrance,{b}]")
        model.add(built.queue[b] >= problem.entry + travel["entrance"][b]).only_enforce_if(literal)
        _keep_arc(built, arcs, travel_terms, "entrance", b, 0, index_of[b], literal, travel)
        literal = model.new_bool_var(f"arc[{b},exit]")
        model.add(exit_arrival >= built.end[b] + travel[b]["exit"]).only_enforce_if(literal)
        _keep_arc(built, arcs, travel_terms, b, "exit", index_of[b], exit_index, literal, travel)
        for a in ids:
            if a == b or not built.options[a]:
                continue
            if earliest_end[a] + travel[a][b] > latest_queue[b]:
                continue  # どの利用案でも間に合わない移動は、最初から作らない
            literal = model.new_bool_var(f"arc[{a},{b}]")
            model.add(built.queue[b] >= built.end[a] + travel[a][b]).only_enforce_if(literal)
            _keep_arc(built, arcs, travel_terms, a, b, index_of[a], index_of[b], literal, travel)
    if problem.entry + travel["entrance"]["exit"] <= problem.exit:
        literal = model.new_bool_var("arc[entrance,exit]")
        model.add(exit_arrival >= problem.entry + travel["entrance"]["exit"]).only_enforce_if(literal)
        _keep_arc(built, arcs, travel_terms, "entrance", "exit", 0, exit_index, literal, travel)
    closing = model.new_bool_var("arc[exit,entrance]")
    model.add(closing == 1)
    arcs.append((exit_index, 0, closing))
    model.add_circuit(arcs)
    return cp_model.LinearExpr.weighted_sum([lit for lit, _ in travel_terms], [m for _, m in travel_terms])


def _keep_arc(built, arcs, travel_terms, from_id, to_id, from_index, to_index, literal, travel):
    arcs.append((from_index, to_index, literal))
    travel_terms.append((literal, travel[from_id][to_id]))
    built.arcs[from_id, to_id] = literal


def _time_ranges(options):
    earliest_end = {}
    latest_queue = {}
    for activity_id, activity_options in options.items():
        if activity_options:
            earliest_end[activity_id] = min(o.lo + o.wait + o.duration for o in activity_options)
            latest_queue[activity_id] = max(o.hi for o in activity_options)
    return earliest_end, latest_queue


def _choices(built):
    return [
        (option, built.choose[activity_id, index])
        for activity_id, activity_options in built.options.items()
        for index, option in enumerate(activity_options)
    ]


def add_budget_and_required(built, problem):
    """制約: 追加費用の合計 ≤ 予算、必須の活動は必ず行う。戻り値は追加費用の合計の式。"""
    choices = _choices(built)
    cost_expr = cp_model.LinearExpr.weighted_sum([c for _, c in choices], [o.cost for o, _ in choices])
    built.model.add(cost_expr <= problem.budget)
    for activity_id in problem.required:
        built.model.add(built.present[activity_id] == 1)
    return cost_expr


def add_redundant_constraints(built, problem, travel_expr):
    """冗長な制約: 成立する予定は変えずに、ソルバーが最適性を早く証明できるようにする。

    1. 各活動の区間 [並び始め − その活動へ来るための最小の徒歩時間, 終了) は、どの順路でも重ならない。
    2. 移動時間 + 待ち時間 + 体験時間 の合計は、滞在時間（退園 − 入園）以下（意図的な待機は0以上）。
    """
    model = built.model
    intervals = []
    for activity_id in problem.activity_ids():
        others = ["entrance"] + [a for a in problem.activity_ids() if a != activity_id]
        least_walk = min(problem.travel[u][activity_id] for u in others)
        longest = max((o.wait + o.duration for o in built.options[activity_id]), default=0)
        start = model.new_int_var(problem.entry - least_walk, problem.exit, f"walk_start[{activity_id}]")
        model.add(start == built.queue[activity_id] - least_walk)
        size = model.new_int_var(least_walk, least_walk + longest, f"walk_size[{activity_id}]")
        model.add(size == built.busy[activity_id] + least_walk)
        intervals.append(model.new_optional_interval_var(
            start, size, built.end[activity_id], built.present[activity_id], f"interval[{activity_id}]"))
    model.add_no_overlap(intervals)
    choices = _choices(built)
    busy_expr = cp_model.LinearExpr.weighted_sum([c for _, c in choices], [o.wait + o.duration for o, _ in choices])
    model.add(travel_expr + busy_expr <= problem.exit - problem.entry)


def objective_expressions(built, problem, travel_expr, cost_expr):
    """目的に使う式: 希望度合計、追加費用、移動時間（優先順位）と、出口への到着時刻（補助）。"""
    ids = problem.activity_ids()
    score_expr = cp_model.LinearExpr.weighted_sum([built.present[a] for a in ids], [problem.preferences[a] for a in ids])
    return {"score": score_expr, "extra_cost": cost_expr, "travel": travel_expr, "exit_arrival": built.exit_arrival}


# ---------------------------------------------------------------------------
# 優先順位つきで解く
# ---------------------------------------------------------------------------


def solve_day_plan(scenario, conditions, settings=None):
    """条件に合う一日の予定を計算し、PlanResult を返す。毎回モデルを作り直す。

    返す前に、検証関数（validate.py）で予定を計算し直します。制約違反やソルバーの値との
    不一致が見つかった場合は、最適と表示せず「モデルまたは入力のエラー」にします。
    """
    settings = settings or SolverSettings()
    info = _solver_info(settings)
    try:
        problem = prepare_problem(scenario, conditions)
    except InputError as error:
        return PlanResult("error", "none", messages=list(error.problems), solver_info=info)
    shortest = shortest_paths(problem.travel)
    options = build_options(problem, shortest)
    issues = run_prechecks(problem, options, shortest) if settings.run_prechecks else []
    proofs = [issue for issue in issues if issue.proves_infeasible]
    if proofs:
        messages = ["事前チェックで、条件を同時に満たせないことが分かりました（ソルバーは実行していません）。"]
        messages += [issue.message for issue in proofs]
        return PlanResult(
            "infeasible", "none", messages=messages, precheck_issues=issues,
            solver_info=info, problem=problem, proof="precheck",
        )
    options = drop_unwanted_activities(problem, options)
    built = build_model(problem, options)
    info.update(_model_size(built))
    stages, best = _solve_stages(built, settings)
    status, scope = overall_status(stages)
    result = PlanResult(
        status, scope, stages=stages, precheck_issues=issues,
        solver_info=info, problem=problem, proof="solver" if status == "infeasible" else None,
    )
    if best is not None and status in ("optimal", "feasible"):
        result.steps, result.objective_values, _hints = best
    result.messages = _status_messages(result)
    if result.has_plan:
        _check_with_validator(result)
    return result


def drop_unwanted_activities(problem, options):
    """必須でなく、希望度が0の活動は予定に入れない（入れても目的は良くならない）。

    移動時間は最短経路に直してあるので、途中に寄り道を加えても移動時間は短くならず、
    このような活動を外しても、最適な予定の目的の値は変わりません。
    """
    kept = {}
    for activity_id, activity_options in options.items():
        wanted = activity_id in problem.required or problem.preferences[activity_id] > 0
        kept[activity_id] = activity_options if wanted else []
    return kept


def _check_with_validator(result):
    """検証関数で計算し直し、問題があれば状態をエラーに変える。"""
    report = validate_plan(result.problem, result.steps)
    mismatches = compare_with_solver(result, report)
    result.validation = report
    if report.ok and not mismatches:
        return
    result.messages = [
        "検証関数で予定を計算し直したところ、制約違反またはソルバーの値との不一致が見つかりました。"
        "この予定は使わないでください（モデルの不具合の可能性があります）。",
        *report.errors,
        *mismatches,
    ]
    result.status = "error"
    result.optimality_scope = "none"
    result.steps = []  # 使ってはいけない予定は返さない（理由は messages、計算し直した値は validation に残る）
    result.objective_values = {}


def _solve_stages(built, settings):
    """第1段階から順に解く。最適性を確認できなかった段階で止める。"""
    stages = []
    best = None
    for name, sense, label in STAGES:
        stage, solution = _solve_stage(built, name, sense, label, settings)
        stages.append(stage)
        if solution is not None and (best is None or _plan_key(solution) < _plan_key(best)):
            best = solution
        if not stage.proven:
            break
        # 最適値を固定し、今の解をヒントにして次の段階へ進む
        built.model.add(built.objectives[name] == stage.objective)
        _set_hints(built, solution)
    return stages, best


def _plan_key(solution):
    """優先順位（希望度は大きいほど、費用・移動・出口への到着は小さいほど良い）で比べるためのキー。"""
    _steps, values, _hints = solution
    return (-values["score"], values["extra_cost"], values["travel"], values["exit_arrival"])


def _solve_stage(built, name, sense, label, settings):
    model = built.model
    model.clear_objective()
    if sense == "max":
        model.maximize(built.objectives[name])
    else:
        model.minimize(built.objectives[name])
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(settings.time_limit_s)
    solver.parameters.num_workers = int(settings.num_workers)
    solver.parameters.random_seed = int(settings.random_seed)
    solver.parameters.relative_gap_limit = 0.0
    solver.parameters.absolute_gap_limit = 0.0
    # OR-Tools 9.15 の CP-SAT は、まれに前処理（presolve）の probing の内部チェックで Python ごと停止するため
    # （冗長な NoOverlap 制約を含む極小の例で確認）、probing を使わない。解と証明の正しさは変わらない。
    solver.parameters.cp_model_probing_level = PRESOLVE_PROBING_LEVEL
    solver.parameters.log_search_progress = bool(settings.log_search_progress)
    started = time.perf_counter()
    code = solver.solve(model)
    elapsed = time.perf_counter() - started
    cp_status = solver.status_name(code)
    solution = None
    objective = bound = None
    if code in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        objective = _as_int(solver.objective_value)
        bound = _as_int(solver.best_objective_bound)
        solution = _extract(built, solver)
    proven = code == cp_model.OPTIMAL and objective is not None and objective == bound
    stage = StageResult(name, label, sense, cp_status, objective, bound, round(elapsed, 3),
                        float(settings.time_limit_s), proven)
    return stage, solution


def _as_int(value):
    """目的値・限界値が整数であることを確かめて int にする（整数でなければそのまま）。"""
    rounded = round(value)
    return int(rounded) if abs(value - rounded) < 1e-6 else value


def _extract(built, solver):
    """ソルバーの値から、訪問順の予定と目的の値を取り出す。"""
    model_values = {name: int(solver.value(expr)) for name, expr in built.objectives.items()}
    successor = {u: v for (u, v), literal in built.arcs.items() if solver.boolean_value(literal)}
    visits = []
    node = successor.get("entrance")
    while node is not None and node != "exit":
        visits.append((node, _chosen_option(built, solver, node), solver.value(built.queue[node])))
        node = successor.get(node)
    steps = _earliest_finish_steps(built, visits)
    last = steps[-1].activity_id if steps else "entrance"
    last_end = steps[-1].end if steps else built.entry
    model_values["exit_arrival"] = last_end + built.travel_table[last]["exit"]
    hints = {"bools": {}, "ints": {}}
    for literal in list(built.present.values()) + list(built.choose.values()) + list(built.arcs.values()):
        hints["bools"][literal] = solver.boolean_value(literal)
    for variable in list(built.queue.values()) + list(built.end.values()) + [built.exit_arrival]:
        hints["ints"][variable] = solver.value(variable)
    return steps, model_values, hints


def _chosen_option(built, solver, activity_id):
    for index, option in enumerate(built.options[activity_id]):
        if solver.boolean_value(built.choose[activity_id, index]):
            return option
    raise RuntimeError(f"活動 {activity_id} の利用案が見つかりません")


def _earliest_finish_steps(built, visits):
    """同じ訪問順・同じ利用方法のまま、各項目がなるべく早く終わる並び始めの時刻を選び直す。

    目的（希望度・追加費用・移動時間）が同点の予定の中から、ソルバーは意味のない待機
    （例えば、到着後すぐ並べるのに、待ち時間の長い次の時間帯まで待つ）を選ぶことがあります。
    通常利用は「到着後すぐ」か「より短い待ち時間の時間帯の開始まで待つ」のうち最も早く終わる方を、
    短縮利用・食事は「到着後すぐ（枠の開始前なら開始まで待つ）」を選びます。
    前の項目が早く終われば、後の項目はその分だけ待てば元の時刻にもできるので、
    この直しで成立しなくなることはなく、目的の値も変わりません。
    """
    clock = built.entry
    place = "entrance"
    steps = []
    for activity_id, option, solver_queue in visits:
        arrival = clock + built.travel_table[place][activity_id]
        candidates = [option]
        if option.mode == "normal":
            candidates = [o for o in built.options[activity_id] if o.mode == "normal"]
        best = None
        for candidate in candidates:
            queue = max(arrival, candidate.lo)
            if queue <= candidate.hi:
                end = queue + candidate.wait + candidate.duration
                if best is None or (end, queue) < (best[2], best[1]):
                    best = (candidate, queue, end)
        solver_end = solver_queue + option.wait + option.duration
        if best is None or best[2] > solver_end:
            raise RuntimeError("時刻を選び直す処理で矛盾が起きました（不具合の可能性があります）")
        chosen, queue, end = best
        kind = {"normal": "attraction", "shortcut": "attraction"}.get(chosen.mode, chosen.mode)
        steps.append(PlanStep(activity_id, kind, chosen.mode, chosen.slot_id, chosen.performance_id,
                              queue, queue + chosen.wait, end, chosen.cost))
        clock = end
        place = activity_id
    return steps


def _set_hints(built, solution):
    _steps, _values, hints = solution
    built.model.clear_hints()
    for literal, value in hints["bools"].items():
        built.model.add_hint(literal, value)
    for variable, value in hints["ints"].items():
        built.model.add_hint(variable, value)


def overall_status(stages):
    """各段階のソルバーの終了状態から、全体の状態と最適性の確認範囲を決める（純粋な関数）。

    UNKNOWN（時間内に解も証明もない）は「未判定」で、決して「実行不可能」にはしません。
    第1段階が FEASIBLE（最適性未確認）なら「暫定案」で、確認範囲は none です。
    """
    first = stages[0].cp_status
    if any(s.cp_status == "MODEL_INVALID" for s in stages):
        return "error", "none"
    if first == "INFEASIBLE":
        return "infeasible", "none"
    if first == "UNKNOWN":
        return "unknown", "none"
    if not stages[0].proven:
        return "feasible", "none"
    if any(s.cp_status == "INFEASIBLE" for s in stages[1:]):
        return "error", "none"  # 目的値を固定した後に解がなくなるのは、モデルの不具合
    priority = [s for s in stages if s.name in {name for name, _, _ in PRIORITY_STAGES}]
    if len(priority) == len(PRIORITY_STAGES) and all(s.proven for s in priority):
        return "optimal", "lexicographic"  # 補助の段階の結果は、最適性の表示に影響しない
    if len(priority) >= 2 and priority[1].proven:
        return "feasible", "score_cost"
    return "feasible", "score"


def _status_messages(result):
    messages = []
    if result.status == "optimal":
        messages.append(
            "希望度合計 → 追加費用 → 移動時間 の優先順位で、最適であることを確認しました。"
            "入力した時間帯別の待ち時間表と1分単位のモデルにおける厳密解であり、"
            "実際の待ち時間や混雑を保証するものではありません。"
        )
        tie_break = [s for s in result.stages if s.name == TIE_BREAK_STAGE[0]]
        if tie_break and tie_break[0].proven:
            messages.append("同点の予定の中から、出口に最も早く着く予定を選びました（補助の段階）。")
        else:
            messages.append("補助の段階（出口への到着時刻）の最適性は確認できていませんが、上の3つの優先順位の結果には影響しません。")
    elif result.status == "feasible":
        messages.append(f"制限時間内に予定は見つかりましたが、{SCOPE_LABELS[result.optimality_scope]}の段階です（暫定案）。")
    elif result.status == "infeasible":
        checked = result.solver_info.get("prechecks", True)
        messages.append(
            "条件をすべて満たす予定は存在しないことを、ソルバーが証明しました。"
            + ("事前チェックでは単純な衝突が見つからなかったため、" if checked else "事前チェックは実行していないため、")
            + "原因は特定できていません。必須項目・入退園時刻・予算・短縮利用の枠などを一つずつ緩めて確認してください。"
        )
    elif result.status == "unknown":
        messages.append(
            "制限時間内に、予定も「予定が存在しないこと」の証明も得られませんでした。"
            "実行不可能とは限りません。制限時間を延ばすか、条件を簡単にして再実行してください。"
        )
    else:
        messages.append("モデルの作成または解の確認で問題が起きました（不具合の可能性があります）。")
    return messages


def _solver_info(settings):
    return {
        "solver": "OR-Tools CP-SAT",
        "ortools_version": ortools.__version__,
        "time_limit_s_per_stage": float(settings.time_limit_s),
        "num_workers": int(settings.num_workers),
        "random_seed": int(settings.random_seed),
        "relative_gap_limit": 0.0,
        "absolute_gap_limit": 0.0,
        "cp_model_probing_level": PRESOLVE_PROBING_LEVEL,
        "prechecks": bool(settings.run_prechecks),
    }


def _model_size(built):
    return {
        "n_activities": len(built.present),
        "n_options": len(built.choose),
        "n_arcs": len(built.arcs),
    }
