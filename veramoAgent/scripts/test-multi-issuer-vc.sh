#!/usr/bin/env bash
set -euo pipefail

# Simple end-to-end smoke test for multi-issuer VC (BLS + PoO) using veramoRestAgent.
# - Builds the Docker image
# - Spins up one container
# - Creates two issuers and one holder
# - Runs the /mi-vc/* flow end-to-end and verifies the resulting VC
#
# Requires: docker, jq, curl

IMAGE_TAG="veramo-rest-agent:local"
CONTAINER_NAME="veramo-rest-agent-test"
PORT="3001"
BASE_URL="http://127.0.0.1:${PORT}"

cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Building image ${IMAGE_TAG}"
docker build -t "${IMAGE_TAG}" .

echo "==> Starting container ${CONTAINER_NAME} on port ${PORT}"
cleanup
docker run -d --name "${CONTAINER_NAME}" -p "${PORT}:3001" "${IMAGE_TAG}" >/dev/null

echo "==> Waiting for health..."
for i in {1..30}; do
  if curl -sf "${BASE_URL}/health" >/dev/null; then
    break
  fi
  sleep 1
done

if ! curl -sf "${BASE_URL}/health" >/dev/null; then
  echo "Health check failed" >&2
  exit 1
fi

setup_actor() {
  local name="$1"
  curl -sS -X POST "${BASE_URL}/setup" -H 'Content-Type: application/json' -d "{\"name\":\"${name}\"}"
}

echo "==> Creating issuers and holder"
issuer1=$(setup_actor "issuer1")
issuer2=$(setup_actor "issuer2")
holder=$(setup_actor "holder1")

issuer1_did=$(echo "${issuer1}" | jq -r '.did')
issuer1_kid_bls=$(echo "${issuer1}" | jq -r '.kid_bls')
issuer1_pub=$(echo "${issuer1}" | jq -r '.bls_pub_key')

issuer2_did=$(echo "${issuer2}" | jq -r '.did')
issuer2_kid_bls=$(echo "${issuer2}" | jq -r '.kid_bls')
issuer2_pub=$(echo "${issuer2}" | jq -r '.bls_pub_key')

holder_did=$(echo "${holder}" | jq -r '.did')

echo "==> Aggregating BLS keys"
aggregatedKey=$(curl -sS -X POST "${BASE_URL}/bls/aggregate" \
  -H 'Content-Type: application/json' \
  -d "{\"keys\":[\"${issuer1_pub}\",\"${issuer2_pub}\"]}" | jq -r '.aggregatedKey')

echo "==> Building payload"
payload_resp=$(curl -sS -X POST "${BASE_URL}/mi-vc/payload" \
  -H 'Content-Type: application/json' \
  -d @- <<EOF
{
  "issuers": [
    {"did":"${issuer1_did}","kid_bls":"${issuer1_kid_bls}"},
    {"did":"${issuer2_did}","kid_bls":"${issuer2_kid_bls}"}
  ],
  "holder_did": "${holder_did}",
  "aggregatedKey": "${aggregatedKey}",
  "claimCount": 2,
  "valueSize": 14,
  "seed": 42
}
EOF
)
payload=$(echo "${payload_resp}" | jq -c '.payload')

echo "==> Signing payload with issuers"
sign_resp=$(curl -sS -X POST "${BASE_URL}/mi-vc/sign" \
  -H 'Content-Type: application/json' \
  -d @- <<EOF
{
  "issuers": [
    {"did":"${issuer1_did}","kid_bls":"${issuer1_kid_bls}"},
    {"did":"${issuer2_did}","kid_bls":"${issuer2_kid_bls}"}
  ],
  "payload": ${payload}
}
EOF
)
signatures=$(echo "${sign_resp}" | jq -c '.signatures')

echo "==> Creating PoO proofs"
proofs_resp=$(curl -sS -X POST "${BASE_URL}/mi-vc/proofs" \
  -H 'Content-Type: application/json' \
  -d @- <<EOF
{
  "issuers": [
    {"did":"${issuer1_did}","kid_bls":"${issuer1_kid_bls}"},
    {"did":"${issuer2_did}","kid_bls":"${issuer2_kid_bls}"}
  ],
  "holder_did": "${holder_did}",
  "payload": ${payload}
}
EOF
)
proofs=$(echo "${proofs_resp}" | jq -c '.proofsOfOwnership')

echo "==> Finalizing VC"
vc_resp=$(curl -sS -X POST "${BASE_URL}/mi-vc/finalize" \
  -H 'Content-Type: application/json' \
  -d @- <<EOF
{
  "payload": ${payload},
  "signatures": ${signatures},
  "aggregatedKey": "${aggregatedKey}",
  "proofsOfOwnership": ${proofs},
  "store": true
}
EOF
)
vc=$(echo "${vc_resp}" | jq -c '.vc')

echo "==> Verifying VC"
verify_resp=$(curl -sS -X POST "${BASE_URL}/mi-vc/verify" \
  -H 'Content-Type: application/json' \
  -d "{\"vc\": ${vc}}")

verified=$(echo "${verify_resp}" | jq -r '.verified')
if [[ "${verified}" != "true" ]]; then
  echo "Verification failed:"
  echo "${verify_resp}"
  exit 1
fi

echo "Verification response:"
echo "${verify_resp}" | jq '.'

echo "==> Multi-issuer VC flow completed successfully"
echo "Aggregated VC:"
echo "${vc}" | jq '.'
