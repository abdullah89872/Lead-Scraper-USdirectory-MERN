"""Website enrichment.

If a business publishes a website, at most ``max_pages`` of the *public* pages
listed below are checked for contact details that the business itself displays:

    /  /contact  /contact-us  /about  /about-us

Only publicly displayed values are read. Nothing is guessed, and if the site
blocks us (403 / CAPTCHA / robots.txt) we stop and record the status instead of
trying to get around it.
"""

from __future__ import annotations

import asyncio
import logging
from urllib.parse import urljoin, urlparse

from ..extractors.contact import (
    extract_address_node,
    extract_contact_points,
    extract_postal_from_text,
    extract_services,
    first_text,
)
from ..extractors.html import json_ld_blocks, make_soup, pick_local_business
from ..models import Lead
from ..services.http import BaseFetcher
from ..validators.emails import email_status

logger = logging.getLogger(__name__)

CONTACT_PATHS = ("/", "/contact", "/contact-us", "/about", "/about-us")


def read_identity(soup) -> dict[str, str | None]:
    """Read business identity fields from the site's own markup / JSON-LD."""
    node = pick_local_business(json_ld_blocks(soup)) or {}
    name = node.get("name") or first_text(soup.select_one("h1"))
    address_node = node.get("address")
    address: str | None = None
    if isinstance(address_node, dict):
        address = extract_address_node(address_node)["address"]
    elif isinstance(address_node, str):
        address = address_node
    if not address:
        element = soup.select_one("address, .address, [itemprop='address']")
        if element is not None:
            address = first_text(element)
    return {"name": name, "address": address}


class WebsiteEnricher:
    def __init__(
        self,
        fetcher: BaseFetcher,
        *,
        max_pages: int = 5,
        concurrency: int = 2,
        enabled: bool = True,
    ) -> None:
        self.fetcher = fetcher
        self.max_pages = max(1, min(max_pages, len(CONTACT_PATHS)))
        self.enabled = enabled
        self._semaphore = asyncio.Semaphore(max(1, concurrency))

    def candidate_urls(self, lead: Lead) -> list[str]:
        urls: list[str] = []
        if lead.contactPageUrl:
            urls.append(lead.contactPageUrl)
        if not lead.website:
            return urls
        parsed = urlparse(lead.website)
        origin = f"{parsed.scheme or 'https'}://{parsed.netloc}"
        for path in CONTACT_PATHS:
            target = urljoin(origin + "/", path.lstrip("/"))
            if target not in urls:
                urls.append(target)
        return urls[: self.max_pages]

    async def enrich(self, lead: Lead) -> Lead:
        if not self.enabled:
            lead.enrichmentStatus = "skipped"
            return lead
        if not lead.website:
            lead.enrichmentStatus = "no_website"
            return lead

        pages = self.candidate_urls(lead)
        visited: list[str] = []
        sources: list[str] = []
        emails: list[str] = list(lead.publicEmails or [])
        phones: list[str] = list(lead.publicPhones or [])
        services: list[str] = list(lead.services or [])
        blocked_reason: str | None = None
        fetched_ok = 0

        async with self._semaphore:
            for page in pages:
                response = await self.fetcher.get(page)
                if response.blocked:
                    blocked_reason = response.reason or "site restricted access"
                    break
                if not response.ok:
                    continue
                fetched_ok += 1
                visited.append(response.final_url or page)

                soup = make_soup(response.text)
                identity = read_identity(soup)
                contacts = extract_contact_points(soup)

                gained = False
                for address in contacts["emails"]:
                    if address not in emails:
                        emails.append(address)
                        gained = True
                for number in contacts["phones"]:
                    if number not in phones:
                        phones.append(number)
                        gained = True
                for item in extract_services(soup, json_ld_blocks(soup)):
                    if item not in services:
                        services.append(item)

                if identity.get("name") and not lead.businessName:
                    lead.businessName = identity["name"]
                if not lead.address and identity.get("address"):
                    parsed = extract_postal_from_text(identity["address"])
                    lead.address = parsed["address"]
                    lead.city = lead.city or parsed["city"]
                    lead.state = lead.state or parsed["state"]
                    lead.zip = lead.zip or parsed["zip"]

                if gained:
                    if not lead.contactPageUrl:
                        lead.contactPageUrl = response.final_url or page

                # Every page actually read is recorded as an enrichment source,
                # even when it added nothing new, so the provenance is complete.
                sources.append(response.final_url or page)

                if emails and phones:
                    break

        lead.publicEmails = emails
        lead.publicPhones = phones
        lead.services = services
        if not lead.email and emails:
            lead.email = emails[0]
        if not lead.phone and phones:
            lead.phone = phones[0]
        lead.emailStatus = email_status(emails) if emails else lead.emailStatus
        lead.enrichmentSources = list(dict.fromkeys((lead.enrichmentSources or []) + sources))

        if blocked_reason:
            lead.enrichmentStatus = "failed"
            lead.notes.append(f"Website enrichment stopped: {blocked_reason}")
        elif fetched_ok == 0:
            lead.enrichmentStatus = "failed"
            lead.notes.append("No public page on the business website could be read.")
        else:
            lead.enrichmentStatus = "completed"
            lead.notes.append(
                f"Checked {fetched_ok} public page(s) on the business website; "
                f"{len(sources)} contained contact details."
            )
        if visited and not lead.contactPageUrl:
            lead.contactPageUrl = visited[0]
        return lead

    async def enrich_many(self, leads: list[Lead]) -> list[Lead]:
        return list(await asyncio.gather(*(self.enrich(lead) for lead in leads)))