#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LIAR2_ROOT="$SCRIPT_DIR/liar2"
RESULT_FILE="$LIAR2_ROOT/resulting_data.txt"

cd "$REPO_ROOT"
mkdir -p "$LIAR2_ROOT"
: > "$RESULT_FILE"

run_case() {
  local title="$1"
  local script_path="$2"

  if [[ ! -f "$script_path" ]]; then
    {
      echo
      echo "===== ${title} ====="
      echo "Missing script: ${script_path}"
    } >> "$RESULT_FILE"
    return 1
  fi

  {
    echo
    echo "===== ${title} ====="
    echo "Command: python3 ${script_path}"
    python3 "$script_path"
  } >> "$RESULT_FILE" 2>&1
}

{
  echo "CAVS LIAR2 ablation run"
  echo "Started: $(date -Iseconds)"
  echo "Repository: $REPO_ROOT"
  echo "Results: $RESULT_FILE"
} >> "$RESULT_FILE"

cases=(
  "1.1 statement (multiclass baseline)|Validation/liar2/ablation_experiments/1.1.statement.py"
  "4.7 statement_iscompetent_confidence_reason|Validation/liar2/ablation_experiments/4.7.statement_iscompetent_confidence_reason.py"
  "4.14 statement_iscompetent_confidence_reason_roberta_nesta|Validation/liar2/ablation_experiments/4.14.statement_iscompetent_confidence_reason_roberta_nesta.py"
)

status=0
for case in "${cases[@]}"; do
  IFS='|' read -r title script_path <<<"$case"
  if ! run_case "$title" "$script_path"; then
    status=1
  fi
done

{
  echo
  echo "Finished: $(date -Iseconds)"
} >> "$RESULT_FILE"

echo "Wrote all output to $RESULT_FILE"
exit "$status"
