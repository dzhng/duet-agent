#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BENCH_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="${DUET_SWEBENCH_VENV:-$BENCH_DIR/.venv}"
PYTHON="$VENV_DIR/bin/python"
MANIFEST="$BENCH_DIR/manifests/multilingual-30.json"
OUTPUT_DIR="$BENCH_DIR/.cache/gold"
INSTANCE_ID=""
KEEP_IMAGES=0

usage() {
  cat <<'EOF'
Usage: gold-check.sh [--manifest PATH | --instance-id ID] [--output-dir PATH] [--keep-images]

Runs official SWE-bench Multilingual gold patches sequentially with one worker.
The default manifest is benchmarks/swebench/manifests/multilingual-30.json.
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest)
      [[ $# -ge 2 ]] || fail "--manifest requires a path"
      MANIFEST="$2"
      shift 2
      ;;
    --instance-id)
      [[ $# -ge 2 ]] || fail "--instance-id requires an id"
      INSTANCE_ID="$2"
      shift 2
      ;;
    --output-dir)
      [[ $# -ge 2 ]] || fail "--output-dir requires a path"
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --keep-images)
      KEEP_IMAGES=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ -x "$PYTHON" ]] || fail "run $SCRIPT_DIR/provision.sh first"
docker info >/dev/null 2>&1 || fail "Docker Desktop is not running"

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
IDS_FILE="$OUTPUT_DIR/instance-ids.txt"
SUMMARY_TSV="$OUTPUT_DIR/summary.tsv"
PREVIOUS_SUMMARY_TSV="$OUTPUT_DIR/summary.previous.tsv"

if [[ -n "$INSTANCE_ID" ]]; then
  printf '%s\n' "$INSTANCE_ID" > "$IDS_FILE"
else
  [[ -f "$MANIFEST" ]] || fail "manifest not found: $MANIFEST"
  "$PYTHON" - "$MANIFEST" > "$IDS_FILE" <<'PY'
import json
import sys

manifest = json.load(open(sys.argv[1]))
for entry in manifest["entries"]:
    print(entry["instanceId"])
PY
fi

if [[ -f "$SUMMARY_TSV" ]]; then
  cp "$SUMMARY_TSV" "$PREVIOUS_SUMMARY_TSV"
else
  : > "$PREVIOUS_SUMMARY_TSV"
fi
printf 'instance_id\tstatus\telapsed_seconds\tcontainer_peak_bytes\tdisk_peak_bytes\n' > "$SUMMARY_TSV"
run_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
failures=0

while IFS= read -r instance_id; do
  [[ -n "$instance_id" ]] || continue
  safe_id="$(printf '%s' "$instance_id" | tr -c '[:alnum:]_.-' '-')"
  run_id="gold-$run_stamp-$safe_id"
  instance_dir="$OUTPUT_DIR/$safe_id"
  mkdir -p "$instance_dir"

  previous_row="$(awk -F '\t' -v id="$instance_id" '$1 == id && $2 == "resolved" { print; exit }' "$PREVIOUS_SUMMARY_TSV")"
  if [[ -n "$previous_row" ]] && find "$instance_dir" -maxdepth 1 -name 'gold.*.json' -print -quit | grep -q .; then
    printf '%s\n' "$previous_row" >> "$SUMMARY_TSV"
    printf '\n==> %s (already resolved; resume skip)\n' "$instance_id"
    continue
  fi

  printf '\n==> %s\n' "$instance_id"
  image_json="$($PYTHON "$SCRIPT_DIR/official_image.py" "$instance_id" --pull --json)" || {
    printf '%s\tpull_error\t0\t0\t0\n' "$instance_id" >> "$SUMMARY_TSV"
    failures=$((failures + 1))
    continue
  }
  image_key="$($PYTHON -c 'import json,sys; print(json.loads(sys.argv[1])["image"])' "$image_json")"
  printf '%s\n' "$image_json" > "$instance_dir/image.json"

  (
    cd "$instance_dir" || exit 1
    "$PYTHON" "$SCRIPT_DIR/run_with_metrics.py" \
      --output "$instance_dir/metrics.json" \
      --run-id "$run_id" \
      -- \
      "$PYTHON" -m swebench.harness.run_evaluation \
        --dataset_name SWE-bench/SWE-bench_Multilingual \
        --split test \
        --instance_ids "$instance_id" \
        --predictions_path gold \
        --max_workers 1 \
        --cache_level none \
        --clean true \
        --run_id "$run_id"
  )
  scorer_exit=$?

  report="$instance_dir/gold.$run_id.json"
  row="$($PYTHON - "$instance_id" "$report" "$instance_dir/metrics.json" "$scorer_exit" <<'PY'
import json
import sys

instance_id, report_path, metrics_path, exit_code = sys.argv[1:]
metrics = json.load(open(metrics_path)) if __import__('os').path.exists(metrics_path) else {}
status = "scorer_error"
if int(exit_code) == 0 and __import__('os').path.exists(report_path):
    report = json.load(open(report_path))
    if instance_id in report.get("resolved_ids", []):
        status = "resolved"
    elif instance_id in report.get("unresolved_ids", []):
        status = "unresolved"
    elif instance_id in report.get("error_ids", []):
        status = "error"
print("\t".join(map(str, [
    instance_id,
    status,
    metrics.get("elapsedSeconds", 0),
    metrics.get("instanceContainersMemoryPeakBytes", 0),
    metrics.get("hostDiskConsumedPeakBytes", 0),
])))
PY
)"
  printf '%s\n' "$row" >> "$SUMMARY_TSV"
  status="$(printf '%s' "$row" | cut -f2)"
  [[ "$status" == "resolved" ]] || failures=$((failures + 1))

  if [[ "$KEEP_IMAGES" -eq 0 ]]; then
    if docker image inspect "$image_key" >/dev/null 2>&1 && ! docker image rm "$image_key" >/dev/null; then
      printf 'error: could not remove benchmark image %s\n' "$image_key" >&2
      failures=$((failures + 1))
    fi
  fi
done < "$IDS_FILE"

printf '\nGold check summary\n'
column -t -s $'\t' "$SUMMARY_TSV" 2>/dev/null || sed 's/\t/  /g' "$SUMMARY_TSV"
printf '\nArtifacts: %s\n' "$OUTPUT_DIR"

[[ "$failures" -eq 0 ]] || exit 1
