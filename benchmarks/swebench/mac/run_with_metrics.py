#!/usr/bin/env python3
"""Run one scorer command while sampling local capacity telemetry."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import time
from pathlib import Path


UNIT_BYTES = {
    "B": 1,
    "KiB": 1024,
    "MiB": 1024**2,
    "GiB": 1024**3,
    "TiB": 1024**4,
    "kB": 1000,
    "MB": 1000**2,
    "GB": 1000**3,
    "TB": 1000**4,
}


def parse_size(value: str) -> int:
    value = value.strip()
    for unit in sorted(UNIT_BYTES, key=len, reverse=True):
        if value.endswith(unit):
            return int(float(value[: -len(unit)].strip()) * UNIT_BYTES[unit])
    return int(value)


def process_tree_rss_bytes(root_pid: int) -> int:
    output = subprocess.check_output(["ps", "-axo", "pid=,ppid=,rss="], text=True)
    rows = [tuple(map(int, line.split())) for line in output.splitlines() if line.strip()]
    descendants = {root_pid}
    changed = True
    while changed:
        changed = False
        for pid, ppid, _rss in rows:
            if ppid in descendants and pid not in descendants:
                descendants.add(pid)
                changed = True
    return sum(rss * 1024 for pid, _ppid, rss in rows if pid in descendants)


def docker_memory_bytes(run_id: str) -> int:
    try:
        output = subprocess.check_output(
            ["docker", "stats", "--no-stream", "--format", "{{json .}}"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError:
        return 0
    total = 0
    for line in output.splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            if run_id not in row.get("Name", ""):
                continue
            used = row.get("MemUsage", "0B / 0B").split("/", 1)[0]
            total += parse_size(used)
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
    return total


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("missing command after --")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    initial_free = shutil.disk_usage(args.output.parent).free
    min_free = initial_free
    max_process_rss = 0
    max_container_memory = 0
    started = time.monotonic()
    process = subprocess.Popen(command)
    while process.poll() is None:
        min_free = min(min_free, shutil.disk_usage(args.output.parent).free)
        try:
            max_process_rss = max(max_process_rss, process_tree_rss_bytes(process.pid))
        except (OSError, subprocess.CalledProcessError):
            pass
        max_container_memory = max(max_container_memory, docker_memory_bytes(args.run_id))
        time.sleep(1)
    elapsed = time.monotonic() - started
    min_free = min(min_free, shutil.disk_usage(args.output.parent).free)
    result = {
        "schemaVersion": 1,
        "commandExitCode": process.returncode,
        "elapsedSeconds": round(elapsed, 3),
        "hostDiskConsumedPeakBytes": max(0, initial_free - min_free),
        "scorerProcessTreeRssPeakBytes": max_process_rss,
        "instanceContainersMemoryPeakBytes": max_container_memory,
    }
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    raise SystemExit(process.returncode)


if __name__ == "__main__":
    main()
