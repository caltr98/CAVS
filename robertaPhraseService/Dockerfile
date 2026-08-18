# syntax=docker/dockerfile:1.6

ARG CAVS_SOURCE_SHA256=unversioned
FROM python:3.10-slim@sha256:c1e4e6c01eb489c422288b2de34b0761ca316f7a2d98e2c33f47659a73ed108a
ARG CAVS_SOURCE_SHA256
LABEL org.opencontainers.image.cavs-source-sha256="${CAVS_SOURCE_SHA256}"

WORKDIR /app

COPY requirements-rev4.lock.txt /app/requirements-rev4.lock.txt

RUN --mount=type=cache,target=/root/.cache/pip \
  pip install "pip==24.3.1" \
  && pip install --index-url https://download.pytorch.org/whl/cpu "torch==2.13.0+cpu" \
  && pip install --requirement /app/requirements-rev4.lock.txt \
  && pip check

COPY robertaPhraseServer.py /app/robertaPhraseServer.py

ENV ROBERTA_PHRASE_MODEL=sentence-transformers/all-distilroberta-v1 \
    ROBERTA_PHRASE_MODEL_REVISION=842eaed40bee4d61673a81c92d5689a8fed7a09f

# Resolve and bake the model during the qualified image build. Runtime
# containers resolve models offline and have no mutable cache volume.
RUN python - <<'PY'
from sentence_transformers import SentenceTransformer

SentenceTransformer(
    "sentence-transformers/all-distilroberta-v1",
    revision="842eaed40bee4d61673a81c92d5689a8fed7a09f",
)
SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
PY

ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

EXPOSE 5004

CMD ["python", "robertaPhraseServer.py"]
