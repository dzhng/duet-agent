#!/usr/bin/env python3
"""Resolve and optionally pull an official SWE-bench instance image."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from typing import Any

from swebench.harness.run_evaluation import load_swebench_dataset
from swebench.harness.test_spec.test_spec import make_test_spec


DATASET_NAME = "SWE-bench/SWE-bench_Multilingual"
DATASET_SPLIT = "test"
IMAGE_NAMESPACE = "swebench"
IMAGE_ARCH = "x86_64"
DOCKER_PLATFORM = "linux/amd64"


def resolve_image(instance_id: str) -> str:
    rows = load_swebench_dataset(DATASET_NAME, DATASET_SPLIT, [instance_id])
    matches = [row for row in rows if row["instance_id"] == instance_id]
    if len(matches) != 1:
        raise ValueError(f"expected one dataset row for {instance_id!r}, found {len(matches)}")
    spec = make_test_spec(matches[0], namespace=IMAGE_NAMESPACE, arch=IMAGE_ARCH)
    return spec.instance_image_key


def pull_image(image: str) -> dict[str, Any]:
    subprocess.run(
        ["docker", "pull", "--platform", DOCKER_PLATFORM, image],
        check=True,
        stdout=sys.stderr,
    )
    raw = subprocess.check_output(
        [
            "docker",
            "image",
            "inspect",
            "--format",
            "{{json .}}",
            image,
        ],
        text=True,
    )
    inspected = json.loads(raw)
    if inspected["Architecture"] != "amd64" or inspected["Os"] != "linux":
        raise RuntimeError(
            f"official image has unexpected platform: {inspected['Os']}/{inspected['Architecture']}"
        )
    return {
        "image": image,
        "platform": DOCKER_PLATFORM,
        "sizeBytes": inspected["Size"],
        "imageId": inspected["Id"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Use pinned SWE-bench code to resolve the official x86_64 image key."
    )
    parser.add_argument("instance_id")
    parser.add_argument("--pull", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    image = resolve_image(args.instance_id)
    result: dict[str, Any] = {"image": image, "platform": DOCKER_PLATFORM}
    if args.pull:
        result = pull_image(image)

    if args.json:
        print(json.dumps(result, sort_keys=True))
    else:
        print(image)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
