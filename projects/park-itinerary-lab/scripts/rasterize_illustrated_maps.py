"""園内の絵地図SVGからタッチ操作用のWebPを再生成する。

絵地図を変更したら、build_illustrated_maps.py の後にこのファイルを実行する。
生成時のみ Inkscape CLI と Pillow が必要。Inkscape 1.4、Pillow 13.0.0、
libwebp 1.6.0 で生成確認。Web版や配布版の起動にはこれらは不要。
"""

from pathlib import Path
import subprocess
import tempfile

from PIL import Image


ASSETS = Path(__file__).resolve().parents[1] / "web" / "assets"
SIDE = 2560


def write_background(park, staging):
    source = ASSETS / f"{park}-geographic-map.svg"
    png = staging / f"{park}.png"
    subprocess.run(
        ["inkscape", "--export-area-page", f"--export-width={SIDE}", f"--export-filename={png}", str(source)],
        check=True,
    )
    with Image.open(png) as image:
        if image.size != (SIDE, SIDE):
            raise ValueError(f"地図が正方形になっていません: {source}")
        output = staging / source.with_suffix(".webp").name
        image.convert("RGB").save(output, "WEBP", quality=90, method=6)
    output.replace(ASSETS / output.name)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(dir=ASSETS) as directory:
        for park_id in ("land", "sea"):
            write_background(park_id, Path(directory))
