#!/usr/bin/env python3
"""Resolve and optionally pull an official SWE-bench instance image."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from typing import Any

IMAGE_NAMESPACE = "swebench"
IMAGE_ARCH = "x86_64"
DOCKER_PLATFORM = "linux/amd64"
INSTANCE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$")


def resolve_image(instance_id: str) -> str:
    if INSTANCE_ID_PATTERN.fullmatch(instance_id) is None:
        raise ValueError(f"invalid SWE-bench instance id: {instance_id!r}")
    # SWE-bench 4.1.0's TestSpec derives remote instance images solely from
    # these values. Deriving the same key locally avoids a mutable Hub lookup.
    key = f"sweb.eval.{IMAGE_ARCH}.{instance_id.lower()}:latest"
    return f"{IMAGE_NAMESPACE}/{key}".replace("__", "_1776_")


def pull_image(image: str) -> dict[str, Any]:
    pull_command = ["docker", "pull", "--platform", DOCKER_PLATFORM, image]
    for attempt in range(1, 4):
        result = subprocess.run(pull_command, check=False, stdout=sys.stderr)
        if result.returncode == 0:
            break
        if attempt == 3:
            raise subprocess.CalledProcessError(result.returncode, pull_command)
        time.sleep(attempt * 2)
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
