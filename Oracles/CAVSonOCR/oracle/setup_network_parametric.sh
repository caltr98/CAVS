#!/bin/sh
set -eu

echo "[NETWORK] Parametric tc initialization for ORACLE_ID=${ORACLE_ID:-unset}"

start_oracle() {
    exec "$@"
}

run_tc() {
    output="$(tc "$@" 2>&1)" || {
        status="$?"
        echo "$output" >&2
        case "$output" in
            *"Specified qdisc kind is unknown."*)
                echo "[NETWORK] Required tc qdisc support is missing in the Docker host kernel." >&2
                echo "[NETWORK] Load/enable sch_prio, sch_netem, and cls_u32 support before starting the latency-enabled stack." >&2
                ;;
        esac
        exit "$status"
    }
}

if [ "${ENABLE_LATENCY:-true}" != "true" ]; then
    echo "[NETWORK] Latency disabled; skipping tc setup"
    start_oracle "$@"
fi

: "${ORACLE_ID:?ORACLE_ID is required}"
: "${NUM_ORACLES:?NUM_ORACLES is required}"
: "${ORACLE_IPS:?ORACLE_IPS is required}"
: "${ORACLE_LOCATIONS:?ORACLE_LOCATIONS is required}"
: "${LATENCY_MATRIX_FILE:?LATENCY_MATRIX_FILE is required}"

is_uint() {
    case "$1" in
        ''|*[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}

csv_count() {
    printf '%s\n' "$1" | awk -F, '{ print NF }'
}

csv_field() {
    printf '%s\n' "$1" | awk -F, -v n="$2" '{
        value = $n
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        print value
    }'
}

latency_between() {
    src="$1"
    dst="$2"

    if [ "$src" = "$dst" ]; then
        echo 0
        return 0
    fi

    result="$(
        awk -F, -v src="$src" -v dst="$dst" '
            BEGIN {
                status = 4
                found = 0
                col = 0
            }
            NR == 1 {
                for (i = 2; i <= NF; i++) {
                    if ($i == dst) {
                        col = i
                        break
                    }
                }
                if (col == 0) {
                    status = 2
                }
                next
            }
            $1 == src {
                found = 1
                if (col == 0) {
                    status = 2
                    exit
                }
                value = $col
                gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
                if (value == "") {
                    status = 3
                    exit
                }
                print value
                status = 0
                exit
            }
            END {
                if (found == 0 && status != 2) {
                    status = 4
                }
                exit status
            }
        ' "$LATENCY_MATRIX_FILE"
    )" || {
        status="$?"
        case "$status" in
            2) echo "[NETWORK] Missing destination region in latency matrix: $dst" >&2 ;;
            3) echo "[NETWORK] Missing latency pair: $src -> $dst" >&2 ;;
            4) echo "[NETWORK] Missing source region in latency matrix: $src" >&2 ;;
            *) echo "[NETWORK] Failed reading latency matrix for $src -> $dst" >&2 ;;
        esac
        return "$status"
    }

    echo "$result"
}

if ! is_uint "$ORACLE_ID" || ! is_uint "$NUM_ORACLES"; then
    echo "[NETWORK] ORACLE_ID and NUM_ORACLES must be non-negative integers" >&2
    exit 1
fi

if [ "$ORACLE_ID" -ge "$NUM_ORACLES" ]; then
    echo "[NETWORK] ORACLE_ID=$ORACLE_ID is outside NUM_ORACLES=$NUM_ORACLES" >&2
    exit 1
fi

if [ ! -r "$LATENCY_MATRIX_FILE" ]; then
    echo "[NETWORK] Latency matrix is not readable: $LATENCY_MATRIX_FILE" >&2
    exit 1
fi

ip_count="$(csv_count "$ORACLE_IPS")"
if [ "$ip_count" -lt "$NUM_ORACLES" ]; then
    echo "[NETWORK] ORACLE_IPS has $ip_count entries but NUM_ORACLES=$NUM_ORACLES" >&2
    exit 1
fi

location_count="$(csv_count "$ORACLE_LOCATIONS")"
if [ "$location_count" -lt "$NUM_ORACLES" ]; then
    echo "[NETWORK] ORACLE_LOCATIONS has $location_count entries but NUM_ORACLES=$NUM_ORACLES" >&2
    exit 1
fi

src_location="$(csv_field "$ORACLE_LOCATIONS" "$((ORACLE_ID + 1))")"
if [ -z "$src_location" ]; then
    echo "[NETWORK] Empty location for oracle${ORACLE_ID}" >&2
    exit 1
fi

echo "[NETWORK] oracle${ORACLE_ID} assigned Azure region: ${src_location}"

tc qdisc del dev eth0 root 2>/dev/null || true
run_tc qdisc add dev eth0 root handle 1: prio bands "$((NUM_ORACLES + 1))"

i=0
band=1
while [ "$i" -lt "$NUM_ORACLES" ]; do
    if [ "$i" != "$ORACLE_ID" ]; then
        dst_ip="$(csv_field "$ORACLE_IPS" "$((i + 1))")"
        dst_location="$(csv_field "$ORACLE_LOCATIONS" "$((i + 1))")"
        delay_ms="$(latency_between "$src_location" "$dst_location")"

        if [ -n "$dst_ip" ] && [ "$delay_ms" != "0" ]; then
            band="$((band + 1))"
            handle="$((band * 10))"

            echo "[NETWORK] oracle${ORACLE_ID} (${src_location}) -> oracle${i} (${dst_location}) ${dst_ip}: ${delay_ms}ms"

            run_tc qdisc add dev eth0 parent "1:${band}" handle "${handle}:" netem delay "${delay_ms}ms"
            run_tc filter add dev eth0 protocol ip parent 1:0 prio "$band" \
                u32 match ip dst "$dst_ip" flowid "1:${band}"
        fi
    fi

    i="$((i + 1))"
done

echo "[NETWORK] Parametric tc rules applied successfully"
exec "$@"
