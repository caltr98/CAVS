from __future__ import annotations

import hashlib
import json
import os
import threading
from typing import List, Sequence, Tuple

import numpy as np
from flask import Flask, jsonify, request
from sentence_transformers import SentenceTransformer
from sklearn.feature_extraction.text import CountVectorizer
from keybert import KeyBERT
import yake


DEFAULT_MODEL_NAME = os.environ.get("ROBERTA_PHRASE_MODEL", "sentence-transformers/all-distilroberta-v1")
DEFAULT_MODEL_REVISION = os.environ.get(
    "ROBERTA_PHRASE_MODEL_REVISION",
    "842eaed40bee4d61673a81c92d5689a8fed7a09f",
)

app = Flask(__name__)

phrase_model = None
keybert_model = None
model_checksum = None
_response_cache = {}
_response_inflight = {}
_response_cache_lock = threading.Lock()


def _get_model() -> SentenceTransformer:
    global phrase_model
    if phrase_model is None:
        phrase_model = SentenceTransformer(
            DEFAULT_MODEL_NAME,
            revision=DEFAULT_MODEL_REVISION,
            local_files_only=True,
        )
    return phrase_model


def _get_keybert_model() -> KeyBERT:
    global keybert_model
    if keybert_model is None:
        keybert_model = KeyBERT(model="sentence-transformers/all-MiniLM-L6-v2")
    return keybert_model


def _rank_keybert(doc: str, *, top_n: int, nr_candidates: int, ngram_max: int,
                  diversity: float, score_threshold: float, use_mmr: bool):
    ranked = _get_keybert_model().extract_keywords(
        doc,
        keyphrase_ngram_range=(1, ngram_max),
        stop_words=None,
        top_n=top_n,
        nr_candidates=nr_candidates,
        use_mmr=use_mmr,
        diversity=diversity,
    )
    kept = [(phrase, float(score)) for phrase, score in ranked if float(score) >= score_threshold]
    return [phrase for phrase, _ in kept], {"scores": [score for _, score in kept]}


def _rank_yake(doc: str, *, top_n: int, ngram_max: int, **_kwargs):
    ranked = yake.KeywordExtractor(lan="en", n=ngram_max, top=top_n).extract_keywords(doc)
    return [phrase for phrase, _ in ranked], {"scores": [float(score) for _, score in ranked]}


def _compute_checksum(model_name: str) -> str:
    return hashlib.sha256(model_name.encode("utf-8")).hexdigest()


def _parse_bool(raw: str, default: bool = True) -> bool:
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "y", "on"}


def _request_cache_key(scope: str) -> str:
    body = request.get_data(cache=True) or b""
    json_body = request.get_json(silent=True) if body else None
    body_value = json_body if json_body is not None else body.decode("utf-8", errors="replace")
    payload = {
        "scope": scope,
        "method": request.method,
        "path": request.path,
        "query": sorted((key, value) for key in request.args for value in request.args.getlist(key)),
        "body": body_value,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _cached_response(scope: str, compute):
    key = _request_cache_key(scope)
    while True:
        with _response_cache_lock:
            cached = _response_cache.get(key)
            if cached is not None:
                body, status, content_type = cached
                resp = app.response_class(response=body, status=status, content_type=content_type)
                resp.headers["X-CAVS-Cache"] = "hit"
                return resp
            entry = _response_inflight.get(key)
            if entry is None:
                entry = {"event": threading.Event(), "result": None, "error": None}
                _response_inflight[key] = entry
                break
        entry["event"].wait()
        if entry.get("error") is not None:
            raise entry["error"]
        result = entry.get("result")
        if result is not None:
            body, status, content_type = result
            resp = app.response_class(response=body, status=status, content_type=content_type)
            resp.headers["X-CAVS-Cache"] = "shared"
            return resp

    try:
        resp = app.make_response(compute())
        result = (resp.get_data(), resp.status_code, resp.content_type)
        if 200 <= resp.status_code < 300:
            resp.direct_passthrough = False
            with _response_cache_lock:
                _response_cache[key] = result
            resp.headers["X-CAVS-Cache"] = "miss"
        entry["result"] = result
        return resp
    except Exception as exc:
        entry["error"] = exc
        raise
    finally:
        with _response_cache_lock:
            _response_inflight.pop(key, None)
            entry["event"].set()


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
    return _cached_response("phrases", _phrases_uncached)


def _phrases_uncached():
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

    engine = str(request.args.get("engine", "roberta")).strip().lower()
    if engine not in {"roberta", "keybert", "yake"}:
        return jsonify(error="engine must be roberta, keybert, or yake"), 400

    ranker = {"roberta": _rank_phrases, "keybert": _rank_keybert, "yake": _rank_yake}[engine]
    phrases_out, extra = ranker(
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
            "name": {"roberta": DEFAULT_MODEL_NAME, "keybert": "sentence-transformers/all-MiniLM-L6-v2", "yake": "yake-0.6.0"}[engine],
            "engine": engine,
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
