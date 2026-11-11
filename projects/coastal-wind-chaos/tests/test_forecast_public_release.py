"""公開用の初期設定と、解析の入口を横断して確かめる。"""

from coastal_wind_chaos import forecast_app as app
from coastal_wind_chaos import forecast_export as saved
from coastal_wind_chaos import forecast_sources as sources
from coastal_wind_chaos import sample_data


def test_default_coordinates_are_public_station_preset():
    default = sources.LOCATIONS["wakkanai"]
    assert default["station_id"] == "11016"
    assert default["kind"] == "observation_station"
    assert app._coordinates({}) == (default["latitude"], default["longitude"])
    assert set(sources.LOCATIONS) == {"choshi", "wakkanai", "coastal_example"}


def test_generated_jma_format_csv_remains_synthetic(tmp_path):
    path = tmp_path / "demo.csv"
    sample_data.generate_sample_csv(path, years=1, missing_rate=0)
    weather = saved.load_observations([path])
    assert weather.attrs["source_kind"] == "synthetic"


def test_demo_does_not_read_old_input_files(tmp_path, monkeypatch):
    def must_not_read(*_):
        raise AssertionError("デモでは以前のCSVを読んではいけません")
    class Done(Exception):
        pass
    monkeypatch.setattr(app, "load_observations", must_not_read)
    monkeypatch.setattr(app.sample_data, "generate_weather", lambda **kwargs: (_ for _ in ()).throw(Done()))
    import pytest
    with pytest.raises(Done):
        app.run_analysis("demo", [tmp_path / "missing-old.csv"], output_dir=tmp_path)
