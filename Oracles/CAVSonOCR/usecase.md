# OCR Queue Input Use Cases

These are queue inputs for the OCR stack in [`Oracles/CAVSonOCR`](/home/cal/componentsCAVS/Oracles/CAVSonOCR).

The important point is: the oracles do not accept requests directly. You submit work to the queue at:

```bash
POST http://127.0.0.1:20000/requests
```

For validation against:

`/home/cal/componentsCAVS/Validation/liar2/data/final/ablation/liar2_ablation_reference.json`

the fields to compare are only:

- `competent`
- `confidence`
- `reason`

Those correspond to:

- `competent_skills_gpt`
- `competent_confidence_skills_gpt`
- `competent_reason_skills_gpt`

Use this holder DID from [`test.rest`](/home/cal/componentsCAVS/test.rest#L133):

```text
did:ethr:sepolia:0x0242ccfbd55f4e1816ce6aec889161764227c48f2234feac158ecacd9cb94836a1
```

## 1. Competent = true

Validation target:

```text
statement: Chuck Grassley was "voting to slash Medicare" when voting against the debt ceiling bill.
competent_skills_gpt: true
competent_confidence_skills_gpt: 0.9
competent_reason_skills_gpt: The author has extensive skills in legislation procedure, government policy implementation, public administration, policy analysis, political science, and political campaigning, which are directly aligned with assessing claims about congressional voting, legislative processes, and political disputes.
```

Queue request:

```bash
 -s -X POST http://127.0.0.1:20000/requests \
  -H 'Content-Type: application/json' \
  -d '{
    "statement": "Chuck Grassley was \"voting to slash Medicare\" when voting against the debt ceiling bill.",
    "holderDid": "did:ethr:sepolia:0x0242ccfbd55f4e1816ce6aec889161764227c48f2234feac158ecacd9cb94836a1",
    "authorSkills": [
      {"label":"legislation procedure","uri":"http://data.europa.eu/esco/skill/33406020-ae9d-495f-a635-0b97e5346d8c"},
      {"label":"government policy implementation","uri":"http://data.europa.eu/esco/skill/2be699a7-416a-4f32-967c-4edc65027b71"},
      {"label":"public administration","uri":"http://data.europa.eu/esco/skill/d39022ab-d102-4720-b689-540d6f056b17"},
      {"label":"policy analysis","uri":"http://data.europa.eu/esco/skill/c5449667-9b40-4114-8d74-f51177669984"},
      {"label":"political science","uri":"http://data.europa.eu/esco/skill/309bc48b-2899-4396-9242-efc26c0e1aee"},
      {"label":"political campaigning","uri":"http://data.europa.eu/esco/skill/4bc7fcff-54a5-4ff0-8f5e-a7c2479b522c"}
    ]
  }'
```

## 2. Competent = true

Validation target:

```text
statement: An Obama campaign tactic for rallying voters is to "offer them cell phones.
competent_skills_gpt: true
competent_confidence_skills_gpt: 0.8
competent_reason_skills_gpt: The author has multiple skills in political science, political campaigning, government policy, and public administration, which are directly relevant to assessing claims about campaign tactics and government programs.
```

Queue request:

```bash
curl -s -X POST http://127.0.0.1:20000/requests \
  -H 'Content-Type: application/json' \
  -d '{
    "statement": "An Obama campaign tactic for rallying voters is to \"offer them cell phones.",
    "holderDid": "did:ethr:sepolia:0x0242ccfbd55f4e1816ce6aec889161764227c48f2234feac158ecacd9cb94836a1",
    "authorSkills": [
      {"label":"political science","uri":"http://data.europa.eu/esco/skill/309bc48b-2899-4396-9242-efc26c0e1aee"},
      {"label":"political campaigning","uri":"http://data.europa.eu/esco/skill/4bc7fcff-54a5-4ff0-8f5e-a7c2479b522c"},
      {"label":"government policy implementation","uri":"http://data.europa.eu/esco/skill/2be699a7-416a-4f32-967c-4edc65027b71"},
      {"label":"public administration","uri":"http://data.europa.eu/esco/skill/d39022ab-d102-4720-b689-540d6f056b17"}
    ]
  }'
```

## 3. Competent = false

Validation target:

```text
statement: The CDC said that 75% of COVID-19 deaths have involved people with at least four comorbidities.
competent_skills_gpt: false
competent_confidence_skills_gpt: 0.2
competent_reason_skills_gpt: The claim is in the health/medicine domain, but the author lacks any health, medical, or epidemiological skills.
```

Queue request:

```bash
curl -s -X POST http://127.0.0.1:20000/requests \
  -H 'Content-Type: application/json' \
  -d '{
    "statement": "The CDC said that 75% of COVID-19 deaths have involved people with at least four comorbidities.",
    "holderDid": "did:ethr:sepolia:0x0242ccfbd55f4e1816ce6aec889161764227c48f2234feac158ecacd9cb94836a1",
    "authorSkills": [
      {"label":"participate in sport events","uri":"http://data.europa.eu/esco/skill/3d102bed-1232-43f7-9ae3-f672a1798f90"},
      {"label":"literature","uri":"http://data.europa.eu/esco/skill/0ab9d433-10e5-4683-ae54-4687179a5259"},
      {"label":"provide leadership","uri":"http://data.europa.eu/esco/skill/3740b2a0-c94e-4116-bf18-f9fdd5b59f56"}
    ]
  }'
```

## Read The Oracle Output

Submit one request and store the returned id:

```bash
REQ_ID=$(curl -s -X POST http://127.0.0.1:20000/requests \
  -H 'Content-Type: application/json' \
  -d '{
    "statement": "The CDC said that 75% of COVID-19 deaths have involved people with at least four comorbidities.",
    "holderDid": "did:ethr:sepolia:0x0242ccfbd55f4e1816ce6aec889161764227c48f2234feac158ecacd9cb94836a1",
    "authorSkills": [
      {"label":"participate in sport events","uri":"http://data.europa.eu/esco/skill/3d102bed-1232-43f7-9ae3-f672a1798f90"},
      {"label":"literature","uri":"http://data.europa.eu/esco/skill/0ab9d433-10e5-4683-ae54-4687179a5259"},
      {"label":"provide leadership","uri":"http://data.europa.eu/esco/skill/3740b2a0-c94e-4116-bf18-f9fdd5b59f56"}
    ]
  }' | jq -r '.requestId')
```

Then inspect the aggregate result:

```bash
curl -s http://127.0.0.1:20000/requests/$REQ_ID | jq '.result | {competent, confidence, reason}'
```

Or inspect each oracle observation:

```bash
curl -s http://127.0.0.1:20000/requests/$REQ_ID/observations | jq '.[] | {oracleId, competent, confidence, reason}'
```

That is the part that should be compared with the validation JSON.
curl
