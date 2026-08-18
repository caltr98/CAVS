#!/bin/bash
set -euo pipefail

if [[ -n "${VERAMO_SUBMITTER_PRIVATE_KEY_FILE:-}" && -r "${VERAMO_SUBMITTER_PRIVATE_KEY_FILE}" ]]; then
    export VERAMO_SUBMITTER_PRIVATE_KEY="$(tr -d '\r\n' < "${VERAMO_SUBMITTER_PRIVATE_KEY_FILE}")"
fi
if [[ -n "${VERAMO_KMS_SECRET_KEY_FILE:-}" && -r "${VERAMO_KMS_SECRET_KEY_FILE}" ]]; then
    export VERAMO_KMS_SECRET_KEY="$(tr -d '\r\n' < "${VERAMO_KMS_SECRET_KEY_FILE}")"
fi

DATA_DIR=/usr/src/app/data
RUNTIME_ENV_FILE="${VERAMO_RUNTIME_ENV_FILE:-/usr/src/app/runtime-config.env}"
mkdir -p "$DATA_DIR"
RUNTIME_STATE_FILE="${VERAMO_RUNTIME_STATE_FILE:-$DATA_DIR/runtime-state.env}"

# Keep stable sqlite filenames so oracle DID/account bindings survive restarts.
export DB_FILE="$DATA_DIR/database.sqlite"
export DB_FILE_ETH="$DATA_DIR/database.sqlite2"

read_env_value() {
    local key="$1"
    local file="$2"
    local line

    [[ -f "$file" ]] || return 1
    line=$(grep -E "^${key}=" "$file" | tail -n 1 || true)
    [[ -n "$line" ]] || return 1
    printf '%s\n' "${line#*=}"
}

read_setting() {
    local key="$1"
    local env_value="${!key:-}"

    if [[ -n "$env_value" ]]; then
        printf '%s\n' "$env_value"
        return 0
    fi

    if [[ -f "$RUNTIME_ENV_FILE" ]]; then
        read_env_value "$key" "$RUNTIME_ENV_FILE" || return 1
        return 0
    fi

    return 1
}

# File-backed Docker secrets are preferred, but older generated benchmark
# stacks mount the owner-controlled runtime env without wiring a dedicated KMS
# secret. Support that format so the agent receives the same required value
# without embedding it in the Compose file or image configuration.
if [[ -z "${VERAMO_KMS_SECRET_KEY:-}" ]]; then
    export VERAMO_KMS_SECRET_KEY="$(read_setting "VERAMO_KMS_SECRET_KEY" || true)"
fi

generate_eth_private_key() {
    node --input-type=module -e "const { Wallet } = await import('ethers'); console.log(Wallet.createRandom().privateKey);"
}

auto_fund_submitter_private_key() {
    local submitter_key="$1"
    local rpc_url=""
    local funder_key=""
    local target_balance_eth="0.02"
    local gas_reserve_eth="0.005"

    rpc_url=$(read_setting "OCR_CONTRACT_RPC_URL" || true)
    funder_key=$(read_setting "AUTHOR_FUNDER_PRIVATE_KEY" || true)
    if [[ -z "$funder_key" ]]; then
        funder_key=$(read_setting "OCR_FUNDER_PRIVATE_KEY" || true)
    fi
    if [[ -z "$funder_key" ]]; then
        funder_key=$(read_setting "PRIVATE_KEY" || true)
    fi
    target_balance_eth=$(read_setting "AUTHOR_TARGET_BALANCE_ETH" || printf '%s\n' "0.25")
    gas_reserve_eth=$(read_setting "AUTHOR_FUNDER_GAS_RESERVE_ETH" || printf '%s\n' "0.005")

    if [[ -z "$rpc_url" || -z "$funder_key" ]]; then
        echo "veramo skipped auto-funding generated submitter key (missing OCR_CONTRACT_RPC_URL or funder private key)"
        return 0
    fi

    # Every oracle uses the same local Anvil funder. Serialize funding so
    # concurrent startups cannot submit different transactions with one nonce.
    local funding_lock=""
    if [[ -d /registry && -w /registry ]]; then
        funding_lock=/registry/veramo-submitter-funding.lock
        while ! mkdir "$funding_lock" 2>/dev/null; do
            sleep 0.1
        done
        trap "rmdir -- $(printf '%q' "$funding_lock") 2>/dev/null || true" EXIT
    fi

    OCR_CONTRACT_RPC_URL="$rpc_url" \
    PRIVATE_KEY="$funder_key" \
    VERAMO_SUBMITTER_PRIVATE_KEY="$submitter_key" \
    AUTHOR_TARGET_BALANCE_ETH="$target_balance_eth" \
    AUTHOR_FUNDER_GAS_RESERVE_ETH="$gas_reserve_eth" \
    node --input-type=module - <<'EOF'
const { JsonRpcProvider, Wallet, formatEther, parseEther } = await import('ethers');

function normalizePrivateKey(value, label) {
    const trimmed = String(value || '').trim();
    const normalized = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
        throw new Error(`${label} must be a 32-byte secp256k1 private key`);
    }
    return normalized;
}

const rpcUrl = String(process.env.OCR_CONTRACT_RPC_URL || '').trim();
const funderKey = normalizePrivateKey(process.env.PRIVATE_KEY, 'PRIVATE_KEY');
const submitterKey = normalizePrivateKey(process.env.VERAMO_SUBMITTER_PRIVATE_KEY, 'VERAMO_SUBMITTER_PRIVATE_KEY');
const targetBalance = parseEther(String(process.env.AUTHOR_TARGET_BALANCE_ETH || '0.25').trim());
const gasReserve = parseEther(String(process.env.AUTHOR_FUNDER_GAS_RESERVE_ETH || '0.005').trim());

if (!rpcUrl) {
    throw new Error('OCR_CONTRACT_RPC_URL is required for auto-funding');
}

const provider = new JsonRpcProvider(rpcUrl);
const funder = new Wallet(funderKey, provider);
const submitter = new Wallet(submitterKey);

const [funderBalance, currentBalance] = await Promise.all([
    provider.getBalance(funder.address),
    provider.getBalance(submitter.address),
]);

console.log(`veramo auto-fund funder=${funder.address} balance=${formatEther(funderBalance)} ETH`);
console.log(`veramo auto-fund submitter=${submitter.address} balance=${formatEther(currentBalance)} ETH target=${formatEther(targetBalance)} ETH`);

if (submitter.address.toLowerCase() === funder.address.toLowerCase()) {
    console.log('veramo auto-fund skipped because submitter key matches the funder');
    process.exit(0);
}

if (currentBalance >= targetBalance) {
    console.log('veramo auto-fund skipped because submitter already meets target balance');
    process.exit(0);
}

if (funderBalance <= gasReserve) {
    throw new Error(`funder balance ${formatEther(funderBalance)} ETH is below reserve ${formatEther(gasReserve)} ETH`);
}

const missingBalance = targetBalance - currentBalance;
let tx;
for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
        // Fetch the pending nonce on every attempt. Other startup components
        // may use the same Anvil funder outside this file-system lock.
        const nonce = await provider.getTransactionCount(funder.address, 'pending');
        tx = await funder.sendTransaction({
            to: submitter.address,
            value: missingBalance,
            nonce,
        });
        break;
    } catch (error) {
        const text = String(error?.shortMessage || error?.message || error).toLowerCase();
        const retryable = text.includes('replacement') || text.includes('nonce') || text.includes('underpriced');
        const fundedBalance = await provider.getBalance(submitter.address);
        if (fundedBalance >= targetBalance) {
            console.log(`veramo auto-fund completed concurrently final_balance=${formatEther(fundedBalance)} ETH`);
            process.exit(0);
        }
        if (!retryable || attempt === 8) throw error;
        console.warn(`veramo auto-fund nonce retry ${attempt}/8: ${error?.shortMessage || error?.message || error}`);
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
}
if (!tx) throw new Error('auto-funding transaction was not submitted');
console.log(`veramo auto-fund submitted tx=${tx.hash} amount=${formatEther(missingBalance)} ETH`);
const receipt = await tx.wait();
if (!receipt || receipt.status !== 1) {
    throw new Error(`auto-funding tx ${tx.hash} reverted`);
}
const finalBalance = await provider.getBalance(submitter.address);
console.log(`veramo auto-fund complete final_balance=${formatEther(finalBalance)} ETH receipt=${receipt.hash}`);
EOF

    if [[ -n "$funding_lock" ]]; then
        rmdir "$funding_lock"
        trap - EXIT
    fi
}

ensure_submitter_private_key() {
    local configured_key="${VERAMO_SUBMITTER_PRIVATE_KEY:-}"
    local generated_key=0
    local lock_file="${RUNTIME_STATE_FILE}.lock"

    if [[ -z "$configured_key" && -f "$RUNTIME_ENV_FILE" ]]; then
        configured_key=$(read_env_value "VERAMO_SUBMITTER_PRIVATE_KEY" "$RUNTIME_ENV_FILE" || true)
    fi
    if [[ -z "$configured_key" && -f "$RUNTIME_ENV_FILE" ]]; then
        configured_key=$(read_env_value "SUBMITTER_PRIVATE_KEY" "$RUNTIME_ENV_FILE" || true)
    fi
    if [[ -z "$configured_key" && -f "$RUNTIME_STATE_FILE" ]]; then
        configured_key=$(read_env_value "VERAMO_SUBMITTER_PRIVATE_KEY" "$RUNTIME_STATE_FILE" || true)
    fi

    while ! (set -o noclobber; : >"$lock_file") 2>/dev/null; do
        sleep 0.1
    done
    # Expand the path while lock_file is still in scope. A later command may
    # fail under `set -e`; an EXIT trap must not reference an expired local.
    trap "rm -f -- $(printf '%q' "$lock_file")" EXIT

    if [[ -z "$configured_key" && -f "$RUNTIME_STATE_FILE" ]]; then
        configured_key=$(read_env_value "VERAMO_SUBMITTER_PRIVATE_KEY" "$RUNTIME_STATE_FILE" || true)
    fi
    if [[ -z "$configured_key" ]]; then
        configured_key=$(generate_eth_private_key)
        generated_key=1
    fi

    # The runtime environment is a shared, read-only configuration mount.
    # Persist generated per-service state in the service's writable data volume.
    mkdir -p "$(dirname "$RUNTIME_STATE_FILE")"
    touch "$RUNTIME_STATE_FILE"
    if grep -Eq '^VERAMO_SUBMITTER_PRIVATE_KEY=$' "$RUNTIME_STATE_FILE"; then
        sed -i "s#^VERAMO_SUBMITTER_PRIVATE_KEY=\$#VERAMO_SUBMITTER_PRIVATE_KEY=${configured_key}#" "$RUNTIME_STATE_FILE"
    elif ! grep -Eq '^VERAMO_SUBMITTER_PRIVATE_KEY=' "$RUNTIME_STATE_FILE"; then
        printf '\nVERAMO_SUBMITTER_PRIVATE_KEY=%s\n' "$configured_key" >>"$RUNTIME_STATE_FILE"
    fi

    rm -f "$lock_file"
    trap - EXIT

    export VERAMO_SUBMITTER_PRIVATE_KEY="$configured_key"
    if [[ "$generated_key" -eq 1 ]]; then
        echo "veramo generated VERAMO_SUBMITTER_PRIVATE_KEY and persisted it to ${RUNTIME_STATE_FILE}"
        auto_fund_submitter_private_key "$configured_key"
    else
        echo "veramo using configured VERAMO_SUBMITTER_PRIVATE_KEY"
    fi
}

ensure_submitter_private_key

export_runtime_setting_if_missing() {
    local key="$1"
    local value="${!key:-}"
    if [[ -n "$value" ]]; then
        export "$key=$value"
        return 0
    fi
    value=$(read_setting "$key" || true)
    if [[ -n "$value" ]]; then
        export "$key=$value"
    fi
}

export_runtime_setting_if_missing OCR_CONTRACT_RPC_URL
export_runtime_setting_if_missing DID_RESOLVER_RPC_URL
export_runtime_setting_if_missing PRIVATE_KEY
export_runtime_setting_if_missing AUTHOR_TARGET_BALANCE_ETH
export_runtime_setting_if_missing AUTHOR_FUNDER_GAS_RESERVE_ETH

echo "veramo using DB_FILE=${DB_FILE} DB_FILE_ETH=${DB_FILE_ETH}"

exec node --loader ts-node/esm veramoRestAgent.ts
