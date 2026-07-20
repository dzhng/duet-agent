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
    work_dir = output_root.resolve() / model / instance_id
    cached = cached_score(row, output_root)
    if cached is not None:
        return cached
    final_report = work_dir / "official-report.json"

    work_dir.mkdir(parents=True, exist_ok=True)
    prediction_path = work_dir / "prediction.jsonl"
    prediction_path.write_text(json.dumps(row) + "\n")
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
        "false",
        "--run_id",
        run_id,
    ]
    subprocess.run(command, cwd=work_dir, check=True)
    matches = list(work_dir.glob(f"*.{run_id}.json"))
    if len(matches) != 1:
        raise RuntimeError(f"expected one scorer report for {instance_id}, found {len(matches)}")
    report = json.loads(matches[0].read_text())
    final_report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return {"instanceId": instance_id, "model": model, "status": report_status(instance_id, report)}


def score_instance(rows: list[dict[str, Any]], output_root: Path) -> list[dict[str, Any]]:
    instance_ids = {row["instance_id"] for row in rows}
    if len(instance_ids) != 1:
        raise ValueError("score_instance requires predictions for exactly one instance")
    instance_id = next(iter(instance_ids))
    models = [row["model_name_or_path"] for row in rows]
    if len(set(models)) != len(models):
        raise ValueError(f"duplicate official scorer identity for {instance_id}")
    results: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []
    for row in rows:
        cached = cached_score(row, output_root)
        if cached is None:
            pending.append(row)
        else:
            results.append(cached)
    if not pending:
        return results

    image = resolve_image(instance_id)
    try:
        pull_image(image)
    except Exception as error:
        remove_if_present(image)
        return results + [infra_result(row, error) for row in pending]

    try:
        for row in pending:
            try:
                results.append(score_one(row, output_root))
            except Exception as error:
                results.append(infra_result(row, error))
    finally:
        remove_if_present(image)
    return results


def cached_score(row: dict[str, Any], output_root: Path) -> dict[str, Any] | None:
    report_path = (
        output_root.resolve()
        / row["model_name_or_path"]
        / row["instance_id"]
        / "official-report.json"
    )
    if not report_path.exists():
        return None
    report = json.loads(report_path.read_text())
    return {
        "instanceId": row["instance_id"],
        "model": row["model_name_or_path"],
        "status": report_status(row["instance_id"], report),
    }


def infra_result(row: dict[str, Any], error: Exception) -> dict[str, Any]:
    return {
        "instanceId": row["instance_id"],
        "model": row["model_name_or_path"],
        "status": "infra_error",
        "error": str(error),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--predictions-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    prediction_files = sorted(args.predictions_dir.glob("*.jsonl"))
    if not prediction_files:
        parser.error("predictions directory contains no JSONL files")

    rows: list[dict[str, Any]] = []
    for path in prediction_files:
        rows.extend(load_jsonl(path))

    rows_by_instance: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        rows_by_instance.setdefault(row["instance_id"], []).append(row)

    results: list[dict[str, Any]] = []
    failures = 0
    for instance_id in sorted(rows_by_instance):
        for result in score_instance(rows_by_instance[instance_id], args.output_dir):
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
