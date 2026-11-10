"""ColabとJupyterで使う、音源入力と解析結果の操作画面。"""
from __future__ import annotations

import csv
from contextlib import nullcontext
import html
import json
import math
from pathlib import Path
import shutil
import tempfile
from typing import Any
from uuid import uuid4
from zipfile import ZipFile, ZIP_DEFLATED


AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac", ".aiff", ".aif", ".webm"}
MAX_UPLOAD_BYTES = 512 * 1024 * 1024

# FileUploadの標準ビューは説明に件数を付けます。ファイル入力の動作を保ち、
# この音源ボタンだけを固定ラベルで表示します（widget自体がbuttonの版にも対応）。
UPLOAD_BUTTON_CSS = """<style>
button.vocal-audio-upload, .vocal-audio-upload button {
  font-size: 0 !important;
}
button.vocal-audio-upload::after, .vocal-audio-upload button::after {
  content: "音源を選ぶ";
  font-size: 14px;
}
button.vocal-audio-upload .fa, .vocal-audio-upload button .fa {
  display: none !important;
}
</style>"""


def uploaded_files(value: Any) -> list[dict]:
    """ipywidgets 7/8のアップロード値を、同じリストへ整理します。"""
    if isinstance(value, dict):
        return [dict(item, name=name) for name, item in value.items()]
    return [dict(item) for item in value or ()]


def save_audio_upload(value: Any, directory: Path) -> Path:
    records = uploaded_files(value)
    if len(records) != 1:
        raise ValueError("解析する音源ファイルを1つ選んでください。")
    record = records[0]
    extension = Path(str(record.get("name", ""))).suffix.lower()
    if extension not in AUDIO_EXTENSIONS:
        raise ValueError("MP3、WAV、M4A、FLACなどの音源ファイルを選んでください。")
    content = bytes(record.get("content", b""))
    if not content or len(content) > MAX_UPLOAD_BYTES:
        raise ValueError("空のファイル、または512 MiBを超えるファイルは使えません。")
    directory.mkdir(parents=True, exist_ok=True)
    # アップロード時の名前をパスとして使わず、作業用の名前にします。
    path = directory / ("upload_" + uuid4().hex + extension)
    path.write_bytes(content)
    return path


def validate_audio_path(value: str | Path) -> Path:
    """実行環境の既存音源を確認します。入力ファイルには書き込みません。"""
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError("/content/ などで始まる音源ファイルの絶対パスを入力してください。")
    if path.suffix.lower() not in AUDIO_EXTENSIONS:
        raise ValueError("MP3、WAV、M4A、FLACなどの音源ファイルを選んでください。")
    if not path.is_file():
        raise ValueError("指定した音源が見つかりません。ファイルのアップロード完了とパスを確認してください。")
    if not 0 < path.stat().st_size <= MAX_UPLOAD_BYTES:
        raise ValueError("空のファイル、または512 MiBを超えるファイルは使えません。")
    return path.resolve()


def validate_interval(start: float, end: float) -> tuple[float, float]:
    from .audio import validate_interval as validate_audio_interval
    if end is None:
        raise ValueError("終了秒を入力するか、「曲全体を解析」を選んでください。")
    return validate_audio_interval(start, end)


def create_audio_preview(source: str | Path, directory: Path) -> Path:
    """全長WAVを埋め込まず、画面専用の短い圧縮音源を別に作ります。"""
    from .audio import _run, require_tool

    source = Path(source).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / ("preview_" + uuid4().hex + ".mp3")
    try:
        _run([require_tool("ffmpeg"), "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
              "-i", str(source), "-t", "30", "-map", "0:a:0", "-vn", "-ac", "2", "-ar", "22050",
              "-c:a", "libmp3lame", "-b:a", "96k", str(destination)], "試聴音源の準備", timeout=60)
        if not destination.is_file() or not 0 < destination.stat().st_size <= 374_000:
            raise ValueError("試聴音源の大きさを確認できません。")
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    return destination


def _number(value: Any, digits: int = 3) -> str:
    try:
        return f"{float(value):.{digits}f}" if math.isfinite(float(value)) else "—"
    except (TypeError, ValueError):
        return "—"


def _band_rows(analysis: dict) -> list[dict]:
    rows = analysis.get("band_sensitivity", [])
    if rows:
        return rows
    return [{"label": "主解析", "fit": analysis.get("fit", {}),
             "quality": analysis.get("quality", {}), "status": analysis.get("status", ""),
             "summary": analysis.get("summary", "")}]


def band_selection_html(analysis: dict) -> str:
    """長さから決めた帯域と、その時間スケールを表示します。"""
    selection = analysis.get("band_selection", {})
    if not selection:
        return ""
    mode = "自動" if selection.get("mode") == "auto" else "固定"
    details = (
        "<h3>今回の解析帯域</h3><p>" + mode + "："
        + _number(selection.get("actual_low_hz")) + "〜" + _number(selection.get("actual_high_hz"))
        + " Hz ／ 対応する変動の周期：約" + _number(selection.get("period_min_seconds"), 2)
        + "〜" + _number(selection.get("period_max_seconds"), 2)
        + "秒 ／ スペクトル計算の窓：" + _number(selection.get("welch_segment_seconds"), 2) + "秒</p>"
    )
    reason = selection.get("reason", "")
    if reason:
        details += "<p>" + html.escape(str(reason)) + "</p>"
    return details


def band_comparison_html(analysis: dict) -> str:
    """帯域を広げた結果を、5 Hzまでの結果と同じ場所で確かめます。"""
    rows = []
    for row in _band_rows(analysis):
        fit = row.get("fit", {})
        cells = [html.escape(str(row.get("label", ""))),
                 _number(fit.get("band_low_hz")) + "〜" + _number(fit.get("band_high_hz")),
                 _number(fit.get("slope")), _number(fit.get("r_squared")),
                 html.escape(str(row.get("summary", row.get("status", ""))))]
        rows.append("<tr>" + "".join("<td>" + value + "</td>" for value in cells) + "</tr>")
    return ("<h3>帯域による結果の違い</h3><p>同じ歌声を、広い帯域と5 Hzまでの帯域で比べます。"
            "傾きが−1に近くなる方だけを採用せず、両方の結果を確認してください。</p>"
            "<table><thead><tr><th>解析</th><th>使用帯域 [Hz]</th><th>傾き β</th><th>R²</th>"
            "<th>この帯域での評価</th></tr></thead><tbody>" + "".join(rows) + "</tbody></table>")


def plot_analysis(analysis: dict):
    """保存用と表示用で同じ図を使い、実測PSDと当てはめを区別します。"""
    from .plot_fonts import configure_plot_fonts
    configure_plot_fonts()
    import matplotlib.pyplot as plt
    import numpy as np

    series, spectrum, fit = (analysis.get(name, {}) for name in ("series", "spectrum", "fit"))
    fig, axes = plt.subplots(2, 1, figsize=(10, 7), constrained_layout=True)
    axes[0].plot(series.get("time_seconds", []), series.get("envelope", []), color="#27696b", linewidth=0.8)
    shortened = analysis.get("metadata", {}).get("preprocessing", {}).get("timeline_modified", False)
    time_label = "時間短縮後の経過時間 [秒]" if shortened else "解析開始からの経過時間 [秒]"
    axes[0].set(xlabel=time_label, ylabel="音の大きさ（RMS振幅）", title="歌声の音量の時間変化")
    frequencies = np.asarray(spectrum.get("frequency_hz", []), dtype=float)
    power = np.asarray(spectrum.get("power", []), dtype=float)
    valid = (frequencies > 0) & (power > 0) & np.isfinite(frequencies) & np.isfinite(power)
    # 表示外の阻止域の微小なPSDで縦軸が広がりすぎることを防ぎます。
    plot_low = max(float(fit.get("band_low_hz") or 0.02) / 2, 1e-6)
    plot_high = max(20.0, float(fit.get("band_high_hz") or 20.0)) * 1.1
    valid &= (frequencies >= plot_low) & (frequencies <= plot_high)
    axes[1].loglog(frequencies[valid], power[valid], color="#a8c1bd", linewidth=0.7, label="実測PSD（Welch法）")
    bin_f = np.asarray(spectrum.get("bin_frequency_hz", []), dtype=float)
    bin_p = np.asarray(spectrum.get("bin_power", []), dtype=float)
    if len(bin_f):
        axes[1].loglog(bin_f, bin_p, "o", markersize=4, color="#27696b", label="対数間隔でまとめた点")
    if fit.get("slope") is not None and len(bin_f):
        fitted = 10 ** (float(fit["intercept"]) + float(fit["slope"]) * np.log10(bin_f))
        axes[1].loglog(bin_f, fitted, color="#c9783c", linewidth=2, label=f"直線の当てはめ（傾き {_number(fit['slope'], 2)}）")
        middle = len(bin_f) // 2
        axes[1].loglog(bin_f, fitted[middle] * bin_f[middle] / bin_f, "--", color="#806795", label="1/fの基準線")
    for row in analysis.get("band_sensitivity", []):
        comparison = row.get("fit", {})
        comparison_high = comparison.get("band_high_hz")
        if (comparison.get("slope") is None or comparison.get("intercept") is None
                or comparison_high is None or float(comparison_high) > 5.0
                or comparison_high == fit.get("band_high_hz")):
            continue
        comparison_low = comparison.get("band_low_hz")
        if comparison_low is None or comparison_high <= comparison_low:
            continue
        points = np.geomspace(float(comparison_low), float(comparison_high), 80)
        prediction = 10 ** (float(comparison["intercept"]) + float(comparison["slope"]) * np.log10(points))
        axes[1].loglog(points, prediction, "--", color="#8d9cba", linewidth=1.3,
                       label="5 Hzまでの当てはめ（傾き " + _number(comparison["slope"], 2) + "）")
    low, high = fit.get("band_low_hz"), fit.get("band_high_hz")
    if low is not None and high is not None:
        axes[1].axvspan(float(low), float(high), color="#dce6cc", alpha=0.3)
        axes[1].set_title("歌声の音量ゆらぎのスペクトル（使用帯域 " + _number(low) + "〜" + _number(high) + " Hz）")
        axes[1].set_xlim(max(float(low) / 2, 1e-6), max(20.0, float(high)) * 1.1)
    else:
        axes[1].set_title("歌声の音量ゆらぎのスペクトル")
    axes[1].set(xlabel="音量が変わる速さ・変動周波数 [Hz]", ylabel="パワースペクトル密度（PSD）")
    axes[1].legend(loc="best")
    for axis in axes:
        axis.grid(True, alpha=0.25)
    return fig


def preprocessing_html(analysis: dict) -> str:
    """音源を短くした量と、グラフの時間軸の意味を表示します。"""
    report = analysis.get("metadata", {}).get("preprocessing", {})
    if not report:
        return ""
    message = "<h3>無音の調整</h3><p>調整前 " + _number(report.get("input_duration_seconds"), 2) + " 秒 → 調整後 " + _number(report.get("output_duration_seconds"), 2) + " 秒</p><p>先頭から除いた時間：" + _number(report.get("leading_removed_seconds"), 2) + " 秒 ／ 末尾：" + _number(report.get("trailing_removed_seconds"), 2) + " 秒 ／ 途中：" + _number(report.get("internal_removed_seconds"), 2) + " 秒</p>"
    if report.get("timeline_modified"):
        message += "<p><strong>途中の無音を除き、時間を短縮しています。</strong>グラフの横軸は時間短縮後の経過時間です。元の曲の時間変動とは条件が変わるため、同じ無音調整の設定で作った比較DBを使ってください。</p>"
    else:
        message += "<p>歌唱の途中の間（ま）は残しています。グラフの横軸は、解析に使った歌声の先頭からの経過時間です。</p>"
    return message


def export_results(analysis: dict, directory: Path) -> Path:
    """音源を含めず、再確認に必要な数値と図をZIPにまとめます。"""
    import matplotlib.pyplot as plt

    directory.mkdir(parents=True, exist_ok=True)
    (directory / "result.json").write_text(json.dumps(analysis, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    tables = [
        ("envelope.csv", analysis.get("series", {}), "time_seconds", "envelope"),
        ("spectrum.csv", analysis.get("spectrum", {}), "frequency_hz", "power"),
        ("binned_spectrum.csv", analysis.get("spectrum", {}), "bin_frequency_hz", "bin_power"),
    ]
    for filename, values, first, second in tables:
        with (directory / filename).open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow([first, second])
            writer.writerows(zip(values.get(first, []), values.get(second, [])))
    with (directory / "band_comparison.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["label", "band_low_hz", "band_high_hz", "slope", "r_squared", "status", "summary"])
        for row in _band_rows(analysis):
            fit = row.get("fit", {})
            writer.writerow([row.get("label", ""), fit.get("band_low_hz"), fit.get("band_high_hz"),
                             fit.get("slope"), fit.get("r_squared"), row.get("status", ""), row.get("summary", "")])
    figure = plot_analysis(analysis)
    figure.savefig(directory / "analysis.png", dpi=160)
    plt.close(figure)
    names = ["result.json", "envelope.csv", "spectrum.csv", "binned_spectrum.csv", "band_comparison.csv", "analysis.png"]
    archive_path = directory / "results.zip"
    with ZipFile(archive_path, "w", ZIP_DEFLATED) as archive:
        for name in names:
            archive.write(directory / name, name)
    return archive_path


def download_file(path: Path) -> None:
    """Colabではダウンロード、通常のJupyterではファイルリンクを表示します。"""
    try:
        from google.colab import files
    except ImportError:
        from IPython.display import FileLink, display
        try:
            relative = path.resolve().relative_to(Path.cwd().resolve())
        except ValueError:
            destination = Path.cwd() / "vocal_lab_downloads" / uuid4().hex
            destination.mkdir(parents=True, exist_ok=True)
            copied = destination / path.name
            shutil.copy2(path, copied)
            relative = copied.relative_to(Path.cwd())
        display(FileLink(relative.as_posix()))
    else:
        files.download(str(path))


def comparison_html(rows: list[dict]) -> str:
    if not rows:
        return ("<p>同じ解析条件の比較データがありません。比較DBを読み込むか、別の音源を同じ条件で登録してください。"
                "解析帯域、無音処理、歌声の分離方法が異なるデータや、今回と同じ音源・同じ区間は比較から除外します。</p>"
                "<p>自動モードは音源の長さによって帯域が変わります。曲どうしを比べる場合は、双方を"
                "「固定（比較DB用：0.2〜20 Hz）」で再解析して登録すると条件をそろえられます。"
                "旧版の比較DBも新しい方法で作り直してください。</p>")
    cells = []
    for index, row in enumerate(rows, 1):
        cells.append("<tr><td>" + str(index) + "</td><td>" + html.escape(str(row.get("artist", ""))) + "</td><td>" + _number(row.get("distance")) + "</td><td>" + html.escape(str(row.get("tracks_count", row.get("count", "—")))) + "</td><td>" + html.escape(str(row.get("track", ""))) + "</td><td>" + html.escape(str(row.get("coverage_label", ""))) + "</td></tr>")
    return "<p>登録曲の音量変動の特徴が近い順です。距離が小さいほど近く、声質・本人・歌唱力を識別する結果ではありません。</p><table><thead><tr><th>順</th><th>登録アーティスト</th><th>特徴量の距離</th><th>比較曲数</th><th>近い登録曲</th><th>登録範囲</th></tr></thead><tbody>" + "".join(cells) + "</tbody></table>"


class VocalNotebookUI:
    """入力→分離→解析→比較の状態を持つ小さな画面です。"""

    def __init__(self, workspace: str | Path | None = None, pipeline=None, database=None):
        import ipywidgets as widgets
        from IPython.display import display, HTML, Audio
        from . import __version__
        from .audio import MAX_SECONDS

        if pipeline is None:
            from .pipeline import run_analysis
            pipeline = run_analysis
        if database is None:
            from . import reference_db
            database = reference_db
        self.run_pipeline, self.db_api = pipeline, database
        self.display, self.HTML, self.Audio = display, HTML, Audio
        self.workspace = Path(workspace or (Path.cwd() / "vocal_lab_runs")).expanduser().resolve()
        self.workspace.mkdir(parents=True, exist_ok=True)
        try:
            from google.colab import files as colab_files
        except ImportError:
            colab_files = None
        self._colab_files = colab_files if callable(getattr(colab_files, "upload", None)) else None
        self._audio_input_path: Path | None = None
        self._audio_input_route: str | None = None
        self._audio_upload_busy = False
        self.database = self.db_api.empty_database()
        self.bundle = None
        self.results_zip = None
        self.version_banner = widgets.HTML(
            f"<p><strong>Vocal Fluctuation Lab v{html.escape(__version__)}</strong>"
            f" ／ 解析区間は最大{MAX_SECONDS / 60:g}分（{MAX_SECONDS:g}秒）</p>"
        )
        self.mode = widgets.ToggleButtons(options=[("ファイルをアップロード", "file"), ("YouTube URL", "youtube")])
        self.audio_upload = widgets.FileUpload(accept=",".join(sorted(AUDIO_EXTENSIONS)), multiple=False, description="音源を選ぶ")
        self.audio_upload.add_class("vocal-audio-upload")
        self.audio_upload.layout.width = "150px"
        self.audio_upload.tooltip = "解析する音源を1つ選びます。選び直すと前の音源を置き換えます。"
        self.audio_upload.layout.display = "none" if self._colab_files else ""
        self.colab_upload_button = widgets.Button(description="音源を選ぶ", layout=widgets.Layout(width="150px"))
        self.colab_upload_button.tooltip = "Colabの標準アップロードで音源を1つ選びます。転送が終わるまでお待ちください。"
        self.colab_upload_button.layout.display = "" if self._colab_files else "none"
        self.upload_output = widgets.Output()
        self.runtime_file_path = widgets.Text(
            description="音源のパス", placeholder="/content/vocals.wav", style={"description_width": "initial"},
            layout=widgets.Layout(width="95%"),
        )
        self.use_runtime_file_button = widgets.Button(description="このファイルを使う", layout=widgets.Layout(width="auto"))
        self.runtime_file_options = widgets.Accordion(children=[widgets.VBox([
            widgets.HTML("<p>大きなWAVなどを選んでも反映されない場合は、Colab左側のフォルダ欄から音源をアップロードし、完了後にファイルの「パスをコピー」を使って下に貼り付けてください。接続済みのDriveにある音源の絶対パスも使えます。元の音源は変更しません。</p>"),
            self.runtime_file_path, self.use_runtime_file_button,
        ])], selected_index=None)
        self.runtime_file_options.set_title(0, "Colab内のファイルを使う")
        self.upload_button_style = widgets.HTML(UPLOAD_BUTTON_CSS, layout=widgets.Layout(height="0px", margin="0"))
        self.selected_audio = widgets.HTML("<p>音源はまだ選ばれていません。新しく選ぶと置き換わります。前の音源は一緒に解析しません。</p>")
        self.url = widgets.Text(description="YouTube URL", placeholder="https://www.youtube.com/watch?v=…", layout=widgets.Layout(width="95%"), style={"description_width": "initial"})
        self.url.layout.display = "none"
        self.start = widgets.FloatText(value=0, description="開始（秒）", style={"description_width": "initial"})
        self.end = widgets.FloatText(value=90, description="終了（秒）", style={"description_width": "initial"})
        self.whole_track = widgets.Checkbox(value=False, description="曲全体を解析", indent=False, layout=widgets.Layout(width="auto"))
        self.reset_times_button = widgets.Button(description="秒数をリセット（0〜90秒）", layout=widgets.Layout(width="auto"))
        self.time_controls = widgets.VBox([
            widgets.HBox([self.start, self.end], layout=widgets.Layout(flex_flow="row wrap")),
            widgets.HTML("<p>秒数は元の音源の先頭から数えます。例：40秒から130秒なら、開始40・終了130です。10秒〜600秒（10分）を指定できます。</p>"),
        ])
        self.device = widgets.Dropdown(options=[("自動（GPUを優先）", "auto"), ("CPU", "cpu"), ("GPU（CUDA）", "cuda")], value="auto", description="処理装置", style={"description_width": "initial"})
        self.vocals_only = widgets.Checkbox(value=False, description="歌声だけの音源です（分離を省略）", indent=False, layout=widgets.Layout(width="auto"))
        self.analysis_mode = widgets.Dropdown(
            options=[("自動（音源の長さに合わせる）", "auto"), ("固定（比較DB用：0.2〜20 Hz）", "fixed")],
            value="auto", description="解析モード", style={"description_width": "initial"},
            layout=widgets.Layout(width="auto", max_width="100%"),
        )
        self.trim_edges = widgets.Checkbox(value=True, description="前後の無音を自動で除く", indent=False, layout=widgets.Layout(width="auto"))
        self.remove_internal = widgets.Checkbox(value=False, description="途中の無音も除く（時間を短縮）", indent=False, layout=widgets.Layout(width="auto"))
        self.threshold_db = widgets.FloatSlider(value=-40, min=-80, max=-10, step=1, description="無音のしきい値 [dB]", readout_format=".0f", style={"description_width": "initial"}, layout=widgets.Layout(width="95%"))
        self.min_silence_seconds = widgets.FloatSlider(value=0.5, min=0.1, max=5, step=0.1, description="除く無音の長さ [秒]", readout_format=".1f", style={"description_width": "initial"}, layout=widgets.Layout(width="95%"))
        self.silence_options = widgets.Accordion(children=[widgets.VBox([
            self.trim_edges, self.remove_internal, self.threshold_db, self.min_silence_seconds,
            widgets.HTML("<p>歌声の最大RMS振幅との差で、無音に近い部分を探します。−40 dBは最大RMS振幅の約1%です。小さい声まで除かれる場合は、しきい値を下げてください。途中の無音を除くと、時間をつなぎ替えた音源の解析になります。</p>"),
        ])], selected_index=None)
        self.silence_options.set_title(0, "無音の調整")
        self.analyse_button = widgets.Button(description="解析を始める", button_style="primary", icon="play")
        self.result_download = widgets.Button(description="結果ZIPを保存", disabled=True, icon="download")
        self.vocals_download = widgets.Button(description="無音調整後の歌声WAVを保存", disabled=True, icon="download", layout=widgets.Layout(width="auto"))
        self.raw_vocals_download = widgets.Button(description="無音調整前の歌声WAVを保存", disabled=True, icon="download", layout=widgets.Layout(width="auto"))
        self.status = widgets.HTML("<p>音源と区間を選んでください。最初は60〜90秒の歌唱区間がおすすめです。</p>")
        self.result_output = widgets.Output()
        self.db_upload = widgets.FileUpload(accept=".json", multiple=False, description="比較DBを読み込む")
        self.artist = widgets.Text(description="アーティスト名", placeholder="登録する歌い手の名前", style={"description_width": "initial"})
        self.track = widgets.Text(description="曲名", placeholder="同じ曲を重ねて登録しないようにします", style={"description_width": "initial"})
        self.add_reference_button = widgets.Button(description="この結果を比較DBへ追加", disabled=True)
        self.db_download = widgets.Button(description="比較DBを保存", icon="download")
        self.db_status = widgets.HTML("<p>実測済みの比較DBは、まだ読み込まれていません。複数曲を同じ条件で登録すると比較できます。</p>")
        self.comparison_output = widgets.HTML()
        self.mode.observe(self._switch_mode, names="value")
        self.audio_upload.observe(self._audio_selected, names="value")
        self.colab_upload_button.on_click(lambda button: self.upload_audio_from_colab())
        self.use_runtime_file_button.on_click(self._use_runtime_file)
        self.runtime_file_path.observe(self._runtime_file_edited, names="value")
        self.whole_track.observe(self._switch_whole_track, names="value")
        self.reset_times_button.on_click(self._reset_times)
        self.analyse_button.on_click(self._analyse)
        self.result_download.on_click(lambda button: download_file(self.results_zip) if self.results_zip else None)
        self.vocals_download.on_click(lambda button: download_file(Path(self.bundle["vocals_path"])) if self.bundle else None)
        self.raw_vocals_download.on_click(lambda button: download_file(Path(self.bundle["extracted_vocals_path"])) if self.bundle and self.bundle.get("extracted_vocals_path") else None)
        self.db_upload.observe(self._import_database, names="value")
        self.add_reference_button.on_click(self._add_reference)
        self.db_download.on_click(self._export_database)
        self.panel = widgets.VBox([
            self.version_banner, self.upload_button_style,
            widgets.HTML("<h2>1 音源と区間を選ぶ</h2><p>利用できる音源を使ってください。YouTubeから取得できない場合は、MP3やWAVをアップロードできます。音源はこの実行環境で処理し、公開DBへ自動送信しません。</p>"),
            self.mode, self.audio_upload, self.colab_upload_button, self.upload_output,
            self.runtime_file_options, self.selected_audio, self.url,
            self.whole_track, self.time_controls, self.reset_times_button,
            widgets.HTML("<p>曲全体を選ぶと、先頭から末尾まで解析します（最大10分）。初期設定では前後の無音を歌声抽出後に自動で除きます。無音調整後の長さが60秒未満のときは判定を保留します。</p>"),
            self.device, self.vocals_only,
            widgets.HTML("<p>保存済みの歌声WAVもアップロードして再解析できます。その場合は上の「歌声だけの音源です（分離を省略）」を選びます。再解析の自由度を残すには、無音調整前の全長WAVも保存してください。</p>"),
            self.analysis_mode,
            widgets.HTML("<p>自動モードは、無音調整後の音声の長さから低周波側とスペクトル計算の窓を決めます。高周波側は最大20 Hzを調べ、5 Hzまでの結果も併記します。固定モードは曲どうしの比較に使います。実際に使えた帯域は結果で確認できます。</p>"),
            self.silence_options, self.analyse_button, self.status,
            self.result_output, widgets.HBox([self.result_download, self.raw_vocals_download, self.vocals_download], layout=widgets.Layout(flex_flow="row wrap")),
            widgets.HTML("<h2>2 登録アーティストと比べる</h2><p>この比較は声の本人判定ではありません。音量変動の特徴を同じ方法で測った登録曲と比べます。比較DBは保存して、次回読み込めます。</p>"),
            self.db_upload, self.db_status, self.artist, self.track,
            widgets.HBox([self.add_reference_button, self.db_download], layout=widgets.Layout(flex_flow="row wrap")), self.comparison_output,
        ])

    def _switch_mode(self, change):
        file_mode = change["new"] == "file"
        self.audio_upload.layout.display = "" if file_mode and self._colab_files is None else "none"
        self.colab_upload_button.layout.display = "" if file_mode and self._colab_files is not None else "none"
        self.upload_output.layout.display = "" if file_mode else "none"
        self.runtime_file_options.layout.display = "" if file_mode else "none"
        self.selected_audio.layout.display = "" if change["new"] == "file" else "none"
        self.url.layout.display = "" if change["new"] == "youtube" else "none"

    def _reset_results(self):
        self.bundle, self.results_zip = None, None
        self.result_download.disabled = self.vocals_download.disabled = self.raw_vocals_download.disabled = self.add_reference_button.disabled = True
        self.result_output.clear_output(wait=False)
        self.comparison_output.value = ""

    def _clear_audio_selection(self):
        self._audio_input_path = None
        self._audio_input_route = None
        self.selected_audio.value = "<p>音源はまだ選ばれていません。新しく選ぶと置き換わります。前の音源は一緒に解析しません。</p>"
        self._reset_results()

    def _show_selected_audio(self, name: str, size: int):
        self.selected_audio.value = (
            "<p>今回の音源：<strong>" + html.escape(name) + "</strong>（"
            + html.escape(f"{size / (1024 * 1024):.1f} MiB")
            + "）<br>新しく選ぶと置き換わります。前の音源は一緒に解析しません。</p>"
        )
        self._set_status("音源を認識しました。今回の音源と区間を確認して、「解析を始める」を押してください。")

    def _audio_selected(self, change):
        """選択音源を明示し、選び直したときに前の解析結果を残しません。"""
        self._clear_audio_selection()
        try:
            records = uploaded_files(change["new"])
            if len(records) != 1:
                raise ValueError("解析する音源ファイルを1つ選んでください。")
            record = records[0]
            name = str(record.get("name", "音源ファイル"))
            if Path(name).suffix.lower() not in AUDIO_EXTENSIONS:
                raise ValueError("MP3、WAV、M4A、FLACなどの音源ファイルを選んでください。")
            size = memoryview(record.get("content", b"")).nbytes
            if not 0 < size <= MAX_UPLOAD_BYTES:
                raise ValueError("空のファイル、または512 MiBを超えるファイルは使えません。")
            self._audio_input_route = "widget"
            self._show_selected_audio(name, size)
        except Exception as error:
            self._set_status("音源を認識できませんでした：" + str(error))

    def upload_audio_from_colab(self, use_output: bool = True):
        """Colab標準転送を使います。Falseなら通常のセルへ直接表示します。"""
        if self._audio_upload_busy:
            self._set_status("音源を転送しています。完了するまでお待ちください。")
            return None
        self._clear_audio_selection()
        self.mode.value = "file"
        self._audio_upload_busy = True
        self.colab_upload_button.disabled = self.analyse_button.disabled = True
        self.use_runtime_file_button.disabled = self.audio_upload.disabled = True
        self.mode.disabled = True
        try:
            if self._colab_files is None:
                raise ValueError("この環境ではColab標準アップロードを使えません。音源選択かファイルのパス指定を使ってください。")
            self._set_status("音源を選び、転送が完了するまでお待ちください。ファイル名が表示されると解析できます。")
            upload_dir = Path(tempfile.mkdtemp(prefix="audio_upload_", dir=self.workspace)).resolve()
            if use_output:
                self.upload_output.clear_output(wait=False)
            with self.upload_output if use_output else nullcontext():
                received = self._colab_files.upload(target_dir=str(upload_dir))
            if not isinstance(received, dict) or len(received) != 1:
                raise ValueError("アップロードは未完了です。解析する音源ファイルを1つだけ選んでください。")
            # Colabが返すキーは、重複名の調整も済ませた実際の保存パスです。
            path = validate_audio_path(next(iter(received)))
            try:
                path.relative_to(upload_dir)
            except ValueError as error:
                raise ValueError("アップロード先の音源を確認できません。もう一度選んでください。") from error
            self._audio_input_path, self._audio_input_route = path, "colab"
            self._show_selected_audio(path.name, path.stat().st_size)
            return path
        except Exception as error:
            self._clear_audio_selection()
            self._set_status("音源を認識できませんでした：" + str(error) + " 左のファイル欄からアップロードし、「Colab内のファイルを使う」で指定する方法も使えます。")
            return None
        finally:
            self._audio_upload_busy = False
            self.colab_upload_button.disabled = self.analyse_button.disabled = False
            self.use_runtime_file_button.disabled = self.audio_upload.disabled = False
            self.mode.disabled = False

    def _runtime_file_edited(self, change):
        if self._audio_input_route == "path":
            self._clear_audio_selection()
            self._set_status("パスを変更しました。「このファイルを使う」を押して音源を確認してください。")

    def _use_runtime_file(self, button=None):
        if self._audio_upload_busy:
            self._set_status("音源を転送しています。完了するまでお待ちください。")
            return None
        self._clear_audio_selection()
        self.mode.value = "file"
        try:
            value = self.runtime_file_path.value.strip()
            if not value:
                raise ValueError("アップロード済み音源の絶対パスを入力してください。")
            path = validate_audio_path(value)
            self._audio_input_path, self._audio_input_route = path, "path"
            self._show_selected_audio(path.name, path.stat().st_size)
            return path
        except Exception as error:
            self._set_status("音源を認識できませんでした：" + str(error))
            return None

    def _switch_whole_track(self, change):
        self.time_controls.layout.display = "none" if change["new"] else ""

    def _reset_times(self, button=None):
        self.start.value, self.end.value = 0, 90
        self.whole_track.value = False

    def _silence_config(self):
        from .silence import SilenceConfig
        return SilenceConfig(trim_edges=self.trim_edges.value, remove_internal=self.remove_internal.value, threshold_db=self.threshold_db.value, min_silence_seconds=self.min_silence_seconds.value, padding_seconds=0.05)

    def _analysis_config(self):
        from .analysis import AnalysisConfig
        automatic = self.analysis_mode.value == "auto"
        return AnalysisConfig(auto_band=automatic, low_hz=0.02 if automatic else 0.2,
                              high_hz=20.0, segment_seconds=120.0 if automatic else 20.0)

    def _set_status(self, text: str) -> None:
        self.status.value = "<p>" + html.escape(str(text)) + "</p>"

    def _analyse(self, button=None):
        if self._audio_upload_busy:
            self._set_status("音源の転送が完了するまでお待ちください。")
            return
        self._reset_results()
        try:
            start, end = (0.0, None) if self.whole_track.value else validate_interval(self.start.value, self.end.value)
            run_dir = Path(tempfile.mkdtemp(prefix="analysis_", dir=self.workspace))
            if self.mode.value == "file":
                if self._audio_input_route == "widget":
                    source = str(save_audio_upload(self.audio_upload.value, run_dir / "input"))
                elif self._audio_input_route in {"path", "colab"} and self._audio_input_path is not None:
                    source = str(validate_audio_path(self._audio_input_path))
                else:
                    raise ValueError("音源ファイルをまだ認識できていません。ファイル名が表示されるまで待つか、「Colab内のファイルを使う」で指定してください。")
            else:
                source = self.url.value.strip()
                if not source:
                    raise ValueError("YouTubeの動画URLを入力してください。")
            self.analyse_button.disabled = True
            self._set_status("処理を始めます。初回は歌声抽出モデルの取得に時間がかかります。")
            self.bundle = self.run_pipeline(source, start, end, run_dir / "output", source_kind=self.mode.value, already_vocals=self.vocals_only.value, progress=self._set_status, device=self.device.value, silence_config=self._silence_config(), config=self._analysis_config())
            self.results_zip = export_results(self.bundle["analysis"], run_dir / "exports")
            self._show_result()
            self.result_download.disabled = self.vocals_download.disabled = False
            self.raw_vocals_download.disabled = not bool(self.bundle.get("extracted_vocals_path"))
            self.add_reference_button.disabled = not self.bundle["analysis"].get("quality", {}).get("usable_for_comparison", False)
            self._show_comparison()
            self._set_status("解析が終わりました。抽出音を聴き、音楽や雑音が残っていないか確かめてから結果を読んでください。")
        except Exception as error:
            self.bundle, self.results_zip = None, None
            self.result_download.disabled = self.vocals_download.disabled = self.raw_vocals_download.disabled = self.add_reference_button.disabled = True
            self._set_status("解析を完了できませんでした：" + str(error))
        finally:
            self.analyse_button.disabled = False

    def _show_result(self):
        import matplotlib.pyplot as plt
        analysis = self.bundle["analysis"]
        fit, quality = analysis.get("fit", {}), analysis.get("quality", {})
        with self.result_output:
            summary = html.escape(str(analysis.get("summary", "解析結果")))
            self.display(self.HTML("<h2>解析結果</h2><p><strong>" + summary + "</strong></p><p>傾き β = " + _number(fit.get("slope")) + " ／ 当てはめ R² = " + _number(fit.get("r_squared")) + " ／ 使用帯域 = " + _number(fit.get("band_low_hz"), 2) + "〜" + _number(fit.get("band_high_hz"), 2) + " Hz</p><p>指定した帯域・区間での参考評価です。歌の上手さ、心地よさ、声質を判定する結果ではありません。</p>"))
            self.display(self.HTML(band_selection_html(analysis)))
            self.display(self.HTML(band_comparison_html(analysis)))
            self.display(self.HTML("<p><strong>解析しているのは、抽出音に含まれるボーカル全体の音量変動です。</strong>主旋律とコーラス、多重録音は分離していません。重ね録りやリバーブも結果に影響するため、歌い手本人に固有の性質とは断定できません。</p>"))
            processing_details = preprocessing_html(analysis)
            if processing_details:
                self.display(self.HTML(processing_details))
            warnings = quality.get("reasons", quality.get("warnings", analysis.get("warnings", [])))
            if isinstance(warnings, str):
                warnings = [warnings]
            for warning in warnings:
                self.display(self.HTML("<p>確認：" + html.escape(str(warning)) + "</p>"))
            self.display(self.HTML("<p>画面の試聴は各音源の先頭30秒までです。解析は指定した全区間を使い、歌声WAVは無音調整後の全長を保存できます。</p>"))
            preview_directory = Path(self.bundle["vocals_path"]).resolve().parent / "previews"

            def show_preview(title, source):
                self.display(self.HTML("<h3>" + title + "</h3>"))
                try:
                    preview = create_audio_preview(source, preview_directory)
                    self.display(self.Audio(filename=str(preview)))
                except Exception:
                    self.display(self.HTML("<p>試聴を用意できませんでした。解析結果と全長の歌声WAVは保存できます。</p>"))

            show_preview("元の区間", self.bundle["clip_path"])
            if self.bundle.get("extracted_vocals_path"):
                show_preview("抽出した歌声（無音調整前）", self.bundle["extracted_vocals_path"])
            show_preview("解析に使った歌声（無音調整後）", self.bundle["vocals_path"])
            figure = plot_analysis(analysis)
            self.display(figure)
            plt.close(figure)

    def _show_comparison(self):
        if not self.bundle:
            return
        try:
            rows = self.db_api.compare_reference(self.bundle["analysis"], self.database, limit=5)
            self.comparison_output.value = comparison_html(rows)
        except ValueError as error:
            self.comparison_output.value = "<p>比較は保留です：" + html.escape(str(error)) + "</p>"

    def _import_database(self, change):
        try:
            records = uploaded_files(change["new"])
            if not records:
                return
            if len(records) != 1:
                raise ValueError("比較DBのJSONを1つ選んでください。")
            content = bytes(records[0].get("content", b""))
            if not content or len(content) > 10 * 1024 * 1024:
                raise ValueError("比較DBは10MB以内のJSONにしてください。")
            path = self.workspace / ("database_" + uuid4().hex + ".json")
            path.write_bytes(content)
            self.database = self.db_api.load_database(path)
            self.db_status.value = "<p>比較DBを読み込みました。同じ解析条件の登録曲が比較の対象です。</p>"
            self._show_comparison()
        except Exception as error:
            self.db_status.value = "<p>比較DBを読み込めませんでした：" + html.escape(str(error)) + "</p>"

    def _add_reference(self, button=None):
        try:
            if not self.bundle:
                raise ValueError("先に音源を解析してください。")
            artist, track = self.artist.value.strip(), self.track.value.strip()
            if not artist or not track:
                raise ValueError("アーティスト名と曲名の両方を入力してください。")
            metadata = self.bundle["analysis"].get("metadata", {})
            source = metadata.get("source_url", "uploaded audio")
            self.database = self.db_api.add_reference(self.database, self.bundle["analysis"], artist, track, source=source)
            self.db_status.value = "<p>「" + html.escape(artist + " / " + track) + "」を登録しました。次回も使うには「比較DBを保存」を押してください。同じ音源・区間は、自分自身との比較から除外されます。</p>"
            self._show_comparison()
        except Exception as error:
            self.db_status.value = "<p>登録できませんでした：" + html.escape(str(error)) + "</p>"

    def _export_database(self, button=None):
        try:
            path = self.workspace / "reference_database.json"
            self.db_api.save_database(self.database, path)
            download_file(path)
        except Exception as error:
            self.db_status.value = "<p>比較DBを保存できませんでした：" + html.escape(str(error)) + "</p>"


def launch_notebook(workspace: str | Path | None = None) -> VocalNotebookUI:
    """この関数を1回呼ぶと、解析画面が表示されます。"""
    from IPython.display import display
    ui = VocalNotebookUI(workspace=workspace)
    display(ui.panel)
    return ui
