ARG CAVS_SOURCE_SHA256=unversioned
FROM python:3.11-slim@sha256:db3ff2e1800a8581e2c48a27c3995339d47bdf046da21c7627accd3d51053a93
ARG CAVS_SOURCE_SHA256
LABEL org.opencontainers.image.cavs-source-sha256="${CAVS_SOURCE_SHA256}"

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY GPT_COMP_CHECK/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY GPT_COMP_CHECK/ .
COPY esco-v1.2.1.jsonl /app/esco-v1.2.1.jsonl

ENV ESCO_ONTOLOGY_PATH=/app/esco-v1.2.1.jsonl

EXPOSE 3030
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "3030"]
