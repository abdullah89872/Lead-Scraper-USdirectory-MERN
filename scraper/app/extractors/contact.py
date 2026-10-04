"""Contact-point extraction from publicly displayed markup.

Sources of truth, in order of trust:

1. ``mailto:`` / ``tel:`` link hrefs (explicitly published by the business)
2. ``<address>`` blocks and postal-looking text
3. JSON-LD ``ContactPoint`` / ``PostalAddress`` nodes
4. Visible body text

Nothing is inferred or invented: a value that is not present in the markup is
returned as ``None``.
"""

from __future__ import annotations

import re
from typing import Any, Iterable
from urllib.parse import urlparse

from bs4 import BeautifulSoup, Tag

from ..validators.emails import extract_emails, normalize_email
from ..validators.phones import extract_phones, normalize_phone
from .html import canonical_url

SOCIAL_HOSTS = (
    "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com",
    "youtube.com", "tiktok.com", "pinterest.com",
)

ZIP_RE = re.compile(r"\b(\d{5})(?:-\d{4})?\b")


def extract_mailto_emails(soup: BeautifulSoup) -> list[str]:
    found: list[str] = []
    for anchor in soup.find_all("a", href=True):
        href = str(anchor["href"])
        if href.lower().startswith("mailto:"):
            address = normalize_email(href.split(":", 1)[1].split("?", 1)[0])
            if address and address not in found:
                found.append(address)
        # data-* attributes are sometimes used for obfuscation by CMSs
        for attr, value in anchor.attrs.items():
            if isinstance(value, str) and attr.lower().startswith("data-") and "@" in value:
                for address in extract_emails(value):
                    if address not in found:
                        found.append(address)
    return found


def extract_tel_phones(soup: BeautifulSoup) -> list[str]:
    found: list[str] = []
    for anchor in soup.find_all("a", href=True):
        href = str(anchor["href"])
        if href.lower().startswith("tel:"):
            number = normalize_phone(href.split(":", 1)[1])
            if number and number not in found:
                found.append(number)
    return found


def visible_text(soup: BeautifulSoup) -> str:
    clone = BeautifulSoup(str(soup), "html.parser")
    for tag in clone(["script", "style", "noscript", "template"]):
        tag.decompose()
    return clone.get_text(" ", strip=True)


def extract_contact_points(soup: BeautifulSoup) -> dict[str, list[str]]:
    """Return ``{"emails": [...], "phones": [...]}`` found in the markup."""
    text = visible_text(soup)
    emails = extract_mailto_emails(soup) + extract_emails(text)
    phones = extract_tel_phones(soup) + extract_phones(text)

    deduped_emails: list[str] = []
    for address in emails:
        if address not in deduped_emails:
            deduped_emails.append(address)

    deduped_phones: list[str] = []
    for number in phones:
        if number not in deduped_phones:
            deduped_phones.append(number)

    return {"emails": deduped_emails, "phones": deduped_phones}


def extract_address_node(value: Any) -> dict[str, str | None]:
    """Map a schema.org PostalAddress (dict or string) to our address fields."""
    if isinstance(value, str):
        return {"address": value or None, "city": None, "state": None, "zip": None}
    if not isinstance(value, dict):
        return {"address": None, "city": None, "state": None, "zip": None}

    street = value.get("streetAddress")
    city = value.get("addressLocality")
    region = value.get("addressRegion")
    zip_value = value.get("postalCode")

    locality = ", ".join(str(part).strip() for part in (city, region) if part)
    tail = " ".join(str(part).strip() for part in (locality, zip_value) if part)
    joined = ", ".join(part for part in (str(street).strip() if street else None, tail) if part)

    return {
        "address": joined or None,
        "city": (city or None),
        "state": (region or None),
        "zip": (str(zip_value).strip() if zip_value else None),
    }


def extract_postal_from_text(text: str) -> dict[str, str | None]:
    """Best-effort parse of a US address string that is already public."""
    result: dict[str, str | None] = {"address": None, "city": None, "state": None, "zip": None}
    if not text:
        return result

    zip_match = ZIP_RE.search(text)
    if zip_match:
        result["zip"] = zip_match.group(1)

    state_match = re.search(r",\s*([A-Z]{2})\s+\d{5}", text)
    if state_match:
        result["state"] = state_match.group(1)

    city_match = re.search(r",\s*([A-Za-z .'\-]+),\s*[A-Z]{2}\b", text)
    if city_match:
        result["city"] = city_match.group(1).strip()

    cleaned = " ".join(text.split())
    if cleaned:
        result["address"] = cleaned
    return result


def extract_services(soup: BeautifulSoup, json_ld: Iterable[dict[str, Any]] = ()) -> list[str]:
    """Publicly listed services/offerings (JSON-LD first, then markup lists)."""
    services: list[str] = []

    def push(value: Any) -> None:
        if isinstance(value, str):
            name = " ".join(value.split())
            if 2 < len(name) < 120 and name not in services:
                services.append(name)
        elif isinstance(value, dict):
            push(value.get("name") or value.get("itemOffered") or value.get("serviceType"))
        elif isinstance(value, list):
            for item in value:
                push(item)

    for block in json_ld:
        push(block.get("makesOffer"))
        push(block.get("hasOfferCatalog"))
        push(block.get("knowsAbout"))
        push(block.get("serviceType"))

    if not services:
        for selector in (
            "[data-testid='services'] li",
            ".services li",
            ".service-list li",
            "#services li",
            "ul.services-list li",
        ):
            for node in soup.select(selector):
                push(node.get_text(" ", strip=True))
            if services:
                break

    return services[:25]


def extract_website(soup: BeautifulSoup, base_host: str | None = None) -> str | None:
    """Find the business' own website from a profile page.

    Only links that point off-directory (and are not social profiles) count.
    """
    candidates: list[str] = []
    for anchor in soup.find_all("a", href=True):
        href = str(anchor["href"]).strip()
        if not href.lower().startswith(("http://", "https://")):
            continue
        host = (urlparse(href).netloc or "").lower()
        if not host or (base_host and base_host in host):
            continue
        if any(social in host for social in SOCIAL_HOSTS):
            continue
        if any(bad in host for bad in ("google.com", "apple.com", "bing.com", "yelp.com")):
            continue
        rel = " ".join(anchor.get("rel") or []).lower()
        text = anchor.get_text(" ", strip=True).lower()
        score = 0
        if "website" in text or "visit" in text or "www" in text:
            score += 2
        if "nofollow" not in rel:
            score += 1
        candidates.append(f"{score}|{href}")
    if not candidates:
        return None
    candidates.sort(reverse=True)
    return canonical_url(candidates[0].split("|", 1)[1])


def first_text(node: Tag | None) -> str | None:
    if node is None:
        return None
    value = node.get_text(" ", strip=True)
    return " ".join(value.split()) or None