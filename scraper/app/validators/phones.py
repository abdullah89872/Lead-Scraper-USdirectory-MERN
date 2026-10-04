"""Phone number extraction and normalization (US/NANP focused).

Normalization never guesses digits: if the number cannot be resolved to a
plausible NANP number the original text is discarded (``None``).
"""

from __future__ import annotations

import re

PHONE_RE = re.compile(
    r"(?:(?:\+?1[\s.\-]?)?(?:\(?\d{3}\)?[\s.\-]?)\d{3}[\s.\-]?\d{4})"
)
# Ranges like 555-0100 - 555-0199 are reserved for fiction and used by mock data.
RESERVED_FICTIONAL_RE = re.compile(r"555-01\d{2}")
# 555-5555 is the other reserved exchange block: it is never assigned to a real
# subscriber, so a number ending in it is not a usable contact point.
RESERVED_EXCHANGE_TAIL_RE = re.compile(r"^555-5555$")

_TELCO_PREFIXES = {"800", "833", "844", "855", "866", "877", "888", "900"}


def digits_only(value: str | None) -> str:
    return re.sub(r"\D", "", value or "")


def normalize_phone(raw: str | None) -> str | None:
    """Return an E.164 US number (``+1XXXXXXXXXX``) or None.

    Accepts 10 digits, 11 digits starting with 1, or ``+1`` prefixes.
    Extensions and trailing text are ignored.
    """
    if not raw:
        return None
    candidate = raw.split("ext")[0].split("x")[0]
    digits = digits_only(candidate)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10:
        return None
    if digits[0] in "01":  # NANP area codes never start with 0 or 1
        return None
    if digits[3] in "01":  # exchange codes never start with 0 or 1
        return None
    if len(set(digits)) == 1:
        return None
    if RESERVED_EXCHANGE_TAIL_RE.match(f"{digits[3:6]}-{digits[6:10]}"):
        return None
    return f"+1{digits}"


def format_phone(raw: str | None) -> str | None:
    """Human readable ``(555) 010-0199`` form of a normalized number."""
    e164 = normalize_phone(raw)
    if not e164:
        return None
    digits = e164[2:]
    return f"({digits[0:3]}) {digits[3:6]}-{digits[6:10]}"


def is_toll_free(raw: str | None) -> bool:
    e164 = normalize_phone(raw)
    return bool(e164) and e164[2:5] in _TELCO_PREFIXES


def extract_phones(text: str) -> list[str]:
    """Return unique normalized phone numbers found in ``text``."""
    if not text:
        return []
    found: list[str] = []
    for match in PHONE_RE.findall(text):
        normalized = normalize_phone(match)
        if normalized and normalized not in found:
            found.append(normalized)
    return found


def is_fictional_number(raw: str | None) -> bool:
    """True for 555-01xx numbers that must never be treated as real data."""
    e164 = normalize_phone(raw)
    if not e164:
        return False
    digits = e164[2:]
    return bool(RESERVED_FICTIONAL_RE.match(f"{digits[3:6]}-{digits[6:10]}"))
