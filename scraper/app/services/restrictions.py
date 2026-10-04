"""Detect and describe access restrictions served by a directory source.

Deliberately dependency-free (no app imports) so both the HTTP layer and the
source registry can use it without creating an import cycle.

Why this exists
---------------
A source can refuse access *without* an error status code. Observed live on
usdirectory.com: ``GET /robots.txt`` and ``GET /`` both answer **HTTP 200** with
an HTML page reading "403 Access Forbidden ... not available from your current
location ... offered exclusively within the United States and Canada only".

Because the status is 200, naive code treats the notice as real content. This
module recognises such notices so the run can **stop and report** the actual
reason.

This is detection and reporting only. Nothing here attempts to defeat, evade or
work around a restriction: no proxy rotation, no CAPTCHA solving, no user-agent
spoofing to look like a different client.
"""

from __future__ import annotations

# (marker found in the body, human readable reason)
RESTRICTION_MARKERS: tuple[tuple[str, str], ...] = (
    (
        "not available from your current location",
        "geo-restriction: usdirectory.com serves its site only within the United "
        "States and Canada, and this host is outside that region",
    ),
    (
        "services are offered exclusively",
        "geo-restriction: the source serves its site only within a specific region",
    ),
    (
        "vpn or proxy connection",
        "geo-restriction: the source blocks VPN/proxy egress and this host is "
        "outside the supported region",
    ),
    (
        "verify you are human",
        "CAPTCHA / human-verification challenge",
    ),
    (
        "are you a robot",
        "CAPTCHA / bot challenge",
    ),
    (
        "unusual traffic",
        "traffic / rate-limit challenge",
    ),
    ("cloudflare", "Cloudflare interstitial challenge"),
    ("access forbidden", "access forbidden (403)"),
    ("access denied", "access denied"),
    ("request blocked", "request blocked by the source"),
)

# Generic markers kept for the HTTP layer.
CHALLENGE_MARKERS: tuple[str, ...] = ("captcha", "cf-challenge")

# How much of the body to inspect.
_SCAN_LIMIT = 6000


def classify_restriction(body: str | None) -> str | None:
    """Return a specific restriction reason if ``body`` is a block notice.

    Returns ``None`` when the body looks like ordinary content, so real pages are
    never misreported as blocked.
    """
    if not body:
        return None
    lowered = body[:_SCAN_LIMIT].lower()
    for marker, reason in RESTRICTION_MARKERS:
        if marker in lowered:
            return reason
    for marker in CHALLENGE_MARKERS:
        if marker in lowered:
            return "anti-bot challenge page detected"
    return None