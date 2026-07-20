#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

docker run --rm \
  -v "$REPO_ROOT:/src:ro" \
  -w /work \
  -e HOME=/tmp/home \
  -e DUET_TEST_IN_DOCKER=1 \
  oven/bun:1.3.11 \
  sh -lc 'cp -R /src/. /work && bun install --frozen-lockfile >/dev/null && bun test ./benchmarks/swebench/test/*.test.ts'
