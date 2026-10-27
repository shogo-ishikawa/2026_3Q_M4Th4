"""テスト全体で使う共通の準備（pytest の fixture）。

- PROJECT_DIR: この作品のフォルダ（tests/ の1つ上）。どこから pytest を実行しても同じ場所を指す。
- demo_scenario: configs/demo_park.json から読み込んだデモのシナリオ。
- make_scenario / make_conditions: 手で作る極小問題の辞書を作る関数。
- solve: 極小問題やデモを、制限時間を明示した設定で解く関数。

テストの出力ファイルは、pytest が用意する tmp_path の中だけに書きます。
"""

import json
from pathlib import Path

import pytest

from park_itinerary_lab.data import load_scenario, scenario_from_dict
from park_itinerary_lab.model import SolverSettings, solve_day_plan

PROJECT_DIR = Path(__file__).resolve().parents[1]
DEMO_SCENARIO_PATH = PROJECT_DIR / "configs" / "demo_park.json"

# 極小問題の待ち時間表のキー（季節・混雑の名前）
TINY_SEASON = "test"

# テストで使うソルバーの設定。制限時間は、極小問題やデモの最適性の証明に十分な長さにする。
TEST_TIME_LIMIT_S = 20.0
TEST_NUM_WORKERS = 4
TEST_RANDOM_SEED = 0


# ---------------------------------------------------------------------------
# 作品のフォルダとデモ
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def project_dir():
    """作品のフォルダ（projects/park-itinerary-lab/）。"""
    return PROJECT_DIR


@pytest.fixture(scope="session")
def demo_scenario_path():
    """デモのシナリオのファイル（configs/demo_park.json）。"""
    return DEMO_SCENARIO_PATH


@pytest.fixture
def demo_raw():
    """デモのシナリオの辞書（呼ぶたびに新しく読み込むので、書き換えてもほかのテストに影響しない）。"""
    with DEMO_SCENARIO_PATH.open(encoding="utf-8") as file:
        return json.load(file)


@pytest.fixture
def demo_scenario():
    """configs/demo_park.json から読み込んだデモのシナリオ。"""
    return load_scenario(DEMO_SCENARIO_PATH)


@pytest.fixture
def demo_conditions():
    """デモで使う基本の条件（Notebook の標準に近い、小さな設定）。"""
    return {
        "entry_time": "09:00",
        "exit_time": "18:00",
        "season": "normal",
        "budget_yen": 2000,
        "allow_new_shortcuts": True,
        "required_shows": ["S1"],
        "required_meals": ["M1"],
    }


# ---------------------------------------------------------------------------
# ソルバーの設定と、解く関数
# ---------------------------------------------------------------------------


def make_settings(**changes):
    """テスト用の SolverSettings。制限時間などを明示し、changes で一部だけ変える。"""
    values = {
        "time_limit_s": TEST_TIME_LIMIT_S,
        "num_workers": TEST_NUM_WORKERS,
        "random_seed": TEST_RANDOM_SEED,
    }
    values.update(changes)
    return SolverSettings(**values)


@pytest.fixture
def solver_settings():
    """テスト用のソルバー設定（各段階の制限時間 20 秒、4 スレッド、乱数 seed 0）。"""
    return make_settings()


def solve_with_settings(scenario, conditions, **setting_changes):
    """シナリオ（辞書でも Scenario でもよい）と条件を、テスト用の設定で解いて PlanResult を返す。"""
    if isinstance(scenario, dict):
        scenario = scenario_from_dict(scenario)
    return solve_day_plan(scenario, conditions, make_settings(**setting_changes))


@pytest.fixture(scope="session")
def solve():
    """solve(シナリオ, 条件, run_prechecks=False のような設定の変更) で解く関数。"""
    return solve_with_settings


# ---------------------------------------------------------------------------
# 手で作る極小問題
# ---------------------------------------------------------------------------


def _walk_matrix(nodes, positions, walk, default_walk):
    """すべての地点の組（向きつき）の徒歩時間の表を作る。

    positions を指定した場合は、直線上の位置の差（分）を徒歩時間にする（三角不等式を必ず満たす）。
    そうでなければ walk[(u, v)]（向きは区別しない）、書いていない組は default_walk 分にする。
    """
    matrix = {}
    for u in nodes:
        matrix[u] = {}
        for v in nodes:
            if u == v:
                continue
            if positions is not None:
                matrix[u][v] = abs(positions[u] - positions[v])
            else:
                matrix[u][v] = walk.get((u, v), walk.get((v, u), default_walk))
    return matrix


def build_tiny_scenario(
    attractions=(),
    shows=(),
    meals=(),
    bands=("09:00-12:00",),
    waits=None,
    offers=(),
    positions=None,
    walk=None,
    default_walk=5,
):
    """極小のシナリオの辞書を作る（入力の形は configs/demo_park.json と同じ）。

    - attractions: {"id", "duration_min", "preference"} を含む辞書のリスト。
      queue_open / queue_close を省略すると、最初の時間帯の開始・最後の時間帯の終了にする。
    - shows: {"id", "duration_min", "arrive_before_min", "preference", "performances"} のリスト。
    - meals: {"id", "duration_min", "window", "preference"} のリスト。
    - waits: {施設ID: [時間帯ごとの待ち時間]}。書かなかった施設は、すべての時間帯で0分。
    - positions: {地点ID: 直線上の位置（分）}。入口・出口・全活動を書く。
    - walk: {(地点ID, 地点ID): 分}。positions がないときに使い、書かない組は default_walk 分。
    """
    waits = dict(waits or {})
    first_open = bands[0].split("-")[0]
    last_close = bands[-1].split("-")[1]
    attraction_items = []
    for item in attractions:
        full = {"name": f"施設{item['id']}", "x": 0, "y": 0, "queue_open": first_open,
                "queue_close": last_close, "finish_by": None}
        full.update(item)
        attraction_items.append(full)
        waits.setdefault(item["id"], [0] * len(bands))
    show_items = [dict({"name": f"ショー{show['id']}", "x": 0, "y": 0}, **show) for show in shows]
    meal_items = [dict({"name": f"食事{meal['id']}", "x": 0, "y": 0}, **meal) for meal in meals]
    nodes = ["entrance", "exit"] + [item["id"] for item in attraction_items + show_items + meal_items]
    return {
        "format_version": 1,
        "meta": {
            "title": "テスト用の極小問題（架空）",
            "source_type": "fictional",
            "checked_on": None,
            "assumptions": ["テストのために手で作った架空の値です。"],
            "notes": "",
        },
        "cost_basis": "per_person",
        "gates": {"entrance": {"name": "入口", "x": 0, "y": 0}, "exit": {"name": "出口", "x": 0, "y": 0}},
        "walking": {"metres_per_minute": 60, "distance": "manhattan"},
        "walk_minutes": _walk_matrix(nodes, positions, walk or {}, default_walk),
        "attractions": attraction_items,
        "wait_tables": {TINY_SEASON: {"label": "テスト用", "bands": list(bands), "wait_min": waits}},
        "shortcut_offers": list(offers),
        "shows": show_items,
        "meals": meal_items,
    }


def build_tiny_conditions(entry="09:00", exit="10:00", **extra):
    """極小問題の条件の辞書を作る。extra で budget_yen などを追加する。"""
    conditions = {"entry_time": entry, "exit_time": exit, "season": TINY_SEASON}
    conditions.update(extra)
    return conditions


@pytest.fixture(scope="session")
def make_scenario():
    """極小のシナリオの辞書を作る関数（build_tiny_scenario）。"""
    return build_tiny_scenario


@pytest.fixture(scope="session")
def make_conditions():
    """極小問題の条件の辞書を作る関数（build_tiny_conditions）。"""
    return build_tiny_conditions
