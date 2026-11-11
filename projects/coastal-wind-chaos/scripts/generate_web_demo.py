"""Webの表示例を、Colabと共通の解析コードから生成する。実観測は使わない。"""

import argparse
import json
from pathlib import Path
import sys

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / "src"))

from coastal_wind_chaos import __version__, sample_data
from coastal_wind_chaos import forecast_lab as lab
from coastal_wind_chaos import forecast_diagnostics as diagnostics


def records(table):
    """空欄をnullとして書き出す。NaNというJavaScript独自の値は保存しない。"""
    return json.loads(table.to_json(orient="records", double_precision=12, force_ascii=False))


def generate(output):
    weather = sample_data.generate_weather(years=3, seed=2026)
    weather.attrs["station"] = "仮想海辺観測点（合成）"
    weather.attrs["source_kind"] = "synthetic"
    result = lab.run_backtest(weather, horizons=(1, 3, 6, 12, 24), seed=2026)
    predictions = result["predictions"]
    metadata = {"schema_version": "1.0.0", "timezone": "Asia/Tokyo", "source_kind": "synthetic",
                "mode": "demo", "station": weather.attrs["station"], "analysis_version": __version__,
                "description": "教材が生成した仮想の海辺のデータです。特定の観測所の実測・精度ではありません。",
                "data_start": str(weather.index.min()), "data_end": str(weather.index.max()),
                "split": {key: str(value) for key, value in result["split"].items()},
                "selection": {str(key): value for key, value in result["selection"].items()},
                "seed": 2026}
    payload = {"metadata": metadata, "summary": records(diagnostics.summarise_errors(predictions)),
               "skill": records(diagnostics.skill_against_baseline(predictions, n_bootstrap=200, seed=2026)),
               "grouped": {by: records(diagnostics.grouped_errors(predictions, by=by))
                           for by in ("month", "hour", "direction", "speed_band")}}
    target = Path(output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("/* Colabと同じPython解析で生成した合成データの例。 */\n"
                      + "window.COASTAL_WIND_DEMO = "
                      + json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                      + ";\n", encoding="utf-8")
    print(f"Generated {target.name}: {len(payload['summary'])} summary rows ({target.stat().st_size:,} bytes)")
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=PROJECT / "web" / "demo-data.js")
    generate(parser.parse_args().output)
