"""Shared pytest fixtures for the scraper tests."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

# The offline suite must never touch the network, whatever the service is
# configured to do at runtime. pydantic-settings gives os.environ precedence over
# the .env file, and conftest is imported before any test module (and therefore
# before app.main binds its settings), so this keeps these tests deterministic
# even when scraper/.env is set to SCRAPER_MODE=live for real runs.
os.environ["SCRAPER_MODE"] = "mock"

FIXTURES = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


@pytest.fixture(scope="session")
def usdirectory_search_html() -> str:
    return load_fixture("usdirectory_search.html")


@pytest.fixture(scope="session")
def usdirectory_profile_html() -> str:
    return load_fixture("usdirectory_profile.html")


@pytest.fixture(scope="session")
def website_contact_html() -> str:
    return load_fixture("website_contact.html")


@pytest.fixture(scope="session")
def profile_json_ld() -> dict:
    return json.loads(load_fixture("usdirectory_profile_jsonld.json"))
