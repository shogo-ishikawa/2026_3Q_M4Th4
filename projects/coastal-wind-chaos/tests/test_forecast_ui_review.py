"""操作の境界と準備セルを、独立した利用シナリオで確認する。"""

import contextlib
import importlib.metadata
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sys
import tempfile
import types

import pandas as pd
import pytest


PROJECT = Path(__file__).resolve().parents[1]
NOTEBOOK = PROJECT / "notebooks/coastal_wind_forecast_lab.ipynb"


def cell_source(title):
    cells = json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"]
    return next("".join(cell["source"]) for cell in cells
                if cell["cell_type"] == "code" and "".join(cell["source"]).startswith(f"#@title {title}"))


@pytest.fixture
def panel(monkeypatch, tmp_path):
    pytest.importorskip("ipywidgets")
    import IPython.display

    shown = []
    monkeypatch.setattr(IPython.display, "display", lambda *items, **kwargs: shown.extend(items))
    monkeypatch.setattr(IPython.display, "clear_output", lambda *args, **kwargs: None)
    calls = []

    def analyse(**kwargs):
        calls.append(kwargs)
        output = Path(kwargs["output_dir"])
        output.mkdir(parents=True)
        archive = output / "result.zip"
        archive.write_bytes(b"UI boundary test")
        return {"metadata": {"mode": kwargs["mode"]}, "predictions": pd.DataFrame(),
                "summary": pd.DataFrame({"n_speed": [0]}), "skill": pd.DataFrame(),
                "grouped": {}, "figures": [], "zip_path": archive}

    namespace = {"IN_COLAB": False, "Path": Path, "tempfile": tempfile,
                 "RESULTS_ROOT": tmp_path / "runs", "run_analysis": analyse}
    with contextlib.redirect_stdout(io.StringIO()):
        exec(compile(cell_source("操作パネルを開く"), "<panel-review>", "exec"), namespace)
    namespace["calls"] = calls
    namespace["shown"] = shown
    namespace["analyse"] = analyse
    yield namespace
    for value in namespace.values():
        if value.__class__.__module__.startswith("ipywidgets") and hasattr(value, "close"):
            value.close()


def test_demo_run_never_receives_files_left_from_another_mode(panel):
    panel["mode"].value = "csv_backtest"
    panel["store_uploads"]({"unreadable.csv": b"a failed previous upload"})
    panel["mode"].value = "demo"
    panel["run_clicked"]()
    assert panel["calls"][-1]["mode"] == "demo"
    assert panel["calls"][-1]["observation_paths"] == []


def test_recent_observations_do_not_hide_forecast_history_upload(panel):
    panel["mode"].value = "latest_forecast"
    panel["recent"].value = True
    assert panel["upload_button"].layout.display != "none"


def test_optional_drive_backup_failure_does_not_erase_success(panel, tmp_path):
    # 接続先が消えた場合を再現。解析の成功と任意の追加保存を混同しない。
    missing_drive = tmp_path / "disconnected-drive"
    missing_drive.write_text("this is a file, not a connected folder")
    panel["STATE"]["drive_dir"] = missing_drive
    panel["run_clicked"]()
    assert panel["STATE"]["result"] is not None
    assert not panel["download_button"].disabled
    assert "完了していません" not in panel["status"].value


def test_settings_changed_during_run_do_not_offer_old_conditions_as_current(panel):
    original = panel["analyse"]

    def change_settings(**kwargs):
        result = original(**kwargs)
        panel["horizons"].value = (72,)
        return result

    panel["run_analysis"] = change_settings
    panel["run_clicked"]()
    assert panel["calls"][-1]["options"]["horizons"] != [72]
    assert panel["STATE"]["result"] is None
    assert panel["download_button"].disabled


def test_inputs_are_locked_during_analysis_and_restored_afterwards(panel):
    original = panel["analyse"]
    checked = []

    def check_locked(**kwargs):
        for name in ("mode", "location", "horizons", "upload_button", "reset_button", "date_reset"):
            assert panel[name].disabled
        checked.append(True)
        return original(**kwargs)

    panel["run_analysis"] = check_locked
    panel["run_clicked"]()
    assert checked == [True]
    assert not panel["mode"].disabled
    assert not panel["horizons"].disabled
    assert not panel["run_button"].disabled
    assert not panel["download_button"].disabled


def test_changed_location_restores_controls_for_the_new_selection(panel):
    original = panel["analyse"]

    def change_location(**kwargs):
        result = original(**kwargs)
        panel["location"].value = "custom"
        return result

    panel["run_analysis"] = change_location
    panel["run_clicked"]()
    assert panel["STATE"]["result"] is None
    assert not panel["latitude"].disabled
    assert not panel["longitude"].disabled


def test_empty_new_file_selection_does_not_retain_downloadable_old_result(panel):
    panel["store_uploads"]({"first.csv": b"some data"})
    panel["run_clicked"]()
    assert panel["STATE"]["result"] is not None
    panel["store_uploads"]({})
    assert panel["STATE"]["paths"] == []
    assert panel["STATE"]["result"] is None
    assert panel["download_button"].disabled


def test_changing_hidden_dates_cannot_leak_them_into_latest_options(panel):
    panel["test_start"].value = "2025-01-01"
    panel["cutoff"].value = "2026-01-01"
    panel["mode"].value = "latest_forecast"
    options = panel["selected_options"]()
    assert not {"train_start", "test_start", "validation_start", "cutoff", "run_time_utc"} & options.keys()


def test_download_uses_current_result_after_repeated_runs(panel):
    panel["run_clicked"]()
    first = panel["STATE"]["result"]["zip_path"]
    panel["run_clicked"]()
    second = panel["STATE"]["result"]["zip_path"]
    assert first != second
    panel["shown"].clear()
    panel["download_clicked"](None)
    assert any(str(second) in str(getattr(value, "path", value)) for value in panel["shown"])


def test_saved_synthetic_input_stays_explicit_outside_demo_mode(panel):
    panel["mode"].value = "future"
    panel["shown"].clear()
    panel["render_result"]({"metadata": {"source_kind": "synthetic", "mode": "future"},
                            "summary": pd.DataFrame(), "predictions": pd.DataFrame(), "figures": []})
    rendered = " ".join(str(getattr(value, "data", value)) for value in panel["shown"])
    assert "合成データによる結果" in rendered


def test_setup_updates_dependencies_even_if_older_packages_are_installed(monkeypatch, tmp_path):
    """importできるだけでは最低対応版を満たすとは限らない。外部取得は模擬する。"""
    source = cell_source("準備：必要なコードとライブラリを読み込む")
    import subprocess

    calls = []
    original_find = importlib.util.find_spec
    original_version = importlib.metadata.version
    original_mkdir = Path.mkdir
    old_path = sys.path.copy()
    old_modules = {name: value for name, value in sys.modules.items()
                   if name == "coastal_wind_chaos" or name.startswith("coastal_wind_chaos.")}

    def find_spec(name, *args, **kwargs):
        if name == "google.colab":
            return types.SimpleNamespace(name=name)
        return original_find(name, *args, **kwargs)

    def run(arguments, **kwargs):
        calls.append(arguments)
        if arguments[:2] == ["git", "clone"]:
            checkout = Path(arguments[-1])
            target = checkout / "projects/coastal-wind-chaos"
            target.mkdir(parents=True)
            shutil.copy2(PROJECT / "pyproject.toml", target / "pyproject.toml")
            shutil.copytree(PROJECT / "src", target / "src", ignore=shutil.ignore_patterns("__pycache__"))
        return types.SimpleNamespace(returncode=0)

    def mkdir(path, *args, **kwargs):
        if str(path).startswith("/content"):
            return None
        return original_mkdir(path, *args, **kwargs)

    monkeypatch.setattr(importlib.util, "find_spec", find_spec)
    def package_version(name):
        updated = any("pip" in arguments and "install" in arguments for arguments in calls)
        return "1.20.0" if name == "numpy" and not updated else original_version(name)

    monkeypatch.setattr(importlib.metadata, "version", package_version)
    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setattr(tempfile, "mkdtemp", lambda **kwargs: str(tmp_path))
    monkeypatch.setattr(Path, "mkdir", mkdir)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            exec(compile(source, "<setup-review>", "exec"), {})
    finally:
        sys.path[:] = old_path
        for name in list(sys.modules):
            if name == "coastal_wind_chaos" or name.startswith("coastal_wind_chaos."):
                del sys.modules[name]
        sys.modules.update(old_modules)
    assert any("pip" in arguments and "install" in arguments for arguments in calls)
