#!/bin/sh
# Ensure the LRCLIB SQLite db-dump is present on the mounted /data volume
# (download + decompress once, cached across restarts + rebuilds), then serve
# it. The dump filenames on https://lrclib.net/db-dumps are timestamped with no
# stable "latest" alias, so the specific dump is chosen via LRCLIB_DUMP_URL.
set -eu

DB="${LRCLIB_DB_PATH:-/data/db.sqlite3}"
PORT="${LRCLIB_PORT:-3300}"

if [ ! -f "$DB" ]; then
  if [ -z "${LRCLIB_DUMP_URL:-}" ]; then
    echo "[lrclib] No database at $DB and LRCLIB_DUMP_URL is unset." >&2
    echo "[lrclib] Pick a current dump from https://lrclib.net/db-dumps and set" >&2
    echo "[lrclib] LRCLIB_DUMP_URL (e.g. .../lrclib-db-dump-<timestamp>.sqlite3.gz)." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$DB")"
  echo "[lrclib] Fetching dump (multi-GB, one-time): $LRCLIB_DUMP_URL" >&2
  # -C - resumes a partial download so a dropped connection doesn't restart the
  # whole multi-GB transfer.
  case "$LRCLIB_DUMP_URL" in
    *.gz)
      gz="$DB.download.gz"
      curl -fL --retry 5 --retry-delay 5 -C - "$LRCLIB_DUMP_URL" -o "$gz"
      echo "[lrclib] Decompressing ..." >&2
      gunzip -c "$gz" > "$DB.partial"
      rm -f "$gz"
      ;;
    *)
      curl -fL --retry 5 --retry-delay 5 -C - "$LRCLIB_DUMP_URL" -o "$DB.partial"
      ;;
  esac
  # Rename only after a fully successful download+decompress, so an interrupted
  # run never leaves a truncated db.sqlite3 that would be treated as cached.
  mv "$DB.partial" "$DB"
  echo "[lrclib] Dump ready: $DB" >&2
else
  echo "[lrclib] Using cached database: $DB" >&2
fi

exec lrclib serve --port "$PORT" --database "$DB"
