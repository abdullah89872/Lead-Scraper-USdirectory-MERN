"""Run ONE small live scrape through the project's own pipeline.

Read-only diagnostic. It makes the same requests the service makes, honours
robots.txt and the configured delays, and never attempts to bypass a block.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys

os.environ["SCRAPER_MODE"] = "live"
# Only a *default*: an explicit value in the environment always wins. This used
# to pin the probe to 3 pages, which made it look like the crawler could not
# follow pagination past page 3.
os.environ.setdefault("SCRAPE_MAX_PAGES", "25")
os.environ.setdefault("SCRAPE_CONCURRENCY", "1")
os.environ.setdefault("SCRAPE_REQUEST_DELAY_MS", "1200")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import Settings  # noqa: E402
from app.models import ScrapeRequest  # noqa: E402
from app.services.pipeline import run_scrape  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")


async def main() -> int:
    settings = Settings()
    print("MODE:", settings.scraper_mode, "| FETCHER:", settings.scraper_fetcher)
    print("UA:", settings.scraper_user_agent)

    req = ScrapeRequest(
        category="Roofing",
        location="Hillsboro, Oregon",
        max_leads=5,
        source="usdirectory",
        enrichment=False,
    )
    resp = await run_scrape(req, settings, None)

    print("\n=== SCRAPE RESULT ===")
    print("returned :", resp.returned)
    print("stats    :", json.dumps(resp.stats.model_dump(), indent=2)[:2000])
    print("warnings :", json.dumps(resp.warnings, indent=2))

    leads = [lead.model_dump(mode="json") for lead in resp.leads]
    # The console view is deliberately short; the full result is written to
    # JSON so every sourceUrl can be re-checked afterwards.
    print("leads    :", json.dumps(leads, indent=2)[:2000])

    out_path = os.environ.get("LIVE_PROBE_JSON", "live_result.json")
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "returned": resp.returned,
                "stats": resp.stats.model_dump(),
                "warnings": resp.warnings,
                "leads": leads,
            },
            handle,
            indent=2,
            ensure_ascii=False,
        )
    print(f"\nfull result written to {out_path} ({len(leads)} leads)")

    print("\n=== LEADS ===")
    for lead in resp.leads:
        print(f"- {lead.business_name!r}  {lead.phone or '-'}  {lead.source_url}")
    return 0 if resp.stats.blocked else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))