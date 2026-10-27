"""各活動の「利用案（option）」を作る。最適化モデルと事前チェックが共通に使う。

利用案は「どのモードで、いつ並び始められ、待ち時間と費用がいくらか」の組です。

- normal   : 通常利用。待ち時間表の時間帯ごとに1つ。並び始める時刻の時間帯の待ち時間を使う。
- shortcut : 有料の時間短縮利用。枠ごとに1つ。枠は並び始める（入場する）時刻に適用する。
- show     : ショーの公演回ごとに1つ。開演の arrive_before 分前までに到着する。
- meal     : 食事・休憩。開始時刻が指定の時間帯に入るようにする。

基準時刻 q（並び始め・集合・開始の時刻）は、利用案ごとに lo 以上 hi 以下（両端を含む）です。
入力の時間帯 [開始, 終了) は、ここで「終了 − 1 分」までの整数範囲に直します。
"""

from dataclasses import dataclass, replace

from .data import shortest_paths
from .timeutil import format_time


@dataclass(frozen=True)
class Option:
    activity_id: str
    key: str
    mode: str
    lo: int
    hi: int
    wait: int
    duration: int
    cost: int
    slot_id: str | None = None
    performance_id: str | None = None


def raw_options(problem, activity_id):
    """時間の制約で絞り込む前の利用案。"""
    kind = problem.kind_of(activity_id)
    activity = problem.activity(activity_id)
    if kind == "attraction":
        return _attraction_options(problem, activity)
    if kind == "show":
        return [
            Option(
                activity_id=activity.id,
                key=f"show:{performance.id}",
                mode="show",
                lo=performance.start - activity.arrive_before,
                hi=performance.start - activity.arrive_before,
                wait=activity.arrive_before,
                duration=activity.duration,
                cost=0,
                performance_id=performance.id,
            )
            for performance in activity.performances
        ]
    return [
        Option(
            activity_id=activity.id,
            key="meal",
            mode="meal",
            lo=activity.window[0],
            hi=activity.window[1] - 1,
            wait=0,
            duration=activity.duration,
            cost=0,
        )
    ]


def _attraction_options(problem, attraction):
    must_use = [problem.slots[s] for s in problem.must_use_slots if problem.slots[s].attraction_id == attraction.id]
    options = []
    if not must_use:
        table = problem.wait_table
        for band, wait in zip(table.bands, table.waits.get(attraction.id, ())):
            start = max(band[0], attraction.queue_open)
            end = min(band[1], attraction.queue_close)
            if wait is None or start >= end:
                continue
            options.append(
                Option(
                    activity_id=attraction.id,
                    key=f"normal@{format_time(band[0])}",
                    mode="normal",
                    lo=start,
                    hi=end - 1,
                    wait=wait,
                    duration=attraction.duration,
                    cost=0,
                )
            )
    slots = must_use if must_use else problem.slots_for(attraction.id)
    for slot in slots:
        options.append(
            Option(
                activity_id=attraction.id,
                key=f"shortcut:{slot.id}",
                mode="shortcut",
                lo=slot.window[0],
                hi=slot.window[1] - 1,
                wait=slot.residual_wait,
                duration=attraction.duration,
                cost=slot.price,
                slot_id=slot.id,
            )
        )
    return options


def tighten_option(problem, shortest, option):
    """入退園時刻・最短の移動時間・予算から、利用案の範囲を狭める。

    戻り値は (狭めた利用案または None, 除外した理由)。理由は "time" か "budget"。
    どの順路でも、入口からは最短でも shortest[入口][活動] 分、活動から出口へも
    最短でも shortest[活動][出口] 分かかるので、この絞り込みで実行可能な予定は失われません。
    """
    if option.cost > problem.budget:
        return None, "budget"
    activity_id = option.activity_id
    lo = max(option.lo, problem.entry + shortest["entrance"][activity_id])
    hi = min(option.hi, problem.exit - shortest[activity_id]["exit"] - option.wait - option.duration)
    if problem.kind_of(activity_id) == "attraction":
        finish_by = problem.activity(activity_id).finish_by
        if finish_by is not None:
            hi = min(hi, finish_by - option.wait - option.duration)
    if lo > hi:
        return None, "time"
    return replace(option, lo=lo, hi=hi), None


def build_options(problem, shortest=None):
    """全活動の利用案。戻り値は {活動ID: [Option, ...]}（使えない活動は空リスト）。"""
    shortest = shortest or shortest_paths(problem.travel)
    options = {}
    for activity_id in problem.activity_ids():
        kept = []
        for option in raw_options(problem, activity_id):
            tightened, _reason = tighten_option(problem, shortest, option)
            if tightened is not None:
                kept.append(tightened)
        options[activity_id] = kept
    return options


def drop_reasons(problem, shortest, activity_id):
    """利用案が残らなかった理由を数える（事前チェックの説明用）。"""
    counts = {"raw": 0, "time": 0, "budget": 0}
    for option in raw_options(problem, activity_id):
        counts["raw"] += 1
        _tightened, reason = tighten_option(problem, shortest, option)
        if reason is not None:
            counts[reason] += 1
    return counts
