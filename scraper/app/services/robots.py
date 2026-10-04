"""robots.txt support - checked before every outbound request."""

from __future__ import annotations

import logging
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

from .http import BaseFetcher

logger = logging.getLogger(__name__)


class RobotsPolicy:
    """Caches and evaluates robots.txt rules for visited hosts."""

    def __init__(self, fetcher: BaseFetcher, *, enabled: bool = True, user_agent: str = "*"):
        self.fetcher = fetcher
        self.enabled = enabled
        self.user_agent = user_agent or "*"
        self._parsers: dict[str, RobotFileParser | None] = {}

    @staticmethod
    def robots_url(url: str) -> str:
        parts = urlparse(url)
        return urljoin(f"{parts.scheme}://{parts.netloc}", "/robots.txt")

    async def _parser_for(self, url: str) -> RobotFileParser | None:
        origin = self.robots_url(url)
        if origin in self._parsers:
            return self._parsers[origin]

        parser: RobotFileParser | None = None
        try:
            result = await self.fetcher.direct_get(origin)
            if result and result.ok and result.text:
                parser = RobotFileParser()
                parser.parse(result.text.splitlines())
                logger.info("robots.txt loaded for %s", origin)
            else:
                logger.info("robots.txt unavailable for %s (status=%s)", origin, getattr(result, "status", None))
        except Exception as exc:  # noqa: BLE001 - never fail the run over robots.txt
            logger.warning("robots.txt fetch error for %s: %s", origin, exc)

        self._parsers[origin] = parser
        return parser

    async def can_fetch(self, url: str) -> bool:
        if not self.enabled:
            return True
        parser = await self._parser_for(url)
        if parser is None:
            # Unable to read the policy (network/geo restriction). We do not
            # guess: callers decide, and the conservative default is to allow
            # only because the policy is unreadable, never to bypass a known rule.
            return True
        try:
            return parser.can_fetch(self.user_agent, url)
        except Exception:  # noqa: BLE001
            return True

    async def crawl_delay(self, url: str) -> float | None:
        if not self.enabled:
            return None
        parser = await self._parser_for(url)
        if parser is None:
            return None
        try:
            return parser.crawl_delay(self.user_agent)
        except Exception:  # noqa: BLE001
            return None
