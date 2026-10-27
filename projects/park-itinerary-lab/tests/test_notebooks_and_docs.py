"""Notebook と文書の形を確かめるテスト（Notebook の実行は scripts/run_notebooks.py で行う）。"""

import ast
import json
import re
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
NOTEBOOKS = {
    "intro": PROJECT_DIR / "notebooks" / "01_pulp_intro.ipynb",
    "main": PROJECT_DIR / "notebooks" / "02_day_plan_optimisation.ipynb",
}


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def source(cell):
    return "".join(cell["source"]) if isinstance(cell["source"], list) else cell["source"]


def setup_cell(notebook):
    """最初のコードセル（セットアップ）。"""
    return next(cell for cell in notebook["cells"] if cell["cell_type"] == "code")


def test_committed_notebooks_have_no_outputs():
    """生成物をコミットしないよう、Notebook は出力を消した状態で保存する。"""
    for path in NOTEBOOKS.values():
        for cell in load(path)["cells"]:
            if cell["cell_type"] == "code":
                assert cell.get("outputs") == [], f"{path.name} に出力が残っています"
                assert cell.get("execution_count") is None


def test_setup_cells_differ_only_in_extra_and_demo_loading():
    """01 と 02 のセットアップセルは、INSTALL_EXTRA とデモ設定の読み込み以外は同じ。"""
    intro = source(setup_cell(load(NOTEBOOKS["intro"])))
    main = source(setup_cell(load(NOTEBOOKS["main"])))
    marker = "# 4. デモ設定"
    intro_common = intro.split(marker)[0].replace('INSTALL_EXTRA = "intro"', 'INSTALL_EXTRA = "X"')
    main_common = main.split(marker)[0].replace('INSTALL_EXTRA = "main"', 'INSTALL_EXTRA = "X"')
    assert intro_common == main_common
    assert marker in intro and marker in main


def test_setup_cells_are_colab_forms_with_explicit_settings():
    """セットアップは Colab のフォーム表示で、REPO_URL などを明示している。"""
    for path in NOTEBOOKS.values():
        cell = setup_cell(load(path))
        text = source(cell)
        assert cell["metadata"].get("cellView") == "form"
        assert text.startswith("# @title ")
        for name in ("REPO_URL = ", "REPO_REF = ", "CHECKOUT_DIR = ", "PROJECT_DIR = ", "OUTPUT_DIR = "):
            assert name in text, f"{path.name}: {name} がありません"
        assert 'REPO_URL = "https://github.com/shogo-ishikawa/2026_3Q_M4Th4.git"' in text
        assert "clone --branch" not in text  # SHA を clone --branch に渡さない


def test_repo_ref_matches_readme_links():
    """Notebook が取得する版（REPO_REF）と、README のリンク先のブランチが同じ。"""
    refs = set()
    for path in NOTEBOOKS.values():
        match = re.search(r'^REPO_REF = "([^"]+)"', source(setup_cell(load(path))), flags=re.M)
        refs.add(match.group(1))
    assert len(refs) == 1
    ref = refs.pop()
    readme = (PROJECT_DIR / "README.md").read_text(encoding="utf-8")
    for path in NOTEBOOKS.values():
        link = f"https://github.com/shogo-ishikawa/2026_3Q_M4Th4/blob/{ref}/projects/park-itinerary-lab/notebooks/{path.name}"
        assert link in readme


def test_notebook_version_matches_package():
    from park_itinerary_lab import __version__

    for path in NOTEBOOKS.values():
        assert f'NOTEBOOK_VERSION = "{__version__}"' in source(setup_cell(load(path)))


OLD_PULP_NAMES = {"LpStatus", "PULP_CBC_CMD"}


def _old_pulp_uses(tree):
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr in OLD_PULP_NAMES:
            found.append(node.attr)
        if isinstance(node, ast.Name) and node.id in OLD_PULP_NAMES:
            found.append(node.id)
        if isinstance(node, ast.Call):
            name = getattr(node.func, "attr", getattr(node.func, "id", ""))
            if name == "LpVariable" and any(keyword.arg == "cat" for keyword in node.keywords):
                found.append("LpVariable(cat=...)")
    return found


def test_no_old_pulp_api_in_code():
    """PuLP 4.2 で使えない古い書き方（LpStatus, PULP_CBC_CMD, LpVariable(cat=...)）をコードで使っていない。"""
    for path in sorted((PROJECT_DIR / "src").rglob("*.py")):
        assert _old_pulp_uses(ast.parse(path.read_text(encoding="utf-8"))) == [], path.name
    for path in NOTEBOOKS.values():
        for cell in load(path)["cells"]:
            if cell["cell_type"] == "code":
                assert _old_pulp_uses(ast.parse(source(cell))) == [], path.name


def test_init_does_not_import_solvers():
    """01 が OR-Tools なしで動くよう、パッケージの __init__.py はソルバーを読み込まない。"""
    tree = ast.parse((PROJECT_DIR / "src" / "park_itinerary_lab" / "__init__.py").read_text(encoding="utf-8"))
    imported = [node for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom))]
    assert imported == []


def test_intro_module_does_not_need_ortools():
    tree = ast.parse((PROJECT_DIR / "src" / "park_itinerary_lab" / "intro.py").read_text(encoding="utf-8"))
    modules = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            modules.add(node.module.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            modules.add("." + (node.module or ""))
    assert "ortools" not in modules
    assert not any(module.startswith(".") for module in modules)


def test_validator_does_not_use_the_model():
    """検証関数は最適化モデル（model.py）や利用案の作成（options.py）を使わずに計算し直す。"""
    tree = ast.parse((PROJECT_DIR / "src" / "park_itinerary_lab" / "validate.py").read_text(encoding="utf-8"))
    relative = {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.level == 1}
    assert relative <= {"timeutil"}
