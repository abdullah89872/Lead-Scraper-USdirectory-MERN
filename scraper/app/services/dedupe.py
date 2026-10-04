"""Deduplication.

Exact matches (per the keys below) are merged, filling gaps in the surviving
record. *Uncertain* matches - similar names in the same city that share no
contact point - are only flagged with ``possibleDuplicate`` and are never merged
automatically.

Keys used, in the order the spec lists them:

* source URL
* source id
* email
* phone
* business name + city + state
* business name + address
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher

from ..models import Lead

_PUNCT_RE = re.compile(r"[^a-z0-9 ]+")
_SUFFIXES = {
    "llc", "inc", "incorporated", "co", "company", "corp", "corporation", "ltd",
    "llp", "pllc", "group", "holdings", "the", "and",
}


def normalize_name(value: str | None) -> str:
    """'The Cedar Ridge Roofing Co., LLC' -> 'cedar ridge roofing'."""
    if not value:
        return ""
    text = _PUNCT_RE.sub(" ", value.lower())
    tokens = [token for token in text.split() if token and token not in _SUFFIXES]
    return " ".join(tokens).strip()


def normalize_email_value(value: str | None) -> str:
    return (value or "").strip().lower()


def normalize_phone_value(value: str | None) -> str:
    digits = re.sub(r"\D", "", value or "")
    return digits[-10:] if len(digits) >= 10 else digits


def normalize_text(value: str | None) -> str:
    return " ".join((value or "").lower().split())


def name_similarity(left: str | None, right: str | None) -> float:
    a, b = normalize_name(left), normalize_name(right)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def match_keys(lead: Lead) -> list[str]:
    """All exact-match keys this lead contributes."""
    keys: list[str] = []
    if lead.sourceUrl:
        keys.append(f"url:{normalize_text(lead.sourceUrl)}")
    if lead.sourceId:
        keys.append(f"src:{lead.source or ''}:{lead.sourceId}")
    # Only the lead's PRIMARY contact point is used as a merge key.
    #
    # Earlier versions added every entry of publicEmails/publicPhones. A directory
    # profile page lists *other* businesses too ("nearby"/related listings), so
    # each lead could absorb the contacts of many others. Every lead then shared
    # the same keys and 21 distinct Sacramento businesses were merged into 1
    # (verified live: profilesParsed=21, duplicatesRemoved=20).
    #
    # Dedupe must never destroy distinct businesses, so only the contact that
    # actually belongs to this record is trusted here.
    primary_email = normalize_email_value(lead.email)
    if primary_email:
        keys.append(f"email:{primary_email}")
    primary_phone = normalize_phone_value(lead.phone)
    if primary_phone:
        keys.append(f"phone:{primary_phone}")
    name = normalize_name(lead.businessName)
    if name:
        city = normalize_text(lead.city)
        state = normalize_text(lead.state)
        if city:
            keys.append(f"ncs:{name}|{city}|{state}")
        if lead.address:
            keys.append(f"na:{name}|{normalize_text(lead.address)}")
    return keys


def merge_leads(primary: Lead, other: Lead) -> Lead:
    """Copy values from ``other`` into ``primary`` without overwriting data."""
    scalar_fields = (
        "category", "description", "address", "city", "state", "zip", "phone",
        "email", "website", "sourceId", "contactPageUrl",
    )
    for fieldname in scalar_fields:
        if getattr(primary, fieldname) in (None, "") and getattr(other, fieldname):
            setattr(primary, fieldname, getattr(other, fieldname))

    def union(left: list[str] | None, right: list[str] | None) -> list[str]:
        merged = list(left or [])
        for item in right or []:
            if item and item not in merged:
                merged.append(item)
        return merged

    primary.publicEmails = union(primary.publicEmails, other.publicEmails)
    primary.publicPhones = union(primary.publicPhones, other.publicPhones)
    primary.services = union(primary.services, other.services)
    primary.enrichmentSources = union(primary.enrichmentSources, other.enrichmentSources)
    primary.notes = union(primary.notes, other.notes)
    if primary.enrichmentStatus == "not_attempted" and other.enrichmentStatus != "not_attempted":
        primary.enrichmentStatus = other.enrichmentStatus
    if primary.emailStatus == "unknown" and other.emailStatus != "unknown":
        primary.emailStatus = other.emailStatus
    if not primary.email and primary.publicEmails:
        primary.email = primary.publicEmails[0]
    if not primary.phone and primary.publicPhones:
        primary.phone = primary.publicPhones[0]
    return primary


@dataclass
class DedupeResult:
    leads: list[Lead] = field(default_factory=list)
    removed: int = 0
    merge_notes: list[str] = field(default_factory=list)
    possible_duplicates: int = 0


def dedupe_leads(leads: list[Lead], *, fuzzy_threshold: float = 0.82) -> DedupeResult:
    """Merge exact duplicates and flag (but keep) uncertain ones.

    ``fuzzy_threshold`` only controls the *flagging* of uncertain matches - a
    value below 1.0 means a similar name alone never merges two records.
    """
    result = DedupeResult()
    seen: dict[str, Lead] = {}

    for lead in leads:
        existing: Lead | None = None
        for key in match_keys(lead):
            if key in seen:
                existing = seen[key]
                break

        if existing is not None:
            result.removed += 1
            result.merge_notes.append(
                f"Merged duplicate '{lead.businessName}' ({lead.sourceUrl}) into "
                f"'{existing.businessName}'"
            )
            merge_leads(existing, lead)
        else:
            existing = lead
            result.leads.append(lead)

        for key in match_keys(existing):
            seen.setdefault(key, existing)

    # Flag - never merge - uncertain name matches within the same city/state.
    for index, lead in enumerate(result.leads):
        for other in result.leads[index + 1 :]:
            if lead.possibleDuplicate and other.possibleDuplicate:
                continue
            same_city = normalize_text(lead.city) == normalize_text(other.city)
            same_state = normalize_text(lead.state) == normalize_text(other.state)
            if not same_city or not same_state or not normalize_text(lead.city):
                continue
            if name_similarity(lead.businessName, other.businessName) >= fuzzy_threshold:
                lead.possibleDuplicate = True
                other.possibleDuplicate = True
                lead.duplicateReason = lead.duplicateReason or (
                    f"similar name to '{other.businessName}' in the same city"
                )
                other.duplicateReason = other.duplicateReason or (
                    f"similar name to '{lead.businessName}' in the same city"
                )
                result.possible_duplicates += 1

    return result