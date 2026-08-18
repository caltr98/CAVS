#!/usr/bin/env bash
set -euo pipefail

load_secret() {
    # Declare separately: a single `local a=.. b=${!a}` line evaluates the
    # indirect expansion before `file_var` is assigned on bash 5.2+, which fails
    # with "invalid indirect expansion". Split so file_var is set first.
    local name="$1"
    local file_var="${1}_FILE"
    local file="${!file_var:-}"
    if [[ -n "$file" && -r "$file" ]]; then
        export "$name=$(tr -d '\r\n' < "$file")"
    fi
}
for secret_name in VERAMO_SUBMITTER_PRIVATE_KEY OPENAI_API_KEY PRIVATE_KEY OCR_FUNDER_PRIVATE_KEY AUTHOR_FUNDER_PRIVATE_KEY OCR_QUEUE_AUTH_TOKEN; do
    load_secret "$secret_name"
done

ORACLE_ID="${ORACLE_ID:-0}"
VERAMO_RUNTIME_ENV_FILE="${VERAMO_RUNTIME_ENV_FILE:-/usr/src/app/runtime-config.env}"
QUEUE_ADDR="${QUEUE_ADDR:-0.0.0.0:20000}"
CAVS_PORT="${PORT:-4200}"

export VERAMO_RUNTIME_ENV_FILE
export VERAMO_ENDPOINT="${VERAMO_ENDPOINT:-http://127.0.0.1:3001}"
export PORT="$CAVS_PORT"

mkdir -p /usr/src/app/data /registry

pids=""

start_prefixed() {
    local label="$1"
    shift
    (
        set -o pipefail
        "$@" 2>&1 | sed -u "s/^/[oracle${ORACLE_ID}][${label}] /"
    ) &
    pids="${pids} $!"
}

shutdown() {
    trap - INT TERM EXIT
    for pid in $pids; do
        kill "$pid" 2>/dev/null || true
    done
    wait $pids 2>/dev/null || true
}

trap shutdown INT TERM EXIT

start_prefixed veramo /usr/src/app/veramo-start.sh
start_prefixed queue /cavs-queue -queue_addr="$QUEUE_ADDR"
start_prefixed cavs bash -lc 'cd /usr/src/app/CAVSBackend && exec node CAVSService.js'

wait_tcp() {
    local label="$1"
    local host="$2"
    local port="$3"
    local timeout="${4:-180}"
    local start
    start="$(date +%s)"
    while true; do
        if timeout 2 bash -lc "</dev/tcp/${host}/${port}" >/dev/null 2>&1; then
            echo "[oracle${ORACLE_ID}][entrypoint] ${label} ready on ${host}:${port}"
            return 0
        fi
        if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
            echo "[oracle${ORACLE_ID}][entrypoint] timed out waiting for ${label} on ${host}:${port}" >&2
            return 1
        fi
        sleep 2
    done
}

wait_tcp veramo 127.0.0.1 3001 "${VERAMO_STARTUP_TIMEOUT:-180}"
wait_tcp cavs 127.0.0.1 "$CAVS_PORT" "${CAVS_STARTUP_TIMEOUT:-180}"

start_prefixed ocr /cavs-oracle "$@"

status=0
while true; do
    for pid in $pids; do
        if ! kill -0 "$pid" 2>/dev/null; then
            wait "$pid" || status=$?
            exit "$status"
        fi
    done
    sleep 1
done
