"""同じ解析条件で測った歌声の特徴量を保存し、参考値として比べます。

音源そのものは保存しません。距離は音量包絡の特徴量の違いであり、
歌手の本人認証、声質の一致率、歌唱力を表す値ではありません。
"""

import hashlib
import json
import math
from pathlib import Path
import tempfile


DATABASE_SCHEMA = "vocal-fluctuation-reference-db-v1"
RESULT_SCHEMA = "vocal-fluctuation-result-v1"
METHOD_ID = "rms-welch-v2"
FEATURE_SCALES = {
    "slope": 0.5,
    "envelope_cv": 0.5,
    "low_band_fraction": 0.25,
    "spectral_flatness": 0.25,
}
MAX_REFERENCES = 5000
MAX_DATABASE_BYTES = 5_000_000
COMPARISON_BASIS = (
    "同じ解析条件と歌声の前処理で得た、音量包絡の傾き・変動係数・"
    "低周波側の割合・スペクトル平坦度を比較。歌手本人や声質の一致率ではありません。"
)


def empty_database():
    """実測値がまだない空のデータベースを返します。"""
    return {"schema_version": DATABASE_SCHEMA, "references": []}


def _number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} は有限の数値にしてください。")
    try:
        number = float(value)
    except (OverflowError, ValueError) as error:
        raise ValueError(f"{label} は有限の数値にしてください。") from error
    if not math.isfinite(number):
        raise ValueError(f"{label} は有限の数値にしてください。")
    return number


def _text(value, label, maximum=500, required=False):
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError(f"{label} は {maximum} 文字以内の文字列にしてください。")
    value = value.strip()
    if required and not value:
        raise ValueError(f"{label} を入力してください。")
    return value


def _features(value):
    if not isinstance(value, dict) or set(value) != set(FEATURE_SCALES):
        raise ValueError("比較する4種類の特徴量がそろっていません。")
    result = {key: _number(value[key], key) for key in FEATURE_SCALES}
    if any(abs(number) > 1_000_000 for number in result.values()):
        raise ValueError("比較する特徴量の値が大きすぎます。解析結果を確認してください。")
    if result["envelope_cv"] < 0:
        raise ValueError("音量の変動係数は0以上にしてください。")
    for key in ["low_band_fraction", "spectral_flatness"]:
        if not 0 <= result[key] <= 1:
            raise ValueError(f"{key} は0以上1以下にしてください。")
    return result


def _metadata(value):
    if not isinstance(value, dict):
        raise ValueError("音源と解析区間の情報がありません。")
    fingerprint = value.get("source_sha256")
    if (not isinstance(fingerprint, str) or len(fingerprint) != 64
            or any(char not in "0123456789abcdef" for char in fingerprint.lower())):
        raise ValueError("音源の SHA-256 が確認できません。音源から再解析してください。")
    start = _number(value.get("start_seconds"), "開始秒")
    end = _number(value.get("end_seconds"), "終了秒")
    if start < 0 or end <= start:
        raise ValueError("解析区間は 0 ≤ 開始秒 < 終了秒 にしてください。")
    separation = _text(value.get("separation_method"), "歌声の前処理", 150, True)
    model_version = value.get("model_version", "")
    model_version = _text("" if model_version is None else model_version, "モデルの版", 100)
    hash_scope = value.get("source_hash_scope", "original-file")
    if hash_scope not in {"original-file", "selected-clip"}:
        raise ValueError("音源のハッシュが指す範囲を確認できません。")
    result = {
        "source_sha256": fingerprint.lower(),
        "start_seconds": start,
        "end_seconds": end,
        "separation_method": separation,
        "model_version": model_version,
        "source_hash_scope": hash_scope,
    }
    if "analysis_request_signature" in value:
        result["analysis_request_signature"] = _text(value["analysis_request_signature"], "解析の設定識別子", 2000, True)
    return result


def _analysis_values(analysis):
    if not isinstance(analysis, dict) or analysis.get("schema_version") != RESULT_SCHEMA:
        raise ValueError("このツールの解析結果JSONを使ってください。")
    if analysis.get("method_id") != METHOD_ID:
        raise ValueError("異なる解析方法の結果は比較できません。v1.2以前の比較DBは歌声WAVから再解析して、新しいDBへ登録してください。")
    quality = analysis.get("quality")
    if not isinstance(quality, dict) or quality.get("usable_for_comparison") is not True:
        raise ValueError("比較に必要な長さや品質が足りません。音源や解析区間を見直してください。")
    signature = _text(analysis.get("analysis_signature"), "解析条件", 2000, True)
    return signature, _features(analysis.get("features")), _metadata(analysis.get("metadata"))


def _clip_key(metadata):
    # 区間を丸めずに保存し、違う区間を同じ実測値として扱わないようにします。
    if metadata["source_hash_scope"] == "selected-clip":
        return ("selected-clip", metadata["source_sha256"])
    return ("original-file", metadata["source_sha256"], metadata["start_seconds"], metadata["end_seconds"])


def _processing_key(metadata):
    return (metadata["separation_method"], metadata["model_version"])


def _record_key(record):
    return (record["analysis_signature"], _processing_key(record["metadata"]),
            _clip_key(record["metadata"]))


def _record_id(record):
    encoded = json.dumps(_record_key(record), ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _validated_record(value):
    if not isinstance(value, dict):
        raise ValueError("比較データの行が辞書になっていません。")
    signature, features, metadata = _analysis_values(value)
    record = {
        "schema_version": RESULT_SCHEMA,
        "method_id": METHOD_ID,
        "analysis_signature": signature,
        "quality": {"usable_for_comparison": True},
        "features": features,
        "metadata": metadata,
        "artist": _text(value.get("artist"), "アーティスト名", 150, True),
        "track": _text(value.get("track"), "曲名", 200, True),
        "source": _text(value.get("source", ""), "出典", 1000),
        "notes": _text(value.get("notes", ""), "メモ", 2000),
    }
    record["id"] = _record_id(record)
    if "id" in value and value["id"] != record["id"]:
        raise ValueError("比較データの識別子と解析区間が一致しません。")
    return record


def validate_database(database):
    """読込み・書出しとも同じ検証を行い、安全なコピーを返します。"""
    if not isinstance(database, dict) or database.get("schema_version") != DATABASE_SCHEMA:
        raise ValueError("比較データベースの形式が違います。")
    rows = database.get("references")
    if not isinstance(rows, list) or len(rows) > MAX_REFERENCES:
        raise ValueError(f"比較データは {MAX_REFERENCES} 区間以内にしてください。")
    checked = [_validated_record(row) for row in rows]
    keys = [_record_key(row) for row in checked]
    if len(set(keys)) != len(keys):
        raise ValueError("同じ音源・同じ区間・同じ条件の実測値が重複しています。")
    return {"schema_version": DATABASE_SCHEMA, "references": checked}


def load_database(path):
    """利用者が保存した特徴量JSONを読み込みます。音源は含みません。"""
    path = Path(path)
    if path.stat().st_size > MAX_DATABASE_BYTES:
        raise ValueError("比較データベースが大きすぎます。5 MB以内にしてください。")
    try:
        database = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValueError("比較データベースのJSONを読み取れません。") from error
    return validate_database(database)


def save_database(database, path):
    """検証済みの特徴量のみ保存し、保存先の Path を返します。"""
    checked = validate_database(database)
    content = json.dumps(checked, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if len(content.encode("utf-8")) > MAX_DATABASE_BYTES:
        raise ValueError("比較データベースが大きすぎます。5 MB以内にしてください。")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # 同名の .tmp ファイルを利用者が置いていても上書きしません。
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                     prefix=path.name + ".", suffix=".tmp", delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(content)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return path


def add_reference(database, analysis, artist, track, source="", notes=""):
    """実測結果を加えた新しい辞書を返します。元の辞書は変更しません。

    同じ音源・区間を重ねて登録して、あるアーティストの重みを増やすことは
    できません。名前やメモを直す場合は、保存前のデータを編集します。
    """
    checked = validate_database(database)
    signature, features, metadata = _analysis_values(analysis)
    record = _validated_record({
        "schema_version": RESULT_SCHEMA, "method_id": METHOD_ID,
        "analysis_signature": signature, "quality": {"usable_for_comparison": True},
        "features": features, "metadata": metadata, "artist": artist, "track": track,
        "source": source, "notes": notes,
    })
    if any(_record_key(row) == _record_key(record) for row in checked["references"]):
        raise ValueError("この音源の同じ区間は、同じ条件ですでに登録されています。")
    if len(checked["references"]) >= MAX_REFERENCES:
        raise ValueError(f"比較データは {MAX_REFERENCES} 区間以内にしてください。")
    checked["references"].append(record)
    return checked


def _mean_features(values):
    return {key: sum(value[key] for value in values) / len(values) for key in FEATURE_SCALES}


def _distance(left, right):
    squared = [((left[key] - right[key]) / scale) ** 2 for key, scale in FEATURE_SCALES.items()]
    return math.sqrt(sum(squared) / len(squared))


def _matching_records(records, signature, metadata):
    matched = []
    excluded = {"settings_excluded": 0, "processing_excluded": 0, "self_excluded": 0}
    for row in records:
        if row["analysis_signature"] != signature:
            excluded["settings_excluded"] += 1
        elif _processing_key(row["metadata"]) != _processing_key(metadata):
            excluded["processing_excluded"] += 1
        elif _clip_key(row["metadata"]) == _clip_key(metadata):
            excluded["self_excluded"] += 1
        else:
            matched.append(row)
    return matched, excluded


def _counts(records):
    artists = {row["artist"].casefold() for row in records}
    tracks = {(row["artist"].casefold(), row["track"].casefold()) for row in records}
    return {"records": len(records), "tracks": len(tracks), "artists": len(artists)}


def comparison_coverage(analysis, database):
    """登録総数と、順位づけと同じ条件で使える件数を返します。"""
    records = validate_database(database)["references"]
    result = {"total": _counts(records), "eligible": None}
    if analysis is not None:
        signature, _, metadata = _analysis_values(analysis)
        matched, excluded = _matching_records(records, signature, metadata)
        result.update(eligible=_counts(matched), **excluded)
    return result


def compare_reference(analysis, database, limit=5):
    """同条件の実測値だけを使い、アーティストごとの参考順位を返します。

    同じ曲の複数区間をまず平均し、その後で曲ごとに同じ重みで平均します。
    問い合わせと同一の音源・同一区間は、自分自身との比較から外します。
    距離が小さいほど、ここで測った4特徴量が近いという意味です。
    """
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError("表示件数は1以上100以下の整数にしてください。")
    checked = validate_database(database)
    signature, features, metadata = _analysis_values(analysis)
    grouped = {}
    matched, _ = _matching_records(checked["references"], signature, metadata)
    for row in matched:
        artist_key = row["artist"].casefold()
        artist = grouped.setdefault(artist_key, {"artist": row["artist"], "tracks": {}})
        track_key = row["track"].casefold()
        track = artist["tracks"].setdefault(track_key, {"name": row["track"], "features": []})
        track["features"].append(row["features"])
    ranking = []
    for artist in grouped.values():
        tracks = artist["tracks"].values()
        track_means = [{"track": track["name"], "features": _mean_features(track["features"])}
                       for track in tracks]
        feature_means = _mean_features([track["features"] for track in track_means])
        nearest = min(track_means, key=lambda track: _distance(features, track["features"]))
        ranking.append({
            "artist": artist["artist"], "track": nearest["track"],
            "tracks_count": len(track_means),
            "clips_count": sum(len(track["features"]) for track in tracks),
            "distance": _distance(features, feature_means),
            "feature_means": feature_means,
            "tracks": sorted(track["track"] for track in track_means),
            "comparison_basis": COMPARISON_BASIS,
            "coverage_label": "1曲の参考値" if len(track_means) == 1 else "複数曲の参考値",
        })
    ranking.sort(key=lambda row: (row["distance"], row["artist"].casefold()))
    return ranking[:limit]
