#!/usr/bin/env python3
"""Refresh official food links and a few menu names for the public park catalogue.

Python 3.12 standard library. The venue's own link is followed; menu URLs and
food names are never inferred from a venue ID. Images and descriptions are not copied.
"""
from __future__ import annotations
import argparse
import concurrent.futures
import datetime as dt
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import tempfile
import time
import urllib.parse
import urllib.request

PROJECT = Path(__file__).resolve().parents[1]
FOOD = {"restaurant", "cafe", "snack", "popcorn"}
OFFICIAL_HOST = "www.tokyodisneyresort.jp"


def official_url(value: str, base: str) -> str:
    """Only follow public HTTPS links on the source website."""
    url = urllib.parse.urljoin(base, value)
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != OFFICIAL_HOST or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("Official restaurant URL required")
    return url


def clean_text(value: str) -> str:
    return " ".join(value.split()).strip()


class MenuParser(HTMLParser):
    def __init__(self, base: str):
        super().__init__(convert_charrefs=True)
        self.base = base
        self.links = []
        self.items = []
        self.section = ""
        self.heading = None
        self.anchor = None

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag in {"h2", "h3"}:
            self.heading = {"tag": tag, "text": []}
        if tag == "a":
            try:
                url = official_url(attrs.get("href", ""), self.base)
            except ValueError:
                url = None
            self.anchor = {"url": url, "text": [], "section": self.section, "name": ""}

    def handle_data(self, data):
        if self.heading:
            self.heading["text"].append(data)
        if self.anchor:
            self.anchor["text"].append(data)

    def handle_endtag(self, tag):
        if self.heading and tag == self.heading["tag"]:
            title = clean_text(" ".join(self.heading["text"]))
            if tag == "h2":
                self.section = title
            elif self.anchor:
                self.anchor["name"] = title
            self.heading = None
        if tag == "a" and self.anchor:
            item = self.anchor
            item["text"] = clean_text(" ".join(item["text"]))
            if item["url"]:
                self.links.append(item)
                if item["name"] and re.fullmatch(r"/food/\d+/", urllib.parse.urlsplit(item["url"]).path):
                    self.items.append(item)
            self.anchor = None


def parse_menu_link(source: str, venue_url: str) -> str:
    parsed = MenuParser(venue_url)
    parsed.feed(source)
    for link in parsed.links:
        if link["text"] == "店舗メニュー" and re.search(r"/restaurant/food/\d+/", link["url"]):
            return link["url"]
    raise ValueError("Official venue page has no menu link")


def on_sale(item: dict, date: str) -> bool:
    text = item["text"]
    if "[販売期間]" not in text:
        return True
    dates = re.findall(r"(\d{4})年(\d{1,2})月(\d{1,2})日", text.split("[販売期間]", 1)[1])
    values = [f"{int(y):04d}-{int(m):02d}-{int(d):02d}" for y, m, d in dates]
    if values and date < values[0]:
        return False
    return not (len(values) > 1 and date > values[1])


def menu_score(item: dict, category: str) -> int:
    name, section = item["name"], item["section"]
    if any(word in name for word in ("スーベニア", "バケット", "ポップコーンケース", "トング", "シーズニング", "トッピング")):
        return -100
    if category == "popcorn":
        return (100 if "レギュラーボックス" in name else 40) if "ポップコーン" in name else -100
    main = ("カレー", "カリー", "パスタ", "ピッツァ", "ピザ", "サンド", "バーガー", "ヌードル", "麺", "アントレ", "メイン", "プレート", "コンボ", "お食事", "ワッフル", "オムライス", "まん", "チュロス", "チキン", "ソーセージ", "パイ", "ギョウザ", "膳", "重", "ライスボウル", "スナックボックス", "ブレッド")
    # A sauce-only topping is not a representative meal; a waffle with maple
    # sauce is still food and must not be discarded just because its name contains sauce.
    if name.endswith("ソース") and not any(word in name for word in main if word != "パイ"):
        return -100
    if any(word in name for word in ("ドリンク", "コーヒー", "ラッシー", "ソーダ", "ワイン", "ビール", "カクテル", "ティー")):
        return 10
    if "お子様" in name or name == "だしセット":
        return 25
    if "飲み比べ" in name:
        return 10
    if "セット" in name or "コース" in name:
        return 95
    if any(word in section for word in main):
        return 90
    if any(word in name for word in main):
        return 85
    if name in ("ライス", "パン"):
        return 20
    if "スナックケース" in name:
        return 15
    if "スナック" in section:
        return 75
    if "スペシャルメニュー" in section:
        return 65
    if any(word in section for word in ("ドリンク", "アルコール", "デザート", "スイーツ", "スウィーツ", "サイド")):
        return 20
    return 45


def parse_menu_items(source: str, menu_url: str, category: str, date: str) -> list[dict]:
    parser = MenuParser(menu_url)
    parser.feed(source)
    candidates = [(i, item) for i, item in enumerate(parser.items) if on_sale(item, date) and menu_score(item, category) >= 0]
    candidates.sort(key=lambda pair: (-menu_score(pair[1], category), pair[0]))
    items, seen = [], set()
    for _, item in candidates:
        name = item["name"]
        flavours = re.findall(r"#\s*([^#]+?味)(?:\s|$)", item["text"])
        if category == "popcorn" and flavours:
            name = "ポップコーン（" + "・".join(dict.fromkeys(flavours)) + "）"
        if name in seen:
            continue
        seen.add(name)
        items.append({"name": name[:180], "url": item["url"]})
        if len(items) == 3:
            break
    return items


def fetch_text(url: str, timeout: float = 12) -> str:
    url = official_url(url, url)
    request = urllib.request.Request(url, headers={"User-Agent": "ParkItineraryLab/1.3 (educational official menu link updater)"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        official_url(response.url, url)
        return response.read(3_000_000).decode("utf-8")


def refresh_food(activity: dict, date: str, fetcher=fetch_text) -> dict:
    venue_url = official_url(activity["sourceUrl"], activity["sourceUrl"])
    menu_url = parse_menu_link(fetcher(venue_url), venue_url)
    items = parse_menu_items(fetcher(menu_url), menu_url, activity["category"], date)
    return {"menuUrl": menu_url, "menuItems": items, "menuCheckedOn": date, "menuSourceUrl": menu_url, "menuStatus": "verified"}


def update_catalogue(catalogue: dict, date: str, *, workers: int = 8, fetcher=fetch_text) -> tuple[dict, dict]:
    """Merge only menu fields; on failure retain the last successful observation."""
    items = [activity for park in catalogue["parks"] for activity in park["activities"] if activity.get("category") in FOOD]
    report = {"checkedOn": date, "checked": len(items), "updated": 0, "errors": []}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(refresh_food, activity, date, fetcher): activity for activity in items}
        for future in concurrent.futures.as_completed(futures):
            activity = futures[future]
            try:
                activity.update(future.result())
                report["updated"] += 1
            except (OSError, ValueError, KeyError, UnicodeError) as error:
                if "menuUrl" not in activity:
                    activity.update({"menuUrl": activity["sourceUrl"], "menuItems": [], "menuStatus": "unavailable"})
                report["errors"].append({"activityId": activity["id"], "reason": str(error)[:250]})
    catalogue["foodMenuUpdate"] = report
    return catalogue, report


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as target:
        temporary = Path(target.name)
        json.dump(value, target, ensure_ascii=False, indent=2)
        target.write("\n")
    os.replace(temporary, path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalogue", type=Path, default=PROJECT / "web/data/parks.json")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--date", default=dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date().isoformat())
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    if dt.date.fromisoformat(args.date).isoformat() != args.date or not 1 <= args.workers <= 12:
        parser.error("Use YYYY-MM-DD and 1–12 workers")
    started = time.monotonic()
    result, report = update_catalogue(json.loads(args.catalogue.read_text(encoding="utf-8")), args.date, workers=args.workers)
    atomic_json(args.output, result)
    print(f"Food menus: {report['updated']}/{report['checked']} verified, {len(report['errors'])} failed, {time.monotonic()-started:.1f}s")
    for error in report["errors"]:
        print(error["activityId"], error["reason"])


if __name__ == "__main__":
    main()
