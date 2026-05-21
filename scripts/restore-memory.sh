#!/usr/bin/env bash
# Restore ~/.duet/memory.db from the most recent memory.db.corrupted-* backup.
#
# Run this AFTER quitting every duet CLI. It will refuse to run if anything
# still holds the open-lock on the current memory.db.
set -euo pipefail

DUET_DIR="$HOME/.duet"
CURRENT="$DUET_DIR/memory.db"
RESTORE_SRC="$(ls -d "$DUET_DIR"/memory.db.corrupted-* 2>/dev/null | sort | tail -1 || true)"

if [[ -z "$RESTORE_SRC" ]]; then
  echo "no memory.db.corrupted-* backup found under $DUET_DIR" >&2
  exit 1
fi

# Refuse if anything is still holding the current memory.db.
if [[ -f "$CURRENT/.duet-open.lock" ]]; then
  HOLDER="$(head -1 "$CURRENT/.duet-open.lock" 2>/dev/null || echo "")"
  if [[ -n "$HOLDER" ]] && kill -0 "$HOLDER" 2>/dev/null; then
    echo "duet pid $HOLDER still holds $CURRENT/.duet-open.lock; quit it before restoring" >&2
    exit 2
  fi
fi
if [[ -f "$CURRENT/postmaster.pid" ]]; then
  HOLDER="$(head -1 "$CURRENT/postmaster.pid" 2>/dev/null || echo "")"
  if [[ -n "$HOLDER" && "$HOLDER" =~ ^[0-9]+$ ]] && kill -0 "$HOLDER" 2>/dev/null; then
    echo "live postgres process pid $HOLDER still owns $CURRENT/postmaster.pid; quit it before restoring" >&2
    exit 2
  fi
fi

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
ASIDE="$DUET_DIR/memory.db.fresh-pre-restore-$STAMP"

echo "moving current (fresh, empty) $CURRENT aside -> $ASIDE"
mv "$CURRENT" "$ASIDE"

echo "restoring $RESTORE_SRC -> $CURRENT"
mv "$RESTORE_SRC" "$CURRENT"

# Stale locks inside the restored snapshot would block the next open.
rm -f "$CURRENT/.duet-open.lock" "$CURRENT/postmaster.pid"

echo "done. start duet again; it will replay WAL and reopen the restored db."
