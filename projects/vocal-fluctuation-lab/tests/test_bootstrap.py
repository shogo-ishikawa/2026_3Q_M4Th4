"""古い実行環境を残したまま準備セルから更新できることを確認します。"""
import json
from pathlib import Path
import subprocess
import sys
import unittest


PROJECT = Path(__file__).resolve().parents[1]


# sys.modulesを書き換える準備セルは、他のテストの読み込み状態と分けて実行します。
BOOTSTRAP_SCENARIO = r"""
import importlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
from unittest.mock import patch
import urllib.error
import zipfile

project, scenario = Path(sys.argv[1]), sys.argv[2]
notebook = json.loads((project / "notebooks/vocal_fluctuation_lab.ipynb").read_text())
cells = [cell["source"] for cell in notebook["cells"] if cell["cell_type"] == "code"]
prepare, open_screen = cells[:2]

def archive_bytes(old_limit=False):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        paths = list((project / "vocal_lab").glob("*.py")) + list(project.glob("requirements*.txt"))
        for path in paths:
            content = path.read_text()
            if path.name == "__init__.py":
                content = '__version__ = "1.7.0"\n'
            if old_limit and path.name == "audio.py":
                content = content.replace("MAX_SECONDS = 600.0", "MAX_SECONDS = 180.0")
            archive.writestr("class-main/projects/vocal-fluctuation-lab/" + path.relative_to(project).as_posix(), content)
    return stream.getvalue()

def make_old_source(directory):
    package = directory / "vocal_lab"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text('__version__ = "1.0.0"\n')
    (package / "notebook_ui.py").write_text('''
def validate_interval(start, end):
    if end - start > 180:
        raise ValueError("解析する区間は10秒〜180秒にしてください。")
    return start, end
class VocalNotebookUI:
    pass
''')
    (directory / "requirements-colab.txt").write_text("old requirements\n")

def load_old(directory):
    for name in list(sys.modules):
        if name == "vocal_lab" or name.startswith("vocal_lab."):
            del sys.modules[name]
    sys.path.insert(0, str(directory))
    importlib.invalidate_caches()
    from vocal_lab import notebook_ui as old_ui
    try:
        old_ui.validate_interval(0, 300)
    except ValueError:
        pass
    else:
        raise AssertionError("old source did not reproduce the 180-second limit")
    return old_ui

def assert_current(namespace, expected_directory):
    with patch("IPython.display.display"):
        exec(compile(open_screen, "screen-cell", "exec"), namespace)
    import vocal_lab
    from vocal_lab import audio, notebook_ui
    assert vocal_lab.__version__ == "1.7.0"
    assert Path(vocal_lab.__file__).resolve().parent == expected_directory / "vocal_lab"
    assert Path(notebook_ui.__file__).resolve().parent == expected_directory / "vocal_lab"
    assert Path(sys.path[0]) == expected_directory
    assert sys.path.count(str(expected_directory)) == 1
    assert audio.MAX_SECONDS == 600
    assert notebook_ui.validate_interval(0, 300) == (0, 300)
    assert notebook_ui.validate_interval(0, 600) == (0, 600)
    lab = namespace["lab"]
    assert lab.trim_edges.value is True
    assert lab.remove_internal.value is False
    assert lab._silence_config().threshold_db == -40
    # 実際のボタン処理が300秒を受け付けることを確認し、音源取得の直前で止めます。
    admitted = []
    def before_audio(*args, **kwargs):
        admitted.append((args, kwargs))
        raise RuntimeError("stop before network and audio processing")
    lab.run_pipeline = before_audio
    lab.mode.value = "youtube"
    lab.url.value = "https://www.youtube.com/watch?v=abcdefghijk"
    lab.start.value, lab.end.value = 0, 300
    lab.analyse_button.click()
    assert admitted[-1][0][1:3] == (0, 300)
    assert admitted[-1][1]["silence_config"].trim_edges is True
    assert admitted[-1][1]["silence_config"].remove_internal is False
    lab.start.value, lab.end.value = 30, 360
    lab.whole_track.value = True
    lab.reset_times_button.click()
    assert (lab.start.value, lab.end.value, lab.whole_track.value) == (0, 90, False)

with tempfile.TemporaryDirectory() as folder:
    workspace = Path(folder)
    old_directory = workspace / "old-project"
    make_old_source(old_directory)
    if scenario == "same-version":
        (old_directory / "vocal_lab/__init__.py").write_text('__version__ = "1.7.0"\n')
    os.chdir(old_directory)
    data_file = old_directory / "uploads/song.wav"
    database = old_directory / "reference_database.json"
    data_file.parent.mkdir()
    data_file.write_bytes(b"do not delete this recording")
    database.write_text('{"references": []}')
    old_ui = load_old(old_directory)
    unrelated = types.ModuleType("vocal_lab_helpers")
    sys.modules["vocal_lab_helpers"] = unrelated
    namespace = {"vocal_lab_ready": True}
    requests = []
    payload = archive_bytes(old_limit=scenario == "outdated-download")

    def downloaded(request, timeout):
        requests.append(request)
        assert timeout == 90
        return io.BytesIO(payload)

    if scenario == "local":
        local = workspace / "local-project"
        local.mkdir()
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            for name in archive.namelist():
                path = local / name.split("/projects/vocal-fluctuation-lab/", 1)[1]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(archive.read(name))
        os.chdir(local)
        prepare = prepare.replace('source_mode = "公開版を更新"', 'source_mode = "手元のフォルダを使う"')
        with patch("urllib.request.urlopen", side_effect=AssertionError("local mode accessed the network")), patch("subprocess.run"):
            exec(compile(prepare, "preparation-cell", "exec"), namespace)
        assert_current(namespace, local)
    elif scenario == "failed-download":
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("offline")), patch("subprocess.run"):
            try:
                exec(compile(prepare, "preparation-cell", "exec"), namespace)
            except urllib.error.URLError:
                pass
            else:
                raise AssertionError("failed download did not fail")
        assert namespace["vocal_lab_ready"] is False
        try:
            exec(compile(open_screen, "screen-cell", "exec"), namespace)
        except RuntimeError as error:
            assert "準備セル" in str(error)
        else:
            raise AssertionError("old screen opened after preparation failed")
        assert "lab" not in namespace
    else:
        with patch("urllib.request.urlopen", side_effect=downloaded), patch("subprocess.run") as install:
            if scenario == "outdated-download":
                try:
                    exec(compile(prepare, "preparation-cell", "exec"), namespace)
                except RuntimeError as error:
                    assert "古いまま" in str(error)
                else:
                    raise AssertionError("outdated downloaded code was accepted")
                assert namespace["vocal_lab_ready"] is False
            else:
                exec(compile(prepare, "preparation-cell", "exec"), namespace)
                prepared = Path(namespace["project_directory"]).resolve()
                assert prepared != old_directory
                assert_current(namespace, prepared)
                if scenario == "second-preparation":
                    first_url = requests[-1].full_url
                    exec(compile(prepare, "preparation-cell", "exec"), namespace)
                    second = Path(namespace["project_directory"]).resolve()
                    assert second != prepared
                    assert requests[-1].full_url != first_url
                    assert_current(namespace, second)
                if scenario == "screen-refresh":
                    load_old(old_directory)
                    assert str(prepared) in sys.path
                    assert sys.path[0] == str(old_directory)
                    assert_current(namespace, prepared)
                assert all(request.headers.get("Cache-control") == "no-cache" for request in requests)
                assert install.call_args.args[0][:4] == [sys.executable, "-m", "pip", "install"]
        assert requests
    assert data_file.read_bytes() == b"do not delete this recording"
    assert database.read_text() == '{"references": []}'
    assert sys.modules["vocal_lab_helpers"] is unrelated
print("bootstrap scenario passed:", scenario)
"""


class BootstrapTests(unittest.TestCase):
    def run_scenario(self, scenario):
        completed = subprocess.run([sys.executable, "-c", BOOTSTRAP_SCENARIO, str(PROJECT), scenario],
                                   text=True, capture_output=True, timeout=90)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)

    def test_preparation_replaces_old_imports_and_stale_working_directory(self):
        self.run_scenario("refresh")

    def test_second_preparation_uses_a_new_source_and_cache_key(self):
        self.run_scenario("second-preparation")

    def test_matching_version_number_does_not_keep_another_source_directory(self):
        self.run_scenario("same-version")

    def test_opening_screen_can_replace_old_imports_again(self):
        self.run_scenario("screen-refresh")

    def test_explicit_local_zip_mode_uses_local_files(self):
        self.run_scenario("local")

    def test_failed_preparation_cannot_open_the_old_screen(self):
        self.run_scenario("failed-download")

    def test_old_downloaded_features_fail_before_opening_screen(self):
        self.run_scenario("outdated-download")

    def test_versioned_notebook_is_identical_and_has_clean_forms(self):
        canonical = json.loads((PROJECT / "notebooks/vocal_fluctuation_lab.ipynb").read_text())
        versioned = json.loads((PROJECT / "notebooks/vocal_fluctuation_lab_v1.7.0.ipynb").read_text())
        self.assertEqual(versioned, canonical)
        for cell in versioned["cells"]:
            if cell["cell_type"] == "code":
                self.assertEqual(cell["metadata"].get("cellView"), "form")
                self.assertTrue(cell["source"].startswith("#@title "))
                self.assertEqual(cell["outputs"], [])
                self.assertIsNone(cell["execution_count"])


if __name__ == "__main__":
    unittest.main()
