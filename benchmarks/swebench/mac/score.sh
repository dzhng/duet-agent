#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PYTHON="${DUET_SWEBENCH_VENV:-$BENCH_DIR/.venv}/bin/python"

[[ $# -eq 2 ]] || {
  printf 'Usage: score.sh PREDICTIONS_DIR OUTPUT_DIR\n' >&2
  exit 2
}
[[ -x "$PYTHON" ]] || {
  printf 'error: run %s/provision.sh first\n' "$SCRIPT_DIR" >&2
  exit 1
}

exec "$PYTHON" "$SCRIPT_DIR/score_predictions.py" \
  --predictions-dir "$1" \
  --output-dir "$2"
