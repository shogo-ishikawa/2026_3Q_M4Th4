"""公開ページのグラフ用データを共通の解析コードで作ります。"""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vocal_lab.examples import demo_result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("web/data"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for kind in ("white", "pink", "brown"):
        result = demo_result(kind)
        (args.output / f"demo-{kind}.json").write_text(
            json.dumps(result, ensure_ascii=False, allow_nan=False), encoding="utf-8"
        )
        print(kind, result["status"], result["fit"].get("slope"))


if __name__ == "__main__":
    main()
