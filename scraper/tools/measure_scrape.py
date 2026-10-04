"""Time a live scrape directly, bypassing the backend's HTTP timeout.

Used to size SCRAPE_TIMEOUT_MS against the real cost of a job. Writes its
result to timing.json when finished.

Usage:  python tools/measure_scrape.py [maxLeads] [outfile]
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time

os.environ["SCRAPER_MODE"] = "live"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import Settings  # noqa: E402
from app.models import ScrapeRequest  # noqa: E402
from app.services.pipeline import run_scrape  # noqa: E402


async def main(max_leads: int, outfile: str) -> int:
    settings = Settings()
    print(
        f"delay={settings.scrape_request_delay_ms}ms "
        f"concurrency={settings.scrape_concurrency} "
        f"enrich_pages={settings.enrichment_max_pages}",
        flush=True,
    )

    request = ScrapeRequest(
        category="Roofing",
        location="Hillsboro, Oregon",
        max_leads=max_leads,
        source="usdirectory",
        enrichment=False,  # measure the directory crawl on its own
    )

    started = time.monotonic()
    response = await run_scrape(request, settings, None)
    elapsed = time.monotonic() - started

    per_lead = elapsed / max(response.returned, 1)
    print(f"\nmaxLeads={max_leads} returned={response.returned}")
    print(f"elapsed      : {elapsed:.1f}s")
    print(f"per lead     : {per_lead:.2f}s")
    print(f"stats        : {json.dumps(response.stats.model_dump())}")

    with open(outfile, "w", encoding="utf-8") as handle:
        json.dump(
            {
                "maxLeads": max_leads,
                "returned": response.returned,
                "elapsedS": round(elapsed, 1),
                "perLeadS": round(per_lead, 2),
                "stats": response.stats.model_dump(),
            },
            handle,
            indent=2,
        )
    print(f"\nwritten to {outfile}")
    return 0


if __name__ == "__main__":
    leads = int(sys.argv[1]) if len(sys.argv) > 1 else 25
    out = sys.argv[2] if len(sys.argv) > 2 else "timing.json"
    raise SystemExit(asyncio.run(main(leads, out)))
