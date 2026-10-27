"""入力データを読み込み、確認し、計算に使う形にまとめる。

入力は2種類あります。

- シナリオ（パークのデータ）: 施設、待ち時間表、短縮利用の枠、ショー、食事・休憩。
  JSONファイル1つ、または CSV ファイルを集めたフォルダから読み込みます。
- 条件（その日の希望）: 入退園時刻、季節・混雑、予算、必須項目など。Python の辞書で渡します。

prepare_problem() が両方を確認し、最適化・検証・事前チェックが共通に使う Problem を作ります。
誤りがあれば、日本語の説明を並べた InputError を出します。
"""

import copy
import csv
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path

from .timeutil import format_time, format_window, parse_time, parse_window

SOURCE_TYPES = ("fictional", "own_observation", "published_information", "other")
DISTANCE_METHODS = ("manhattan", "euclidean")
COST_BASES = ("per_person", "group_total")
GATE_NODES = ("entrance", "exit")
# 初版で実装済みの追加購入ルール。空なので、ルールを指定すると入力エラーにします。
IMPLEMENTED_PURCHASE_RULES = ()

_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")

CONDITION_KEYS = (
    "entry_time",
    "exit_time",
    "season",
    "budget_yen",
    "cost_basis",
    "party_size",
    "allow_new_shortcuts",
    "required_attractions",
    "required_shows",
    "required_meals",
    "preferences",
    "preference_rank",
    "acquired_shortcuts",
    "shortcut_candidates",
    "purchase_rules",
)


class InputError(ValueError):
    """入力データや条件の誤り。problems に日本語の指摘を1件ずつ持つ。"""

    def __init__(self, problems):
        self.problems = list(problems)
        lines = "\n".join(f"- {problem}" for problem in self.problems)
        super().__init__(f"入力に問題があります:\n{lines}")


@dataclass(frozen=True)
class Attraction:
    id: str
    name: str
    x: float
    y: float
    duration: int
    preference: int
    queue_open: int
    queue_close: int
    finish_by: int | None


@dataclass(frozen=True)
class Performance:
    id: str
    start: int


@dataclass(frozen=True)
class Show:
    id: str
    name: str
    x: float
    y: float
    duration: int
    arrive_before: int
    preference: int
    performances: tuple


@dataclass(frozen=True)
class Meal:
    id: str
    name: str
    x: float
    y: float
    duration: int
    window: tuple
    preference: int


@dataclass(frozen=True)
class ShortcutSlot:
    """有料の時間短縮利用の枠。acquired=False は「取得できると仮定した未取得の枠」。"""

    id: str
    attraction_id: str
    window: tuple
    residual_wait: int
    price: int
    paid: int
    acquired: bool
    must_use: bool


@dataclass(frozen=True)
class WaitTable:
    key: str
    label: str
    bands: tuple
    waits: dict


@dataclass
class Scenario:
    meta: dict
    cost_basis: str
    entrance: dict
    exit: dict
    walking: dict
    walk_minutes: dict | None
    attractions: dict
    shows: dict
    meals: dict
    wait_tables: dict
    offers: dict
    raw: dict

    def activity_ids(self):
        return list(self.attractions) + list(self.shows) + list(self.meals)


@dataclass
class Problem:
    """シナリオと条件を合わせた、計算用の問題。時刻は 0:00 からの分、費用は円。

    travel は「途中の地点を通り過ぎてもよい」最短の徒歩時間です（座標から計算した場合は元の値と同じ）。
    """

    scenario: Scenario
    conditions: dict
    entry: int
    exit: int
    season: str
    wait_table: WaitTable
    preferences: dict
    travel: dict
    slots: dict
    required: frozenset
    must_use_slots: frozenset
    budget: int
    cost_basis: str
    party_size: int
    allow_new_shortcuts: bool
    shortcut_candidates: tuple | None
    warnings: list

    def activity_ids(self):
        return self.scenario.activity_ids()

    def kind_of(self, activity_id):
        if activity_id in self.scenario.attractions:
            return "attraction"
        if activity_id in self.scenario.shows:
            return "show"
        if activity_id in self.scenario.meals:
            return "meal"
        raise KeyError(activity_id)

    def activity(self, activity_id):
        kind = self.kind_of(activity_id)
        if kind == "attraction":
            return self.scenario.attractions[activity_id]
        if kind == "show":
            return self.scenario.shows[activity_id]
        return self.scenario.meals[activity_id]

    def name_of(self, node_id):
        if node_id == "entrance":
            return self.scenario.entrance["name"]
        if node_id == "exit":
            return self.scenario.exit["name"]
        return self.activity(node_id).name

    def slots_for(self, attraction_id):
        return [slot for slot in self.slots.values() if slot.attraction_id == attraction_id]

    def already_paid(self):
        return sum(slot.paid for slot in self.slots.values() if slot.acquired)


# ---------------------------------------------------------------------------
# 小さな確認用の関数
# ---------------------------------------------------------------------------


class _Checker:
    """誤りを1件ずつためておき、最後にまとめて InputError にする。"""

    def __init__(self):
        self.problems = []

    def add(self, message):
        self.problems.append(message)

    def raise_if_any(self):
        if self.problems:
            raise InputError(self.problems)

    def time(self, value, where):
        try:
            return parse_time(value)
        except ValueError as error:
            self.add(f"{where}: {error}")
            return None

    def window(self, value, where):
        try:
            return parse_window(value)
        except ValueError as error:
            self.add(f"{where}: {error}")
            return None

    def integer(self, value, where, minimum=0):
        if isinstance(value, bool) or not isinstance(value, int):
            self.add(f"{where}: 整数で入力してください（{value!r}）")
            return None
        if value < minimum:
            self.add(f"{where}: {minimum}以上にしてください（{value}）")
            return None
        return value

    def number(self, value, where):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            self.add(f"{where}: 数値で入力してください（{value!r}）")
            return None
        return value

    def dict_items(self, items, where):
        """リストの中の辞書を (番号, 辞書) で返す。リストでない・辞書でない項目は誤りとして記録する。"""
        if items is None:
            return []
        if not isinstance(items, (list, tuple)):
            self.add(f"{where} はリスト（[...]）にしてください")
            return []
        pairs = []
        for index, item in enumerate(items):
            if isinstance(item, dict):
                pairs.append((index, item))
            else:
                self.add(f"{where}[{index}] は辞書（{{...}}）にしてください（{item!r}）")
        return pairs

    def identifier(self, value, where):
        if not isinstance(value, str) or not _ID_PATTERN.match(value):
            self.add(f"{where}: IDは英数字・ハイフン・下線で書いてください（{value!r}）")
            return None
        if value in GATE_NODES:
            self.add(f"{where}: '{value}' は入口・出口用の名前なので、IDに使えません")
            return None
        return value


# ---------------------------------------------------------------------------
# シナリオ（パークのデータ）の読み込み
# ---------------------------------------------------------------------------


def load_scenario(path):
    """JSONファイルからシナリオを読み込む。"""
    path = Path(path)
    with path.open(encoding="utf-8") as file:
        raw = json.load(file)
    return scenario_from_dict(raw)


def scenario_from_dict(raw):
    """シナリオの辞書を確認して Scenario にする。元の辞書は変更しない。"""
    if not isinstance(raw, dict):
        raise InputError(["シナリオは辞書（JSON のオブジェクト）にしてください"])
    raw = copy.deepcopy(raw)
    check = _Checker()
    if raw.get("format_version") != 1:
        check.add("format_version は 1 にしてください")
    meta = _read_meta(raw.get("meta", {}), check)
    cost_basis = raw.get("cost_basis", "per_person")
    if cost_basis not in COST_BASES:
        check.add(f"cost_basis は {COST_BASES} のどれかにしてください（{cost_basis!r}）")
    entrance, exit_gate = _read_gates(raw.get("gates", {}), check)
    walking = _read_walking(raw.get("walking", {}), check)
    attractions = _read_attractions(raw.get("attractions", []), check)
    shows = _read_shows(raw.get("shows", []), check)
    meals = _read_meals(raw.get("meals", []), check)
    _check_unique_ids(attractions, shows, meals, raw, check)
    wait_tables = _read_wait_tables(raw.get("wait_tables", {}), attractions, check)
    offers = _read_offers(raw.get("shortcut_offers", []), attractions, check)
    walk_minutes = raw.get("walk_minutes")
    if walk_minutes is not None and not (
        isinstance(walk_minutes, dict) and all(isinstance(row, dict) for row in walk_minutes.values())
    ):
        check.add("walk_minutes は null か {出発ID: {到着ID: 分}} の辞書にしてください")
    check.raise_if_any()
    scenario = Scenario(
        meta=meta,
        cost_basis=cost_basis,
        entrance=entrance,
        exit=exit_gate,
        walking=walking,
        walk_minutes=walk_minutes,
        attractions=attractions,
        shows=shows,
        meals=meals,
        wait_tables=wait_tables,
        offers=offers,
        raw=raw,
    )
    travel_matrix(scenario)  # 移動時間を計算できるかを、ここで確認しておく
    return scenario


def _read_meta(meta, check):
    if not isinstance(meta, dict):
        check.add("meta は辞書にしてください")
        return {}
    source_type = meta.get("source_type")
    if source_type not in SOURCE_TYPES:
        check.add(f"meta.source_type は {SOURCE_TYPES} のどれかにしてください（{source_type!r}）")
    checked_on = meta.get("checked_on")
    if checked_on is not None and not re.match(r"^\d{4}-\d{2}-\d{2}$", str(checked_on)):
        check.add(f"meta.checked_on は null または 'YYYY-MM-DD' にしてください（{checked_on!r}）")
    assumptions = meta.get("assumptions", [])
    if not isinstance(assumptions, list):
        check.add("meta.assumptions は文字列のリストにしてください")
    return dict(meta)


def _read_gates(gates, check):
    result = []
    for key in GATE_NODES:
        gate = gates.get(key) if isinstance(gates, dict) else None
        if not isinstance(gate, dict):
            check.add(f"gates.{key} がありません")
            result.append({"name": key, "x": 0, "y": 0})
            continue
        result.append(
            {
                "name": str(gate.get("name", key)),
                "x": check.number(gate.get("x"), f"gates.{key}.x"),
                "y": check.number(gate.get("y"), f"gates.{key}.y"),
            }
        )
    return result[0], result[1]


def _read_walking(walking, check):
    if not isinstance(walking, dict):
        check.add("walking は {metres_per_minute, distance} の辞書にしてください")
        walking = {}
    speed = walking.get("metres_per_minute", 60)
    method = walking.get("distance", "manhattan")
    if check.number(speed, "walking.metres_per_minute") is not None and speed <= 0:
        check.add("walking.metres_per_minute は正の数にしてください")
    if method not in DISTANCE_METHODS:
        check.add(f"walking.distance は {DISTANCE_METHODS} のどれかにしてください（{method!r}）")
    return {"metres_per_minute": speed, "distance": method}


def _read_attractions(items, check):
    attractions = {}
    for index, item in check.dict_items(items, "attractions"):
        where = f"attractions[{index}]"
        activity_id = check.identifier(item.get("id"), f"{where}.id")
        queue_open = check.time(item.get("queue_open"), f"{where}.queue_open")
        queue_close = check.time(item.get("queue_close"), f"{where}.queue_close")
        if queue_open is not None and queue_close is not None and queue_open >= queue_close:
            check.add(f"{where}: queue_open は queue_close より前にしてください")
        finish_by = item.get("finish_by")
        if finish_by is not None:
            finish_by = check.time(finish_by, f"{where}.finish_by")
        attraction = Attraction(
            id=activity_id,
            name=str(item.get("name", activity_id)),
            x=check.number(item.get("x"), f"{where}.x"),
            y=check.number(item.get("y"), f"{where}.y"),
            duration=check.integer(item.get("duration_min"), f"{where}.duration_min"),
            preference=check.integer(item.get("preference"), f"{where}.preference"),
            queue_open=queue_open,
            queue_close=queue_close,
            finish_by=finish_by,
        )
        if activity_id is not None:
            if activity_id in attractions:
                check.add(f"{where}: ID '{activity_id}' が重複しています")
            attractions[activity_id] = attraction
    return attractions


def _read_shows(items, check):
    shows = {}
    for index, item in check.dict_items(items, "shows"):
        where = f"shows[{index}]"
        show_id = check.identifier(item.get("id"), f"{where}.id")
        performances = []
        seen = set()
        for number, performance in check.dict_items(item.get("performances", []), f"{where}.performances"):
            place = f"{where}.performances[{number}]"
            performance_id = check.identifier(performance.get("id"), f"{place}.id")
            start = check.time(performance.get("start"), f"{place}.start")
            if performance_id in seen:
                check.add(f"{place}: 公演ID '{performance_id}' が重複しています")
            seen.add(performance_id)
            performances.append(Performance(id=performance_id, start=start))
        if not performances:
            check.add(f"{where}: performances（公演回）を1つ以上入力してください")
        show = Show(
            id=show_id,
            name=str(item.get("name", show_id)),
            x=check.number(item.get("x"), f"{where}.x"),
            y=check.number(item.get("y"), f"{where}.y"),
            duration=check.integer(item.get("duration_min"), f"{where}.duration_min"),
            arrive_before=check.integer(item.get("arrive_before_min"), f"{where}.arrive_before_min"),
            preference=check.integer(item.get("preference"), f"{where}.preference"),
            performances=tuple(performances),
        )
        if show_id is not None:
            if show_id in shows:
                check.add(f"{where}: ID '{show_id}' が重複しています")
            shows[show_id] = show
    return shows


def _read_meals(items, check):
    meals = {}
    for index, item in check.dict_items(items, "meals"):
        where = f"meals[{index}]"
        meal_id = check.identifier(item.get("id"), f"{where}.id")
        meal = Meal(
            id=meal_id,
            name=str(item.get("name", meal_id)),
            x=check.number(item.get("x"), f"{where}.x"),
            y=check.number(item.get("y"), f"{where}.y"),
            duration=check.integer(item.get("duration_min"), f"{where}.duration_min"),
            window=check.window(item.get("window"), f"{where}.window"),
            preference=check.integer(item.get("preference", 0), f"{where}.preference"),
        )
        if meal_id is not None:
            if meal_id in meals:
                check.add(f"{where}: ID '{meal_id}' が重複しています")
            meals[meal_id] = meal
    return meals


def _check_unique_ids(attractions, shows, meals, raw, check):
    seen = {}
    for kind, group in (("attractions", attractions), ("shows", shows), ("meals", meals)):
        for activity_id in group:
            if activity_id in seen:
                check.add(f"ID '{activity_id}' が {seen[activity_id]} と {kind} で重複しています")
            seen[activity_id] = kind
    performance_ids = [p.id for show in shows.values() for p in show.performances]
    duplicated = {pid for pid in performance_ids if performance_ids.count(pid) > 1}
    for performance_id in sorted(duplicated, key=str):
        check.add(f"公演ID '{performance_id}' が複数のショーで使われています")


def _read_wait_tables(tables, attractions, check):
    if not isinstance(tables, dict) or not tables:
        check.add("wait_tables（季節・混雑ごとの待ち時間表）を1つ以上入力してください")
        return {}
    result = {}
    for key, table in tables.items():
        where = f"wait_tables.{key}"
        if not isinstance(table, dict) or not isinstance(table.get("wait_min", {}), dict):
            check.add(f"{where} は {{label, bands, wait_min}} の辞書にしてください")
            continue
        bands = [check.window(band, f"{where}.bands") for band in table.get("bands", [])]
        if not bands:
            check.add(f"{where}: bands（時間帯）を入力してください")
        if None not in bands:
            ordered = sorted(bands)
            for before, after in zip(ordered, ordered[1:]):
                if after[0] < before[1]:
                    check.add(f"{where}: 時間帯 {before} と {after} が重なっています")
        waits = {}
        for attraction_id, values in table.get("wait_min", {}).items():
            if attraction_id not in attractions:
                check.add(f"{where}.wait_min: 施設ID '{attraction_id}' がありません")
                continue
            if not isinstance(values, list) or len(values) != len(bands):
                check.add(f"{where}.wait_min.{attraction_id}: 時間帯と同じ数の値を入力してください")
                continue
            cleaned = []
            for value in values:
                if value is None:
                    cleaned.append(None)
                else:
                    cleaned.append(check.integer(value, f"{where}.wait_min.{attraction_id}"))
            waits[attraction_id] = tuple(cleaned)
        result[key] = WaitTable(key=key, label=str(table.get("label", key)), bands=tuple(bands), waits=waits)
    return result


def _read_offers(items, attractions, check):
    offers = {}
    for index, item in check.dict_items(items, "shortcut_offers"):
        where = f"shortcut_offers[{index}]"
        offer_id = check.identifier(item.get("id"), f"{where}.id")
        attraction_id = item.get("attraction")
        if attraction_id not in attractions:
            check.add(f"{where}: 施設ID '{attraction_id}' がありません")
        offer = ShortcutSlot(
            id=offer_id,
            attraction_id=attraction_id,
            window=check.window(item.get("window"), f"{where}.window"),
            residual_wait=check.integer(item.get("residual_wait_min"), f"{where}.residual_wait_min"),
            price=check.integer(item.get("price_yen"), f"{where}.price_yen"),
            paid=0,
            acquired=False,
            must_use=False,
        )
        if offer_id is not None:
            if offer_id in offers:
                check.add(f"{where}: 枠ID '{offer_id}' が重複しています")
            offers[offer_id] = offer
    return offers


# ---------------------------------------------------------------------------
# CSV フォルダからの読み込み
# ---------------------------------------------------------------------------


def load_scenario_csv(folder):
    """CSV を集めたフォルダからシナリオを読み込む（JSON と同じ確認を行う）。"""
    return scenario_from_dict(scenario_dict_from_csv(folder))


def scenario_dict_from_csv(folder):
    """CSV フォルダを、JSON と同じ形の辞書に変換する。"""
    folder = Path(folder)
    with (folder / "scenario.json").open(encoding="utf-8") as file:
        raw = json.load(file)
    raw.setdefault("format_version", 1)
    raw["attractions"] = [_attraction_from_row(row) for row in _read_csv(folder / "attractions.csv")]
    raw["wait_tables"] = _wait_tables_from_rows(_read_csv(folder / "wait_times.csv"))
    raw["shortcut_offers"] = [_offer_from_row(row) for row in _read_csv(folder / "shortcut_offers.csv", True)]
    raw["shows"] = _shows_from_rows(_read_csv(folder / "shows.csv", True))
    raw["meals"] = [_meal_from_row(row) for row in _read_csv(folder / "meals.csv", True)]
    walk_rows = _read_csv(folder / "walk_minutes.csv", True)
    if walk_rows:
        raw["walk_minutes"] = _walk_minutes_from_rows(walk_rows)
    return raw


def _read_csv(path, optional=False):
    if optional and not path.exists():
        return []
    with path.open(encoding="utf-8-sig", newline="") as file:
        rows = []
        for row in csv.DictReader(file):
            if any((value or "").strip() for value in row.values()):
                rows.append({key.strip(): (value or "").strip() for key, value in row.items() if key})
        return rows


def _number_or_text(text):
    """CSV のセルを数値に変換する。数値でなければ文字列のまま返し、後の確認でエラーにする。"""
    if text == "":
        return None
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        return text


def _attraction_from_row(row):
    return {
        "id": row.get("id"),
        "name": row.get("name"),
        "x": _number_or_text(row.get("x", "")),
        "y": _number_or_text(row.get("y", "")),
        "duration_min": _number_or_text(row.get("duration_min", "")),
        "preference": _number_or_text(row.get("preference", "")),
        "queue_open": row.get("queue_open"),
        "queue_close": row.get("queue_close"),
        "finish_by": row.get("finish_by") or None,
    }


def _wait_tables_from_rows(rows):
    tables = {}
    for row in rows:
        key = row.get("season")
        band_columns = [column for column in row if column not in ("season", "season_label", "attraction_id")]
        table = tables.setdefault(key, {"label": row.get("season_label") or key, "bands": band_columns, "wait_min": {}})
        table["wait_min"][row.get("attraction_id")] = [_number_or_text(row[column]) for column in band_columns]
    return tables


def _offer_from_row(row):
    return {
        "id": row.get("id"),
        "attraction": row.get("attraction_id"),
        "window": f"{row.get('window_start')}-{row.get('window_end')}",
        "price_yen": _number_or_text(row.get("price_yen", "")),
        "residual_wait_min": _number_or_text(row.get("residual_wait_min", "")),
    }


def _shows_from_rows(rows):
    shows = {}
    for row in rows:
        show_id = row.get("show_id")
        show = {
            "id": show_id,
            "name": row.get("show_name"),
            "x": _number_or_text(row.get("x", "")),
            "y": _number_or_text(row.get("y", "")),
            "duration_min": _number_or_text(row.get("duration_min", "")),
            "arrive_before_min": _number_or_text(row.get("arrive_before_min", "")),
            "preference": _number_or_text(row.get("preference", "")),
        }
        if show_id in shows:
            first = {key: value for key, value in shows[show_id].items() if key != "performances"}
            if first != show:
                raise InputError([f"shows.csv: ショー '{show_id}' の行で、公演回以外の列の値がそろっていません"])
        else:
            shows[show_id] = dict(show, performances=[])
        shows[show_id]["performances"].append({"id": row.get("performance_id"), "start": row.get("start")})
    return list(shows.values())


def _meal_from_row(row):
    return {
        "id": row.get("id"),
        "name": row.get("name"),
        "x": _number_or_text(row.get("x", "")),
        "y": _number_or_text(row.get("y", "")),
        "duration_min": _number_or_text(row.get("duration_min", "")),
        "window": f"{row.get('window_start')}-{row.get('window_end')}",
        "preference": _number_or_text(row.get("preference", "")) or 0,
    }


def _walk_minutes_from_rows(rows):
    matrix = {}
    for row in rows:
        matrix.setdefault(row.get("from_id"), {})[row.get("to_id")] = _number_or_text(row.get("minutes", ""))
    return matrix


# ---------------------------------------------------------------------------
# 移動時間
# ---------------------------------------------------------------------------


def node_ids(scenario):
    """移動時間の表に使う地点のID（入口、出口、すべての活動）。"""
    return list(GATE_NODES) + scenario.activity_ids()


def _position(scenario, node_id):
    if node_id == "entrance":
        return scenario.entrance["x"], scenario.entrance["y"]
    if node_id == "exit":
        return scenario.exit["x"], scenario.exit["y"]
    for group in (scenario.attractions, scenario.shows, scenario.meals):
        if node_id in group:
            return group[node_id].x, group[node_id].y
    raise KeyError(node_id)


def walking_minutes(scenario, from_id, to_id):
    """座標から徒歩の分数を計算する（端数は切り上げ）。"""
    (x1, y1), (x2, y2) = _position(scenario, from_id), _position(scenario, to_id)
    if scenario.walking["distance"] == "manhattan":
        distance = abs(x1 - x2) + abs(y1 - y2)
    else:
        distance = math.hypot(x1 - x2, y1 - y2)
    return math.ceil(distance / scenario.walking["metres_per_minute"] - 1e-9)


def travel_matrix(scenario):
    """travel[出発地][到着地] = 徒歩の分数。walk_minutes があればそれを、なければ座標を使う。"""
    nodes = node_ids(scenario)
    given = scenario.walk_minutes
    check = _Checker()
    travel = {}
    for from_id in nodes:
        travel[from_id] = {}
        for to_id in nodes:
            if from_id == to_id:
                travel[from_id][to_id] = 0
            elif given is None:
                travel[from_id][to_id] = walking_minutes(scenario, from_id, to_id)
            else:
                value = given.get(from_id, {}).get(to_id)
                travel[from_id][to_id] = check.integer(value, f"walk_minutes[{from_id}][{to_id}]")
    check.raise_if_any()
    return travel


def shortest_paths(travel):
    """どこを経由してもよい場合の最短移動時間（事前チェックや範囲の絞り込みに使う）。"""
    nodes = list(travel)
    best = {u: dict(travel[u]) for u in nodes}
    for middle in nodes:
        for u in nodes:
            for v in nodes:
                via = best[u][middle] + best[middle][v]
                if via < best[u][v]:
                    best[u][v] = via
    return best


# ---------------------------------------------------------------------------
# 条件と合わせて Problem を作る
# ---------------------------------------------------------------------------


def prepare_problem(scenario, conditions):
    """シナリオと条件を確認し、計算に使う Problem を作る。"""
    if not isinstance(conditions, dict):
        raise InputError(["条件（conditions）は辞書にしてください"])
    check = _Checker()
    conditions = copy.deepcopy(conditions)
    unknown = sorted(set(conditions) - set(CONDITION_KEYS))
    for key in unknown:
        check.add(f"不明な設定項目です: '{key}'（綴りを確認してください）")
    entry = check.time(conditions.get("entry_time"), "entry_time（入園時刻）")
    exit_time = check.time(conditions.get("exit_time"), "exit_time（退園時刻）")
    if entry is not None and exit_time is not None and entry >= exit_time:
        check.add("入園時刻は退園時刻より前にしてください")
    season = conditions.get("season")
    if not isinstance(season, str) or season not in scenario.wait_tables:
        check.add(f"season（季節・混雑）は {list(scenario.wait_tables)} のどれかにしてください（{season!r}）")
    budget = check.integer(conditions.get("budget_yen", 0), "budget_yen（追加費用の予算）")
    cost_basis = conditions.get("cost_basis", "per_person")
    if cost_basis not in COST_BASES:
        check.add(f"cost_basis は {COST_BASES} のどれかにしてください")
    elif cost_basis != scenario.cost_basis:
        check.add(f"条件の cost_basis（{cost_basis}）とデータの cost_basis（{scenario.cost_basis}）が違います")
    party_size = check.integer(conditions.get("party_size", 1), "party_size（人数）", minimum=1)
    allow_new = conditions.get("allow_new_shortcuts", False)
    if not isinstance(allow_new, bool):
        check.add("allow_new_shortcuts は True か False にしてください")
    required = _read_required(scenario, conditions, check)
    preferences = _read_preferences(scenario, conditions, check)
    acquired = _read_acquired(scenario, conditions, check)
    candidates = _read_candidates(scenario, conditions, check)
    rules = conditions.get("purchase_rules") or []
    if not isinstance(rules, (list, tuple)):
        check.add("purchase_rules はリストにしてください（初版では空のまま）")
    elif rules:
        unsupported = [rule for rule in rules if rule not in IMPLEMENTED_PURCHASE_RULES]
        check.add(f"未実装の購入ルールです: {unsupported}（初版では購入ルールを適用しません）")
    check.raise_if_any()

    slots = {}
    if allow_new:
        for offer in scenario.offers.values():
            if candidates is None or offer.attraction_id in candidates:
                slots[offer.id] = offer
    for slot in acquired:
        slots[slot.id] = slot
    must_use = frozenset(slot.id for slot in acquired if slot.must_use)
    required = set(required) | {slot.attraction_id for slot in acquired if slot.must_use}
    problem = Problem(
        scenario=scenario,
        conditions=conditions,
        entry=entry,
        exit=exit_time,
        season=season,
        wait_table=scenario.wait_tables[season],
        preferences=preferences,
        travel=shortest_paths(travel_matrix(scenario)),
        slots=slots,
        required=frozenset(required),
        must_use_slots=must_use,
        budget=budget,
        cost_basis=cost_basis,
        party_size=party_size,
        allow_new_shortcuts=allow_new,
        shortcut_candidates=candidates,
        warnings=data_warnings(scenario, season) + _acquired_warnings(scenario, acquired, entry, exit_time),
    )
    return problem


def _acquired_warnings(scenario, acquired, entry, exit_time):
    """取得済み枠の時間帯が、滞在時間や施設の案内時間から外れていないかを確かめる（注意として表示）。"""
    warnings = []
    for slot in acquired:
        attraction = scenario.attractions[slot.attraction_id]
        if slot.window[1] <= entry or slot.window[0] >= exit_time:
            warnings.append(
                f"取得済み枠 '{slot.id}' の時間帯 {format_window(slot.window)} は、入園から退園までの間にありません"
            )
        elif slot.window[0] < attraction.queue_open or slot.window[1] > attraction.queue_close:
            warnings.append(
                f"取得済み枠 '{slot.id}' の時間帯 {format_window(slot.window)} が、施設 '{attraction.id}' の案内時間"
                f" {format_time(attraction.queue_open)}-{format_time(attraction.queue_close)} の外を含みます"
            )
    return warnings


def _id_list(conditions, key, check):
    values = conditions.get(key, [])
    if values is None:
        return []
    if not isinstance(values, (list, tuple)):
        check.add(f"{key} はIDのリストにしてください")
        return []
    return list(values)


def _read_required(scenario, conditions, check):
    groups = (
        ("required_attractions", scenario.attractions, "施設"),
        ("required_shows", scenario.shows, "ショー"),
        ("required_meals", scenario.meals, "食事・休憩"),
    )
    required = []
    for key, group, label in groups:
        for activity_id in _id_list(conditions, key, check):
            if activity_id not in group:
                check.add(f"{key}: '{activity_id}' は{label}のIDではありません")
            elif activity_id in required:
                check.add(f"{key}: '{activity_id}' が重複しています")
            else:
                required.append(activity_id)
    return required


def _read_preferences(scenario, conditions, check):
    base = {}
    for group in (scenario.attractions, scenario.shows, scenario.meals):
        for activity_id, activity in group.items():
            base[activity_id] = activity.preference
    overrides = conditions.get("preferences") or {}
    rank = conditions.get("preference_rank")
    if overrides and rank:
        check.add("preferences と preference_rank は、どちらか一方だけ指定してください")
        return base
    if rank:
        return _preferences_from_rank(rank, base, check)
    if not isinstance(overrides, dict):
        check.add("preferences は {ID: 希望度} の辞書にしてください")
        return base
    for activity_id, value in overrides.items():
        if activity_id not in base:
            check.add(f"preferences: '{activity_id}' という活動はありません")
        elif check.integer(value, f"preferences['{activity_id}']") is not None:
            base[activity_id] = value
    return base


def _preferences_from_rank(rank, base, check):
    """順位から希望度を作る: n件のうち1位は n、2位は n-1 …、一覧にないものは 0。"""
    if not isinstance(rank, (list, tuple)) or len(set(rank)) != len(rank):
        check.add("preference_rank は重複のないIDのリストにしてください")
        return base
    preferences = {activity_id: 0 for activity_id in base}
    for position, activity_id in enumerate(rank):
        if activity_id not in base:
            check.add(f"preference_rank: '{activity_id}' という活動はありません")
        else:
            preferences[activity_id] = len(rank) - position
    return preferences


def _read_acquired(scenario, conditions, check):
    slots = []
    items = conditions.get("acquired_shortcuts") or []
    must_use_attractions = set()
    for index, item in check.dict_items(items, "acquired_shortcuts"):
        where = f"acquired_shortcuts[{index}]"
        slot_id = check.identifier(item.get("id"), f"{where}.id")
        if slot_id in scenario.offers or slot_id in [slot.id for slot in slots]:
            check.add(f"{where}: 枠ID '{slot_id}' が他の枠と重複しています")
        attraction_id = item.get("attraction")
        if attraction_id not in scenario.attractions:
            check.add(f"{where}: 施設ID '{attraction_id}' がありません")
        must_use = item.get("must_use")
        if not isinstance(must_use, bool):
            check.add(f"{where}.must_use（必ず使うなら True、使うかどうかを任せるなら False）を指定してください")
        elif must_use:
            if attraction_id in must_use_attractions:
                check.add(f"{where}: 同じ施設に「必ず使う」取得済み枠が複数あります（施設は1回までの利用です）")
            must_use_attractions.add(attraction_id)
        slots.append(
            ShortcutSlot(
                id=slot_id,
                attraction_id=attraction_id,
                window=check.window(item.get("window"), f"{where}.window"),
                residual_wait=check.integer(item.get("residual_wait_min"), f"{where}.residual_wait_min"),
                price=0,
                paid=check.integer(item.get("paid_yen", 0), f"{where}.paid_yen"),
                acquired=True,
                must_use=must_use is True,
            )
        )
    return slots


def _read_candidates(scenario, conditions, check):
    candidates = conditions.get("shortcut_candidates")
    if candidates is None:
        return None
    if not isinstance(candidates, (list, tuple)):
        check.add("shortcut_candidates は None か施設IDのリストにしてください")
        return None
    for attraction_id in candidates:
        if attraction_id not in scenario.attractions:
            check.add(f"shortcut_candidates: '{attraction_id}' は施設のIDではありません")
    return tuple(candidates)


def data_warnings(scenario, season):
    """計算は続けられるが、確認したほうがよい点を返す。"""
    warnings = []
    table = scenario.wait_tables[season]
    for attraction in scenario.attractions.values():
        if attraction.id not in table.waits:
            warnings.append(f"待ち時間表「{table.label}」に施設 '{attraction.id}' がないため、通常利用はできません")
            continue
        uncovered = _uncovered_minutes(attraction, table)
        if uncovered:
            warnings.append(
                f"施設 '{attraction.id}' の案内時間のうち {uncovered} 分は待ち時間表に値がないため、通常利用できません"
            )
    travel = travel_matrix(scenario)
    shortest = shortest_paths(travel)
    for u in travel:
        for v in travel:
            if shortest[u][v] < travel[u][v]:
                warnings.append(
                    f"移動時間 {u}→{v} の {travel[u][v]} 分より、別の地点を通る道のほうが短いため、"
                    f"{shortest[u][v]} 分として計算します"
                )
    for offer in scenario.offers.values():
        attraction = scenario.attractions[offer.attraction_id]
        if offer.window[0] < attraction.queue_open or offer.window[1] > attraction.queue_close:
            warnings.append(
                f"短縮利用の枠 '{offer.id}' の時間帯が、施設 '{attraction.id}' の案内時間"
                f" {format_time(attraction.queue_open)}-{format_time(attraction.queue_close)} の外を含みます"
            )
    return warnings


def _uncovered_minutes(attraction, table):
    """案内時間 [queue_open, queue_close) のうち、待ち時間の値がない分数。"""
    covered = 0
    for band, wait in zip(table.bands, table.waits[attraction.id]):
        if wait is None:
            continue
        start = max(band[0], attraction.queue_open)
        end = min(band[1], attraction.queue_close)
        covered += max(0, end - start)
    return (attraction.queue_close - attraction.queue_open) - covered
