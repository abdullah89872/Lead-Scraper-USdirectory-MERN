"""USdirectorySource URL building, slug parsing and page parsing."""

from __future__ import annotations

import asyncio

import pytest

from app.services.http import StaticFetcher
from app.services.rate_limiter import RateLimiter
from app.sources.usdirectory import (
    USDirectorySource,
    legacy_profile_id,
    profile_state_token,
)
from tests.conftest import load_fixture

SOURCE = USDirectorySource()
SITE = "https://usdirectory.com"


# --------------------------------------------------------------------------- #
# Legacy /b/{id}/{slug}.aspx profiles.
#
# The live site uses this shape for most listings past page 2. These links were
# previously rejected outright, which silently truncated every crawl at 3 pages
# while the site itself had 6+.
# --------------------------------------------------------------------------- #
LEGACY = "/b/352529/Professional-cleaning-Miami-Florida.aspx"


def test_legacy_aspx_profile_is_recognised() -> None:
    assert SOURCE.is_profile_url(f"{SITE}{LEGACY}") is True
    assert profile_state_token(LEGACY.strip("/")) == "US"


def test_legacy_profile_id_is_the_numeric_record_id() -> None:
    assert legacy_profile_id(LEGACY.strip("/")) == "b352529"
    assert SOURCE.extract_source_id(f"{SITE}{LEGACY}") == "b352529"


def test_modern_slug_still_recognised() -> None:
    assert SOURCE.is_profile_url(f"{SITE}/Jomada-Services-Corp-miami-FL-1") is True
    assert SOURCE.extract_source_id(f"{SITE}/Jomada-Services-Corp-miami-FL-1") == (
        "Jomada-Services-Corp-miami-FL-1"
    )


def test_listing_and_site_pages_are_not_profiles() -> None:
    assert SOURCE.is_profile_url(f"{SITE}/Florida/Miami/Home-Services") is False
    assert SOURCE.is_profile_url(f"{SITE}/About-Us") is False
    assert SOURCE.is_profile_url(f"{SITE}/") is False


def test_slug_without_state_code_is_not_a_profile() -> None:
    # Real listing card on the live site; not a profile because "Miami" is a
    # city, not a state code.
    assert SOURCE.is_profile_url(f"{SITE}/Cal-Sons-Carpet-and-Wood-Flooring-Miami") is False


def test_pseudo_state_tokens_are_not_treated_as_states() -> None:
    assert profile_state_token("El-Paso-LP") is None
    assert profile_state_token("Something-OF") is None


def test_live_listing_page_yields_both_url_shapes_with_names() -> None:
    """Regression: the live listing markup must produce named refs."""
    html = load_fixture("usdirectory_search_live.html")
    page = SOURCE.parse_search_page(html, f"{SITE}/Florida/Miami/Home-Services")

    urls = {ref.url for ref in page.refs}
    assert f"{SITE}/Jomada-Services-Corp-miami-FL-1" in urls
    assert f"{SITE}{LEGACY}" in urls

    names = {ref.url: ref.business_name for ref in page.refs}
    assert names[f"{SITE}/Jomada-Services-Corp-miami-FL-1"] == "Jomada Services Corp"
    assert names[f"{SITE}{LEGACY}"] == "Professional cleaning"

    # Legacy refs carry the numeric id as their source id.
    ids = {ref.url: ref.source_id for ref in page.refs}
    assert ids[f"{SITE}{LEGACY}"] == "b352529"


def test_live_listing_page_exposes_next_page() -> None:
    html = load_fixture("usdirectory_search_live.html")
    page = SOURCE.parse_search_page(html, f"{SITE}/Florida/Miami/Home-Services")
    assert page.next_url == f"{SITE}/Florida/Miami/Home-Services?page=2"


def test_json_ld_itemlist_is_flattened_from_collection_page() -> None:
    """The ItemList lives under CollectionPage.mainEntity, not @graph."""
    from app.extractors.html import json_ld_blocks, make_soup

    blocks = json_ld_blocks(make_soup(load_fixture("usdirectory_search_live.html")))
    types = {str(node.get("@type")) for node in blocks}
    assert "ItemList" in types
    item_list = next(node for node in blocks if node.get("@type") == "ItemList")
    assert item_list["numberOfItems"] == 64
    assert len(item_list["itemListElement"]) == 2


# --------------------------------------------------------------------------- #
# Pagination depth.
#
# The reported symptom was "the automation only goes for 3 pages" while the
# site showed 7. Two independent causes are covered here: the legacy profile
# shape (above) and the pager/next-page resolution below.
# --------------------------------------------------------------------------- #
def _listing_page(slugs: list[str], pager: list[int], *, base: str = SITE) -> str:
    """Build a listing page in the live site's shape."""
    cards = "".join(
        f'<div class="city-business-row card">'
        f'<a href="{slug}" class="city-business-row__thumb"></a>'
        f'<h3 class="city-business-row__title"><a href="{slug}">Biz {n}</a></h3>'
        f"</div>"
        for n, slug in enumerate(slugs)
    )
    links = "".join(
        f'<a href="{base}/Florida/Miami/Home-Services?page={n}">{n}</a>'
        for n in pager
    )
    return (
        "<html><body>"
        f'<div class="row">{cards}</div>'
        f'<nav class="pagination">{links}</nav>'
        "</body></html>"
    )


def test_pager_numbering_drives_next_page() -> None:
    html = _listing_page(["/Alpha-Miami-FL"], pager=[2, 3, 4])
    page = SOURCE.parse_search_page(html, f"{SITE}/Florida/Miami/Home-Services")
    assert page.next_url == f"{SITE}/Florida/Miami/Home-Services?page=2"


def test_pagination_advances_through_more_than_three_pages() -> None:
    """Regression: the crawl must not stall at page 3."""
    soup_pages = {
        1: ["/Alpha-Miami-FL", "/Bravo-Miami-FL"],
        2: ["/b/101/Charlie-Miami-Florida.aspx"],
        3: ["/b/102/Delta-Miami-Florida.aspx"],
        4: ["/b/103/Echo-Miami-Florida.aspx"],
        5: ["/b/104/Foxtrot-Miami-Florida.aspx"],
    }
    pages = {}
    for number, slugs in soup_pages.items():
        remaining = [n for n in range(number + 1, 7)]
        url = f"{SITE}/Florida/Miami/Home-Services"
        pages[url if number == 1 else f"{url}?page={number}"] = _listing_page(
            slugs, pager=remaining or [number]
        )

    fetcher = StaticFetcher(
        pages=pages,
        user_agent="test-bot",
        max_retries=0,
        limiter=RateLimiter(min_delay_s=0),
    )

    async def run():
        return await SOURCE.discover(
            fetcher, category="Home Services", location="Miami, FL",
            max_leads=100, max_pages=20,
        )

    result = asyncio.run(run())

    assert result.pages_fetched == 5, "expected all five listing pages to be walked"
    urls = {ref.url for ref in result.refs}
    assert f"{SITE}/Alpha-Miami-FL" in urls
    # The legacy profiles on pages 3-5 are the ones that were previously dropped.
    legacy_ids = {ref.source_id for ref in result.refs if ref.source_id}
    for expected in ("b101", "b102", "b103", "b104"):
        assert expected in legacy_ids, (
            f"missing legacy profile {expected}; got {sorted(legacy_ids)}"
        )


def test_repeated_pages_do_not_loop_forever() -> None:
    """A listing that keeps repeating must still terminate."""
    seed = f"{SITE}/Florida/Miami/Home-Services"
    pages = {seed: _listing_page(["/Alpha-Miami-FL"], pager=[2])}
    pages[f"{seed}?page=2"] = _listing_page(["/Alpha-Miami-FL"], pager=[3])
    pages[f"{seed}?page=3"] = _listing_page(["/Alpha-Miami-FL"], pager=[4])
    pages[f"{seed}?page=4"] = _listing_page(["/Alpha-Miami-FL"], pager=[])

    fetcher = StaticFetcher(
        pages=pages,
        user_agent="test-bot",
        max_retries=0,
        limiter=RateLimiter(min_delay_s=0),
    )

    async def run():
        return await SOURCE.discover(
            fetcher, category="Home Services", location="Miami, FL",
            max_leads=100, max_pages=50,
        )

    result = asyncio.run(run())
    assert result.pages_fetched <= 4, "repeated listings must not loop forever"
    assert len(result.refs) == 1


def test_state_name_location_builds_expected_url() -> None:
    assert SOURCE.search_urls("Roofing", "Hillsboro, Oregon") == [
        "https://usdirectory.com/Oregon/Hillsboro/Roofing"
    ]


def test_state_abbreviation_location_builds_expected_url() -> None:
    assert SOURCE.search_urls("Roofing", "Hillsboro, OR") == [
        "https://usdirectory.com/Oregon/Hillsboro/Roofing"
    ]


def test_multi_word_category_slug() -> None:
    assert SOURCE.search_urls("business services", "Hillsboro, OR") == [
        "https://usdirectory.com/Oregon/Hillsboro/Business-Services"
    ]


def test_state_only_location() -> None:
    assert SOURCE.search_urls("Roofing", "Oregon") == [
        "https://usdirectory.com/Oregon/Roofing"
    ]


def test_location_without_state_is_rejected() -> None:
    from app.services.us_states import LocationError

    with pytest.raises(LocationError):
        SOURCE.search_urls("Roofing", "Somewhere Nowhere")


# --- Multi-category resolution -------------------------------------------------
# Verified live on 2026-04-10: there is no /Oregon/Hillsboro/Roofing page (410).
# The trade is spread over the categories the city actually publishes.

HILLSBORO_CATEGORIES = [
    "Auto-Repair",
    "Beauty-Salons",
    "Contractors",
    "Food-Beverage",
    "Home-Services",
    "Legal",
    "Remodeling-and-Repair",
    "Roofing-Services",
]


def _prepared_source(categories: list[str]) -> USDirectorySource:
    source = USDirectorySource()
    source.city_categories = list(categories)
    return source


def test_resolve_categories_prefers_the_dedicated_category() -> None:
    source = _prepared_source(HILLSBORO_CATEGORIES)
    ranked = source.resolve_categories("Roofing")
    assert ranked[0] == "Roofing-Services"
    # The broader buckets that also hold roofers are included behind it.
    assert "Contractors" in ranked
    assert "Home-Services" in ranked


def test_resolve_categories_never_returns_an_unpublished_slug() -> None:
    source = _prepared_source(HILLSBORO_CATEGORIES)
    for slug in source.resolve_categories("Roofing"):
        assert slug in HILLSBORO_CATEGORIES


def test_search_urls_covers_every_matching_category() -> None:
    source = _prepared_source(HILLSBORO_CATEGORIES)
    urls = source.search_urls("Roofing", "Hillsboro, Oregon")
    assert urls == [
        "https://usdirectory.com/Oregon/Hillsboro/Roofing-Services",
        "https://usdirectory.com/Oregon/Hillsboro/Contractors",
        "https://usdirectory.com/Oregon/Hillsboro/Home-Services",
        "https://usdirectory.com/Oregon/Hillsboro/Remodeling-and-Repair",
    ]


def test_search_urls_skips_categories_the_city_does_not_publish() -> None:
    # Hillsboro does not publish Remodeling-and-Repair, so it must not be crawled.
    source = _prepared_source(
        ["Contractors", "Home-Services", "Roofing-Services"]
    )
    urls = source.search_urls("Roofing", "Hillsboro, Oregon")
    assert urls == [
        "https://usdirectory.com/Oregon/Hillsboro/Roofing-Services",
        "https://usdirectory.com/Oregon/Hillsboro/Contractors",
        "https://usdirectory.com/Oregon/Hillsboro/Home-Services",
    ]


def test_search_urls_exact_category_match_wins() -> None:
    source = _prepared_source(HILLSBORO_CATEGORIES)
    assert source.search_urls("Contractors", "Hillsboro, Oregon") == [
        "https://usdirectory.com/Oregon/Hillsboro/Contractors"
    ]


def test_resolve_categories_returns_nothing_without_a_match() -> None:
    source = _prepared_source(["Auto-Repair", "Beauty-Salons"])
    assert source.resolve_categories("Underwater Basket Weaving") == []


def test_resolve_categories_empty_input() -> None:
    assert _prepared_source(HILLSBORO_CATEGORIES).resolve_categories("  ") == []


def test_resolve_category_stays_available_for_single_slug_callers() -> None:
    source = _prepared_source(HILLSBORO_CATEGORIES)
    assert source.resolve_category("Roofing") == "Roofing-Services"


def test_search_template_override() -> None:
    templated = USDirectorySource(
        search_template="https://example.org/find?what={category}&where={city},{state_abbr}&p={page}"
    )
    assert templated.search_urls("Roofing", "Hillsboro, Oregon") == [
        "https://example.org/find?what=Roofing&where=Hillsboro,OR&p=1"
    ]


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://usdirectory.com/Cedar-Ridge-Roofing-Hillsboro-OR-100201", True),
        ("https://usdirectory.com/Oregon/Hillsboro/Roofing", False),
        ("https://usdirectory.com/about", False),
        ("https://usdirectory.com/", False),
        ("https://other-directory.com/Cedar-Ridge-Roofing-Hillsboro-OR-100201", False),
    ],
)
def test_is_profile_url(url: str, expected: bool) -> None:
    assert SOURCE.is_profile_url(url) is expected


def test_extract_source_id() -> None:
    # The slug is the stable identity. The old implementation returned the
    # trailing number, but live data shows that number is only a duplicate
    # disambiguator (e.g. the 2nd "-Boise-ID" listing), not a record id.
    assert SOURCE.extract_source_id("/Cedar-Ridge-Roofing-Hillsboro-OR-100201") == (
        "Cedar-Ridge-Roofing-Hillsboro-OR-100201"
    )
    assert SOURCE.extract_source_id("/Oregon/Hillsboro/Roofing") is None


def test_slugify() -> None:
    assert SOURCE.slugify("business services") == "Business-Services"
    assert SOURCE.slugify("roofing") == "Roofing"
    assert SOURCE.slugify("A/C & Heating") == "A-C-Heating"


def test_parse_search_page(usdirectory_search_html: str) -> None:
    base = "https://usdirectory.com/Oregon/Hillsboro/Roofing"
    page = SOURCE.parse_search_page(usdirectory_search_html, base)

    urls = [ref.url for ref in page.refs]
    assert len(urls) == 3  # the duplicated link is collapsed
    assert urls[0] == "https://usdirectory.com/Cedar-Ridge-Roofing-Hillsboro-OR-100201"
    assert page.refs[0].source_id == "Cedar-Ridge-Roofing-Hillsboro-OR-100201"
    assert page.next_url == "https://usdirectory.com/Oregon/Hillsboro/Roofing?page=2"


def test_parse_profile_json_ld_first(usdirectory_profile_html: str) -> None:
    url = "https://usdirectory.com/Cedar-Ridge-Roofing-Hillsboro-OR-100201"
    lead = SOURCE.parse_profile(usdirectory_profile_html, url, category="Roofing")

    assert lead is not None
    assert lead.businessName == "Cedar Ridge Roofing"
    assert lead.address == "4820 Main St, Hillsboro, OR 97123"
    assert lead.city == "Hillsboro"
    assert lead.state == "OR"
    assert lead.zip == "97123"
    assert lead.phone == "+15035550101"
    assert lead.email == "info@cedar-ridge-roofing.example.com"
    assert lead.website == "https://www.cedar-ridge-roofing.example.com"
    assert lead.sourceUrl == url
    assert lead.sourceId == "Cedar-Ridge-Roofing-Hillsboro-OR-100201"
    assert lead.category == "Roofing Contractor"
    assert "Roof Inspection" in lead.services
    assert lead.demoData is False


def test_parse_profile_without_business_name_returns_none() -> None:
    assert SOURCE.parse_profile("<html><body><p>nothing</p></body></html>", "https://usdirectory.com/x") is None
