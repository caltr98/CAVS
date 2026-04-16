#!/usr/bin/env python3

import argparse
import csv
import html
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests


WIKI_API = "https://en.wikipedia.org/w/api.php"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
DEFAULT_USER_AGENT = "componentsCAVS-liar2-wiki/1.0 (local research script)"


def _collapse_ws(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "")).strip()


def _normalize_plaintext(value: str) -> str:
    """
    Keep paragraph breaks (\\n\\n) but normalize intra-line whitespace.
    """
    text = (value or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.split("\n")]
    # Collapse excessive blank lines.
    out: List[str] = []
    blank_run = 0
    for ln in lines:
        if ln == "":
            blank_run += 1
            if blank_run <= 2:
                out.append("")
        else:
            blank_run = 0
            out.append(ln)
    return "\n".join(out).strip()


def normalize_author_key(name: str) -> str:
    return _collapse_ws(name).lower()


def read_liar2_speakers(csv_path: str) -> Iterable[str]:
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            speaker = (row.get("speaker") or "").strip()
            if speaker:
                yield speaker


def write_json(path: str, data: Any) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def load_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def looks_like_disambiguation(bio_text: str) -> bool:
    t = _collapse_ws(bio_text).lower()
    # Wikipedia disambiguation pages often start with "... may refer to:"
    if " may refer to:" in t[:80]:
        return True
    if t.startswith("may refer to:"):
        return True
    return False


def extract_birth_year_from_text(bio_text: str) -> Optional[int]:
    """
    Best-effort: parse year from common Wikipedia lead patterns.
    Examples:
      - "(born March 20, 1968)"
      - "(born 1968)"
      - "born March 20, 1968"
    """
    t = bio_text or ""
    patterns = [
        r"\(born[^)]*?(\d{4})\)",
        r"\bborn[^,\n]{0,80}?(\d{4})\b",
    ]
    for pat in patterns:
        m = re.search(pat, t, flags=re.IGNORECASE)
        if m:
            try:
                year = int(m.group(1))
                return year
            except Exception:
                continue
    return None


def render_progress_bar(
    current: int,
    total: int,
    *,
    start_time_s: float,
    width: int = 30,
    prefix: str = "Speakers",
) -> str:
    total = max(total, 1)
    current = max(0, min(current, total))
    frac = current / total
    filled = int(frac * width)
    bar = "=" * filled + "-" * (width - filled)

    elapsed = max(0.0, time.time() - start_time_s)
    rate = (current / elapsed) if elapsed > 0 else 0.0
    eta_s = int((total - current) / rate) if rate > 0 else 0

    return f"{prefix}: [{bar}] {current}/{total} ({frac:.0%}) elapsed={int(elapsed)}s eta={eta_s}s"


@dataclass
class WikiBio:
    title: str
    extract: str
    pageid: Optional[int]
    url: Optional[str]
    source: str
    wikibase_item: Optional[str]


def wiki_search_title(query: str, *, session: requests.Session, timeout_s: float) -> Optional[str]:
    query = _collapse_ws(query)
    if not query:
        return None

    def norm(s: str) -> str:
        s = _collapse_ws(s).strip().strip('"').strip("'").lower()
        return _collapse_ws(s)

    query_norm = norm(query)
    if not query_norm:
        return None

    def is_close_enough(title: str) -> bool:
        # User requirement: title must match the searched speaker exactly (case-insensitive).
        title_norm = norm(title)
        return bool(title_norm) and title_norm == query_norm

    params = {
        "action": "query",
        "format": "json",
        "list": "search",
        "srsearch": query,
        "srlimit": 5,
        "srprop": "",
    }
    try:
        r = session.get(WIKI_API, params=params, timeout=timeout_s)
        r.raise_for_status()
        data = r.json()
    except Exception:
        return None
    hits = (data.get("query") or {}).get("search") or []
    if not hits:
        return None
    for hit in hits:
        if not isinstance(hit, dict):
            continue
        title = hit.get("title")
        if not isinstance(title, str) or not title:
            continue
        if "(disambiguation)" in title.lower():
            continue
        if is_close_enough(title):
            return title
    return None


def wikidata_search_entity_id(query: str, *, session: requests.Session, timeout_s: float) -> Optional[str]:
    """
    Resolve a speaker name to a Wikidata Q-id using strict label matching (case-insensitive).
    This is much faster than Wikipedia HTML parsing and avoids page-content scraping.
    """
    query = _collapse_ws(query)
    if not query:
        return None

    def norm(s: str) -> str:
        return _collapse_ws(s).strip().strip('"').strip("'").lower()

    query_norm = norm(query)
    if not query_norm:
        return None

    params = {
        "action": "wbsearchentities",
        "format": "json",
        "search": query,
        "language": "en",
        "uselang": "en",
        "limit": 10,
    }
    try:
        r = session.get(WIKIDATA_API, params=params, timeout=timeout_s)
        r.raise_for_status()
        data = r.json()
    except Exception:
        return None

    hits = data.get("search") if isinstance(data, dict) else None
    if not isinstance(hits, list):
        return None

    for hit in hits:
        if not isinstance(hit, dict):
            continue
        label = hit.get("label")
        eid = hit.get("id")
        if not isinstance(label, str) or not isinstance(eid, str):
            continue
        if norm(label) == query_norm:
            return eid
    return None


def wiki_fetch_page_html(title: str, *, session: requests.Session, timeout_s: float) -> Optional[str]:
    params = {
        "action": "parse",
        "format": "json",
        "page": title,
        "prop": "text",
        "redirects": 1,
    }
    try:
        r = session.get(WIKI_API, params=params, timeout=timeout_s)
        r.raise_for_status()
        data = r.json()
    except Exception:
        return None
    parse = data.get("parse") if isinstance(data, dict) else None
    if not isinstance(parse, dict):
        return None
    text = parse.get("text")
    if not isinstance(text, dict):
        return None
    html_body = text.get("*")
    if not isinstance(html_body, str) or not html_body.strip():
        return None
    return html_body


def _strip_tags_keep_text(fragment: str) -> str:
    # Remove tags but keep text; used to get heading titles.
    t = re.sub(r"(?s)<[^>]+>", " ", fragment or "")
    t = html.unescape(t)
    return _collapse_ws(t)


def extract_wanted_sections_from_page_html(page_html: str) -> str:
    """
    Extract only the content under:
      - "Early life" / "Early life and education"
      - "Career" (and common variants containing "career")

    Falls back to empty string if no relevant sections are found.
    """
    if not page_html:
        return ""

    # Remove tables/figures early to avoid dragging in infoboxes or navboxes.
    cleaned = re.sub(r"(?is)<table\\b.*?>.*?</table>", " ", page_html)
    cleaned = re.sub(r"(?is)<figure\\b.*?>.*?</figure>", " ", cleaned)
    cleaned = re.sub(r"(?is)<img\\b[^>]*>", " ", cleaned)

    # Some pages use <h2 id="...">Title</h2> (no mw-headline span).
    # Others use <h2>...<span class="mw-headline">Title</span>...</h2>.
    heading_re = re.compile(r"(?is)<h([2-6])[^>]*>(.*?)</h\1>")

    headings: List[Tuple[int, int, int, str]] = []
    for m in heading_re.finditer(cleaned):
        level = int(m.group(1))
        title = _strip_tags_keep_text(m.group(2))
        if not title:
            continue
        headings.append((m.start(), m.end(), level, title))

    def want_heading(title: str) -> bool:
        t = _collapse_ws(title).lower()
        if t.startswith("early life"):
            return True
        # Accept common career section names: "Career", "Political career", "Professional career", etc.
        if t == "career":
            return True
        if t.endswith("career") or t.startswith("career") or " career" in t:
            # Avoid "career statistics" sections which are often tables.
            if "statistics" in t:
                return False
            return True
        return False

    sections: List[str] = []
    for i, (start, end, level, title) in enumerate(headings):
        if not want_heading(title):
            continue

        stop_at = len(cleaned)
        for j in range(i + 1, len(headings)):
            _s2, _e2, level2, _t2 = headings[j]
            if level2 <= level:
                stop_at = _s2
                break

        section_html = cleaned[end:stop_at]
        section_text = _strip_html_to_text(section_html)
        if section_text:
            sections.append(f"{title}\n{section_text}".strip())

    return _normalize_plaintext("\n\n".join(sections))


def _strip_html_to_text(html_text: str) -> str:
    t = html_text or ""
    # Remove common image/caption containers before stripping tags.
    t = re.sub(r'(?is)<div[^>]*class="[^"]*(?:thumb|thumbcaption|gallery)[^"]*"[^>]*>.*?</div>', " ", t)
    # Remove scripts/styles.
    t = re.sub(r"(?is)<script.*?>.*?</script>", " ", t)
    t = re.sub(r"(?is)<style.*?>.*?</style>", " ", t)
    # Remove superscript reference blocks early.
    t = re.sub(r"(?is)<sup\\b[^>]*>.*?</sup>", " ", t)
    # Replace <br> and <p> with newlines.
    t = re.sub(r"(?i)<br\\s*/?>", "\n", t)
    t = re.sub(r"(?i)</p\\s*>", "\n\n", t)
    # Remove all other tags.
    t = re.sub(r"(?s)<[^>]+>", " ", t)
    t = html.unescape(t)
    text = _normalize_plaintext(t)

    # Drop inline reference markers like [1], [a], [citation needed], etc.
    text = re.sub(r"\[\s*(?:\d+|[a-z])\s*\]", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\[\s*edit\s*\]", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\[\s*citation needed\s*\]", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\[\s*needs citation\s*\]", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\[\s*clarification needed\s*\]", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\[\s*who\?\s*\]", "", text, flags=re.IGNORECASE)

    # Remove any raw URLs that might appear in the page text.
    text = re.sub(r"https?://\\S+", "", text, flags=re.IGNORECASE)

    # Remove entire trailing sections that are typically links/references.
    stop_headings = {
        "references",
        "notes",
        "bibliography",
        "sources",
        "external links",
        "further reading",
        "see also",
        "works cited",
        "citations",
    }
    lines = text.split("\n")
    kept: List[str] = []
    for ln in lines:
        # Drop common Wikipedia boilerplate lines.
        if re.match(r"(?i)^\s*(main article|see also)\s*:", ln):
            continue
        heading = _collapse_ws(re.sub(r"\[[^\]]*\]", "", ln)).lower()
        if heading in stop_headings:
            break
        kept.append(ln)
    return _normalize_plaintext("\n".join(kept))


def extract_infobox_fields(page_html: str, field_names: List[str]) -> List[str]:
    """
    Best-effort extraction of specific fields from the Wikipedia infobox without retaining tables/links.

    Used as a fallback when Wikidata does not provide education/degree information.
    """
    if not page_html:
        return []
    wanted = {_collapse_ws(n).lower() for n in (field_names or []) if _collapse_ws(n)}
    if not wanted:
        return []

    out: List[str] = []
    for m in re.finditer(
        r"(?is)<table[^>]*class=[\"'][^\"']*infobox[^\"']*[\"'][^>]*>(.*?)</table>",
        page_html,
    ):
        table_html = m.group(1)
        for row in re.finditer(r"(?is)<tr[^>]*>(.*?)</tr>", table_html):
            row_html = row.group(1)
            th_m = re.search(r"(?is)<th[^>]*>(.*?)</th>", row_html)
            td_m = re.search(r"(?is)<td[^>]*>(.*?)</td>", row_html)
            if not th_m or not td_m:
                continue
            key = _strip_tags_keep_text(th_m.group(1)).lower()
            if key not in wanted:
                continue
            value = _collapse_ws(_expand_degree_abbreviations(_strip_html_to_text(td_m.group(1))))
            if value:
                out.append(value)

    # De-duplicate preserving order.
    seen = set()
    uniq: List[str] = []
    for x in out:
        if x not in seen:
            seen.add(x)
            uniq.append(x)
    return uniq


def wiki_fetch_extract(title: str, *, session: requests.Session, timeout_s: float, max_chars: int) -> Optional[WikiBio]:
    params = {
        "action": "query",
        "format": "json",
        "prop": "extracts|pageprops",
        "inprop": "url",
        "redirects": 1,
        "titles": title,
        "explaintext": 1,
        "exintro": 0,
        "exchars": max_chars,
    }
    try:
        r = session.get(WIKI_API, params=params, timeout=timeout_s)
        r.raise_for_status()
        data = r.json()
    except Exception:
        return None
    pages = (data.get("query") or {}).get("pages") or {}
    if not isinstance(pages, dict) or not pages:
        return None
    page = next(iter(pages.values()))
    if not isinstance(page, dict):
        return None
    if page.get("missing") is not None:
        return None
    extract = page.get("extract")
    if not isinstance(extract, str) or not extract.strip():
        extract = ""
    pageprops = page.get("pageprops") if isinstance(page.get("pageprops"), dict) else {}
    wikibase_item = pageprops.get("wikibase_item") if isinstance(pageprops, dict) else None

    # Prefer extracting "Early life(+education)" + "Career" sections from the page HTML
    # to better capture background (while stripping tables/links/references).
    page_html = wiki_fetch_page_html(title, session=session, timeout_s=timeout_s)
    section_text = extract_wanted_sections_from_page_html(page_html or "")
    if section_text:
        normalized_extract = section_text
    else:
        # Fallback: use the full page HTML (still stripping tables/figures/images) if there are
        # no matching sections, then fall back further to the Wikipedia plaintext extract.
        fallback_html = page_html or ""
        fallback_html = re.sub(r"(?is)<table\\b.*?>.*?</table>", " ", fallback_html)
        fallback_html = re.sub(r"(?is)<figure\\b.*?>.*?</figure>", " ", fallback_html)
        fallback_html = re.sub(r"(?is)<img\\b[^>]*>", " ", fallback_html)
        normalized_extract = _strip_html_to_text(fallback_html) or (_normalize_plaintext(extract) if extract else "")

    if not normalized_extract:
        return None
    return WikiBio(
        title=page.get("title") or title,
        extract=normalized_extract[:max_chars],
        pageid=page.get("pageid"),
        url=None,
        source="wikipedia",
        wikibase_item=wikibase_item if isinstance(wikibase_item, str) else None,
    )


def wikidata_get_labels(
    entity_ids: List[str], *, session: requests.Session, timeout_s: float
) -> Dict[str, str]:
    ids = [e for e in entity_ids if isinstance(e, str) and e]
    if not ids:
        return {}
    params = {
        "action": "wbgetentities",
        "format": "json",
        "ids": "|".join(sorted(set(ids))),
        "props": "labels",
        "languages": "en",
        "languagefallback": 1,
    }
    try:
        r = session.get(WIKIDATA_API, params=params, timeout=timeout_s)
        r.raise_for_status()
        data = r.json()
    except Exception:
        return {}
    entities = data.get("entities") if isinstance(data, dict) else None
    if not isinstance(entities, dict):
        return {}
    out: Dict[str, str] = {}
    for eid, ent in entities.items():
        if not isinstance(ent, dict):
            continue
        labels = ent.get("labels")
        if isinstance(labels, dict) and "en" in labels and isinstance(labels["en"], dict):
            v = labels["en"].get("value")
            if isinstance(v, str) and v:
                out[eid] = v
    return out


def _expand_degree_abbreviations(text: str) -> str:
    t = text or ""
    replacements = {
        r"\bJ\.?\s*D\.?\b": "Juris Doctor",
        r"\bLL\.?\s*M\.?\b": "Master of Laws",
        r"\bM\.?\s*B\.?\s*A\.?\b": "Master of Business Administration",
        r"\bB\.?\s*S\.?\b": "Bachelor of Science",
        r"\bB\.?\s*A\.?\b": "Bachelor of Arts",
        r"\bB\.?\s*Sc\.?\b": "Bachelor of Science",
        r"\bB\.?\s*Eng\.?\b": "Bachelor of Engineering",
        r"\bM\.?\s*S\.?\b": "Master of Science",
        r"\bM\.?\s*A\.?\b": "Master of Arts",
        r"\bM\.?\s*Sc\.?\b": "Master of Science",
        r"\bM\.?\s*Eng\.?\b": "Master of Engineering",
        r"\bPh\.?\s*D\.?\b": "Doctor of Philosophy",
        r"\bD\.?\s*Phil\.?\b": "Doctor of Philosophy",
    }
    for pat, rep in replacements.items():
        t = re.sub(pat, rep, t, flags=re.IGNORECASE)
    return t


def _extract_entity_ids_from_claims(claims: Dict[str, Any], prop: str) -> List[str]:
    out_ids: List[str] = []
    for claim in claims.get(prop, []) or []:
        if not isinstance(claim, dict):
            continue
        mainsnak = claim.get("mainsnak")
        if not isinstance(mainsnak, dict):
            continue
        datavalue = mainsnak.get("datavalue")
        if not isinstance(datavalue, dict):
            continue
        value = datavalue.get("value")
        if isinstance(value, dict) and isinstance(value.get("id"), str):
            out_ids.append(value["id"])
    return out_ids


def wikidata_get_profile_facts(
    wikibase_item: str, *, session: requests.Session, timeout_s: float
) -> Dict[str, Any]:
    """
    Fetch structured profile facts from Wikidata only (no Wikipedia page scraping).
    """
    params = {
        "action": "wbgetentities",
        "format": "json",
        "ids": wikibase_item,
        "props": "claims|labels|descriptions",
        "languages": "en",
        "languagefallback": 1,
    }
    try:
        r = session.get(WIKIDATA_API, params=params, timeout=timeout_s)
        r.raise_for_status()
        data = r.json()
    except Exception:
        return {}

    entities = data.get("entities") if isinstance(data, dict) else None
    if not isinstance(entities, dict) or wikibase_item not in entities:
        return {}
    ent = entities[wikibase_item]
    if not isinstance(ent, dict):
        return {}
    claims = ent.get("claims")
    if not isinstance(claims, dict):
        claims = {}

    # Human check (P31=Q5) and birth year (P569) are handled elsewhere via existing helpers.
    institutions, degrees = wikidata_get_education(wikibase_item, session=session, timeout_s=timeout_s)

    position_ids = _extract_entity_ids_from_claims(claims, "P39")   # position held
    employer_ids = _extract_entity_ids_from_claims(claims, "P108")  # employer
    occupation_ids = _extract_entity_ids_from_claims(claims, "P106")  # occupation

    labels = wikidata_get_labels(
        position_ids + employer_ids + occupation_ids,
        session=session,
        timeout_s=timeout_s,
    )

    def dedup(seq: List[str]) -> List[str]:
        seen = set()
        out: List[str] = []
        for x in seq:
            x = _collapse_ws(x)
            if not x or x in seen:
                continue
            seen.add(x)
            out.append(x)
        return out

    label = None
    desc = None
    labels_obj = ent.get("labels")
    if isinstance(labels_obj, dict) and isinstance(labels_obj.get("en"), dict):
        label = labels_obj["en"].get("value")
    desc_obj = ent.get("descriptions")
    if isinstance(desc_obj, dict) and isinstance(desc_obj.get("en"), dict):
        desc = desc_obj["en"].get("value")

    return {
        "wikidata_id": wikibase_item,
        "label": label if isinstance(label, str) else None,
        "description": desc if isinstance(desc, str) else None,
        "institutions": institutions,
        "degrees": degrees,
        "positions": dedup([labels.get(x, "") for x in position_ids]),
        "employers": dedup([labels.get(x, "") for x in employer_ids]),
        "occupations": dedup([labels.get(x, "") for x in occupation_ids]),
    }
def wikidata_get_education(
    wikibase_item: str, *, session: requests.Session, timeout_s: float
) -> Tuple[List[str], List[str]]:
    # Education / educated at = P69; academic degree = P512.
    params = {
        "action": "wbgetentities",
        "format": "json",
        "ids": wikibase_item,
        "props": "claims",
    }
    try:
        r = session.get(WIKIDATA_API, params=params, timeout=timeout_s)
        r.raise_for_status()
        data = r.json()
    except Exception:
        return [], []
    entities = data.get("entities") if isinstance(data, dict) else None
    if not isinstance(entities, dict) or wikibase_item not in entities:
        return [], []
    ent = entities[wikibase_item]
    if not isinstance(ent, dict):
        return [], []
    claims = ent.get("claims")
    if not isinstance(claims, dict):
        return [], []

    def extract_entity_ids(prop: str) -> List[str]:
        out_ids: List[str] = []
        for claim in claims.get(prop, []) or []:
            if not isinstance(claim, dict):
                continue
            mainsnak = claim.get("mainsnak")
            if not isinstance(mainsnak, dict):
                continue
            datavalue = mainsnak.get("datavalue")
            if not isinstance(datavalue, dict):
                continue
            value = datavalue.get("value")
            if isinstance(value, dict) and isinstance(value.get("id"), str):
                out_ids.append(value["id"])
        return out_ids

    educated_at_ids = extract_entity_ids("P69")
    degree_ids = extract_entity_ids("P512")
    labels = wikidata_get_labels(educated_at_ids + degree_ids, session=session, timeout_s=timeout_s)

    institutions: List[str] = []
    for eid in educated_at_ids:
        if eid in labels:
            institutions.append(_expand_degree_abbreviations(labels[eid]))
    degrees: List[str] = []
    for eid in degree_ids:
        if eid in labels:
            degrees.append(_expand_degree_abbreviations(labels[eid]))

    # De-duplicate preserving order.
    def dedup(seq: List[str]) -> List[str]:
        seen = set()
        out: List[str] = []
        for x in seq:
            if x not in seen:
                seen.add(x)
                out.append(x)
        return out

    return dedup(institutions), dedup(degrees)


def wikidata_get_birth_year(
    wikibase_item: str, *, session: requests.Session, timeout_s: float
) -> Optional[int]:
    # Date of birth = P569
    params = {
        "action": "wbgetentities",
        "format": "json",
        "ids": wikibase_item,
        "props": "claims",
    }
    try:
        r = session.get(WIKIDATA_API, params=params, timeout=timeout_s)
        r.raise_for_status()
        data = r.json()
    except Exception:
        return None
    entities = data.get("entities") if isinstance(data, dict) else None
    if not isinstance(entities, dict) or wikibase_item not in entities:
        return None
    ent = entities[wikibase_item]
    if not isinstance(ent, dict):
        return None
    claims = ent.get("claims")
    if not isinstance(claims, dict):
        return None
    for claim in claims.get("P569", []) or []:
        if not isinstance(claim, dict):
            continue
        mainsnak = claim.get("mainsnak")
        if not isinstance(mainsnak, dict):
            continue
        datavalue = mainsnak.get("datavalue")
        if not isinstance(datavalue, dict):
            continue
        value = datavalue.get("value")
        if isinstance(value, dict) and isinstance(value.get("time"), str):
            # value.time is like "+1968-03-20T00:00:00Z"
            m = re.search(r"([12]\d{3})", value["time"])
            if m:
                try:
                    return int(m.group(1))
                except Exception:
                    return None
    return None


def wikidata_is_human(
    wikibase_item: str, *, session: requests.Session, timeout_s: float
) -> Optional[bool]:
    # Instance of (P31) == human (Q5)
    params = {
        "action": "wbgetentities",
        "format": "json",
        "ids": wikibase_item,
        "props": "claims",
    }
    try:
        r = session.get(WIKIDATA_API, params=params, timeout=timeout_s)
        r.raise_for_status()
        data = r.json()
    except Exception:
        return None
    entities = data.get("entities") if isinstance(data, dict) else None
    if not isinstance(entities, dict) or wikibase_item not in entities:
        return None
    ent = entities[wikibase_item]
    if not isinstance(ent, dict):
        return None
    claims = ent.get("claims")
    if not isinstance(claims, dict):
        return None

    for claim in claims.get("P31", []) or []:
        if not isinstance(claim, dict):
            continue
        mainsnak = claim.get("mainsnak")
        if not isinstance(mainsnak, dict):
            continue
        datavalue = mainsnak.get("datavalue")
        if not isinstance(datavalue, dict):
            continue
        value = datavalue.get("value")
        if isinstance(value, dict) and value.get("id") == "Q5":
            return True
    return False


def build_bios(
    speakers: List[str],
    *,
    existing: Dict[str, Any],
    session: requests.Session,
    timeout_s: float,
    sleep_s: float,
    max_chars: int,
    output_path: str,
    save_every: int,
    show_progress: bool,
    min_birth_year: int,
    force_refresh: bool,
) -> Tuple[Dict[str, Any], Dict[str, int]]:
    out = dict(existing) if isinstance(existing, dict) else {}
    stats = {
        "total": 0,
        "cached": 0,
        "fetched": 0,
        "miss": 0,
        "ambiguous": 0,
        "too_old": 0,
        "not_person": 0,
        "education_nonempty": 0,
        "education_from_infobox": 0,
        "profiles_ok": 0,
        "missing_degrees": 0,
    }
    progress_start = time.time()

    unique = {}
    for s in speakers:
        key = normalize_author_key(s)
        if key and key not in unique:
            unique[key] = s

    for idx, (key, speaker) in enumerate(sorted(unique.items()), start=1):
        if show_progress:
            sys.stderr.write("\r" + render_progress_bar(idx - 1, len(unique), start_time_s=progress_start))
            sys.stderr.flush()

        stats["total"] += 1
        if (not force_refresh) and key in out and isinstance(out[key], dict) and out[key].get("bio"):
            # Refresh legacy entries that include extra metadata fields.
            cached_bio = out[key].get("bio") if isinstance(out[key].get("bio"), str) else ""
            cached_status = out[key].get("status")

            # If this looks like a disambiguation page, don't keep it.
            if looks_like_disambiguation(cached_bio):
                out[key] = {"speaker": speaker, "bio": "", "status": "ambiguous"}
                stats["ambiguous"] += 1
                if save_every > 0 and idx % save_every == 0:
                    write_json(output_path, out)
                continue

            # If the birth year is clearly too old, discard this wiki match.
            cached_birth_year = extract_birth_year_from_text(cached_bio)
            if cached_birth_year is not None and cached_birth_year < min_birth_year:
                out[key] = {"speaker": speaker, "bio": "", "status": "too_old"}
                stats["too_old"] += 1
                if save_every > 0 and idx % save_every == 0:
                    write_json(output_path, out)
                continue

            # If it's already in the new minimal format and previously marked ok/miss/etc, keep.
            if "wiki" not in out[key] and "education" not in out[key] and cached_status in {
                "ok",
                "miss",
                "ambiguous",
                "too_old",
            }:
                stats["cached"] += 1
                continue

        # Speaker-side non-person heuristic: skip Wikipedia lookup for obvious non-person "speakers".
        speaker_norm = _collapse_ws(speaker).strip()
        speaker_l = speaker_norm.lower()
        if (
            any(ch in speaker_norm for ch in ['"', "%"])
            or re.match(r"^\d", speaker_l)
            or any(w in speaker_l for w in ["lawmakers", "district", "slate", "american public", "of the american public"])
        ):
            out[key] = {"speaker": speaker, "bio": "", "status": "not_person"}
            stats["not_person"] += 1
            if save_every > 0 and idx % save_every == 0:
                write_json(output_path, out)
            continue

        # Wikipedia title resolution (strict) + extract (no HTML scraping).
        title = wiki_search_title(speaker, session=session, timeout_s=timeout_s)
        if not title:
            out[key] = {"speaker": speaker, "bio": "", "status": "miss"}
            stats["miss"] += 1
            if save_every > 0 and idx % save_every == 0:
                write_json(output_path, out)
            continue

        bio = wiki_fetch_extract(title, session=session, timeout_s=timeout_s, max_chars=max_chars)
        if not bio:
            out[key] = {"speaker": speaker, "bio": "", "status": "miss"}
            stats["miss"] += 1
            if save_every > 0 and idx % save_every == 0:
                write_json(output_path, out)
            continue

        # Disambiguation detection (plaintext extract).
        if looks_like_disambiguation(bio.extract):
            out[key] = {"speaker": speaker, "bio": "", "status": "ambiguous"}
            stats["ambiguous"] += 1
            if save_every > 0 and idx % save_every == 0:
                write_json(output_path, out)
            continue

        wikibase_item = bio.wikibase_item or wikidata_search_entity_id(speaker, session=session, timeout_s=timeout_s)
        if not wikibase_item:
            out[key] = {"speaker": speaker, "bio": "", "status": "miss"}
            stats["miss"] += 1
            if save_every > 0 and idx % save_every == 0:
                write_json(output_path, out)
            continue

        is_human = wikidata_is_human(wikibase_item, session=session, timeout_s=timeout_s)
        if is_human is False:
            out[key] = {"speaker": speaker, "bio": "", "status": "not_person"}
            stats["not_person"] += 1
            if save_every > 0 and idx % save_every == 0:
                write_json(output_path, out)
            continue
        birth_year = wikidata_get_birth_year(wikibase_item, session=session, timeout_s=timeout_s)

        # Structured facts from Wikidata (degrees must be present).
        facts = wikidata_get_profile_facts(wikibase_item, session=session, timeout_s=timeout_s)
        institutions = facts.get("institutions") if isinstance(facts.get("institutions"), list) else []
        degrees = facts.get("degrees") if isinstance(facts.get("degrees"), list) else []
        positions = facts.get("positions") if isinstance(facts.get("positions"), list) else []
        employers = facts.get("employers") if isinstance(facts.get("employers"), list) else []
        occupations = facts.get("occupations") if isinstance(facts.get("occupations"), list) else []

        # Degrees are optional: if missing, keep the bio (background still useful) but track it.
        if not degrees:
            stats["missing_degrees"] += 1

        # Birth-year constraint: reject matches that look like the wrong (older) person.
        if birth_year is None:
            out[key] = {"speaker": speaker, "bio": "", "status": "miss"}
            stats["miss"] += 1
            if save_every > 0 and idx % save_every == 0:
                write_json(output_path, out)
            continue
        if birth_year < min_birth_year:
            out[key] = {"speaker": speaker, "bio": "", "status": "too_old"}
            stats["too_old"] += 1
            if save_every > 0 and idx % save_every == 0:
                write_json(output_path, out)
            continue

        # Construct a minimal bio from Wikidata facts only.
        parts: List[str] = []
        if bio.extract:
            parts.append(bio.extract)
        if institutions or degrees:
            edu_parts: List[str] = []
            if institutions:
                edu_parts.append("; ".join(institutions))
            if degrees:
                edu_parts.append("Degrees: " + "; ".join(degrees))
            parts.append("Education: " + " | ".join(edu_parts))
        if positions:
            parts.append("Positions: " + "; ".join(positions[:12]))
        if employers:
            parts.append("Employers: " + "; ".join(employers[:12]))
        if occupations:
            parts.append("Occupations: " + "; ".join(occupations[:12]))
        merged_bio = _normalize_plaintext("\n\n".join([p for p in parts if p]).strip())

        out[key] = {"speaker": speaker, "bio": merged_bio, "status": "ok"}
        stats["fetched"] += 1
        if institutions or degrees:
            stats["education_nonempty"] += 1
        stats["profiles_ok"] += 1

        if save_every > 0 and idx % save_every == 0:
            write_json(output_path, out)

        if sleep_s > 0 and idx < len(unique):
            time.sleep(sleep_s)

    if show_progress:
        sys.stderr.write("\r" + render_progress_bar(len(unique), len(unique), start_time_s=progress_start) + "\n")
        sys.stderr.flush()

    return out, stats


def parse_args(argv: List[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build a JSON mapping of LIAR2 speaker -> Wikipedia bio extract.")
    p.add_argument(
        "--input",
        default="Validation/liar2/dataset/all.csv",
        help="LIAR2 CSV file (default: Validation/liar2/dataset/all.csv)",
    )
    p.add_argument(
        "--output",
        default="Validation/liar2/data/final/bios/wiki_bios_all.json",
        help="Output JSON path (default: Validation/liar2/data/final/bios/wiki_bios_all.json)",
    )
    p.add_argument("--timeout-s", type=float, default=15.0)
    p.add_argument("--sleep-s", type=float, default=0.1, help="Sleep between requests (default: 0.1)")
    p.add_argument("--max-chars", type=int, default=20000, help="Max chars to keep from Wikipedia page text (default: 20000)")
    p.add_argument(
        "--min-birth-year",
        type=int,
        default=1930,
        help="Reject matched Wikipedia pages with birth year < this (default: 1930).",
    )
    p.add_argument("--limit-speakers", type=int, default=None, help="Optional cap on unique speakers for testing")
    p.add_argument(
        "--save-every",
        type=int,
        default=25,
        help="Write incremental progress to --output every N speakers (default: 25).",
    )
    p.add_argument(
        "--force-refresh",
        action="store_true",
        help="Ignore cached bios in --output and refetch everything (still checkpoint-saves).",
    )
    p.add_argument("--no-progress", action="store_true", help="Disable the progress bar output.")
    return p.parse_args(argv)


def main(argv: List[str]) -> int:
    args = parse_args(argv)

    speakers = list(read_liar2_speakers(args.input))
    if not speakers:
        print(f"No speakers found in {args.input}", file=sys.stderr)
        return 2

    unique_keys = list({normalize_author_key(s) for s in speakers if normalize_author_key(s)})
    if args.limit_speakers is not None:
        # Keep a deterministic subset.
        allow = set(sorted(unique_keys)[: args.limit_speakers])
        speakers = [s for s in speakers if normalize_author_key(s) in allow]

    existing: Dict[str, Any] = {}
    if os.path.exists(args.output):
        try:
            existing = load_json(args.output)
        except Exception:
            existing = {}

    with requests.Session() as session:
        # Wikipedia may reject requests with no/unknown User-Agent.
        session.headers.update({"User-Agent": DEFAULT_USER_AGENT})
        bios, stats = build_bios(
            speakers,
            existing=existing,
            session=session,
            timeout_s=args.timeout_s,
            sleep_s=args.sleep_s,
            max_chars=args.max_chars,
            output_path=args.output,
            save_every=args.save_every,
            show_progress=not args.no_progress,
            min_birth_year=args.min_birth_year,
            force_refresh=args.force_refresh,
        )

    write_json(args.output, bios)
    print(json.dumps({"output": os.path.abspath(args.output), **stats}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
