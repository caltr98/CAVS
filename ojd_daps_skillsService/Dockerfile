# syntax=docker/dockerfile:1.6

ARG CAVS_SOURCE_SHA256=unversioned
FROM python:3.11-slim@sha256:db3ff2e1800a8581e2c48a27c3995339d47bdf046da21c7627accd3d51053a93
ARG CAVS_SOURCE_SHA256
LABEL org.opencontainers.image.cavs-source-sha256="${CAVS_SOURCE_SHA256}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DEFAULT_TIMEOUT=1000 \
    PIP_RETRIES=20 \
    PIP_PROGRESS_BAR=off

WORKDIR /app

COPY requirements-rev4.lock.txt /app/requirements-rev4.lock.txt

# The exact Python environment used by the pre-revision qualification image is
# frozen here. The en_skillner wheel URL is commit- and SHA-256-pinned.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --timeout 1000 --retries 20 "pip==24.3.1" \
    && pip install --timeout 1000 --retries 20 \
       --requirement /app/requirements-rev4.lock.txt \
    && pip check

COPY ojd_daps_skillsService.py /app/ojd_daps_skillsService.py

# Preload exact Nesta model/taxonomy commits at build time so container
# recreation cannot resolve a moving HuggingFace branch.
#
# This triggers:
# - en_skillner wheel install (spaCy model)
# - multiskill classifier download
# - taxonomy embeddings download (ESCO)
RUN python - <<'PY'
from huggingface_hub import snapshot_download
from ojd_daps_skills.extract_skills.extract_skills import SkillsExtractor
from ojd_daps_skills import PACKAGE_PATH
from ojd_daps_skills.extract_skills.extract_skills_utils import (
    PUBLIC_MODEL_FOLDER_PATH,
)

snapshot_download(
    repo_id="nestauk/multiskill-classifier",
    revision="19eea6bff155af799c349348f0c87960b87ad85e",
    local_dir=PUBLIC_MODEL_FOLDER_PATH / "ms_model",
)
snapshot_download(
    repo_id="nestauk/skills_taxonomy_embeddings",
    repo_type="dataset",
    revision="14b8f527b454abe282c968a199ded2cd8974791b",
    local_dir=PACKAGE_PATH / "data",
    allow_patterns=["esco*_embeddings.json"],
)

SkillsExtractor(
    ner_model_name="nestauk/en_skillner",
    ms_model_name="nestauk/multiskill-classifier",
    taxonomy_name="esco",
)

print("OJD-DAPS models preloaded successfully")
PY

ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

EXPOSE 5005

CMD ["python", "ojd_daps_skillsService.py"]
