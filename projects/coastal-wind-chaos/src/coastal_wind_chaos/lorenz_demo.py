"""ローレンツ系（Lorenz, 1963）で、初期値のわずかな違いが広がる様子を調べる実験。

この実験は、風向きの機械学習予測とは独立しています。ローレンツ系は、外から
乱数を加えなくても未来が一通りに決まる「決定論的」な系ですが、初期値の
小さな違いが指数関数的に広がります（初期値鋭敏性、カオス）。

ここで使う時間は、ローレンツ系の無次元の時間です。時間や日には換算しません。
換算の仕方を決めれば「何時間で外れる」という数字はいくらでも作れてしまうため、
実際の天気の予測限界を表すものとして読まないでください。

対照として、安定なAR(1)過程（相関のある確率変動）の双子実験も用意します。
AR(1)では初期値の差は縮み、予測が外れる原因は新しく加わる乱数です。
"""

import numpy as np
import pandas as pd

SIGMA = 10.0
RHO = 28.0
BETA = 8.0 / 3.0
DEFAULT_DT = 0.01

# σ=10, ρ=28, β=8/3 のときの最大リアプノフ指数の文献値（約0.906）。
# 推定結果が妥当かどうかを確かめる目安として使う。
REFERENCE_LYAPUNOV_EXPONENT = 0.9056


def lorenz_tendency(state):
    """状態 (x, y, z) の時間変化率を返す。

    state の最後の次元が x, y, z の3つであれば、複数の状態をまとめて計算できる。
    """
    x = state[..., 0]
    y = state[..., 1]
    z = state[..., 2]
    dx = SIGMA * (y - x)
    dy = x * (RHO - z) - y
    dz = x * y - BETA * z
    return np.stack([dx, dy, dz], axis=-1)


def rk4_step(state, dt=DEFAULT_DT):
    """4次のルンゲ・クッタ法で、状態を dt だけ進める。"""
    k1 = lorenz_tendency(state)
    k2 = lorenz_tendency(state + 0.5 * dt * k1)
    k3 = lorenz_tendency(state + 0.5 * dt * k2)
    k4 = lorenz_tendency(state + dt * k3)
    return state + dt * (k1 + 2 * k2 + 2 * k3 + k4) / 6


def run_lorenz(initial_state, n_steps, dt=DEFAULT_DT):
    """初期状態から n_steps 回進めた軌道を返す。

    戻り値の形は (n_steps + 1, ..., 3) で、先頭が初期状態。
    """
    state = np.asarray(initial_state, dtype=float)
    trajectory = np.empty((n_steps + 1,) + state.shape)
    trajectory[0] = state
    for step in range(n_steps):
        state = rk4_step(state, dt)
        trajectory[step + 1] = state
    return trajectory


def attractor_points(n_points, seed=0, dt=DEFAULT_DT, spinup_steps=3000, spacing_steps=200):
    """アトラクタ（軌道が集まる領域）の上の点を n_points 個選ぶ。

    はじめに spinup_steps 回だけ進めて初期値の影響を消し、その後は
    spacing_steps 回ごとに点を取り出す。
    """
    rng = np.random.default_rng(seed)
    start = np.array([1.0, 1.0, 20.0]) + rng.normal(0.0, 1.0, size=3)
    n_steps = spinup_steps + spacing_steps * n_points
    trajectory = run_lorenz(start, n_steps, dt)
    return trajectory[spinup_steps + spacing_steps :: spacing_steps][:n_points]


def random_perturbations(n_points, size, seed=0):
    """大きさが size で、向きがランダムな小さなずれを n_points 個作る。"""
    rng = np.random.default_rng(seed)
    directions = rng.normal(size=(n_points, 3))
    directions = directions / np.linalg.norm(directions, axis=1, keepdims=True)
    return size * directions


def twin_distances(start_points, perturbation_size, n_steps, dt=DEFAULT_DT, seed=0):
    """各出発点と、少しだけずらした初期値の「双子」を同時に進め、距離の変化を返す。

    戻り値:
        times: 形 (n_steps + 1,) の時刻（無次元）
        distances: 形 (n_steps + 1, 出発点の数) の距離
    """
    start_points = np.asarray(start_points, dtype=float)
    shifted = start_points + random_perturbations(len(start_points), perturbation_size, seed)
    pair = np.stack([start_points, shifted])  # 形 (2, 出発点の数, 3)
    trajectory = run_lorenz(pair, n_steps, dt)
    distances = np.linalg.norm(trajectory[:, 1] - trajectory[:, 0], axis=-1)
    times = dt * np.arange(n_steps + 1)
    return times, distances


def twin_runs(start_point, perturbation_size, n_steps, dt=DEFAULT_DT, seed=0):
    """1つの出発点について、元の軌道と少しずらした軌道の x と、2つの距離を表で返す。"""
    start_point = np.asarray(start_point, dtype=float)
    shifted = start_point + random_perturbations(1, perturbation_size, seed)[0]
    trajectory = run_lorenz(np.stack([start_point, shifted]), n_steps, dt)  # 形 (n_steps + 1, 2, 3)
    return pd.DataFrame({
        "time": dt * np.arange(n_steps + 1),
        "x_reference": trajectory[:, 0, 0],
        "x_shifted": trajectory[:, 1, 0],
        "distance": np.linalg.norm(trajectory[:, 1] - trajectory[:, 0], axis=-1),
    })


def first_time_above(times, distances, tolerance):
    """距離が初めて tolerance を超えた時刻を、出発点ごとに返す（超えなければ NaN）。"""
    above = distances > tolerance
    first_index = np.argmax(above, axis=0)
    reach_times = times[first_index].astype(float)
    reach_times[~above.any(axis=0)] = np.nan
    return reach_times


def predictability_table(start_points, perturbation_sizes, tolerance=1.0, n_steps=3000,
                         dt=DEFAULT_DT, seed=0):
    """初期誤差の大きさごとに、距離が tolerance に達するまでの時間をまとめる。

    出発点によって広がり方が違うため、中央値と四分位数（25%, 75%）で示す。
    """
    rows = []
    for size in perturbation_sizes:
        times, distances = twin_distances(start_points, size, n_steps, dt, seed)
        reach_times = first_time_above(times, distances, tolerance)
        reached = np.isfinite(reach_times)
        rows.append({
            "initial_error": size,
            "median_time": np.median(reach_times[reached]) if reached.any() else np.nan,
            "q25_time": np.percentile(reach_times[reached], 25) if reached.any() else np.nan,
            "q75_time": np.percentile(reach_times[reached], 75) if reached.any() else np.nan,
            "n_reached": int(reached.sum()),
            "n_start_points": len(reach_times),
        })
    return pd.DataFrame(rows)


def typical_log_distance(distances):
    """出発点ごとの距離の対数を平均する（幾何平均の対数）。"""
    return np.mean(np.log(distances), axis=1)


def fit_growth_rate(times, distances, lower, upper):
    """距離が lower から upper の間にある区間で、距離の対数の傾き（成長率）を求める。

    指数関数的に広がる区間では log(距離) が時間に対してほぼ直線になり、
    その傾きは最大リアプノフ指数の目安になる。
    """
    log_distance = typical_log_distance(distances)
    in_range = (log_distance > np.log(lower)) & (log_distance < np.log(upper))
    if in_range.sum() < 10:
        raise ValueError(
            "距離が lower から upper の範囲にある時間が短すぎて、傾きを求められません。"
            "lower・upper・n_steps を見直してください。距離がそもそも増えていない"
            "（カオスでない。例：RHO = 20）場合にも、このエラーになります。"
        )
    slope, _ = np.polyfit(times[in_range], log_distance[in_range], 1)
    return slope


def estimate_lyapunov_benettin(start_point, n_steps=20000, dt=DEFAULT_DT, separation=1e-8, seed=0):
    """Benettin らの方法で、最大リアプノフ指数を推定する。

    小さなずれを1ステップ進めるたびに、伸びた倍率の対数を足し合わせ、
    ずれの大きさを元の separation に戻す（向きはそのまま）。
    """
    reference = np.asarray(start_point, dtype=float)
    shifted = reference + random_perturbations(1, separation, seed)[0]
    total_log_growth = 0.0
    for _ in range(n_steps):
        pair = rk4_step(np.stack([reference, shifted]), dt)
        reference = pair[0]
        gap = pair[1] - pair[0]
        gap_size = np.linalg.norm(gap)
        total_log_growth += np.log(gap_size / separation)
        shifted = reference + gap * (separation / gap_size)
    return total_log_growth / (n_steps * dt)


def time_step_check(start_points, dts=(0.01, 0.005), perturbation_sizes=(1e-8, 1e-4), tolerance=1.0,
                    total_time=35.0, benettin_time=100.0, seed=0):
    """積分の刻み dt を小さくしても、結果がほぼ変わらないことを確かめる（数値計算の確認）。

    同じ出発点と同じずれを使い、dt ごとに「距離が tolerance に達するまでの時間」の中央値と、
    Benettin法による最大リアプノフ指数を求める。時間はどれも無次元で、同じ total_time まで進める。
    dt を小さくすると計算の回数が増えるので、時間がかかる。
    """
    rows = []
    for dt in dts:
        n_steps = int(round(total_time / dt))
        table = predictability_table(start_points, perturbation_sizes, tolerance, n_steps, dt, seed)
        lyapunov = estimate_lyapunov_benettin(start_points[0], int(round(benettin_time / dt)), dt)
        table.insert(0, "dt", dt)
        table["tolerance"] = tolerance
        table["benettin_lyapunov"] = lyapunov
        rows.append(table)
    return pd.concat(rows, ignore_index=True)


def ar1_twin(phi=0.85, n_steps=48, initial_gap=1.0, noise_std=1.0, seed=0):
    """同じ乱数（外乱）を与えた2つのAR(1)過程を、初期値だけ変えて進める。

    x[k+1] = phi * x[k] + e[k] で |phi| < 1 なら、2つの差は phi**k 倍に縮む。
    初期値の小さな違いが広がるローレンツ系とは逆の振る舞いになる。
    """
    rng = np.random.default_rng(seed)
    noise = rng.normal(0.0, noise_std, size=n_steps)
    run_a = np.zeros(n_steps + 1)
    run_b = np.zeros(n_steps + 1)
    run_b[0] = initial_gap
    for k in range(n_steps):
        run_a[k + 1] = phi * run_a[k] + noise[k]
        run_b[k + 1] = phi * run_b[k] + noise[k]
    return pd.DataFrame({
        "step": np.arange(n_steps + 1),
        "run_a": run_a,
        "run_b": run_b,
        "gap": np.abs(run_b - run_a),
    })


def ar1_forecast_error_std(phi=0.85, noise_std=1.0, n_steps=48):
    """AR(1)過程を「最良の方法」で予測したときの誤差の標準偏差（理論値）。

    k ステップ先の誤差の分散は noise_std**2 * (1 - phi**(2k)) / (1 - phi**2)。
    初期値が正確に分かっていても、これから加わる乱数は予測できないため誤差が増え、
    過程そのもののばらつき（noise_std / sqrt(1 - phi**2)）で頭打ちになる。
    """
    steps = np.arange(n_steps + 1)
    variance = noise_std**2 * (1 - phi ** (2 * steps)) / (1 - phi**2)
    return pd.DataFrame({"step": steps, "error_std": np.sqrt(variance)})
