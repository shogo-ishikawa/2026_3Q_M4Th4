"""独立な正解器（bruteforce.py）が、作品の他のモジュールやサードパーティのライブラリを使っていないことの確認。

正解器は、本体のモデル（model.py）や検証関数（validate.py）と同じ誤りを共有しないように、
標準ライブラリだけで書いています。ここでは、ソースコードを構文木（ast）として読んで
import 文を調べます。さらに、別のプロセスでこのファイルだけを読み込み、実際に読み込まれた
モジュールも確かめます。
"""

import ast
import pathlib
import subprocess
import sys

BRUTEFORCE = (pathlib.Path(__file__).resolve().parents[1]
              / "src" / "park_itinerary_lab" / "bruteforce.py")
STANDARD_LIBRARY = set(sys.stdlib_module_names)


def syntax_tree():
    """bruteforce.py を構文木として読む。"""
    return ast.parse(BRUTEFORCE.read_text(encoding="utf-8"))


def import_statements():
    """bruteforce.py の import 文を (モジュール名, 相対 import の深さ) のリストにする。"""
    found = []
    for node in ast.walk(syntax_tree()):
        if isinstance(node, ast.Import):
            found += [(alias.name, 0) for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            found.append((node.module or "", node.level))
    return found


def test_import_statements_are_found():
    """（確認の前提）import 文を読み取れている。"""
    assert ("math", 0) in import_statements()


def test_no_relative_imports():
    """from . import ... のような相対 import がない。"""
    assert [name for name, level in import_statements() if level > 0] == []


def test_no_park_itinerary_lab_imports():
    """park_itinerary_lab（作品の他のモジュール）を import していない。"""
    names = [name for name, _level in import_statements()]
    assert [name for name in names if name.split(".")[0] == "park_itinerary_lab"] == []


def test_only_standard_library_modules():
    """import しているのは標準ライブラリのモジュールだけ。"""
    top_level = {name.split(".")[0] for name, _level in import_statements()}
    assert top_level - STANDARD_LIBRARY == set()


def test_no_dynamic_imports():
    """__import__・importlib・exec・eval で、import 文を使わずにモジュールを読み込んでいない。"""
    forbidden = {"__import__", "importlib", "import_module", "exec", "eval"}
    used = set()
    for node in ast.walk(syntax_tree()):
        if isinstance(node, ast.Name) and node.id in forbidden:
            used.add(node.id)
        elif isinstance(node, ast.Attribute) and node.attr in forbidden:
            used.add(node.attr)
    assert used == set()


STANDALONE_CHECK = """
import importlib.util
import sys

before = set(sys.modules)
spec = importlib.util.spec_from_file_location("standalone_bruteforce", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print("\\n".join(sorted(set(sys.modules) - before - {"standalone_bruteforce"})))
"""


def test_file_loads_alone_with_standard_library_only():
    """別のプロセスで bruteforce.py を（パッケージの外の単独のファイルとして）読み込める。

    相対 import があれば読み込みに失敗し、作品や他のライブラリを読み込めば一覧に現れる。
    """
    completed = subprocess.run([sys.executable, "-I", "-c", STANDALONE_CHECK, str(BRUTEFORCE)],
                               capture_output=True, text=True, timeout=60)
    assert completed.returncode == 0, completed.stderr
    loaded = {name.split(".")[0] for name in completed.stdout.split()}
    assert "park_itinerary_lab" not in loaded
    assert loaded - STANDARD_LIBRARY == set()
