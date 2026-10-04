"""Source registry - one place to plug in additional directories later."""

from __future__ import annotations

from ..config import Settings
from .base import DirectorySource
from .mock import MockDirectorySource
from .usdirectory import USDirectorySource

SOURCES: dict[str, type[DirectorySource]] = {
    "usdirectory": USDirectorySource,
}

# Sources that can be scraped in mock mode (no network required).
MOCK_CAPABLE = {"usdirectory"}


def available_sources() -> list[dict[str, str]]:
    return [
        {
            "name": name,
            "displayName": cls.display_name,
            "baseUrl": cls.base_url if getattr(cls, "base_url", "") else "https://usdirectory.com",
            "mockCapable": name in MOCK_CAPABLE,
        }
        for name, cls in SOURCES.items()
    ]


def get_source(name: str, settings: Settings) -> DirectorySource:
    """Return the source implementation for ``name`` honouring the run mode."""
    key = (name or "usdirectory").strip().lower()
    if key not in SOURCES and key != "usdirectory":
        raise KeyError(f"unknown source '{name}'. Available: {', '.join(SOURCES)}")

    if settings.is_mock:
        if key in MOCK_CAPABLE:
            return MockDirectorySource(
                base_url=settings.us_directory_base_url,
                search_template=settings.us_directory_search_template,
            )
        raise KeyError(f"source '{key}' has no mock implementation")

    return USDirectorySource(
        base_url=settings.us_directory_base_url,
        search_template=settings.us_directory_search_template,
    )
