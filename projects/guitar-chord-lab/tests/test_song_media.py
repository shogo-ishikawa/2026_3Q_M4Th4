import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from guitar_chord_lab import song_media

VIDEO_ID = "AbCdEF12_-X"
SHORT = f"https://youtu.be/{VIDEO_ID}?t=17"
CANONICAL = f"https://www.youtube.com/watch?v={VIDEO_ID}"


@pytest.mark.parametrize(
    "url",
    [
        SHORT,
        f"{CANONICAL}&list=other",
        f"https://m.youtube.com/watch?v={VIDEO_ID}",
        f"https://www.youtube.com/shorts/{VIDEO_ID}",
    ],
)
def test_video_url_accepts_video_links_and_removes_extra_parameters(url):
    assert song_media.normalise_youtube_url(url) == CANONICAL


@pytest.mark.parametrize(
    "url",
    [
        "https://www.youtube.com/playlist?list=other",
        f"{CANONICAL}&v={VIDEO_ID}",
        f"https://www.youtube.com.evil.example/watch?v={VIDEO_ID}",
        f"https://example.org@www.youtube.com/watch?v={VIDEO_ID}",
        "https://youtu.be/short",
    ],
)
def test_video_url_rejects_other_sources(url):
    with pytest.raises(song_media.SongSourceError, match="動画1本"):
        song_media.normalise_youtube_url(url)


def test_local_input_is_preserved(tmp_path):
    local = tmp_path / "student.wav"
    local.write_bytes(b"my audio")
    with song_media.open_song_source(local, temp_root=tmp_path) as path:
        assert path == local
    assert local.read_bytes() == b"my audio"


def test_youtube_input_requires_permission(tmp_path):
    with pytest.raises(song_media.SongSourceError, match="利用規約"):
        with song_media.open_song_source(SHORT, temp_root=tmp_path):
            pytest.fail("a source must not open before the user confirms permission")
    assert not list(tmp_path.iterdir())


def write_fake_download(url, directory, lease_fd):
    assert url == CANONICAL
    audio = directory / "source.mp3"
    audio.write_bytes(b"example MP3")
    (directory / "source.webm.part").write_bytes(b"partial data")
    return audio


@pytest.mark.parametrize("error", [None, RuntimeError, KeyboardInterrupt])
def test_temporary_download_cleaned_after_the_pipeline(tmp_path, monkeypatch, error):
    monkeypatch.setattr(song_media, "_download_youtube", write_fake_download)

    def analyse():
        with song_media.open_song_source(SHORT, youtube_allowed=True, temp_root=tmp_path) as audio:
            assert audio.read_bytes() == b"example MP3"
            if error:
                raise error()
        return audio

    if error:
        with pytest.raises(error):
            analyse()
    else:
        assert not analyse().exists()
    assert not list(tmp_path.rglob("run-*"))


def test_download_failure_removes_partial_files(tmp_path, monkeypatch):
    def fail(url, directory, lease_fd):
        write_fake_download(url, directory, lease_fd)
        raise song_media.SongSourceError("conversion failed")

    monkeypatch.setattr(song_media, "_download_youtube", fail)
    with pytest.raises(song_media.SongSourceError, match="conversion failed"):
        with song_media.open_song_source(SHORT, youtube_allowed=True, temp_root=tmp_path):
            pytest.fail("a failed download must not reach analysis")
    assert not list(tmp_path.rglob("run-*"))


@pytest.mark.skipif(song_media.fcntl is None, reason="POSIX process locks")
def test_new_run_removes_orphans_but_preserves_live_download(tmp_path, monkeypatch):
    monkeypatch.setattr(song_media, "_download_youtube", write_fake_download)
    with song_media.open_song_source(SHORT, youtube_allowed=True, temp_root=tmp_path) as first:
        root = first.parent.parent
        orphan = root / ("run-" + "a" * 32)
        orphan.mkdir()
        (orphan / "source.mp3").write_bytes(b"abandoned")
        orphan.with_suffix(".lease").touch()
        keep = root / "another-file.txt"
        keep.touch()
        with song_media.open_song_source(SHORT, youtube_allowed=True, temp_root=tmp_path) as second:
            assert not orphan.exists()
            assert not orphan.with_suffix(".lease").exists()
            assert first.exists()
            assert second.exists()
            assert first != second
            assert keep.exists()
        assert first.exists()


@pytest.mark.skipif(song_media.fcntl is None, reason="POSIX process locks")
def test_abrupt_process_exit_is_cleaned_even_on_a_local_input(tmp_path):
    code = """
import os
import sys
from pathlib import Path
from guitar_chord_lab import song_media

root = song_media._temp_root(Path(sys.argv[1]))
with song_media._temporary_run(root) as (directory, _lease):
    (directory / "source.mp3").write_bytes(b"abandoned")
    os._exit(43)
"""
    result = subprocess.run([sys.executable, "-c", code, str(tmp_path)], timeout=30)
    assert result.returncode == 43
    assert list(tmp_path.rglob("source.mp3"))
    local = tmp_path / "student.wav"
    local.touch()
    with song_media.open_song_source(local, temp_root=tmp_path) as path:
        assert path.exists()
        assert not list(tmp_path.rglob("run-*"))


def test_downloader_uses_explicit_arguments_and_mp3(tmp_path, monkeypatch):
    monkeypatch.setattr(song_media.importlib.util, "find_spec", lambda name: object())
    monkeypatch.setattr(song_media.shutil, "which", lambda name: f"/bin/{name}")

    def run(args, **kwargs):
        assert args[:3] == [sys.executable, "-m", "yt_dlp"]
        assert args[-2:] == ["--", CANONICAL]
        assert {"--ignore-config", "--no-cookies", "--no-playlist", "--no-remote-components"} <= set(args)
        assert args[args.index("--audio-format") + 1] == "mp3"
        assert args[args.index("--js-runtimes") + 1] == "node"
        assert "shell" not in kwargs
        assert kwargs["stdin"] == subprocess.DEVNULL
        audio = Path(kwargs["cwd"]) / "source.mp3"
        audio.write_bytes(b"converted MP3")
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(song_media.subprocess, "run", run)
    with song_media.open_song_source(SHORT, youtube_allowed=True, temp_root=tmp_path) as path:
        assert path.read_bytes() == b"converted MP3"
