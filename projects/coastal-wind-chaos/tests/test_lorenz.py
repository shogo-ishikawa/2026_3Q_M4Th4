"""ローレンツ系の実験と、安定なAR(1)の対照実験を確かめる。"""

import numpy as np
import pytest

from coastal_wind_chaos import lorenz_demo as ld


@pytest.fixture(scope="module")
def points():
    return ld.attractor_points(8, seed=3)


def test_lorenz_is_deterministic(points):
    first = ld.run_lorenz(points[0], 500)
    second = ld.run_lorenz(points[0], 500)
    assert np.array_equal(first, second)


def test_tiny_differences_grow_then_saturate(points):
    times, distances = ld.twin_distances(points, 1e-8, 3000)
    typical = np.exp(ld.typical_log_distance(distances))
    assert typical[1000] > 1e-6        # 時間10で100倍以上に広がる
    assert typical[-1] < 60            # アトラクタの大きさで頭打ち
    assert typical[-1] > 1.0


def test_growth_rate_is_close_to_the_largest_lyapunov_exponent(points):
    times, distances = ld.twin_distances(points, 1e-10, 3000)
    rate = ld.fit_growth_rate(times, distances, 1e-8, 1e-1)
    assert 0.75 < rate < 1.05


def test_benettin_estimate_is_close_to_the_reference_value(points):
    estimate = ld.estimate_lyapunov_benettin(points[0], n_steps=20000)
    assert abs(estimate - ld.REFERENCE_LYAPUNOV_EXPONENT) < 0.1


def test_ten_times_smaller_error_adds_only_about_ln10_over_lambda(points):
    table = ld.predictability_table(points, [1e-9, 1e-7, 1e-5, 1e-3], tolerance=1.0, n_steps=3500)
    assert (table["n_reached"] == len(points)).all()
    times = table["median_time"].to_numpy()
    assert np.all(np.diff(times) < 0)  # 初期誤差が大きいほど早く外れる
    per_decade = -np.polyfit(np.log10(table["initial_error"]), times, 1)[0]
    assert 1.8 < per_decade < 3.5     # ln(10) / 0.906 ≒ 2.5


def test_twin_runs_start_close_and_end_far_apart(points):
    runs = ld.twin_runs(points[0], 1e-6, 3000)
    assert runs["distance"].iloc[0] == pytest.approx(1e-6)
    assert runs["distance"].iloc[-1] > 1.0


def test_stable_ar1_twins_converge_instead_of_diverging():
    twin = ld.ar1_twin(phi=0.8, n_steps=30, initial_gap=1.0, seed=2)
    np.testing.assert_allclose(twin["gap"], 0.8 ** twin["step"], rtol=1e-9, atol=1e-12)


def test_ar1_forecast_error_grows_and_levels_off():
    error = ld.ar1_forecast_error_std(phi=0.85, noise_std=1.0, n_steps=100)["error_std"].to_numpy()
    assert error[0] == 0 and np.all(np.diff(error) >= 0)
    assert error[-1] == pytest.approx(1 / np.sqrt(1 - 0.85**2), rel=1e-6)


def test_too_short_fit_range_is_reported(points):
    times, distances = ld.twin_distances(points, 1e-2, 100)
    with pytest.raises(ValueError, match="短すぎ"):
        ld.fit_growth_rate(times, distances, 10.0, 20.0)
