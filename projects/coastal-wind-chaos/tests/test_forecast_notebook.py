"""公開Notebookの再現性と、操作から解析へ渡す条件・データの取り違えを確認する。"""

import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

import pandas as pd
import pytest

PROJECT_DIR = Path(__file__).resolve().parents[1]
NOTEBOOK = PROJECT_DIR / "notebooks/coastal_wind_forecast_lab.ipynb"
BUILDER = PROJECT_DIR / "scripts/build_forecast_notebook.py"


def load_builder():
    spec = importlib.util.spec_from_file_location("build_forecast_notebook", BUILDER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def notebook_cells():
    return json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"]


def test_rebuild_is_identical_and_cells_are_publishable(tmp_path):
    builder = load_builder()
    rebuilt = builder.build(tmp_path / "rebuilt.ipynb")
    assert rebuilt.read_bytes() == NOTEBOOK.read_bytes()
    notebook = json.loads(rebuilt.read_text(encoding="utf-8"))
    nbformat = pytest.importorskip("nbformat")
    nbformat.validate(nbformat.from_dict(notebook))
    identifiers = []
    for cell in notebook["cells"]:
        identifiers.append(cell["id"])
        if cell["cell_type"] == "code":
            source = "".join(cell["source"])
            compile(source, f"<{cell['id']}>", "exec")
            assert source.startswith("#@title ")
            assert cell["metadata"]["cellView"] == "form"
            assert cell["metadata"]["jupyter"]["source_hidden"] is True
            assert cell["execution_count"] is None
            assert cell["outputs"] == []
    assert len(set(identifiers)) == len(identifiers)


def test_ref_changes_colab_link_and_source_together(tmp_path):
    builder = load_builder()
    path = builder.build(tmp_path / "main.ipynb", source_ref="main")
    notebook = json.loads(path.read_text(encoding="utf-8"))
    assert notebook["metadata"]["coastal_wind_lab"]["source_ref"] == "main"
    assert "/blob/main/" in "".join(notebook["cells"][0]["source"])
    setup = next("".join(cell["source"]) for cell in notebook["cells"]
                 if cell["cell_type"] == "code" and "REPOSITORY_URL" in "".join(cell["source"]))
    assert 'SOURCE_REF = "main"' in setup
    assert "--branch" in setup


@pytest.fixture
def ui(monkeypatch, tmp_path):
    pytest.importorskip("ipywidgets")
    import IPython.display

    sources = types.ModuleType("coastal_wind_chaos.forecast_sources")
    sources.LOCATIONS = {
        "choshi": {"name": "銚子", "latitude": 35.73833333333334, "longitude": 140.85666666666665, "station_id": "45148"},
        "wakkanai": {"name": "稚内", "latitude": 45.415, "longitude": 141.67833333333334, "station_id": "11016"},
        "coastal_example": {"name": "沿岸の例示地点", "latitude": 35.0, "longitude": 140.0, "station_id": None},
    }
    monkeypatch.setitem(sys.modules, "coastal_wind_chaos.forecast_sources", sources)
    displayed = []
    monkeypatch.setattr(IPython.display, "display", lambda *args, **kwargs: displayed.extend(args))
    monkeypatch.setattr(IPython.display, "clear_output", lambda *args, **kwargs: None)
    calls = []

    def run_analysis(**kwargs):
        calls.append(kwargs)
        directory = Path(kwargs["output_dir"])
        directory.mkdir(parents=True)
        bundle = directory / "result.zip"
        bundle.write_bytes(b"placeholder for UI test")
        return {"predictions": pd.DataFrame({"horizon_h": [3], "model": ["persistence"]}),
                "summary": pd.DataFrame(), "grouped": {}, "skill": pd.DataFrame(),
                "figures": [], "zip_path": bundle, "metadata": {"mode": kwargs["mode"]}}

    namespace = {"Path": Path, "tempfile": tempfile, "IN_COLAB": False,
                 "RESULTS_ROOT": tmp_path / "runs", "run_analysis": run_analysis}
    source = next("".join(cell["source"]) for cell in notebook_cells()
                  if cell["cell_type"] == "code" and "#@title 操作パネルを開く" in "".join(cell["source"]))
    exec(compile(source, "<forecast-panel>", "exec"), namespace)
    namespace["calls"] = calls
    namespace["displayed"] = displayed
    yield namespace
    for value in list(namespace.values()):
        if hasattr(value, "close") and value.__class__.__module__.startswith("ipywidgets"):
            value.close()


def test_opening_panel_and_changing_settings_do_not_fetch_or_analyse(ui):
    assert ui["calls"] == []
    ui["mode"].value = "latest_forecast"
    ui["location"].value = "wakkanai"
    ui["forecast_hours"].value = 48
    assert ui["calls"] == []
    assert ui["station"].value == "稚内"
    assert ui["station_id"].value == "11016"
    assert ui["download_button"].disabled


def test_run_uses_current_files_and_mode_specific_dates(ui):
    ui["store_uploads"]({"first.csv": b"old input"})
    old_path = ui["STATE"]["paths"][0]
    ui["store_uploads"]({"second.csv": b"new input"})
    assert ui["STATE"]["paths"] != [old_path]
    ui["mode"].value = "csv_backtest"
    ui["validation_start"].value = "2024-01-01 00:00"
    ui["test_start"].value = "2025-01-01 00:00"
    ui["run_clicked"]()
    call = ui["calls"][-1]
    assert call["mode"] == "csv_backtest"
    assert [Path(path).name for path in call["observation_paths"]] == ["second.csv"]
    assert call["options"]["test_start"] == "2025-01-01 00:00"
    assert not ui["download_button"].disabled
    ui["mode"].value = "latest_forecast"
    assert ui["STATE"]["result"] is None
    assert ui["download_button"].disabled
    ui["run_clicked"]()
    call = ui["calls"][-1]
    assert "test_start" not in call["options"]
    assert "validation_start" not in call["options"]


def test_reset_dates_and_settings_clear_previous_result(ui):
    ui["cutoff"].value = "2026-01-01 12:00"
    ui["run_time_utc"].value = "2026-01-01T00:00"
    ui["test_start"].value = "2025-01-01"
    ui["reset_dates"]()
    assert all(ui[name].value == "" for name in ("cutoff", "run_time_utc", "test_start"))
    ui["mode"].value = "future"
    ui["horizons"].value = (48, 72)
    ui["store_uploads"]({"history.zip": b"archive"})
    ui["run_clicked"]()
    previous_dir = ui["calls"][-1]["output_dir"]
    ui["reset_settings"](None)
    assert ui["mode"].value == "demo"
    assert ui["horizons"].value == (1, 3, 6, 12, 24)
    assert ui["STATE"]["paths"] == []
    assert ui["STATE"]["result"] is None
    assert ui["download_button"].disabled
    ui["run_clicked"]()
    assert ui["calls"][-1]["output_dir"] != previous_dir


def test_failed_upload_does_not_reuse_previous_files_and_names_stay_local(ui):
    ui["store_uploads"]({"../old.csv": b"data"})
    path = Path(ui["STATE"]["paths"][0])
    assert path.name == "old.csv"
    with pytest.raises(ValueError, match="CSV"):
        ui["store_uploads"]({"unsupported.py": b"not observation data"})
    assert ui["STATE"]["paths"] == []
    assert ui["download_button"].disabled


def test_failed_analysis_cannot_download_old_result(ui):
    ui["run_clicked"]()
    assert ui["STATE"]["result"] is not None

    def fail(**kwargs):
        raise ValueError("学習期間のデータが不足しています")

    ui["run_analysis"] = fail
    ui["run_clicked"]()
    assert ui["STATE"]["result"] is None
    assert ui["download_button"].disabled
    assert not ui["run_button"].disabled
    assert "完了していません" in ui["status"].value


def test_future_options_do_not_include_retrospective_test_dates(ui):
    ui["mode"].value = "future"
    ui["train_start"].value = "2023-01-01 00:00"
    ui["test_start"].value = "2025-01-01 00:00"
    ui["cutoff"].value = "2026-01-01 12:00"
    ui["future_method"].value = "boosting_shallow"
    ui["horizons"].value = (1, 3)
    options = ui["selected_options"]()
    assert options["selected_methods"] == {1: "boosting_shallow", 3: "boosting_shallow"}
    assert options["train_start"] == "2023-01-01 00:00"
    assert options["cutoff"] == "2026-01-01 12:00"
    assert "test_start" not in options
    assert ui["train_start"].layout.display != "none"
    assert ui["test_start"].layout.display == "none"


def test_learning_curve_is_explicit_opt_in(ui):
    assert ui["selected_options"]()["learning_curve_months"] == []
    ui["learning_curve"].value = True
    ui["learning_months"].value = (6, 12)
    assert ui["selected_options"]()["learning_curve_months"] == [6, 12]
    ui["mode"].value = "latest_forecast"
    assert "learning_curve_months" not in ui["selected_options"]()


def test_modes_hide_only_their_own_controls(ui):
    ui["mode"].value = "latest_forecast"
    assert ui["learning_box"].layout.display == "none"
    assert ui["nwp_box"].layout.display == ""
    assert ui["run_button"].layout.display != "none"
    assert ui["mode"].layout.display != "none"
    ui["mode"].value = "future"
    assert ui["test_start"].layout.display == "none"
    assert ui["train_start"].layout.display != "none"
    assert ui["run_button"].layout.display != "none"


def test_future_zero_count_summary_is_explicitly_unscored(ui):
    ui["mode"].value = "future"
    ui["displayed"].clear()
    ui["render_result"]({"metadata": {"messages": ["入力観測は2026年1月1日までです"]},
                          "summary": pd.DataFrame({"n_speed": [0], "speed_mae_ms": [float("nan")]}),
                          "predictions": pd.DataFrame(), "figures": []})
    rendered = " ".join(str(getattr(item, "data", item)) for item in ui["displayed"])
    assert "入力観測は2026年1月1日までです" in rendered
    assert "未来の精度は未評価" in rendered
