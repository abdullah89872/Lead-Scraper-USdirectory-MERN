"""Deduplication tests."""

from __future__ import annotations

from app.models import Lead
from app.services.dedupe import (
    dedupe_leads,
    match_keys,
    merge_leads,
    name_similarity,
    normalize_name,
    normalize_phone_value,
)


def make_lead(**overrides) -> Lead:
    base = dict(
        businessName="Cedar Ridge Roofing",
        sourceUrl="https://usdirectory.com/Cedar-Ridge-Roofing-Hillsboro-OR-100201",
        source="usdirectory",
        city="Hillsboro",
        state="OR",
    )
    base.update(overrides)
    return Lead(**base)


def test_normalize_name_strips_legal_suffixes() -> None:
    assert normalize_name("The Cedar Ridge Roofing Co., LLC") == "cedar ridge roofing"
    assert normalize_name("Cedar Ridge Roofing, Inc.") == "cedar ridge roofing"


def test_normalize_phone_value() -> None:
    assert normalize_phone_value("+1 (503) 555-0101") == "5035550101"
    assert normalize_phone_value(None) == ""


def test_name_similarity() -> None:
    assert name_similarity("Cedar Ridge Roofing", "Cedar Ridge Roofing LLC") == 1.0
    assert name_similarity("Cedar Ridge Roofing", "Summit Plumbing") < 0.5


def test_match_keys_cover_all_spec_keys() -> None:
    lead = make_lead(
        sourceId="100201",
        email="info@acme.example.com",
        phone="+15035550101",
        address="4820 Main St, Hillsboro, OR 97123",
    )
    keys = match_keys(lead)
    prefixes = {key.split(":", 1)[0] for key in keys}
    assert {"url", "src", "email", "phone", "ncs", "na"} <= prefixes


def test_same_source_url_is_merged() -> None:
    first = make_lead(email="info@acme.example.com")
    second = make_lead(phone="+15035550101")  # same sourceUrl
    result = dedupe_leads([first, second])

    assert len(result.leads) == 1
    assert result.removed == 1
    # merging filled the gaps instead of losing data
    assert result.leads[0].phone == "+15035550101"
    assert result.leads[0].email == "info@acme.example.com"


def test_shared_email_merges_different_source_urls() -> None:
    first = make_lead(sourceUrl="https://usdirectory.com/a-1", email="info@acme.example.com")
    second = make_lead(
        businessName="Cedar Ridge Roofing LLC",
        sourceUrl="https://usdirectory.com/b-2",
        email="info@acme.example.com",
    )
    result = dedupe_leads([first, second])
    assert len(result.leads) == 1
    assert result.leads[0].sourceUrl == "https://usdirectory.com/a-1"


def test_shared_phone_merges() -> None:
    first = make_lead(sourceUrl="https://usdirectory.com/a-1", phone="+15035550101")
    second = make_lead(sourceUrl="https://usdirectory.com/b-2", phone="(503) 555-0101")
    assert len(dedupe_leads([first, second]).leads) == 1


def test_name_city_state_merges() -> None:
    first = make_lead(sourceUrl="https://usdirectory.com/a-1")
    second = make_lead(sourceUrl="https://usdirectory.com/b-2", businessName="Cedar Ridge Roofing Inc")
    assert len(dedupe_leads([first, second]).leads) == 1


def test_uncertain_matches_are_flagged_not_merged() -> None:
    first = make_lead(
        businessName="Cedar Ridge Roofing",
        sourceUrl="https://usdirectory.com/a-1",
        email="info@a.example.com",
    )
    second = make_lead(
        businessName="Cedar Ridge Roofers",
        sourceUrl="https://usdirectory.com/b-2",
        email="info@b.example.com",
    )
    result = dedupe_leads([first, second])
    assert len(result.leads) == 2
    assert result.possible_duplicates == 1
    assert all(lead.possibleDuplicate for lead in result.leads)
    assert all(lead.duplicateReason for lead in result.leads)


def test_different_cities_are_not_flagged() -> None:
    first = make_lead(sourceUrl="https://usdirectory.com/a-1", city="Hillsboro")
    second = make_lead(sourceUrl="https://usdirectory.com/b-2", city="Beaverton")
    result = dedupe_leads([first, second])
    assert len(result.leads) == 2
    assert result.possible_duplicates == 0


def test_merge_leads_unions_contact_lists() -> None:
    primary = make_lead(publicEmails=[], publicPhones=["+15035550101"])
    other = make_lead(publicEmails=["a@b.example.com"], publicPhones=["+15035550101", "+15032349900"])
    merge_leads(primary, other)
    assert primary.publicEmails == ["a@b.example.com"]
    assert primary.publicPhones == ["+15035550101", "+15032349900"]
    assert primary.email == "a@b.example.com"
