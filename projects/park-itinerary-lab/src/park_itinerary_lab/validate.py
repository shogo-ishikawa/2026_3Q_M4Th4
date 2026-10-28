"""計算結果を、最適化とは別の計算で確かめる検証関数。

ソルバーが返した「訪問順・利用方法（通常／短縮の枠／公演回）・並び始めの時刻」だけを使い、
移動・到着・待機・待ち時間・開始・終了・費用・必須条件を最初から計算し直します。
待ち時間の表や枠の確認は、このファイルの中の関数で行い、最適化モデル（model.py）や
利用案の作成（options.py）は使いません。

「ソルバーが成功と言ったから正しい」とせず、この結果と照らし合わせて確認します。
"""

from dataclasses import dataclass, field

from .timeutil import format_time, format_window, in_window

MODE_LABELS = {
    "normal": "通常利用",
    "shortcut_offer": "短縮利用（仮定枠・未取得）",
    "shortcut_acquired": "短縮利用（取得済み枠）",
    "show": "ショー鑑賞",
    "meal": "食事・休憩",
}

SEGMENT_LABELS = {
    "travel": "移動",
    "idle": "待機（意図的な待ち・空き時間）",
    "queue": "行列の待ち時間",
    "preshow": "開演前の待機",
    "ride": "体験",
    "show": "鑑賞",
    "meal": "食事・休憩",
}


@dataclass
class ValidationReport:
    ok: bool
    errors: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    rows: list = field(default_factory=list)
    segments: list = field(default_factory=list)
    metrics: dict = field(default_factory=dict)
    required_status: dict = field(default_factory=dict)
    must_use_status: dict = field(default_factory=dict)


def _get(step, name):
    """PlanStep でも辞書でも、同じ名前で値を取り出す。"""
    if isinstance(step, dict):
        return step.get(name)
    return getattr(step, name, None)


def validate_plan(problem, steps):
    """予定を計算し直し、制約を満たすかを調べた ValidationReport を返す。"""
    report = ValidationReport(ok=True)
    clock = problem.entry
    place = "entrance"
    visited = []
    used_slots = []
    totals = {"score": 0, "extra_cost": 0, "travel": 0, "queue_wait": 0, "preshow_wait": 0, "idle": 0}
    for order, step in enumerate(steps, start=1):
        activity_id = _get(step, "activity_id")
        if activity_id not in problem.activity_ids():
            report.errors.append(f"{order}番目: '{activity_id}' という活動はありません")
            continue
        queue_time = _get(step, "queue_time")
        if isinstance(queue_time, bool) or not isinstance(queue_time, int):
            report.errors.append(f"{order}番目: 並び始めの時刻（queue_time）が整数の分で書かれていません（{queue_time!r}）")
            continue
        if activity_id in visited:
            report.errors.append(f"{order}番目: 「{problem.name_of(activity_id)}」を2回以上予定に入れています")
        visited.append(activity_id)
        row = _check_step(problem, step, order, place, clock, report)
        if row["slot_id"] and row["mode_key"].startswith("shortcut"):
            used_slots.append(row["slot_id"])
        _add_segments(report, row)
        _add_totals(totals, row)
        report.rows.append(row)
        clock = row["end"]
        place = activity_id
    exit_arrival = _check_exit(problem, place, clock, report)
    totals["travel"] += problem.travel[place]["exit"]
    _check_requirements(problem, visited, used_slots, totals, report)
    report.metrics = _metrics(problem, totals, exit_arrival, len(visited))
    report.ok = not report.errors
    return report


def _check_step(problem, step, order, place, clock, report):
    activity_id = _get(step, "activity_id")
    name = problem.name_of(activity_id)
    queue_time = int(_get(step, "queue_time"))
    walk = problem.travel[place][activity_id]
    arrival = clock + walk
    if queue_time < arrival:
        report.errors.append(
            f"{order}番目「{name}」: 到着 {format_time(arrival)} より前の {format_time(queue_time)} に並び始めています"
        )
    detail = _check_mode(problem, step, order, name, queue_time, report)
    start = detail["start"]
    end = start + detail["duration"]
    _check_finish_by(problem, activity_id, end, order, name, report)
    return {
        "order": order,
        "activity_id": activity_id,
        "name": name,
        "kind": problem.kind_of(activity_id),
        "mode_key": detail["mode_key"],
        "mode_label": MODE_LABELS.get(detail["mode_key"], detail["mode_key"]),
        "slot_id": detail.get("slot_id"),
        "slot_window": detail.get("slot_window"),
        "performance_id": detail.get("performance_id"),
        "from_id": place,
        "depart": clock,
        "travel_min": walk,
        "arrival": arrival,
        "idle_min": queue_time - arrival,
        "queue_time": queue_time,
        "wait_min": detail["wait"],
        "wait_kind": detail["wait_kind"],
        "start": start,
        "end": end,
        "cost_yen": detail["cost"],
        "preference": problem.preferences[activity_id],
    }


def _check_mode(problem, step, order, name, queue_time, report):
    """利用方法ごとに、時間帯・枠・公演回を確かめ、待ち時間と費用を求める。"""
    kind = problem.kind_of(_get(step, "activity_id"))
    mode = _get(step, "mode")
    where = f"{order}番目「{name}」"
    expected = {"attraction": ("normal", "shortcut"), "show": ("show",), "meal": ("meal",)}[kind]
    if mode not in expected:
        report.errors.append(f"{where}: 利用方法 '{mode}' はこの種類の活動には使えません")
        mode = expected[0]
    if mode == "normal":
        return _check_normal(problem, step, where, queue_time, report)
    if mode == "shortcut":
        return _check_shortcut(problem, step, where, queue_time, report)
    if mode == "show":
        return _check_show(problem, step, where, queue_time, report)
    return _check_meal(problem, step, where, queue_time, report)


def normal_wait_at(wait_table, attraction_id, minute):
    """並び始める時刻 minute が入る時間帯の待ち時間。値がなければ None。"""
    values = wait_table.waits.get(attraction_id)
    if values is None:
        return None
    for band, wait in zip(wait_table.bands, values):
        if band[0] <= minute < band[1]:
            return wait
    return None


def _check_normal(problem, step, where, queue_time, report):
    attraction = problem.activity(_get(step, "activity_id"))
    if not attraction.queue_open <= queue_time < attraction.queue_close:
        report.errors.append(
            f"{where}: 並び始め {format_time(queue_time)} が案内時間 "
            f"{format_time(attraction.queue_open)}-{format_time(attraction.queue_close)} の外です"
        )
    wait = normal_wait_at(problem.wait_table, attraction.id, queue_time)
    if wait is None:
        report.errors.append(f"{where}: {format_time(queue_time)} の待ち時間が表にないため、通常利用できません")
        wait = 0
    return {"mode_key": "normal", "wait": wait, "wait_kind": "queue", "cost": 0,
            "start": queue_time + wait, "duration": attraction.duration}


def _check_shortcut(problem, step, where, queue_time, report):
    attraction = problem.activity(_get(step, "activity_id"))
    slot_id = _get(step, "slot_id")
    slot = problem.slots.get(slot_id)
    if slot is None:
        if slot_id in problem.scenario.offers:
            report.errors.append(f"{where}: 枠 {slot_id} は、この条件では使えません（短縮利用を検討しない設定、または候補外）")
        else:
            report.errors.append(f"{where}: 枠 {slot_id} がありません")
        return {"mode_key": "shortcut_offer", "wait": 0, "wait_kind": "queue", "cost": 0,
                "start": queue_time, "duration": attraction.duration, "slot_id": slot_id}
    if slot.attraction_id != attraction.id:
        report.errors.append(f"{where}: 枠 {slot_id} は別の施設（{slot.attraction_id}）の枠です")
    if not in_window(queue_time, slot.window):
        report.errors.append(
            f"{where}: 並び始め {format_time(queue_time)} が枠 {format_window(slot.window)} の外です（終了時刻ちょうどは含みません）"
        )
    mode_key = "shortcut_acquired" if slot.acquired else "shortcut_offer"
    cost = 0 if slot.acquired else slot.price
    return {"mode_key": mode_key, "wait": slot.residual_wait, "wait_kind": "queue", "cost": cost,
            "start": queue_time + slot.residual_wait, "duration": attraction.duration,
            "slot_id": slot.id, "slot_window": slot.window}


def _check_show(problem, step, where, queue_time, report):
    show = problem.activity(_get(step, "activity_id"))
    performance_id = _get(step, "performance_id")
    performance = next((p for p in show.performances if p.id == performance_id), None)
    if performance is None:
        report.errors.append(f"{where}: 公演回 {performance_id} がありません")
        return {"mode_key": "show", "wait": 0, "wait_kind": "preshow", "cost": 0,
                "start": queue_time, "duration": show.duration, "performance_id": performance_id}
    meeting = performance.start - show.arrive_before
    if queue_time != meeting:
        report.errors.append(
            f"{where}: 集合時刻は開演 {format_time(performance.start)} の {show.arrive_before} 分前の "
            f"{format_time(meeting)} ですが、予定では {format_time(queue_time)} になっています"
        )
    return {"mode_key": "show", "wait": performance.start - queue_time, "wait_kind": "preshow", "cost": 0,
            "start": performance.start, "duration": show.duration, "performance_id": performance.id}


def _check_meal(problem, step, where, queue_time, report):
    meal = problem.activity(_get(step, "activity_id"))
    if not in_window(queue_time, meal.window):
        report.errors.append(
            f"{where}: 開始 {format_time(queue_time)} が時間帯 {format_window(meal.window)} の外です"
        )
    return {"mode_key": "meal", "wait": 0, "wait_kind": "queue", "cost": 0,
            "start": queue_time, "duration": meal.duration}


def _check_finish_by(problem, activity_id, end, order, name, report):
    if problem.kind_of(activity_id) != "attraction":
        return
    finish_by = problem.activity(activity_id).finish_by
    if finish_by is not None and end > finish_by:
        report.errors.append(f"{order}番目「{name}」: 終了 {format_time(end)} が完了期限 {format_time(finish_by)} を過ぎています")


def _check_exit(problem, place, clock, report):
    exit_arrival = clock + problem.travel[place]["exit"]
    if exit_arrival > problem.exit:
        report.errors.append(
            f"出口への到着 {format_time(exit_arrival)} が退園時刻 {format_time(problem.exit)} を過ぎています"
        )
    report.segments.append(_segment("travel", clock, exit_arrival, "exit", f"{problem.name_of('exit')}へ移動"))
    return exit_arrival


def _check_requirements(problem, visited, used_slots, totals, report):
    for activity_id in sorted(problem.required):
        done = activity_id in visited
        report.required_status[activity_id] = done
        if not done:
            report.errors.append(f"必須の「{problem.name_of(activity_id)}」（{activity_id}）が予定に入っていません")
    for slot_id in sorted(problem.must_use_slots):
        used = slot_id in used_slots
        report.must_use_status[slot_id] = used
        if not used:
            report.errors.append(f"必ず使う取得済み枠 {slot_id} が使われていません")
    if totals["extra_cost"] > problem.budget:
        report.errors.append(f"追加費用 {totals['extra_cost']} 円が予算 {problem.budget} 円を超えています")


def _segment(kind, start, end, activity_id, label):
    return {"kind": kind, "kind_label": SEGMENT_LABELS[kind], "start": start, "end": end,
            "minutes": end - start, "activity_id": activity_id, "label": label}


def _add_segments(report, row):
    name = row["name"]
    pieces = [
        ("travel", row["depart"], row["arrival"], f"{name}へ移動"),
        ("idle", row["arrival"], row["queue_time"], f"{name}の前で待機"),
        (row["wait_kind"], row["queue_time"], row["start"], f"{name}の{SEGMENT_LABELS[row['wait_kind']]}"),
    ]
    main_kind = {"attraction": "ride", "show": "show", "meal": "meal"}[row["kind"]]
    pieces.append((main_kind, row["start"], row["end"], name))
    for kind, start, end, label in pieces:
        if end > start:
            report.segments.append(_segment(kind, start, end, row["activity_id"], label))


def _add_totals(totals, row):
    totals["score"] += row["preference"]
    totals["extra_cost"] += row["cost_yen"]
    totals["travel"] += row["travel_min"]
    totals["idle"] += max(0, row["idle_min"])
    if row["wait_kind"] == "preshow":
        totals["preshow_wait"] += row["wait_min"]
    else:
        totals["queue_wait"] += row["wait_min"]


def _metrics(problem, totals, exit_arrival, count):
    paid = problem.already_paid()
    return {
        "score": totals["score"],
        "extra_cost_yen": totals["extra_cost"],
        "already_paid_yen": paid,
        "total_cost_yen": paid + totals["extra_cost"],
        "budget_yen": problem.budget,
        "travel_min": totals["travel"],
        "queue_wait_min": totals["queue_wait"],
        "preshow_wait_min": totals["preshow_wait"],
        "idle_min": totals["idle"],
        "entry_time": problem.entry,
        "exit_arrival": exit_arrival,
        "exit_time": problem.exit,
        "n_activities": count,
    }


def compare_with_solver(result, report):
    """ソルバーの値と、検証関数で計算し直した値が一致するかを調べる。不一致の説明のリストを返す。"""
    mismatches = []
    if len(result.steps) != len(report.rows):
        mismatches.append("予定の項目数が一致しません")
    for step, row in zip(result.steps, report.rows):
        for key in ("start", "end"):
            if getattr(step, key) != row[key]:
                mismatches.append(f"{row['name']} の {key}: ソルバー {getattr(step, key)} / 検証 {row[key]}")
    pairs = (("score", "score"), ("extra_cost", "extra_cost_yen"), ("travel", "travel_min"))
    for solver_key, metric_key in pairs:
        if solver_key in result.objective_values and result.objective_values[solver_key] != report.metrics[metric_key]:
            mismatches.append(
                f"{solver_key}: ソルバー {result.objective_values[solver_key]} / 検証 {report.metrics[metric_key]}"
            )
    return mismatches
