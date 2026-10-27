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
import random

import pandas as pd

from .data import InputError, prepare_problem, scenario_from_dict
from .model import PlanResult, SolverSettings, solve_day_plan
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
)

METHOD_LABELS = {"A": "A: 同時最適化", "B": "B: 候補を先に絞る"}


# ---------------------------------------------------------------------------
# 方法 B: 短縮利用の候補を先に決める
# ---------------------------------------------------------------------------


def shortlist_candidates(problem, reference_time):
    """方法 B の候補の施設を、CANDIDATE_RULE に従って決める。各施設の計算過程を返す。"""
    reference = parse_time(reference_time)
    rows = []
    for attraction in problem.scenario.attractions.values():
        offers = [s for s in problem.slots.values() if s.attraction_id == attraction.id and not s.acquired]
        if not offers:
            continue
        cheapest = min(offers, key=lambda s: (s.price, s.residual_wait, s.id))
        normal = None
        if attraction.queue_open <= reference < attraction.queue_close:
            normal = normal_wait_at(problem.wait_table, attraction.id, reference)
        saved = 0 if normal is None else normal - cheapest.residual_wait
        ratio = math.inf if cheapest.price == 0 else saved / cheapest.price
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
    rows.sort(key=lambda row: (-row["_ratio"], -row["saved_min"], row["attraction_id"]))
    spent = 0
    for row in rows:
        if row["saved_min"] <= 0:
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


def apply_show_variant(scenario, variant):
    """ショーの開演時刻や場所を変えたシナリオを作る（元のシナリオは変更しない）。

    variant の例: {"label": "13時・奥", "show_id": "S1", "starts": ["13:00"], "x": 0, "y": 650}
    starts を省略すると公演回はそのまま、x / y を省略すると場所はそのまま。
    """
    if not variant or not (variant.get("starts") or variant.get("x") is not None or variant.get("y") is not None):
        return scenario
    _check_variant(variant)
    raw = copy.deepcopy(scenario.raw)
    show = next((s for s in raw["shows"] if s["id"] == variant["show_id"]), None)
    if show is None:
        raise InputError([f"ショー '{variant['show_id']}' がありません"])
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


def _check_variant(variant):
    """ショーの条件の書き方を確かめ、誤りは InputError（日本語）にする。"""
    problems = []
    if not isinstance(variant.get("show_id"), str):
        problems.append("show_variant には show_id（ショーのID）を文字列で書いてください")
    starts = variant.get("starts")
    if starts is not None and (not isinstance(starts, (list, tuple)) or not all(isinstance(s, str) for s in starts)):
        problems.append('show_variant の starts は "HH:MM" の文字列のリストにしてください')
    for key in ("x", "y"):
        value = variant.get(key)
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
            problems.append(f"show_variant の {key} は数値にしてください")
    if problems:
        raise InputError(problems)


def conditions_for_variant(base_conditions, variant):
    """variant に "required": False があれば、そのショーを必須から外す（固定時刻の予定がない基準）。"""
    conditions = copy.deepcopy(base_conditions)
    if variant and variant.get("required") is False:
        shows = [s for s in conditions.get("required_shows") or [] if s != variant["show_id"]]
        conditions["required_shows"] = shows
    return conditions


def comparison_cases(budgets, show_variants):
    """予算とショーの条件の組合せを、ケースの一覧にする。"""
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
    rows = []
    details = {}
    for case in cases:
        variant = case.get("show_variant")
        conditions = conditions_for_variant(dict(base_conditions, budget_yen=case["budget_yen"]), variant)
        reference = reference_time or conditions.get("entry_time")
        try:
            case_scenario = apply_show_variant(scenario, variant)
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
        row_b["b_same_options_as_a"] = _same_options(result_a, selected)
        _add_difference(row_b, result_a, result_b, row_a)
        rows += [row_a, row_b]
        details[case["case_id"]] = {
            "conditions": conditions,
            "A": {"result": result_a, "report": report_a},
            "B": {"result": result_b, "report": report_b, "candidates": candidate_rows},
        }
    return pd.DataFrame(rows), details


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
    affordable = {s.attraction_id for s in problem.slots.values() if not s.acquired and s.price <= problem.budget}
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
        "required_shows": ", ".join(conditions.get("required_shows") or []) or "なし",
        "time_limit_s_per_stage": settings.time_limit_s,
        "num_workers": settings.num_workers,
        "solver_random_seed": settings.random_seed,
    }


def _used_shortcuts(report):
    if report is None:
        return "", ""
    used = [row for row in report.rows if row["mode_key"].startswith("shortcut")]
    attractions = ", ".join(row["activity_id"] for row in used)
    slots = ", ".join(f"{row['slot_id']}({format_time(row['slot_window'][0])}-{format_time(row['slot_window'][1])})"
                      for row in used)
    return attractions, slots


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
        "solve_time_s": round(sum(stage.wall_time_s for stage in result.stages), 3),
        "score_status": _stage_value(result, 0, "cp_status"),
        "score_objective": _stage_value(result, 0, "objective"),
        "score_bound": _stage_value(result, 0, "bound"),
        "cost_status": _stage_value(result, 1, "cp_status"),
        "cost_bound": _stage_value(result, 1, "bound"),
        "travel_status": _stage_value(result, 2, "cp_status"),
        "travel_bound": _stage_value(result, 2, "bound"),
        "shortcut_candidates": candidates,
        "b_same_options_as_a": None,
        "reference_time": reference,
        "validation_ok": None if report is None else report.ok,
        "score_diff_A_minus_B": None,
        "diff_note": "",
        "message": result.messages[0] if result.messages else "",
    }


def _score_proven(result):
    return result.has_plan and result.optimality_scope in ("lexicographic", "score_cost", "score")


def _add_difference(row_b, result_a, result_b, row_a):
    """A と B の両方で希望度合計の最適性を確認できたときだけ、差（A − B）を計算する。

    どちらかが暫定案の場合、差にはソルバーの打ち切りの影響が混ざるので計算しません。
    """
    if not _score_proven(result_a):
        row_b["diff_note"] = f"Aの希望度合計が最適と確認できていないため、差を計算しない（A: {result_a.status_label}）"
    elif not result_b.has_plan:
        row_b["diff_note"] = f"Bでは予定が得られていない（B: {result_b.status_label}）"
    elif not _score_proven(result_b):
        row_b["diff_note"] = "Bは暫定案のため、手法の影響として差を計算しない"
    else:
        row_b["score_diff_A_minus_B"] = row_a["score"] - row_b["score"]


def save_comparison(table, output_root, label, settings_info):
    """比較の表（CSV）と設定（JSON）を、outputs/ の中の新しいフォルダに保存する。"""
    folder = new_run_folder(output_root, label)
    table.to_csv(folder / "comparison.csv", index=False, encoding="utf-8-sig")
    info = dict(settings_info, candidate_rule=CANDIDATE_RULE, environment=environment_info())
    with (folder / "settings.json").open("w", encoding="utf-8") as file:
        json.dump(info, file, ensure_ascii=False, indent=2, default=str)
    return folder


def representative_cases(table):
    """差が最大のケースと、差が0のケースを1つずつ選ぶ（差を計算できたケースの中から）。"""
    b_rows = table[table["method"] == METHOD_LABELS["B"]]
    measured = b_rows.dropna(subset=["score_diff_A_minus_B"])
    chosen = []
    if not measured.empty:
        chosen.append(measured.sort_values("score_diff_A_minus_B", ascending=False).iloc[0]["case_id"])
        zero = measured[measured["score_diff_A_minus_B"] == 0]
        if not zero.empty and zero.iloc[0]["case_id"] not in chosen:
            chosen.append(zero.iloc[0]["case_id"])
    return chosen


# ---------------------------------------------------------------------------
# 乱数で作る架空のシナリオ（一括実験・テスト用）
# ---------------------------------------------------------------------------


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
    tables = []
    for seed in seeds:
        scenario = scenario_from_dict(generate_random_scenario(seed, **generator_options))
        cases = [{"case_id": f"seed{seed}／予算{b}円", "budget_yen": b, "show_variant": None} for b in budgets]
        table, _details = run_comparison(scenario, base_conditions, cases, settings, reference_time, seed=seed)
        tables.append(table)
    return pd.concat(tables, ignore_index=True) if tables else pd.DataFrame()
