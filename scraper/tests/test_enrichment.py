"""Website enrichment tests (all offline, using the static fetcher)."""

from __future__ import annotations

from app.enrichment.website import CONTACT_PATHS, WebsiteEnricher, read_identity
from app.extractors.html import make_soup
from app.models import Lead
from app.services.http import BaseFetcher, FetchResult, StaticFetcher
from app.services.rate_limiter import RateLimiter
from app.services.robots import RobotsPolicy

SITE = "https://www.cedar-ridge-roofing.example.com"


class RecordingFetcher(StaticFetcher):
    """StaticFetcher that remembers which URLs were requested."""

    def __init__(self, pages=None, **kwargs):
        super().__init__(pages, **kwargs)
        self.requested: list[str] = []

    async def _fetch_once(self, url: str) -> FetchResult:
        if not url.endswith("robots.txt"):
            self.requested.append(url)
        return await super()._fetch_once(url)


def make_fetcher(pages: dict[str, str], *, robots: str | None = None, **kwargs) -> RecordingFetcher:
    fetcher = RecordingFetcher(
        pages, user_agent="test-bot", max_retries=0, limiter=RateLimiter(min_delay_s=0), **kwargs
    )
    if robots is not None:
        fetcher.add(f"{SITE}/robots.txt", robots)
    fetcher.set_robots(RobotsPolicy(fetcher, enabled=True, user_agent="test-bot"))
    return fetcher


def make_lead(**overrides) -> Lead:
    base = dict(
        businessName="Cedar Ridge Roofing",
        website=SITE,
        sourceUrl="https://usdirectory.com/Cedar-Ridge-Roofing-Hillsboro-OR-100201",
        city="Hillsboro",
        state="OR",
    )
    base.update(overrides)
    return Lead(**base)


async def test_enrichment_adds_public_contact_details(website_contact_html: str) -> None:
    fetcher = make_fetcher(
        {f"{SITE}/": "<html><body><h1>Home</h1></body></html>", f"{SITE}/contact": website_contact_html},
        robots="User-agent: *\nAllow: /\n",
    )
    enricher = WebsiteEnricher(fetcher)
    lead = await enricher.enrich(make_lead())

    assert lead.enrichmentStatus == "completed"
    assert "office@cedar-ridge-roofing.example.com" in lead.publicEmails
    assert "+15035550101" in lead.publicPhones
    assert lead.contactPageUrl == f"{SITE}/contact"
    assert lead.enrichmentSources


async def test_enrichment_without_website_is_marked_but_not_failed() -> None:
    fetcher = make_fetcher({}, robots="User-agent: *\nAllow: /\n")
    lead = await WebsiteEnricher(fetcher).enrich(make_lead(website=None))
    assert lead.enrichmentStatus == "no_website"
    assert fetcher.requested == []


async def test_enrichment_respects_robots_disallow() -> None:
    fetcher = make_fetcher(
        {f"{SITE}/contact": "<html><body>should not be read</body></html>"},
        robots="User-agent: *\nDisallow: /\n",
    )
    lead = await WebsiteEnricher(fetcher).enrich(make_lead())

    assert fetcher.requested == []  # nothing was fetched
    assert lead.enrichmentStatus == "failed"
    assert any("robots" in note.lower() or "stopped" in note.lower() for note in lead.notes)


async def test_enrichment_never_invents_missing_contact_info() -> None:
    page = "<html><body><address>4820 Main St, Hillsboro, OR 97123</address></body></html>"
    fetcher = make_fetcher({f"{SITE}/": page, f"{SITE}/contact": page}, robots="User-agent: *\nAllow: /\n")
    lead = await WebsiteEnricher(fetcher).enrich(make_lead())

    assert lead.publicEmails == []
    assert lead.publicPhones == []
    assert lead.email is None
    assert lead.phone is None
    assert lead.enrichmentStatus == "completed"


async def test_enrichment_visits_at_most_max_pages() -> None:
    pages = {f"{SITE}{path}": f"<html><body><h1>{path}</h1></body></html>" for path in CONTACT_PATHS}
    fetcher = make_fetcher(pages, robots="User-agent: *\nAllow: /\n")
    await WebsiteEnricher(fetcher, max_pages=2).enrich(make_lead())
    assert len(fetcher.requested) == 2


async def test_enrichment_disabled_is_skipped() -> None:
    fetcher = make_fetcher({}, robots="User-agent: *\nAllow: /\n")
    lead = await WebsiteEnricher(fetcher, enabled=False).enrich(make_lead())
    assert lead.enrichmentStatus == "skipped"


async def test_blocked_website_is_recorded_as_failed() -> None:
    class BlockedFetcher(BaseFetcher):
        name = "blocked"

        async def _fetch_once(self, url: str) -> FetchResult:
            if url.endswith("robots.txt"):
                return FetchResult(url=url, status=200, text="User-agent: *\nAllow: /\n")
            return FetchResult(url=url, status=403, text="Access Forbidden")

    fetcher = BlockedFetcher(user_agent="test", max_retries=0, limiter=RateLimiter(min_delay_s=0))
    fetcher.set_robots(RobotsPolicy(fetcher, enabled=True, user_agent="test"))
    lead = await WebsiteEnricher(fetcher).enrich(make_lead())

    assert lead.enrichmentStatus == "failed"
    assert any("stopped" in note.lower() for note in lead.notes)


def test_read_identity_prefers_json_ld() -> None:
    html = """
    <html><head><script type="application/ld+json">
    {"@type":"LocalBusiness","name":"Cedar Ridge Roofing",
     "address":{"streetAddress":"4820 Main St","addressLocality":"Hillsboro",
                "addressRegion":"OR","postalCode":"97123"}}
    </script></head><body><h1>Other name</h1></body></html>
    """
    identity = read_identity(make_soup(html))
    assert identity["name"] == "Cedar Ridge Roofing"
    assert identity["address"] == "4820 Main St, Hillsboro, OR 97123"


def test_candidate_urls_include_contact_and_about() -> None:
    lead = make_lead()
    urls = WebsiteEnricher(StaticFetcher(pages={}, user_agent="t", max_retries=0), max_pages=5).candidate_urls(lead)
    assert f"{SITE}/" in urls
    assert f"{SITE}/contact" in urls
    assert f"{SITE}/about-us" in urls
