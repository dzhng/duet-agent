#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

docker run --rm \
  -v "$REPO_ROOT:/src:ro" \
  -w /work \
  -e HOME=/tmp/home \
  -e DUET_TEST_IN_DOCKER=1 \
  oven/bun:1.3.11 \
  sh -lc '
    tar -C /src \
      --exclude="./.env*" \
      --exclude=./.git \
      --exclude=./benchmarks/swebench/.cache \
      --exclude=./benchmarks/swebench/.venv \
      --exclude=./benchmarks/swebench/runs \
      --exclude=./dist \
      --exclude=./node_modules \
      -cf - . |
      tar -C /work -xf -
    bun install --frozen-lockfile >/dev/null
    bun test ./benchmarks/swebench/test/*.test.ts
  '
