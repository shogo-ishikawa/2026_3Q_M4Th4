"""Notebook を確かめる。

- scripts/build_notebook.py で作り直すと、リポジトリの Notebook と同じになる（セルのIDも固定）
- 上から順に実行して、エラーや警告が出ない（数十秒かかる）

nbformat・nbclient・ipykernel がない環境では飛ばす（pip install -e ".[test,notebook]" で入る）。
"""

import json
import shutil
import sys

import pytest

from conftest import PROJECT_DIR

nbformat = pytest.importorskip("nbformat")
NOTEBOOK = PROJECT_DIR / "notebooks" / "coastal_wind_hands_on.ipynb"


def test_notebook_matches_the_builder(tmp_path):
    sys.path.insert(0, str(PROJECT_DIR / "scripts"))
    import build_notebook

    built = build_notebook.build(tmp_path / "built.ipynb")
    assert json.loads(built.read_text(encoding="utf-8")) == json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    cells = json.loads(NOTEBOOK.read_text(encoding="utf-8"))["cells"]
    assert [cell["id"] for cell in cells] == [f"cell-{number:02d}" for number in range(1, len(cells) + 1)]
    assert all(not cell.get("outputs") for cell in cells if cell["cell_type"] == "code")  # 出力は保存しない
    assert f'BRANCH = "{build_notebook.BRANCH}"' in "".join(cells[2]["source"])  # リンクと取得先が同じ版
    assert build_notebook.BRANCH in "".join(cells[0]["source"])


def test_notebook_runs_without_errors_or_warnings(tmp_path):
    nbclient = pytest.importorskip("nbclient")
    pytest.importorskip("ipykernel")
    # 作品フォルダに data/ などを作らないよう、必要なフォルダを一時フォルダに写して実行する
    for folder in ["src", "notebooks"]:
        shutil.copytree(PROJECT_DIR / folder, tmp_path / folder,
                        ignore=shutil.ignore_patterns("__pycache__", ".ipynb_checkpoints"))
    notebook = nbformat.read(tmp_path / "notebooks" / "coastal_wind_hands_on.ipynb", as_version=4)
    client = nbclient.NotebookClient(notebook, timeout=900, kernel_name="python3",
                                     resources={"metadata": {"path": str(tmp_path / "notebooks")}})
    client.execute()
    problems = []
    for number, cell in enumerate(notebook.cells):
        for output in cell.get("outputs", []):
            if output.get("output_type") == "error" or output.get("name") == "stderr":
                problems.append(f"セル {number}: {output.get('ename') or output.get('text', '')[:300]}")
    assert not problems, "\n".join(problems)
