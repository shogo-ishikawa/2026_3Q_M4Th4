"""風向の変換と、角度の差・平均の計算を確かめる。"""

import numpy as np
import pytest

from coastal_wind_chaos import wind_pipeline as wp


@pytest.mark.parametrize("label, degrees", [
    ("北", 0.0), ("北北東", 22.5), ("東", 90.0), ("南", 180.0), ("西", 270.0), ("北北西", 337.5), (" 南 ", 180.0),
])
def test_direction_label_to_degrees(label, degrees):
    assert wp.direction_label_to_degrees(label) == degrees


@pytest.mark.parametrize("label", ["静穏", "", "×", "///", None, np.nan])
def test_calm_blank_and_unknown_labels_have_no_direction(label):
    assert np.isnan(wp.direction_label_to_degrees(label))


def test_degrees_to_label_round_trip_and_nearest_label():
    degrees = np.arange(16) * 22.5
    assert list(wp.degrees_to_direction_label(degrees)) == wp.DIRECTION_LABELS
    assert list(wp.degrees_to_direction_label([359.0, 11.0, 12.0, 348.0])) == ["北", "北", "北北東", "北北西"]


def test_undefined_direction_has_no_label():
    assert list(wp.degrees_to_direction_label([0.0, np.nan, 90.0])) == ["北", None, "東"]


@pytest.mark.parametrize("direction, expected_u, expected_v", [
    (0.0, 0.0, -2.0),    # 北風（北から吹く）は南向き：v < 0
    (90.0, -2.0, 0.0),   # 東風は西向き：u < 0
    (180.0, 0.0, 2.0),   # 南風は北向き：v > 0
    (270.0, 2.0, 0.0),   # 西風は東向き：u > 0
])
def test_wind_to_uv_uses_meteorological_convention(direction, expected_u, expected_v):
    u, v = wp.wind_to_uv(2.0, direction)
    assert u == pytest.approx(expected_u, abs=1e-12)
    assert v == pytest.approx(expected_v, abs=1e-12)


def test_uv_to_direction_is_inverse_of_wind_to_uv_near_the_boundary():
    directions = np.array([0.0, 0.1, 1.0, 89.9, 180.0, 270.0, 359.0, 359.9])
    speeds = np.array([0.5, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0])
    u, v = wp.wind_to_uv(speeds, directions)
    back = wp.uv_to_direction(u, v)
    assert np.all((back >= 0) & (back < 360))
    assert np.max(wp.angular_error(directions, back)) < 1e-9


def test_no_wind_has_no_direction():
    assert np.isnan(wp.uv_to_direction(0.0, 0.0))


@pytest.mark.parametrize("direction", [360.0, 720.0, -360.0])
def test_north_wind_comes_back_near_0_and_never_as_360(direction):
    u, v = wp.wind_to_uv(5.0, direction)
    back = wp.uv_to_direction(u, v)
    assert 0.0 <= back < 360.0
    assert wp.angular_error(0.0, back) < 1e-9


def test_normalise_degrees_keeps_the_range_0_to_360():
    values = wp.normalise_degrees([-10.0, 0.0, 360.0, 725.0, -1e-15, np.nan])
    np.testing.assert_allclose(values[:5], [350.0, 0.0, 0.0, 5.0, 0.0])
    assert np.isnan(values[5])


def test_angular_difference_wraps_at_0_and_360():
    assert wp.angular_difference(350.0, 10.0) == pytest.approx(20.0)
    assert wp.angular_difference(10.0, 350.0) == pytest.approx(-20.0)
    assert wp.angular_error(0.0, 180.0) == pytest.approx(180.0)
    differences = wp.angular_difference(np.arange(0, 720, 7.0), np.arange(0, 1440, 14.0) - 1e-15)
    assert np.all((differences >= -180) & (differences < 180))


def test_circular_mean_differs_from_naive_mean():
    assert np.mean([350.0, 10.0]) == pytest.approx(180.0)  # 普通の平均では南になってしまう
    assert wp.circular_mean_deg([350.0, 10.0]) == 0.0
    assert wp.circular_mean_deg([90.0, 180.0]) == pytest.approx(135.0)


def test_circular_mean_of_opposite_directions_is_undefined():
    """北と南のように打ち消し合うと、平均の向きは決まらない（NaN）。欠損は無視する。"""
    assert np.isnan(wp.circular_mean_deg([0.0, 180.0]))
    assert np.isnan(wp.circular_mean_deg([90.0, 270.0, 0.0, 180.0]))
    assert wp.circular_mean_deg([0.0, 180.0, np.nan, 90.0]) == pytest.approx(90.0)


def test_random_direction_guess_has_expected_error_of_90_degrees():
    rng = np.random.default_rng(0)
    for true_directions in [np.zeros(200_000), rng.uniform(0, 360, 200_000), np.full(200_000, 337.5)]:
        errors = wp.random_direction_errors(true_directions, seed=1)
        assert errors.mean() == pytest.approx(wp.RANDOM_DIRECTION_EXPECTED_ERROR_DEG, abs=0.5)
