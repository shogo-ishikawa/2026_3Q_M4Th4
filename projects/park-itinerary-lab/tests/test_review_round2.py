"""2回目の見直しで見つかった問題が再び起きないことを確かめるテスト。"""

import json
import os
import shutil
import subprocess
import sys

import nbformat
import pandas as pd
import pytest
from nbclient.exceptions import CellExecutionError

from park_itinerary_lab import experiment
from park_itinerary_lab.data import InputError, prepare_problem

DEMO_BUSY = {"entry_time": "09:00", "exit_time": "18:00", "season": "busy", "budget_yen": 2000,
             "allow_new_shortcuts": True, "required_shows": ["S1"], "required_meals": ["M1"]}


def _messages(result):
    return " ".join(result.messages)


# ---------------------------------------------------------------------------
# 事前チェックの説明（時間・予算・完了期限の区別）
# ---------------------------------------------------------------------------


def test_total_time_precheck_says_when_prices_are_the_cause(demo_scenario, solve):
    """予算0円では必須2施設の合計時間が滞在に収まらないが、料金を考えなければ収まる。P4 はそれを書き添える。"""
    conditions = {"entry_time": "10:00", "exit_time": "12:10", "season": "busy", "budget_yen": 0,
                  "allow_new_shortcuts": True, "required_attractions": ["A1", "A4"]}
    blocked = solve(demo_scenario, conditions)
    assert blocked.status == "infeasible" and blocked.proof == "precheck"
    total = next(issue.message for issue in blocked.precheck_issues if issue.code == "P4-total")
    assert "予算内で使える方法では" in total and "料金を考えなければ" in total
    assert solve(demo_scenario, dict(conditions, budget_yen=2100)).status == "optimal"


def test_total_time_precheck_keeps_the_time_wording_without_prices(make_scenario, make_conditions, solve):
    """短縮利用の枠がなく、時間だけが足りない場合は、料金の説明を付けない。"""
    scenario = make_scenario(
        attractions=[{"id": "X", "duration_min": 40, "preference": 1}, {"id": "Y", "duration_min": 40, "preference": 1}],
        positions={"entrance": 0, "exit": 0, "X": 0, "Y": 0},
    )
    result = solve(scenario, make_conditions("09:00", "10:00", required_attractions=["X", "Y"]))
    assert result.status == "infeasible"
    total = next(issue.message for issue in result.precheck_issues if issue.code == "P4-total")
    assert "料金を考えなければ" not in total


@pytest.mark.parametrize("budget, budget_named", [(500, True), (1000, False)])
def test_completion_deadline_message_names_the_budget_only_when_it_also_blocks(
        make_scenario, make_conditions, solve, budget, budget_named):
    """完了期限で外れた枠が予算も超えるなら両方を、予算内なら完了期限だけを原因として説明する。"""
    scenario = make_scenario(
        attractions=[{"id": "X", "duration_min": 5, "preference": 1, "finish_by": "09:30"}],
        waits={"X": [None]},
        offers=[{"id": "PX", "attraction": "X", "window": "09:00-10:00", "price_yen": 800, "residual_wait_min": 0}],
        positions={"entrance": 0, "exit": 0, "X": 40},
    )
    conditions = make_conditions("09:00", "12:00", allow_new_shortcuts=True, required_attractions=["X"],
                                 budget_yen=budget)
    result = solve(scenario, conditions)
    assert result.status == "infeasible" and result.proof == "precheck"
    assert "完了期限" in _messages(result)
    assert ("予算を超えます" in _messages(result)) is budget_named


# ---------------------------------------------------------------------------
# 比較実験の設定の誤り
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("budgets, variants, reference, words", [
    ([0, 1000], [{"label": "x", "show_id": "S1"}, {"label": "x", "show_id": "S1", "starts": ["14:00"]}], None,
     "label が重複"),
    ([0, 0], [{"label": "x", "show_id": "S1"}], None, "同じ予算"),
    (1000, [{"label": "x", "show_id": "S1"}], None, "EXPERIMENT_BUDGETS"),
    ([], [{"label": "x", "show_id": "S1"}], None, "EXPERIMENT_BUDGETS"),
    ([-100], [{"label": "x", "show_id": "S1"}], None, "0以上の整数"),
    ([0], [{"show_id": "S1", "starts": ["13:00"]}], None, "label"),
    ([0], "S1", None, "EXPERIMENT_SHOW_VARIANTS"),
    ([0], [{"label": "x", "show_id": "S1"}], "9時", "REFERENCE_TIME"),
])
def test_experiment_settings_errors_are_japanese_input_errors(demo_scenario, solver_settings,
                                                              budgets, variants, reference, words):
    """ケースの一覧を作れない設定の誤りは、計算を始める前に日本語の InputError にする（KeyError などにしない）。"""
    with pytest.raises(InputError) as caught:
        cases = experiment.comparison_cases(budgets, variants)
        experiment.run_comparison(demo_scenario, DEMO_BUSY, cases, solver_settings, reference)
    assert any(words in problem for problem in caught.value.problems)


def test_duplicate_case_ids_are_rejected_before_solving(demo_scenario, solver_settings):
    cases = [{"case_id": "同じ", "budget_yen": 0, "show_variant": None},
             {"case_id": "同じ", "budget_yen": 1000, "show_variant": None}]
    with pytest.raises(InputError, match="重複"):
        experiment.run_comparison(demo_scenario, DEMO_BUSY, cases, solver_settings)


@pytest.mark.parametrize("seeds", ["1", [], [1.5]])
def test_random_batch_checks_its_seeds(seeds, solver_settings):
    with pytest.raises(InputError, match="BATCH_SEEDS"):
        experiment.run_random_batch(seeds, [0], {"entry_time": "09:00", "exit_time": "18:00", "season": "random"},
                                    solver_settings)


def test_bad_variant_contents_become_error_rows_with_the_reason(demo_scenario, solver_settings):
    """1つのショーの条件の中身の誤りは、そのケースのエラーの行として、学生が書いた値を示して残す。"""
    variants = [{"label": "IDなし", "required": False}, {"label": "時刻の誤記", "show_id": "S1", "starts": ["13時"]}]
    table, _details = experiment.run_comparison(
        demo_scenario, DEMO_BUSY, experiment.comparison_cases([0], variants), solver_settings)
    assert list(table["status"]) == ["error"] * 4
    assert "show_id" in table["message"].iloc[0]
    assert "'13時'" in table["message"].iloc[2]


def test_comparison_rows_keep_the_precheck_reason(demo_scenario, solver_settings):
    """退園後に開演するショーを必須にしたケースは、事前チェックの理由まで表に残す。"""
    variants = [{"label": "退園後", "show_id": "S1", "starts": ["20:00"]}]
    table, _details = experiment.run_comparison(
        demo_scenario, DEMO_BUSY, experiment.comparison_cases([0], variants), solver_settings)
    assert list(table["status"]) == ["infeasible", "infeasible"]
    assert all("どの公演回も" in message for message in table["message"])
    assert table["diff_note"].iloc[1].startswith("Aに予定がないため")
    view = experiment.comparison_view(table)
    assert "予定がない理由" in view.columns and all("どの公演回も" in reason for reason in view["予定がない理由"])


# ---------------------------------------------------------------------------
# 研究の基準（ショーなし）と、方法Bの表示
# ---------------------------------------------------------------------------


def test_no_show_baseline_removes_the_fixed_time_event(demo_scenario, solver_settings):
    """S1 を除く条件では S1 を予定に入れない（S1 は地点として残し、希望度0にする）。必須にしないだけの条件では、S1 が任意の予定として選ばれる。"""
    variants = [{"label": "ショーなし", "show_id": "S1", "exclude": True},
                {"label": "必須にしない", "show_id": "S1", "required": False}]
    table, details = experiment.run_comparison(
        demo_scenario, DEMO_BUSY, experiment.comparison_cases([1000], variants), solver_settings)
    excluded, optional = table.iloc[0], table.iloc[2]
    assert excluded["status"] == optional["status"] == "optimal"
    problem = details["ショーなし／予算1000円"]["A"]["result"].problem
    assert excluded["shows_attended"] == "" and excluded["excluded_shows"] == "S1"
    assert "S1" in problem.scenario.shows and problem.preferences["S1"] == 0  # 地点としては残す（移動時間を変えない）
    assert optional["shows_attended"].startswith("S1-")
    assert excluded["required_shows"] == optional["required_shows"] == "なし"


def test_exclude_variant_cannot_be_combined_with_a_new_time(demo_scenario):
    with pytest.raises(InputError, match="exclude"):
        experiment.apply_show_variant(demo_scenario, {"label": "x", "show_id": "S1", "exclude": True, "starts": ["13:00"]})


def test_same_options_flag_ignores_attractions_with_a_must_use_slot(demo_scenario, solver_settings):
    """必ず使う取得済み枠がある施設（A6）は、方法Aでも他の枠を使えないので、B と A の選択肢の比較から除く。"""
    own = {"id": "OWN6", "attraction": "A6", "window": "12:00-13:00", "residual_wait_min": 5, "paid_yen": 800,
           "must_use": True}
    conditions = dict(DEMO_BUSY, budget_yen=1000, acquired_shortcuts=[own])
    table, _details = experiment.run_comparison(
        demo_scenario, conditions, experiment.comparison_cases([1000], [{"label": "元", "show_id": "S1"}]),
        solver_settings)
    row_b = table.iloc[1]
    assert row_b["shortcut_candidates"] == "A4"
    assert row_b["b_same_options_as_a"] == True  # noqa: E712
    assert row_b["score_diff_A_minus_B"] == 0


def test_representative_cases_ignore_the_visiting_order_of_shortcuts():
    a, b = experiment.METHOD_LABELS["A"], experiment.METHOD_LABELS["B"]
    rows = [
        ("gap", a, None, None, "A4", 900), ("gap", b, 3, False, "A6", 800),
        ("same-set", a, None, None, "A4, A6", 1700), ("same-set", b, 0, False, "A6, A4", 1700),
        ("other-choice", a, None, None, "A4", 900), ("other-choice", b, 0, False, "A1", 1200),
    ]
    table = pd.DataFrame(rows, columns=["case_id", "method", "score_diff_A_minus_B", "b_same_options_as_a",
                                        "used_shortcut_attractions", "extra_cost_yen"])
    assert experiment.representative_cases(table) == ["gap", "other-choice"]


def test_candidate_view_uses_japanese_column_names(demo_scenario):
    rows = experiment.shortlist_candidates(prepare_problem(demo_scenario, DEMO_BUSY), "09:00")
    view = experiment.candidate_view(rows)
    assert list(view.columns)[:3] == ["施設ID", "名前", "基準時刻"]
    assert set(view["候補"]) <= {"候補", ""}


# ---------------------------------------------------------------------------
# Notebook（設定の誤りで「すべて実行」が止まらない、または日本語で止まる）
# ---------------------------------------------------------------------------


def test_notebook_02_explains_a_wrong_experiment_setting(run_notebook):
    _notebook, text = run_notebook("02_day_plan_optimisation", [('REFERENCE_TIME = None', 'REFERENCE_TIME = "9時"')])
    assert "比較実験の設定に誤りがあります" in text and "REFERENCE_TIME" in text
    assert "比較実験の表がないため" in text
    assert "設定セルの条件の計算結果: 最適性確認済み" in text


def test_notebook_01_stops_with_a_japanese_message_for_an_unknown_required_id(run_notebook):
    with pytest.raises(CellExecutionError, match="必須の活動 'Z' がありません"):
        run_notebook("01_pulp_intro", [('required_ids = ["F"]', 'required_ids = ["Z"]')])


# ---------------------------------------------------------------------------
# セットアップセル（ネットワークを使わない場合）と、Notebook の実行スクリプト
# ---------------------------------------------------------------------------


def _setup_source(project_dir, replacements):
    """01 のセットアップセルのコードを取り出し、設定の行を置き換える。"""
    notebook = nbformat.read(project_dir / "notebooks" / "01_pulp_intro.ipynb", as_version=4)
    source = notebook.cells[2].source
    for old, new in replacements:
        assert old in source, old
        source = source.replace(old, new)
    return source


def _run_setup(project_dir, folder, replacements, src_dir=None):
    """セットアップセルを別のプロセスで実行する。インストールが必要になったら、インストールせずに止める。

    src_dir（標準はこの作品の src/）を PYTHONPATH の先頭に置き、試すコードを読み込ませる
    （インストール済みのパッケージが別のチェックアウトを指していても、入れ直さないようにする）。
    """
    no_install = ("    install_project(PROJECT_DIR)", '    raise RuntimeError("テスト: インストールが必要になりました")')
    script = folder / "setup_cell.py"
    script.write_text(_setup_source(project_dir, [*replacements, no_install]), encoding="utf-8")
    env = dict(os.environ, HOME=str(folder), GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
               PYTHONPATH=str(src_dir or project_dir / "src"))
    return subprocess.run([sys.executable, str(script)], cwd=folder, capture_output=True, text=True, env=env,
                          timeout=300)


def test_setup_cell_rejects_an_empty_repo_ref_without_falling_back(project_dir, tmp_path):
    done = _run_setup(project_dir, tmp_path, [('REPO_REF = "claude/new-session-cc8kr0"', 'REPO_REF = "   "')])
    assert done.returncode != 0
    assert "REPO_REF が空です" in done.stderr
    assert not (tmp_path / "2026_3Q_M4Th4").exists()


def test_setup_cell_explains_how_to_use_a_checkout_it_did_not_create(project_dir, tmp_path):
    clone = tmp_path / "2026_3Q_M4Th4"
    clone.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=clone, check=True)
    done = _run_setup(project_dir, tmp_path, [])
    assert done.returncode != 0
    assert "このセルが作ったチェックアウトではない" in done.stderr and "PROJECT_DIR_OVERRIDE" in done.stderr
    assert "CHECKOUT_DIR を変える" not in done.stderr  # Colab 以外では CHECKOUT_DIR は使わない
    assert list(clone.iterdir()) == [clone / ".git"]


def test_setup_cell_does_not_report_another_repositorys_commit_for_an_unpacked_copy(project_dir, tmp_path):
    """配布zipを別のGitリポジトリの中に展開しても、そのリポジトリのコミットを作品の版として表示しない。"""
    outer = tmp_path / "coursework"
    copy = outer / "v0.1.0"
    shutil.copytree(project_dir, copy, ignore=shutil.ignore_patterns("outputs", "__pycache__", ".pytest_cache"))
    (copy / "BUILD_INFO.json").write_text(json.dumps({"version": "0.1.0", "commit": "abc1234"}), encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=outer, check=True)
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q",
                    "--allow-empty", "-m", "unrelated"], cwd=outer, check=True)
    done = _run_setup(project_dir, tmp_path, [('PROJECT_DIR_OVERRIDE = ""', f'PROJECT_DIR_OVERRIDE = "{copy}"')],
                      src_dir=copy / "src")
    assert done.returncode == 0, done.stderr[-2000:]
    assert "Gitのチェックアウトではありません" in done.stdout
    assert "abc1234" in done.stdout  # 配布zipの情報（BUILD_INFO.json）を表示する
    assert "コミットしていない変更" not in done.stdout


def _copy_runner(project_dir, root):
    """scripts/run_notebooks.py を、配布zipと同じ形（v0.1.0/ の下）に写す。"""
    copy = root / "v0.1.0"
    (copy / "scripts").mkdir(parents=True)
    (copy / "notebooks").mkdir()
    shutil.copy2(project_dir / "scripts" / "run_notebooks.py", copy / "scripts" / "run_notebooks.py")
    return copy


def test_run_notebooks_refuses_repo_root_outside_the_repository(project_dir, tmp_path):
    copy = _copy_runner(project_dir, tmp_path)
    done = subprocess.run([sys.executable, str(copy / "scripts" / "run_notebooks.py"), "--cwd", "repo-root"],
                          capture_output=True, text=True, timeout=120)
    assert done.returncode == 2
    assert "--cwd repo-root は使えません" in done.stdout
    assert not (tmp_path / "2026_3Q_M4Th4").exists()


def test_run_notebooks_reports_a_cell_timeout_and_keeps_the_partial_notebook(project_dir, tmp_path):
    copy = _copy_runner(project_dir, tmp_path)
    notebook = nbformat.v4.new_notebook()
    notebook.cells = [nbformat.v4.new_code_cell("print('started')"), nbformat.v4.new_code_cell("import time\ntime.sleep(30)")]
    nbformat.write(notebook, copy / "notebooks" / "slow.ipynb")
    done = subprocess.run([sys.executable, str(copy / "scripts" / "run_notebooks.py"), "slow", "--timeout", "3"],
                          capture_output=True, text=True, timeout=180)
    assert done.returncode == 1
    assert "失敗: slow" in done.stdout and "制限時間（3 秒）を超えました" in done.stdout
    saved = list((copy / "outputs" / "executed_notebooks").glob("*/slow.ipynb"))
    assert len(saved) == 1
    assert "started" in nbformat.read(saved[0], as_version=4).cells[0].outputs[0]["text"]
