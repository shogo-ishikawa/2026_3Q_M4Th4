"""python -m vocal_lab.cli でNotebookと同じ解析を実行します。"""
import argparse
import json
import sys

from .audio import AudioInputError
from .pipeline import run_analysis


def main(argv=None):
    parser = argparse.ArgumentParser(description="歌声の音量変動を調べるVocal Fluctuation Lab")
    parser.add_argument("source", help="音声ファイルのパス、またはYouTube動画1本のURL")
    parser.add_argument("--start", type=float, default=0.0, help="開始秒（0以上）")
    parser.add_argument("--end", type=float, required=True, help="終了秒（解析区間は10〜180秒）")
    parser.add_argument("--output", default="outputs", help="解析ごとに専用フォルダを作る出力先")
    parser.add_argument("--youtube", action="store_true", help="YouTube URLから指定区間を取得する")
    parser.add_argument("--already-vocals", action="store_true", help="入力が歌声のみの場合に限り、歌声分離を省略する")
    parser.add_argument("--device", choices=["auto", "cpu", "cuda", "mps"], default="auto")
    args = parser.parse_args(argv)
    try:
        result = run_analysis(args.source, args.start, args.end, args.output,
                              source_kind="youtube" if args.youtube else "file",
                              already_vocals=args.already_vocals, device=args.device, progress=print)
    except (AudioInputError, ValueError) as error:
        print(f"解析できませんでした: {error}", file=sys.stderr)
        return 2
    print(json.dumps({"status": result["analysis"]["status"],
                      "summary": result["analysis"]["summary"],
                      "result_path": result["result_path"], "vocals_path": result["vocals_path"]},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
