"""楽曲解析用の入力を開き、YouTubeから取得した一時音源を片付けます。"""

import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

try:
    import fcntl  # Colab/Linux・macOSのプロセス間ロック
except ImportError:  # Windowsでは安全のため別の実行のフォルダを掃除しない
    fcntl = None


class SongSourceError(RuntimeError):
    """音源の入力や取得に失敗したときのエラーです。"""


_VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")
_RUN_NAME = re.compile(r"run-[0-9a-f]{32}")
_YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}


def normalise_youtube_url(url: str) -> str:
    """単一動画のYouTube URLを検証し、動画IDだけを含むHTTPS URLに直します。"""
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        raise SongSourceError("YouTube URLの形式を確認してください。") from None
    host = parts.netloc.lower()
    video_id = ""
    if parts.scheme in {"http", "https"}:
        if host == "youtu.be":
            video_id = parts.path.removeprefix("/").removesuffix("/")
        elif host in _YOUTUBE_HOSTS:
            if parts.path == "/watch":
                ids = parse_qs(parts.query, keep_blank_values=True).get("v", [])
                if len(ids) == 1:
                    video_id = ids[0]
            elif parts.path.startswith("/shorts/"):
                video_id = parts.path.removeprefix("/shorts/").removesuffix("/")
    if not _VIDEO_ID.fullmatch(video_id):
        raise SongSourceError("YouTubeの動画1本のURL（watch、youtu.be、Shorts）を指定してください。")
    return f"https://www.youtube.com/watch?v={video_id}"


def _temp_root(temp_root):
    parent = Path(temp_root) if temp_root is not None else Path(tempfile.gettempdir())
    suffix = f"-{os.getuid()}" if hasattr(os, "getuid") else ""
    return parent / f"guitar-chord-lab-media{suffix}"


def _prepare_root(root):
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    if root.is_symlink():
        raise SongSourceError("一時音源フォルダにシンボリックリンクは使用できません。")
    if hasattr(os, "getuid"):
        info = root.stat()
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise SongSourceError("一時音源フォルダは、現在の利用者だけが使える場所に指定してください。")


@contextmanager
def _locked(path, *, wait=True):
    # POSIXのみ。一時フォルダは自分のアカウントだけが書き込める専用領域です。
    with path.open("a+b") as lock:
        mode = fcntl.LOCK_EX if wait else fcntl.LOCK_EX | fcntl.LOCK_NB
        try:
            fcntl.flock(lock, mode)
        except BlockingIOError:
            yield None
            return
        try:
            yield lock
        finally:
            # 異常終了時にはOSがロックを解放します。ダウンロード子プロセスが
            # FDを保持していれば、その終了までロックが残ります。
            fcntl.flock(lock, fcntl.LOCK_UN)


def _remove_run(directory, lease_path):
    if directory.is_dir() and not directory.is_symlink():
        shutil.rmtree(directory)
    lease_path.unlink(missing_ok=True)


def _remove_orphans(root):
    """全体ロックの内側で、実行ロックを確保できた古いフォルダだけ削除します。"""
    names = {entry.name.removesuffix(".lease") for entry in root.iterdir()}
    for name in sorted(names):
        if not _RUN_NAME.fullmatch(name):
            continue
        directory = root / name
        lease_path = root / f"{name}.lease"
        if directory.is_symlink() or lease_path.is_symlink():
            continue
        with _locked(lease_path, wait=False) as lease:
            if lease is not None:
                _remove_run(directory, lease_path)


def _cleanup_on_start(root):
    if fcntl is not None and root.exists():
        _prepare_root(root)
        with _locked(root / ".runs.lock"):
            _remove_orphans(root)


@contextmanager
def _temporary_run(root):
    _prepare_root(root)
    if fcntl is None:
        # Windowsでも通常終了と例外終了はこの実行のフォルダだけを削除します。
        with tempfile.TemporaryDirectory(prefix="run-", dir=root) as name:
            yield Path(name), None
        return

    directory = root / f"run-{uuid.uuid4().hex}"
    lease_path = directory.with_suffix(".lease")
    global_lock = root / ".runs.lock"
    created = False
    with ExitStack() as leases:
        try:
            with _locked(global_lock):
                _remove_orphans(root)
                directory.mkdir(mode=0o700)
                created = True
                lease = leases.enter_context(_locked(lease_path))
            yield directory, lease.fileno()
        finally:
            if created:
                with _locked(global_lock):
                    leases.close()
                    _remove_run(directory, lease_path)


def _download_command(url, directory):
    args = [
        sys.executable, "-m", "yt_dlp",
        "--ignore-config", "--no-plugin-dirs", "--no-remote-components",
        "--no-cookies", "--no-cookies-from-browser", "--no-cache-dir",
        "--no-playlist", "--no-progress", "--abort-on-unavailable-fragments",
        "--socket-timeout", "20", "--retries", "2", "--fragment-retries", "2",
        "--match-filter", "!is_live", "--format", "bestaudio/best",
        "--extract-audio", "--audio-format", "mp3", "--audio-quality", "0",
        "--output", str(directory / "source.%(ext)s"),
    ]
    # yt-dlpではDenoが既定で有効です。Node.jsにも対応させます。
    if shutil.which("node"):
        args += ["--js-runtimes", "node"]
    return args + ["--", url]


def _download_youtube(url, directory, lease_fd):
    if importlib.util.find_spec("yt_dlp") is None:
        raise SongSourceError('YouTube入力には yt-dlp が必要です。pip install -U "yt-dlp[default]" を実行してください。')
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise SongSourceError("MP3への変換には ffmpeg と ffprobe が必要です。")
    options = {} if lease_fd is None else {"pass_fds": (lease_fd,)}
    try:
        result = subprocess.run(
            _download_command(url, directory), cwd=directory, stdin=subprocess.DEVNULL,
            capture_output=True, encoding="utf-8", errors="replace", timeout=900,
            **options,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SongSourceError(f"YouTube音源の取得処理を完了できませんでした。手元の音源でも解析できます。{exc}") from exc
    audio = directory / "source.mp3"
    if result.returncode != 0 or not audio.is_file() or audio.stat().st_size == 0:
        errors = [line for line in result.stderr.splitlines() if line.startswith("ERROR:")]
        detail = f" 詳細: {errors[-1][:500]}" if errors else ""
        raise SongSourceError(
            "YouTube音源を取得できませんでした。URL、公開範囲、接続、yt-dlpとJavaScript実行環境を確認してください。"
            f"取得できない場合は、利用できる手元の音源を指定してください。{detail}"
        )
    return audio


@contextmanager
def open_song_source(
    source: str | Path, *, youtube_allowed: bool = False, temp_root: str | Path | None = None,
) -> Iterator[Path]:
    """ローカル音源、または解析中だけ存在するYouTube由来のMP3のPathを返します。

    youtube_allowed=True は、利用規約・法令上許される方法で対象音源を取得
    できることを利用者が確認した場合に指定します。
    temp_root は専用一時フォルダの親ディレクトリです。
    """
    root = _temp_root(temp_root).expanduser().absolute()
    if isinstance(source, str) and "://" in source:
        url = normalise_youtube_url(source)
        if youtube_allowed is not True:
            raise SongSourceError(
                "YouTubeの利用規約と法令に沿って取得できる音源であることを確認し、YouTube入力を許可してください。"
            )
        with _temporary_run(root) as (directory, lease_fd):
            yield _download_youtube(url, directory, lease_fd)
    else:
        _cleanup_on_start(root)
        path = Path(source).expanduser()
        if not path.is_file():
            raise SongSourceError("音源ファイルが見つかりません。ファイル名、またはYouTubeの動画URLを指定してください。")
        yield path
