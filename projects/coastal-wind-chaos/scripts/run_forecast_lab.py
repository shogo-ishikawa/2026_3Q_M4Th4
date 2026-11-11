"""Colabと同じ解析をコマンドから実行する。"""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from coastal_wind_chaos.forecast_app import MODES, run_analysis


def main():
    parser = argparse.ArgumentParser(description="海岸の風速・風向予報ラボ")
    parser.add_argument("--mode", choices=MODES, default="demo")
    parser.add_argument("--data", nargs="*", default=[])
    parser.add_argument("--options", type=Path, help="解析条件のJSONファイル")
    parser.add_argument("--output", type=Path, default=Path("results/forecast-lab"))
    args = parser.parse_args()
    options = json.loads(args.options.read_text(encoding="utf-8")) if args.options else {}
    result = run_analysis(args.mode, args.data, options, args.output)
    for message in result["metadata"].get("messages", []):
        print(message)
    print(result["summary"].to_string(index=False))
    print("結果ZIP:", result["zip_path"])


if __name__ == "__main__":
    main()
