"""極小問題（活動 2〜4 個・入園から退園まで 60〜90 分）を乱数の seed から作る、テスト用の生成器。

本体の CP-SAT モデルと、全時刻を調べる正解器（park_itinerary_lab.bruteforce）を照合する入力に
使います。make_tiny_instance(seed) は (シナリオの辞書, 条件の辞書) を返し、同じ seed からは
毎回同じ問題ができます。seed によって、次の特徴が混ざるようにしています。

- 三角不等式を満たさない徒歩時間の表（walk_minutes）、出口→入口の移動 > 0、入口と出口の位置の違い
- 後の時間帯まで待つと得になる待ち時間表、時間帯・短縮枠・食事の時間帯の終わりぎりぎりでの入列
- 完了期限（finish_by）、事前到着つきのショー（公演 1〜2 回）、食事の時間帯
- 予算より高い／安い新規の短縮枠、必ず使う／任意の取得済み枠、新規の短縮利用の不許可
- 混雑日（通常の待ち時間が長く、同じ料金の新規枠を予算の範囲で 1〜2 個買うかどうかが効く）
- shortcut_candidates が null・空のリスト・施設のリスト
- 所要時間 0 分の活動、希望度 0、希望順位（preference_rank）、必須の活動、実行不可能な条件

new_scenario などの小さな関数は、手計算のテスト（test_bruteforce.py）でも使います。
最後の instance_features は、seed の集まりが上の特徴を本当に含むかを数えるための関数です。
値はすべてテスト用の架空のものです。
"""

import bisect
import random

from park_itinerary_lab.bruteforce import (
    band_wait,
    direct_walk_minutes,
    find_option,
    parse_window,
    prepare_instance,
    solve_by_enumeration,
    to_minutes,
    travel_minutes,
)

SEASON = "test"


# ------------------------------------------------------------------ 辞書を作る小さな関数


def hhmm(minutes):
    """0:00 からの分を "HH:MM" に直す（例: 570 → "09:30"）。"""
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def span(start, end):
    """分の組 (開始, 終了) を "HH:MM-HH:MM" に直す。範囲は [開始, 終了)。"""
    return f"{hhmm(start)}-{hhmm(end)}"


def new_scenario(bands):
    """活動のない最小のシナリオを作る。bands は待ち時間表の時間帯 [(開始, 終了), ...]（分）。"""
    return {
        "format_version": 1,
        "meta": {"title": "極小テスト（架空）", "source_type": "fictional", "checked_on": None,
                 "assumptions": ["テスト用の架空の値です。"], "notes": ""},
        "cost_basis": "per_person",
        "gates": {"entrance": {"name": "入口", "x": 0, "y": 0},
                  "exit": {"name": "出口", "x": 0, "y": 0}},
        "walking": {"metres_per_minute": 60, "distance": "manhattan"},
        "walk_minutes": None,
        "attractions": [],
        "wait_tables": {SEASON: {"label": "テスト用", "bands": [span(s, e) for s, e in bands],
                                 "wait_min": {}}},
        "shortcut_offers": [],
        "shows": [],
        "meals": [],
    }


def add_attraction(scenario, attraction_id, waits, x=0, y=0, duration=5, preference=5,
                   queue=(8 * 60, 22 * 60), finish_by=None):
    """施設を追加する。waits は時間帯ごとの待ち時間（分）のリストで、null は None。"""
    scenario["attractions"].append({
        "id": attraction_id, "name": f"施設{attraction_id}", "x": x, "y": y,
        "duration_min": duration, "preference": preference,
        "queue_open": hhmm(queue[0]), "queue_close": hhmm(queue[1]),
        "finish_by": None if finish_by is None else hhmm(finish_by),
    })
    scenario["wait_tables"][SEASON]["wait_min"][attraction_id] = list(waits)


def add_show(scenario, show_id, starts, x=0, y=0, duration=20, arrive_before=0, preference=5):
    """ショーを追加する。starts は開演時刻（分）のリストで、公演 ID は "<ショー ID>-<番号>"。"""
    performances = [{"id": f"{show_id}-{number}", "start": hhmm(start)}
                    for number, start in enumerate(starts, start=1)]
    scenario["shows"].append({
        "id": show_id, "name": f"ショー{show_id}", "x": x, "y": y, "duration_min": duration,
        "arrive_before_min": arrive_before, "preference": preference, "performances": performances,
    })


def add_meal(scenario, meal_id, window, x=0, y=0, duration=30, preference=0):
    """食事を追加する。window は始めてよい時間帯 (開始, 終了)（分）。"""
    scenario["meals"].append({
        "id": meal_id, "name": f"食事{meal_id}", "x": x, "y": y, "duration_min": duration,
        "window": span(*window), "preference": preference,
    })


def add_offer(scenario, offer_id, attraction_id, window, price, residual=0):
    """新規に取得できると仮定する短縮枠（有料）を追加する。"""
    scenario["shortcut_offers"].append({
        "id": offer_id, "attraction": attraction_id, "window": span(*window),
        "price_yen": price, "residual_wait_min": residual,
    })


def acquired_slot(slot_id, attraction_id, window, residual=0, paid=0, must_use=False):
    """取得済みの短縮枠の辞書を作る（条件の acquired_shortcuts に入れる）。"""
    return {"id": slot_id, "attraction": attraction_id, "window": span(*window),
            "residual_wait_min": residual, "paid_yen": paid, "must_use": must_use}


def new_conditions(entry, exit_time, **changes):
    """条件の辞書を作る。entry・exit_time は分で与え、changes で既定値を上書きする。"""
    conditions = {
        "entry_time": hhmm(entry), "exit_time": hhmm(exit_time), "season": SEASON,
        "budget_yen": 0, "allow_new_shortcuts": False,
        "required_attractions": [], "required_shows": [], "required_meals": [],
        "preferences": {}, "preference_rank": None, "acquired_shortcuts": [],
        "shortcut_candidates": None, "purchase_rules": [], "cost_basis": "per_person",
        "party_size": 1,
    }
    conditions.update(changes)
    return conditions


# ------------------------------------------------------------------ 乱数で活動と移動を作る


def pick_kinds(rng):
    """活動の種類の並び（2〜4 個、先頭は必ず施設、ショーは 2 つ・食事は 1 つまで）を選ぶ。"""
    count = rng.choice([2, 3, 3, 4])
    kinds = ["attraction"]
    while len(kinds) < count:
        kind = rng.choice(["attraction", "attraction", "show", "meal"])
        if kind == "meal" and "meal" in kinds:
            continue
        if kind == "show" and kinds.count("show") == 2:
            continue
        kinds.append(kind)
    return kinds


def random_point(rng):
    """入口の近く（±120 m）の位置を選ぶ。"""
    return rng.randint(-120, 120), rng.randint(-120, 120)


def random_queue_hours(rng, entry):
    """入列可能時間。たいていは一日中で、ときどき予定の途中で開く・閉まる。"""
    if rng.random() < 0.75:
        return 8 * 60, 22 * 60
    opens = entry + rng.randint(0, 20)
    return opens, opens + rng.randint(5, 50)


def add_random_attraction(rng, scenario, attraction_id, entry, exit_time):
    """施設を 1 つ追加する。待ち時間は後で add_random_waits が決める。"""
    x, y = random_point(rng)
    finish_by = entry + rng.randint(15, exit_time - entry) if rng.random() < 0.25 else None
    add_attraction(scenario, attraction_id, [], x=x, y=y,
                   duration=rng.choice([0, 2, 5, 8, 12]), preference=rng.choice([0, 1, 3, 5, 8]),
                   queue=random_queue_hours(rng, entry), finish_by=finish_by)


def add_random_show(rng, scenario, show_id, entry, exit_time):
    """ショーを 1 つ追加する（公演 1〜2 回、事前到着 0〜10 分）。"""
    x, y = random_point(rng)
    count = rng.choice([1, 2])
    starts = sorted(rng.sample(range(entry + 5, exit_time - 5), count))
    add_show(scenario, show_id, starts, x=x, y=y, duration=rng.choice([0, 10, 20]),
             arrive_before=rng.choice([0, 5, 10]), preference=rng.choice([0, 2, 4, 6]))


def add_random_meal(rng, scenario, meal_id, entry):
    """食事を 1 つ追加する。始めてよい時間帯は 1 分だけのこともある。"""
    x, y = random_point(rng)
    start = entry + rng.randint(0, 45)
    window = (start, start + rng.choice([1, 2, 3, 15, 40]))
    add_meal(scenario, meal_id, window, x=x, y=y, duration=rng.choice([0, 10, 20, 30]),
             preference=rng.choice([0, 2, 4]))


def add_random_activities(rng, scenario, entry, exit_time):
    """種類を選んで、施設 A1…・ショー S1…・食事 M1 を追加する。"""
    counters = {"attraction": 0, "show": 0, "meal": 0}
    for kind in pick_kinds(rng):
        counters[kind] += 1
        if kind == "attraction":
            add_random_attraction(rng, scenario, f"A{counters[kind]}", entry, exit_time)
        elif kind == "show":
            add_random_show(rng, scenario, f"S{counters[kind]}", entry, exit_time)
        else:
            add_random_meal(rng, scenario, f"M{counters[kind]}", entry)


def all_activity_ids(scenario):
    """施設・ショー・食事の ID を、この順に並べたリスト。"""
    return [item["id"] for key in ("attractions", "shows", "meals") for item in scenario[key]]


def random_walk_table(rng, scenario):
    """徒歩時間の表を直接与える。ときどき遠回りの値を入れ、三角不等式を満たさない表にする。"""
    nodes = ["entrance", "exit"] + all_activity_ids(scenario)
    table = {}
    for from_id in nodes:
        table[from_id] = {}
        for to_id in nodes:
            if from_id != to_id:
                long_way = rng.random() < 0.25
                table[from_id][to_id] = rng.randint(10, 25) if long_way else rng.randint(0, 6)
    return table


def set_random_walking(rng, scenario):
    """入口・出口の位置と、徒歩時間の決め方（表・縦横の距離・直線距離）を選ぶ。"""
    if rng.random() < 0.5:
        x, y = random_point(rng)
        scenario["gates"]["exit"].update({"x": x, "y": y})
    scenario["walking"]["metres_per_minute"] = rng.choice([50, 60, 80])
    flavour = rng.choice(["table", "table", "manhattan", "manhattan", "euclidean"])
    if flavour == "table":
        scenario["walk_minutes"] = random_walk_table(rng, scenario)
    else:
        scenario["walking"]["distance"] = flavour


# ------------------------------------------------------------------ 待ち時間表


def random_cut_points(rng, entry, exit_time, travel, scenario):
    """時間帯の区切りの時刻。ときどき、入口から直行した到着時刻 t（または t + 1 分）で区切る。

    返り値は (区切りのリスト, tight)。tight は (施設 ID, 区切り) か None。
    半分ほどは早めの区切り（入園 5〜30 分後）も入れ、次の時間帯まで待つ価値が出るようにする。
    """
    cuts = set(rng.sample(range(entry + 5, exit_time - 5), rng.randint(1, 3)))
    if rng.random() < 0.5:
        cuts.add(entry + rng.randint(5, 30))
    tight = None
    if rng.random() < 0.3:
        attraction_id = rng.choice(scenario["attractions"])["id"]
        tight = (attraction_id, entry + travel["entrance"][attraction_id] + rng.choice([0, 1]))
        cuts.add(tight[1])
    return sorted(cuts), tight


def random_bands(rng, entry, exit_time, cuts):
    """区切りから時間帯を作る。ときどき開始を遅らせたり、途中の時間帯を抜いたりする。"""
    first = entry - 30 if rng.random() < 0.85 else entry + rng.randint(1, 4)
    points = [first] + [cut for cut in cuts if cut > first] + [exit_time + 30]
    bands = list(zip(points[:-1], points[1:]))
    if len(bands) >= 3 and rng.random() < 0.15:
        bands.pop(rng.randrange(1, len(bands) - 1))
    return bands


def random_wait(rng):
    """時間帯 1 つ分の待ち時間（分）。ときどき null（通常利用なし）にする。"""
    if rng.random() < 0.12:
        return None
    return rng.choice([0, 0, 5, 10, 15, 20, 30, 45, 60])


def add_random_waits(rng, scenario, bands, tight):
    """施設ごとの時間帯別の待ち時間を決める。

    ときどき「最初の時間帯は長く、次の時間帯は短い」施設を作り、待ってから並ぶと得になるようにする。
    tight があれば、その施設で到着の前後で終わる時間帯を 0 分にする（終わりぎりぎりの入列）。
    """
    table = scenario["wait_tables"][SEASON]
    table["bands"] = [span(s, e) for s, e in bands]
    for attraction in scenario["attractions"]:
        waits = [random_wait(rng) for _band in bands]
        if len(bands) >= 2 and rng.random() < 0.4:
            waits[0], waits[1] = rng.randint(30, 60), rng.randint(0, 5)
        table["wait_min"][attraction["id"]] = waits
    if tight is not None:
        make_band_end_tight(table, bands, tight)


def make_band_end_tight(table, bands, tight):
    """tight = (施設 ID, 区切り)。その区切りで終わる時間帯を 0 分、次の時間帯を 45 分にする。"""
    attraction_id, cut = tight
    for index, (_start, end) in enumerate(bands[:-1]):
        if end == cut:
            table["wait_min"][attraction_id][index] = 0
            table["wait_min"][attraction_id][index + 1] = 45


# ------------------------------------------------------------------ 短縮枠と条件


def random_slot_window(rng, entry, exit_time):
    """短縮枠の時間帯。1〜2 分だけの枠も作る。"""
    start = entry + rng.randint(0, exit_time - entry - 10)
    return start, start + rng.choice([1, 2, 5, 15, 30])


def add_random_offers(rng, scenario, entry, exit_time):
    """施設ごとに、新規の短縮枠を 0〜2 個追加する（料金 300〜1200 円）。"""
    for attraction in scenario["attractions"]:
        count = rng.choice([0, 1, 1, 2])
        for number in range(1, count + 1):
            add_offer(scenario, f"P-{attraction['id']}-{number}", attraction["id"],
                      random_slot_window(rng, entry, exit_time),
                      price=rng.choice([300, 500, 800, 1200]), residual=rng.choice([0, 2, 5]))


def random_budget(rng, scenario):
    """追加費用の予算。ときどき、ある短縮枠の料金とちょうど同じ額にする（「以下」の境界）。"""
    prices = [offer["price_yen"] for offer in scenario["shortcut_offers"]]
    if prices and rng.random() < 0.3:
        return rng.choice(prices)
    return rng.choice([0, 0, 500, 1000, 2000])


def random_candidates(rng, scenario):
    """shortcut_candidates: null（制限なし）・空のリスト・施設 ID のリストのどれか。"""
    draw = rng.random()
    if draw < 0.5:
        return None
    if draw < 0.7:
        return []
    ids = [attraction["id"] for attraction in scenario["attractions"]]
    return sorted(rng.sample(ids, rng.randint(1, len(ids))))


def random_acquired(rng, scenario, entry, exit_time):
    """取得済みの短縮枠（0 または 1 個）。必ず使うかどうかも乱数で決める。"""
    if rng.random() >= 0.3:
        return []
    attraction_id = rng.choice(scenario["attractions"])["id"]
    return [acquired_slot(f"G-{attraction_id}", attraction_id,
                          random_slot_window(rng, entry, exit_time),
                          residual=rng.choice([0, 3]), paid=rng.choice([0, 1000, 2000]),
                          must_use=rng.random() < 0.5)]


def random_required(rng, scenario):
    """必須の活動を種類ごとに選ぶ（各活動 25 %、ときどき全部。全部だと成立しないことが多い）。"""
    share = 1.0 if rng.random() < 0.1 else 0.25
    chosen = {}
    for key, name in (("attractions", "required_attractions"), ("shows", "required_shows"),
                      ("meals", "required_meals")):
        chosen[name] = [item["id"] for item in scenario[key] if rng.random() < share]
    return chosen


def random_preference_changes(rng, scenario):
    """希望度の上書き（preferences）か希望順位（preference_rank）を、ときどき入れる。

    本体の入力確認は両方の同時指定を入力エラーにするので、どちらか一方だけにする。
    """
    ids = all_activity_ids(scenario)
    draw = rng.random()
    if draw < 0.2:
        return {"preferences": {rng.choice(ids): rng.choice([0, 4, 9])}, "preference_rank": None}
    if draw < 0.4:
        return {"preferences": {}, "preference_rank": rng.sample(ids, rng.randint(1, len(ids)))}
    return {"preferences": {}, "preference_rank": None}


def random_conditions(rng, scenario, entry, exit_time):
    """予算・短縮利用・取得済み枠・必須・希望度の条件を乱数で決める。"""
    return new_conditions(
        entry, exit_time,
        budget_yen=random_budget(rng, scenario),
        allow_new_shortcuts=rng.random() < 0.65,
        shortcut_candidates=random_candidates(rng, scenario),
        acquired_shortcuts=random_acquired(rng, scenario, entry, exit_time),
        **random_required(rng, scenario),
        **random_preference_changes(rng, scenario),
    )


def make_busy(rng, scenario, conditions, entry):
    """ときどき「混雑日」にする: 通常の待ち時間を長くし、各施設に同じ料金の新規枠を 1 つずつ用意する。

    予算は「枠 1 つ分」「枠 2 つ分」「2 つ分に 1 円足りない」のどれかにして、
    追加費用の合計に対する予算の上限が効く問題を作る。ときどき新規の短縮利用そのものを許さない
    （枠が役に立つ日に、許可の設定が守られるかを確かめるため）。
    """
    if rng.random() >= 0.2:
        return
    table = scenario["wait_tables"][SEASON]
    scenario["shortcut_offers"] = []
    price = rng.choice([300, 500])
    for attraction in scenario["attractions"]:
        table["wait_min"][attraction["id"]] = [rng.choice([30, 45, 60]) for _band in table["bands"]]
        start = entry + rng.randint(0, 10)
        add_offer(scenario, f"P-{attraction['id']}-busy", attraction["id"],
                  (start, start + rng.choice([15, 30, 60])), price=price,
                  residual=rng.choice([0, 2, 5]))
    conditions.update(allow_new_shortcuts=rng.random() < 0.8, shortcut_candidates=None,
                      budget_yen=rng.choice([price, 2 * price, 2 * price, 2 * price - 1]))


# ------------------------------------------------------------------ 境界ぎりぎりの調整


def tighten_one_window(rng, scenario, conditions, entry, travel):
    """ときどき、入口から直行した到着時刻 t に合わせて、枠・列・公演の境界を置く。

    margin = 1 なら「ぎりぎり間に合う側」、margin = 0 なら「1 分遅れる側」になる。
    - 短縮枠と食事は [t − k, t + margin): margin = 1 なら到着した分（= 終了 − 1 分）にだけ入れる。
    - 施設の列の締め切り（queue_close）を t + margin にする。
    - 施設の完了期限（finish_by）を「t にすぐ並んだときの終了時刻 − 1 + margin」にする。
    - ショーは集合時刻（開演 − 事前到着分）を t − 1 + margin にする。
    """
    slots = scenario["shortcut_offers"] + conditions["acquired_shortcuts"]
    targets = [("slot", slot) for slot in slots] + [("meal", meal) for meal in scenario["meals"]]
    targets += [(kind, item) for kind in ("queue", "finish") for item in scenario["attractions"]]
    targets += [("show", show) for show in scenario["shows"]]
    if rng.random() >= 0.5:
        return
    kind, item = rng.choice(targets)
    arrival = entry + travel["entrance"][item["attraction"] if kind == "slot" else item["id"]]
    margin = rng.choice([0, 1])
    if kind in ("slot", "meal"):
        item["window"] = span(arrival - rng.randint(1, 5), arrival + margin)
    elif kind == "queue":
        item["queue_open"], item["queue_close"] = hhmm(8 * 60), hhmm(arrival + margin)
    elif kind == "finish":
        end = end_when_joining_at(scenario, item, arrival)
        item["finish_by"] = None if end is None else hhmm(end - 1 + margin)
    else:
        set_meeting_time(rng, item, arrival - 1 + margin)


def end_when_joining_at(scenario, attraction, minute):
    """施設に minute ちょうどに通常利用で並んだときの終了時刻。その時刻に並べなければ None。"""
    opens, closes = to_minutes(attraction["queue_open"]), to_minutes(attraction["queue_close"])
    wait = band_wait(scenario["wait_tables"][SEASON], attraction["id"], minute)
    if wait is None or not opens <= minute < closes:
        return None
    return minute + wait + attraction["duration_min"]


def set_meeting_time(rng, show, meeting):
    """ショーの公演を 1 つ選び、集合時刻（開演 − 事前到着分）が meeting になるように開演を動かす。"""
    start = hhmm(meeting + show["arrive_before_min"])
    if all(performance["start"] != start for performance in show["performances"]):
        show["performances"][rng.randrange(len(show["performances"]))]["start"] = start


# ------------------------------------------------------------------ 生成器の本体


def make_tiny_instance(seed):
    """seed から極小問題を 1 つ作り、(シナリオの辞書, 条件の辞書) を返す。"""
    rng = random.Random(seed)
    entry = 9 * 60 + rng.choice([0, 10, 30])
    exit_time = entry + rng.randint(60, 90)
    scenario = new_scenario([])
    add_random_activities(rng, scenario, entry, exit_time)
    set_random_walking(rng, scenario)
    travel = travel_minutes(scenario)
    cuts, tight = random_cut_points(rng, entry, exit_time, travel, scenario)
    bands = random_bands(rng, entry, exit_time, cuts)
    add_random_waits(rng, scenario, bands, tight)
    add_random_offers(rng, scenario, entry, exit_time)
    conditions = random_conditions(rng, scenario, entry, exit_time)
    make_busy(rng, scenario, conditions, entry)
    for _round in range(2):
        tighten_one_window(rng, scenario, conditions, entry, travel)
    return scenario, conditions


# ------------------------------------------------------------------ 素朴な探索（正解器の照合・網羅の確認用）


def search_without_memo(instance, earliest_only):
    """メモ化をせずに予定を 1 つずつたどり、最善値を返す（極小の問題の照合用の素朴な方法）。

    instance は bruteforce.prepare_instance の結果。値は (希望度, -追加費用, -移動時間) で、
    条件に合う予定がなければ None。
    earliest_only が True なら、各活動に「到着後、最初に並べて間に合う分」だけを試す
    （わざと待ってから並ぶ予定は調べない）。False なら、到着後のすべての分を試す。
    """
    best = None
    stack = [(0, "entrance", instance["entry"], 0, (0, 0, 0))]
    while stack:
        visited, node, time, spent, value = stack.pop()
        walk = instance["travel"][node]["exit"]
        all_required = visited & instance["required"] == instance["required"]
        if all_required and time + walk <= instance["exit"]:
            total = (value[0], value[1], value[2] - walk)
            best = total if best is None or total > best else best
        stack += next_states(instance, (visited, node, time, spent, value), earliest_only)
    return best


def next_states(instance, state, earliest_only):
    """search_without_memo 用: 次の活動に並んだ後の状態のリスト。"""
    visited, node, time, spent, value = state
    states = []
    for index, activity in enumerate(instance["activities"]):
        if visited & (1 << index):
            continue
        walk = instance["travel"][node][activity["id"]]
        for option in activity["options"]:
            if spent + option["cost"] > instance["budget"]:
                continue
            first = bisect.bisect_left(option["join_minutes"], time + walk)
            joins = option["joins"][first:first + 1] if earliest_only else option["joins"][first:]
            gained = (activity["preference"], -option["cost"], -walk)
            total = tuple(a + b for a, b in zip(value, gained))
            states += [(visited | (1 << index), activity["id"], end, spent + option["cost"], total)
                       for _q, end in joins]
    return states


def earliest_join_best(instance):
    """各活動に「到着後、最初に並べて間に合う分」にだけ並ぶ予定の中での最善値。

    これが正解器の最善値より悪ければ、その問題では「わざと待ってから並ぶ」ことが得になっている。
    """
    return search_without_memo(instance, earliest_only=True)


# ------------------------------------------------------------------ 生成した問題の特徴（網羅の確認用）


def plan_timeline(instance, plan):
    """予定の各項目について (項目, 到着時刻, 終了時刻) を並べ、出口への到着時刻も返す。"""
    rows = []
    node, time = "entrance", instance["entry"]
    by_id = {activity["id"]: activity for activity in instance["activities"]}
    for step in plan:
        activity = by_id[step["activity_id"]]
        end = dict(find_option(activity, step)["joins"])[step["queue_time"]]
        rows.append((step, time + instance["travel"][node][activity["id"]], end))
        node, time = activity["id"], end
    return rows, time + instance["travel"][node]["exit"]


def join_window_end(scenario, conditions, step):
    """項目が並び始めた短縮枠・食事の時間帯・待ち時間の時間帯の終了時刻（ショーは None）。"""
    if step["mode"] == "shortcut":
        slots = scenario["shortcut_offers"] + conditions["acquired_shortcuts"]
        return parse_window(next(s["window"] for s in slots if s["id"] == step["slot_id"]))[1]
    if step["mode"] == "meal":
        meal = next(item for item in scenario["meals"] if item["id"] == step["activity_id"])
        return parse_window(meal["window"])[1]
    if step["mode"] == "normal":
        for band in scenario["wait_tables"][conditions["season"]]["bands"]:
            start, end = parse_window(band)
            if start <= step["queue_time"] < end:
                return end
    return None


def outside_queue_hours(scenario, step):
    """短縮枠の入場時刻が、その施設の通常の入列可能時間の外なら True。"""
    attraction = next(a for a in scenario["attractions"] if a["id"] == step["activity_id"])
    opens, closes = to_minutes(attraction["queue_open"]), to_minutes(attraction["queue_close"])
    return not opens <= step["queue_time"] < closes


def walking_features(scenario):
    """移動時間に関する特徴の名前の集合。"""
    features = set()
    travel = travel_minutes(scenario)
    if scenario["walk_minutes"] is not None:
        features.add("walk_table")
        if direct_walk_minutes(scenario) != travel:
            features.add("walk_table_non_metric")
    else:
        features.add(scenario["walking"]["distance"])
    if travel["exit"]["entrance"] > 0:
        features.add("exit_to_entrance_walk")
    gates = scenario["gates"]
    if (gates["entrance"]["x"], gates["entrance"]["y"]) != (gates["exit"]["x"], gates["exit"]["y"]):
        features.add("gates_apart")
    return features


def activity_features(scenario, conditions):
    """施設・ショー・食事と希望度に関する特徴の名前の集合。"""
    features = set()
    items = scenario["attractions"] + scenario["shows"] + scenario["meals"]
    if any(item["duration_min"] == 0 for item in items):
        features.add("zero_duration")
    if any(item["finish_by"] is not None for item in scenario["attractions"]):
        features.add("finish_by")
    for show in scenario["shows"]:
        features.add("show_two_performances" if len(show["performances"]) == 2
                     else "show_one_performance")
        if show["arrive_before_min"] > 0:
            features.add("show_arrive_before")
    if scenario["meals"]:
        features.add("meal_window")
    activities = prepare_instance(scenario, conditions)["activities"]
    if any(activity["preference"] == 0 for activity in activities):
        features.add("zero_preference")
    if conditions["preference_rank"]:
        features.add("preference_rank")
    if conditions["preferences"]:
        features.add("preference_override")
    required_keys = ("required_attractions", "required_shows", "required_meals")
    if any(conditions[key] for key in required_keys):
        features.add("required")
    return features


def shortcut_features(scenario, conditions):
    """短縮枠に関する特徴の名前の集合。"""
    features = set()
    candidates = conditions["shortcut_candidates"]
    if candidates is None:
        features.add("candidates_null")
    elif candidates == []:
        features.add("candidates_empty")
    else:
        features.add("candidates_list")
    if scenario["shortcut_offers"] and not conditions["allow_new_shortcuts"]:
        features.add("new_shortcuts_not_allowed")
    if conditions["allow_new_shortcuts"]:
        prices = [offer["price_yen"] for offer in scenario["shortcut_offers"]
                  if candidates is None or offer["attraction"] in candidates]
        if any(price > conditions["budget_yen"] for price in prices):
            features.add("offer_above_budget")
        if any(price <= conditions["budget_yen"] for price in prices):
            features.add("offer_within_budget")
    for slot in conditions["acquired_shortcuts"]:
        features.add("must_use_true" if slot["must_use"] else "must_use_false")
    return features


def boundary_features(scenario, conditions):
    """入口から直行した到着時刻 t が、境界の「1 分遅れる側」などにある特徴の名前の集合。

    枠・食事の時間帯・列の締め切りが t ちょうどに終わる、集合時刻が t − 1 分、
    完了期限が「t にすぐ並んだときの終了時刻」かその 1 分前、の場合。
    """
    features = set()
    entry = to_minutes(conditions["entry_time"])
    travel = travel_minutes(scenario)
    arrival = {place: entry + minutes for place, minutes in travel["entrance"].items()}
    for slot in scenario["shortcut_offers"] + conditions["acquired_shortcuts"]:
        if parse_window(slot["window"])[1] == arrival[slot["attraction"]]:
            features.add("slot_ends_on_arrival")
    for meal in scenario["meals"]:
        if parse_window(meal["window"])[1] == arrival[meal["id"]]:
            features.add("meal_window_ends_on_arrival")
    for attraction in scenario["attractions"]:
        if to_minutes(attraction["queue_close"]) == arrival[attraction["id"]]:
            features.add("queue_closes_on_arrival")
        end = end_when_joining_at(scenario, attraction, arrival[attraction["id"]])
        if end is not None and attraction["finish_by"] is not None:
            if to_minutes(attraction["finish_by"]) - end in (-1, 0):
                features.add("finish_by_at_direct_join_end")
    for show in scenario["shows"]:
        starts = [to_minutes(performance["start"]) for performance in show["performances"]]
        if arrival[show["id"]] - 1 in [start - show["arrive_before_min"] for start in starts]:
            features.add("meeting_one_minute_before_arrival")
    return features


def step_features(scenario, conditions, step, arrival):
    """最適な予定の項目 1 つ（到着時刻つき）から分かる特徴の名前の集合。"""
    features = {"uses_" + step["mode"]}
    q = step["queue_time"]
    if q > arrival:
        features.add("idle_before_join")
    if step["mode"] == "show" and q == arrival:
        features.add("arrives_exactly_at_meeting_time")
    if step["mode"] == "shortcut" and outside_queue_hours(scenario, step):
        features.add("shortcut_outside_queue_hours")
    end = join_window_end(scenario, conditions, step)
    if end is not None and q == end - 1 == arrival:
        features.add(f"forced_join_at_{step['mode']}_end")
    return features


def solution_features(scenario, conditions, oracle):
    """正解器の結果（最適値と予定の例）から分かる特徴の名前の集合。"""
    if not oracle["feasible"]:
        return {"infeasible"}
    features = {"feasible"}
    instance = prepare_instance(scenario, conditions)
    greedy = earliest_join_best(instance)
    if greedy is None or greedy < (oracle["score"], -oracle["extra_cost"], -oracle["travel"]):
        features.add("waiting_pays_off")
    if 0 < oracle["extra_cost"] == conditions["budget_yen"]:
        features.add("budget_exactly_used")
    rows, exit_arrival = plan_timeline(instance, oracle["plan"])
    if exit_arrival == instance["exit"]:
        features.add("exit_exactly_on_time")
    for step, arrival, _end in rows:
        features |= step_features(scenario, conditions, step, arrival)
    return features | budget_features(scenario, conditions, oracle)


def budget_features(scenario, conditions, oracle):
    """予算の特徴: 有料の新規枠を 2 つ使う・予算がもっとあれば希望度合計が上がる（予算が効いている）。"""
    features = set()
    offer_ids = {offer["id"] for offer in scenario["shortcut_offers"]}
    if sum(step["slot_id"] in offer_ids for step in oracle["plan"]) >= 2:
        features.add("two_paid_slots_used")
    if conditions["allow_new_shortcuts"] and conditions["budget_yen"] > 0:
        richer = solve_by_enumeration(scenario, dict(conditions, budget_yen=10 ** 6))
        if richer["score"] > oracle["score"]:
            features.add("budget_limits_purchases")
    return features


def instance_features(scenario, conditions, oracle):
    """生成した問題と正解器の結果から、含まれる特徴の名前の集合を作る（網羅の確認用）。"""
    return (walking_features(scenario) | activity_features(scenario, conditions)
            | shortcut_features(scenario, conditions) | boundary_features(scenario, conditions)
            | solution_features(scenario, conditions, oracle))
