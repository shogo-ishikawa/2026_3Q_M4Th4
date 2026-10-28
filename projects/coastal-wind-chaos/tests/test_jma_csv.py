"""気象庁形式CSVの読込を、実際のダウンロードファイルと同じ構造の小さな例で確かめる。

例の値とダウンロード時刻は、テストのために作ったもの（実際の観測値ではない）。
見出しの構造・真夜中の書き方・品質情報・現象なし情報・静穏の表し方は、
気象庁「過去の気象データ・ダウンロード」のCSVの書き方に合わせた。
"""

import numpy as np
import pandas as pd
import pytest
from conftest import write_text

from coastal_wind_chaos import sample_data
from coastal_wind_chaos import wind_pipeline as wp

HEADER_OFFICE = [
    "ダウンロードした時刻：2000/1/1 00:00:00",
    "",
    "," + ",".join(["テスト地点"] * 22),
    "年月日時,気温(℃),気温(℃),気温(℃),降水量(mm),降水量(mm),降水量(mm),降水量(mm),"
    "日照時間(時間),日照時間(時間),日照時間(時間),日照時間(時間),"
    "風速(m/s),風速(m/s),風速(m/s),風速(m/s),風速(m/s),"
    "現地気圧(hPa),現地気圧(hPa),現地気圧(hPa),海面気圧(hPa),海面気圧(hPa),海面気圧(hPa)",
    ",,,,,,,,,,,,,,風向,風向,,,,,,,",
    ",,品質情報,均質番号,,現象なし情報,品質情報,均質番号,,現象なし情報,品質情報,均質番号,"
    ",品質情報,,品質情報,均質番号,,品質情報,均質番号,,品質情報,均質番号",
]
ROWS_OFFICE = [
    "2024/2/28 22:00:00,7.6,8,1,0,1,8,1,0,1,8,1,2.7,8,北北東,8,1,1012.4,8,1,1013.1,8,1",
    "2024/2/28 23:00:00,7.1,8,1,0,1,8,1,0,1,8,1,0.1,8,静穏,8,1,1012.6,8,1,1013.3,8,1",
    "2024/2/29 00:00:00,6.9,8,1,0,1,8,1,0,1,8,1,2.4,8,南,8,1,1012.8,8,1,1013.5,8,1",
    "2024/2/29 1:00:00,,1,1,,,1,1,,,1,1,,1,,1,1,,1,1,,1,1",  # 欠測：値と現象なし情報は空欄
    "2024/2/29 2:00:00,5.1,4,1,0.0,0,8,1,0,1,8,1,1.8,8,西,8,1,1012.9,8,1,1013.6,8,1",
    "2024/2/29 9:00:00,8.3,8,1,0,1,8,1,0.6,0,8,1,3.3,8,東,8,1,1013.4,8,1,1014.1,8,1",
]

HEADER_AMEDAS = [
    "ダウンロードした時刻：2000/1/1 00:00:00",
    "",
    "," + ",".join(["テスト地点"] * 20),
    "年月日時,気温(℃),気温(℃),気温(℃),降水量(mm),降水量(mm),降水量(mm),"
    "日照時間(時間),日照時間(時間),日照時間(時間),風速(m/s),風速(m/s),風速(m/s),風速(m/s),風速(m/s),"
    "現地気圧(hPa),現地気圧(hPa),現地気圧(hPa),海面気圧(hPa),海面気圧(hPa),海面気圧(hPa)",
    ",,,,,,,,,,,,風向,風向,,,,,,,",
    ",,品質情報,均質番号,,品質情報,均質番号,,品質情報,均質番号,,品質情報,,品質情報,均質番号,"
    ",品質情報,均質番号,,品質情報,均質番号",
]
ROWS_AMEDAS = [
    "2024/2/28 6:00:00,3.2,8,1,0.0,8,1,,8,1,2.6,8,西北西,8,1,,0,1,,0,1",
    "2024/2/28 7:00:00,4.4,8,1,0.0,8,1,0.5,8,1,3.3,8,北西,8,1,,0,1,,0,1",
]


def at(text):
    return pd.Timestamp(text)


def office_row(time, temperature):
    """気象台の形式の1行（気温だけ変えられる）。"""
    clock = sample_data.format_time_jma(time)
    return f"{clock},{temperature},8,1,0,1,8,1,0,1,8,1,2.0,8,北,8,1,1012.0,8,1,1013.0,8,1"


@pytest.fixture
def office_csv(tmp_path):
    return write_text(tmp_path / "office.csv", HEADER_OFFICE + ROWS_OFFICE)


def test_reads_office_layout_column_names_and_midnight(office_csv):
    raw = wp.read_jma_csv(office_csv)
    for column in ["temperature_c", "temperature_c_quality", "sunshine_h_no_phenomenon", "wind_speed_ms",
                   "wind_speed_ms_quality", "wind_direction", "wind_direction_quality",
                   "wind_speed_ms_homogeneity", "station_pressure_hpa", "sea_level_pressure_hpa"]:
        assert column in raw.columns
    # 「2024/2/29 00:00:00」は 2/28 の24時 = 2/29 の0時
    assert at("2024-02-29 00:00") in raw.index
    assert raw.loc[at("2024-02-29 00:00"), "wind_direction"] == "南"
    assert raw.attrs["station"] == "テスト地点"


def test_prepare_weather_handles_calm_missing_quality_and_no_phenomenon(office_csv):
    weather = wp.prepare_weather(wp.read_jma_csv(office_csv))
    # 静穏：風向なし、u = v = 0
    calm = weather.loc[at("2024-02-28 23:00")]
    assert calm["wind_is_calm"] and np.isnan(calm["wind_direction_deg"])
    assert calm["u_ms"] == 0.0 and calm["v_ms"] == 0.0
    # 欠測（品質情報1）はすべて欠損
    missing = weather.loc[at("2024-02-29 01:00")]
    assert np.isnan(missing["temperature_c"]) and np.isnan(missing["u_ms"])
    # 資料不足値（品質情報4）は既定では使わない
    assert np.isnan(weather.loc[at("2024-02-29 02:00"), "temperature_c"])
    # 夜の日照時間（現象なし）は 0、昼の値はそのまま
    assert weather.loc[at("2024-02-28 22:00"), "sunshine_h"] == 0.0
    assert weather.loc[at("2024-02-29 09:00"), "sunshine_h"] == pytest.approx(0.6)
    # 南風（南から吹く）は北向き：v > 0
    assert weather.loc[at("2024-02-29 00:00"), "v_ms"] == pytest.approx(2.4)


def test_only_normal_values_are_used_by_default_and_quality_5_can_be_chosen(tmp_path):
    rows = [ROWS_OFFICE[0].replace("7.6,8,1,", "7.6,5,1,", 1), ROWS_OFFICE[2].replace("6.9,8,1,", "6.9,2,1,", 1)]
    raw = wp.read_jma_csv(write_text(tmp_path / "q.csv", HEADER_OFFICE + rows))
    assert wp.DEFAULT_MIN_QUALITY == 8
    weather = wp.prepare_weather(raw)
    assert np.isnan(weather.loc[at("2024-02-28 22:00"), "temperature_c"])  # 既定では準正常値（5）も使わない
    with_semi_normal = wp.prepare_weather(raw, min_quality=5)  # 準正常値を使うと明示したとき
    assert with_semi_normal.loc[at("2024-02-28 22:00"), "temperature_c"] == pytest.approx(7.6)
    for weather in [weather, with_semi_normal]:
        assert np.isnan(weather.loc[at("2024-02-29 00:00"), "temperature_c"])  # 疑問値（2）は使わない


def test_min_quality_can_accept_insufficient_data(office_csv):
    weather = wp.prepare_weather(wp.read_jma_csv(office_csv), min_quality=4)
    assert weather.loc[at("2024-02-29 02:00"), "temperature_c"] == pytest.approx(5.1)


def test_missing_hours_become_rows_so_shift_means_hours(office_csv):
    weather = wp.prepare_weather(wp.read_jma_csv(office_csv))
    assert len(weather) == 12  # 22時〜翌9時の12時間。3〜8時は行がなかった
    assert np.isnan(weather.loc[at("2024-02-29 05:00"), "u_ms"])
    wp.check_hourly(weather)


def test_amedas_layout_night_sunshine_and_unobserved_pressure(tmp_path):
    path = write_text(tmp_path / "amedas.csv", HEADER_AMEDAS + ROWS_AMEDAS)
    weather = wp.prepare_weather(wp.read_jma_csv(path))
    assert weather.loc[at("2024-02-28 06:00"), "sunshine_h"] == 0.0  # 空欄だが品質は正常（夜）
    assert weather.loc[at("2024-02-28 07:00"), "sunshine_h"] == pytest.approx(0.5)
    assert weather["sea_level_pressure_hpa"].isna().all()  # 品質情報0：観測していない
    summary = dict(wp.summarise_weather(weather).to_numpy())
    assert "観測していない" in summary["sea_level_pressure_hpa が欠損の時刻"]


def test_blank_sunshine_with_low_quality_never_becomes_zero(tmp_path):
    rows = [ROWS_AMEDAS[0].replace(",,8,1,2.6,", ",,0,1,2.6,", 1),   # 観測していない（0）
            ROWS_AMEDAS[1].replace(",0.5,8,1,", ",,1,1,", 1)]        # 欠測（1）
    weather = wp.prepare_weather(wp.read_jma_csv(write_text(tmp_path / "low.csv", HEADER_AMEDAS + rows)),
                                 min_quality=0)
    assert weather["sunshine_h"].isna().all()


def test_split_date_columns_with_hour_24_match_literal_dates(tmp_path):
    literal = write_text(tmp_path / "literal.csv", [
        "ダウンロードした時刻：2000/1/1 00:00:00", "", "," + ",".join(["テスト地点"] * 8),
        "年月日時,気温(℃),気温(℃),気温(℃),風速(m/s),風速(m/s),風速(m/s),風速(m/s),風速(m/s)",
        ",,,,,,風向,風向,",
        ",,品質情報,均質番号,,品質情報,,品質情報,均質番号",
        "2024/2/28 23:00:00,7.3,8,1,2.7,8,北東,8,1",
        "2024/2/29 00:00:00,6.9,8,1,2.4,8,北北東,8,1",
        "2024/2/29 1:00:00,6.6,8,1,2.1,8,北北東,8,1",
    ])
    split = write_text(tmp_path / "split.csv", [
        "ダウンロードした時刻：2000/1/1 00:00:00", "", ",,,," + ",".join(["テスト地点"] * 8),
        "年,月,日,時,気温(℃),気温(℃),気温(℃),風速(m/s),風速(m/s),風速(m/s),風速(m/s),風速(m/s)",
        ",,,,,,,,,風向,風向,",
        ",,,,,品質情報,均質番号,,品質情報,,品質情報,均質番号",
        "2024,2,28,23,7.3,8,1,2.7,8,北東,8,1",
        "2024,2,28,24,6.9,8,1,2.4,8,北北東,8,1",
        "2024,2,29,1,6.6,8,1,2.1,8,北北東,8,1",
    ])
    from_literal = wp.read_jma_csv(literal)
    from_split = wp.read_jma_csv(split)
    pd.testing.assert_frame_equal(from_literal, from_split)
    assert from_split.index[1] == at("2024-02-29 00:00")


def test_dates_resaved_with_hyphens_are_read(tmp_path, office_csv):
    rows = [row.replace("2024/2/28 22:00:00", "2024-02-28 22:00:00") for row in ROWS_OFFICE]
    resaved = wp.read_jma_csv(write_text(tmp_path / "iso.csv", HEADER_OFFICE + rows))
    pd.testing.assert_frame_equal(resaved, wp.read_jma_csv(office_csv))


def test_trailing_empty_columns_from_a_spreadsheet_are_ignored(tmp_path, office_csv):
    lines = [line + ",," for line in HEADER_OFFICE + ROWS_OFFICE]
    pd.testing.assert_frame_equal(wp.read_jma_csv(write_text(tmp_path / "wide.csv", lines)),
                                  wp.read_jma_csv(office_csv))


def test_symbol_mode_file_gives_a_clear_error(tmp_path):
    path = write_text(tmp_path / "symbol.csv", [
        "ダウンロードした時刻：2000/1/1 00:00:00", "", ",テスト地点,テスト地点",
        ",気温(℃),気温(℃)", ",,均質番号", "2024年2月28日1時,5.9,1",
    ])
    with pytest.raises(ValueError, match="すべて数値で格納"):
        wp.read_jma_csv(path)


def test_several_stations_in_one_file_are_rejected(tmp_path):
    path = write_text(tmp_path / "two.csv", [
        "ダウンロードした時刻：2000/1/1 00:00:00", "", ",地点A,地点A,地点A,地点B,地点B,地点B",
        "年月日時,気温(℃),気温(℃),気温(℃),気温(℃),気温(℃),気温(℃)",
        ",,品質情報,均質番号,,品質情報,均質番号",
        "2024/2/28 1:00:00,5.9,8,1,6.0,8,1",
    ])
    with pytest.raises(ValueError, match="複数の地点"):
        wp.read_jma_csv(path)


def test_two_stations_with_the_same_name_are_rejected(tmp_path):
    path = write_text(tmp_path / "same_name.csv", [
        "ダウンロードした時刻：2000/1/1 00:00:00", "", ",高松,高松,高松,高松,高松,高松",
        "年月日時,気温(℃),気温(℃),気温(℃),気温(℃),気温(℃),気温(℃)",
        ",,品質情報,均質番号,,品質情報,均質番号",
        "2024/2/28 1:00:00,5.9,8,1,6.0,8,1",
    ])
    with pytest.raises(ValueError, match="同じ名前の列"):
        wp.read_jma_csv(path)


def test_files_joined_into_one_file_are_rejected(tmp_path):
    lines = HEADER_OFFICE + ROWS_OFFICE[:2] + HEADER_OFFICE + ROWS_OFFICE[2:]
    with pytest.raises(ValueError, match="見出し行が2回以上"):
        wp.read_jma_csv(write_text(tmp_path / "joined.csv", lines))


def test_file_without_wind_cannot_be_prepared(tmp_path):
    path = write_text(tmp_path / "nowind.csv", [
        "ダウンロードした時刻：2000/1/1 00:00:00", "", ",テスト地点,テスト地点,テスト地点",
        "年月日時,気温(℃),気温(℃),気温(℃)", ",,品質情報,均質番号", "2024/2/28 1:00:00,5.9,8,1",
    ])
    raw = wp.read_jma_csv(path)
    with pytest.raises(ValueError, match="風向・風速"):
        wp.prepare_weather(raw)


def test_station_that_does_not_observe_wind_gets_a_clear_error(tmp_path):
    rows = [row.replace(",2.6,8,西北西,8,1,", ",,0,,0,1,").replace(",3.3,8,北西,8,1,", ",,0,,0,1,")
            for row in ROWS_AMEDAS]
    raw = wp.read_jma_csv(write_text(tmp_path / "rain_only.csv", HEADER_AMEDAS + rows))
    with pytest.raises(ValueError, match="観測していません"):
        wp.prepare_weather(raw)


@pytest.mark.parametrize("encoding", ["cp932", "utf-8", "utf-8-sig"])
def test_encoding_is_detected(tmp_path, encoding):
    path = write_text(tmp_path / "office.csv", HEADER_OFFICE + ROWS_OFFICE, encoding=encoding)
    assert wp.read_jma_csv(path).loc[at("2024-02-29 00:00"), "wind_direction"] == "南"


def test_several_files_are_joined_without_duplicate_times(tmp_path):
    first = write_text(tmp_path / "a.csv", HEADER_OFFICE + ROWS_OFFICE[:3])
    second = write_text(tmp_path / "b.csv", HEADER_OFFICE + ROWS_OFFICE[2:])
    joined = wp.read_jma_csv([second, first])
    assert joined.index.is_monotonic_increasing and not joined.index.has_duplicates
    assert len(joined) == len(ROWS_OFFICE)


def test_overlapping_files_keep_the_values_of_the_first_file(tmp_path):
    header = HEADER_OFFICE
    old_times = pd.date_range("2024-03-01 01:00", periods=48, freq=pd.Timedelta(hours=1))
    new_times = pd.date_range("2024-03-02 01:00", periods=48, freq=pd.Timedelta(hours=1))
    old = write_text(tmp_path / "old.csv", header + [office_row(time, 10.0) for time in old_times])
    new = write_text(tmp_path / "new.csv", header + [office_row(time, 20.0) for time in new_times])
    overlap = old_times.intersection(new_times)
    assert len(overlap) == 24
    assert (wp.read_jma_csv([old, new]).loc[overlap, "temperature_c"] == 10.0).all()
    assert (wp.read_jma_csv([new, old]).loc[overlap, "temperature_c"] == 20.0).all()


def test_files_from_different_stations_or_options_are_not_joined(tmp_path):
    first = write_text(tmp_path / "a.csv", HEADER_OFFICE + ROWS_OFFICE[:3])
    other_station = [line.replace("テスト地点", "別の地点") for line in HEADER_OFFICE]
    second = write_text(tmp_path / "b.csv", other_station + ROWS_OFFICE[3:])
    with pytest.raises(ValueError, match="別の地点"):
        wp.read_jma_csv([first, second])
    plain = write_text(tmp_path / "c.csv", [
        "ダウンロードした時刻：2000/1/1 00:00:00", "", ",テスト地点,テスト地点,テスト地点",
        "年月日時,気温(℃),風速(m/s),風速(m/s)", ",,,風向", ",,,", "2024/3/1 1:00:00,5.9,2.5,北東",
    ])
    with pytest.raises(ValueError, match="項目や表示オプション"):
        wp.read_jma_csv([first, plain])


def test_homogeneity_change_is_reported(tmp_path):
    rows = [ROWS_OFFICE[0], ROWS_OFFICE[2].replace("6.9,8,1,", "6.9,8,2,", 1)]
    path = write_text(tmp_path / "moved.csv", HEADER_OFFICE + rows)
    changes = wp.homogeneity_changes(wp.prepare_weather(wp.read_jma_csv(path)))
    assert changes == {"temperature_c": ["2024-02-29 00:00:00"]}


def test_synthetic_csv_round_trip_keeps_every_value(tmp_path):
    settings = sample_data.make_settings("default", years=1, seed=5, missing_rate=0.01)
    observed = sample_data.observe(sample_data.simulate_truth(settings), settings)
    path = sample_data.write_jma_csv(observed, tmp_path / "synthetic.csv", settings)
    raw = wp.read_jma_csv(path)
    assert list(raw.columns) == list(observed.columns)
    assert raw.index.equals(observed.index)
    for column in observed.columns:
        if column == "wind_direction":
            assert raw[column].fillna("").tolist() == observed[column].fillna("").tolist()
        else:
            np.testing.assert_allclose(raw[column].to_numpy(float), observed[column].to_numpy(float), equal_nan=True)


def test_synthetic_csv_looks_like_a_jma_download_but_says_it_is_synthetic(tmp_path):
    settings = sample_data.generate_sample_csv(tmp_path / "sample.csv", years=1, seed=3)
    lines = (tmp_path / "sample.csv").read_bytes().decode("cp932").split("\r\n")
    assert "合成データ" in lines[0] and "気象庁の観測値ではありません" in lines[0]
    assert lines[1] == ""
    assert lines[3].startswith("年月日時,気温(℃),")
    assert lines[4].split(",")[10:12] == ["風向", "風向"]
    assert lines[6].startswith("2023/1/1 1:00:00,")
    assert lines[-2].startswith("2024/1/1 00:00:00,")
    night = lines[6].split(",")
    assert night[4:6] == ["0", "1"]  # 夜の日照時間は「0」、現象なし情報は 1
    assert settings["seed"] == 3
    missing = [line.split(",") for line in lines[6:-1] if line.split(",")[2] == "1"]
    assert missing, "欠測の行があるはず"
    assert missing[0][4:7] == ["", "", "1"]  # 欠測：日照時間・現象なし情報は空欄、品質情報は 1


def test_prefecture_row_above_the_station_row_is_accepted(tmp_path):
    lines = HEADER_OFFICE[:2] + ["," + ",".join(["テスト県"] * 22)] + HEADER_OFFICE[2:] + ROWS_OFFICE
    weather = wp.load_weather(write_text(tmp_path / "pref.csv", lines))
    assert weather.loc[at("2024-02-29 00:00"), "wind_direction"] == "南"


def test_file_without_quality_columns_does_not_use_sunshine(tmp_path):
    path = write_text(tmp_path / "plain.csv", [
        "ダウンロードした時刻：2000/1/1 00:00:00", "", ",テスト地点,テスト地点,テスト地点,テスト地点",
        "年月日時,気温(℃),日照時間(時間),風速(m/s),風速(m/s)",
        ",,,,風向", ",,,,",
        "2024/2/28 1:00:00,5.9,,2.5,北東",
        "2024/2/28 2:00:00,5.6,,0.1,静穏",
        "2024/2/28 12:00:00,8.0,0.7,2.0,南",
    ])
    weather = wp.load_weather(path)
    assert weather.loc[at("2024-02-28 01:00"), "wind_direction_deg"] == 45.0
    # 品質情報も現象なし情報もないと、夜の空欄と欠測を区別できないので日照時間は使わない
    assert weather["sunshine_h"].isna().all()
    assert "sunshine_now" not in wp.recent_columns(wp.make_forecast_table(weather, 1))
    summary = dict(wp.summarise_weather(weather).to_numpy())
    assert summary["品質情報の列"].startswith("なし")
    assert summary["均質番号が変わった時刻（観測環境の変化。ファイルの境目も含む）"].startswith("均質番号の列なし")


def test_daytime_blank_sunshine_is_reported(tmp_path):
    rows = [ROWS_AMEDAS[0], ROWS_AMEDAS[1].replace("2024/2/28 7:00:00", "2024/2/28 12:00:00").replace(",0.5,8,1,", ",,8,1,")]
    weather = wp.prepare_weather(wp.read_jma_csv(write_text(tmp_path / "noon.csv", HEADER_AMEDAS + rows)))
    summary = dict(wp.summarise_weather(weather).to_numpy())
    value = summary["空欄を0時間とした日照時間（全体／10〜14時）"]
    assert value.startswith("2／1") and "欠測の可能性" in value
