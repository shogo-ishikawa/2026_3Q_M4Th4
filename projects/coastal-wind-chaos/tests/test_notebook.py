"""Notebook を上から順に実行し、エラーや警告が出ないことを確かめる（数十秒かかる）。

nbclient・nbformat・ipykernel がない環境では飛ばす（pip install -e ".[test,notebook]" で入る）。
"""

import shutil

import pytest

from conftest import PROJECT_DIR

nbformat = pytest.importorskip("nbformat")
nbclient = pytest.importorskip("nbclient")
pytest.importorskip("ipykernel")


def test_notebook_runs_without_errors_or_warnings(tmp_path):
    # 作品フォルダに data/ などを作らないよう、必要なフォルダを一時フォルダに写して実行する
    for folder in ["src", "notebooks"]:
        shutil.copytree(PROJECT_DIR / folder, tmp_path / folder,
                        ignore=shutil.ignore_patterns("__pycache__", ".ipynb_checkpoints"))
    notebook = nbformat.read(tmp_path / "notebooks" / "coastal_wind_hands_on.ipynb", as_version=4)
    client = nbclient.NotebookClient(notebook, timeout=600, kernel_name="python3",
                                     resources={"metadata": {"path": str(tmp_path / "notebooks")}})
    client.execute()
    problems = []
    for number, cell in enumerate(notebook.cells):
        for output in cell.get("outputs", []):
            if output.get("output_type") == "error" or output.get("name") == "stderr":
                problems.append(f"セル {number}: {output.get('ename') or output.get('text', '')[:300]}")
    assert not problems, "\n".join(problems)
