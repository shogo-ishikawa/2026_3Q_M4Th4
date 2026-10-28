"""5回目の見直し（PR #2 のレビュー）で見つかった問題が再び起きないことを確かめるテスト。"""

import json
import shutil
import subprocess
import sys

import nbformat
import pytest

from park_itinerary_lab import experiment
from park_itinerary_lab.intro import compare_with_enumeration, enumerate_selections, solve_selection

NOTEBOOKS = ["01_pulp_intro", "02_day_plan_optimisation"]

# ---------------------------------------------------------------------------
# セットアップセル: 読み込み済みのコードが変わったら止める
# ---------------------------------------------------------------------------

# 子プロセスで実行する手順。Notebook のカーネルと同じく、1つのプロセス・1つの名前空間でセットアップを繰り返す。
CHILD = r'''
import importlib, json, shutil, sys
from pathlib import Path

setup_source, copy, scenario = sys.argv[1], Path(sys.argv[2]), sys.argv[3]
package = copy / "src" / "park_itinerary_lab"
namespace = {"__name__": "__main__"}
steps = []


def run_setup():
    """セットアップのセルを実行し、最後まで進んだか、止まった例外を記録する。"""
    namespace.pop("SETUP_FINISHED", None)
    try:
        exec(compile(setup_source + "\nSETUP_FINISHED = True\n", "setup", "exec"), namespace)
        steps.append({"setup": "ok", "finished": namespace.get("SETUP_FINISHED", False)})
    except Exception as error:
        steps.append({"setup": type(error).__name__, "message": str(error),
                      "finished": namespace.get("SETUP_FINISHED", False)})


def call_format_time():
    exec("from park_itinerary_lab.timeutil import format_time", namespace)
    steps.append({"format_time": namespace["format_time"](570)})


if scenario == "import_before_setup":
    import park_itinerary_lab  # セットアップより前に読み込む（記録がない）
run_setup()
if scenario != "import_before_setup":
    call_format_time()
if scenario in ("edit", "edit_then_reload"):
    with (package / "timeutil.py").open("a", encoding="utf-8") as file:
        file.write('\n\ndef format_time(minutes):\n    return "CHANGED"\n')
if scenario == "edit_then_reload":
    for name in [n for n in sys.modules if n.startswith("park_itinerary_lab.")]:
        del sys.modules[name]  # サブモジュールだけを消し、パッケージを reload しても解決扱いにしない
    importlib.reload(sys.modules["park_itinerary_lab"])
if scenario == "add":
    (package / "extra_module.py").write_text("VALUE = 1\n", encoding="utf-8")
if scenario == "delete":
    (package / "report.py").unlink()
if scenario != "import_before_setup":
    run_setup()
print(json.dumps(steps, ensure_ascii=False))
'''


def _setup_source(project_dir, notebook, copy):
    """Notebook のセットアップセルを取り出し、写しのフォルダを使う設定にする（インストールはさせない）。"""
    source = nbformat.read(project_dir / "notebooks" / f"{notebook}.ipynb", as_version=4).cells[2].source
    replacements = [('PROJECT_DIR_OVERRIDE = ""', f'PROJECT_DIR_OVERRIDE = "{copy}"'),
                    ("    install_project(PROJECT_DIR)", '    raise RuntimeError("テスト: インストールが必要になりました")')]
    for old, new in replacements:
        assert source.count(old) == 1, old
        source = source.replace(old, new)
    return source


@pytest.fixture
def project_copy(project_dir, tmp_path):
    """元のソースを書き換えないように、作品の一時コピーを作る。"""
    copy = tmp_path / "park-itinerary-lab"
    shutil.copytree(project_dir, copy, ignore=shutil.ignore_patterns("outputs", "__pycache__", ".pytest_cache", "dist"))
    return copy


def _run_child(project_dir, notebook, copy, scenario, tmp_path):
    done = subprocess.run(
        [sys.executable, "-c", CHILD, _setup_source(project_dir, notebook, copy), str(copy), scenario],
        capture_output=True, text=True, timeout=600, cwd=tmp_path,
        env={"PYTHONPATH": str(copy / "src"), "PATH": "/usr/bin:/bin", "HOME": str(tmp_path)},
    )
    assert done.returncode == 0, done.stderr[-3000:]
    return json.loads(done.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize("notebook", NOTEBOOKS)
def test_setup_stops_when_loaded_code_was_edited_at_the_same_path(project_dir, project_copy, tmp_path, notebook):
    """同じパスのソースの返値を変えると、同じプロセスでのセットアップの再実行は止まり、新しいプロセスでは新しい値になる。"""
    first, before, second = _run_child(project_dir, notebook, project_copy, "edit", tmp_path)
    assert first == {"setup": "ok", "finished": True} and before == {"format_time": "09:30"}
    assert second["setup"] == "RestartRequired" and second["finished"] is False  # デモの計算へ進まない
    assert "編集 timeutil.py" in second["message"] and "再起動" in second["message"]
    assert "セットアップのセルから実行し直してください" in second["message"]
    fresh_setup, fresh_value, _again = _run_child(project_dir, notebook, project_copy, "unchanged", tmp_path)
    assert fresh_setup == {"setup": "ok", "finished": True} and fresh_value == {"format_time": "CHANGED"}


@pytest.mark.parametrize("notebook", NOTEBOOKS)
def test_setup_can_be_rerun_when_nothing_changed(project_dir, project_copy, tmp_path, notebook):
    first, value, second = _run_child(project_dir, notebook, project_copy, "unchanged", tmp_path)
    assert first == second == {"setup": "ok", "finished": True}
    assert value == {"format_time": "09:30"}


@pytest.mark.parametrize("scenario, words", [("add", "追加 extra_module.py"), ("delete", "削除 report.py"),
                                             ("edit_then_reload", "編集 timeutil.py")])
def test_setup_detects_added_deleted_files_and_ignores_partial_reloads(project_dir, project_copy, tmp_path,
                                                                       scenario, words):
    """ファイルの追加・削除も止める。sys.modules の一部削除やパッケージの reload では解決扱いにしない。"""
    steps = _run_child(project_dir, "02_day_plan_optimisation", project_copy, scenario, tmp_path)
    assert steps[-1]["setup"] == "RestartRequired" and words in steps[-1]["message"]


def test_setup_requires_a_restart_when_loaded_without_a_record(project_dir, project_copy, tmp_path):
    """セットアップより前にパッケージを読み込んだ（読み込み時の記録がない）場合は、安全側に倒して再起動を求める。"""
    (only,) = _run_child(project_dir, "01_pulp_intro", project_copy, "import_before_setup", tmp_path)
    assert only["setup"] == "RestartRequired" and "記録がありません" in only["message"]


def test_both_notebooks_share_the_same_setup_code(project_dir):
    """2つの Notebook のセットアップセルは、依存の追加分（INSTALL_EXTRA）とデモの読み込み以外は同じ。"""
    sources = []
    for notebook in NOTEBOOKS:
        source = nbformat.read(project_dir / "notebooks" / f"{notebook}.ipynb", as_version=4).cells[2].source
        common = source.split("# 4. デモ設定")[0]
        sources.append("\n".join(line for line in common.splitlines() if not line.startswith("INSTALL_EXTRA")))
    assert sources[0] == sources[1]
    assert "check_loaded_code(" in sources[0] and "_PARK_ITINERARY_LAB_LOADED" in sources[0]


# ---------------------------------------------------------------------------
# 研究の比較: すべてのショーを除く基準と、1つのショーだけを除く条件
# ---------------------------------------------------------------------------

UNTIL_21 = {"entry_time": "09:00", "exit_time": "21:00", "season": "busy", "budget_yen": 0,
            "allow_new_shortcuts": True, "required_shows": ["S1"], "required_meals": ["M1"]}
ALL_SHOWS = {"label": "ショーなし（基準）", "exclude_all_shows": True}
ONLY_S1 = {"label": "S1だけ除く", "show_id": "S1", "exclude": True}


@pytest.fixture(scope="module")
def until_21_comparison(demo_scenario_path):
    """退園 21:00（夜の S2-1930 に間に合う）で、すべてのショーを除く条件と S1 だけを除く条件を比べる。"""
    from park_itinerary_lab.data import load_scenario
    from park_itinerary_lab.model import SolverSettings

    scenario = load_scenario(demo_scenario_path)
    raw_before = json.dumps(scenario.raw, sort_keys=True)
    conditions = json.loads(json.dumps(UNTIL_21))
    table, details = experiment.run_comparison(
        scenario, conditions, experiment.comparison_cases([0], [ALL_SHOWS, ONLY_S1]),
        SolverSettings(time_limit_s=20, num_workers=4))
    return table, details, scenario, raw_before, conditions


def test_all_shows_baseline_attends_no_show_in_either_method(until_21_comparison):
    table, _details, _scenario, _raw, _conditions = until_21_comparison
    rows = table[table["case_id"] == "ショーなし（基準）／予算0円"]
    assert list(rows["status"]) == ["optimal", "optimal"]
    assert list(rows["shows_attended"]) == ["", ""]  # A も B も、どのショーも見ない
    assert list(rows["excluded_shows"]) == ["S1, S2", "S1, S2"] and list(rows["required_shows"]) == ["なし", "なし"]


def test_excluding_only_s1_keeps_s2(until_21_comparison):
    table, _details, _scenario, _raw, _conditions = until_21_comparison
    rows = table[table["case_id"] == "S1だけ除く／予算0円"]
    assert list(rows["shows_attended"]) == ["S2-1930", "S2-1930"]
    assert list(rows["excluded_shows"]) == ["S1", "S1"]


def test_comparison_does_not_change_the_original_scenario_or_conditions(until_21_comparison):
    _table, _details, scenario, raw_before, conditions = until_21_comparison
    assert json.dumps(scenario.raw, sort_keys=True) == raw_before
    assert conditions == UNTIL_21


@pytest.mark.parametrize("variant, s2", [(ALL_SHOWS, 0), (ONLY_S1, 2)])
def test_excluding_shows_keeps_rank_based_scores_of_other_activities(demo_scenario, variant, s2):
    """希望順位から決まった、ほかの活動の希望度はそのまま（除いたショーだけを0にする）。"""
    ranked = dict(UNTIL_21, preference_rank=["A1", "S1", "A4", "S2", "A6"])
    conditions = experiment.conditions_for_variant(ranked, variant, demo_scenario)
    preferences = conditions["preferences"]
    assert conditions["preference_rank"] is None and conditions["required_shows"] == []
    assert (preferences["A1"], preferences["A4"], preferences["A6"], preferences["A2"]) == (5, 3, 1, 0)
    assert preferences["S1"] == 0 and preferences["S2"] == s2


def test_excluding_shows_keeps_travel_waits_slots_meals_and_budget(demo_scenario):
    """ショーを除いても、ほかの施設・待ち時間・短縮利用の枠・食事・予算・移動時間は変わらない。"""
    from park_itinerary_lab.data import prepare_problem

    base = prepare_problem(demo_scenario, UNTIL_21)
    excluded = prepare_problem(demo_scenario, experiment.conditions_for_variant(UNTIL_21, ALL_SHOWS, demo_scenario))
    assert excluded.travel == base.travel
    assert (excluded.wait_table, excluded.slots, excluded.budget) == (base.wait_table, base.slots, base.budget)
    assert excluded.required == {a for a in base.required if a not in demo_scenario.shows} == {"M1"}
    assert {a: p for a, p in excluded.preferences.items() if a not in demo_scenario.shows} == \
        {a: p for a, p in base.preferences.items() if a not in demo_scenario.shows}


def test_excluding_a_show_keeps_shortest_routes_through_its_location(make_scenario, make_conditions):
    """徒歩の表で、ショーの場所を通ると近道になる場合も、ショーを除いた後の移動時間は変わらない（地点として残す）。"""
    from park_itinerary_lab.data import prepare_problem, scenario_from_dict

    walk = {("entrance", "X"): 30, ("X", "SH"): 5, ("SH", "entrance"): 5, ("entrance", "exit"): 0,
            ("X", "exit"): 30, ("SH", "exit"): 5}
    raw = make_scenario(attractions=[{"id": "X", "duration_min": 5, "preference": 1}],
                        shows=[{"id": "SH", "duration_min": 10, "arrive_before_min": 0, "preference": 3,
                                "performances": [{"id": "SH-1000", "start": "10:00"}]}], walk=walk)
    scenario = scenario_from_dict(raw)
    conditions = make_conditions("09:00", "12:00", required_shows=["SH"])
    base = prepare_problem(scenario, conditions)
    excluded = prepare_problem(scenario, experiment.conditions_for_variant(conditions, ALL_SHOWS, scenario))
    assert base.travel["entrance"]["X"] == 10  # 入口 → ショーの場所 → X
    assert excluded.travel == base.travel


@pytest.mark.parametrize("variant", [{"label": "x", "exclude_all_shows": True, "show_id": "S1"},
                                     {"label": "x", "exclude_all_shows": False},
                                     {"label": "x", "exclude_all_shows": True, "required": True}])
def test_wrongly_combined_all_shows_variant_is_an_error_row(demo_scenario, solver_settings, variant):
    table, _details = experiment.run_comparison(
        demo_scenario, UNTIL_21, experiment.comparison_cases([0], [variant]), solver_settings)
    assert list(table["status"]) == ["error", "error"]
    assert all("exclude_all_shows" in reason for reason in table["reason"])


# ---------------------------------------------------------------------------
# PuLP 入門: 所要時間・希望度・費用がすべて0の活動
# ---------------------------------------------------------------------------

ZERO = {"id": "Z", "minutes": 0, "preference": 0, "cost_yen": 0}


def _check_against_enumeration(activities, time_limit, budget, required=()):
    result = solve_selection(activities, time_limit, budget, required)
    check = compare_with_enumeration(result, enumerate_selections(activities, time_limit, budget, required))
    assert check["ok"], (result, check)
    assert check["selected_is_one_of_best"] == (result.status == "Optimal")
    return result


def test_only_an_all_zero_optional_activity_gives_a_zero_score_plan():
    """レビューの再現例: 入力の確認は通り、CBC は Optimal を返す。値のない変数で止まらず、希望度0の解を返す。"""
    result = _check_against_enumeration([{"id": "a", "minutes": 0, "preference": 0, "cost_yen": 0}], 10, 0)
    assert (result.status, result.selected, result.total_preference) == ("Optimal", [], 0)


def test_all_zero_activity_mixed_with_ordinary_ones():
    activities = [ZERO, {"id": "A", "minutes": 30, "preference": 5, "cost_yen": 500},
                  {"id": "B", "minutes": 20, "preference": 3, "cost_yen": 0}]
    result = _check_against_enumeration(activities, 40, 1000)
    assert result.selected == ["A"] and result.total_preference == 5  # Z は選んでも選ばなくても同じなので選ばない


def test_required_all_zero_activity_is_selected():
    activities = [ZERO, {"id": "B", "minutes": 20, "preference": 3, "cost_yen": 0}]
    result = _check_against_enumeration(activities, 30, 0, required=["Z"])
    assert sorted(result.selected) == ["B", "Z"] and result.total_preference == 3


@pytest.mark.parametrize("seed", range(30))
def test_random_instances_with_all_zero_activities_match_enumeration(seed):
    import random

    rng = random.Random(seed)
    activities = [dict(ZERO, id=f"Z{i}") for i in range(rng.randint(1, 2))]
    activities += [{"id": f"A{i}", "minutes": rng.randint(0, 60), "preference": rng.randint(0, 9),
                    "cost_yen": rng.choice([0, 300, 800])} for i in range(rng.randint(0, 5))]
    rng.shuffle(activities)
    required = rng.sample([a["id"] for a in activities], k=rng.randint(0, min(2, len(activities))))
    _check_against_enumeration(activities, rng.randint(0, 120), rng.choice([0, 500, 1500]), required)


def test_infeasible_status_is_kept_with_all_zero_activities():
    """実行不可能のときは、従来どおり状態を返し、選んだ活動や合計を作らない。"""
    activities = [ZERO, {"id": "A", "minutes": 30, "preference": 5, "cost_yen": 500}]
    result = _check_against_enumeration(activities, 40, 0, required=["A"])
    assert result.status == "Infeasible" and result.selected == [] and result.total_preference is None


def test_missing_value_is_an_error_unless_the_activity_contributes_nothing():
    """値がない（None）のは、すべて0の任意の活動のときだけ「選ばない」とする。それ以外は隠さずに止める。"""
    from park_itinerary_lab.intro import is_chosen

    assert is_chosen(ZERO, None) is False
    assert is_chosen(ZERO, 1.0, ["Z"]) is True
    with pytest.raises(RuntimeError, match="値を返しませんでした"):
        is_chosen(ZERO, None, ["Z"])  # 必須なのに値がない
    with pytest.raises(RuntimeError, match="値を返しませんでした"):
        is_chosen({"id": "A", "minutes": 30, "preference": 5, "cost_yen": 0}, None)


def test_objective_value_of_an_all_zero_objective_is_zero():
    import pulp

    from park_itinerary_lab.intro import objective_value

    problem = pulp.LpProblem("zero", pulp.LpMaximize)
    x = problem.add_variable("x", cat="Binary")
    problem += 0 * x, "objective"
    problem += x <= 1, "bound"
    assert problem.solve(pulp.COIN_CMD(msg=False)).status_str == "Optimal"
    assert objective_value(problem) == 0


def test_notebook_01_runs_with_an_all_zero_activity(run_notebook):
    """01 の設定セルに、所要時間・希望度・費用がすべて0の活動を加えても、最後まで実行できる。"""
    add = ('required_ids = ["F"]', 'required_ids = ["F"]\nactivities.append({"id": "Z", "name": "ひと休み", '
                                   '"minutes": 0, "preference": 0, "cost_yen": 0})')
    _notebook, text = run_notebook("01_pulp_intro", [add])
    assert "1行ずつ書いたモデルと、src/ の関数の答え（希望度の合計）は一致しました。" in text
