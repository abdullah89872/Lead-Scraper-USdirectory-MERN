"""Runtime configuration for the scraper service (environment driven)."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    scraper_port: int = 8000
    scraper_host: str = "127.0.0.1"

    # mock | live
    scraper_mode: str = "mock"
    # httpx | playwright
    scraper_fetcher: str = "httpx"
    scraper_headless: bool = True
    scraper_user_agent: str = (
        "LeadForgeAI/1.0 (+https://example.com/leadforge-bot; respectful crawler)"
    )

    scrape_request_delay_ms: int = 1200
    scrape_concurrency: int = 2
    scrape_max_pages: int = 200
    scrape_request_timeout_ms: int = 20000
    scrape_max_retries: int = 2
    scrape_block_cooldown_s: int = 60
    respect_robots_txt: bool = True

    enrichment_max_pages: int = 5
    enrichment_concurrency: int = 2

    us_directory_base_url: str = "https://usdirectory.com"
    us_directory_search_template: str = ""

    internal_api_token: str = "change-me-internal-token"

    @property
    def is_mock(self) -> bool:
        return self.scraper_mode.strip().lower() == "mock"

    @property
    def request_timeout_s(self) -> float:
        return max(self.scrape_request_timeout_ms, 1000) / 1000.0

    @property
    def request_delay_s(self) -> float:
        return max(self.scrape_request_delay_ms, 0) / 1000.0


@lru_cache
def get_settings() -> Settings:
    return Settings()
