"""Email extraction helpers.

Only addresses that are literally present in publicly displayed markup are
returned. Nothing is generated, guessed or pattern-completed.
"""

from __future__ import annotations

import re

from email_validator import EmailNotValidError, validate_email

# Deliberately conservative: requires a TLD-ish suffix and no whitespace.
EMAIL_RE = re.compile(
    r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}\b"
)

# Common placeholder / asset false positives found in real markup.
_JUNK_LOCAL_PARTS = {"example", "email", "yourname", "name", "user", "test", "sentry"}
_JUNK_SUFFIXES = (
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".css", ".js",
    ".woff", ".woff2", ".ttf", ".ico", ".pdf", ".mp4", ".webm",
)
_JUNK_DOMAINS = {
    "example.com", "example.org", "example.net", "sentry.io",
    "domain.com", "yourdomain.com", "email.com", "sentry.wixpress.com",
}


def normalize_email(raw: str | None) -> str | None:
    """Lowercase/trim an email and drop obvious noise. Returns None if unusable."""
    if not raw:
        return None
    value = raw.strip()
    value = value.replace("mailto:", "").replace("MAILTO:", "")
    value = value.split("?")[0]
    value = value.strip().strip(".,;:()<>[]\"'`")
    value = value.replace(" ", "")
    if not value or "@" not in value:
        return None
    return value.lower()


def is_valid_email(value: str | None) -> bool:
    """Syntactically valid, deliverability-checked only for syntax/domain shape."""
    if not value or len(value) > 254:
        return False
    try:
        validate_email(value, check_deliverability=False)
    except EmailNotValidError:
        return False
    return True


def is_junk_email(value: str) -> bool:
    lowered = value.lower()
    if any(lowered.endswith(suffix) for suffix in _JUNK_SUFFIXES):
        return True
    local, _, domain = lowered.partition("@")
    if domain in _JUNK_DOMAINS:
        return True
    if local in _JUNK_LOCAL_PARTS:
        return True
    # e.g. "u003e@..." leftovers from escaped HTML
    if local.startswith("u00") or local.startswith("x3"):
        return True
    return False


def deobfuscate(text: str) -> str:
    """Turn ``name (at) domain (dot) com`` style text into real emails.

    This is a faithful reading of publicly displayed text, not fabrication.
    """
    if not text:
        return ""
    out = text
    # Bracketed/parenthesised markers are unambiguous, so rewrite them first.
    out = re.sub(r"\s*\[\s*at\s*\]\s*", "@", out, flags=re.IGNORECASE)
    out = re.sub(r"\s*\(\s*at\s*\)\s*", "@", out, flags=re.IGNORECASE)
    out = re.sub(r"\s*\[\s*dot\s*\]\s*", ".", out, flags=re.IGNORECASE)
    out = re.sub(r"\s*\(\s*dot\s*\)\s*", ".", out, flags=re.IGNORECASE)
    # Word form: "name at acme dot com". The domain marker is normalised first so
    # the bare " at " rule can recognise what follows it as a domain.
    out = re.sub(r"\s+dot\s+(?=[A-Za-z]{2,}\b)", ".", out, flags=re.IGNORECASE)
    out = re.sub(
        r"\s+at\s+(?=[A-Za-z0-9\-]+\.[A-Za-z]{2,})", "@", out, flags=re.IGNORECASE
    )
    return out


def extract_emails(text: str, *, allow_deobfuscation: bool = True) -> list[str]:
    """Return unique, normalized, plausible public email addresses."""
    if not text:
        return []
    haystack = deobfuscate(text) if allow_deobfuscation else text
    found: list[str] = []
    for match in EMAIL_RE.findall(haystack):
        normalized = normalize_email(match)
        if not normalized or normalized in found:
            continue
        if is_junk_email(normalized) or not is_valid_email(normalized):
            continue
        found.append(normalized)
    return found


def email_status(emails: list[str]) -> str:
    if not emails:
        return "unknown"
    return "valid" if all(is_valid_email(e) for e in emails) else "invalid"
