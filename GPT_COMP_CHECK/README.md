# GPT Competence Checker

This service exposes the GPT-based competence classifier used by CAVS.

## Endpoints

- `GET /healthz`
- `POST /competence`
- `POST /extract` (alias)

The request body accepts:

```json
{
  "statement": "text of the claim",
  "skills": ["skill a", "skill b"],
  "model": "gpt-4.1",
  "temperature": 0,
  "api_key": "optional override",
  "base_url": "optional override"
}
```

The response returns:

```json
{
  "competent_skill_gpt": true,
  "competent_confidence_skill_gpt": 0.66,
  "competent_reason_skill_gpt": "Reasoning sentence...",
  "raw": {}
}
```

## Configuration

- `OPENAI_COMPETENCE_API_KEY` or `OPENAI_API_KEY`
- `OPENAI_COMPETENCE_BASE_URL` or `OPENAI_BASE_URL`
- `OPENAI_COMPETENCE_MODEL` or `OPENAI_MODEL`
- `OPENAI_COMPETENCE_TEMPERATURE` or `OPENAI_TEMPERATURE`
- `OPENAI_TIMEOUT_S`
- `ESCO_ONTOLOGY_PATH`

The service validates incoming skill URIs against the ESCO ontology file before
calling the model.

## Run Locally

```bash
cd GPT_COMP_CHECK
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
OPENAI_API_KEY=sk-... ESCO_ONTOLOGY_PATH=../esco-v1.2.1.jsonl \
  uvicorn app:app --host 0.0.0.0 --port 3030
```

## Docker

```bash
docker build -t gpt-comp-check .
docker run -p 3030:3030 -e OPENAI_API_KEY=sk-... gpt-comp-check
```
