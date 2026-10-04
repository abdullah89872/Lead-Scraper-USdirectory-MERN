"""FastAPI surface for the scraper service.

The service is stateless: it receives a scrape request, performs it respecting
the source's rules, and returns normalized leads. It never writes to MongoDB -
persistence belongs to the Node API.
"""

from __future__ import annotations

import logging
import time

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .models import EnrichRequest, EnrichResponse, ScrapeRequest, ScrapeResponse
from .services.pipeline import enrich_single, run_scrape
from .services.progress import ProgressReporter
from .services.robots import RobotsPolicy
from .sources.registry import available_sources

logging.basicConfig(
    level=logging.INFO,
    format='{"ts":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
)
logger = logging.getLogger("leadforge.scraper")

settings = get_settings()

app = FastAPI(
    title="LeadForge AI Scraper",
    version="1.0.0",
    description=(
        "Respectful public-directory scraper. Honours robots.txt, rate limits and "
        "access restrictions; stops and reports instead of bypassing them."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # internal service - the Node API is the only caller
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "service": "leadforge-scraper",
        "version": app.version,
        "mode": settings.scraper_mode,
        "fetcher": "static" if settings.is_mock else settings.scraper_fetcher,
        "respectRobotsTxt": settings.respect_robots_txt,
        "time": int(time.time()),
    }


@app.get("/sources")
async def sources() -> dict[str, object]:
    return {"mode": settings.scraper_mode, "sources": available_sources()}


@app.post("/scrape", response_model=ScrapeResponse)
async def scrape(request: ScrapeRequest) -> ScrapeResponse:
    """Run a scrape. Long running for live mode (bounded by max_pages/limits)."""
    reporter = ProgressReporter(
        request.progress_url or None,
        request.progress_token or settings.internal_api_token,
        request.job_id,
    )
    try:
        logger.info(
            "scrape start source=%s category=%s location=%s max=%s mode=%s",
            request.source, request.category, request.location,
            request.max_leads, settings.scraper_mode,
        )
        response = await run_scrape(request, settings, reporter)
        logger.info(
            "scrape done returned=%s pages=%s blocked=%s durationMs=%s",
            response.returned, response.stats.pagesFetched,
            response.stats.blocked, response.stats.durationMs,
        )
        return response
    finally:
        await reporter.close()


@app.post("/enrich", response_model=EnrichResponse)
async def enrich(request: EnrichRequest) -> EnrichResponse:
    """Enrich a single lead from the business' own public website."""
    return await enrich_single(request.lead, settings)


@app.get("/robots")
async def robots_check(url: str = Query(..., description="Absolute URL to check")) -> dict[str, object]:
    """Report what robots.txt says about a URL (no fetching of the page itself)."""
    from .services.http import HttpxFetcher
    from .services.rate_limiter import RateLimiter

    fetcher = HttpxFetcher(
        user_agent=settings.scraper_user_agent,
        timeout_s=settings.request_timeout_s,
        max_retries=1,
        limiter=RateLimiter(min_delay_s=0.0, concurrency=1),
    )
    policy = RobotsPolicy(fetcher, enabled=True, user_agent=settings.scraper_user_agent)
    try:
        allowed = await policy.can_fetch(url)
        delay = await policy.crawl_delay(url)
        return {"url": url, "allowed": allowed, "crawlDelay": delay}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"could not evaluate robots.txt: {exc}")
    finally:
        await fetcher.close()


if __name__ == "__main__":  # pragma: no cover - manual entrypoint
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.scraper_host,
        port=settings.scraper_port,
        reload=False,
    )
