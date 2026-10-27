"""最適化の前に、明らかに成立しない条件を見つける事前チェック。

ここでのチェックは「必要条件」だけを調べます。一部の活動だけを取り出し、
移動時間には最短の値を使うので、ここで「成立しない」と判定された条件は、
本当にどんな予定でも満たせません（実行不可能の証明になります）。
逆に、ここで問題が見つからなくても、成立するとは限りません。
"""

from dataclasses import dataclass
from itertools import permutations

from .data import shortest_paths
from .options import build_options, drop_reasons
from .timeutil import format_time


@dataclass(frozen=True)
class PrecheckIssue:
    code: str
    message: str
    activity_ids: tuple
    proves_infeasible: bool


def run_prechecks(problem, options=None, shortest=None):
    """事前チェックの結果を返す。proves_infeasible=True の項目があれば実行不可能。"""
    shortest = shortest or shortest_paths(problem.travel)
    options = options or build_options(problem, shortest)
    timely = build_options(problem, shortest, check_budget=False)  # 料金を考えない利用案（説明の区別に使う）
    issues = []
    issues += _check_gates(problem, shortest)
    issues += _check_each_required(problem, shortest, options)
    issues += _check_required_pairs(problem, shortest, options, timely)
    issues += _check_total_time(problem, options, timely)
    issues += [PrecheckIssue("W-data", message, (), False) for message in problem.warnings]
    return issues


def _check_gates(problem, shortest):
    walk = shortest["entrance"]["exit"]
    if problem.entry + walk <= problem.exit:
        return []
    message = (
        f"入口から出口まで最短でも {walk} 分かかるため、入園 {format_time(problem.entry)} から"
        f"退園 {format_time(problem.exit)} までの間に出口へ着けません。"
    )
    return [PrecheckIssue("P1-gates", message, (), True)]


def _check_each_required(problem, shortest, options):
    issues = []
    for activity_id in sorted(problem.required):
        if options[activity_id]:
            continue
        name = problem.name_of(activity_id)
        reason = _why_no_option(problem, shortest, activity_id)
        message = f"必須の「{name}」（{activity_id}）は、それだけを予定に入れても成立しません。{reason}"
        issues.append(PrecheckIssue("P2-single", message, (activity_id,), True))
    return issues


def _why_no_option(problem, shortest, activity_id):
    """必須の活動に使える利用案がない理由を、確かめられた範囲で説明する。"""
    counts = drop_reasons(problem, shortest, activity_id)
    kind = problem.kind_of(activity_id)
    must_use = [s for s in problem.must_use_slots if problem.slots[s].attraction_id == activity_id]
    if counts["raw"] == 0:
        if kind == "attraction":
            return "この季節・混雑の待ち時間表と案内時間、使える短縮利用の枠のどれにも、利用できる時間帯がありません。"
        return "利用できる時間帯がありません。"
    if counts["budget"] > 0:
        return "時間内に利用できる方法（短縮利用の枠）はありますが、その料金が追加費用の予算を超えます。"
    if counts["finish_by"] > 0 and counts["finish_by_affordable"] > 0:
        return "入退園時刻と移動の面では利用できる時間帯がありますが、施設の完了期限（finish_by）までに利用を終えられません。"
    if counts["finish_by"] > 0:
        return ("入退園時刻と移動の面では利用できる短縮利用の枠がありますが、施設の完了期限（finish_by）までに"
                "利用を終えられず、その料金も追加費用の予算を超えます。")
    if must_use:
        return f"必ず使う取得済み枠 {must_use[0]} の時間帯では、移動を含めて入退園時刻の間に利用を終えられません。"
    if kind == "show":
        return "どの公演回も、入園後の移動で開演前の集合時刻に間に合わないか、終演後に退園時刻までに出口へ着けません。"
    if kind == "meal":
        return "開始できる時間帯に、移動を含めて間に合わないか、終了後に退園時刻までに出口へ着けません。"
    return "どの時間帯・利用方法でも、移動を含めて入退園時刻の間に利用を終えられません。"


def _pair_time_fits(shortest, first, second, option_a, option_b):
    """2つの必須活動を first → second の順に、最も早い時刻で入れられるか（費用は見ない）。"""
    end_a = option_a.lo + option_a.wait + option_a.duration
    queue_b = max(option_b.lo, end_a + shortest[first][second])
    return queue_b <= option_b.hi


def _check_required_pairs(problem, shortest, options, timely):
    """必須の活動の2つ組を調べる。時間の面で入る組合せがあっても、費用の合計が予算を超えるなら、そう説明する。"""
    issues = []
    required = sorted(a for a in problem.required if options[a])
    for index, a in enumerate(required):
        for b in required[index + 1 :]:
            fits_in_time = False
            fits = False
            for first, second in permutations((a, b)):
                for option_a in timely[first]:
                    for option_b in timely[second]:
                        if _pair_time_fits(shortest, first, second, option_a, option_b):
                            fits_in_time = True
                            fits = fits or option_a.cost + option_b.cost <= problem.budget
            if fits:
                continue
            names = f"必須の「{problem.name_of(a)}」（{a}）と「{problem.name_of(b)}」（{b}）"
            if fits_in_time:
                message = f"{names}は、時間の面では両方を入れる順番・時間帯がありますが、その追加費用の合計が予算を超えます。"
            else:
                message = f"{names}は、どちらの順番・どの時間帯（公演回・枠）を選んでも、移動を含めると両方を予定に入れられません。"
            issues.append(PrecheckIssue("P3-pair", message, (a, b), True))
    return issues


def _check_total_time(problem, options, timely):
    """必須項目の「待ち時間＋所要時間」の最小値の合計が、滞在時間を超えないかを調べる。

    予算内の利用案（options）で判定します。料金を考えない利用案（timely）なら収まる場合は、
    予算内の方法だけでは足りないことを、説明に書き添えます。
    """
    required = [a for a in problem.required if options[a]]
    needed = sum(min(o.wait + o.duration for o in options[a]) for a in required)
    available = problem.exit - problem.entry
    if needed <= available:
        return []
    message = (
        f"必須項目の待ち時間と所要時間の合計が、予算内で使える方法では最小でも {needed} 分あり、"
        f"滞在時間 {available} 分を超えます。"
    )
    needed_any_price = sum(min(o.wait + o.duration for o in timely[a]) for a in required)
    if needed_any_price <= available:
        message += (f"料金を考えなければ合計は最小 {needed_any_price} 分で滞在時間に収まりますが、"
                    "そのための短縮利用の料金が予算を超えます。")
    return [PrecheckIssue("P4-total", message, tuple(sorted(required)), True)]
