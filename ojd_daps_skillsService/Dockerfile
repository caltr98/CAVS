# syntax=docker/dockerfile:1.6

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# `ojd-daps-skills` downloads the `en_skillner` spaCy model via a wheel filename that
# newer pip versions reject. Keep pip < 25 so the official download mechanism works.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install "pip<25"

# Install CPU-only PyTorch to avoid pulling large CUDA dependency stacks.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --index-url https://download.pytorch.org/whl/cpu torch

# Install the latest ojd-daps-skills + Flask.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install flask ojd-daps-skills

COPY ojd_daps_skillsService.py /app/ojd_daps_skillsService.py

# Preload Nesta models/taxonomy at build time so container recreation does not
# re-download from HuggingFace on startup.
#
# This triggers:
# - en_skillner wheel install (spaCy model)
# - multiskill classifier download
# - taxonomy embeddings download (ESCO)
RUN python - <<'PY'
from ojd_daps_skills.extract_skills.extract_skills import SkillsExtractor

SkillsExtractor(
    ner_model_name="nestauk/en_skillner",
    ms_model_name="nestauk/multiskill-classifier",
    taxonomy_name="esco",
)

print("OJD-DAPS models preloaded successfully")
PY

EXPOSE 5005

CMD ["python", "ojd_daps_skillsService.py"]
