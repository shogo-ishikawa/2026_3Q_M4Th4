"""極小問題（活動 2〜4 個・入園から退園まで 60〜90 分）を乱数の seed から作る、テスト用の生成器。

本体の CP-SAT モデルと、全時刻を調べる正解器（park_itinerary_lab.bruteforce）を照合する入力に
使います。make_tiny_instance(seed) は (シナリオの辞書, 条件の辞書) を返し、同じ seed からは
毎回同じ問題ができます。seed によって、次の特徴が混ざるようにしています。

- 三角不等式を満たさない徒歩時間の表（walk_minutes）、出口→入口の移動 > 0、入口と出口の位置の違い
- 後の時間帯まで待つと得になる待ち時間表、時間帯・短縮枠・食事の時間帯の終わりぎりぎりでの入列
- 完了期限（finish_by）、事前到着つきのショー（公演 1〜2 回）、食事の時間帯
- 予算より高い／安い新規の短縮枠、必ず使う／任意の取得済み枠、新規の短縮利用の不許可
- shortcut_candidates が null・空のリスト・施設のリスト
- 所要時間 0 分の活動、希望度 0、希望順位（preference_rank）、必須の活動、実行不可能な条件

後半の new_scenario などの小さな関数は、手計算のテスト（test_bruteforce.py）でも使います。
値はすべてテスト用の架空のものです。
"""

import random

from park_itinerary_lab.bruteforce import travel_minutes

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
    """時間帯の区切りの時刻。ときどき、入口から直行した到着時刻の 1 分後で区切る。

    返り値は (区切りのリスト, tight)。tight は (施設 ID, 到着 + 1 分) か None。
    """
    cuts = set(rng.sample(range(entry + 5, exit_time - 5), rng.randint(1, 3)))
    tight = None
    if rng.random() < 0.3:
        attraction_id = rng.choice(scenario["attractions"])["id"]
        tight = (attraction_id, entry + travel["entrance"][attraction_id] + 1)
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
    tight があれば、その施設で到着直後に終わる時間帯を 0 分にする（終わりぎりぎりの入列）。
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
        count = rng.choice([0, 0, 1, 1, 2])
        for number in range(1, count + 1):
            add_offer(scenario, f"P-{attraction['id']}-{number}", attraction["id"],
                      random_slot_window(rng, entry, exit_time),
                      price=rng.choice([300, 500, 800, 1200]), residual=rng.choice([0, 2, 5]))


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
    """必須の活動を種類ごとに選ぶ（各活動 25 %）。"""
    chosen = {}
    for key, name in (("attractions", "required_attractions"), ("shows", "required_shows"),
                      ("meals", "required_meals")):
        chosen[name] = [item["id"] for item in scenario[key] if rng.random() < 0.25]
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
        budget_yen=rng.choice([0, 0, 500, 1000, 2000]),
        allow_new_shortcuts=rng.random() < 0.65,
        shortcut_candidates=random_candidates(rng, scenario),
        acquired_shortcuts=random_acquired(rng, scenario, entry, exit_time),
        **random_required(rng, scenario),
        **random_preference_changes(rng, scenario),
    )


# ------------------------------------------------------------------ 境界ぎりぎりの調整


def tighten_one_window(rng, scenario, conditions, entry, travel):
    """ときどき、入口から直行した到着時刻 t に合わせて、枠・時間帯・公演の境界を置く。

    短縮枠と食事は [t − k, t + 1) にして、到着した分（= 終了 − 1 分）にしか入れないようにする。
    ショーは集合時刻（開演 − 事前到着分）を t ちょうどにする。
    """
    targets = scenario["shortcut_offers"] + conditions["acquired_shortcuts"]
    targets = [("slot", slot) for slot in targets] + [("meal", meal) for meal in scenario["meals"]]
    targets += [("show", show) for show in scenario["shows"]]
    if not targets or rng.random() >= 0.45:
        return
    kind, item = rng.choice(targets)
    place = item["attraction"] if kind == "slot" else item["id"]
    arrival = entry + travel["entrance"][place]
    if kind != "show":
        item["window"] = span(arrival - rng.randint(0, 5), arrival + 1)
        return
    start = hhmm(arrival + item["arrive_before_min"])
    if all(performance["start"] != start for performance in item["performances"]):
        item["performances"][rng.randrange(len(item["performances"]))]["start"] = start


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
    tighten_one_window(rng, scenario, conditions, entry, travel)
    return scenario, conditions
