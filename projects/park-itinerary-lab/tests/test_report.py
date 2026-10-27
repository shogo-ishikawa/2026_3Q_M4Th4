"""表示・図・保存（report.py）のテスト。

デモの計算結果から、入力の表・結果の表・タイムライン図を作れることと、
保存のたびに新しいフォルダを作り、前の結果を上書きしないことを確かめます。
図は画面のない環境でも描けるように、matplotlib の Agg（画像に描く方式）を使います。
出力は pytest の tmp_path の中だけに書きます。
"""

import json
from datetime import datetime

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402  （Agg を選んだ後に読み込む）
import pandas as pd  # noqa: E402
import pytest  # noqa: E402
from matplotlib.figure import Figure  # noqa: E402

from park_itinerary_lab import report  # noqa: E402
from park_itinerary_lab.data import load_scenario  # noqa: E402

# デモの標準条件に、任意の取得済み枠（既払い 1000 円）を1つ加えた条件
CONDITIONS = {
    "entry_time": "09:00",
    "exit_time": "18:00",
    "season": "normal",
    "budget_yen": 2000,
    "allow_new_shortcuts": True,
    "required_shows": ["S1"],
    "required_meals": ["M1"],
    "acquired_shortcuts": [
        {"id": "OWN1", "attraction": "A2", "window": "13:00-14:00", "residual_wait_min": 5, "paid_yen": 1000,
         "must_use": False}
    ],
}


@pytest.fixture(scope="module")
def demo_result(demo_scenario_path, solve):
    """デモを解いた結果（最適性確認済み）。モジュールの中で共有するので書き換えない。"""
    result = solve(load_scenario(demo_scenario_path), CONDITIONS)
    assert result.status == "optimal"
    return result


@pytest.fixture(scope="module")
def infeasible_result(demo_scenario_path, solve):
    """退園 18:00 なのに夜のショー S2（19:30 開演）を必須にした、成立しない条件の結果。"""
    return solve(load_scenario(demo_scenario_path), dict(CONDITIONS, required_shows=["S2"]))


def test_input_tables_build_for_the_demo(demo_result):
    """入力データの表（施設・待ち時間・短縮利用の枠・ショー・食事）を作れる。"""
    problem = demo_result.problem
    attractions = report.attraction_table(problem)
    assert len(attractions) == 8
    assert {"ID", "名前", "希望度", "必須"} <= set(attractions.columns)
    waits = report.wait_table(problem)
    assert waits.shape == (8, 12)
    assert waits.columns[0] == "09:00-10:00"
    assert waits.loc["A1", "09:00-10:00"] == 30
    assert pd.isna(waits.loc["A8", "18:00-19:00"])  # 値がない時間帯は空欄
    slots = report.shortcut_table(problem)
    assert len(slots) == 9  # 仮定枠 8 + 取得済み枠 1
    assert set(slots["区分"]) == {"仮定枠（未取得）", "取得済み枠"}
    own = slots[slots["枠ID"] == "OWN1"].iloc[0]
    assert (own["今回の追加費用(円)"], own["既払い額(円)"]) == (0, 1000)
    assert len(report.show_table(problem)) == 3  # S1 の2回 + S2 の1回
    assert len(report.meal_table(problem)) == 1


def test_result_tables_build_for_the_demo(demo_result):
    """結果の表（状態の文章・段階・予定表・時間の流れ・まとめ・事前チェック）を作れる。"""
    validation = demo_result.validation
    text = report.status_text(demo_result)
    assert "最適性確認済み" in text and "最適性の確認範囲" in text
    stages = report.stage_table(demo_result)
    assert len(stages) == len(demo_result.stages)
    assert list(stages["最適性"][:3]) == ["確認済み"] * 3
    plan = report.plan_table(validation)
    assert len(plan) == len(validation.rows)
    assert plan["開始"].str.fullmatch(r"\d{2}:\d{2}").all()
    assert len(report.segment_table(validation)) == len(validation.segments)
    summary = report.summary_table(demo_result, validation)
    values = dict(zip(summary["項目"], summary["値"]))

    def value_of(words):
        """項目名に words を含む行の値（表示の言い回しが少し変わってもよいように、部分一致で探す）。"""
        return next(value for item, value in values.items() if words in item)

    assert value_of("計算結果") == "最適性確認済み"
    assert value_of("検証関数") == "問題なし"
    assert value_of("既払い額") == 1000
    assert value_of("今回の追加費用") == 0
    assert value_of("昼のパレード") == "満たす"
    assert "1人分" in " ".join(values)  # 費用の基準（1人分）を明記する
    assert isinstance(report.precheck_table(demo_result), pd.DataFrame)


def test_tables_for_an_infeasible_result_explain_the_reason(infeasible_result):
    """成立しない条件では、状態の文章と事前チェックの表に日本語の理由が出る。"""
    assert infeasible_result.status == "infeasible"
    assert "実行不可能と証明" in report.status_text(infeasible_result)
    checks = report.precheck_table(infeasible_result)
    assert (checks["実行不可能の証明"] == "はい").any()
    assert checks["内容"].str.contains("S2").any()


def test_plot_timeline_returns_a_matplotlib_figure(demo_result):
    """タイムライン図は matplotlib の Figure で返る（予定の各項目と「出口へ」の行がある）。"""
    figure = report.plot_timeline(demo_result.validation)
    try:
        assert isinstance(figure, Figure)
        axis = figure.axes[0]
        assert len(axis.get_yticks()) == len(demo_result.validation.rows) + 1
        assert len(axis.patches) >= len(demo_result.validation.segments)
    finally:
        plt.close(figure)


def test_save_run_creates_a_new_folder_with_plan_segments_and_summary(tmp_path, demo_result):
    """保存するたびに新しいフォルダを作り、plan.csv・segments.csv・summary.json（UTF-8 の JSON）を書く。"""
    validation = demo_result.validation
    figure = report.plot_timeline(validation)
    try:
        folders = [report.save_run(tmp_path, "demo", demo_result, validation, figure=figure) for _ in range(3)]
    finally:
        plt.close(figure)
    assert len(set(folders)) == 3
    for folder in folders:
        assert folder.parent == tmp_path
        assert {"plan.csv", "segments.csv", "summary.json", "timeline.png"} <= {path.name for path in folder.iterdir()}
        text = (folder / "summary.json").read_text(encoding="utf-8")
        summary = json.loads(text)
        assert summary["status"] == "optimal"
        assert "最適性確認済み" in text  # 日本語をそのまま書く（\\u のような書き方にしない）
        assert summary["validation"]["ok"] is True
        assert summary["validation"]["metrics"]["already_paid_yen"] == 1000
        assert summary["conditions"]["exit_time"] == "18:00"
        assert len(summary["steps"]) == len(validation.rows)
        plan = pd.read_csv(folder / "plan.csv", encoding="utf-8-sig")
        assert len(plan) == len(validation.rows)
        segments = pd.read_csv(folder / "segments.csv", encoding="utf-8-sig")
        assert len(segments) == len(validation.segments)


def test_save_run_never_overwrites_a_previous_result(tmp_path, monkeypatch, demo_result, infeasible_result):
    """同じ時刻（秒）・同じラベルで保存しても、番号をつけた別のフォルダにし、前の結果は変わらない。"""

    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 1, 2, 3, 4, 5)

    monkeypatch.setattr(report, "datetime", FixedDatetime)
    first = report.save_run(tmp_path, "same", demo_result, demo_result.validation)
    before = (first / "summary.json").read_text(encoding="utf-8")
    second = report.save_run(tmp_path, "same", infeasible_result)
    assert (first.name, second.name) == ("20260102-030405_same", "20260102-030405_same-2")
    assert (first / "summary.json").read_text(encoding="utf-8") == before
    assert json.loads((second / "summary.json").read_text(encoding="utf-8"))["status"] == "infeasible"
    assert not (second / "plan.csv").exists()  # 予定のない結果には予定表を書かない


def test_save_run_works_for_an_input_error(tmp_path, demo_scenario, solve):
    """入力の誤りの結果（計算用の問題が作れない）でも、状態と理由を保存できる。"""
    result = solve(demo_scenario, dict(CONDITIONS, entry_time="9時"))
    assert result.status == "error"
    folder = report.save_run(tmp_path, "error", result)
    summary = json.loads((folder / "summary.json").read_text(encoding="utf-8"))
    assert summary["status"] == "error"
    assert any("entry_time" in message for message in summary["messages"])


def test_environment_info_records_python_and_library_versions():
    """環境の記録に、Python と主要ライブラリ（OR-Tools・PuLP など）の版が入る。"""
    info = report.environment_info()
    assert info["python"].count(".") == 2
    for name in ("ortools", "pulp", "pandas", "matplotlib"):
        assert info[name] != "未導入", name
