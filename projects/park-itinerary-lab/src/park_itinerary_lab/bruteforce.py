"""極小問題の独立な正解器（全時刻の全列挙）。

本体の CP-SAT モデル（model.py）とは別に、問題の決まりを普通の Python で書き下した
「答え合わせ用」の解き方です。どの活動をどの順に回るか、どの利用方法（通常・短縮枠・
公演回・食事）を使うかに加えて、並び始める時刻（入列時刻）q も 1 分ごとにすべて試します。
そのため「待ち時間が下がるまで、わざと待ってから並ぶ」予定も見落としません。

調べ方は「メモ化つきの深さ優先探索（動的計画法）」です。状態は
(訪問済みの活動の集合, 今いる地点, 今の時刻, ここまでの追加費用) の組で、
同じ状態から先の最善は一度だけ計算して memo に記録します。

計算量は活動数と時間の長さに対して急に増えるので、数個の活動・数時間までの
極小問題専用です。標準ライブラリだけを使い、park_itinerary_lab の他のモジュール
（データ読込・本体モデル・検証関数）には依存しません。入力はシナリオと条件の
「JSON と同じ形の辞書」をそのまま受け取ります。

主な決まり（時刻はすべて 0:00 からの整数の分）:
- 時間帯や枠 "A-B" は [A, B) で、A ちょうどは入り、B ちょうどは入らない。
- 移動時間は、他の地点を通り抜ける近道も含めた最短の徒歩時間（Floyd–Warshall 法）。
- 通常利用: 入列可能時間 [queue_open, queue_close) と、待ち時間が null でない時間帯の中で
  並び始める。体験開始 = q + その時間帯の待ち時間、終了 = 開始 + 所要時間。
- 短縮枠: 枠 [開始, 終了) の中で入る。開始 = q + 残余待ち時間。新規の枠だけ料金が
  追加費用になる（取得済みの枠の既払い額は追加費用に数えない）。
- ショー: 公演回を1つ選び、開演 − 事前到着分 までに到着する。
- 食事: 時間帯 [開始, 終了) の中で始める。
- 目的は (1) 希望度の合計を最大、(2) 追加費用を最小、(3) 移動時間の合計を最小 の順。
"""

import bisect
import math

ENTRANCE = "entrance"
EXIT = "exit"


# ------------------------------------------------------------------ 時刻


def to_minutes(text):
    """"HH:MM" を 0:00 からの分に直す（例: "09:30" → 570）。整数はそのまま返す。"""
    if isinstance(text, int):
        return text
    hours, minutes = text.split(":")
    return int(hours) * 60 + int(minutes)


def parse_window(text):
    """"HH:MM-HH:MM" を (開始, 終了) の分に直す。範囲は [開始, 終了) で、終了の分は含まない。"""
    first, last = text.split("-")
    return to_minutes(first), to_minutes(last)


# ------------------------------------------------------------------ 移動時間


def list_activities(scenario):
    """施設・ショー・食事を (種類, 元の辞書) のリストにする。この並び順が活動の番号になる。"""
    items = [("attraction", item) for item in scenario.get("attractions", [])]
    items += [("show", item) for item in scenario.get("shows", [])]
    items += [("meal", item) for item in scenario.get("meals", [])]
    return items


def node_positions(scenario):
    """地点 ID → (x, y) の辞書。入口は "entrance"、出口は "exit" という ID にする。"""
    gates = scenario["gates"]
    positions = {
        ENTRANCE: (gates["entrance"]["x"], gates["entrance"]["y"]),
        EXIT: (gates["exit"]["x"], gates["exit"]["y"]),
    }
    for _kind, item in list_activities(scenario):
        positions[item["id"]] = (item["x"], item["y"])
    return positions


def metres_between(point_a, point_b, distance):
    """2 地点間の距離（m）。manhattan は縦横の道に沿った距離、euclidean は直線距離。"""
    dx = abs(point_a[0] - point_b[0])
    dy = abs(point_a[1] - point_b[1])
    if distance == "manhattan":
        return dx + dy
    if distance == "euclidean":
        return math.sqrt(dx * dx + dy * dy)
    raise ValueError(f"unknown distance type: {distance!r}")


def walk_minutes_from_metres(metres, metres_per_minute):
    """距離を徒歩の分に直す。1 分未満は切り上げ（小さな誤差 1e-9 は切り上げない）。"""
    return max(0, math.ceil(metres / metres_per_minute - 1e-9))


def direct_walk_minutes(scenario):
    """寄り道をしない直接の徒歩時間の表 table[出発 ID][到着 ID]（分）を作る。

    walk_minutes が与えられていればその値を、なければ位置と歩く速さから計算する。
    同じ地点どうしは 0 分。
    """
    positions = node_positions(scenario)
    given = scenario.get("walk_minutes")
    walking = scenario.get("walking") or {}
    table = {}
    for from_id in positions:
        table[from_id] = {}
        for to_id in positions:
            if from_id == to_id:
                table[from_id][to_id] = 0
            elif given is not None:
                table[from_id][to_id] = int(given[from_id][to_id])
            else:
                metres = metres_between(positions[from_id], positions[to_id], walking["distance"])
                table[from_id][to_id] = walk_minutes_from_metres(metres, walking["metres_per_minute"])
    return table


def shortest_walk_minutes(direct):
    """Floyd–Warshall 法で、他の地点を通り抜ける近道も含めた最短の徒歩時間の表にする。"""
    nodes = list(direct)
    best = {from_id: dict(direct[from_id]) for from_id in nodes}
    for via in nodes:
        for from_id in nodes:
            for to_id in nodes:
                through = best[from_id][via] + best[via][to_id]
                if through < best[from_id][to_id]:
                    best[from_id][to_id] = through
    return best


def travel_minutes(scenario):
    """予定の項目の間で使う移動時間（分）の表。直接の徒歩時間を最短経路の値に置き換えたもの。"""
    return shortest_walk_minutes(direct_walk_minutes(scenario))


# ------------------------------------------------------------------ 希望度・短縮枠・必須


def preference_values(scenario, conditions):
    """活動 ID → 希望度の辞書。

    preference_rank が空でないリストなら、n 個中 k 番目に n − k + 1 点、載っていない活動は 0 点。
    そうでなければ、データの preference を conditions の preferences で上書きする。
    """
    activity_ids = [item["id"] for _kind, item in list_activities(scenario)]
    rank = conditions.get("preference_rank")
    if rank:
        values = {activity_id: 0 for activity_id in activity_ids}
        for position, activity_id in enumerate(rank, start=1):
            values[activity_id] = len(rank) - position + 1
        return values
    values = {item["id"]: item["preference"] for _kind, item in list_activities(scenario)}
    values.update(conditions.get("preferences") or {})
    return values


def allowed_slots(scenario, conditions):
    """使ってよい短縮枠のリスト。

    新規の枠（shortcut_offers）は allow_new_shortcuts が true のときだけで、
    shortcut_candidates がリストなら、その施設の枠だけに限る（空のリストなら新規の枠はなし）。
    取得済みの枠（acquired_shortcuts）は常にすべて使ってよく、追加費用は 0 円とする。
    """
    slots = []
    candidates = conditions.get("shortcut_candidates")
    if conditions.get("allow_new_shortcuts", False):
        for offer in scenario.get("shortcut_offers", []):
            if candidates is None or offer["attraction"] in candidates:
                slots.append(make_slot(offer, cost=offer["price_yen"], must_use=False))
    for acquired in conditions.get("acquired_shortcuts") or []:
        slots.append(make_slot(acquired, cost=0, must_use=bool(acquired.get("must_use", False))))
    return slots


def make_slot(raw, cost, must_use):
    """短縮枠の辞書を、計算に使う形（枠は分の組）にそろえる。"""
    return {
        "id": raw["id"],
        "attraction": raw["attraction"],
        "window": parse_window(raw["window"]),
        "residual_wait": raw["residual_wait_min"],
        "cost": cost,
        "must_use": must_use,
    }


def required_ids(conditions, slots):
    """必ず訪れる活動 ID の集合。必ず使う取得済み枠（must_use）の施設も含める。"""
    required = set(conditions.get("required_attractions") or [])
    required |= set(conditions.get("required_shows") or [])
    required |= set(conditions.get("required_meals") or [])
    required |= {slot["attraction"] for slot in slots if slot["must_use"]}
    return required


# ------------------------------------------------------------------ 利用方法と並び始める時刻


def band_wait(wait_table, attraction_id, minute):
    """待ち時間表で minute を含む時間帯 [s, e) の待ち時間を返す。該当なし・null なら None。

    時間帯どうしは重ならないものとし、最初に見つかった時間帯の値を使う。
    """
    waits = wait_table["wait_min"].get(attraction_id)
    if waits is None:
        return None
    for band, wait in zip(wait_table["bands"], waits):
        start, end = parse_window(band)
        if start <= minute < end:
            return wait
    return None


def make_option(mode, joins, cost=0, slot_id=None, performance_id=None):
    """利用方法 1 つ分の辞書。joins は (並び始める時刻 q, 体験の終了時刻) の組のリスト。"""
    return {"mode": mode, "slot_id": slot_id, "performance_id": performance_id,
            "cost": cost, "joins": joins}


def normal_joins(attraction, wait_table, first, last):
    """通常利用: first〜last 分の毎分について、並び始められるなら (q, 終了時刻) を作る。"""
    open_at = to_minutes(attraction["queue_open"])
    close_at = to_minutes(attraction["queue_close"])
    joins = []
    for q in range(first, last + 1):
        if not open_at <= q < close_at:
            continue
        wait = band_wait(wait_table, attraction["id"], q)
        if wait is not None:
            joins.append((q, q + wait + attraction["duration_min"]))
    return joins


def window_joins(window, extra_wait, duration, first, last):
    """枠 [開始, 終了) の中の毎分 q について (q, 終了時刻) を作る。短縮枠と食事で使う。"""
    start, end = window
    return [(q, q + extra_wait + duration) for q in range(max(start, first), min(end, last + 1))]


def slot_option(slot, attraction, first, last):
    """短縮枠 1 つを使う利用方法。枠は入列可能時間とは重ねず、そのまま使う。"""
    joins = window_joins(slot["window"], slot["residual_wait"], attraction["duration_min"],
                         first, last)
    return make_option("shortcut", joins, cost=slot["cost"], slot_id=slot["id"])


def attraction_options(attraction, slots, wait_table, first, last):
    """施設の利用方法の候補。必ず使う取得済み枠があれば、その枠だけにする。"""
    own_slots = [slot for slot in slots if slot["attraction"] == attraction["id"]]
    must_use = [slot for slot in own_slots if slot["must_use"]]
    if must_use:
        # 1 回の利用で 2 つの枠は使えないので、必ず使う枠が 2 つ以上なら候補なし（実行不可能）。
        if len(must_use) > 1:
            return []
        return [slot_option(must_use[0], attraction, first, last)]
    options = [make_option("normal", normal_joins(attraction, wait_table, first, last))]
    options += [slot_option(slot, attraction, first, last) for slot in own_slots]
    return options


def show_options(show):
    """ショーの公演回ごとの利用方法。集合時刻 m = 開演 − 事前到着分 を q とする。"""
    options = []
    for performance in show["performances"]:
        start = to_minutes(performance["start"])
        meeting = start - show["arrive_before_min"]
        joins = [(meeting, start + show["duration_min"])]
        options.append(make_option("show", joins, performance_id=performance["id"]))
    return options


def meal_options(meal, first, last):
    """食事の利用方法（1 つだけ）。時間帯 [開始, 終了) の中の毎分に始められる。"""
    joins = window_joins(parse_window(meal["window"]), 0, meal["duration_min"], first, last)
    return [make_option("meal", joins)]


def keep_useful_joins(option, deadline):
    """終了時刻が deadline を過ぎる入列時刻を除き、二分探索用の q のリストも作る。

    deadline は「終了後に出口へ直行しても退園時刻に間に合う」最も遅い終了時刻
    （施設に完了期限 finish_by があれば、それとの小さい方）。
    最短の移動時間は三角不等式を満たすので、これを過ぎると後で何をしても間に合わない。
    """
    option["joins"] = [(q, end) for q, end in option["joins"] if end <= deadline]
    option["join_minutes"] = [q for q, _end in option["joins"]]
    return option


# ------------------------------------------------------------------ 問題の準備


def check_size(scenario, entry, exit_time, max_activities, max_horizon_min):
    """全列挙で扱える大きさかを確かめる。大きすぎれば ValueError。"""
    count = len(list_activities(scenario))
    if count > max_activities:
        raise ValueError(f"too many activities for enumeration: {count} > {max_activities}")
    if exit_time - entry > max_horizon_min:
        raise ValueError(
            f"horizon too long for enumeration: {exit_time - entry} > {max_horizon_min} minutes")


def activity_record(kind, item, context):
    """活動 1 つを、全列挙で使う形（希望度と利用方法の候補）にまとめる。"""
    first, last = context["entry"], context["exit"]
    if kind == "attraction":
        options = attraction_options(item, context["slots"], context["wait_table"], first, last)
    elif kind == "show":
        options = show_options(item)
    else:
        options = meal_options(item, first, last)
    deadline = last - context["travel"][item["id"]][EXIT]
    if kind == "attraction" and item.get("finish_by") is not None:
        deadline = min(deadline, to_minutes(item["finish_by"]))
    options = [keep_useful_joins(option, deadline) for option in options]
    return {"id": item["id"], "kind": kind,
            "preference": context["preferences"][item["id"]], "options": options}


def required_mask(activities, required):
    """必須の活動 ID の集合を、活動の番号のビットの集合（整数）に直す。"""
    index_of = {activity["id"]: index for index, activity in enumerate(activities)}
    unknown = sorted(required - set(index_of))
    if unknown:
        raise ValueError(f"required activity ids not in the scenario: {unknown}")
    mask = 0
    for activity_id in required:
        mask |= 1 << index_of[activity_id]
    return mask


def prepare_instance(scenario, conditions, max_activities=6, max_horizon_min=240):
    """全列挙に必要な値（活動・利用方法・移動時間・予算・必須）を 1 つの辞書にまとめる。"""
    entry = to_minutes(conditions["entry_time"])
    exit_time = to_minutes(conditions["exit_time"])
    check_size(scenario, entry, exit_time, max_activities, max_horizon_min)
    slots = allowed_slots(scenario, conditions)
    context = {
        "entry": entry,
        "exit": exit_time,
        "travel": travel_minutes(scenario),
        "slots": slots,
        "wait_table": scenario["wait_tables"][conditions["season"]],
        "preferences": preference_values(scenario, conditions),
    }
    activities = [activity_record(kind, item, context) for kind, item in list_activities(scenario)]
    return {
        "entry": entry,
        "exit": exit_time,
        "budget": conditions.get("budget_yen", 0),
        "travel": context["travel"],
        "activities": activities,
        "required": required_mask(activities, required_ids(conditions, slots)),
    }


# ------------------------------------------------------------------ 全列挙（メモ化つき探索）


def finish_here(instance, state):
    """ここで予定を終えて出口へ向かう場合の値。必須が残る・退園に遅れるなら None。"""
    visited, node, time, _spent = state
    walk = instance["travel"][node][EXIT]
    if visited & instance["required"] != instance["required"]:
        return None
    if time + walk > instance["exit"]:
        return None
    return (0, 0, -walk)


def try_activity(instance, memo, state, index, best):
    """活動 index を次に訪れる全通り（利用方法 × 並び始める毎分 q）を試し、最善を更新して返す。

    best は (値, 最初の選択)。値は (希望度, -追加費用, -移動時間) で、大きいほど良い。
    """
    visited, node, time, spent = state
    activity = instance["activities"][index]
    walk = instance["travel"][node][activity["id"]]
    arrival = time + walk
    for option in activity["options"]:
        cost = spent + option["cost"]
        if cost > instance["budget"]:
            continue
        # 到着より前には並べないので、q >= 到着時刻 の入列時刻だけを（毎分すべて）試す。
        first = bisect.bisect_left(option["join_minutes"], arrival)
        for q, end in option["joins"][first:]:
            next_state = (visited | (1 << index), activity["id"], end, cost)
            rest = best_rest(instance, memo, next_state)
            if rest is None:
                continue
            value = (activity["preference"] + rest[0], rest[1] - option["cost"], rest[2] - walk)
            if best[0] is None or value > best[0]:
                best = (value, (activity["id"], option, q, next_state))
    return best


def best_rest(instance, memo, state):
    """状態 state から出口までの最善値 (希望度, -追加費用, -移動時間) を返す。無理なら None。

    state = (訪問済みの活動のビットの集合, 今いる地点 ID, 今の時刻, ここまでの追加費用)。
    同じ状態は一度だけ計算し、memo[state] = (最善値, 最初の選択) として記録する。
    """
    if state in memo:
        return memo[state][0]
    best = (finish_here(instance, state), None)
    for index in range(len(instance["activities"])):
        if not state[0] & (1 << index):
            best = try_activity(instance, memo, state, index, best)
    memo[state] = best
    return best[0]


def witness_plan(memo, state):
    """memo に記録した「最初の選択」をたどり、最善値を実現する予定（訪問順）を作る。"""
    plan = []
    choice = memo[state][1]
    while choice is not None:
        activity_id, option, q, state = choice
        plan.append({
            "activity_id": activity_id,
            "mode": option["mode"],
            "slot_id": option["slot_id"],
            "performance_id": option["performance_id"],
            "queue_time": q,
        })
        choice = memo[state][1]
    return plan


def solve_by_enumeration(scenario, conditions, max_activities=6, max_horizon_min=240):
    """極小問題を全時刻の全列挙で解き、最適な (希望度, 追加費用, 移動時間) と予定の例を返す。

    Returns {"feasible": bool, "score": int|None, "extra_cost": int|None, "travel": int|None,
             "plan": [{"activity_id", "mode", "slot_id", "performance_id", "queue_time"}, ...],
             "states_explored": int}
    mode は "normal"（通常）・"shortcut"（短縮枠）・"show"・"meal" のいずれか。
    plan は訪問順で、queue_time は並び始める（入る・集合する）時刻（0:00 からの分）。
    活動数が max_activities より多い、または入園から退園までが max_horizon_min 分より
    長い場合は ValueError を出す。
    """
    instance = prepare_instance(scenario, conditions, max_activities, max_horizon_min)
    memo = {}
    start = (0, ENTRANCE, instance["entry"], 0)
    best = best_rest(instance, memo, start)
    if best is None:
        return {"feasible": False, "score": None, "extra_cost": None, "travel": None,
                "plan": [], "states_explored": len(memo)}
    return {"feasible": True, "score": best[0], "extra_cost": -best[1], "travel": -best[2],
            "plan": witness_plan(memo, start), "states_explored": len(memo)}


# ------------------------------------------------------------------ 予定の計算し直し（照合用）


def find_option(activity, step):
    """予定の項目の mode・slot_id・performance_id に合う利用方法を探す。なければ None。"""
    wanted = (step["mode"], step.get("slot_id"), step.get("performance_id"))
    for option in activity["options"]:
        if (option["mode"], option["slot_id"], option["performance_id"]) == wanted:
            return option
    return None


def apply_step(instance, state, step):
    """予定の項目 1 つを state（今いる地点・時刻・合計など）に反映する。

    決まりに合えば None、合わなければ理由の文字列（英語）を返す。
    """
    index_of = {activity["id"]: index for index, activity in enumerate(instance["activities"])}
    activity_id = step["activity_id"]
    if activity_id not in index_of:
        return f"unknown activity {activity_id}"
    if state["visited"] & (1 << index_of[activity_id]):
        return f"{activity_id} is visited twice"
    activity = instance["activities"][index_of[activity_id]]
    option = find_option(activity, step)
    if option is None:
        return f"{activity_id}: this mode, slot or performance is not allowed"
    walk = instance["travel"][state["node"]][activity_id]
    q = step["queue_time"]
    if q < state["time"] + walk:
        return f"{activity_id}: joins at {q} before arriving at {state['time'] + walk}"
    ends = dict(option["joins"])
    if q not in ends:
        return f"{activity_id}: cannot join at {q} (window, wait band, finish_by or exit time)"
    state.update(visited=state["visited"] | (1 << index_of[activity_id]), node=activity_id,
                 time=ends[q], score=state["score"] + activity["preference"],
                 cost=state["cost"] + option["cost"], travel=state["travel"] + walk)
    return None


def rejected(reason):
    """evaluate_plan の「実行不可能」の結果。"""
    return {"feasible": False, "score": None, "extra_cost": None, "travel": None,
            "reason": reason}


def finish_plan(instance, state):
    """最後の項目から出口へ歩き、必須・予算・退園時刻を確かめて結果を作る。"""
    walk = instance["travel"][state["node"]][EXIT]
    if state["visited"] & instance["required"] != instance["required"]:
        return rejected("a required activity is missing")
    if state["cost"] > instance["budget"]:
        return rejected(f"extra cost {state['cost']} is over the budget {instance['budget']}")
    if state["time"] + walk > instance["exit"]:
        return rejected(f"arrives at the exit at {state['time'] + walk}, after {instance['exit']}")
    return {"feasible": True, "score": state["score"], "extra_cost": state["cost"],
            "travel": state["travel"] + walk, "reason": None}


def evaluate_plan(scenario, conditions, plan, max_activities=6, max_horizon_min=240):
    """与えられた予定を、この正解器と同じ決まりで計算し直す（本体の予定の照合用）。

    plan は solve_by_enumeration の plan と同じ形の辞書のリスト（訪問順）。
    Returns {"feasible": bool, "score", "extra_cost", "travel", "reason": str|None}
    reason は決まりに合わなかった理由（英語）。
    """
    instance = prepare_instance(scenario, conditions, max_activities, max_horizon_min)
    state = {"visited": 0, "node": ENTRANCE, "time": instance["entry"],
             "score": 0, "cost": 0, "travel": 0}
    for step in plan:
        reason = apply_step(instance, state, step)
        if reason is not None:
            return rejected(reason)
    return finish_plan(instance, state)
