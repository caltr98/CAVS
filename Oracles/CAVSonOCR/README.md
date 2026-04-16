# CAVSonOCR

This directory contains the active CAVS oracle deployment. It runs a four-node
OCR network where each oracle uses its own CAVS service instance for skill
extraction, competence scoring, and VC issuance.

## Start Here

- `docker-compose.yml`
  Main deployment file.
- `.env.example`
  Environment template.
- `Oracle/noncentralized/`
  Smart-contract registry support for on-chain mode.
- `main.go`, `main_queue.go`, `queue_node.go`
  Go entry points for oracle and queue behavior.

## Compose Profiles

- `centralized`
  Local HTTP queue mode.
- `smart-contract`
  On-chain registry with direct oracle request delivery.
- `nesta`
  OJD/Nesta extraction services for competence mode.

## Run Local Queue Mode

```bash
cd Oracles/CAVSonOCR
cp .env.example .env
OCR_SEED=12345 docker compose --profile centralized --profile nesta up --build
```

The local queue listens on `http://127.0.0.1:20000`.

## Run Smart-Contract Mode

```bash
cd Oracles/CAVSonOCR
cp .env.example .env
OCR_SEED=12345 \
OCR_CONTRACT_RPC_URL=https://your-rpc-endpoint \
OCR_CONTRACT_ADDRESS=0xYourContract \
docker compose --profile smart-contract --profile nesta up --build
```

## Use GPT Instead Of Nesta

Omit the `nesta` profile and set:

```bash
CAVS_COMPETENCE_MODE=gpt
```

Example:

```bash
OCR_SEED=12345 CAVS_COMPETENCE_MODE=gpt \
  docker compose --profile centralized up --build
```

The shared bootstrap seed is required. The per-oracle seeds default to
`101`, `202`, `303`, and `404`, and can be overridden with
`OCR_ORACLE0_SEED` through `OCR_ORACLE3_SEED`.

## Local Queue Requests

Submit a request:

```bash
curl -s -X POST http://127.0.0.1:20000/requests \
  -H 'Content-Type: application/json' \
  -d '{"statement":"I built Docker pipelines in Python and worked on NLP models."}'
```

Poll a request:

```bash
curl -s http://127.0.0.1:20000/requests/<id>
```

Inspect per-oracle observations:

```bash
curl -s http://127.0.0.1:20000/requests/<id>/observations
```

## Stop

```bash
docker compose down -v
```
