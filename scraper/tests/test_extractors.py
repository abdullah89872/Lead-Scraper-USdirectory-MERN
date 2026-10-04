"""Extractor tests: JSON-LD, contact points, addresses, pagination, services."""

from __future__ import annotations

from app.extractors.contact import (
    extract_address_node,
    extract_contact_points,
    extract_postal_from_text,
    extract_services,
    extract_website,
)
from app.extractors.html import (
    canonical_url,
    extract_json_ld_contact,
    find_next_page_url,
    json_ld_blocks,
    make_soup,
    pick_local_business,
)


def test_json_ld_blocks_flattens_graph() -> None:
    html = """
    <html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[
      {"@type":"WebSite","name":"Directory"},
      {"@type":"RoofingContractor","name":"Cedar Ridge Roofing"}
    ]}
    </script></head><body></body></html>
    """
    blocks = json_ld_blocks(make_soup(html))
    assert len(blocks) == 2
    node = pick_local_business(blocks)
    assert node is not None and node["name"] == "Cedar Ridge Roofing"


def test_malformed_json_ld_is_ignored() -> None:
    html = """<html><head><script type="application/ld+json">{not json}</script></head><body></body></html>"""
    assert json_ld_blocks(make_soup(html)) == []


def test_json_ld_contact_extraction() -> None:
    node = {"telephone": "+1-503-555-0101", "email": "hi@acme.com"}
    contacts = extract_json_ld_contact(node)
    assert contacts["emails"] == ["hi@acme.com"]
    assert contacts["phones"] == ["+1-503-555-0101"]


def test_contact_points_prefers_explicit_links(website_contact_html: str) -> None:
    soup = make_soup(website_contact_html)
    contacts = extract_contact_points(soup)
    assert "office@cedar-ridge-roofing.example.com" in contacts["emails"]
    assert "bidding@cedar-ridge-roofing.example.com" in contacts["emails"]
    assert "+15035550101" in contacts["phones"]


def test_address_node_dict_and_string() -> None:
    node = {
        "streetAddress": "4820 Main St",
        "addressLocality": "Hillsboro",
        "addressRegion": "OR",
        "postalCode": "97123",
    }
    parsed = extract_address_node(node)
    assert parsed["city"] == "Hillsboro"
    assert parsed["zip"] == "97123"
    assert parsed["address"].startswith("4820 Main St")
    assert extract_address_node("4820 Main St, Hillsboro, OR 97123")["zip"] is None


def test_postal_from_text() -> None:
    parsed = extract_postal_from_text("4820 Main St, Hillsboro, OR 97123")
    assert parsed["city"] == "Hillsboro"
    assert parsed["state"] == "OR"
    assert parsed["zip"] == "97123"


def test_extract_services_from_json_ld() -> None:
    soup = make_soup("<html><body></body></html>")
    blocks = [{"makesOffer": [{"@type": "Offer", "name": "Gutter Repair"}]}]
    assert extract_services(soup, blocks) == ["Gutter Repair"]


def test_extract_services_from_markup() -> None:
    soup = make_soup(
        "<html><body><ul class='services'><li>Roof Inspection</li><li>Repairs</li></ul></body></html>"
    )
    assert extract_services(soup) == ["Roof Inspection", "Repairs"]


def test_extract_website_skips_social_and_directory() -> None:
    html = """
    <html><body>
      <a href="https://www.facebook.com/cedarridge">Facebook</a>
      <a rel="nofollow" href="https://www.cedar-ridge-roofing.example.com">Visit website</a>
      <a href="https://usdirectory.com/other">Other listing</a>
    </body></html>
    """
    assert extract_website(make_soup(html), "usdirectory.com") == "https://www.cedar-ridge-roofing.example.com"


def test_website_absent_returns_none() -> None:
    assert extract_website(make_soup("<html><body><p>no links</p></body></html>"), "usdirectory.com") is None


def test_find_next_page_url_variants() -> None:
    rel = make_soup('<html><body><a rel="next" href="/list?page=3">More</a></body></html>')
    assert find_next_page_url(rel, "https://example.com/list") == "https://example.com/list?page=3"

    text = make_soup("<html><body><a href='?page=4'>Next</a></body></html>")
    assert find_next_page_url(text, "https://example.com/list") == "https://example.com/list?page=4"

    none = make_soup("<html><body><a href='/x'>x</a></body></html>")
    assert find_next_page_url(none, "https://example.com/list") is None


def test_canonical_url_drops_fragment_and_trailing_slash() -> None:
    assert canonical_url("HTTPS://Example.com/Path/#frag") == "https://example.com/Path"
    assert canonical_url("https://example.com/search?q=1") == "https://example.com/search?q=1"
