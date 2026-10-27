"""計算結果を、表・文章・図・ファイルにする。

時刻は表示のときだけ "HH:MM" に直します。費用の基準（1人分かグループ総額か）は表に明記します。
スコアは入力した希望度の合計であり、実際の来園者の満足度を測った値ではありません。
"""

import json
import platform
import sys
from datetime import datetime
from importlib import metadata
from pathlib import Path

import pandas as pd

from .timeutil import format_time, format_window
from .validate import SEGMENT_LABELS

COST_BASIS_LABELS = {"per_person": "1人分", "group_total": "グループ総額"}

SEGMENT_COLOURS = {
    "travel": "#9e9e9e",
    "idle": "#d7ccc8",
    "queue": "#ffb74d",
    "preshow": "#ffe082",
    "ride": "#1e88e5",
    "show": "#8e24aa",
    "meal": "#43a047",
}


# ---------------------------------------------------------------------------
# 入力データの表
# ---------------------------------------------------------------------------


def attraction_table(problem):
    rows = []
    for attraction in problem.scenario.attractions.values():
        rows.append({
            "ID": attraction.id,
            "名前": attraction.name,
            "体験時間(分)": attraction.duration,
            "希望度": problem.preferences[attraction.id],
            "通常の案内時間": f"{format_time(attraction.queue_open)}-{format_time(attraction.queue_close)}",
            "必須": "必須" if attraction.id in problem.required else "",
        })
    return pd.DataFrame(rows)


def wait_table(problem):
    """選んだ季節・混雑の待ち時間表（行: 施設、列: 並び始める時間帯）。空欄は通常利用できない時間帯。"""
    table = problem.wait_table
    columns = [format_window(band) for band in table.bands]
    rows = {}
    for attraction_id in problem.scenario.attractions:
        values = table.waits.get(attraction_id, (None,) * len(columns))
        rows[attraction_id] = list(values)
    return pd.DataFrame.from_dict(rows, orient="index", columns=columns).astype("Int64")


def shortcut_table(problem):
    rows = []
    for slot in problem.scenario.offers.values():
        rows.append(_slot_row(problem, slot, allowed=slot.id in problem.slots))
    for slot in problem.slots.values():
        if slot.acquired:
            rows.append(_slot_row(problem, slot, allowed=True))
    return pd.DataFrame(rows)


def _slot_row(problem, slot, allowed):
    return {
        "枠ID": slot.id,
        "施設": slot.attraction_id,
        "入場できる時間帯": format_window(slot.window),
        "区分": "取得済み枠" if slot.acquired else "仮定枠（未取得）",
        "今回の追加費用(円)": slot.price,
        "既払い額(円)": slot.paid,
        "残る待ち時間(分)": slot.residual_wait,
        "必ず使う": "はい" if slot.must_use else "",
        "この条件で使える": "はい" if allowed else "いいえ",
    }


def show_table(problem):
    rows = []
    for show in problem.scenario.shows.values():
        for performance in show.performances:
            rows.append({
                "ショーID": show.id,
                "名前": show.name,
                "公演回": performance.id,
                "開演": format_time(performance.start),
                "集合（何分前）": show.arrive_before,
                "公演時間(分)": show.duration,
                "希望度": problem.preferences[show.id],
                "必須": "必須" if show.id in problem.required else "",
            })
    return pd.DataFrame(rows)


def meal_table(problem):
    rows = []
    for meal in problem.scenario.meals.values():
        rows.append({
            "ID": meal.id,
            "名前": meal.name,
            "開始できる時間帯": format_window(meal.window),
            "所要時間(分)": meal.duration,
            "希望度": problem.preferences[meal.id],
            "必須": "必須" if meal.id in problem.required else "",
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# 計算結果の表と文章
# ---------------------------------------------------------------------------


def status_text(result):
    """計算結果の状態を、日本語の文章にまとめる。"""
    lines = [f"計算結果: {result.status_label}"]
    if result.status in ("optimal", "feasible"):
        lines.append(f"最適性の確認範囲: {result.scope_label}")
    lines += result.messages
    if result.stages:
        total = sum(stage.wall_time_s for stage in result.stages)
        lines.append(f"計算時間の合計: {total:.2f} 秒（各段階の制限時間 {result.stages[0].time_limit_s:g} 秒）")
    return "\n".join(lines)


def stage_table(result):
    """優先順位つき最適化の各段階の結果。"""
    rows = []
    for stage in result.stages:
        shown = format_time if stage.name == "exit_arrival" else (lambda value: value)
        rows.append({
            "段階": stage.label,
            "向き": "最大化" if stage.sense == "max" else "最小化",
            "ソルバーの終了状態": stage.cp_status,
            "目的値": shown(stage.objective) if stage.objective is not None else None,
            "限界値": shown(stage.bound) if stage.bound is not None else None,
            "最適性": "確認済み" if stage.proven else "未確認",
            "計算時間(秒)": stage.wall_time_s,
            "制限時間(秒)": stage.time_limit_s,
        })
    return pd.DataFrame(rows)


def plan_table(report):
    """一日の予定表（1行が1つの活動）。"""
    rows = []
    for row in report.rows:
        rows.append({
            "順番": row["order"],
            "ID": row["activity_id"],
            "名前": row["name"],
            "利用方法": row["mode_label"],
            "枠・公演回": row["slot_id"] or row["performance_id"] or "",
            "入場枠": format_window(row["slot_window"]) if row["slot_window"] else "",
            "出発": format_time(row["depart"]),
            "移動(分)": row["travel_min"],
            "到着": format_time(row["arrival"]),
            "待機(分)": row["idle_min"],
            "並び始め・集合": format_time(row["queue_time"]),
            "待ち(分)": row["wait_min"],
            "開始": format_time(row["start"]),
            "終了": format_time(row["end"]),
            "追加費用(円)": row["cost_yen"],
            "希望度": row["preference"],
        })
    return pd.DataFrame(rows)


def segment_table(report):
    """時間の流れ（移動・待機・待ち時間・体験・鑑賞・食事）を1行ずつ並べた表。"""
    rows = []
    for segment in report.segments:
        rows.append({
            "開始": format_time(segment["start"]),
            "終了": format_time(segment["end"]),
            "分": segment["minutes"],
            "区分": segment["kind_label"],
            "内容": segment["label"],
        })
    return pd.DataFrame(rows)


def summary_table(result, report):
    """合計スコア・費用・時間・必須条件の充足状況。"""
    problem = result.problem
    metrics = report.metrics
    basis = COST_BASIS_LABELS[problem.cost_basis]
    items = [
        ("計算結果", result.status_label),
        ("最適性の確認範囲", result.scope_label),
        ("検証関数による確認", "問題なし" if report.ok else "問題あり: " + " / ".join(report.errors)),
        ("希望度の合計（スコア）", metrics["score"]),
        (f"今回の追加費用（{basis}, 円）", metrics["extra_cost_yen"]),
        (f"取得済み枠の既払い額（{basis}, 円）", metrics["already_paid_yen"]),
        (f"費用の総額（{basis}, 円）", metrics["total_cost_yen"]),
        (f"追加費用の予算（{basis}, 円）", metrics["budget_yen"]),
        ("移動時間の合計(分)", metrics["travel_min"]),
        ("行列の待ち時間の合計(分)", metrics["queue_wait_min"]),
        ("開演前の待機の合計(分)", metrics["preshow_wait_min"]),
        ("待機（意図的な待ち・空き時間）の合計(分)", metrics["idle_min"]),
        ("入園時刻", format_time(metrics["entry_time"])),
        ("出口への到着", format_time(metrics["exit_arrival"])),
        ("退園時刻（期限）", format_time(metrics["exit_time"])),
    ]
    if problem.cost_basis == "per_person" and problem.party_size > 1:
        items.append((f"参考: {problem.party_size}人分の総額（円）", metrics["total_cost_yen"] * problem.party_size))
    for activity_id, done in report.required_status.items():
        items.append((f"必須: {problem.name_of(activity_id)}", "満たす" if done else "満たさない"))
    for slot_id, used in report.must_use_status.items():
        items.append((f"必ず使う枠: {slot_id}", "使用" if used else "未使用"))
    return pd.DataFrame(items, columns=["項目", "値"])


def precheck_table(result):
    rows = []
    for issue in result.precheck_issues:
        rows.append({
            "コード": issue.code,
            "実行不可能の証明": "はい" if issue.proves_infeasible else "いいえ（注意）",
            "内容": issue.message,
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# タイムライン図
# ---------------------------------------------------------------------------


def _japanese_font_available():
    try:
        import matplotlib_fontja  # noqa: F401  （読み込むと日本語のフォントが設定される）
    except ImportError:
        return False
    return True


def plot_timeline(report, title=None):
    """予定のタイムライン図（matplotlib の Figure）を返す。"""
    import matplotlib.pyplot as plt

    japanese = _japanese_font_available()
    lanes = [row["activity_id"] for row in report.rows] + ["exit"]
    names = {row["activity_id"]: row["name"] for row in report.rows}
    names["exit"] = "出口へ" if japanese else "to exit"
    figure, axis = plt.subplots(figsize=(11, 0.45 * len(lanes) + 1.6))
    for segment in report.segments:
        lane = lanes.index(segment["activity_id"])
        axis.barh(lane, segment["minutes"], left=segment["start"], height=0.6,
                  color=SEGMENT_COLOURS[segment["kind"]], edgecolor="white", linewidth=0.5)
    axis.set_yticks(range(len(lanes)))
    if japanese:
        axis.set_yticklabels([f"{index + 1}. {names[lane]}" if lane != "exit" else names[lane]
                              for index, lane in enumerate(lanes)])
    else:
        axis.set_yticklabels([lane for lane in lanes])
    axis.invert_yaxis()
    start = (report.metrics["entry_time"] // 60) * 60
    end = -(-max(report.metrics["exit_time"], report.metrics["exit_arrival"]) // 60) * 60
    axis.set_xlim(start, end + 15)
    axis.set_xticks(range(start, end + 1, 60))
    axis.set_xticklabels([format_time(t) for t in range(start, end + 1, 60)])
    axis.axvline(report.metrics["exit_time"], color="red", linestyle="--", linewidth=1)
    axis.grid(axis="x", alpha=0.3)
    handles = [plt.Rectangle((0, 0), 1, 1, color=SEGMENT_COLOURS[k]) for k in SEGMENT_COLOURS]
    labels = [SEGMENT_LABELS[k] if japanese else k for k in SEGMENT_COLOURS]
    axis.legend(handles, labels, loc="upper center", bbox_to_anchor=(0.5, -0.12), ncol=7, fontsize=8, frameon=False)
    axis.set_title(title or ("一日の予定（赤い破線は退園時刻）" if japanese else "Day plan (red dashed line: exit time)"))
    figure.tight_layout()
    return figure


# ---------------------------------------------------------------------------
# 保存と環境の記録
# ---------------------------------------------------------------------------


def environment_info(packages=("park-itinerary-lab", "pandas", "matplotlib", "ortools", "pulp", "cbcbox")):
    """Python と主要ライブラリの版。入っていないものは「未導入」と表示する。"""
    info = {"python": sys.version.split()[0], "platform": platform.platform()}
    for name in packages:
        try:
            info[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            info[name] = "未導入"
    return info


def new_run_folder(output_root, label):
    """outputs/ の中に、実行ごとの新しいフォルダ（日時_ラベル）を作る。既存のフォルダは上書きしない。"""
    output_root = Path(output_root)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    folder = output_root / f"{stamp}_{label}"
    number = 2
    while folder.exists():
        folder = output_root / f"{stamp}_{label}-{number}"
        number += 1
    folder.mkdir(parents=True)
    return folder


def save_run(output_root, label, result, report=None, figure=None, extra=None):
    """予定表・時間の流れ・計算結果をフォルダに保存し、そのフォルダを返す。"""
    folder = new_run_folder(output_root, label)
    if report is not None:
        plan_table(report).to_csv(folder / "plan.csv", index=False, encoding="utf-8-sig")
        segment_table(report).to_csv(folder / "segments.csv", index=False, encoding="utf-8-sig")
    if figure is not None:
        figure.savefig(folder / "timeline.png", dpi=150, bbox_inches="tight")
    summary = result_summary(result, report)
    if extra:
        summary["extra"] = extra
    with (folder / "summary.json").open("w", encoding="utf-8") as file:
        json.dump(summary, file, ensure_ascii=False, indent=2, default=str)
    return folder


def result_summary(result, report=None):
    """JSON に保存できる形の、計算結果のまとめ。"""
    problem = result.problem
    summary = {
        "saved_at": datetime.now().isoformat(timespec="seconds"),
        "status": result.status,
        "status_label": result.status_label,
        "optimality_scope": result.optimality_scope,
        "proof": result.proof,
        "messages": result.messages,
        "objective_values": result.objective_values,
        "stages": [stage.__dict__ for stage in result.stages],
        "precheck_issues": [issue.__dict__ for issue in result.precheck_issues],
        "solver_info": result.solver_info,
        "environment": environment_info(),
        "steps": [step.__dict__ for step in result.steps],
    }
    if problem is not None:
        summary["conditions"] = problem.conditions
        summary["scenario_meta"] = problem.scenario.meta
        summary["cost_basis"] = problem.cost_basis
    if report is not None:
        summary["validation"] = {"ok": report.ok, "errors": report.errors, "metrics": report.metrics,
                                 "required_status": report.required_status,
                                 "must_use_status": report.must_use_status}
    return summary


def metrics_row(label, result):
    """条件を変えた計算結果を1行にまとめる（比較の表に使う）。予定がない場合は状態だけを入れる。"""
    report = result.validation
    metrics = report.metrics if report is not None else {}
    return {
        "条件": label,
        "計算結果": result.status_label,
        "最適性の確認範囲": result.scope_label if result.has_plan else "",
        "希望度の合計": metrics.get("score"),
        "追加費用(円)": metrics.get("extra_cost_yen"),
        "移動(分)": metrics.get("travel_min"),
        "行列の待ち(分)": metrics.get("queue_wait_min"),
        "意図的な待機(分)": metrics.get("idle_min"),
        "出口への到着": format_time(metrics["exit_arrival"]) if metrics else "",
        "訪問数": metrics.get("n_activities"),
    }
