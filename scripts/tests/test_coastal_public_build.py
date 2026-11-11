"""Pagesへ解析入力やローカル生成物を混ぜず、配布用の版をそろえる。"""

import importlib.util
from pathlib import Path
import subprocess
import zipfile


def test_public_build_uses_selected_assets_and_tracked_distribution_only(tmp_path, monkeypatch):
    repository = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location("public_site_builder", repository / "scripts/build_public_site.py")
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    monkeypatch.setattr(builder, "ROOT", tmp_path)
    project = tmp_path / "projects/coastal-wind-chaos"
    (project / "web").mkdir(parents=True)
    (project / "notebooks").mkdir()
    (project / "pyproject.toml").write_text('[project]\nversion="1.1.0"\n')
    for name in builder.COASTAL_WEB_FILES:
        (project / "web" / name).write_text("public asset")
    (project / "notebooks/lab.ipynb").write_text("{}")
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    # 共有された端末上で、Webフォルダや解析結果にファイルが残っている場合も想定する。
    (project / "web/private-input.csv").write_text("not public")
    (project / "results").mkdir()
    (project / "results/model.joblib").write_text("not public")
    archive = builder.build_coastal_site(tmp_path / "output")
    public = tmp_path / "output/coastal-wind-chaos"
    assert (public / "index.html").is_file()
    assert not (public / "private-input.csv").exists()
    assert not (public / "notebooks").exists()
    assert archive.name == "CoastalWindLab_v1.1.0.zip"
    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        assert "v1.1.0/notebooks/lab.ipynb" in names
        assert all(name.startswith("v1.1.0/") for name in names)
        assert not any("private-input" in name or "model.joblib" in name for name in names)
