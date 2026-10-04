"""Optional live-scrape debugging (``SCRAPER_DEBUG=true``).

When enabled, the scraper records what it actually saw so a parser can be fixed
against reality rather than guesswork:

* the search URL it requested
* how many listings it found on each page
* every profile URL discovered
* the fields extracted from each profile
* an HTML snapshot for pages that failed to parse

Safety rules baked in
---------------------
* **No secrets are ever written.** Every value passes through :func:`redact`,
  which masks anything that looks like a token, API key or password.
* Snapshots are truncated and the number of saved pages is capped.
* Nothing is written at all when debugging is disabled.

Output: a JSONL event log plus ``*.html`` snapshots inside the debug directory.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# Key names whose values are masked outright, wherever they appear.
SECRET_KEY_RE = re.compile(
    r"(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential)",
    re.IGNORECASE,
)
# Value shapes that look like credentials regardless of the key name.
SECRET_VALUE_RES = (
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}"),  # JWT
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"),  # OpenAI-style key
    re.compile(r"\bghp_[A-Za-z0-9]{20,}"),  # GitHub token
)
REDACTED = "***redacted***"

# Cap the stored snapshot size so a 5 MB page cannot flood the disk.
MAX_SNAPSHOT_BYTES = 512_000
MAX_SNAPSHOTS = 40


def redact(value: Any, *, _depth: int = 0) -> Any:
    """Recursively mask anything that looks like a credential."""
    if _depth > 6:
        return "..."
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            if isinstance(key, str) and SECRET_KEY_RE.search(key):
                out[key] = REDACTED
            else:
                out[key] = redact(item, _depth=_depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        return [redact(item, _depth=_depth + 1) for item in value]
    if isinstance(value, str):
        for pattern in SECRET_VALUE_RES:
            if pattern.search(value):
                return REDACTED
        return value
    return value


class ScrapeDebugger:
    """Collects live-scrape diagnostics. A no-op when ``enabled`` is False."""

    def __init__(self, enabled: bool = False, directory: str | Path | None = None) -> None:
        self.enabled = bool(enabled)
        self.directory = Path(directory) if directory else Path("scraper-debug")
        self._snapshots = 0
        self._handle = None
        if self.enabled:
            try:
                self.directory.mkdir(parents=True, exist_ok=True)
                stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                self._handle = (self.directory / f"scrape-{stamp}.jsonl").open(
                    "a", encoding="utf-8"
                )
            except OSError as exc:  # pragma: no cover - disk problems must not kill a run
                logger.warning("scrape debug disabled, cannot open log: %s", exc)
                self.enabled = False

    # ------------------------------------------------------------------ core
    def event(self, kind: str, **payload: Any) -> None:
        """Append one structured event to the debug log."""
        if not self.enabled or self._handle is None:
            return
        record = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "kind": kind,
            **redact(payload),
        }
        try:
            self._handle.write(json.dumps(record, default=str) + "\n")
            self._handle.flush()
        except OSError:  # pragma: no cover
            logger.debug("could not write debug event %s", kind)

    def snapshot(self, url: str, html: str, *, reason: str) -> str | None:
        """Save a (truncated) copy of ``html`` so parsing can be debugged."""
        if not self.enabled:
            return None
        if self._snapshots >= MAX_SNAPSHOTS:
            self.event("snapshot_skipped", url=url, reason="snapshot cap reached")
            return None
        self._snapshots += 1
        host = (urlparse(url).netloc or "local").replace(":", "_")
        name = f"{host}-{abs(hash(url)) % 10_000_000}-{self._snapshots}.html"
        path = self.directory / name
        body = html or ""
        truncated = len(body) > MAX_SNAPSHOT_BYTES
        if truncated:
            body = body[:MAX_SNAPSHOT_BYTES]
        try:
            path.write_text(
                f"<!-- source-url: {url}\nreason: {reason}\ntruncated: {truncated} -->\n{body}",
                encoding="utf-8",
            )
        except OSError:  # pragma: no cover
            logger.debug("could not write snapshot for %s", url)
            return None
        self.event(
            "snapshot_saved", url=url, path=str(path), reason=reason,
            truncated=truncated, bytes=len(body),
        )
        return str(path)

    # ---------------------------------------------------------- convenience
    def search_url(self, url: str) -> None:
        self.event("search_url", url=url)

    def listings(self, url: str, count: int, profile_urls: list[str]) -> None:
        self.event("listings_found", url=url, count=count, profileUrls=profile_urls)

    def profile_result(
        self,
        url: str,
        *,
        ok: bool,
        fields: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        self.event(
            "profile",
            url=url,
            ok=ok,
            error=error,
            fields={k: v for k, v in (fields or {}).items() if v not in (None, "", [])},
        )

    def summary(self, **payload: Any) -> None:
        self.event("summary", **payload)

    def close(self) -> None:
        if self._handle is not None:
            try:
                self._handle.close()
            except OSError:  # pragma: no cover
                pass
            self._handle = None