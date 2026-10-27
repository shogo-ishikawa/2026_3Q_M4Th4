"""研究へ向けた比較実験（experiment.py）のテスト。

方法 A（同時最適化）と方法 B（短縮利用の候補を先に絞る）の比較について、
候補の決め方（CANDIDATE_RULE）、比較表の作り方、未確認・エラーのケースの扱い、保存を確かめます。
出力は pytest の tmp_path の中だけに書きます。
"""

import json
from datetime import datetime

import pandas as pd
import pytest

from park_itinerary_lab import experiment, report
from park_itinerary_lab.data import load_scenario, prepare_problem, scenario_from_dict
from park_itinerary_lab.model import SolverSettings, solve_day_plan

METHOD_A = experiment.METHOD_LABELS["A"]
METHOD_B = experiment.METHOD_LABELS["B"]


def offer(offer_id, attraction_id, price, residual, window="09:00-12:00"):
    """短縮利用の仮定枠の辞書を作る。"""
    return {"id": offer_id, "attraction": attraction_id, "window": window, "price_yen": price,
            "residual_wait_min": residual}


# ---------------------------------------------------------------------------
# 方法 B の候補の決め方
# ---------------------------------------------------------------------------

# 基準時刻 09:00 の通常の待ち時間（分）。F は 10:00 から並べるので、基準時刻には通常利用できない。
REFERENCE_WAITS = {"A": 60, "B": 30, "C": 40, "D": 10, "E": 50, "F": 30, "G": 2, "H": 30, "I": 50}
SHORTLIST_OFFERS = [
    offer("P-A-1", "A", 1000, 10),
    offer("P-A-2", "A", 1000, 5),   # A の最安の枠（同額なら残る待ち時間の短い方）→ 短縮 55 分
    offer("P-A-3", "A", 1500, 0),
    offer("P-B", "B", 500, 5),      # 短縮 25 分、50 分/1000円
    offer("P-C", "C", 0, 0),        # 料金0円 → 比は無限大で先頭
    offer("P-D", "D", 100, 10),     # 短縮 0 分 → 候補にしない
    offer("P-E", "E", 2000, 0),     # 短縮 50 分、25 分/1000円
    offer("P-F", "F", 300, 0),      # 基準時刻に通常利用できない → 短縮 0 分
    offer("P-G", "G", 100, 0),      # 短縮 2 分、20 分/1000円（安いので、予算の残りに入る）
    offer("P-H", "H", 500, 5),      # B と同じ比・同じ短縮時間 → 施設IDの順で B の後
    offer("P-I", "I", 1000, 0),     # B と同じ比、短縮時間が長い（50 分）→ B の前
]


@pytest.fixture
def shortlist_rows(make_scenario, make_conditions):
    """予算 2600 円で、基準時刻 09:00 の候補の計算過程を作る。"""
    attractions = [{"id": attraction_id, "duration_min": 5, "preference": 1} for attraction_id in REFERENCE_WAITS]
    for item in attractions:
        if item["id"] == "F":
            item["queue_open"] = "10:00"
    raw = make_scenario(
        attractions=attractions,
        waits={attraction_id: [wait] for attraction_id, wait in REFERENCE_WAITS.items()},
        offers=SHORTLIST_OFFERS,
    )
    conditions = make_conditions(exit="12:00", allow_new_shortcuts=True, budget_yen=2600)
    problem = prepare_problem(scenario_from_dict(raw), conditions)
    return experiment.shortlist_candidates(problem, "09:00")


def test_shortlist_orders_by_saved_minutes_per_yen_with_tie_rules(shortlist_rows):
    """並び順: 短縮できる時間 ÷ 料金 の大きい順。同じ比なら短縮時間の長い順、さらに施設IDの順。"""
    assert [row["attraction_id"] for row in shortlist_rows] == ["C", "A", "I", "B", "H", "E", "G", "D", "F"]
    rows = {row["attraction_id"]: row for row in shortlist_rows}
    assert rows["A"]["saved_per_1000yen"] == 55.0
    assert rows["I"]["saved_per_1000yen"] == rows["B"]["saved_per_1000yen"] == rows["H"]["saved_per_1000yen"] == 50.0
    assert rows["I"]["saved_min"] > rows["B"]["saved_min"] == rows["H"]["saved_min"]
    assert all(row["reference_time"] == "09:00" for row in shortlist_rows)


def test_shortlist_uses_the_cheapest_slot_with_the_shorter_residual_wait_on_price_ties(shortlist_rows):
    """施設ごとに最も安い枠を使う。同じ料金なら、残る待ち時間の短い枠を選ぶ。"""
    rows = {row["attraction_id"]: row for row in shortlist_rows}
    assert rows["A"]["cheapest_slot"] == "P-A-2"
    assert (rows["A"]["price_yen"], rows["A"]["residual_wait_min"], rows["A"]["saved_min"]) == (1000, 5, 55)


def test_shortlist_skips_what_does_not_fit_the_budget_and_continues(shortlist_rows):
    """予算に入らない施設（H・E）は飛ばし、その後の安い施設（G）は候補にする。合計は予算以内。"""
    rows = {row["attraction_id"]: row for row in shortlist_rows}
    assert [row["attraction_id"] for row in shortlist_rows if row["selected"]] == ["C", "A", "I", "B", "G"]
    assert rows["H"]["reason"] == rows["E"]["reason"] == "予算を超える"
    assert rows["G"]["selected"] and rows["G"]["reason"] == "候補"
    assert sum(row["price_yen"] for row in shortlist_rows if row["selected"]) == 2600


def test_shortlist_excludes_attractions_without_a_saving(shortlist_rows):
    """短縮できる時間が0分以下（D）や、基準時刻に通常利用できない施設（F）は候補にしない。"""
    rows = {row["attraction_id"]: row for row in shortlist_rows}
    assert rows["D"]["saved_min"] == 0 and not rows["D"]["selected"]
    assert rows["F"]["normal_wait_min"] is None and rows["F"]["saved_min"] == 0 and not rows["F"]["selected"]
    assert rows["D"]["reason"] == rows["F"]["reason"] == "短縮できる時間が0分以下"


def test_shortlist_puts_free_slots_first(shortlist_rows):
    """料金0円の枠は比を無限大として先頭に置き、表には比を空欄（None）で表示する。"""
    first = shortlist_rows[0]
    assert (first["attraction_id"], first["price_yen"], first["saved_per_1000yen"]) == ("C", 0, None)
    assert first["selected"]


def test_candidate_rule_is_recorded_in_japanese():
    """候補の作り方は、基準時刻・比・同点の扱い・予算の扱いを文章で記録している。"""
    for words in ("基準時刻", "料金", "同点", "予算", "0円"):
        assert words in experiment.CANDIDATE_RULE


# ---------------------------------------------------------------------------
# 方法 B を解く
# ---------------------------------------------------------------------------


@pytest.fixture
def free_late_slot(make_scenario, make_conditions):
    """09:10-10:00 の必須ショーの後に、施設 X を使いたい問題。

    X の通常の待ち時間は 09:00 台は0分、10:00 以降は60分。料金0円の枠 P-X（10:00-11:00）がある。
    基準時刻 09:00 では短縮しても得がないので、方法 B の規則では候補にならない。
    """
    raw = make_scenario(
        attractions=[{"id": "X", "duration_min": 10, "preference": 5}],
        shows=[{"id": "SH", "duration_min": 50, "arrive_before_min": 0, "preference": 6,
                "performances": [{"id": "SH-0910", "start": "09:10"}]}],
        bands=("09:00-10:00", "10:00-12:00"),
        waits={"X": [0, 60]},
        offers=[offer("P-X", "X", 0, 0, window="10:00-11:00")],
        default_walk=5,
    )
    conditions = make_conditions(exit="11:00", allow_new_shortcuts=True, budget_yen=0, required_shows=["SH"])
    return scenario_from_dict(raw), conditions


def test_method_b_with_no_candidates_uses_no_offers(free_late_slot, solver_settings):
    """候補が空（shortcut_candidates = []）なら、B はどの仮定枠も使わない。A は同じ枠を使える。"""
    scenario, conditions = free_late_slot
    result_b, rows, selected = experiment.solve_method_b(scenario, conditions, solver_settings)
    assert selected == []
    assert rows[0]["reason"] == "短縮できる時間が0分以下"
    assert result_b.problem.shortcut_candidates == ()
    assert result_b.problem.slots == {}
    assert result_b.status == "optimal"
    assert all(step.mode != "shortcut" for step in result_b.steps)
    result_a = solve_day_plan(scenario, conditions, solver_settings)
    assert result_a.status == "optimal"
    assert [step.slot_id for step in result_a.steps if step.mode == "shortcut"] == ["P-X"]
    assert result_a.objective_values["score"] == 11 and result_b.objective_values["score"] == 6


def test_comparison_reports_the_difference_when_both_are_proven(free_late_slot, solver_settings):
    """A と B の両方で希望度合計の最適性を確認できたときだけ、差（A − B）を表に入れる。"""
    scenario, conditions = free_late_slot
    cases = [{"case_id": "後の時間帯の無料の枠", "budget_yen": 0, "show_variant": None}]
    table, details = experiment.run_comparison(scenario, conditions, cases, solver_settings)
    assert list(table["method"]) == [METHOD_A, METHOD_B]
    row_a, row_b = table.iloc[0], table.iloc[1]
    assert (row_a["score"], row_b["score"]) == (11, 6)
    assert row_b["score_diff_A_minus_B"] == 5
    assert row_b["shortcut_candidates"] == "なし"
    assert not row_b["b_same_options_as_a"]  # 0円の枠 P-X を B は使えない
    assert pd.isna(row_a["score_diff_A_minus_B"])  # 差は B の行にだけ書く
    assert set(details["後の時間帯の無料の枠"]) >= {"conditions", "A", "B"}


@pytest.fixture(scope="module")
def demo_comparison(demo_scenario_path):
    """デモで、予算3通り × ショーの条件2通り（元のまま／13時に変更）を比較した表。"""
    scenario = load_scenario(demo_scenario_path)
    base = {"entry_time": "09:00", "exit_time": "14:00", "season": "normal", "allow_new_shortcuts": True,
            "required_shows": ["S1"], "required_meals": ["M1"]}
    variants = [{"label": "元のまま", "show_id": "S1"}, {"label": "13時", "show_id": "S1", "starts": ["13:00"]}]
    cases = experiment.comparison_cases([0, 1000, 2000], variants)
    settings = SolverSettings(time_limit_s=20, num_workers=4, random_seed=0)
    table, _details = experiment.run_comparison(scenario, base, cases, settings)
    return table


def test_comparison_table_has_one_row_per_case_and_method(demo_comparison):
    """ケースごとに A と B の2行。設定・状態・限界値・計算時間も列に残す。"""
    assert len(demo_comparison) == 12
    assert list(demo_comparison["method"]) == [METHOD_A, METHOD_B] * 6
    for column in ("case_id", "budget_yen", "show_variant", "status", "optimality_scope", "score", "score_bound",
                   "solve_time_s", "time_limit_s_per_stage", "validation_ok", "shortcut_candidates"):
        assert column in demo_comparison.columns
    assert set(demo_comparison["show_variant"]) == {"元のまま", "13時"}


def test_method_b_never_beats_method_a_when_both_scores_are_proven(demo_comparison):
    """B は A の選択肢を減らした問題なので、両方の希望度合計が確認済みなら B ≦ A になる。"""
    proven_scopes = {"lexicographic", "score_cost", "score"}
    compared = 0
    for case_id, rows in demo_comparison.groupby("case_id", sort=False):
        row_a = rows[rows["method"] == METHOD_A].iloc[0]
        row_b = rows[rows["method"] == METHOD_B].iloc[0]
        assert row_a["validation_ok"] and row_b["validation_ok"], case_id
        if row_a["optimality_scope"] in proven_scopes and row_b["optimality_scope"] in proven_scopes:
            compared += 1
            assert row_b["score"] <= row_a["score"], case_id
            assert row_b["score_diff_A_minus_B"] == row_a["score"] - row_b["score"]
            if row_b["b_same_options_as_a"]:
                assert row_b["score"] == row_a["score"], case_id  # 同じ問題なら同じ最適値
    assert compared == 6


def test_budget_zero_rows_use_no_paid_shortcut(demo_comparison):
    """予算0円のケースでは、A も B も有料の短縮利用を使わない。"""
    zero = demo_comparison[demo_comparison["budget_yen"] == 0]
    assert (zero["extra_cost_yen"] == 0).all()
    assert (zero["used_slots"] == "").all()


def test_difference_is_not_computed_when_a_is_not_proven(monkeypatch, free_late_slot, solver_settings):
    """A の希望度合計が最適と確認できていなければ、差は空欄（NaN）にし、理由を書く。"""
    real_solve = experiment.solve_day_plan

    def solve_with_a_unproven(scenario, conditions, settings=None):
        result = real_solve(scenario, conditions, settings)
        if conditions.get("shortcut_candidates") is None:  # 方法 A だけを「暫定案」にする
            result.status, result.optimality_scope = "feasible", "none"
        return result

    monkeypatch.setattr(experiment, "solve_day_plan", solve_with_a_unproven)
    scenario, conditions = free_late_slot
    cases = [{"case_id": "A が暫定案", "budget_yen": 0, "show_variant": None}]
    table, _details = experiment.run_comparison(scenario, conditions, cases, solver_settings)
    row_a, row_b = table.iloc[0], table.iloc[1]
    assert row_a["status"] == "feasible" and row_b["status"] == "optimal"
    assert pd.isna(row_b["score_diff_A_minus_B"])
    assert "Aの希望度合計が最適と確認できていない" in row_b["diff_note"]


def test_difference_is_not_computed_when_b_is_not_proven(monkeypatch, free_late_slot, solver_settings):
    """B だけが暫定案の場合も、手法の影響として差を計算しない。"""
    real_solve = experiment.solve_day_plan

    def solve_with_b_unproven(scenario, conditions, settings=None):
        result = real_solve(scenario, conditions, settings)
        if conditions.get("shortcut_candidates") is not None:
            result.status, result.optimality_scope = "feasible", "none"
        return result

    monkeypatch.setattr(experiment, "solve_day_plan", solve_with_b_unproven)
    scenario, conditions = free_late_slot
    cases = [{"case_id": "B が暫定案", "budget_yen": 0, "show_variant": None}]
    table, _details = experiment.run_comparison(scenario, conditions, cases, solver_settings)
    row_b = table.iloc[1]
    assert pd.isna(row_b["score_diff_A_minus_B"])
    assert "Bは暫定案" in row_b["diff_note"]


def test_time_limit_zero_rows_are_kept_with_a_note(free_late_slot):
    """制限時間0秒（未判定）のケースも表から除かず、状態と理由を残す。"""
    scenario, conditions = free_late_slot
    cases = [{"case_id": "時間切れ", "budget_yen": 0, "show_variant": None}]
    table, _details = experiment.run_comparison(scenario, conditions, cases, SolverSettings(time_limit_s=0, num_workers=4))
    assert len(table) == 2
    assert set(table["status"]) <= {"unknown", "feasible", "optimal"}
    assert "infeasible" not in set(table["status"])
    row_a, row_b = table.iloc[0], table.iloc[1]
    if row_a["optimality_scope"] not in ("lexicographic", "score_cost", "score"):
        assert pd.isna(row_b["score_diff_A_minus_B"])
        assert "Aの希望度合計が最適と確認できていない" in row_b["diff_note"]


def test_invalid_show_variant_keeps_error_rows(demo_scenario, demo_conditions, solver_settings):
    """ショーの条件の誤り（存在しないショー・時刻の誤り）は、エラーの行として残し、黙って除外しない。"""
    variants = [
        {"label": "存在しないショー", "show_id": "S9", "starts": ["12:00"]},
        {"label": "時刻の誤り", "show_id": "S1", "starts": ["25:99"]},
    ]
    cases = experiment.comparison_cases([0], variants)
    table, details = experiment.run_comparison(demo_scenario, demo_conditions, cases, solver_settings)
    assert len(table) == 4
    assert set(table["status"]) == {"error"}
    assert all(any("぀" <= ch <= "ヿ" for ch in message) for message in table["message"])
    assert table["score"].isna().all()
    assert table["score_diff_A_minus_B"].isna().all()
    assert set(details) == {case["case_id"] for case in cases}


# ---------------------------------------------------------------------------
# ケースの作り方
# ---------------------------------------------------------------------------


def test_comparison_cases_combine_budgets_and_show_variants():
    """ケースは「ショーの条件 × 予算」のすべての組合せ。"""
    variants = [{"label": "元のまま", "show_id": "S1"}, {"label": "13時", "show_id": "S1", "starts": ["13:00"]}]
    cases = experiment.comparison_cases([0, 1000], variants)
    assert [case["case_id"] for case in cases] == ["元のまま／予算0円", "元のまま／予算1000円", "13時／予算0円", "13時／予算1000円"]


def test_show_variant_changes_time_and_place_without_changing_the_original(demo_scenario):
    """ショーの時刻・場所を変えた別のシナリオを作り、元のシナリオは変えない。"""
    variant = {"label": "13時・奥", "show_id": "S1", "starts": ["13:00"], "x": 0, "y": 650}
    changed = experiment.apply_show_variant(demo_scenario, variant)
    assert [(p.id, p.start) for p in changed.shows["S1"].performances] == [("S1-1300", 780)]
    assert (changed.shows["S1"].x, changed.shows["S1"].y) == (0, 650)
    assert [p.start for p in demo_scenario.shows["S1"].performances] == [660, 900]
    assert experiment.apply_show_variant(demo_scenario, {"label": "元のまま", "show_id": "S1"}) is demo_scenario


def test_variant_with_required_false_removes_only_that_show(demo_conditions):
    """required: False のケースでは、そのショーだけを必須から外す（元の条件は変えない）。"""
    base = dict(demo_conditions, required_shows=["S1", "S2"])
    conditions = experiment.conditions_for_variant(base, {"label": "なし", "show_id": "S1", "required": False})
    assert conditions["required_shows"] == ["S2"]
    assert base["required_shows"] == ["S1", "S2"]


def test_representative_cases_pick_the_largest_and_a_zero_difference():
    """代表的なケースとして、差が最大のケースと、差が0のケースを選ぶ（差を計算できたケースだけ）。"""
    table = pd.DataFrame([
        {"case_id": "c1", "method": METHOD_B, "score_diff_A_minus_B": float("nan")},
        {"case_id": "c2", "method": METHOD_B, "score_diff_A_minus_B": 0.0},
        {"case_id": "c3", "method": METHOD_B, "score_diff_A_minus_B": 4.0},
        {"case_id": "c3", "method": METHOD_A, "score_diff_A_minus_B": float("nan")},
    ])
    assert experiment.representative_cases(table) == ["c3", "c2"]


# ---------------------------------------------------------------------------
# 保存と乱数のシナリオ
# ---------------------------------------------------------------------------


def test_save_comparison_writes_csv_and_settings_into_a_new_folder_each_time(tmp_path):
    """呼ぶたびに tmp_path の中に新しいフォルダを作り、comparison.csv と settings.json を書く。"""
    table = pd.DataFrame([{"case_id": "予算0円", "method": METHOD_A, "score": 10}])
    first = experiment.save_comparison(table, tmp_path, "demo", {"seed": None, "note": "テスト"})
    second = experiment.save_comparison(table, tmp_path, "demo", {"seed": None})
    assert first != second
    assert first.parent == tmp_path and second.parent == tmp_path
    for folder in (first, second):
        loaded = pd.read_csv(folder / "comparison.csv", encoding="utf-8-sig")
        assert loaded["case_id"].tolist() == ["予算0円"]
        settings = json.loads((folder / "settings.json").read_text(encoding="utf-8"))
        assert settings["candidate_rule"] == experiment.CANDIDATE_RULE
        assert "python" in settings["environment"]
    assert json.loads((first / "settings.json").read_text(encoding="utf-8"))["note"] == "テスト"


def test_save_comparison_never_overwrites_within_the_same_second(tmp_path, monkeypatch):
    """同じ時刻（秒）に保存しても、番号をつけた別のフォルダにする（上書きしない）。"""

    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 1, 2, 3, 4, 5)

    monkeypatch.setattr(report, "datetime", FixedDatetime)
    table = pd.DataFrame([{"case_id": "c", "score": 1}])
    folders = [experiment.save_comparison(table, tmp_path, "same", {}) for _ in range(3)]
    assert [folder.name for folder in folders] == ["20260102-030405_same", "20260102-030405_same-2", "20260102-030405_same-3"]


@pytest.mark.parametrize("seed", [0, 1, 7])
def test_random_scenario_is_deterministic_per_seed_and_loads(seed):
    """同じ seed からは同じ架空のシナリオができ、入力の確認を通る。"""
    first = experiment.generate_random_scenario(seed)
    assert first == experiment.generate_random_scenario(seed)
    scenario = scenario_from_dict(first)
    assert scenario.meta["source_type"] == "fictional"
    assert len(scenario.attractions) == 8 and len(scenario.shows) == 1 and len(scenario.meals) == 1
    conditions = {"entry_time": "09:00", "exit_time": "18:00", "season": "random", "budget_yen": 1000,
                  "allow_new_shortcuts": True}
    problem = prepare_problem(scenario, conditions)
    assert problem.slots
    assert all(1 <= problem.preferences[attraction_id] <= 10 for attraction_id in scenario.attractions)


def test_different_seeds_give_different_scenarios():
    """seed を変えると、施設の配置や希望度が変わる。"""
    assert experiment.generate_random_scenario(1) != experiment.generate_random_scenario(2)


def test_random_batch_runs_only_when_called_and_records_the_seed(solver_settings):
    """乱数の一括実験は、明示的に呼んだときだけ動く。各行に seed を記録する。"""
    base = {"entry_time": "09:00", "exit_time": "15:00", "season": "random", "allow_new_shortcuts": True}
    table = experiment.run_random_batch([1], [1000], base, solver_settings)
    assert len(table) == 2
    assert set(table["seed"]) == {1}
    assert list(table["method"]) == [METHOD_A, METHOD_B]
    assert set(table["status"]) <= {"optimal", "feasible", "unknown", "infeasible", "error"}
