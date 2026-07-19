#!/usr/bin/env python3
"""Score campaign predictions one at a time with the pinned official harness."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from official_image import pull_image, resolve_image


DATASET = "SWE-bench/SWE-bench_Multilingual"
SPLIT = "test"


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    for index, row in enumerate(rows):
        if not all(isinstance(row.get(key), str) for key in (
            "instance_id",
            "model_name_or_path",
            "model_patch",
        )):
            raise ValueError(f"invalid prediction row {index} in {path}")
    return rows


def report_status(instance_id: str, report: dict[str, Any]) -> str:
    for key, status in (
        ("resolved_ids", "resolved"),
        ("unresolved_ids", "unresolved"),
        ("empty_patch_ids", "empty_patch"),
        ("error_ids", "error"),
    ):
        if instance_id in report.get(key, []):
            return status
    return "missing"


def remove_if_present(image: str) -> None:
    inspected = subprocess.run(
        ["docker", "image", "inspect", image],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if inspected.returncode == 0:
        subprocess.run(["docker", "image", "rm", image], check=True)


def score_one(row: dict[str, Any], output_root: Path) -> dict[str, Any]:
    instance_id = row["instance_id"]
    model = row["model_name_or_path"]
    work_dir = output_root / model / instance_id
    final_report = work_dir / "official-report.json"
    if final_report.exists():
        report = json.loads(final_report.read_text())
        return {"instanceId": instance_id, "model": model, "status": report_status(instance_id, report)}

    work_dir.mkdir(parents=True, exist_ok=True)
    prediction_path = work_dir / "prediction.jsonl"
    prediction_path.write_text(json.dumps(row) + "\n")
    image = resolve_image(instance_id)
    pull_image(image)
    run_id = f"score-{model}-{instance_id}".replace("/", "-")
    command = [
        os.fspath(Path(sys.executable)),
        "-m",
        "swebench.harness.run_evaluation",
        "--dataset_name",
        DATASET,
        "--split",
        SPLIT,
        "--instance_ids",
        instance_id,
        "--predictions_path",
        os.fspath(prediction_path),
        "--max_workers",
        "1",
        "--cache_level",
        "none",
        "--clean",
        "true",
        "--run_id",
        run_id,
    ]
    try:
        subprocess.run(command, cwd=work_dir, check=True)
    finally:
        remove_if_present(image)
    matches = list(work_dir.glob(f"*.{run_id}.json"))
    if len(matches) != 1:
        raise RuntimeError(f"expected one scorer report for {instance_id}, found {len(matches)}")
    report = json.loads(matches[0].read_text())
    final_report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return {"instanceId": instance_id, "model": model, "status": report_status(instance_id, report)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--predictions-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    prediction_files = sorted(args.predictions_dir.glob("*.jsonl"))
    if not prediction_files:
        parser.error("predictions directory contains no JSONL files")

    results: list[dict[str, Any]] = []
    failures = 0
    for path in prediction_files:
        for row in load_jsonl(path):
            try:
                result = score_one(row, args.output_dir)
            except Exception as error:
                result = {
                    "instanceId": row["instance_id"],
                    "model": row["model_name_or_path"],
                    "status": "infra_error",
                    "error": str(error),
                }
            results.append(result)
            print(f"{result['status']:12} {result['model']} {result['instanceId']}", flush=True)
            if result["status"] in {"infra_error", "missing", "error"}:
                failures += 1

    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "summary.json").write_text(
        json.dumps({"schemaVersion": 1, "results": results}, indent=2, sort_keys=True) + "\n"
    )
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
