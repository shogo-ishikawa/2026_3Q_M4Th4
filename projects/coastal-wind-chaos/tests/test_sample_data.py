"""合成データ：再現性、成分の切り替え、前線の予兆、観測の表し方を確かめる。"""

import numpy as np
import pandas as pd
import pytest

from coastal_wind_chaos import sample_data
from coastal_wind_chaos import wind_pipeline as wp


def truth_for(preset, **changes):
    return sample_data.simulate_truth(sample_data.make_settings(preset, years=1, seed=21, **changes))


def test_same_seed_gives_the_same_file_and_another_seed_does_not(tmp_path):
    for name, seed in [("a.csv", 1), ("b.csv", 1), ("c.csv", 2)]:
        sample_data.generate_sample_csv(tmp_path / name, years=1, seed=seed)
    assert (tmp_path / "a.csv").read_bytes() == (tmp_path / "b.csv").read_bytes()
    assert (tmp_path / "a.csv").read_bytes() != (tmp_path / "c.csv").read_bytes()


def test_components_can_be_switched_off():
    periodic = truth_for("periodic_only")
    for name in ["background", "ar", "front"]:
        assert (periodic[f"u_{name}"] == 0).all() and (periodic[f"v_{name}"] == 0).all()
    with_ar = truth_for("periodic_ar")
    assert with_ar["u_ar"].std() > 0.5
    assert (with_ar["u_front"] == 0).all() and (with_ar["u_background"] == 0).all()
    no_periodic = truth_for("default", use_periodic=False)
    assert (no_periodic["u_periodic"] == 0).all()


def test_switching_one_component_keeps_the_others_unchanged():
    full = truth_for("default")
    periodic_ar = truth_for("periodic_ar")
    stronger_fronts = truth_for("default", front_strength=2.0)
    np.testing.assert_allclose(full["u_ar"], periodic_ar["u_ar"])
    np.testing.assert_allclose(full["u_periodic"], periodic_ar["u_periodic"])
    np.testing.assert_allclose(full["u_background"], stronger_fronts["u_background"])
    np.testing.assert_allclose(2 * full["u_front"], stronger_fronts["u_front"])


def test_strength_scales_the_ar_component():
    weak = truth_for("periodic_ar", ar_strength=0.5)
    strong = truth_for("periodic_ar", ar_strength=2.0)
    assert strong["u_ar"].std() == pytest.approx(4 * weak["u_ar"].std(), rel=1e-9)


def test_periodic_only_repeats_every_day_apart_from_the_slow_seasonal_change():
    truth = truth_for("periodic_only")
    day_to_day = (truth["u_true"] - truth["u_true"].shift(24)).abs().max()
    assert day_to_day < 0.1


def test_sea_breeze_by_day_and_land_breeze_at_night():
    truth = truth_for("periodic_only")
    summer = truth[truth.index.month.isin([5, 6, 7, 8])]
    by_hour = summer.groupby(summer.index.hour)["v_periodic"].mean()
    assert by_hour.loc[14] > 2.0    # 午後は南から吹く（北向き v > 0）
    assert by_hour.loc[3] < 0.0     # 夜は北寄り（v < 0）


def test_fronts_with_and_without_precursor():
    """予兆の有無で前線の時刻と強さは同じ。違いは通過前12時間の「予兆」の部分だけ。"""
    with_sign = truth_for("default")
    without_sign = truth_for("no_precursor")
    passages = np.flatnonzero(with_sign["hours_since_front"].to_numpy() == 0)
    assert len(passages) > 20
    difference = (with_sign["v_front"] - without_sign["v_front"]).to_numpy()
    in_precursor = np.zeros(len(difference), dtype=bool)
    for passage in passages:
        in_precursor[max(passage - 12, 0):passage] = True
    assert np.all(difference[~in_precursor] == 0)
    passage = passages[passages > 24][0]
    ramp = difference[passage - 12:passage]
    assert np.all(ramp > 0) and np.all(np.diff(ramp) > 0)  # 南寄りの風が通過直前に向けて強まる


def test_calm_label_and_quantised_directions():
    settings = sample_data.make_settings("default", years=1, seed=21)
    observed = sample_data.observe(sample_data.simulate_truth(settings), settings)
    labels = observed["wind_direction"].dropna()
    assert set(labels) <= set(wp.DIRECTION_LABELS) | {wp.CALM_LABEL}
    calm = observed["wind_direction"] == wp.CALM_LABEL
    assert (observed.loc[calm, "wind_speed_ms"] <= wp.CALM_SPEED_MS).all()
    assert (observed.loc[~calm & observed["wind_speed_ms"].notna(), "wind_speed_ms"] > wp.CALM_SPEED_MS).all()
    missing = observed["wind_speed_ms_quality"] == 1
    assert missing.sum() > 0 and observed.loc[missing, "wind_speed_ms"].isna().all()


def test_observation_error_is_at_least_the_16_point_rounding():
    settings = sample_data.make_settings("default", years=1, seed=21, observation_noise_ms=0.0)
    truth = sample_data.simulate_truth(settings)
    weather = wp.prepare_weather(sample_data.observe(truth, settings))
    error = sample_data.observation_error_summary(weather, truth)
    assert 4.5 < error < 7.0  # 22.5度刻みに丸めると平均約5.6度ずれる


def test_settings_are_checked():
    with pytest.raises(ValueError, match="未知の設定"):
        sample_data.make_settings("default", arr_strength=1.0)
    with pytest.raises(ValueError, match="ar_phi"):
        sample_data.make_settings("default", ar_phi=1.0)
    with pytest.raises(ValueError, match="プリセット"):
        sample_data.make_settings("everything")


def test_generate_weather_matches_reading_the_csv(tmp_path):
    sample_data.generate_sample_csv(tmp_path / "sample.csv", "periodic_ar", years=1, seed=4)
    from_csv = wp.load_weather(tmp_path / "sample.csv")
    direct = sample_data.generate_weather("periodic_ar", years=1, seed=4)
    columns = ["u_ms", "v_ms", "wind_direction_deg", "temperature_c", "sunshine_h", "sea_level_pressure_hpa"]
    np.testing.assert_allclose(from_csv[columns].to_numpy(float), direct[columns].to_numpy(float), equal_nan=True)


def test_truth_file_round_trip_and_front_timing(tmp_path):
    sample_data.generate_sample_csv(tmp_path / "s.csv", years=1, seed=8, truth_path=tmp_path / "t.csv")
    truth = sample_data.read_truth_csv(tmp_path / "t.csv")
    assert isinstance(truth.index, pd.DatetimeIndex) and len(truth) == 365 * 24
    passage = truth.index[truth["hours_since_front"] == 0][3]
    hours = sample_data.hours_from_nearest_front(truth, [passage - pd.Timedelta(hours=2), passage])
    np.testing.assert_allclose(hours, [-2.0, 0.0])
