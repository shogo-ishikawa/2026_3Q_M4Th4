"""音源を小さな区間へ切り出し、必要なら歌声を分離します。"""
from __future__ import annotations

import importlib.metadata
import math
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import parse_qs, urlparse

import numpy as np
import soundfile as sf

MIN_SECONDS = 10.0
MAX_SECONDS = 180.0
SAMPLE_RATE = 44100
MODEL_NAME = "htdemucs"


class AudioInputError(ValueError):
    """入力や外部ツールの失敗を、画面に説明できる形で伝えます。"""


def validate_interval(start_seconds, end_seconds, duration_seconds=None):
    """秒数を確認します。指定区間を黙って短くすることはありません。"""
    values = (start_seconds, end_seconds)
    if any(isinstance(value, bool) for value in values):
        raise AudioInputError("開始秒と終了秒には数値を入力してください。")
    try:
        start, end = map(float, values)
    except (TypeError, ValueError) as error:
        raise AudioInputError("開始秒と終了秒には数値を入力してください。") from error
    if not all(math.isfinite(value) for value in (start, end)):
        raise AudioInputError("開始秒と終了秒には有限の数値を入力してください。")
    if start < 0 or end <= start:
        raise AudioInputError("0秒以上の開始秒と、それより後の終了秒を指定してください。")
    if not MIN_SECONDS <= end - start <= MAX_SECONDS:
        raise AudioInputError(f"解析区間は{MIN_SECONDS:g}〜{MAX_SECONDS:g}秒にしてください。判定には60秒以上を勧めます。")
    if duration_seconds is not None:
        if not math.isfinite(duration_seconds) or duration_seconds <= 0:
            raise AudioInputError("音源の長さを確認できません。有限の長さの音声ファイルを使ってください。")
        if end > duration_seconds + 0.001:
            raise AudioInputError(f"終了秒が音源の長さ（{duration_seconds:.2f}秒）を超えています。")
    return start, end


def require_tool(name):
    path = shutil.which(name)
    if path is None:
        raise AudioInputError(f"{name}がありません。準備セルを実行するか、FFmpegを導入してください。")
    return path


def _run(command, purpose, timeout=180):
    """シェルを介さず実行し、失敗時も原因を消しません。"""
    try:
        completed = subprocess.run(command, text=True, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as error:
        raise AudioInputError(f"{purpose}が時間内に終わりませんでした。区間を短くして再試行してください。") from error
    if completed.returncode != 0:
        detail = completed.stdout[-1800:].strip()
        raise AudioInputError(f"{purpose}に失敗しました。\n{detail}")
    return completed.stdout


def probe_duration(path):
    source = Path(path).expanduser().resolve()
    if not source.is_file():
        raise AudioInputError("音源ファイルが見つかりません。アップロードしたファイルを選んでください。")
    output = _run([require_tool("ffprobe"), "-v", "error", "-show_entries", "format=duration",
                   "-of", "default=noprint_wrappers=1:nokey=1", str(source)], "音源の長さの確認")
    try:
        duration = float(output.strip())
    except ValueError as error:
        raise AudioInputError("音源の長さを読み取れません。別の音声形式で試してください。") from error
    if not math.isfinite(duration) or duration <= 0:
        raise AudioInputError("有限の長さの音源を使ってください。")
    return duration


def extract_clip(source, destination, start_seconds, end_seconds):
    """選択された音だけを44100Hz・ステレオの非圧縮WAVへ変換します。"""
    start, end = float(start_seconds), float(end_seconds)
    if not all(math.isfinite(value) for value in (start, end)) or start < 0 or end <= start:
        raise AudioInputError("切り出す秒数が正しくありません。")
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if source == destination:
        raise AudioInputError("元音源と出力先は別のファイルにしてください。")
    if destination.exists():
        raise AudioInputError("出力先が既に存在します。別の作業フォルダを使ってください。")
    destination.parent.mkdir(parents=True, exist_ok=True)
    _run([require_tool("ffmpeg"), "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
          "-ss", f"{start:.9f}", "-i", str(source), "-t", f"{end - start:.9f}",
          "-map", "0:a:0", "-vn", "-ac", "2", "-ar", str(SAMPLE_RATE),
          "-c:a", "pcm_f32le", str(destination)], "音源区間の切り出し")
    actual = probe_duration(destination)
    if abs(actual - (end - start)) > 0.05:
        destination.unlink(missing_ok=True)
        raise AudioInputError("指定区間を最後まで読み取れませんでした。終了秒と音源を確認してください。")
    return destination


def canonical_youtube_url(url):
    """動画1本のURLだけを受け付け、再生リストなどの付加情報を外します。"""
    if not isinstance(url, str):
        raise AudioInputError("YouTube動画のURLを入力してください。")
    try:
        parsed = urlparse(url.strip())
        port = parsed.port
    except ValueError as error:
        raise AudioInputError("YouTube動画1本の正しいURLを入力してください。") from error
    hosts = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"}
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in hosts or parsed.username or parsed.password or port not in (None, 80, 443):
        raise AudioInputError("YouTube動画1本のURLを入力してください。音声ファイルのアップロードも使えます。")
    video_id = ""
    if parsed.hostname in {"youtu.be", "www.youtu.be"}:
        video_id = parsed.path.strip("/")
    elif parsed.path == "/watch":
        video_id = parse_qs(parsed.query).get("v", [""])[0]
    else:
        parts = parsed.path.strip("/").split("/")
        if len(parts) == 2 and parts[0] in {"shorts", "embed", "live"}:
            video_id = parts[1]
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise AudioInputError("再生リストではなく、動画1本のURLを入力してください。")
    return f"https://www.youtube.com/watch?v={video_id}"


def download_youtube_section(url, start_seconds, end_seconds, directory, padding_seconds=2.0):
    """選択区間と前後の短い余白だけを取得します。取得失敗時は迂回しません。"""
    canonical = canonical_youtube_url(url)
    start, end = validate_interval(start_seconds, end_seconds)
    require_tool("ffmpeg")
    try:
        import yt_dlp
        from yt_dlp.utils import download_range_func
    except ImportError as error:
        raise AudioInputError("yt-dlpがありません。先に準備セルを実行してください。") from error
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    base_options = {"format": "bestaudio/best", "noplaylist": True, "quiet": True,
                    "no_warnings": False, "socket_timeout": 30, "retries": 2,
                    "fragment_retries": 2, "max_filesize": 500 * 1024 * 1024}
    # yt-dlpの公式JavaScript対応を使います。既存の実行環境だけを選び、
    # ここから外部スクリプトや認証情報を追加取得することはありません。
    runtimes = {name: {"path": path} for name in ("deno", "node") if (path := shutil.which(name))}
    if runtimes:
        base_options["js_runtimes"] = runtimes
    try:
        with yt_dlp.YoutubeDL(base_options) as downloader:
            info = downloader.extract_info(canonical, download=False)
        if not isinstance(info, dict) or info.get("_type") in {"playlist", "multi_video"}:
            raise AudioInputError("動画1本のURLを使ってください。")
        if info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming", "post_live"}:
            raise AudioInputError("ライブ配信は使えません。公開済みの通常の動画か音声ファイルを使ってください。")
        duration = info.get("duration")
        if not isinstance(duration, (int, float)) or isinstance(duration, bool):
            raise AudioInputError("動画の長さを確認できません。音声ファイルをアップロードしてください。")
        validate_interval(start, end, float(duration))
        context_start = max(0.0, start - padding_seconds)
        context_end = min(float(duration), end + padding_seconds)
        options = dict(base_options, outtmpl=str(directory / "download.%(ext)s"),
                       download_ranges=download_range_func(None, [(context_start, context_end)]),
                       force_keyframes_at_cuts=True)
        with yt_dlp.YoutubeDL(options) as downloader:
            downloaded = downloader.extract_info(canonical, download=True)
        paths = [Path(item["filepath"]) for item in downloaded.get("requested_downloads", []) if item.get("filepath")]
        paths += [path for path in directory.glob("download.*") if path.suffix not in {".part", ".ytdl"}]
        path = next((path for path in paths if path.is_file()), None)
        if path is None:
            raise AudioInputError("取得した音声ファイルを確認できません。アップロードで試してください。")
        return {"path": path, "context_start_seconds": context_start,
                "context_end_seconds": context_end, "source_duration_seconds": float(duration),
                "source_url": canonical}
    except AudioInputError:
        raise
    except Exception as error:
        raise AudioInputError("YouTubeから取得できませんでした。地域・配信元・YouTube側の制限などが考えられます。"
                              "権利を確認した音声ファイルのアップロードを使ってください。\n"
                              + str(error)[-600:]) from error


def separate_vocals(audio_path, output_dir, device="auto", progress=None):
    """Demucsの学習済みモデルで歌声を推定します。分離精度の保証はしません。"""
    if device not in {"auto", "cpu", "cuda", "mps"}:
        raise AudioInputError("処理装置はauto・cpu・cuda・mpsのいずれかにしてください。")
    try:
        version = importlib.metadata.version("demucs")
    except importlib.metadata.PackageNotFoundError as error:
        raise AudioInputError("Demucsがありません。準備セルを実行してください。既に歌声のみの音源なら分離を省略できます。") from error
    if progress:
        progress("歌声を抽出しています。初回はモデルの取得に時間がかかります。")
    command = [sys.executable, "-m", "demucs.separate", "--two-stems", "vocals", "--other-method", "none",
               "-n", MODEL_NAME, "--float32", "--clip-mode", "none", "--shifts", "0",
               "-o", str(Path(output_dir).resolve())]
    if device != "auto":
        command += ["-d", device]
    command += [str(Path(audio_path).resolve())]
    _run(command, "歌声の抽出（GPUメモリが不足する場合はcpuを選んでください）", timeout=1800)
    vocals = Path(output_dir).resolve() / MODEL_NAME / Path(audio_path).stem / "vocals.wav"
    if not vocals.is_file():
        raise AudioInputError("Demucsの出力に歌声音源がありません。入力音源と準備セルを確認してください。")
    return vocals, version


def load_audio(path):
    """ステレオを保ったまま読みます。逆位相の歌声も打ち消しません。"""
    samples, sample_rate = sf.read(path, dtype="float64", always_2d=True)
    if samples.size == 0 or not np.isfinite(samples).all():
        raise AudioInputError("音源が空か、数値として読み取れないデータを含んでいます。")
    return samples, sample_rate
