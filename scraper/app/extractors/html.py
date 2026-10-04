"""Low-level HTML/JSON-LD helpers shared by every directory source."""

from __future__ import annotations

import json
import logging
from typing import Any, Callable, Iterable
from urllib.parse import urljoin, urlparse, urlunparse

from bs4 import BeautifulSoup, Tag

logger = logging.getLogger(__name__)

try:  # lxml is optional (faster, tolerant); stdlib parser always works
    import lxml  # noqa: F401

    _PARSER = "lxml"
except Exception:  # noqa: BLE001
    _PARSER = "html.parser"

LOCAL_BUSINESS_TYPES = {
    "localbusiness", "organization", "corporation", "store", "professionalservice",
    "homeandconstructionbusiness", "roofingcontractor", "generalcontractor",
    "plumber", "electrician", "hvacbusiness", "movingcompany", "autorepair",
    "dentist", "legalservice", "realestateagent", "foodestablishment",
}


def make_soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html or "", _PARSER)


def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split())
    return text or None


def canonical_url(url: str) -> str:
    """Normalize a URL for comparison/storage (drops fragments, sorts nothing else)."""
    if not url:
        return ""
    parts = urlparse(url.strip())
    # A bare root ("https://example.com/") is stored without the trailing slash
    # so the same site always compares equal.
    path = parts.path.rstrip("/")
    return urlunparse((parts.scheme.lower(), parts.netloc.lower(), path, "", parts.query, ""))


def absolute(url: str, base: str) -> str:
    return canonical_url(urljoin(base, url.strip()))


def json_ld_blocks(soup: BeautifulSoup) -> list[dict[str, Any]]:
    """Return every JSON-LD node found in the document (flattened)."""
    blocks: list[dict[str, Any]] = []
    for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
        raw = script.string or script.get_text() or ""
        raw = raw.strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            try:  # tolerate trailing junk / multiple objects
                data = json.loads(raw.rstrip(";, \n"))
            except json.JSONDecodeError:
                logger.debug("skipping malformed JSON-LD block")
                continue
        blocks.extend(_flatten_json_ld(data))
    return blocks


def _flatten_json_ld(data: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if isinstance(data, list):
        for item in data:
            out.extend(_flatten_json_ld(item))
    elif isinstance(data, dict):
        graph = data.get("@graph")
        if isinstance(graph, (list, dict)):
            # A ``@graph`` wrapper is only a container: its children are the
            # real nodes, so the wrapper itself is not reported.
            return _flatten_json_ld(graph)
        out.append(data)
        # ``CollectionPage`` (and ``WebPage``) publish their content under
        # ``mainEntity`` - on the live listing pages that is where the
        # ``ItemList`` of every business lives. Without this the listing's
        # first-party structured data was never returned.
        main_entity = data.get("mainEntity") or data.get("mainEntityOfPage")
        if isinstance(main_entity, (list, dict)):
            out.extend(_flatten_json_ld(main_entity))
    return out


def _type_names(node: dict[str, Any]) -> set[str]:
    raw = node.get("@type") or node.get("type") or ""
    if isinstance(raw, list):
        names = {str(item).lower() for item in raw}
    else:
        names = {str(raw).lower()}
    return {name for name in names if name}


def pick_local_business(blocks: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
    """Prefer a LocalBusiness-ish node, else the first node with a name."""
    fallback: dict[str, Any] | None = None
    for node in blocks:
        if not isinstance(node, dict):
            continue
        types = _type_names(node)
        if types & LOCAL_BUSINESS_TYPES:
            return node
        if fallback is None and node.get("name"):
            fallback = node
    return fallback


def extract_json_ld_contact(node: dict[str, Any]) -> dict[str, list[str]]:
    """Pull published emails/phones out of a JSON-LD business node."""
    emails: list[str] = []
    phones: list[str] = []

    def push(value: Any) -> None:
        if isinstance(value, str):
            if "@" in value:
                emails.append(value)
            else:
                phones.append(value)
        elif isinstance(value, list):
            for item in value:
                push(item)
        elif isinstance(value, dict):
            push(value.get("email"))
            push(value.get("telephone"))

    push(node.get("email"))
    push(node.get("telephone"))
    push(node.get("contactPoint"))
    return {"emails": emails, "phones": phones}


def find_anchors(
    soup: BeautifulSoup,
    base_url: str,
    predicate: Callable[[str, Tag], bool],
) -> list[str]:
    """Absolute, de-duplicated anchor hrefs matching ``predicate``."""
    found: list[str] = []
    for anchor in soup.find_all("a", href=True):
        href = str(anchor["href"]).strip()
        if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        target = absolute(href, base_url)
        if not target:
            continue
        try:
            if not predicate(target, anchor):
                continue
        except Exception:  # noqa: BLE001 - a bad anchor must not break the crawl
            continue
        if target not in found:
            found.append(target)
    return found


def find_next_page_url(soup: BeautifulSoup, base_url: str) -> str | None:
    """Detect the next page of results via rel=next or pagination markup."""
    rel_next = soup.find("a", attrs={"rel": lambda value: value and "next" in value})
    if isinstance(rel_next, Tag) and rel_next.get("href"):
        return absolute(str(rel_next["href"]), base_url)

    for anchor in soup.find_all("a", href=True):
        text = anchor.get_text(" ", strip=True).lower()
        aria = str(anchor.get("aria-label") or "").lower()
        if text in {"next", "next page", "›", "»", ">"} or "next" in aria:
            return absolute(str(anchor["href"]), base_url)
    return None
