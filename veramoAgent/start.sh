#!/bin/bash
set -euo pipefail

DATA_DIR=/usr/src/app/data
mkdir -p "$DATA_DIR"

# Pick a fresh sqlite filename to avoid reusing a DB that might contain conflicting aliases.
pick_db() {
  local base="$1"
  if [ ! -e "$base" ]; then
    echo "$base"
    return
  fi
  mktemp "${base}.XXXXXX"
}

export DB_FILE="$(pick_db "$DATA_DIR/database.sqlite")"
export DB_FILE_ETH="$(pick_db "$DATA_DIR/database.sqlite2")"

echo "veramo using DB_FILE=${DB_FILE} DB_FILE_ETH=${DB_FILE_ETH}"

exec node --loader ts-node/esm veramoRestAgent.ts
