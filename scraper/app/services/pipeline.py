"""Scrape pipeline: discover -> extract -> normalize -> dedupe -> enrich.

This is the single place where the workflow lives, so the HTTP layer stays thin
and the behaviour is identical in mock and live mode.
"""

from __future__ import annotations

import asyncio
import logging
import time

from ..config import Settings
from ..enrichment.website import WebsiteEnricher
from ..models import EnrichResponse, Lead, ScrapeRequest, ScrapeResponse, ScrapeStats
from ..sources.base import ProfileRef
from ..sources.registry import get_source
from ..validators.emails import email_status
from .dedupe import dedupe_leads
from .http import BaseFetcher, HttpxFetcher, PlaywrightFetcher, StaticFetcher
from .progress import ProgressReporter
from .rate_limiter import RateLimiter, SourceBlockedError
from .robots import RobotsPolicy
from .us_states import LocationError

logger = logging.getLogger(__name__)


def build_fetcher(settings: Settings, limiter: RateLimiter) -> BaseFetcher:
    """Pick the transport for this run (mock mode always uses StaticFetcher)."""
    common = {
        "user_agent": settings.scraper_user_agent,
        "timeout_s": settings.request_timeout_s,
        "max_retries": settings.scrape_max_retries,
        "limiter": limiter,
    }
    if settings.is_mock:
        return StaticFetcher(pages={}, **common)
    if settings.scraper_fetcher.strip().lower() == "playwright":
        return PlaywrightFetcher(headless=settings.scraper_headless, **common)
    return HttpxFetcher(**common)


def build_robots(settings: Settings, fetcher: BaseFetcher) -> RobotsPolicy:
    policy = RobotsPolicy(
        fetcher,
        enabled=settings.respect_robots_txt and not settings.is_mock,
        user_agent=settings.scraper_user_agent,
    )
    fetcher.set_robots(policy)
    return policy


def build_limiter(settings: Settings) -> RateLimiter:
    return RateLimiter(
        min_delay_s=0.0 if settings.is_mock else settings.request_delay_s,
        concurrency=settings.scrape_concurrency,
        block_cooldown_s=settings.scrape_block_cooldown_s,
    )


def _finalize(stats: ScrapeStats, started: float) -> ScrapeStats:
    stats.durationMs = int((time.monotonic() - started) * 1000)
    return stats


def _empty_response(
    request: ScrapeRequest, settings: Settings, stats: ScrapeStats, started: float,
    warnings: list[str],
) -> ScrapeResponse:
    return ScrapeResponse(
        source=request.source,
        mode="mock" if settings.is_mock else "live",
        category=request.category,
        location=request.location,
        requested=request.max_leads,
        returned=0,
        leads=[],
        stats=_finalize(stats, started),
        warnings=warnings,
    )


async def run_scrape(
    request: ScrapeRequest,
    settings: Settings,
    reporter: ProgressReporter | None = None,
) -> ScrapeResponse:
    started = time.monotonic()
    stats = ScrapeStats()
    warnings: list[str] = []

    async def emit(stage: str, percent: int, message: str | None = None, found: int | None = None):
        if reporter is not None:
            await reporter.emit(stage, percent, message, found)

    limiter = build_limiter(settings)
    fetcher = build_fetcher(settings, limiter)
    build_robots(settings, fetcher)

    try:
        source = get_source(request.source, settings)
    except KeyError as exc:
        await fetcher.close()
        return _empty_response(request, settings, stats, started, [str(exc)])

    if settings.is_mock:
        warnings.append(
            "Mock mode is enabled: the leads below are synthetic demo data and do "
            "not represent real businesses."
        )

    try:
        await source.prepare(
            fetcher,
            category=request.category,
            location=request.location,
            max_leads=request.max_leads,
            enrichment=request.enrichment,
        )
        await emit("searching", 8, f"Searching {source.display_name}", 0)

        discovery = await source.discover(
            fetcher,
            category=request.category,
            location=request.location,
            max_leads=request.max_leads,
            max_pages=settings.scrape_max_pages,
            on_progress=lambda stage, pct, msg, found: emit(stage, pct, msg, found),
        )
        stats.pagesFetched = discovery.pages_fetched
        stats.errors.extend(discovery.errors[:10])

        if discovery.blocked:
            stats.blocked = True
            stats.blockReason = discovery.block_reason
            warnings.append(
                "The source restricted automated access "
                f"({discovery.block_reason}). The run stopped without attempting to "
                "bypass it. No data was scraped."
            )
            await emit("restricted", 100, stats.blockReason, 0)
            return _empty_response(request, settings, stats, started, warnings)

        if not discovery.refs:
            warnings.append(
                "No business listings were found for this category and location. "
                "Check the spelling, or try a nearby larger city."
            )
            await emit("done", 100, "No listings found", 0)
            return _empty_response(request, settings, stats, started, warnings)

        await emit(
            "extracting", 55,
            f"Reading {min(len(discovery.refs), request.max_leads)} business profiles",
            len(discovery.refs),
        )

        leads, blocked_during_extraction = await _extract_profiles(
            source, fetcher, discovery.refs[: request.max_leads], settings, stats,
            request.category, request.location, emit,
        )

        if blocked_during_extraction and not leads:
            stats.blocked = True
            stats.blockReason = stats.blockReason or "source restricted access"
            warnings.append(
                "The source restricted automated access while reading profiles. "
                "Stopped without bypassing it."
            )

        first_pass = dedupe_leads(leads)
        stats.duplicatesRemoved = first_pass.removed
        for lead in first_pass.leads:
            if lead.publicEmails:
                lead.emailStatus = email_status(lead.publicEmails)
        leads = first_pass.leads

        if request.enrichment and leads:
            await emit("enriching", 82, "Enriching from business websites", len(leads))
            leads = await _enrich(leads, fetcher, settings, stats, emit)

        final_pass = dedupe_leads(leads)
        stats.duplicatesRemoved += final_pass.removed
        stats.possibleDuplicates = final_pass.possible_duplicates
        leads = final_pass.leads[: request.max_leads]

        await emit("done", 100, f"{len(leads)} leads ready", len(leads))
        response = _empty_response(request, settings, stats, started, warnings)
        response.source = source.name
        response.returned = len(leads)
        response.leads = leads
        return response
    except SourceBlockedError as exc:
        stats.blocked = True
        stats.blockReason = str(exc)
        warnings.append(f"Source restricted access: {exc}. Stopped instead of bypassing it.")
        return _empty_response(request, settings, stats, started, warnings)
    except LocationError:
        # Caller error (unresolvable location): surface it so the API can return a
        # 422 instead of silently reporting "no leads found".
        raise
    except Exception as exc:  # noqa: BLE001 - reported to the API caller
        logger.exception("scrape pipeline failed")
        stats.errors.append(f"{type(exc).__name__}: {exc}")
        return _empty_response(
            request, settings, stats, started, warnings + [f"Scrape failed: {exc}"]
        )
    finally:
        await fetcher.close()


async def _extract_profiles(
    source,
    fetcher: BaseFetcher,
    refs: list[ProfileRef],
    settings: Settings,
    stats: ScrapeStats,
    category: str,
    location: str,
    emit,
) -> tuple[list[Lead], bool]:
    """Fetch + parse profiles with capped concurrency, stopping on a block."""
    semaphore = asyncio.Semaphore(max(1, settings.scrape_concurrency))
    state: dict[str, object] = {"blocked": False, "reason": None}
    leads: list[Lead] = []
    lock = asyncio.Lock()
    total = len(refs)

    async def worker(ref: ProfileRef) -> None:
        if state["blocked"]:
            return
        async with semaphore:
            if state["blocked"]:
                return
            lead, _html, blocked, error = await source.extract_profile(
                fetcher, ref, category=category, location=location
            )
        async with lock:
            stats.profilesFetched += 1
            if blocked:
                state["blocked"] = True
                state["reason"] = error
                stats.errors.append(error or "blocked")
            elif lead is not None:
                leads.append(lead)
                stats.profilesParsed += 1
            elif error:
                stats.errors.append(error)
            if stats.profilesFetched % 10 == 0 or stats.profilesFetched == total:
                percent = 55 + int(stats.profilesFetched / max(total, 1) * 25)
                await emit(
                    "extracting", percent,
                    f"Parsed {stats.profilesParsed} of {total} profiles",
                    stats.profilesParsed,
                )

    await asyncio.gather(*(worker(ref) for ref in refs))
    if state["blocked"]:
        stats.blockReason = state["reason"]  # type: ignore[assignment]
    return leads, bool(state["blocked"])


async def _enrich(
    leads: list[Lead],
    fetcher: BaseFetcher,
    settings: Settings,
    stats: ScrapeStats,
    emit,
) -> list[Lead]:
    enricher = WebsiteEnricher(
        fetcher,
        max_pages=settings.enrichment_max_pages,
        concurrency=settings.enrichment_concurrency,
        enabled=True,
    )
    enriched = await enricher.enrich_many(leads)
    stats.enriched = sum(1 for lead in enriched if lead.enrichmentStatus == "completed")
    stats.enrichmentFailed = sum(1 for lead in enriched if lead.enrichmentStatus == "failed")
    await emit("enriching", 95, f"Enriched {stats.enriched} lead(s)", len(enriched))
    return enriched


async def enrich_single(lead: Lead, settings: Settings) -> EnrichResponse:
    """Enrich one lead on demand (used by ``POST /enrich``)."""
    limiter = build_limiter(settings)
    fetcher = build_fetcher(settings, limiter)
    build_robots(settings, fetcher)
    try:
        enricher = WebsiteEnricher(
            fetcher,
            max_pages=settings.enrichment_max_pages,
            concurrency=settings.enrichment_concurrency,
        )
        updated = await enricher.enrich(lead)
        return EnrichResponse(
            lead=updated,
            status=updated.enrichmentStatus,
            pagesVisited=updated.enrichmentSources,
            message=updated.notes[-1] if updated.notes else None,
        )
    finally:
        await fetcher.close()
