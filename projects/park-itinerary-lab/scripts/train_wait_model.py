#!/usr/bin/env python3
"""Fit the canonical browser model to local observations and optional monthly archives.

Python 3.12 and Node.js >=18. Training code lives only in web/wait-model.js.
Raw provider input remains local; only derived coefficients and protected
multi-day aggregates are written to the output model.
"""
import argparse
import datetime as dt
import json
from pathlib import Path
import re
import subprocess

from issued_training_inputs import with_issued_inputs

PROJECT = Path(__file__).resolve().parents[1]
QUEUE_SOURCE = {"name": "Queue-Times.com", "url": "https://queue-times.com/", "kind": "collected-live-observations", "attribution": "Powered by Queue-Times.com"}


def load_observations(path):
    payload = json.loads(path.read_text())
    if isinstance(payload, list):
        return payload, []
    if isinstance(payload, dict) and isinstance(payload.get("observations"), list):
        return payload["observations"], payload.get("dataSources", [])
    raise ValueError(f"Observation array missing in {path}")


def load_history(directory):
    rows, sources = [], []
    if not directory or not directory.exists():
        return rows, sources
    for path in sorted(directory.iterdir()):
        if path.is_file() and re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])\.json", path.name):
            month_rows, month_sources = load_observations(path)
            # Archive files contain only this month's rows; other filenames are never read.
            rows.extend(row for row in month_rows if isinstance(row, dict) and str(row.get("date", "")).startswith(path.stem + "-"))
            sources.extend(month_sources)
    return rows, sources


def fit_summary(candidate):
    """Keep the evidence for a candidate separately from the model used for predictions."""
    fields = ("trainedAt", "beforeDate", "firstDate", "lastDate", "days", "samples",
              "minDays", "minSamples", "status", "usable", "validation",
              "visitFactorSupport", "visitFactors", "visitFactorValidation", "issuedInputCoverage")
    return {key: candidate[key] for key in fields if key in candidate}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--observations", type=Path)
    parser.add_argument("--history-dir", type=Path)
    parser.add_argument("--forecast-dir", type=Path, help="Frozen daily forecasts with their hourly inputs")
    parser.add_argument("--catalogue", type=Path, default=PROJECT / "web/data/parks.json")
    parser.add_argument("--calendar", type=Path)
    parser.add_argument("--source-metadata", type=Path)
    parser.add_argument("--fallback-model", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--before-date", default=dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date().isoformat())
    args = parser.parse_args()
    if not (args.observations or args.history_dir):
        parser.error("Supply --observations or --history-dir")
    observations, sources = load_observations(args.observations) if args.observations else ([], [])
    archived, archive_sources = load_history(args.history_dir)
    observations.extend(archived)
    observations = with_issued_inputs(observations, args.forecast_dir)
    sources.extend(archive_sources)
    if any(row.get("source") == "queue-times" for row in observations if isinstance(row, dict)):
        sources.append(QUEUE_SOURCE)
    if args.source_metadata:
        sources.extend(json.loads(args.source_metadata.read_text()))
    sources = list({json.dumps(source, sort_keys=True): source for source in sources if isinstance(source, dict)}.values())
    catalogue = json.loads(args.catalogue.read_text())
    calendar = json.loads(args.calendar.read_text()) if args.calendar and args.calendar.exists() else None
    module = (PROJECT / "web/wait-model.js").as_uri()
    fallback = json.loads(args.fallback_model.read_text()) if args.fallback_model and args.fallback_model.exists() else {}
    script = "import {trainWaitModel,validateWaitModel} from " + json.dumps(module) + ";let raw='';for await(const chunk of process.stdin)raw+=chunk;const d=JSON.parse(raw);console.log(JSON.stringify({schemaVersion:2,updatedAt:new Date().toISOString(),validFallbacks:(d.fallback.parks||[]).filter(validateWaitModel),parks:d.parks.map(park=>trainWaitModel(d.observations,park,{beforeDate:d.beforeDate,calendarData:d.calendarData,dataSources:d.dataSources,sampleLimit:null}))}));"
    process = subprocess.run(["node", "--input-type=module", "-e", script], input=json.dumps({"observations": observations, "parks": catalogue["parks"], "beforeDate": args.before_date, "calendarData": calendar, "dataSources": sources,"fallback":fallback}), text=True, capture_output=True, check=True)
    model = json.loads(process.stdout)
    valid_fallbacks = model.pop('validFallbacks', [])
    if valid_fallbacks:
        previous = {'parks': valid_fallbacks}
        for index, candidate in enumerate(model["parks"]):
            fallback = next((park for park in previous.get("parks", []) if park.get("parkId") == candidate["parkId"]), None)
            narrower = fallback and (candidate.get('days', 0) < fallback.get('days', 0) or (candidate.get('firstDate') and fallback.get('firstDate') and candidate['firstDate'] > fallback['firstDate'] and candidate.get('lastDate', '9999') <= fallback.get('lastDate', '0000')))
            if (not candidate.get("usable") or narrower) and fallback and fallback.get("status") == "trained" and fallback.get("usable") and fallback.get("lastDate", "9999") < args.before_date:
                model["parks"][index] = {
                    **fallback,
                    "retainedModelReason": "学習期間または検証結果に基づき前の検証済みモデルを保持",
                    "latestAttempt": fit_summary(candidate),
                }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(model, ensure_ascii=False, indent=2) + "\n")
    for park in model["parks"]:
        print(f"{park['parkId']}: {park['status']} ({park['days']} days, {park['samples']} observations), usable={park['usable']}")


if __name__ == "__main__":
    main()
