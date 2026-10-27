"""時刻の表記を変換する小さな関数。

入力では "09:30" のような「時:分」の文字列を使います。
計算では、0:00 からの経過分（整数）を使います。例: 9:30 → 570。
時間帯は "10:00-11:00" のように書き、開始を含み終了を含まない [開始, 終了) として扱います。
"""

import re

_TIME_PATTERN = re.compile(r"^(\d{1,2}):(\d{2})$")


def parse_time(value):
    """"09:30" を 570（0:00 からの分）に変換する。整数はそのまま分として扱う。"""
    if isinstance(value, bool):
        raise ValueError(f"時刻として解釈できません: {value!r}")
    if isinstance(value, int):
        if value < 0:
            raise ValueError(f"時刻（分）は0以上にしてください: {value}")
        return value
    if not isinstance(value, str):
        raise ValueError(f"時刻は 'HH:MM' の文字列で入力してください: {value!r}")
    match = _TIME_PATTERN.match(value.strip())
    if match is None:
        raise ValueError(f"時刻は 'HH:MM' の形式で入力してください: {value!r}")
    hours = int(match.group(1))
    minutes = int(match.group(2))
    if hours > 47 or minutes > 59:
        raise ValueError(f"時刻の値が範囲外です: {value!r}")
    return hours * 60 + minutes


def format_time(minutes):
    """570 を "09:30" に変換する。"""
    if minutes is None:
        return ""
    minutes = int(minutes)
    sign = "-" if minutes < 0 else ""
    minutes = abs(minutes)
    return f"{sign}{minutes // 60:02d}:{minutes % 60:02d}"


def parse_window(value):
    """"10:00-11:00" を (600, 660) に変換する。[開始, 終了) の意味で、開始 < 終了 が必要。"""
    if isinstance(value, str):
        parts = value.split("-")
        if len(parts) != 2:
            raise ValueError(f"時間帯は 'HH:MM-HH:MM' の形式で入力してください: {value!r}")
        start, end = parse_time(parts[0].strip()), parse_time(parts[1].strip())
    elif isinstance(value, dict):
        start, end = parse_time(value.get("start")), parse_time(value.get("end"))
    elif isinstance(value, (list, tuple)) and len(value) == 2:
        start, end = parse_time(value[0]), parse_time(value[1])
    else:
        raise ValueError(f"時間帯として解釈できません: {value!r}")
    if start >= end:
        raise ValueError(f"時間帯の開始は終了より前にしてください: {value!r}")
    return start, end


def format_window(window):
    """(600, 660) を "10:00-11:00" に変換する。"""
    if window is None:
        return ""
    return f"{format_time(window[0])}-{format_time(window[1])}"


def in_window(minute, window):
    """minute が [開始, 終了) に入っていれば True。終了ちょうどは含まない。"""
    return window[0] <= minute < window[1]
