#!/usr/bin/env python3
"""Capture the local benchmark environment without reading credentials."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import platform
import shutil
import subprocess
from pathlib import Path
from typing import Any


DATASET_NAME = "SWE-bench/SWE-bench_Multilingual"
DATASET_SPLIT = "test"
IMAGE_NAMESPACE = "swebench"
IMAGE_PLATFORM = "linux/amd64"


def command_output(*argv: str) -> str:
    return subprocess.check_output(argv, text=True).strip()


def docker_info() -> dict[str, Any]:
    return json.loads(command_output("docker", "info", "--format", "{{json .}}"))


def lock_data(manifest: Path) -> dict[str, Any]:
    info = docker_info()
    disk = shutil.disk_usage(Path(__file__).resolve())
    manifest_data = json.loads(manifest.read_text())
    return {
        "schemaVersion": 1,
        "host": {
            "os": "macOS",
            "osVersion": command_output("sw_vers", "-productVersion"),
            "architecture": platform.machine(),
            "cpuCount": os.cpu_count(),
            "memoryBytes": int(command_output("sysctl", "-n", "hw.memsize")),
            "diskAvailableBytes": disk.free,
        },
        "docker": {
            "clientVersion": command_output("docker", "version", "--format", "{{.Client.Version}}"),
            "serverVersion": command_output("docker", "version", "--format", "{{.Server.Version}}"),
            "operatingSystem": info["OperatingSystem"],
            "architecture": info["Architecture"],
            "cpuCount": info["NCPU"],
            "memoryBytes": info["MemTotal"],
            "instanceImagePlatform": IMAGE_PLATFORM,
            "emulation": "Docker Desktop amd64 emulation on Apple Silicon",
        },
        "python": {
            "version": platform.python_version(),
            "uvVersion": command_output("uv", "--version").removeprefix("uv "),
            "swebenchVersion": importlib.metadata.version("swebench"),
            "miniSweAgentVersion": importlib.metadata.version("mini-swe-agent"),
        },
        "benchmark": {
            "dataset": DATASET_NAME,
            "datasetRevision": manifest_data["datasetRevision"],
            "split": DATASET_SPLIT,
            "imageNamespace": IMAGE_NAMESPACE,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    data = lock_data(args.manifest)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
