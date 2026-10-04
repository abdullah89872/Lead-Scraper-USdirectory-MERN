"""API surface tests (mock mode, no network)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_reports_mock_mode() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["mode"] in {"mock", "live"}
    assert body["service"] == "leadforge-scraper"


def test_sources_lists_usdirectory() -> None:
    response = client.get("/sources")
    assert response.status_code == 200
    names = {item["name"] for item in response.json()["sources"]}
    assert "usdirectory" in names


def test_scrape_endpoint_returns_leads_in_mock_mode() -> None:
    response = client.post(
        "/scrape",
        json={"category": "Roofing", "location": "Hillsboro, Oregon", "max_leads": 8},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "mock"
    assert body["returned"] == 8
    assert len(body["leads"]) == 8
    first = body["leads"][0]
    for field in (
        "businessName", "source", "sourceUrl", "publicEmails", "publicPhones",
        "services", "emailStatus", "enrichmentStatus", "scrapedAt",
    ):
        assert field in first
    assert first["demoData"] is True


def test_scrape_endpoint_validates_input() -> None:
    too_small = client.post("/scrape", json={"category": "R", "location": "Hillsboro, OR"})
    assert too_small.status_code == 422

    bad_max = client.post(
        "/scrape", json={"category": "Roofing", "location": "Hillsboro, OR", "max_leads": 5000}
    )
    assert bad_max.status_code == 422


def test_scrape_unknown_source_is_reported_not_crashed() -> None:
    response = client.post(
        "/scrape",
        json={"category": "Roofing", "location": "Hillsboro, OR", "max_leads": 3, "source": "bogus"},
    )
    assert response.status_code == 200
    assert response.json()["returned"] == 0


def test_enrich_endpoint_without_website() -> None:
    response = client.post(
        "/enrich",
        json={
            "lead": {
                "businessName": "No Site LLC",
                "sourceUrl": "https://usdirectory.com/No-Site-LLC-Hillsboro-OR-1",
            }
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "no_website"
