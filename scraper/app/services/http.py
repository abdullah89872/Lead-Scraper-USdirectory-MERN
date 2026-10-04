"""HTML fetchers.

Three interchangeable implementations:

* :class:`HttpxFetcher`      - plain HTTP, fast, no browser download
* :class:`PlaywrightFetcher` - headless Chromium for JS-heavy pages
* :class:`StaticFetcher`     - in-memory URL -> HTML map (mock mode + tests)
"""

from __future__ import annotations

import asyncio
import logging
import random
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import httpx

from .rate_limiter import BLOCK_STATUS_CODES, RateLimiter, SourceBlockedError, host_of
from .restrictions import CHALLENGE_MARKERS, RESTRICTION_MARKERS, classify_restriction

logger = logging.getLogger(__name__)


@dataclass
class FetchResult:
    url: str
    status: int
    text: str = ""
    final_url: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    blocked: bool = False
    reason: str | None = None
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.status == 200 and bool(self.text) and not self.blocked


class BaseFetcher(ABC):
    """Common fetch behaviour: politeness, retries, block detection."""

    name = "base"

    def __init__(
        self,
        *,
        user_agent: str,
        timeout_s: float = 20.0,
        max_retries: int = 2,
        limiter: RateLimiter | None = None,
        robots: Any | None = None,
    ) -> None:
        self.user_agent = user_agent
        self.timeout_s = timeout_s
        self.max_retries = max(0, max_retries)
        self.limiter = limiter or RateLimiter()
        self.robots = robots

    def set_robots(self, robots: Any) -> None:
        self.robots = robots

    async def direct_get(self, url: str) -> FetchResult:
        """Fetch without robots.txt checks (used for robots.txt itself)."""
        return await self._perform(url)

    async def get(self, url: str, *, check_robots: bool = True) -> FetchResult:
        if check_robots and self.robots is not None:
            allowed = await self.robots.can_fetch(url)
            if not allowed:
                logger.info("robots.txt disallows %s - skipping", url)
                return FetchResult(url=url, status=0, blocked=True, reason="disallowed by robots.txt")
        return await self._perform(url)

    async def _perform(self, url: str) -> FetchResult:
        attempt = 0
        last_error: str | None = None
        while attempt <= self.max_retries:
            attempt += 1
            try:
                async with self.limiter.slot(url):
                    result = await self._fetch_once(url)
            except SourceBlockedError:
                raise
            except Exception as exc:  # noqa: BLE001 - network layer is noisy
                last_error = f"{type(exc).__name__}: {exc}"
                logger.warning("fetch error (%s) %s: %s", attempt, url, last_error)
                if attempt > self.max_retries:
                    return FetchResult(url=url, status=0, error=last_error)
                await asyncio.sleep(self._backoff(attempt))
                continue

            if result.status in BLOCK_STATUS_CODES:
                self.limiter.note_block(host_of(url))
                result.blocked = True
                result.reason = result.reason or f"HTTP {result.status} from source"
                logger.warning("restricted access (%s) for %s", result.status, url)
                return result

            if restriction := classify_restriction(result.text):
                self.limiter.note_block(host_of(url), restriction)
                result.blocked = True
                result.reason = result.reason or restriction
                logger.warning("access restricted for %s: %s", url, restriction)
                return result

            if result.status >= 500 and attempt <= self.max_retries:
                await asyncio.sleep(self._backoff(attempt))
                continue

            return result

        return FetchResult(url=url, status=0, error=last_error or "unknown fetch error")

    def _looks_like_challenge(self, result: FetchResult) -> bool:
        """True when the body is a restriction notice rather than real content.

        Kept as a thin wrapper so existing callers/tests keep working; the
        marker knowledge itself lives in ``app.services.restrictions``.
        """
        if result.status >= 400:
            return False
        return classify_restriction(result.text) is not None

    def _backoff(self, attempt: int) -> float:
        return min(2 ** attempt, 8) + random.uniform(0, 0.75)

    @abstractmethod
    async def _fetch_once(self, url: str) -> FetchResult:  # pragma: no cover - abstract
        raise NotImplementedError

    async def close(self) -> None:  # pragma: no cover - optional override
        return None


class HttpxFetcher(BaseFetcher):
    """Plain HTTP fetching - the default (no browser binaries required)."""

    name = "httpx"

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._client = httpx.AsyncClient(
            follow_redirects=True,
            timeout=httpx.Timeout(self.timeout_s),
            headers={
                "User-Agent": self.user_agent,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
        )

    async def _fetch_once(self, url: str) -> FetchResult:
        response = await self._client.get(url)
        return FetchResult(
            url=url,
            status=response.status_code,
            text=response.text,
            final_url=str(response.url),
            headers=dict(response.headers),
        )

    async def close(self) -> None:
        await self._client.aclose()


class PlaywrightFetcher(BaseFetcher):
    """Headless Chromium fetching for JavaScript heavy pages."""

    name = "playwright"

    def __init__(self, *, headless: bool = True, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.headless = headless
        self._playwright = None
        self._browser = None
        self._context = None
        self._lock = asyncio.Lock()

    async def _ensure_browser(self):
        async with self._lock:
            if self._context is not None:
                return self._context
            from playwright.async_api import async_playwright  # imported lazily

            self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(headless=self.headless)
            self._context = await self._browser.new_context(
                user_agent=self.user_agent, locale="en-US"
            )
            return self._context

    async def _fetch_once(self, url: str) -> FetchResult:
        context = await self._ensure_browser()
        page = await context.new_page()
        try:
            response = await page.goto(
                url, wait_until="domcontentloaded", timeout=self.timeout_s * 1000
            )
            try:
                await page.wait_for_load_state("networkidle", timeout=4000)
            except Exception:  # noqa: BLE001 - networkidle is best effort
                pass
            html = await page.content()
            return FetchResult(
                url=url,
                status=response.status if response else 0,
                text=html,
                final_url=page.url,
            )
        finally:
            await page.close()

    async def close(self) -> None:
        try:
            if self._context is not None:
                await self._context.close()
            if self._browser is not None:
                await self._browser.close()
            if self._playwright is not None:
                await self._playwright.stop()
        except Exception as exc:  # noqa: BLE001
            logger.debug("playwright shutdown: %s", exc)
        finally:
            self._playwright = self._browser = self._context = None


class StaticFetcher(BaseFetcher):
    """Serves pre-built HTML from memory. Used by mock mode and tests."""

    name = "static"

    def __init__(self, pages: dict[str, str] | None = None, **kwargs: Any) -> None:
        kwargs.setdefault("max_retries", 0)
        super().__init__(**kwargs)
        self.pages: dict[str, str] = dict(pages or {})

    def add(self, url: str, html: str) -> None:
        self.pages[url] = html

    async def _fetch_once(self, url: str) -> FetchResult:
        html = self.pages.get(url)
        if html is None:
            return FetchResult(url=url, status=404, text="", reason="not in static map")
        return FetchResult(url=url, status=200, text=html, final_url=url)