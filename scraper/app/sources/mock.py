"""Mock directory source - makes the whole product testable offline.

``SCRAPER_MODE=mock`` swaps the *transport* for the real USdirectory source:
instead of fetching usdirectory.com it renders synthetic listing pages and
profile pages and puts them in an in-memory fetcher map. Parsing, normalization,
deduplication and enrichment then run through exactly the same production code
path - only the HTML source differs.

The generated data is deliberately non-real: reserved ``555-01xx`` phone
numbers, ``@example.com`` addresses and non-resolvable ``*.example.com``
websites. Every lead is flagged ``demoData=true`` so it can never be mistaken
for real business information.
"""

from __future__ import annotations

import hashlib
import json
import random
from dataclasses import dataclass, field
from urllib.parse import urlparse

from ..models import Lead
from ..services.dedupe import normalize_name
from ..services.http import BaseFetcher, StaticFetcher
from .usdirectory import USDirectorySource

NAME_PREFIXES = (
    "Cedar Ridge", "Summit", "Blue Sky", "Ironclad", "Evergreen", "Pioneer",
    "Northgate", "Silverline", "Apex", "Fairview", "Brightstone", "Highpoint",
    "Oakwood", "Juniper", "Copper Creek", "Lakeside", "Redstone", "Westbrook",
    "Hearthstone", "Stonebridge", "Clearwater", "Meadowlark", "Trinity",
    "Riverside", "Maplewood",
)
GENERIC_SUFFIXES = ("Group", "Solutions", "Services", "Company", "Partners", "Industries")
STREET_NAMES = (
    "Main St", "Oak Ave", "Washington St", "Maple Ave", "Industrial Way",
    "Commerce Dr", "Cedar St", "3rd Ave", "Sunset Blvd", "Lincoln St",
    "Brookside Rd", "Park Ave",
)
# Area codes are only combined with the 555-01xx fictional exchange below.
DEMO_AREA_CODES = ("212", "303", "312", "404", "480", "503", "617", "702", "916", "971")
SERVICE_LIBRARY = {
    "default": ("Consultation", "Estimates", "Repairs", "Maintenance", "Installation"),
}


@dataclass
class MockBusiness:
    index: int
    name: str
    category: str
    city: str
    state: str
    state_abbr: str
    description: str
    street: str
    zip: str
    phone: str | None
    email: str | None
    website: str | None
    services: list[str] = field(default_factory=list)
    source_id: str = ""

    @property
    def slug(self) -> str:
        cleaned = "".join(ch if ch.isalnum() else " " for ch in self.name)
        return "-".join(part for part in cleaned.split() if part)

    @property
    def profile_url(self) -> str:
        return (
            f"https://usdirectory.com/{self.name.replace(' ', '-')}-"
            f"{self.city.replace(' ', '-')}-{self.state_abbr}-{self.source_id}"
        )

    @property
    def profile_path(self) -> str:
        return urlparse(self.profile_url).path


def _seed_for(category: str, location: str) -> int:
    digest = hashlib.sha256(f"{category.strip().lower()}|{location.strip().lower()}".encode())
    return int.from_bytes(digest.digest()[:8], "big")


def build_mock_catalog(
    *,
    category: str,
    location: str,
    count: int,
    enrichment: bool = True,
) -> list[MockBusiness]:
    """Deterministically build ``count`` synthetic businesses."""
    from ..services.us_states import parse_location

    parts = parse_location(location)
    city = parts.city or (parts.state_name or "Springfield")
    state_name = parts.state_name or "Oregon"
    abbr = parts.state_abbr or "OR"
    city_slug = city.replace(" ", "-")
    rng = random.Random(_seed_for(category, location))

    services = [f"{category} {item}" for item in SERVICE_LIBRARY["default"]]

    businesses: list[MockBusiness] = []
    for index in range(count):
        prefix = rng.choice(NAME_PREFIXES)
        suffix = category if rng.random() < 0.55 else f"{category} {rng.choice(GENERIC_SUFFIXES)}"
        name = f"{prefix} {suffix}"
        # Uniqueness is checked on the *deduplicated* name so the generated
        # catalog never contains two records the pipeline would merge away.
        taken_names = {normalize_name(biz.name) for biz in businesses}
        if normalize_name(name) in taken_names:
            for attempt in range(index + 2):
                candidate = (
                    f"{prefix} {category} {attempt + 1}"
                    if attempt % 2 == 0
                    else f"{prefix} {suffix} {attempt + 1}"
                )
                if normalize_name(candidate) not in taken_names:
                    name = candidate
                    break
            else:  # pragma: no cover - only with an exhausted name pool
                name = f"{prefix} {category} {index + 1}"

        street_number = rng.randint(100, 9899)
        street = f"{street_number} {rng.choice(STREET_NAMES)}"
        zip_code = f"{rng.randint(10000, 99999)}"

        # ~88% of listings publish a phone. Numbers use the 555-01xx range that
        # the NANP reserves for fiction, so mock leads can never collide with a
        # real business line. The index keeps them unique so no two demo leads
        # share a phone (which the deduplicator would treat as one business).
        phone = (
            f"({DEMO_AREA_CODES[index % len(DEMO_AREA_CODES)]}) 555-01{index:02d}"
            if rng.random() < 0.88
            else None
        )
        slug_domain = "-".join(part.lower() for part in name.split())
        email = f"info@{slug_domain}.example.com" if rng.random() < 0.62 else None
        website = (
            f"https://www.{slug_domain}.example.com" if enrichment and rng.random() < 0.70 else None
        )

        description = (
            f"{name} is a {category.lower()} provider serving {city}, {state_name} and the "
            f"surrounding area. Listed in the public directory with services such as "
            f"{', '.join(item.lower() for item in services[:3])}."
        )

        businesses.append(
            MockBusiness(
                index=index,
                name=name,
                category=category,
                city=city,
                state=state_name,
                state_abbr=abbr,
                description=description,
                street=street,
                zip=zip_code,
                phone=phone,
                email=email,
                website=website,
                services=services,
                source_id=str(100000 + index * 7 + rng.randint(0, 6)),
            )
        )
        _ = city_slug  # kept for readability of the catalog construction
    return businesses


# --------------------------------------------------------------- HTML rendering
def render_search_page(
    businesses: list[MockBusiness],
    *,
    category: str,
    city: str,
    state_abbr: str,
    page: int = 1,
    next_page: str | None = None,
) -> str:
    cards = []
    for biz in businesses:
        cards.append(
            f"""
        <li class="listing result">
          <h3 class="listing-name"><a href="{biz.profile_path}">{biz.name}</a></h3>
          <p class="listing-address">{biz.street}, {biz.city}, {biz.state_abbr} {biz.zip}</p>
          <p class="listing-phone">{biz.phone or ''}</p>
          <a class="profile-link" href="{biz.profile_path}">View profile</a>
        </li>"""
        )
    next_markup = (
        f'<nav class="pagination"><a rel="next" href="{next_page}">Next</a></nav>'
        if next_page
        else ""
    )
    return f"""<!doctype html>
<html lang="en"><head><title>{category} in {city}, {state_abbr} - USdirectory</title></head>
<body>
  <main>
    <h1>{category} in {city}, {state_abbr}</h1>
    <ul class="search-results">
      {''.join(cards)}
    </ul>
    {next_markup}
  </main>
</body></html>"""


def render_profile_page(biz: MockBusiness) -> str:
    offers = ", ".join(json.dumps({"@type": "Offer", "name": item}) for item in biz.services)
    telephone = f'"telephone": "{biz.phone}",' if biz.phone else ""
    email = f'"email": "{biz.email}",' if biz.email else ""
    website = f'"url": "{biz.website}",' if biz.website else ""
    json_ld = f"""{{
      "@context": "https://schema.org",
      "@type": "ProfessionalService",
      "name": "{biz.name}",
      "description": "{biz.description}",
      "address": {{
        "@type": "PostalAddress",
        "streetAddress": "{biz.street}",
        "addressLocality": "{biz.city}",
        "addressRegion": "{biz.state_abbr}",
        "postalCode": "{biz.zip}"
      }},
      {telephone}
      {email}
      {website}
      "makesOffer": [{offers}]
    }}"""

    tel_link = f'<a class="phone" href="tel:{biz.phone}">{biz.phone}</a>' if biz.phone else ""
    mail_link = f'<a class="email" href="mailto:{biz.email}">{biz.email}</a>' if biz.email else ""
    site_link = f'<a class="website" rel="nofollow" href="{biz.website}">Visit website</a>' if biz.website else ""
    services_markup = "".join(f"<li>{item}</li>" for item in biz.services)

    return f"""<!doctype html>
<html lang="en"><head>
  <title>{biz.name} - {biz.city}, {biz.state_abbr} | USdirectory</title>
  <meta name="description" content="{biz.description}">
  <script type="application/ld+json">{json_ld}</script>
</head>
<body>
  <nav class="breadcrumb"><a href="/">Home</a> / <a href="/{biz.state_abbr}">{biz.state}</a> / <span>{biz.category}</span></nav>
  <main>
    <h1 class="business-name">{biz.name}</h1>
    <p class="business-description">{biz.description}</p>
    <address class="business-address">{biz.street}, {biz.city}, {biz.state_abbr} {biz.zip}</address>
    <div class="contact">{tel_link} {mail_link} {site_link}</div>
    <section id="services"><h2>Services</h2><ul class="services">{services_markup}</ul></section>
  </main>
</body></html>"""


def render_website_home(biz: MockBusiness) -> str:
    contacts = []
    if biz.phone:
        contacts.append(f'<a href="tel:{biz.phone}">{biz.phone}</a>')
    if biz.email:
        contacts.append(f'<a href="mailto:{biz.email}">{biz.email}</a>')
    return f"""<!doctype html>
<html><head><title>{biz.name}</title></head>
<body>
  <header><h1>{biz.name}</h1></header>
  <p>{biz.name} serves {biz.city}, {biz.state} with professional {biz.category.lower()} services.</p>
  <p class="address">{biz.street}, {biz.city}, {biz.state_abbr} {biz.zip}</p>
  <nav><a href="/contact">Contact</a> <a href="/about">About</a></nav>
  <div class="contact">{' '.join(contacts)}</div>
</body></html>"""


def render_website_contact(biz: MockBusiness) -> str:
    rows = []
    if biz.email:
        rows.append(f'<li>Email: <a href="mailto:{biz.email}">{biz.email}</a></li>')
    if biz.phone:
        rows.append(f'<li>Phone: <a href="tel:{biz.phone}">{biz.phone}</a></li>')
    rows.append(f"<li>Address: {biz.street}, {biz.city}, {biz.state_abbr} {biz.zip}</li>")
    return f"""<!doctype html>
<html><head><title>Contact | {biz.name}</title></head>
<body>
  <h1>Contact {biz.name}</h1>
  <ul class="contact-details">{''.join(rows)}</ul>
</body></html>"""


def render_website_about(biz: MockBusiness) -> str:
    services = "".join(f"<li>{item}</li>" for item in biz.services)
    return f"""<!doctype html>
<html><head><title>About | {biz.name}</title></head>
<body>
  <h1>About {biz.name}</h1>
  <p>{biz.name} is based in {biz.city}, {biz.state}.</p>
  <ul class="services">{services}</ul>
</body></html>"""


ROBOTS_ALLOW_ALL = "User-agent: *\nAllow: /\nCrawl-delay: 1\n"


class MockDirectorySource(USDirectorySource):
    """USdirectory-shaped source that serves synthetic HTML from memory.

    It inherits the real URL/parse logic, so mock mode exercises the production
    extraction path while never touching the network.
    """

    display_name = "USdirectory.com (mock mode)"
    PAGE_SIZE = 25

    def __init__(self, *, base_url: str = "https://usdirectory.com", search_template: str = ""):
        super().__init__(base_url=base_url, search_template=search_template)
        self.catalog: list[MockBusiness] = []

    async def prepare(
        self,
        fetcher: BaseFetcher,
        *,
        category: str,
        location: str,
        max_leads: int,
        enrichment: bool = True,
    ) -> None:
        if not isinstance(fetcher, StaticFetcher):
            return

        total = min(max_leads + self.PAGE_SIZE, 1000)
        catalog = build_mock_catalog(
            category=category, location=location, count=total, enrichment=enrichment
        )
        self.catalog = catalog

        seed = self.search_urls(category, location)[0]
        city = catalog[0].city if catalog else location
        abbr = catalog[0].state_abbr if catalog else ""

        pages = [
            catalog[index : index + self.PAGE_SIZE]
            for index in range(0, len(catalog), self.PAGE_SIZE)
        ]
        for number, chunk in enumerate(pages, start=1):
            url = seed if number == 1 else f"{seed}?page={number}"
            next_url = f"{seed}?page={number + 1}" if number < len(pages) else None
            fetcher.add(
                url,
                render_search_page(
                    chunk, category=category, city=city, state_abbr=abbr,
                    page=number, next_page=next_url,
                ),
            )

        for biz in catalog:
            fetcher.add(biz.profile_url, render_profile_page(biz))
            if not biz.website:
                continue
            host = urlparse(biz.website).netloc
            origin = f"https://{host}"
            fetcher.add(f"{origin}/robots.txt", ROBOTS_ALLOW_ALL)
            fetcher.add(biz.website, render_website_home(biz))
            fetcher.add(f"{origin}/contact", render_website_contact(biz))
            fetcher.add(f"{origin}/about", render_website_about(biz))

    def parse_profile(self, html, url, *, category=None, location=None) -> Lead | None:
        lead = super().parse_profile(html, url, category=category, location=location)
        if lead is not None:
            lead.demoData = True
            lead.notes.append(
                "Synthetic demo data generated by mock mode - no real business is represented."
            )
        return lead

