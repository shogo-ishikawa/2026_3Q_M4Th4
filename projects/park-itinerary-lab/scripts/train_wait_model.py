#!/usr/bin/env python3
"""Train the same browser ridge model from a collected observation file.

Requires Python 3.12 and Node.js >=18. The learning implementation lives only in
web/wait-model.js so browser and scheduled training use identical features and validation.
"""
import argparse
import datetime as dt
import json
from pathlib import Path
import subprocess

PROJECT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--observations", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--before-date", default=dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date().isoformat())
    args = parser.parse_args()
    observations = json.loads(args.observations.read_text())
    catalogue = json.loads((PROJECT / "web/data/parks.json").read_text())
    module = (PROJECT / "web/wait-model.js").as_uri()
    script = "import {trainWaitModel} from " + json.dumps(module) + ";let raw='';for await(const chunk of process.stdin)raw+=chunk;const d=JSON.parse(raw);console.log(JSON.stringify({schemaVersion:1,updatedAt:new Date().toISOString(),parks:d.parks.map(park=>trainWaitModel(d.observations,park,{beforeDate:d.beforeDate}))}));"
    process = subprocess.run(["node", "--input-type=module", "-e", script], input=json.dumps({"observations": observations, "parks": catalogue["parks"], "beforeDate": args.before_date}), text=True, capture_output=True, check=True)
    model = json.loads(process.stdout)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(model, ensure_ascii=False, indent=2) + "\n")
    for park in model["parks"]:
        print(f"{park['parkId']}: {park['status']} ({park['days']} days, {park['samples']} observations), usable={park['usable']}")


if __name__ == "__main__":
    main()
