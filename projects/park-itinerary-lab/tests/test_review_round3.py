"""3回目の見直し（修正の確認）で見つかった問題が再び起きないことを確かめるテスト。"""

import json
import os
import subprocess
import sys

import nbformat
import pytest

from park_itinerary_lab import experiment
from park_itinerary_lab.data import InputError

DEMO_BUSY = {"entry_time": "09:00", "exit_time": "18:00", "season": "busy", "budget_yen": 2000,
             "allow_new_shortcuts": True, "required_shows": ["S1"], "required_meals": ["M1"]}


# ---------------------------------------------------------------------------
# 事前チェック P4 の説明
# ---------------------------------------------------------------------------


def test_total_time_precheck_counts_items_dropped_only_for_their_price(make_scenario, make_conditions, solve):
    """料金だけで外れた必須の施設（X）も、「料金を考えなければ」の合計に入れる（入れないと誤った説明になる）。"""
    offers = [
        {"id": "PX", "attraction": "X", "window": "09:00-10:00", "price_yen": 1000, "residual_wait_min": 0},
        {"id": "PY", "attraction": "Y", "window": "09:00-10:00", "price_yen": 1000, "residual_wait_min": 0},
    ]
    scenario = make_scenario(
        attractions=[{"id": "X", "duration_min": 30, "preference": 1}, {"id": "Y", "duration_min": 20, "preference": 1},
                     {"id": "Z", "duration_min": 10, "preference": 1}],
        bands=("09:00-10:00",),
        waits={"X": [None], "Y": [30], "Z": [10]},
        offers=offers,
        positions={"entrance": 0, "exit": 0, "X": 0, "Y": 0, "Z": 0},
    )
    conditions = make_conditions("09:00", "10:00", allow_new_shortcuts=True, required_attractions=["X", "Y", "Z"],
                                 budget_yen=0)
    result = solve(scenario, conditions)
    assert result.status == "infeasible"
    total = next(issue.message for issue in result.precheck_issues if issue.code == "P4-total")
    assert "料金を考えなければ" not in total  # 料金を考えなくても 30 + 20 + 20 = 70 分 > 60 分


# ---------------------------------------------------------------------------
# ショーの条件
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("variant", [
    {"label": "存在しないショー", "show_id": "S9"},
    {"label": "必須にしない（IDの打ち間違い）", "show_id": "s1", "required": False},
])
def test_unknown_show_ids_become_error_rows(demo_scenario, solver_settings, variant):
    """存在しないショーのIDは、基準のケースとして黙って計算せず、エラーの行にする。"""
    table, _details = experiment.run_comparison(
        demo_scenario, DEMO_BUSY, experiment.comparison_cases([0], [variant]), solver_settings)
    assert list(table["status"]) == ["error", "error"]
    assert all(f"ショー '{variant['show_id']}' がありません" in reason for reason in table["reason"])


def test_required_true_adds_the_show_to_the_required_shows(demo_scenario, solver_settings):
    variant = {"label": "S2を必須に", "show_id": "S2", "required": True}
    conditions = experiment.conditions_for_variant(dict(DEMO_BUSY, required_shows=[]), variant, demo_scenario)
    assert conditions["required_shows"] == ["S2"]
    table, _details = experiment.run_comparison(
        demo_scenario, dict(DEMO_BUSY, required_shows=[]), experiment.comparison_cases([0], [variant]), solver_settings)
    assert list(table["required_shows"]) == ["S2", "S2"]
    assert list(table["status"]) == ["infeasible", "infeasible"]  # S2 は 19:30 開演で、18:00 の退園の後


@pytest.mark.parametrize("rank", [["A1", "S1", "A4", "A6"], ("A1", "S1", "A4", "A6")])
def test_no_show_baseline_keeps_the_other_ranked_preferences(demo_scenario, rank):
    """希望順位にショーが入っていても、ショーを外した基準で、ほかの活動の希望度は変えない。"""
    variant = {"label": "ショーなし", "show_id": "S1", "exclude": True}
    conditions = experiment.conditions_for_variant(dict(DEMO_BUSY, preference_rank=rank), variant, demo_scenario)
    assert conditions["preference_rank"] is None
    preferences = conditions["preferences"]
    assert (preferences["A1"], preferences["A4"], preferences["A6"]) == (4, 2, 1)
    assert preferences["S1"] == 0 and preferences["A2"] == 0  # 除くショーだけを0にし、一覧にない活動は元のとおり0


def test_no_show_baseline_with_a_rank_solves_without_errors(demo_scenario, solver_settings):
    variants = [{"label": "ショーなし", "show_id": "S1", "exclude": True}, {"label": "元", "show_id": "S1"}]
    conditions = dict(DEMO_BUSY, preference_rank=("A1", "S1", "A4", "A6"))
    table, _details = experiment.run_comparison(
        demo_scenario, conditions, experiment.comparison_cases([0], variants), solver_settings)
    assert "error" not in set(table["status"])


def test_list_as_show_id_is_an_error_row_even_with_preferences(demo_scenario, solver_settings):
    variant = {"label": "ショーなし（S1とS2）", "show_id": ["S1", "S2"], "exclude": True}
    conditions = dict(DEMO_BUSY, preferences={"A3": 8})
    table, _details = experiment.run_comparison(
        demo_scenario, conditions, experiment.comparison_cases([0], [variant]), solver_settings)
    assert list(table["status"]) == ["error", "error"]
    assert all("show_id" in reason for reason in table["reason"])


def test_non_string_required_show_gives_error_rows(demo_scenario, solver_settings):
    table, _details = experiment.run_comparison(
        demo_scenario, dict(DEMO_BUSY, required_shows=[1]),
        experiment.comparison_cases([0], [{"label": "元", "show_id": "S1"}]), solver_settings)
    assert list(table["status"]) == ["error", "error"]
    assert list(table["required_shows"]) == ["1", "1"]


def test_repeated_batch_seeds_are_rejected(solver_settings):
    with pytest.raises(InputError, match="同じ seed"):
        experiment.run_random_batch([1, 1], [0], {"entry_time": "09:00", "exit_time": "18:00", "season": "random"},
                                    solver_settings)


# ---------------------------------------------------------------------------
# 比較の表の表示
# ---------------------------------------------------------------------------


def test_comparison_view_shows_the_specific_reason_and_plain_numbers(demo_scenario, solver_settings):
    variants = [{"label": "退園後", "show_id": "S1", "starts": ["20:00"]}, {"label": "元", "show_id": "S1"}]
    table, _details = experiment.run_comparison(
        demo_scenario, DEMO_BUSY, experiment.comparison_cases([0], variants), solver_settings)
    view = experiment.comparison_view(table)
    no_plan = view.iloc[0]
    assert no_plan["予定がない理由"].startswith("必須の「昼のパレード」（S1）")  # 事前チェックの一般的な見出しではない
    assert no_plan["希望度合計"] == "" and view.iloc[1]["Bの選択肢がAと同じ"] == ""
    assert "「予定がない理由」の列" in view.iloc[1]["差の注記"]
    planned = view.iloc[3]
    assert isinstance(planned["希望度合計"], int) and planned["希望度合計の差（A − B）"] == 0
    assert view.iloc[2]["希望度合計の差（A − B）"] == ""  # A の行には差を書かない


def test_cost_difference_is_shown_only_for_tied_proven_scores(demo_scenario, solver_settings):
    """同点で、両方の追加費用まで最適性を確認できたときだけ、追加費用の差（B − A）を計算する。"""
    variant = {"label": "パークの奥で開演", "show_id": "S1", "x": -400, "y": 680}
    table, _details = experiment.run_comparison(
        demo_scenario, DEMO_BUSY, experiment.comparison_cases([2000], [variant]), solver_settings)
    row_a, row_b = table.iloc[0], table.iloc[1]
    assert row_b["score_diff_A_minus_B"] == 0
    assert row_b["cost_diff_B_minus_A"] == row_b["extra_cost_yen"] - row_a["extra_cost_yen"] >= 0


# ---------------------------------------------------------------------------
# Notebook とセットアップセル
# ---------------------------------------------------------------------------


def test_model_section_has_a_single_well_formed_table(project_dir):
    notebook = nbformat.read(project_dir / "notebooks" / "02_day_plan_optimisation.ipynb", as_version=4)
    text = "\n".join(cell.source for cell in notebook.cells if cell.cell_type == "markdown")
    assert text.count("| まとまり | 関数 | 内容 |") == 1
    header_line = next(i for i, line in enumerate(text.splitlines()) if line.startswith("| まとまり | 関数 | 内容 |"))
    following = text.splitlines()[header_line + 2]
    assert following.startswith("| 決定変数 |")


def test_notebook_02_runs_through_without_an_entry_time(run_notebook):
    _notebook, text = run_notebook("02_day_plan_optimisation", [('    "entry_time": "09:00",          # 入園時刻\n', "")])
    assert "設定セルの入力に誤りがあります" in text
    assert "比較実験:" in text  # まとめまで実行された


def test_setup_cell_records_where_the_code_came_from(project_dir, tmp_path):
    """PROJECT_DIR_OVERRIDE で使った場合、取得していない REPO_URL・REPO_REF を記録しない。"""
    source = nbformat.read(project_dir / "notebooks" / "01_pulp_intro.ipynb", as_version=4).cells[2].source
    source = source.replace('PROJECT_DIR_OVERRIDE = ""', f'PROJECT_DIR_OVERRIDE = "{project_dir}"')
    source = source.replace("    install_project(PROJECT_DIR)", '    raise RuntimeError("テスト: インストールが必要になりました")')
    source += "\nprint('SOURCE_INFO=' + json.dumps(SOURCE_INFO))\n"
    script = tmp_path / "setup_cell.py"
    script.write_text(source, encoding="utf-8")
    env = dict(os.environ, HOME=str(tmp_path), PYTHONPATH=str(project_dir / "src"))
    done = subprocess.run([sys.executable, str(script)], cwd=tmp_path, capture_output=True, text=True, env=env,
                          timeout=300)
    assert done.returncode == 0, done.stderr[-2000:]
    info = json.loads(done.stdout.split("SOURCE_INFO=")[1])
    assert info["code_source"] == "PROJECT_DIR_OVERRIDE"
    assert info["repo_url"] is None and info["repo_ref"] is None
