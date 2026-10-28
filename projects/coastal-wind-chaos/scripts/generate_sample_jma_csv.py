"""南側に海がある仮想観測点の合成データを、気象庁形式のCSVで作るCLI。

作品フォルダ（projects/coastal-wind-chaos/）で実行する例：
    python scripts/generate_sample_jma_csv.py
    python scripts/generate_sample_jma_csv.py --preset periodic_only --output data/periodic_only.csv
    python scripts/generate_sample_jma_csv.py --set ar_strength=2.0 --set front_precursor_hours=0 --output data/strong_ar.csv

できるCSVは合成データで、気象庁の観測値ではありません。
"""

import argparse
import ast
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR / "src"))  # インストールしていなくても読み込めるようにする

from coastal_wind_chaos import sample_data  # noqa: E402


def parse_setting(text):
    """「名前=値」を (名前, 値) に分ける。値は数や True/False なら変換する。"""
    name, separator, value = text.partition("=")
    if not separator:
        raise argparse.ArgumentTypeError("--set は 名前=値 の形で指定してください（例：ar_strength=2.0）")
    try:
        value = ast.literal_eval(value)
    except (ValueError, SyntaxError):
        pass  # 文字列のまま使う
    return name.strip(), value


def parse_args():
    parser = argparse.ArgumentParser(
        description="南側に海がある仮想観測点の合成データを、気象庁形式のCSVで作ります（気象庁の観測値ではありません）。")
    parser.add_argument("--output", type=Path, default=PROJECT_DIR / "data" / "sample_coastal_amedas.csv",
                        help="出力するCSV（既定：data/sample_coastal_amedas.csv）")
    parser.add_argument("--preset", default="default", choices=list(sample_data.PRESETS),
                        help="成分の組み合わせ（既定：default）")
    parser.add_argument("--seed", type=int, help="乱数の種（既定：2026）")
    parser.add_argument("--years", type=int, help="何年分作るか（既定：3）")
    parser.add_argument("--start", help="最初の日（既定：2023-01-01）")
    parser.add_argument("--truth-output", type=Path,
                        help="観測誤差を含まない真の状態と成分の内訳を保存するCSV（任意）")
    parser.add_argument("--set", dest="changes", action="append", default=[], type=parse_setting,
                        metavar="名前=値", help="そのほかの設定を変える（何回でも指定できる）")
    parser.add_argument("--encoding", default="cp932", help="文字コード（既定：気象庁と同じ cp932）")
    return parser.parse_args()


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # 出力をファイルに書き出しても、日本語で失敗しないようにする
    args = parse_args()
    changes = dict(args.changes)
    for name in ["seed", "years", "start"]:
        if getattr(args, name) is not None:
            changes[name] = getattr(args, name)
    settings = sample_data.generate_sample_csv(args.output, args.preset, args.truth_output,
                                               args.encoding, **changes)
    print("合成データを作りました（気象庁の観測値ではありません）。")
    print(f"  出力: {args.output}")
    if args.truth_output is not None:
        print(f"  真の状態と成分: {args.truth_output}")
    print(f"  プリセット: {args.preset}（{sample_data.PRESET_LABELS[args.preset]}）")
    for name, value in settings.items():
        print(f"  {name} = {value}")


if __name__ == "__main__":
    main()
