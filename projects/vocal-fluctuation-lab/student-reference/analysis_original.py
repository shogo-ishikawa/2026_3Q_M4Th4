# 元のセル先頭は !pip install yt-dlp です。ここでは関数部分だけを保存します。
import os
import re
import numpy as np
import matplotlib.pyplot as plt
import librosa
import yt_dlp  # 6行目: ハイフン(yt-dlp)からアンダーバー(yt_dlp)に変更
import subprocess

def is_url(path_or_url: str) -> bool:
    return bool(re.match(r'^https?://', path_or_url))

def download_audio_from_youtube(url: str, output_template: str) -> str:
    print(f"[INFO] ダウンロード中: {url}")
    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': output_template,
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '192',
        }],
        'quiet': True,
        'no_warnings': True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])
    return f"{output_template}.mp3"

def separate_vocals_demucs(audio_path: str, output_dir: str = "separated") -> str:
    """Demucsで歌声のみをAI抽出"""
    cmd = [
        "demucs",
        "--two-stems=vocals",
        "-o", output_dir,
        audio_path
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    filename_stem = os.path.splitext(os.path.basename(audio_path))[0]
    return os.path.join(output_dir, "htdemucs", filename_stem, "vocals.wav")

def compare_artists_1f_fluctuation(tracks_dict: dict, duration_sec: float = 30.0, start_sec: float = 0.0):
    """
    複数曲のボーカル音源から1/fゆらぎを抽出し、一つのグラフ上で比較する

    :param tracks_dict: {"曲名・アーティスト名": "ファイルパスまたはURL"}
    """
    results = []
    plt.figure(figsize=(12, 7))

    # 描画用のカラーマップ設定
    colors = plt.cm.tab10(np.linspace(0, 1, len(tracks_dict)))

    for idx, (label, source) in enumerate(tracks_dict.items()):
        print(f"\n[解析開始 ({idx+1}/{len(tracks_dict)})] : {label}")
        temp_file = None
        target_file = source

        try:
            # URLの場合は自動ダウンロード
            if is_url(source):
                safe_filename = f"temp_track_{idx}"
                target_file = download_audio_from_youtube(source, safe_filename)
                temp_file = target_file

            # ボーカル分離処理
            vocal_file = separate_vocals_demucs(target_file)

            # 歌声データロード
            y, sr = librosa.load(vocal_file, sr=None, mono=True, offset=start_sec, duration=duration_sec)

            # FFTとパワースペクトル算出
            num_samples = len(y)
            fft_spectrum = np.fft.rfft(y)
            freqs = np.fft.rfftfreq(num_samples, d=1/sr)
            power_spectrum = np.abs(fft_spectrum) ** 2

            # 人の声の帯域（100Hz〜8000Hz）をフィルタリング
            valid_idx = (freqs >= 100) & (freqs <= 8000) & (power_spectrum > 0)
            f_valid = freqs[valid_idx]
            p_valid = power_spectrum[valid_idx]

            # 対数変換と直線のフィッティング (傾き alpha)
            log_f = np.log10(f_valid)
            log_p = np.log10(p_valid)
            alpha, intercept = np.polyfit(log_f, log_p, 1)

            # フィッティングラインをグラフに追加
            plt.plot(log_f, alpha * log_f + intercept, color=colors[idx], linewidth=2.5,
                     label=f'{label} (α = {alpha:.2f})')

            results.append((label, alpha))

        except Exception as e:
            print(f"[ERROR] {label} の解析中にエラーが発生しました: {e}")

        finally:
            if temp_file and os.path.exists(temp_file):
                os.remove(temp_file)

    # グラフのスタイリング
    plt.axhline(y=0, color='gray', linestyle=':', alpha=0.5)
    plt.title('1/f Fluctuation Comparison - Multi Artist Vocals', fontsize=14, fontweight='bold')
    plt.xlabel('Log10(Frequency [Hz])', fontsize=12)
    plt.ylabel('Log10(Power Spectrum)', fontsize=12)
    plt.grid(True, which="both", linestyle="--", alpha=0.5)
    plt.legend(fontsize=11, loc='upper right')
    plt.tight_layout()
    plt.show()

    # 解析データのスコア順（1/fゆらぎ度が高い順）ランキング出力
    print("\n" + "="*55)
    print(" 🌟 1/fゆらぎ度（傾き α が -1.0 に近い順）ランキング")
    print("="*55)
    results_sorted = sorted(results, key=lambda x: abs(x[1] - (-1.0)))

    for rank, (name, alpha) in enumerate(results_sorted, 1):
        diff = abs(alpha - (-1.0))
        print(f" {rank}位 : {name:<20} | 傾き α = {alpha:.2f} (1/fとの誤差: {diff:.2f})")
    print("="*55)

