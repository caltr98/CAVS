import os
import threading
import json
import hashlib
import inspect
import traceback

from flask import Flask, jsonify, request

try:
    # Preferred interface (matches Nesta OJD DAPS example code).
    from ojd_daps_skills.pipeline.extract_skills.extract_skills import ExtractSkills
except Exception:  # pragma: no cover
    ExtractSkills = None

try:
    # Fallback interface present in newer ojd-daps-skills releases.
    from ojd_daps_skills.extract_skills.extract_skills import SkillsExtractor
except Exception:  # pragma: no cover
    SkillsExtractor = None

try:
    from spacy.tokens import Doc
except Exception:  # pragma: no cover
    Doc = None

app = Flask(__name__)

_extractor_lock = threading.Lock()
_es = None
_response_cache = {}
_response_inflight = {}
_response_cache_lock = threading.Lock()


def _request_cache_key(scope):
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


def _cached_response(scope, compute):
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


def _get_es():
    """
    Lazily construct the OJD-DAPS ExtractSkills pipeline to keep container startup fast.
    First call will download required models if not already present.
    """
    global _es
    if _es is not None:
        return _es
    with _extractor_lock:
        if _es is not None:
            return _es
        if ExtractSkills is None and SkillsExtractor is None:
            raise RuntimeError("No supported ojd-daps-skills API found (missing ExtractSkills and SkillsExtractor).")

        if ExtractSkills is not None:
            config_name = os.getenv("OJD_EXTRACTSKILLS_CONFIG_NAME", "extract_skills_esco_special")
            local = os.getenv("OJD_EXTRACTSKILLS_LOCAL", "true").lower() not in ("0", "false", "no")
            _es = ExtractSkills(config_name=config_name, local=local)
            _es.load()
            return _es

        # Fallback to SkillsExtractor (container's current `ojd-daps-skills` provides this).
        _es = SkillsExtractor(
            ner_model_name=os.getenv("OJD_NER_MODEL_NAME", "nestauk/en_skillner"),
            ms_model_name=os.getenv("OJD_MS_MODEL_NAME", "nestauk/multiskill-classifier"),
            taxonomy_name=os.getenv("OJD_TAXONOMY_NAME", "esco"),
        )
        return _es


def _parse_keywords_from_request():
    raw = request.args.get("keywords")
    if raw is None:
        raw_list = request.args.getlist("keywords[]") or request.args.getlist("keywords")
        if raw_list:
            return [k for k in raw_list if k]
        return None

    # `keywords` may be a JSON stringified dict/array (as used by existing Node gateways).
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return [v for v in parsed.values() if v]
        if isinstance(parsed, list):
            return [v for v in parsed if v]
        if isinstance(parsed, str) and parsed:
            return [parsed]
    except Exception:
        pass

    # Fallback: treat as a single keyword or comma-separated string.
    raw = raw.strip()
    if not raw:
        return []
    if "," in raw:
        return [k.strip() for k in raw.split(",") if k.strip()]
    return [raw]


def _call_map_skills(es, items, skill_match_thresh=None):
    if skill_match_thresh is None:
        return es.map_skills(items)

    try:
        sig = inspect.signature(es.map_skills)
        for param in ("skill_match_thresh", "skill_match_threshold"):
            if param in sig.parameters:
                return es.map_skills(items, **{param: float(skill_match_thresh)})
    except Exception:
        pass

    # Default if the library doesn't support passing the threshold explicitly.
    return es.map_skills(items)


def _to_jsonable(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value

    # Common scalar wrappers (e.g., numpy scalars)
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return _to_jsonable(item())
        except Exception:
            pass

    if isinstance(value, dict):
        return {str(k): _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_to_jsonable(v) for v in value]

    # Pydantic / dataclass-like objects
    for method_name in ("model_dump", "dict", "to_dict"):
        method = getattr(value, method_name, None)
        if callable(method):
            try:
                return _to_jsonable(method())
            except Exception:
                pass

    # Fallback to object's __dict__
    d = getattr(value, "__dict__", None)
    if isinstance(d, dict) and d:
        return _to_jsonable(d)

    return str(value)


def _mapped_skills_from_docs(docs):
    mapped = []
    for doc in docs or []:
        for m in (getattr(doc._, "mapped_skills", None) or []):
            if m:
                mapped.append(m)
    return mapped


def _set_doc_mapped_skills(doc, mapped_skills):
    try:
        doc._.mapped_skills = mapped_skills
    except Exception:
        pass
    return doc


def _skill_span_texts(skill_spans):
    out = []
    for span in skill_spans or []:
        if isinstance(span, str):
            text = span
        else:
            text = getattr(span, "text", None)
        if isinstance(text, str) and text:
            out.append(text)
    return out


def _dedupe_mapped_skills(mapped_skills):
    unique = []
    seen = set()
    for item in mapped_skills or []:
        try:
            key = json.dumps(_to_jsonable(item), sort_keys=True, ensure_ascii=True)
        except Exception:
            key = str(item)
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique


def _make_phrase_doc(es, phrases, vocab=None):
    if Doc is None:
        raise RuntimeError("spaCy Doc is unavailable for mapper-only mode.")

    if vocab is None:
        nlp = getattr(getattr(es, "extract_config", None), "nlp", None)
        vocab = getattr(nlp, "vocab", None)
    if vocab is None:
        raise RuntimeError("SkillsExtractor is missing a spaCy vocab.")

    doc = Doc(vocab, words=["skills"])
    doc._.skill_spans = list(phrases or [])
    return doc


def _map_single_doc_phrase_by_phrase(es, doc):
    phrases = _skill_span_texts(getattr(doc._, "skill_spans", None) or [])
    if not phrases:
        return _set_doc_mapped_skills(doc, [])

    mapped_skills = []
    for phrase in phrases:
        try:
            phrase_doc = _make_phrase_doc(es, [phrase], vocab=getattr(doc, "vocab", None))
            mapped_docs = es.map_skills([phrase_doc]) or []
            if not mapped_docs:
                continue
            mapped_skills.extend([m for m in (getattr(mapped_docs[0]._, "mapped_skills", None) or []) if m])
        except Exception:
            traceback.print_exc()

    return _set_doc_mapped_skills(doc, _dedupe_mapped_skills(mapped_skills))


def _safe_map_docs(es, docs):
    if not docs:
        return []

    try:
        mapped_docs = es.map_skills(docs)
        if isinstance(mapped_docs, list) and len(mapped_docs) == len(docs):
            return mapped_docs
        raise RuntimeError(
            f"Expected {len(docs)} mapped docs, got {len(mapped_docs) if isinstance(mapped_docs, list) else type(mapped_docs).__name__}."
        )
    except Exception:
        traceback.print_exc()

    recovered = []
    for doc in docs:
        phrases = _skill_span_texts(getattr(doc._, "skill_spans", None) or [])
        if not phrases:
            recovered.append(_set_doc_mapped_skills(doc, []))
            continue

        try:
            mapped_docs = es.map_skills([doc]) or []
            if mapped_docs:
                recovered.append(mapped_docs[0])
                continue
        except Exception:
            traceback.print_exc()

        recovered.append(_map_single_doc_phrase_by_phrase(es, doc))

    return recovered


def _normalize_legacy_job_matches(job_match):
    if not isinstance(job_match, dict):
        return []

    out = []
    for pair in job_match.get("SKILL") or []:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            continue

        ojo_skill, mapped = pair
        match = {"ojo_skill": str(ojo_skill)}

        if isinstance(mapped, (list, tuple)):
            if len(mapped) >= 1 and mapped[0]:
                match["match_skill"] = str(mapped[0])
            if len(mapped) >= 2 and mapped[1] is not None:
                match["match_id"] = str(mapped[1])
        elif isinstance(mapped, dict):
            for key in ("match_skill", "label", "name"):
                if key in mapped and mapped[key]:
                    match["match_skill"] = str(mapped[key])
                    break
            for key in ("match_id", "id", "uri", "skill_id", "esco_id"):
                if key in mapped and mapped[key]:
                    match["match_id"] = str(mapped[key])
                    break

        if match.get("match_id") or match.get("match_skill"):
            out.append(match)

    return out


def _normalize_legacy_mapped_skills(mapped):
    if isinstance(mapped, dict):
        mapped = [mapped]
    if not isinstance(mapped, list):
        return []
    return [_normalize_legacy_job_matches(job_match) for job_match in mapped]


def _clean_phrase_groups(phrase_groups):
    cleaned_groups = []
    for group in phrase_groups or []:
        if isinstance(group, str):
            group = [group]
        if not isinstance(group, (list, tuple, set)):
            continue

        phrases = []
        seen = set()
        for phrase in group:
            if not isinstance(phrase, str):
                continue
            phrase = phrase.strip()
            if not phrase:
                continue
            phrase_key = phrase.lower()
            if phrase_key in seen:
                continue
            seen.add(phrase_key)
            phrases.append(phrase)

        cleaned_groups.append(phrases)

    return cleaned_groups


def _map_phrases_from_groups(es, phrase_groups):
    phrase_groups = _clean_phrase_groups(phrase_groups)
    if not phrase_groups:
        return [], []

    results = [
        {
            "phrases": phrases,
            "skill_spans": list(phrases),
            "mapped_skills": [],
        }
        for phrases in phrase_groups
    ]
    non_empty = [(idx, phrases) for idx, phrases in enumerate(phrase_groups) if phrases]
    if not non_empty:
        top = results[0]["mapped_skills"] if len(results) == 1 else None
        return results, top

    if SkillsExtractor is not None and isinstance(es, SkillsExtractor):
        docs = []
        for _, phrases in non_empty:
            docs.append(_make_phrase_doc(es, phrases))

        docs = _safe_map_docs(es, docs)
        for (idx, _), doc in zip(non_empty, docs):
            results[idx].update(
                {
                    "skill_spans": _skill_span_texts(getattr(doc._, "skill_spans", None) or []),
                    "mapped_skills": _to_jsonable([m for m in (getattr(doc._, "mapped_skills", None) or []) if m]),
                }
            )

        top = results[0]["mapped_skills"] if len(results) == 1 else None
        return results, top

    if ExtractSkills is not None and hasattr(es, "map_skills"):
        for idx, phrases in non_empty:
            mapped = _call_map_skills(es, phrases)
            normalized = _normalize_legacy_mapped_skills(mapped)
            results[idx]["mapped_skills"] = normalized[0] if normalized else []

        top = results[0]["mapped_skills"] if len(results) == 1 else None
        return results, top

    raise RuntimeError("Unsupported extractor instance; cannot map phrases.")


def _skills_from_texts(es, texts):
    """
    Returns (results, flattened_skills_for_single_input_or_None).

    - If using SkillsExtractor: produces spaCy docs and returns their mapped skills.
    - If using ExtractSkills (legacy/pipeline): calls `map_skills` directly where available.
    """
    if texts is None:
        texts = []

    # Newer interface in this container image.
    if SkillsExtractor is not None and isinstance(es, SkillsExtractor):
        docs = [es.get_skills(t, min_length=0) for t in (texts or [])]
        docs = _safe_map_docs(es, docs)
        results = []
        for t, doc in zip(texts, docs):
            results.append(
                {
                    "text": t,
                    "skill_spans": _skill_span_texts(getattr(doc._, "skill_spans", []) or []),
                    "mapped_skills": _to_jsonable([m for m in (getattr(doc._, "mapped_skills", []) or []) if m]),
                }
            )
        top = results[0]["mapped_skills"] if len(results) == 1 else None
        return results, top

    # Nesta pipeline-style interface (only if present).
    if ExtractSkills is not None and hasattr(es, "map_skills"):
        predicted = es.get_skills(texts)
        mapped = _call_map_skills(es, predicted)
        normalized = _normalize_legacy_mapped_skills(mapped)
        results = []
        for idx, text in enumerate(texts):
            pred = predicted[idx] if idx < len(predicted) and isinstance(predicted[idx], dict) else {}
            results.append(
                {
                    "text": text,
                    "skill_spans": _to_jsonable(pred.get("SKILL", [])),
                    "mapped_skills": normalized[idx] if idx < len(normalized) else [],
                }
            )
        top = results[0]["mapped_skills"] if len(results) == 1 else None
        return results, top

    raise RuntimeError("Unsupported extractor instance; cannot extract skills.")


# Eagerly initialize extractor at import to avoid first-request latency.
try:
    _es = _get_es()
except Exception:  # pragma: no cover
    traceback.print_exc()
else:
    try:
        # Warm up models by running a dummy extraction, which will trigger downloads if needed.
        if SkillsExtractor is not None and isinstance(_es, SkillsExtractor):
            _skills_from_texts(_es, ["warmup"])
        elif ExtractSkills is not None and isinstance(_es, ExtractSkills):
            _call_map_skills(_es, ["warmup"])
    except Exception:
        traceback.print_exc()


def _service_config(es):
    cfg = {
        "config_name": getattr(es, "config_name", None),
        "local": getattr(es, "local", None),
        "engine": type(es).__name__ if es is not None else None,
    }
    return {k: v for k, v in cfg.items() if v is not None}


@app.get("/health")
def health():
    return jsonify(status="ok")


@app.get("/keyword_to_skills")
def keyword_to_skills():
    return _cached_response("keyword_to_skills", _keyword_to_skills_uncached)


def _keyword_to_skills_uncached():
    keywords = _parse_keywords_from_request()
    if keywords is None:
        return jsonify(error="Keywords not provided; pass `keywords` (JSON dict/array)"), 400

    try:
        es = _get_es()
        results, skills = _map_phrases_from_groups(es, [keywords])
    except Exception as e:
        traceback.print_exc()
        return jsonify(error=f"Skill mapping failed: {e}"), 500

    return jsonify(
        num_skills=len(skills) if skills is not None else 0,
        skills=_to_jsonable(skills or []),
        results=results,
        model={},
        config=_service_config(es),
    )


@app.get("/keyword_to_skill")
def keyword_to_skill():
    return keyword_to_skills()


@app.post("/map_phrases")
def map_phrases():
    return _cached_response("map_phrases", _map_phrases_uncached)


def _map_phrases_uncached():
    body = request.get_json(silent=True) or {}
    phrase_groups = body.get("phrase_groups")
    if phrase_groups is None and "phrases" in body:
        phrase_groups = [body.get("phrases")]

    if phrase_groups is None:
        return jsonify(error="Provide JSON body with `phrases` (list of strings) or `phrase_groups` (list of string lists)."), 400

    try:
        es = _get_es()
        results, top_level_skills = _map_phrases_from_groups(es, phrase_groups)
    except Exception as e:
        traceback.print_exc()
        return jsonify(error=f"Phrase mapping failed: {e}"), 500

    payload = {"results": results, "config": _service_config(es)}
    if top_level_skills is not None:
        payload["skills"] = top_level_skills
    return jsonify(payload)


@app.post("/extract")
def extract():
    return _cached_response("extract", _extract_uncached)


def _extract_uncached():
    body = request.get_json(silent=True) or {}
    job_ads = body.get("job_ads")
    text = body.get("text")
    author_skills = body.get("authorSkills") or body.get("author_skills") or []

    if job_ads is None and text is None:
        return (
            jsonify(
                error="Provide JSON body with `text` (string) or `job_ads` (list of strings)."
            ),
            400,
        )

    if text is not None:
        job_ads = [text]

    if not isinstance(job_ads, list) or any(not isinstance(t, str) for t in job_ads):
        return jsonify(error="`job_ads` must be a list of strings, or use `text`."), 400

    try:
        es = _get_es()
        results, top_level_skills = _skills_from_texts(es, job_ads)
    except Exception as e:
        traceback.print_exc()
        return jsonify(error=f"Skill extraction failed: {e}"), 500

    payload = {"results": results, "config": _service_config(es)}

    if top_level_skills is not None:
        payload["skills"] = top_level_skills

        # Compute a simple competence/coverage against provided author skills, if any.
        if isinstance(author_skills, list):
            author_set = {str(s).strip().lower() for s in author_skills if isinstance(s, str) and str(s).strip()}
            ids = {}
            labels = {}

            def _walk(v):
                if isinstance(v, list):
                    # handle legacy shape: [skill_entity, [match_skill, match_id]]
                    if len(v) == 2 and isinstance(v[1], list) and len(v[1]) == 2:
                        label = str(v[1][0]).strip().lower() if isinstance(v[1][0], str) else ""
                        sid = str(v[1][1]).strip().lower() if isinstance(v[1][1], str) else ""
                        if sid:
                            ids[sid] = True
                            if label and sid not in labels:
                                labels[sid] = label
                            return
                    for x in v:
                        _walk(x)
                elif isinstance(v, dict):
                    sid = ""
                    label = ""
                    for k in ("match_id", "id", "uri", "skill_id", "esco_id"):
                        if k in v and isinstance(v[k], str) and v[k].strip():
                            sid = v[k].strip().lower()
                            break
                    for k in ("match_skill", "name", "skill", "label"):
                        if k in v and isinstance(v[k], str) and v[k].strip():
                            label = v[k].strip().lower()
                            break
                    if sid:
                        ids[sid] = True
                        if label and sid not in labels:
                            labels[sid] = label
                        return
                    for x in v.values():
                        _walk(x)

            _walk(top_level_skills)

            denom = len(ids)
            coverage = 0
            for sid, _ in ids.items():
                if sid in author_set:
                    coverage += 1
                    continue
                if sid in labels and labels[sid] in author_set:
                    coverage += 1
            confidence = float(coverage) / denom if denom > 0 else 0.0
            competent = coverage > 0
            reason = "No skills extracted"
            if denom == 0:
                reason = "No skills extracted"
            elif coverage > 0:
                reason = f"Author skills cover {coverage}/{denom} extracted skills"
            else:
                reason = f"Author skills cover 0/{denom} extracted skills"

            payload["competent"] = competent
            payload["confidence"] = confidence
            payload["reason"] = reason

    return jsonify(payload)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5005"))
    app.run(host="0.0.0.0", port=port)
