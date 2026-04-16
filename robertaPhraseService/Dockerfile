# syntax=docker/dockerfile:1.6

FROM python:3.10-slim

WORKDIR /app

RUN --mount=type=cache,target=/root/.cache/pip \
  pip install --upgrade pip \
  && pip install --index-url https://download.pytorch.org/whl/cpu torch \
  && pip install flask sentence-transformers scikit-learn numpy

COPY robertaPhraseServer.py /app/robertaPhraseServer.py

ENV ROBERTA_PHRASE_MODEL=sentence-transformers/all-distilroberta-v1

EXPOSE 5004

CMD ["python", "robertaPhraseServer.py"]
