"""Per-host rate limiting, concurrency control and block cooldowns.

The goal is to be a *good citizen*: slow, serialised per host, and completely
non-interactive when a source signals that access is restricted. When a source
returns 401/403/429/451 or a CAPTCHA challenge we cool the host down and stop
instead of trying to work around the restriction.
"""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from urllib.parse import urlparse

BLOCK_STATUS_CODES = {401, 402, 403, 407, 429, 451, 503}


class SourceBlockedError(RuntimeError):
    """Raised when the remote source restricts access; we never bypass it."""

    def __init__(self, message: str, *, url: str | None = None, status: int | None = None):
        super().__init__(message)
        self.url = url
        self.status = status


def host_of(url: str) -> str:
    try:
        return (urlparse(url).netloc or "").lower() or "unknown"
    except Exception:  # noqa: BLE001 - defensive only
        return "unknown"


class RateLimiter:
    def __init__(
        self,
        *,
        min_delay_s: float = 1.0,
        concurrency: int = 2,
        block_cooldown_s: float = 60.0,
    ) -> None:
        self.min_delay_s = max(min_delay_s, 0.0)
        self.block_cooldown_s = max(block_cooldown_s, 0.0)
        self._semaphore = asyncio.Semaphore(max(concurrency, 1))
        self._host_locks: dict[str, asyncio.Lock] = {}
        self._last_request: dict[str, float] = {}
        self._cooldown_until: dict[str, float] = {}
        self._cooldown_reason: dict[str, str] = {}

    def _lock(self, host: str) -> asyncio.Lock:
        lock = self._host_locks.get(host)
        if lock is None:
            lock = asyncio.Lock()
            self._host_locks[host] = lock
        return lock

    def cooldown_remaining(self, host: str) -> float:
        return max(0.0, self._cooldown_until.get(host, 0.0) - time.monotonic())

    def cooldown_reason(self, host: str) -> str | None:
        """The restriction the source actually signalled for ``host``, if any."""
        if self.cooldown_remaining(host) <= 0:
            return None
        return self._cooldown_reason.get(host)

    def note_block(self, host: str, reason: str | None = None) -> None:
        """Cool the host down after a restriction/rate-limit signal.

        ``reason`` is the specific restriction the source reported. It is kept so
        the error surfaced to the operator explains the real cause (for example a
        geo-restriction) instead of a bare "in back-off" message.
        """
        self._cooldown_until[host] = time.monotonic() + self.block_cooldown_s
        if reason:
            self._cooldown_reason[host] = reason

    @asynccontextmanager
    async def slot(self, url: str):
        host = host_of(url)
        remaining = self.cooldown_remaining(host)
        if remaining > 0:
            reason = self._cooldown_reason.get(host)
            detail = f" Reason reported by the source: {reason}." if reason else ""
            raise SourceBlockedError(
                f"{host} is in back-off for another {remaining:.0f}s after signalling "
                f"restricted access; scraping stopped instead of retrying.{detail}",
                url=url,
            )
        async with self._semaphore:
            async with self._lock(host):
                wait_for = self.min_delay_s - (
                    time.monotonic() - self._last_request.get(host, 0.0)
                )
                if wait_for > 0:
                    await asyncio.sleep(wait_for)
                try:
                    yield
                finally:
                    self._last_request[host] = time.monotonic()
