"""End-to-end pipeline tests in mock mode (no network access required)."""

from __future__ import annotations

import pytest

from app.config import Settings
from app.extractors.contact import extract_contact_points, extract_website
from app.extractors.html import find_next_page_url, make_soup
from app.models import ScrapeRequest
from app.services.http import FetchResult, StaticFetcher
from app.services.pipeline import run_scrape
from app.services.rate_limiter import RateLimiter
from app.sources.mock import (
    MockDirectorySource,
    build_mock_catalog,
    render_profile_page,
    render_search_page,
    render_website_contact,
)
from app.sources.registry import get_source


def mock_settings(**overrides) -> Settings:
    values = dict(
        scraper_mode="mock",
        scrape_concurrency=4,
        enrichment_concurrency=4,
        enrichment_max_pages=5,
        scrape_max_pages=5,
        respect_robots_txt=True,
    )
    values.update(overrides)
    return Settings(**values)


def static_fetcher() -> StaticFetcher:
    return StaticFetcher(
        pages={}, user_agent="test", max_retries=0, limiter=RateLimiter(min_delay_s=0)
    )


async def test_full_mock_scrape_returns_leads() -> None:
    response = await run_scrape(
        ScrapeRequest(category="Roofing", location="Hillsboro, Oregon", max_leads=40),
        mock_settings(),
    )

    assert response.mode == "mock"
    assert response.source == "usdirectory"
    assert response.returned == 40
    assert len(response.leads) == 40
    assert response.stats.blocked is False
    assert response.stats.pagesFetched >= 2  # pagination was exercised
    assert response.warnings  # mock-mode notice is always present


async def test_mock_leads_are_flagged_demo_and_carry_source_urls() -> None:
    from app.validators.phones import is_fictional_number

    response = await run_scrape(
        ScrapeRequest(category="Roofing", location="Hillsboro, OR", max_leads=25),
        mock_settings(),
    )
    for lead in response.leads:
        assert lead.demoData is True
        assert lead.source == "usdirectory"
        assert lead.sourceUrl.startswith("https://usdirectory.com/")
        if lead.phone:
            assert lead.phone.startswith("+1")
            assert is_fictional_number(lead.phone)  # reserved 555-01xx range
        if lead.website:
            assert lead.website.endswith(".example.com")
        if lead.email:
            assert lead.email.endswith(".example.com")


async def test_max_leads_is_respected() -> None:
    response = await run_scrape(
        ScrapeRequest(category="Plumbing", location="Portland, Oregon", max_leads=7),
        mock_settings(),
    )
    assert response.returned <= 7


async def test_enrichment_statuses_are_recorded() -> None:
    response = await run_scrape(
        ScrapeRequest(category="Roofing", location="Hillsboro, Oregon", max_leads=30, enrichment=True),
        mock_settings(),
    )
    statuses = {lead.enrichmentStatus for lead in response.leads}
    assert "completed" in statuses
    enriched = [lead for lead in response.leads if lead.enrichmentStatus == "completed"]
    assert enriched, "expected at least one enriched lead"
    assert any(lead.enrichmentSources for lead in enriched)
    assert response.stats.enriched == len(enriched)


async def test_enrichment_can_be_disabled() -> None:
    response = await run_scrape(
        ScrapeRequest(category="Roofing", location="Hillsboro, Oregon", max_leads=10, enrichment=False),
        mock_settings(),
    )
    assert all(lead.enrichmentStatus == "not_attempted" for lead in response.leads)


async def test_mock_mode_never_touches_the_network() -> None:
    """The in-memory fetcher map is the only data source in mock mode."""
    source = get_source("usdirectory", mock_settings())
    assert isinstance(source, MockDirectorySource)
    fetcher = static_fetcher()
    await source.prepare(
        fetcher, category="Roofing", location="Hillsboro, Oregon", max_leads=10, enrichment=True
    )
    assert any("usdirectory.com" in url for url in fetcher.pages)
    assert any("robots.txt" in url for url in fetcher.pages)
    assert any("example.com/contact" in url for url in fetcher.pages)


async def test_generated_html_round_trips_through_the_parser() -> None:
    catalog = build_mock_catalog(category="Roofing", location="Hillsboro, Oregon", count=3)
    source = MockDirectorySource()
    lead = source.parse_profile(
        render_profile_page(catalog[0]), catalog[0].profile_url, category="Roofing"
    )
    assert lead is not None
    assert lead.businessName == catalog[0].name
    assert lead.city == catalog[0].city
    assert lead.demoData is True


async def test_unknown_source_reports_a_warning() -> None:
    response = await run_scrape(
        ScrapeRequest(category="Roofing", location="Hillsboro, OR", max_leads=5, source="nope"),
        mock_settings(),
    )
    assert response.returned == 0
    assert "unknown source" in response.warnings[0]


async def test_blocked_source_stops_without_bypassing() -> None:
    """A 403 from the source must abort the run, not be worked around."""

    class BlockedFetcher(StaticFetcher):
        async def _fetch_once(self, url: str) -> FetchResult:
            return FetchResult(url=url, status=403, text="Access Forbidden")

    source = MockDirectorySource()
    fetcher = BlockedFetcher(
        pages={}, user_agent="test", max_retries=0, limiter=RateLimiter(min_delay_s=0)
    )
    result = await source.discover(
        fetcher, category="Roofing", location="Hillsboro, Oregon", max_leads=10, max_pages=3
    )
    assert result.blocked is True
    assert "403" in (result.block_reason or "")
    assert result.refs == []


async def test_missing_state_is_a_validation_error_not_a_crash() -> None:
    from app.services.us_states import LocationError

    with pytest.raises(LocationError):
        await run_scrape(
            ScrapeRequest(category="Roofing", location="Nowhere", max_leads=5), mock_settings()
        )


def test_generated_search_page_exposes_pagination() -> None:
    catalog = build_mock_catalog(category="Roofing", location="Hillsboro, Oregon", count=2)
    html = render_search_page(
        catalog, category="Roofing", city=catalog[0].city, state_abbr=catalog[0].state_abbr,
        page=1, next_page="https://usdirectory.com/Oregon/Hillsboro/Roofing?page=2",
    )
    soup = make_soup(html)
    assert find_next_page_url(soup, "https://usdirectory.com/x") is not None


def test_generated_website_page_has_contact_info() -> None:
    from app.validators.phones import normalize_phone

    catalog = [
        biz
        for biz in build_mock_catalog(category="Roofing", location="Hillsboro, Oregon", count=25)
        if biz.phone and biz.email
    ][0]
    contacts = extract_contact_points(make_soup(render_website_contact(catalog)))
    assert catalog.email in contacts["emails"]
    assert normalize_phone(catalog.phone) in contacts["phones"]


async def test_blocked_run_returns_clean_response(monkeypatch) -> None:
    """End-to-end: a restricted source yields zero leads and a clear warning."""

    class BlockedFetcher(StaticFetcher):
        async def _fetch_once(self, url: str) -> FetchResult:
            return FetchResult(url=url, status=403, text="Access Forbidden")

    def fake_build_fetcher(settings, limiter):
        return BlockedFetcher(pages={}, user_agent="test", max_retries=0, limiter=limiter)

    import app.services.pipeline as pipeline_module
    from app.sources.mock import MockDirectorySource

    async def noop_prepare(fetcher, **kwargs):  # noqa: ANN001, ANN003
        return None

    source = MockDirectorySource()
    source.prepare = noop_prepare  # type: ignore[method-assign]
    monkeypatch.setattr(pipeline_module, "build_fetcher", fake_build_fetcher)
    monkeypatch.setattr(pipeline_module, "get_source", lambda name, settings: source)

    response = await run_scrape(
        ScrapeRequest(category="Roofing", location="Hillsboro, Oregon", max_leads=5),
        mock_settings(),
    )
    assert response.returned == 0
    assert response.leads == []
    assert response.stats.blocked is True
    assert "restricted" in response.warnings[-1].lower()