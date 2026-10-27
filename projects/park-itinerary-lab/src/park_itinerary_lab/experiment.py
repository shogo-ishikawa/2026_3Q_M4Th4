"""研究へ向けた小規模な比較実験。

A. 同時最適化: 訪問先・順序・短縮利用をまとめて決める（本体の solve_day_plan をそのまま使う）。
B. 短縮候補を先に絞る方法: 基準時刻の待ち時間から決めた規則（CANDIDATE_RULE）で、
   予算内の「短縮利用の候補の施設」を先に決め、それ以外の施設の短縮利用を禁止して、同じモデルで解く。

B の候補集合は「購入済みの集合」ではありません。A と同じく、実際に使った枠の料金だけを数えます。
この比較は「候補を先に絞る判断」が結果にどう影響するかを調べるためのものです。
A が B 以上になること自体は、B が A の選択肢を減らした問題であることから当然で、発見ではありません。
"""

import copy
import json
import math
import numbers
import random

import pandas as pd

from .data import InputError, prepare_problem, scenario_from_dict
from .model import SCOPE_LABELS, PlanResult, SolverSettings, solve_day_plan
from .report import environment_info, new_run_folder
from .timeutil import format_time, parse_time
from .validate import normal_wait_at, validate_plan

CANDIDATE_RULE = (
    "基準時刻に並び始めた場合の通常の待ち時間から、短縮利用の残る待ち時間を引いた値を「短縮できる時間」とする。"
    "施設ごとに最も安い枠（同額なら残る待ち時間の短い枠、さらにIDの順）の料金を使い、"
    "「短縮できる時間 ÷ 料金」の大きい順（同点は短縮できる時間の長い順、さらに施設IDの順）に並べ、"
    "料金の合計が予算以内に収まるものを順に候補とする（入らないものは飛ばして次を調べる）。"
    "基準時刻に通常利用できない施設や、短縮できる時間が0分以下の施設は候補にしない。"
    "料金0円の枠は比が無限大として先頭に並べる。"
    "取得済み枠をすでに持っている施設は、新しく買う候補にしない（取得済み枠は方法A・Bのどちらでも使える）。"
)

METHOD_LABELS = {"A": "A: 同時最適化", "B": "B: 候補を先に絞る"}


# ---------------------------------------------------------------------------
# 方法 B: 短縮利用の候補を先に決める
# ---------------------------------------------------------------------------


def shortlist_candidates(problem, reference_time):
    """方法 B の候補の施設を、CANDIDATE_RULE に従って決める。各施設の計算過程を返す。"""
    reference = parse_time(reference_time)
    rows = []
    held = {s.attraction_id for s in problem.slots.values() if s.acquired}
    for attraction in problem.scenario.attractions.values():
        offers = [s for s in problem.slots.values() if s.attraction_id == attraction.id and not s.acquired]
        if not offers:
            continue
        cheapest = min(offers, key=lambda s: (s.price, s.residual_wait, s.id))
        normal = None
        if attraction.queue_open <= reference < attraction.queue_close:
            normal = normal_wait_at(problem.wait_table, attraction.id, reference)
        saved = None if normal is None else normal - cheapest.residual_wait  # 通常利用できないなら計算しない
        ratio = _saving_ratio(saved, cheapest.price)
        rows.append({
            "attraction_id": attraction.id,
            "name": attraction.name,
            "reference_time": format_time(reference),
            "normal_wait_min": normal,
            "cheapest_slot": cheapest.id,
            "residual_wait_min": cheapest.residual_wait,
            "saved_min": saved,
            "price_yen": cheapest.price,
            "saved_per_1000yen": None if math.isinf(ratio) else round(ratio * 1000, 3),
            "_ratio": ratio,
            "selected": False,
            "reason": "",
        })
    rows.sort(key=lambda row: (-row["_ratio"], -(row["saved_min"] or 0), row["attraction_id"]))
    spent = 0
    for row in rows:
        if row["attraction_id"] in held:
            row["reason"] = "取得済み枠あり"
        elif row["saved_min"] is None:
            row["reason"] = "基準時刻に通常利用できない"
        elif row["saved_min"] <= 0:
            row["reason"] = "短縮できる時間が0分以下"
        elif spent + row["price_yen"] > problem.budget:
            row["reason"] = "予算を超える"
        else:
            row["selected"] = True
            row["reason"] = "候補"
            spent += row["price_yen"]
    for row in rows:
        del row["_ratio"]
    return rows


def _saving_ratio(saved, price):
    """「短縮できる時間 ÷ 料金」。通常利用できない施設は最後、料金0円は先頭（無限大）に並ぶ値にする。"""
    if saved is None:
        return -math.inf
    if price == 0:
        return math.inf
    return saved / price


def solve_method_b(scenario, conditions, settings=None, reference_time=None):
    """方法 B で解く。戻り値は (PlanResult, 候補の計算過程, 候補の施設IDのリスト)。"""
    problem = prepare_problem(scenario, conditions)
    reference_time = reference_time or conditions.get("entry_time")
    rows = shortlist_candidates(problem, reference_time)
    selected = [row["attraction_id"] for row in rows if row["selected"]]
    conditions_b = dict(conditions, shortcut_candidates=selected)
    return solve_day_plan(scenario, conditions_b, settings), rows, selected


# ---------------------------------------------------------------------------
# 条件を変えたケースを作る
# ---------------------------------------------------------------------------


VARIANT_KEYS = ("label", "show_id", "starts", "x", "y", "required", "exclude")


def apply_show_variant(scenario, variant):
    """ショーの開演時刻や場所を変えたシナリオを作る（元のシナリオは変更しない）。

    variant の例: {"label": "13時・奥", "show_id": "S1", "starts": ["13:00"], "x": 0, "y": 650}
    starts を省略すると公演回はそのまま、x / y を省略すると場所はそのまま。
    "exclude": True なら、そのショーをシナリオから外す（固定時刻の予定がない基準）。
    """
    if not variant:
        return scenario
    _check_variant(variant)
    if variant["show_id"] not in scenario.shows:
        raise InputError([f"ショー '{variant['show_id']}' がありません（show_id を確かめてください）"])
    changes = variant.get("starts") or variant.get("x") is not None or variant.get("y") is not None
    if not (changes or variant.get("exclude")):
        return scenario
    raw = copy.deepcopy(scenario.raw)
    show = next(s for s in raw["shows"] if s["id"] == variant["show_id"])
    if variant.get("exclude"):
        raw["shows"] = [s for s in raw["shows"] if s["id"] != variant["show_id"]]
        return scenario_from_dict(raw)
    moved = variant.get("x") is not None or variant.get("y") is not None
    if moved and raw.get("walk_minutes") is not None:
        raise InputError(["移動時間の表（walk_minutes）を使うシナリオでは、座標を変えても移動時間は変わりません"])
    if variant.get("starts"):
        show["performances"] = [
            {"id": f"{show['id']}-{start.replace(':', '')}", "start": start} for start in variant["starts"]
        ]
    for key in ("x", "y"):
        if variant.get(key) is not None:
            show[key] = variant[key]
    return scenario_from_dict(raw)


def _check_variant(variant, where="show_variant"):
    """ショーの条件の書き方を確かめ、誤りは InputError（日本語）にする。"""
    problems = _variant_problems(variant, where)
    if problems:
        raise InputError(problems)


def _variant_problems(variant, where):
    """ショーの条件1つの誤りを、日本語の文のリストで返す。"""
    if not isinstance(variant, dict):
        return [f'{where} は辞書で書いてください 例: {{"label": "13時の回だけ", "show_id": "S1", "starts": ["13:00"]}}']
    problems = []
    unknown = sorted(set(variant) - set(VARIANT_KEYS))
    if unknown:
        problems.append(f"{where} に使えないキーがあります: {unknown}（使えるキー: {', '.join(VARIANT_KEYS)}）")
    label = variant.get("label")
    if not isinstance(label, str) or not label.strip():
        problems.append(f"{where} に label（表に出す名前）を文字列で書いてください")
    if not isinstance(variant.get("show_id"), str):
        problems.append(f"{where} に show_id（ショーのID）を文字列で書いてください")
    starts = variant.get("starts")
    if starts is not None:
        if not isinstance(starts, (list, tuple)) or not starts:
            problems.append(f'{where} の starts は "HH:MM" の文字列のリストにしてください')
        else:
            problems += [f'{where} の starts の {start!r} は "HH:MM" の形式で書いてください'
                         for start in starts if not _is_time_text(start)]
    for key in ("x", "y"):
        value = variant.get(key)
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
            problems.append(f"{where} の {key} は数値にしてください")
    for key in ("required", "exclude"):
        if key in variant and not isinstance(variant[key], bool):
            problems.append(f"{where} の {key} は True か False にしてください")
    if variant.get("exclude") and (starts or variant.get("x") is not None or variant.get("y") is not None):
        problems.append(f"{where}: exclude（ショーを外す）と、開演時刻・場所の変更は同時に指定できません")
    return problems


def _is_time_text(value):
    if not isinstance(value, str):
        return False
    try:
        parse_time(value)
    except ValueError:
        return False
    return True


def check_experiment_settings(budgets, show_variants, reference_time=None):
    """比較実験の設定の形（予算・ショーの条件の一覧・基準時刻）を確かめ、誤りは InputError（日本語）にする。

    ケースの一覧を作れない誤り（ラベルがない・重複している、予算がリストでない など）は、計算を始める前に止めます。
    1つのショーの条件の中身の誤り（存在しないショー・時刻の書き方など）は、そのケースをエラーの行として表に残します。
    """
    problems = _budget_problems(budgets) + _variant_list_problems(show_variants) + _reference_problems(reference_time)
    if problems:
        raise InputError(problems)


def _budget_problems(budgets):
    if not isinstance(budgets, (list, tuple)) or not budgets:
        return ["EXPERIMENT_BUDGETS は、予算（0以上の整数, 円）のリストにしてください 例: [0, 1000, 2000]"]
    problems = [f"EXPERIMENT_BUDGETS の {budget!r} は0以上の整数（円）にしてください"
                for budget in budgets if isinstance(budget, bool) or not isinstance(budget, int) or budget < 0]
    if len(set(map(repr, budgets))) < len(budgets):
        problems.append("EXPERIMENT_BUDGETS に同じ予算が2回以上あります")
    return problems


def _variant_list_problems(show_variants):
    if not isinstance(show_variants, (list, tuple)) or not show_variants:
        return ["EXPERIMENT_SHOW_VARIANTS は、ショーの条件（辞書）のリストにしてください"]
    problems = []
    labels = []
    for number, variant in enumerate(show_variants, start=1):
        label = variant.get("label") if isinstance(variant, dict) else None
        if isinstance(label, str) and label.strip():
            labels.append(label)
        else:
            problems.append(f'EXPERIMENT_SHOW_VARIANTS の{number}番目は、label（表に出す名前）を持つ辞書にしてください'
                            f' 例: {{"label": "13時の回だけ", "show_id": "S1", "starts": ["13:00"]}}')
    repeated = sorted({label for label in labels if labels.count(label) > 1})
    if repeated:
        problems.append(f"EXPERIMENT_SHOW_VARIANTS の label が重複しています: {repeated}")
    return problems


def _reference_problems(reference_time):
    if reference_time is None or _is_time_text(reference_time):
        return []
    return [f'REFERENCE_TIME は "HH:MM" の文字列か None にしてください（{reference_time!r}）']


def _seed_problems(seeds):
    if not isinstance(seeds, (list, tuple)) or not seeds or not all(
            isinstance(seed, int) and not isinstance(seed, bool) for seed in seeds):
        return ["BATCH_SEEDS は、乱数の seed（整数）のリストにしてください 例: [1, 2, 3]"]
    if len(set(seeds)) < len(seeds):
        return ["BATCH_SEEDS に同じ seed が2回以上あります"]
    return []


def conditions_for_variant(base_conditions, variant, scenario=None):
    """ショーの条件に合わせて、必須ショーと希望度の指定を変えた条件を作る（元の条件は変えない）。

    "required": True なら、そのショーを必須にする。"required": False なら必須から外す
    （希望度があれば、任意の予定として選ばれることがある）。
    "exclude": True なら必須から外し、希望度の指定からも除く（シナリオからは apply_show_variant で外す）。
    """
    conditions = copy.deepcopy(base_conditions)
    shows = conditions.get("required_shows") or []
    if not variant or not isinstance(shows, (list, tuple)):
        return conditions  # 形の誤りは prepare_problem が日本語で説明する
    show_id = variant.get("show_id")
    if variant.get("required") is True and show_id not in shows:
        conditions["required_shows"] = [*shows, show_id]
    if variant.get("required") is False or variant.get("exclude"):
        conditions["required_shows"] = [s for s in shows if s != show_id]
    if variant.get("exclude"):
        _drop_show_preference(conditions, show_id, scenario)
    return conditions


def _drop_show_preference(conditions, show_id, scenario):
    """外すショーを、希望度の指定から除く。ほかの活動の希望度は変えない。

    希望順位（preference_rank）から一覧を作り直すと、ほかの活動の順位と希望度が変わってしまうので、
    元の順位で決まる希望度を、すべての活動について明示した preferences に置き換えてから除きます。
    """
    rank = conditions.get("preference_rank")
    if scenario is not None and isinstance(rank, (list, tuple)) and rank and not conditions.get("preferences"):
        activity_ids = [*scenario.attractions, *scenario.shows, *scenario.meals]
        if all(isinstance(a, str) and a in activity_ids for a in rank) and len(set(rank)) == len(rank):
            weights = {activity_id: 0 for activity_id in activity_ids}
            for position, activity_id in enumerate(rank):
                weights[activity_id] = len(rank) - position
            conditions["preferences"] = weights
            conditions["preference_rank"] = None
    if isinstance(conditions.get("preferences"), dict):
        conditions["preferences"].pop(show_id, None)


def comparison_cases(budgets, show_variants):
    """予算とショーの条件の組合せを、ケースの一覧にする（設定の誤りは InputError）。"""
    check_experiment_settings(budgets, show_variants)
    cases = []
    for variant in show_variants:
        for budget in budgets:
            cases.append({
                "case_id": f"{variant['label']}／予算{budget}円",
                "budget_yen": budget,
                "show_variant": variant,
            })
    return cases


# ---------------------------------------------------------------------------
# 比較を実行して表にする
# ---------------------------------------------------------------------------


def run_comparison(scenario, base_conditions, cases, settings=None, reference_time=None, seed=None):
    """各ケースで方法 A と B を解き、1行1方法の表と、予定の詳細を返す。

    タイムアウト・実行不可能・入力エラーのケースも除外せず、状態とともに表に残します。
    """
    settings = settings or SolverSettings()
    _check_cases(cases, reference_time)
    rows = []
    details = {}
    for case in cases:
        variant = case.get("show_variant")
        conditions = dict(base_conditions, budget_yen=case["budget_yen"])
        reference = reference_time or conditions.get("entry_time")
        try:
            case_scenario = apply_show_variant(scenario, variant)
            conditions = conditions_for_variant(conditions, variant, scenario)
        except InputError as error:
            result_a = result_b = PlanResult("error", "none", messages=list(error.problems))
            case_scenario, candidate_rows, selected = scenario, [], []
        else:
            result_a = solve_day_plan(case_scenario, conditions, settings)
            result_b, candidate_rows, selected = _solve_b_safely(case_scenario, conditions, settings, reference)
        report_a = _validate(result_a)
        report_b = _validate(result_b)
        common = _case_settings(case, case_scenario, conditions, settings, seed)
        row_a = _result_row(common, "A", result_a, report_a, "", "全施設（制限なし）")
        row_b = _result_row(common, "B", result_b, report_b, reference, ", ".join(selected) or "なし")
        row_b["b_same_options_as_a"] = _same_options(result_a, selected) if result_a.has_plan else None
        _add_difference(row_b, result_a, result_b, row_a)
        rows += [row_a, row_b]
        details[case["case_id"]] = {
            "conditions": conditions,
            "A": {"result": result_a, "report": report_a},
            "B": {"result": result_b, "report": report_b, "candidates": candidate_rows},
        }
    return pd.DataFrame(rows), details


def _check_cases(cases, reference_time):
    """計算を始める前に、ケースIDの重複と基準時刻の書き方を確かめる。"""
    problems = _reference_problems(reference_time)
    ids = [case["case_id"] for case in cases]
    repeated = sorted({case_id for case_id in ids if ids.count(case_id) > 1})
    if repeated:
        problems.append(f"ケースIDが重複しています（ショーの条件の label・予算・seed を確かめてください）: {repeated}")
    if problems:
        raise InputError(problems)


def _solve_b_safely(scenario, conditions, settings, reference):
    try:
        return solve_method_b(scenario, conditions, settings, reference)
    except InputError as error:
        return PlanResult("error", "none", messages=list(error.problems)), [], []


def _validate(result):
    """予定がある結果だけ、検証関数の結果を返す（エラーになった予定の値は表に出さない）。"""
    if not result.has_plan:
        return None
    if result.validation is not None:
        return result.validation
    return validate_plan(result.problem, result.steps)


def _same_options(result_a, selected):
    """B の候補が、予算内で買える枠のある施設をすべて含むなら、B は A と同じ問題になる。"""
    problem = result_a.problem
    if problem is None:
        return None
    # 必ず使う取得済み枠がある施設は、方法Aでもその枠しか使えないので、比べる対象から除く
    fixed = {problem.slots[slot_id].attraction_id for slot_id in problem.must_use_slots}
    affordable = {s.attraction_id for s in problem.slots.values()
                  if not s.acquired and s.price <= problem.budget and s.attraction_id not in fixed}
    return affordable <= set(selected)


def _stage_value(result, index, key):
    if len(result.stages) > index:
        return getattr(result.stages[index], key)
    return None


def _case_settings(case, scenario, conditions, settings, seed):
    variant = case.get("show_variant") or {}
    return {
        "case_id": case["case_id"],
        "seed": seed,
        "scenario": scenario.meta.get("title", ""),
        "season": conditions.get("season"),
        "entry_time": conditions.get("entry_time"),
        "exit_time": conditions.get("exit_time"),
        "budget_yen": case["budget_yen"],
        "show_variant": variant.get("label", "元のまま"),
        "required_shows": _id_text(conditions.get("required_shows")),
        "time_limit_s_per_stage": settings.time_limit_s,
        "num_workers": settings.num_workers,
        "solver_random_seed": settings.random_seed,
    }


def _id_text(value):
    """IDのリストを "S1, S2" の文字列にする（空なら「なし」。形の誤りもそのまま文字にする）。"""
    if isinstance(value, (list, tuple)):
        return ", ".join(map(str, value)) or "なし"
    return "なし" if value is None else str(value)


def _used_shortcuts(report):
    if report is None:
        return "", ""
    used = [row for row in report.rows if row["mode_key"].startswith("shortcut")]
    attractions = ", ".join(row["activity_id"] for row in used)
    slots = ", ".join(f"{row['slot_id']}({format_time(row['slot_window'][0])}-{format_time(row['slot_window'][1])})"
                      for row in used)
    return attractions, slots


def _shows_attended(report):
    """鑑賞したショーの公演回（例: "S1-1500"）。"""
    if report is None:
        return ""
    return ", ".join(row["performance_id"] for row in report.rows if row["kind"] == "show")


def _result_row(common, method, result, report, reference, candidates):
    metrics = report.metrics if report is not None else {}
    used_attractions, used_slots = _used_shortcuts(report)
    return {
        **common,
        "method": METHOD_LABELS[method],
        "status": result.status,
        "status_label": result.status_label,
        "optimality_scope": result.optimality_scope,
        "score": metrics.get("score"),
        "extra_cost_yen": metrics.get("extra_cost_yen"),
        "travel_min": metrics.get("travel_min"),
        "queue_wait_min": metrics.get("queue_wait_min"),
        "exit_arrival": format_time(metrics["exit_arrival"]) if metrics else None,
        "n_activities": metrics.get("n_activities"),
        "used_shortcut_attractions": used_attractions,
        "used_slots": used_slots,
        "shows_attended": _shows_attended(report),
        "solve_time_s": round(sum(stage.wall_time_s for stage in result.stages), 3),
        "score_status": _stage_value(result, 0, "cp_status"),
        "score_objective": _stage_value(result, 0, "objective"),
        "score_bound": _stage_value(result, 0, "bound"),
        "score_time_s": _stage_value(result, 0, "wall_time_s"),
        "cost_status": _stage_value(result, 1, "cp_status"),
        "cost_objective": _stage_value(result, 1, "objective"),
        "cost_bound": _stage_value(result, 1, "bound"),
        "cost_time_s": _stage_value(result, 1, "wall_time_s"),
        "travel_status": _stage_value(result, 2, "cp_status"),
        "travel_objective": _stage_value(result, 2, "objective"),
        "travel_bound": _stage_value(result, 2, "bound"),
        "travel_time_s": _stage_value(result, 2, "wall_time_s"),
        "exit_arrival_stage_status": _stage_value(result, 3, "cp_status"),
        "shortcut_candidates": candidates,
        "b_same_options_as_a": None,
        "reference_time": reference,
        "validation_ok": None if report is None else report.ok,
        "score_diff_A_minus_B": None,
        "cost_diff_B_minus_A": None,
        "diff_note": "",
        "reason": _reason(result),
        "message": " ／ ".join(result.messages),
    }


def _reason(result):
    """予定がない場合の理由。事前チェックで分かった場合は、その具体的な内容を返す（予定があれば空）。"""
    if result.has_plan:
        return ""
    proofs = [issue.message for issue in result.precheck_issues if issue.proves_infeasible]
    return " ／ ".join(proofs or result.messages)


def _score_proven(result):
    return result.has_plan and result.optimality_scope in ("lexicographic", "score_cost", "score")


def _add_difference(row_b, result_a, result_b, row_a):
    """A と B の両方で希望度合計の最適性を確認できたときだけ、差（A − B）を計算する。

    どちらかが暫定案の場合、差にはソルバーの打ち切りの影響が混ざるので計算しません。
    """
    if result_a.status in ("infeasible", "error"):
        row_b["diff_note"] = (f"Aに予定がないため、差を計算しない（A: {result_a.status_label}／B: {result_b.status_label}。"
                              "理由は「予定がない理由」の列、CSV では reason の列）")
    elif not _score_proven(result_a):
        row_b["diff_note"] = f"Aの希望度合計が最適と確認できていないため、差を計算しない（A: {result_a.status_label}）"
    elif not result_b.has_plan:
        row_b["diff_note"] = f"Bでは予定が得られていない（B: {result_b.status_label}）"
    elif not _score_proven(result_b):
        row_b["diff_note"] = "Bは暫定案のため、手法の影響として差を計算しない"
    else:
        row_b["score_diff_A_minus_B"] = row_a["score"] - row_b["score"]
        if row_a["score"] == row_b["score"] and _cost_proven(result_a) and _cost_proven(result_b):
            row_b["cost_diff_B_minus_A"] = row_b["extra_cost_yen"] - row_a["extra_cost_yen"]


def _cost_proven(result):
    return result.has_plan and result.optimality_scope in ("lexicographic", "score_cost")


def save_comparison(table, output_root, label, settings_info):
    """比較の表（CSV）と設定（JSON）を、outputs/ の中の新しいフォルダに保存する。"""
    folder = new_run_folder(output_root, label)
    table.to_csv(folder / "comparison.csv", index=False, encoding="utf-8-sig")
    info = dict(settings_info, candidate_rule=CANDIDATE_RULE, environment=environment_info())
    with (folder / "settings.json").open("w", encoding="utf-8") as file:
        json.dump(info, file, ensure_ascii=False, indent=2, default=str)
    return folder


# Notebook で表示するときの日本語の列名（CSV には英語の列名のまま保存します）
COMPARISON_VIEW_COLUMNS = {
    "case_id": "ケース",
    "method": "方法",
    "status_label": "状態",
    "scope_label": "最適性の確認範囲",
    "score": "希望度合計",
    "extra_cost_yen": "追加費用(円)",
    "travel_min": "移動(分)",
    "used_shortcut_attractions": "短縮利用した施設",
    "shows_attended": "見たショーの回",
    "shortcut_candidates": "方法Bの候補",
    "same_options_label": "Bの選択肢がAと同じ",
    "score_diff_A_minus_B": "希望度合計の差（A − B）",
    "cost_diff_B_minus_A": "同点のときの追加費用の差（B − A）",
    "diff_note": "差の注記",
    "reason": "予定がない理由",
}
CANDIDATE_VIEW_COLUMNS = {
    "attraction_id": "施設ID",
    "name": "名前",
    "reference_time": "基準時刻",
    "normal_wait_min": "通常の待ち(分)",
    "cheapest_slot": "最も安い枠",
    "residual_wait_min": "枠の残る待ち(分)",
    "saved_min": "短縮できる時間(分)",
    "price_yen": "料金(円)",
    "saved_per_1000yen": "1000円あたりの短縮(分)",
    "selected": "候補",
    "reason": "理由",
}


def comparison_view(table):
    """比較の表を、Notebook で読むための日本語の列名の表にする（元の表は変えない）。"""
    view = table.copy()
    view["scope_label"] = [SCOPE_LABELS.get(scope, scope) if status in ("optimal", "feasible") else ""
                           for status, scope in zip(view["status"], view["optimality_scope"])]
    view["same_options_label"] = [{True: "はい（差は構造上0）", False: "いいえ"}.get(value, "")
                                  for value in view["b_same_options_as_a"]]
    view["reason"] = [_display(reason) if status in ("infeasible", "unknown", "error") else ""
                      for status, reason in zip(view["status"], view["reason"])]
    for column in ("score", "extra_cost_yen", "travel_min", "score_diff_A_minus_B", "cost_diff_B_minus_A"):
        view[column] = [_display(value) for value in view[column]]
    return view[list(COMPARISON_VIEW_COLUMNS)].rename(columns=COMPARISON_VIEW_COLUMNS)


def _display(value):
    """表示用: 欠損値は空欄、整数の値（3.0 など）は整数（3）にする。"""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ""
    if isinstance(value, numbers.Integral) and not isinstance(value, bool):
        return int(value)
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def candidate_view(rows):
    """方法Bの候補の計算過程（shortlist_candidates の結果）を、日本語の列名の表にする。"""
    table = pd.DataFrame(rows, columns=list(CANDIDATE_VIEW_COLUMNS))
    table["selected"] = table["selected"].map({True: "候補", False: ""})
    return table.rename(columns=CANDIDATE_VIEW_COLUMNS)


def representative_cases(table):
    """差が最大のケースと、差が0のケースを1つずつ選ぶ（差を計算できたケースの中から）。

    差が0のケースは、B の選択肢が A と同じになったもの（構造上、差が0）を避け、
    A と B で使った短縮利用や追加費用が違うものを優先します。
    """
    b_rows = table[table["method"] == METHOD_LABELS["B"]]
    measured = b_rows.dropna(subset=["score_diff_A_minus_B"])
    chosen = []
    if measured.empty:
        return chosen
    chosen.append(measured.sort_values("score_diff_A_minus_B", ascending=False).iloc[0]["case_id"])
    zero = measured[(measured["score_diff_A_minus_B"] == 0) & (~measured["case_id"].isin(chosen))]
    a_rows = {row["case_id"]: row for _index, row in table[table["method"] == METHOD_LABELS["A"]].iterrows()}

    def choices_differ(row):
        a_row = a_rows.get(row["case_id"])
        if a_row is None:
            return False
        return (_id_set(a_row["used_shortcut_attractions"]) != _id_set(row["used_shortcut_attractions"])
                or a_row["extra_cost_yen"] != row["extra_cost_yen"])

    candidates = [zero]
    if {"b_same_options_as_a", "used_shortcut_attractions", "extra_cost_yen"} <= set(table.columns) and not zero.empty:
        different = zero[zero["b_same_options_as_a"] == False]  # noqa: E712
        candidates = [different[different.apply(choices_differ, axis=1)] if not different.empty else different,
                      different, zero]
    for preferred in candidates:
        if not preferred.empty:
            chosen.append(preferred.iloc[0]["case_id"])
            break
    return chosen


# ---------------------------------------------------------------------------
# 乱数で作る架空のシナリオ（一括実験・テスト用）
# ---------------------------------------------------------------------------


def _id_set(text):
    """"A4, A6" のような文字列を、順番を無視した集合にする（空欄や欠損値は空集合）。"""
    if not isinstance(text, str):
        return frozenset()
    return frozenset(part.strip() for part in text.split(",") if part.strip())


def generate_random_scenario(
    seed,
    n_attractions=8,
    n_shortcut_attractions=3,
    n_shows=1,
    with_meal=True,
    day=("09:00", "21:00"),
    band_minutes=60,
    area_m=(900, 700),
    duration_range=(2, 15),
    peak_wait_range=(20, 110),
    slot_minutes=60,
    slot_every_minutes=180,
):
    """乱数 seed から、架空のパークのシナリオ（辞書）を作る。同じ seed なら同じ内容になる。"""
    rng = random.Random(seed)
    opening, closing = parse_time(day[0]), parse_time(day[1])
    attractions, popularity = _random_attractions(rng, n_attractions, area_m, duration_range, day)
    bands = list(range(opening, closing, band_minutes))
    waits = {}
    for attraction in attractions:
        peak = peak_wait_range[0] + popularity[attraction["id"]] * (peak_wait_range[1] - peak_wait_range[0])
        waits[attraction["id"]] = [_wait_profile(peak, start + band_minutes / 2, opening, closing) for start in bands]
    popular = sorted(popularity, key=lambda a: -popularity[a])[:n_shortcut_attractions]
    offers = _random_offers(rng, popular, opening, closing, slot_minutes, slot_every_minutes)
    return {
        "format_version": 1,
        "meta": {
            "title": f"乱数で作った架空パーク（seed={seed}）",
            "source_type": "fictional",
            "checked_on": None,
            "assumptions": ["乱数で生成した架空の値で、実在の施設やサービスとは関係ありません。"],
            "notes": "",
        },
        "cost_basis": "per_person",
        "gates": {"entrance": {"name": "入口", "x": 0, "y": 0}, "exit": {"name": "出口", "x": 0, "y": 0}},
        "walking": {"metres_per_minute": 60, "distance": "manhattan"},
        "walk_minutes": None,
        "attractions": attractions,
        "wait_tables": {
            "random": {
                "label": "乱数で作った待ち時間",
                "bands": [f"{format_time(s)}-{format_time(min(s + band_minutes, closing))}" for s in bands],
                "wait_min": waits,
            }
        },
        "shortcut_offers": offers,
        "shows": _random_shows(rng, n_shows, area_m, opening, closing),
        "meals": _random_meal(area_m, opening, closing) if with_meal else [],
    }


def _random_attractions(rng, count, area_m, duration_range, day):
    attractions = []
    popularity = {}
    for number in range(1, count + 1):
        attraction_id = f"R{number}"
        popularity[attraction_id] = rng.random()
        attractions.append({
            "id": attraction_id,
            "name": f"施設{number}",
            "x": rng.randint(-area_m[0] // 2, area_m[0] // 2),
            "y": rng.randint(60, area_m[1]),
            "duration_min": rng.randint(*duration_range),
            "preference": rng.randint(1, 10),
            "queue_open": day[0],
            "queue_close": day[1],
            "finish_by": None,
        })
    return attractions, popularity


def _wait_profile(peak, minute, opening, closing):
    """開園直後と夕方に短く、昼過ぎに長い待ち時間（5分単位）。"""
    middle = opening + (closing - opening) * 0.4
    width = (closing - opening) * 0.25
    factor = 0.3 + 0.7 * math.exp(-(((minute - middle) / width) ** 2))
    return int(5 * round(peak * factor / 5))


def _random_offers(rng, attraction_ids, opening, closing, slot_minutes, every_minutes):
    offers = []
    for attraction_id in attraction_ids:
        price = rng.choice([600, 800, 1000, 1200])
        residual = rng.choice([5, 10])
        start = opening + every_minutes // 3
        while start + slot_minutes <= closing:
            offers.append({
                "id": f"P-{attraction_id}-{format_time(start).replace(':', '')}",
                "attraction": attraction_id,
                "window": f"{format_time(start)}-{format_time(start + slot_minutes)}",
                "price_yen": price,
                "residual_wait_min": residual,
            })
            start += every_minutes
    return offers


def _random_shows(rng, count, area_m, opening, closing):
    shows = []
    for number in range(1, count + 1):
        candidates = list(range(opening + 120, closing - 120, 30)) or [opening + (closing - opening) // 2]
        starts = sorted(rng.sample(candidates, k=min(2, len(candidates))))
        shows.append({
            "id": f"SH{number}",
            "name": f"ショー{number}",
            "x": rng.randint(-area_m[0] // 2, area_m[0] // 2),
            "y": rng.randint(60, area_m[1]),
            "duration_min": 30,
            "arrive_before_min": 15,
            "preference": rng.randint(3, 10),
            "performances": [
                {"id": f"SH{number}-{format_time(s).replace(':', '')}", "start": format_time(s)} for s in starts
            ],
        })
    return shows


def _random_meal(area_m, opening, closing):
    start = max(opening, parse_time("11:00"))
    end = min(closing, start + 180)
    return [{
        "id": "MEAL",
        "name": "食事",
        "x": 0,
        "y": area_m[1] // 2,
        "duration_min": 40,
        "window": f"{format_time(start)}-{format_time(end)}",
        "preference": 0,
    }]


def run_random_batch(seeds, budgets, base_conditions, settings=None, reference_time=None, **generator_options):
    """乱数のシナリオを seed ごとに作り、予算を変えて A と B を比較する（明示的に呼んだときだけ実行）。"""
    problems = _seed_problems(seeds) + _budget_problems(budgets) + _reference_problems(reference_time)
    if problems:
        raise InputError(problems)
    tables = []
    for seed in seeds:
        scenario = scenario_from_dict(generate_random_scenario(seed, **generator_options))
        cases = [{"case_id": f"seed{seed}／予算{b}円", "budget_yen": b, "show_variant": None} for b in budgets]
        table, _details = run_comparison(scenario, base_conditions, cases, settings, reference_time, seed=seed)
        tables.append(table)
    return pd.concat(tables, ignore_index=True) if tables else pd.DataFrame()
