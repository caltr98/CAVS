from __future__ import annotations

import hashlib
import os
from typing import List, Sequence, Tuple

import numpy as np
from flask import Flask, jsonify, request
from sentence_transformers import SentenceTransformer
from sklearn.feature_extraction.text import CountVectorizer


DEFAULT_MODEL_NAME = os.environ.get("ROBERTA_PHRASE_MODEL", "sentence-transformers/all-distilroberta-v1")

app = Flask(__name__)

phrase_model = None
model_checksum = None


def _get_model() -> SentenceTransformer:
    global phrase_model
    if phrase_model is None:
        phrase_model = SentenceTransformer(DEFAULT_MODEL_NAME)
    return phrase_model


def _compute_checksum(model_name: str) -> str:
    return hashlib.sha256(model_name.encode("utf-8")).hexdigest()


def _parse_bool(raw: str, default: bool = True) -> bool:
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "y", "on"}


def _candidate_phrases(doc: str, ngram_max: int, nr_candidates: int) -> List[str]:
    vectorizer = CountVectorizer(ngram_range=(1, ngram_max), stop_words=None)
    matrix = vectorizer.fit_transform([doc])
    features = vectorizer.get_feature_names_out()
    counts = matrix.toarray()[0]
    ranked = sorted(
        (
            (phrase.strip(), int(count), phrase.count(" ") + 1)
            for phrase, count in zip(features, counts)
            if phrase and not phrase.strip().isdigit()
        ),
        key=lambda item: (-item[1], -item[2], -len(item[0]), item[0]),
    )
    out: List[str] = []
    seen = set()
    for phrase, _, _ in ranked:
        if phrase in seen:
            continue
        seen.add(phrase)
        out.append(phrase)
        if len(out) >= nr_candidates:
            break
    return out


def _semantic_scores(model: SentenceTransformer, doc: str, phrases: Sequence[str]) -> Tuple[np.ndarray, np.ndarray]:
    doc_embedding = model.encode([doc], normalize_embeddings=True, convert_to_numpy=True)
    phrase_embeddings = model.encode(list(phrases), normalize_embeddings=True, convert_to_numpy=True)
    scores = np.matmul(phrase_embeddings, doc_embedding[0])
    return phrase_embeddings, scores


def _mmr_indices(
    phrase_embeddings: np.ndarray,
    scores: np.ndarray,
    top_n: int,
    diversity: float,
) -> List[int]:
    if len(scores) == 0:
        return []
    top_n = min(top_n, len(scores))
    if top_n <= 0:
        return []

    selected = [int(np.argmax(scores))]
    if top_n == 1:
        return selected

    candidate_similarity = np.matmul(phrase_embeddings, phrase_embeddings.T)
    remaining = set(range(len(scores))) - set(selected)

    while remaining and len(selected) < top_n:
        next_idx = None
        next_score = None
        for idx in remaining:
            redundancy = max(candidate_similarity[idx, chosen] for chosen in selected)
            mmr_score = (1.0 - diversity) * float(scores[idx]) - diversity * float(redundancy)
            if next_score is None or mmr_score > next_score:
                next_idx = idx
                next_score = mmr_score
        if next_idx is None:
            break
        selected.append(next_idx)
        remaining.remove(next_idx)

    return selected


def _rank_phrases(
    doc: str,
    *,
    top_n: int,
    nr_candidates: int,
    ngram_max: int,
    diversity: float,
    score_threshold: float,
    use_mmr: bool,
) -> Tuple[List[str], dict]:
    model = _get_model()
    phrases = _candidate_phrases(doc, ngram_max=ngram_max, nr_candidates=nr_candidates)
    if not phrases:
        return [], {}

    phrase_embeddings, scores = _semantic_scores(model, doc, phrases)
    keep = [idx for idx, score in enumerate(scores) if float(score) >= score_threshold]
    if keep:
        phrases = [phrases[idx] for idx in keep]
        phrase_embeddings = phrase_embeddings[keep]
        scores = scores[keep]
    else:
        phrases = []
        phrase_embeddings = np.empty((0, 0))
        scores = np.array([])

    if not phrases:
        return [], {}

    if use_mmr:
        ranked_indices = _mmr_indices(phrase_embeddings, scores, top_n=top_n, diversity=diversity)
    else:
        ranked_indices = list(np.argsort(scores)[::-1][:top_n])

    ordered_phrases = [phrases[idx] for idx in ranked_indices]
    ordered_scores = [float(scores[idx]) for idx in ranked_indices]
    return ordered_phrases, {"scores": ordered_scores}


@app.route("/phrases", methods=["GET"])
def phrases():
    doc = request.args.get("doc", "")
    if not doc.strip():
        return jsonify(error="Document not provided"), 400

    try:
        top_n = max(1, min(int(request.args.get("top_n", 50)), 200))
    except ValueError:
        top_n = 50
    try:
        nr_candidates = max(10, min(int(request.args.get("nr_candidates", 100)), 500))
    except ValueError:
        nr_candidates = 100
    try:
        ngram_max = max(1, min(int(request.args.get("ngram_max", 3)), 3))
    except ValueError:
        ngram_max = 3
    try:
        diversity = max(0.0, min(float(request.args.get("diversity", 0.7)), 1.0))
    except ValueError:
        diversity = 0.7
    try:
        score_threshold = max(-1.0, min(float(request.args.get("score_threshold", 0.10)), 1.0))
    except ValueError:
        score_threshold = 0.10
    use_mmr = _parse_bool(request.args.get("use_mmr"), default=True)

    phrases_out, extra = _rank_phrases(
        doc,
        top_n=top_n,
        nr_candidates=nr_candidates,
        ngram_max=ngram_max,
        diversity=diversity,
        score_threshold=score_threshold,
        use_mmr=use_mmr,
    )

    return jsonify(
        num_phrases=len(phrases_out),
        phrases=phrases_out,
        model={
            "name": DEFAULT_MODEL_NAME,
            "model_checksum": model_checksum,
            "params": {
                "top_n": top_n,
                "nr_candidates": nr_candidates,
                "ngram_max": ngram_max,
                "use_mmr": use_mmr,
                "diversity": diversity,
                "score_threshold": score_threshold,
            },
        },
        debug=extra,
    )


@app.route("/keywords", methods=["GET"])
def keywords_alias():
    response = phrases()
    if isinstance(response, tuple):
        return response
    payload = response.get_json()
    payload["keywords"] = payload.get("phrases", [])
    return jsonify(payload)


if __name__ == "__main__":
    model_checksum = _compute_checksum(DEFAULT_MODEL_NAME)
    _get_model()
    app.run(host="0.0.0.0", port=5004)
