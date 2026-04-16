# CAVS

CAVS is a Credibility Assessment and Verification System built around a Veramo
credential backend, skill extraction services, LIAR2 validation assets, and an
OCR-style oracle network.

## Start Here

- `docker-compose.yaml`
  Local stack for the web client, backend, Veramo agent, and extraction
  services.
- `veramoAgent/CAVSBackend/`
  Main backend API and VC issuance flow.
- `Validation/liar2/`
  LIAR2 datasets, retained outputs, and pipeline scripts.
- `Oracles/CAVSonOCR/`
  Active decentralized oracle deployment.
- `GPT_COMP_CHECK/`
  GPT-based competence classification service.
- `chrome-extension/`
  Reddit browser extension.
- `veramoAgent/MultiSignatureVeramo/`
  BLS and multisignature Veramo work.

## Run The Local Stack

```bash
export OPENAI_API_KEY=your_key_here
docker compose up --build
```

Open these services after startup:

- client: `http://localhost:3000`
- CAVS backend: `http://localhost:4200`
- Veramo agent: `http://localhost:3001`
- GPT competence service: `http://localhost:3030`

The default backend competence mode is `nesta`. To switch the backend to the
GPT competence path, set `CAVS_COMPETENCE_MODE=gpt` before starting the stack.

## Main Backend Endpoints

- `POST http://localhost:4200/api/extract`
- `GET http://localhost:4200/api/pipeline_config`
- `POST http://localhost:4200/api/pipeline_config`
- `POST http://localhost:4200/api/vc`

## Repo Map

- `Validation/`
  Validation data, LIAR2 outputs, and supporting lookup files.
- `Oracles/`
  Oracle network code and smart-contract registry support.
- `veramoAgent/`
  Veramo agent, backend, client, and multisignature package.
- `keyBertService/`, `keyLLMService/`, `robertaPhraseService/`,
  `ojd_daps_skillsService/`
  Extraction and enrichment services used by the backend.
- `CAVS.pdf`
  Architecture and experiment document.
