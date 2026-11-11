"""提出結果の完全な包絡を固定帯域で再解析し、音源を含まない参考DBを作ります。"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import unicodedata
from zipfile import ZipFile

import numpy as np

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from vocal_lab import __version__
from vocal_lab.analysis import AnalysisConfig
from vocal_lab.reanalyse import reanalyse_result
from vocal_lab.reference_db import add_reference, empty_database, save_database


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def normalised_member(name):
    """UTF-8フラグのないMac ZIPと、分解された日本語の表記をそろえます。"""
    try:
        name = name.encode("cp437").decode("utf-8")
    except UnicodeError:
        pass
    return unicodedata.normalize("NFC", name)


def verify_spectrum(original):
    """保存された包絡から、元のPSD全点も再現できることを確認します。"""
    reproduced = reanalyse_result(original, AnalysisConfig(**original["config"]))
    for key in ("frequency_hz", "power", "bin_frequency_hz", "bin_power"):
        saved = np.asarray(original["spectrum"][key], dtype=float)
        calculated = np.asarray(reproduced["spectrum"][key], dtype=float)
        if (saved.shape != calculated.shape or not np.isfinite(saved).all()
                or not np.allclose(saved, calculated, rtol=1e-10, atol=1e-12)):
            raise ValueError("保存されたPSDと包絡からの計算が一致しません。")


def public_catalogue(rows):
    """WebとColabで共有する、音源を含まない公開曲目一覧です。"""
    return {
        "schema_version": "vocal-reference-catalogue-v1",
        "config": {"low_hz": 0.2, "high_hz": 20.0, "segment_seconds": 20.0, "auto_band": False},
        "references": [{
            "artist": row["artist"], "track": row["track"],
            "separation_method": row["separation_method"], "model_version": row["model_version"],
            "slope": row["fixed_fit"]["slope"], "r_squared": row["fixed_fit"]["r_squared"],
            "duration_seconds": row["duration_seconds"], "status": row["fixed_status"],
        } for row in rows if row["include_in_comparison"]],
        "excluded": [{"artist": row["artist"], "track": row["track"], "reason": row["holdout_reason"]}
                     for row in rows if not row["include_in_comparison"]],
    }


def import_archive(archive_path, catalogue_path, output):
    """元のZIPを変更せず、明示した曲だけを読み込みます。"""
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    catalogue = json.loads(Path(catalogue_path).read_text(encoding="utf-8"))
    if catalogue.get("schema_version") != "vocal-reference-import-catalogue-v1":
        raise ValueError("登録用の曲目一覧を確認してください。")
    database = empty_database()
    rows, held = [], []
    with ZipFile(archive_path) as archive:
        members = {}
        for info in archive.infolist():
            members.setdefault(normalised_member(info.filename), []).append(info)
        declared = [normalised_member(item["member"]) for item in catalogue["entries"]]
        if len(declared) != len(set(declared)):
            raise ValueError("登録用の曲目一覧に同じ解析結果が重複しています。")
        for item in catalogue["entries"]:
            member = normalised_member(item["member"])
            if len(members.get(member, [])) != 1:
                raise ValueError("曲目一覧とZIPの解析結果が一致しません：" + member)
            info = members[member][0]
            if info.file_size > 20 * 1024 * 1024:
                raise ValueError("解析結果JSONが大きすぎます：" + member)
            raw = archive.read(info)
            original = json.loads(raw)
            verify_spectrum(original)
            fixed = reanalyse_result(original)
            if not fixed["quality"]["usable_for_comparison"]:
                raise ValueError("固定帯域で比較品質を満たしません：" + member)
            processing = fixed["metadata"]["separation_method"]
            include = item["include_in_comparison"] is True
            row = {
                "artist": item["artist"], "track": item["track"],
                "include_in_comparison": include,
                "holdout_reason": item.get("holdout_reason", ""),
                "original_result_sha256": hashlib.sha256(raw).hexdigest(),
                "original_spectrum_verified": True,
                "original_created_at": original["metadata"].get("created_at"),
                "reanalysis": fixed["reanalysis"],
                "original_config": original["config"], "original_fit": original["fit"],
                "fixed_config": fixed["config"], "fixed_fit": fixed["fit"], "fixed_status": fixed["status"],
                "fixed_quality": fixed["quality"],
                "duration_seconds": fixed["duration_seconds"],
                "analysis_signature": fixed["analysis_signature"],
                "separation_method": processing,
                "model_version": fixed["metadata"].get("model_version", ""),
                "preprocessing": fixed["metadata"]["preprocessing"],
                "source_audio_sha256": fixed["metadata"]["source_sha256"],
            }
            rows.append(row)
            if include:
                notes = "利用者提供の数値結果を保存済み200 Hz包絡から固定帯域へ再計算。録音版と分離品質の音声照合は未実施。"
                if processing == "already-vocals":
                    notes += " 保存済み歌声WAVの入力。元の分離モデルを推定して書き換えていません。"
                database = add_reference(database, fixed, item["artist"], item["track"],
                                         source="利用者提供の解析結果（" + catalogue["provided_at"] + "）", notes=notes)
            else:
                held.append(row)
    manifest = {
        "schema_version": "vocal-reference-measurements-v1", "package_version": __version__,
        "prepared_at": datetime.now(timezone.utc).isoformat(),
        "input_archive_sha256": hashlib.sha256(Path(archive_path).read_bytes()).hexdigest(),
        "reanalysis_method": "stored-envelope-fixed-band", "audio_included": False,
        "full_envelope_included": False, "records": rows,
    }
    save_database(database, output / "reference_database.json")
    for processing, name in [("already-vocals", "reference_database_saved_vocals.json"),
                             ("demucs:htdemucs", "reference_database_demucs.json")]:
        subset = {**database, "references": [r for r in database["references"] if r["metadata"]["separation_method"] == processing]}
        save_database(subset, output / name)
    write_json(output / "reference_measurements.json", manifest)
    write_json(output / "reference_catalogue_public.json", public_catalogue(rows))
    # A different schema prevents this held-out record being mistaken for a normal comparison DB.
    write_json(output / "reference_holdout.json", {
        "schema_version": "vocal-reference-holdout-v1", "records": held,
        "historical_records": catalogue.get("superseded_holdouts", []),
    })
    with (output / "reference_summary.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["artist", "track", "original_beta_auto", "fixed_beta_0p2_20Hz", "fixed_r_squared",
                         "duration_seconds", "separation_method", "included_in_comparison", "holdout_reason"])
        for row in rows:
            writer.writerow([row["artist"], row["track"], row["original_fit"]["slope"], row["fixed_fit"]["slope"],
                             row["fixed_fit"]["r_squared"], row["duration_seconds"], row["separation_method"],
                             row["include_in_comparison"], row["holdout_reason"]])
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--catalogue", type=Path, default=PROJECT / "data/reference_import_catalogue.json")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    manifest = import_archive(args.archive, args.catalogue, args.output)
    included = sum(row["include_in_comparison"] for row in manifest["records"])
    print(f"比較DB：{included}曲、参考枠：{len(manifest['records']) - included}曲。音源は含めていません。")


if __name__ == "__main__":
    main()
