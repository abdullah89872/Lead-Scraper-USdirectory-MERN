"""Directory source abstraction.

Adding a new directory later means implementing three small methods:

* :meth:`DirectorySource.search_urls`  - seed URLs for category + location
* :meth:`DirectorySource.parse_search_page` - listing page -> profile refs
* :meth:`DirectorySource.parse_profile`     - profile page -> :class:`Lead`

The pagination, politeness and stopping logic lives here so every source
behaves the same way (and so no source can accidentally bypass restrictions).
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Awaitable, Callable
from urllib.parse import urlparse

from ..models import Lead
from ..services.http import BaseFetcher

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[str, int, str | None, int | None], Awaitable[None]]


@dataclass
class ProfileRef:
    url: str
    source_id: str | None = None
    business_name: str | None = None


@dataclass
class SearchPage:
    refs: list[ProfileRef] = field(default_factory=list)
    next_url: str | None = None


@dataclass
class DiscoveryResult:
    refs: list[ProfileRef] = field(default_factory=list)
    pages_fetched: int = 0
    blocked: bool = False
    block_reason: str | None = None
    errors: list[str] = field(default_factory=list)


class DirectorySource(ABC):
    """Base class for every directory integration."""

    name: str = "base"
    display_name: str = "Base directory"
    base_url: str = ""

    @property
    def host(self) -> str:
        return (urlparse(self.base_url).netloc or "").lower()

    # ------------------------------------------------------------------ API
    @abstractmethod
    def search_urls(self, category: str, location: str) -> list[str]:
        """Seed search/listing URLs for a category + location pair."""

    @abstractmethod
    def parse_search_page(self, html: str, url: str) -> SearchPage:
        """Extract business profile references plus the next page URL."""

    @abstractmethod
    def parse_profile(
        self,
        html: str,
        url: str,
        *,
        category: str | None = None,
        location: str | None = None,
    ) -> Lead | None:
        """Extract a single lead from a business profile page."""

    def is_profile_url(self, url: str) -> bool:
        """Hook used by the default discovery implementation."""
        return self.host in (urlparse(url).netloc or "").lower()

    # ------------------------------------------------------------ behaviour
    async def prepare(
        self,
        fetcher: BaseFetcher,
        *,
        category: str,
        location: str,
        max_leads: int,
        enrichment: bool = True,
    ) -> None:
        """Optional hook: pre-load any data the source needs.

        Mock sources use it to seed an in-memory fetch map; real sources do
        nothing here (they fetch live pages during ``discover``).
        """
        return None

    async def discover(
        self,
        fetcher: BaseFetcher,
        *,
        category: str,
        location: str,
        max_leads: int,
        max_pages: int,
        on_progress: ProgressCallback | None = None,
        debugger: Any | None = None,
    ) -> DiscoveryResult:
        """Walk search pages until the target number of refs is collected."""
        result = DiscoveryResult()
        seen: set[str] = set()

        for seed in self.search_urls(category, location):
            if debugger is not None:
                debugger.search_url(seed)
            page_url: str | None = seed
            pages_here = 0
            # A listing page repeats some businesses in its "recommended" and
            # "nearby" blocks, so one page with nothing new does NOT prove the
            # listing ended. We allow a single repeat before stopping, which
            # still breaks the loop on a genuinely repeating page sequence.
            stagnant_pages = 0
            while page_url and pages_here < max_pages and len(result.refs) < max_leads:
                if debugger is not None:
                    debugger.search_url(page_url)
                response = await fetcher.get(page_url)
                if response.blocked:
                    result.blocked = True
                    result.block_reason = response.reason or "source restricted access"
                    logger.warning("discovery stopped: %s", result.block_reason)
                    if debugger is not None:
                        debugger.event("discovery_blocked", url=page_url,
                                       reason=result.block_reason)
                    return result
                if not response.ok:
                    msg = f"{page_url} -> HTTP {response.status} {response.error or ''}".strip()
                    result.errors.append(msg)
                    logger.info("search page unavailable: %s", msg)
                    if debugger is not None:
                        debugger.event("search_page_unavailable", url=page_url,
                                       status=response.status, error=response.error)
                        debugger.snapshot(page_url, response.text, reason=msg)
                    break

                pages_here += 1
                result.pages_fetched += 1
                page = self.parse_search_page(response.text, page_url)
                before = len(result.refs)
                for ref in page.refs:
                    if ref.url in seen:
                        continue
                    seen.add(ref.url)
                    result.refs.append(ref)
                    if len(result.refs) >= max_leads:
                        break
                new_refs = len(result.refs) - before

                if debugger is not None:
                    debugger.listings(
                        page_url,
                        len(result.refs) - before,
                        [item.url for item in page.refs],
                    )
                    if not page.refs:
                        debugger.snapshot(
                            page_url, response.text,
                            reason="no profile links discovered on this search page",
                        )

                if on_progress:
                    await on_progress(
                        "discovering",
                        min(95, 10 + int(len(result.refs) / max(max_leads, 1) * 40)),
                        f"Found {len(result.refs)} businesses on {result.pages_fetched} page(s)",
                        len(result.refs),
                    )

                page_url = page.next_url

                # Stop only on an empty page, or on a second consecutive page
                # that adds nothing new (loop protection).
                if not page.refs:
                    logger.info("listing page %s had no profiles; stopping", page_url)
                    page_url = None
                elif new_refs == 0:
                    stagnant_pages += 1
                    if stagnant_pages >= 2:
                        logger.info(
                            "two consecutive pages with no new listings (%s); "
                            "pagination exhausted", page_url,
                        )
                        page_url = None
                else:
                    stagnant_pages = 0

        return result

    async def extract_profile(
        self,
        fetcher: BaseFetcher,
        ref: ProfileRef,
        *,
        category: str | None = None,
        location: str | None = None,
    ) -> tuple[Lead | None, str | None, bool, str | None]:
        """Fetch + parse one profile.

        Returns ``(lead, source_html, blocked, error)``. The HTML is returned so
        enrichment can reuse it without a second request.
        """
        response = await fetcher.get(ref.url)
        if response.blocked:
            return None, None, True, response.reason or "source restricted access"
        if not response.ok:
            return None, None, False, f"HTTP {response.status} for {ref.url}"
        try:
            lead = self.parse_profile(response.text, response.final_url or ref.url, category=category, location=location)
        except Exception as exc:  # noqa: BLE001 - a bad page must not kill the job
            logger.warning("profile parse failed %s: %s", ref.url, exc)
            return None, response.text, False, f"parse error: {exc}"
        if lead is None:
            return None, response.text, False, "no business data found on page"
        if ref.source_id and not lead.sourceId:
            lead.sourceId = ref.source_id
        return lead, response.text, False, None
