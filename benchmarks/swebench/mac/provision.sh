#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="${DUET_SWEBENCH_VENV:-$BENCH_DIR/.venv}"
PYTHON="$VENV_DIR/bin/python"

SWEBENCH_VERSION="4.1.0"
MINI_SWE_AGENT_VERSION="2.4.5"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

for command in docker uv sw_vers sysctl; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done

[[ "$(uname -s)" == "Darwin" ]] || fail "this provisioner supports macOS only"
[[ "$(uname -m)" == "arm64" ]] || fail "expected Apple Silicon (arm64), got $(uname -m)"
docker info >/dev/null 2>&1 || fail "Docker Desktop is not running"

if [[ ! -x "$PYTHON" ]]; then
  uv venv --python 3.12 "$VENV_DIR"
fi

"$PYTHON" -c 'import sys; raise SystemExit(sys.version_info[:2] != (3, 12))' || \
  fail "existing venv must use Python 3.12: $VENV_DIR"

uv pip install --python "$PYTHON" \
  "swebench==$SWEBENCH_VERSION" \
  "mini-swe-agent==$MINI_SWE_AGENT_VERSION"

"$PYTHON" "$SCRIPT_DIR/generate_environment_lock.py" \
  --manifest "${DUET_SWEBENCH_MANIFEST:-$BENCH_DIR/manifests/multilingual-30.json}" \
  --output "$SCRIPT_DIR/environment.lock.json"

"$PYTHON" -m unittest discover -s "$SCRIPT_DIR/tests" -p 'test_*.py'

printf '\nMac SWE-bench environment is ready.\n'
printf '  Python: %s\n' "$PYTHON"
printf '  Lock:   %s\n' "$SCRIPT_DIR/environment.lock.json"
printf '  Next:   bash %s/gold-check.sh --instance-id apache__druid-13704\n' "$SCRIPT_DIR"
